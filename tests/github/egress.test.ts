import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkoutForTurn } from "#lib/github/checkout.js";
import { parseGh } from "#lib/github/cli.js";
import {
  ALLOWED_DOMAINS_ENV,
  allowedHosts,
  basePolicy,
  EGRESS_ENV,
  EGRESS_NOTE,
  EGRESS_SETUP_HINT,
  egressMode,
  extraDomains,
  GITHUB_HOSTS,
  MAX_EXTRA_DOMAINS,
  REGISTRY_HOSTS,
  withBasePolicy,
} from "#lib/github/egress.js";
import {
  LEASE_RESET_ATTEMPTS,
  type LeaseSandbox,
  leasePolicy,
  resetTokenScopeMemo,
  runGh,
  runGitPush,
  runLeasedGitCommand,
  type TokenMinter,
  withShellLease,
} from "#lib/github/lease.js";
import { factoryInit, factoryOpenOptions } from "#lib/github/repo-sandbox.js";
import { bashTool, githubNotes } from "#lib/github/tools.js";

/**
 * The sandbox egress policy, in the mode a deployment gets by default.
 *
 * @remarks
 * `vitest.config.ts` runs the rest of the suite with egress open, where the
 * policies around a lease are what they always were. This file clears that
 * setting and replays the same flows (a `gh` command, a push, a shell
 * lease, a station's clone and setup, the orchestrator's checkout) against
 * the allowlist, recording every policy the sandbox is given.
 */

const TOKEN = "ghs_EGRESSTOKEN0123456789abcdefghijklmn";

/**
 * Stands in for `VercelSandbox.environment`, so the sandbox modules can be
 * loaded and their `open()` call read. Each environment records what it was
 * opened with and then refuses to open, which stops a station's module
 * before it would clone anything.
 */
vi.mock("eve/sandbox/vercel", async (original) => ({
  ...(await original<typeof import("eve/sandbox/vercel")>()),
  VercelSandbox: {
    environment: () => {
      const opened: unknown[] = [];
      return {
        open: (options: unknown) => {
          opened.push(options);
          return Promise.reject(
            new Error("the fake environment opens nothing")
          );
        },
        opened,
      };
    },
  },
}));

type Policy = "allow-all" | "deny-all" | { allow?: Record<string, unknown[]> };

type Step =
  | { kind: "policy"; policy: Policy }
  | { command: string; kind: "run" };

const fakeSandbox = (
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({}),
  options: { resetFailures?: number } = {}
) => {
  const steps: Step[] = [];
  let policies = 0;
  let failures = 0;
  const sandbox = {
    name: "sbx_egress",
    resolvePath: () => "/workspace",
    run: async ({ command }: { command: string }) => {
      steps.push({ command, kind: "run" });
      const result = respond(command);
      return {
        exitCode: result.exitCode ?? 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      };
    },
    setNetworkPolicy: async (policy: unknown) => {
      policies += 1;
      steps.push({ kind: "policy", policy: policy as Policy });
      // The first policy attaches the lease; the ones after take it off,
      // and the first `resetFailures` of those fail.
      if (policies > 1 && failures < (options.resetFailures ?? 0)) {
        failures += 1;
        throw new Error("sandbox API unavailable");
      }
    },
    writeTextFile: async () => undefined,
  };
  return { sandbox: sandbox as unknown as LeaseSandbox, steps };
};

const mint: TokenMinter = async () => TOKEN;
const dependencies = { id: () => "egress", mint };

const policiesOf = (steps: readonly Step[]): Policy[] =>
  steps.flatMap((step) => (step.kind === "policy" ? [step.policy] : []));

const hostsOf = (policy: Policy): string[] =>
  typeof policy === "object" ? Object.keys(policy.allow ?? {}).sort() : [];

/** The hosts a policy attaches a rule to, which is where a credential is. */
const credentialHosts = (policy: Policy): string[] =>
  typeof policy === "object"
    ? Object.entries(policy.allow ?? {})
        .filter(([, rules]) => rules.length > 0)
        .map(([host]) => host)
        .sort()
    : [];

const gh = (...args: string[]) => {
  const parsed = parseGh(args);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.invocation;
};

const restricted = () => {
  vi.stubEnv(EGRESS_ENV, "");
  vi.stubEnv(ALLOWED_DOMAINS_ENV, "");
};

beforeEach(() => {
  resetTokenScopeMemo();
  restricted();
  vi.stubEnv("FACTORY_BOT_NAME", "foreman");
  vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
  vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "");
  vi.stubEnv("FACTORY_ALLOW_INSTALL_SCRIPTS", "");
  vi.stubEnv("FACTORY_SETUP_COMMAND", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("egressMode: the deployer's switch", () => {
  test("restricted is the default", () => {
    expect(egressMode()).toBe("restricted");
  });

  test.each(["open", "OPEN", " open "])("%j opens egress", (value) => {
    vi.stubEnv(EGRESS_ENV, value);
    expect(egressMode()).toBe("open");
  });

  test.each(["restricted", "1", "true", "allow-all", "opened", "off"])(
    "%j is not the opt-out, so the allowlist stays on",
    (value) => {
      vi.stubEnv(EGRESS_ENV, value);
      expect(egressMode()).toBe("restricted");
    }
  );
});

describe("the default allowlist", () => {
  test("names every host by its full name: no wildcard, scheme, port, or path", () => {
    for (const host of [...GITHUB_HOSTS, ...REGISTRY_HOSTS]) {
      expect(host).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      expect(host).toContain(".");
    }
  });

  test("has no duplicates", () => {
    const all = [...GITHUB_HOSTS, ...REGISTRY_HOSTS];
    expect(new Set(all).size).toBe(all.length);
  });

  test("covers what git and gh reach: the git endpoint, the API, uploads, archives, and Actions logs", () => {
    expect(GITHUB_HOSTS).toEqual(
      expect.arrayContaining([
        "github.com",
        "api.github.com",
        "codeload.github.com",
        "uploads.github.com",
        "results-receiver.actions.githubusercontent.com",
      ])
    );
  });

  test("covers the documented setup command, pnpm install", () => {
    expect(REGISTRY_HOSTS).toContain("registry.npmjs.org");
  });

  test("every host a lease attaches a credential to is a GitHub host on the list", () => {
    for (const kind of ["gh", "git", "shell"] as const) {
      const hosts = credentialHosts(leasePolicy(kind, TOKEN, "p") as Policy);
      expect(hosts.length).toBeGreaterThanOrEqual(2);
      for (const host of hosts) {
        expect(GITHUB_HOSTS).toContain(host);
      }
    }
  });
});

describe("extraDomains: FACTORY_SANDBOX_ALLOWED_DOMAINS", () => {
  test("unset adds nothing", () => {
    expect(extraDomains()).toEqual([]);
  });

  test("reads comma-separated hostnames, trimmed, lowercased, and deduplicated", () => {
    vi.stubEnv(
      ALLOWED_DOMAINS_ENV,
      " npm.example.com, API.Internal.Example.org ,,npm.example.com "
    );
    expect(extraDomains()).toEqual([
      "npm.example.com",
      "api.internal.example.org",
    ]);
  });

  test("added hosts join the allowlist, after the defaults", () => {
    vi.stubEnv(ALLOWED_DOMAINS_ENV, "npm.example.com");
    expect(allowedHosts()).toEqual([
      ...GITHUB_HOSTS,
      ...REGISTRY_HOSTS,
      "npm.example.com",
    ]);
  });

  test.each([
    ["a wildcard", "*.example.com"],
    ["every host", "*"],
    ["a scheme", "https://npm.example.com"],
    ["a port", "npm.example.com:8443"],
    ["a path", "npm.example.com/registry"],
    ["a bare label", "localhost"],
    ["an IP address", "10.0.0.1"],
    ["a space inside", "npm example.com"],
    ["a leading dot", ".example.com"],
    ["a trailing dot", "example.com."],
    ["a label starting with a hyphen", "-bad.example.com"],
    ["shell text", "example.com;curl evil.test"],
    ["an at sign", "user@example.com"],
  ])("refuses %s (%j), naming the entry", (_label, entry) => {
    vi.stubEnv(ALLOWED_DOMAINS_ENV, `npm.example.com,${entry}`);
    expect(() => extraDomains()).toThrow(/is not a hostname/);
    // A sandbox must not open on a policy that quietly dropped the entry.
    expect(() => basePolicy()).toThrow(/FACTORY_SANDBOX_ALLOWED_DOMAINS/);
  });

  test("refuses more hosts than a person would review", () => {
    const many = Array.from(
      { length: MAX_EXTRA_DOMAINS + 1 },
      (_, index) => `h${index}.example.com`
    );
    vi.stubEnv(ALLOWED_DOMAINS_ENV, many.join(","));
    expect(() => extraDomains()).toThrow(/the limit is 64/);
    vi.stubEnv(ALLOWED_DOMAINS_ENV, many.slice(1).join(","));
    expect(extraDomains()).toHaveLength(MAX_EXTRA_DOMAINS);
  });

  test("a bad entry does not stop a deployment that opened egress", () => {
    vi.stubEnv(EGRESS_ENV, "open");
    vi.stubEnv(ALLOWED_DOMAINS_ENV, "*.example.com");
    expect(basePolicy()).toBe("allow-all");
  });
});

describe("basePolicy: what a sandbox opens with and returns to", () => {
  test("restricted: the allowlist, each host with no rules, and nothing else", () => {
    const policy = basePolicy() as Policy;
    expect(hostsOf(policy)).toEqual(
      [...GITHUB_HOSTS, ...REGISTRY_HOSTS].sort()
    );
    expect(credentialHosts(policy)).toEqual([]);
    expect(hostsOf(policy)).not.toContain("*");
  });

  test("open: allow-all, as before", () => {
    vi.stubEnv(EGRESS_ENV, "open");
    expect(basePolicy()).toBe("allow-all");
  });

  test("factoryOpenOptions hands that policy to open()", () => {
    expect(factoryOpenOptions()).toEqual({ networkPolicy: basePolicy() });
    vi.stubEnv(EGRESS_ENV, "open");
    expect(factoryOpenOptions()).toEqual({ networkPolicy: "allow-all" });
  });

  test("is read when it is asked for, not when the module loads", () => {
    expect(hostsOf(basePolicy() as Policy)).not.toContain("npm.example.com");
    vi.stubEnv(ALLOWED_DOMAINS_ENV, "npm.example.com");
    expect(hostsOf(basePolicy() as Policy)).toContain("npm.example.com");
  });
});

describe("leasePolicy over the base policy", () => {
  const LEASE_HOSTS = {
    gh: ["api.github.com", "uploads.github.com"],
    git: ["codeload.github.com", "github.com"],
    shell: [
      "api.github.com",
      "codeload.github.com",
      "github.com",
      "uploads.github.com",
    ],
  } as const;

  test.each(["gh", "git", "shell"] as const)(
    "restricted, %s: the allowlist, with a credential on that lease's hosts only, and no catch-all",
    (kind) => {
      const policy = leasePolicy(kind, TOKEN, "placeholder") as Policy;
      expect(hostsOf(policy)).toEqual(
        [...GITHUB_HOSTS, ...REGISTRY_HOSTS].sort()
      );
      expect(hostsOf(policy)).not.toContain("*");
      expect(credentialHosts(policy)).toEqual([...LEASE_HOSTS[kind]]);
    }
  );

  test.each(["gh", "git", "shell"] as const)(
    "open, %s: exactly the policy a lease was before the allowlist existed",
    (kind) => {
      const restrictedPolicy = leasePolicy(kind, TOKEN, "placeholder") as {
        allow: Record<string, unknown[]>;
      };
      vi.stubEnv(EGRESS_ENV, "open");
      const policy = leasePolicy(kind, TOKEN, "placeholder") as {
        allow: Record<string, unknown[]>;
      };
      expect(Object.keys(policy.allow).sort()).toEqual(
        ["*", ...LEASE_HOSTS[kind]].sort()
      );
      expect(policy.allow["*"]).toEqual([]);
      // The credential rules themselves do not depend on the mode.
      for (const host of LEASE_HOSTS[kind]) {
        expect(policy.allow[host]).toEqual(restrictedPolicy.allow[host]);
      }
    }
  );

  test("a host the deployer added cannot displace a lease's rule on a GitHub host", () => {
    vi.stubEnv(ALLOWED_DOMAINS_ENV, "api.github.com,npm.example.com");
    const policy = leasePolicy("gh", TOKEN, "placeholder") as Policy;
    expect(credentialHosts(policy)).toEqual([...LEASE_HOSTS.gh]);
    expect(hostsOf(policy)).toContain("npm.example.com");
  });

  test("a lease's hosts are reachable even if a future allowlist forgot them", () => {
    const policy = withBasePolicy({
      "new.github.example": [{ transform: [{ headers: { a: "b" } }] }],
    }) as Policy;
    expect(hostsOf(policy)).toContain("new.github.example");
  });

  test("the real token appears only in a rule on a GitHub host, never on a registry", () => {
    const policy = leasePolicy("shell", TOKEN, "placeholder") as {
      allow: Record<string, unknown[]>;
    };
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const carriers = Object.entries(policy.allow)
      .filter(([, rules]) => {
        const text = JSON.stringify(rules);
        return text.includes(TOKEN) || text.includes(basic);
      })
      .map(([host]) => host)
      .sort();
    // Exactly the lease's own hosts carry it, as a bearer token or as git's
    // basic auth; no other host on the allowlist does.
    expect(carriers).toEqual([...LEASE_HOSTS.shell]);
    for (const host of carriers) {
      expect(GITHUB_HOSTS).toContain(host);
      expect(REGISTRY_HOSTS).not.toContain(host);
    }
  });
});

/** No policy in a restricted run may open every host, and the run set some. */
const expectNeverOpen = (steps: readonly Step[]) => {
  expect(policiesOf(steps).length).toBeGreaterThan(0);
  for (const policy of policiesOf(steps)) {
    expect(policy).not.toBe("allow-all");
    expect(hostsOf(policy)).not.toContain("*");
  }
};

describe("a lease in restricted mode: attach over the allowlist, return to the allowlist", () => {
  test("a gh command the runtime runs", async () => {
    const { sandbox, steps } = fakeSandbox();
    await runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies);
    expect(policiesOf(steps)).toEqual([
      leasePolicy("gh", TOKEN, "factory-egress"),
      basePolicy(),
    ]);
    expectNeverOpen(steps);
  });

  test("the implementer's push", async () => {
    const { sandbox, steps } = fakeSandbox();
    await runGitPush(sandbox, "factory/bug-fix-login", dependencies);
    expect(policiesOf(steps)).toEqual([
      leasePolicy("git", TOKEN, "factory-egress"),
      basePolicy(),
    ]);
    expectNeverOpen(steps);
  });

  test("a shell command that names gh or git", async () => {
    const { sandbox, steps } = fakeSandbox();
    await withShellLease(sandbox, dependencies, async () => "ran");
    expect(policiesOf(steps)).toEqual([
      leasePolicy("shell", TOKEN, "factory-egress"),
      basePolicy(),
    ]);
    expectNeverOpen(steps);
  });

  test("a command that fails still returns the sandbox to the allowlist", async () => {
    const { sandbox, steps } = fakeSandbox();
    await expect(
      withShellLease(sandbox, dependencies, async () => {
        throw new Error("command blew up");
      })
    ).rejects.toThrow("command blew up");
    expect(policiesOf(steps).at(-1)).toEqual(basePolicy());
  });

  test("the reset is retried, each time with the allowlist, never with allow-all", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({}), {
      resetFailures: LEASE_RESET_ATTEMPTS - 1,
    });
    await runLeasedGitCommand(sandbox, "/usr/bin/git fetch", dependencies);
    const policies = policiesOf(steps);
    expect(policies).toHaveLength(1 + LEASE_RESET_ATTEMPTS);
    expect(policies.slice(1)).toEqual(
      new Array(LEASE_RESET_ATTEMPTS).fill(basePolicy())
    );
    expectNeverOpen(steps);
  });

  test("two leases in a row leave the same base policy between them", async () => {
    const { sandbox, steps } = fakeSandbox();
    await runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies);
    await runGitPush(sandbox, "factory/bug-fix-login", dependencies);
    const policies = policiesOf(steps);
    expect(policies[1]).toEqual(basePolicy());
    expect(policies[3]).toEqual(basePolicy());
    expect(credentialHosts(policies[1] as Policy)).toEqual([]);
  });

  test("the policy in force after a lease carries no credential at all", async () => {
    const { sandbox, steps } = fakeSandbox();
    await runGitPush(sandbox, "factory/bug-fix-login", dependencies);
    expect(JSON.stringify(policiesOf(steps).at(-1))).not.toContain(TOKEN);
    expect(credentialHosts(policiesOf(steps).at(-1) as Policy)).toEqual([]);
  });

  test("a host added by the deployer is reachable during a lease and after it", async () => {
    vi.stubEnv(ALLOWED_DOMAINS_ENV, "npm.example.com");
    const { sandbox, steps } = fakeSandbox();
    await runGitPush(sandbox, "factory/bug-fix-login", dependencies);
    // The lease going on, and the lease coming off.
    expect(policiesOf(steps)).toHaveLength(2);
    for (const policy of policiesOf(steps)) {
      expect(hostsOf(policy)).toContain("npm.example.com");
    }
  });
});

describe("a station session in restricted mode", () => {
  test("the clone is leased over the allowlist, and the setup command runs on the allowlist with no credential", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox as never, dependencies);
    expect(policiesOf(steps)).toEqual([
      leasePolicy("git", TOKEN, "factory-egress"),
      basePolicy(),
    ]);
    const setup = steps.findIndex(
      (step) =>
        step.kind === "run" && step.command === "cd repo && pnpm install"
    );
    expect(setup).toBeGreaterThan(0);
    expect(steps[setup - 1]).toEqual({ kind: "policy", policy: basePolicy() });
    expectNeverOpen(steps);
  });

  test("a failing setup command says how to allow the host it could not reach", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox } = fakeSandbox((command) =>
      command.startsWith("cd repo")
        ? {
            exitCode: 1,
            stderr:
              "ERR_PNPM_META_FETCH_FAIL GET https://npm.example.com/left-pad: connect ECONNREFUSED",
          }
        : {}
    );
    const failure = await factoryInit(sandbox as never, dependencies).catch(
      (error: unknown) => error as Error
    );
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain("ERR_PNPM_META_FETCH_FAIL");
    expect(message).toContain(EGRESS_SETUP_HINT);
    expect(message).toContain("FACTORY_SANDBOX_ALLOWED_DOMAINS");
    expect(message).toContain("FACTORY_SANDBOX_EGRESS=open");
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  test("with egress open, a failing setup command is reported as it always was", async () => {
    vi.stubEnv(EGRESS_ENV, "open");
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox } = fakeSandbox((command) =>
      command.startsWith("cd repo") ? { exitCode: 1, stderr: "boom" } : {}
    );
    const failure = await factoryInit(sandbox as never, dependencies).catch(
      (error: unknown) => error as Error
    );
    expect((failure as Error).message).toContain("boom");
    expect((failure as Error).message).not.toContain("FACTORY_SANDBOX");
  });
});

describe("the orchestrator's checkout in restricted mode", () => {
  test("fetches under a lease over the allowlist and returns to it", async () => {
    const sha = "a".repeat(40);
    const { sandbox, steps } = fakeSandbox((command) =>
      command.includes("fetch") ? { stdout: `${sha}\n` } : { exitCode: 1 }
    );
    const result = await checkoutForTurn(
      sandbox as never,
      {
        baseSha: null,
        defaultBranch: "main",
        headRef: null,
        headSha: sha,
        owner: "acme",
        pullRequestNumber: null,
        repo: "widgets",
      },
      dependencies
    );
    expect(result?.sha).toBe(sha);
    expect(policiesOf(steps)).toEqual([
      leasePolicy("git", TOKEN, "factory-egress"),
      basePolicy(),
    ]);
    expectNeverOpen(steps);
  });
});

/**
 * A source file with its comments removed and its string literals kept.
 *
 * @remarks
 * Enough of a scanner for the factory's own sources: line and block
 * comments, and single-quoted, double-quoted, and template strings (a
 * quoted string ends at its line's end at the latest, so a quote inside a
 * regular expression cannot swallow the lines after it).
 */
const withoutComments = (source: string): string => {
  let code = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const pair = source.slice(index, index + 2);
    if (pair === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (pair === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (
        end < source.length &&
        source[end] !== char &&
        (char === "`" || source[end] !== "\n")
      ) {
        end += source[end] === "\\" ? 2 : 1;
      }
      code += source.slice(index, end + 1);
      index = end + 1;
    } else {
      code += char;
      index += 1;
    }
  }
  return code;
};

describe("every factory sandbox opens with the base policy", () => {
  const SANDBOX_MODULES: Record<string, () => Promise<unknown>> = {
    "agent/sandbox.ts": () => import("#sandbox.js"),
    "agent/subagents/analyst/sandbox.ts": () =>
      import("#subagents/analyst/sandbox.js"),
    "agent/subagents/implementer/sandbox.ts": () =>
      import("#subagents/implementer/sandbox.js"),
    "agent/subagents/reviewer/sandbox.ts": () =>
      import("#subagents/reviewer/sandbox.js"),
  };
  const PATHS = Object.keys(SANDBOX_MODULES);

  interface SandboxModule {
    default: () => Promise<unknown>;
    environment: { opened: { networkPolicy?: Policy }[] };
  }

  /** Runs a sandbox module's own definition against the fake environment. */
  const openedWith = async (path: string) => {
    const module = (await SANDBOX_MODULES[path]?.()) as SandboxModule;
    module.environment.opened.length = 0;
    await expect(module.default()).rejects.toThrow(
      "the fake environment opens nothing"
    );
    return module.environment.opened;
  };

  test("the modules below are every sandbox the factory defines", () => {
    const found = (readdirSync("agent", { recursive: true }) as string[])
      .filter((path) => /(^|\/)sandbox\.ts$/.test(path))
      .map((path) => `agent/${path}`)
      .sort();
    expect(found).toEqual(PATHS);
  });

  test.each(PATHS)(
    "%s opens on the allowlist, with no catch-all",
    async (path) => {
      const opened = await openedWith(path);
      expect(opened).toEqual([{ networkPolicy: basePolicy() }]);
      const policy = opened[0]?.networkPolicy as Policy;
      expect(hostsOf(policy)).toEqual(
        [...GITHUB_HOSTS, ...REGISTRY_HOSTS].sort()
      );
      expect(credentialHosts(policy)).toEqual([]);
    }
  );

  test.each(PATHS)(
    "%s opens on allow-all once the deployer opened egress",
    async (path) => {
      vi.stubEnv(EGRESS_ENV, "open");
      expect(await openedWith(path)).toEqual([{ networkPolicy: "allow-all" }]);
    }
  );

  test("the only allow-all string literal in the factory is the one basePolicy returns", () => {
    const ALLOW_ALL = /(["'`])allow-all\1/g;
    const literals = (path: string) =>
      withoutComments(readFileSync(path, "utf8")).match(ALLOW_ALL) ?? [];
    const sources = (readdirSync("agent", { recursive: true }) as string[])
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `agent/${path}`);
    expect(sources).toContain("agent/lib/github/lease.ts");
    expect(sources).toContain("agent/lib/github/egress.ts");
    // The scanner does find the literal where it belongs, and skips the
    // mention of it in that file's doc comment.
    expect(literals("agent/lib/github/egress.ts")).toEqual(['"allow-all"']);
    const elsewhere = sources
      .filter((path) => path !== "agent/lib/github/egress.ts")
      .filter((path) => literals(path).length > 0);
    expect(elsewhere).toEqual([]);
  });
});

describe("what an agent is told about its network", () => {
  /** The description the model reads on the `bash` tool built for `role`. */
  const bashDescription = (role: Parameters<typeof githubNotes>[0]): string =>
    (
      bashTool({ environment: {} as never, role }) as unknown as {
        description: string;
      }
    ).description;

  test.each(["implementer", "reader"] as const)(
    "%s: the bash tool says which hosts are reachable, in restricted mode only",
    (role) => {
      expect(githubNotes(role)).toContain(EGRESS_NOTE);
      expect(bashDescription(role)).toContain(EGRESS_NOTE);
      expect(bashDescription(role).endsWith(githubNotes(role))).toBe(true);
      vi.stubEnv(EGRESS_ENV, "open");
      expect(githubNotes(role)).not.toContain(EGRESS_NOTE);
      expect(bashDescription(role)).not.toContain(EGRESS_NOTE);
      expect(bashDescription(role).endsWith(githubNotes(role))).toBe(true);
    }
  );

  test("the orchestrator has no shell, so it is told nothing about the network", () => {
    expect(githubNotes("orchestrator")).not.toContain(EGRESS_NOTE);
    expect(bashDescription("orchestrator")).not.toContain(EGRESS_NOTE);
    // Its notes are still there; only the egress note is left out.
    expect(githubNotes("orchestrator").length).toBeGreaterThan(100);
    expect(
      bashDescription("orchestrator").endsWith(githubNotes("orchestrator"))
    ).toBe(true);
  });

  test("the note and the hint follow the writing rules for agent-facing text", () => {
    for (const text of [EGRESS_NOTE, EGRESS_SETUP_HINT]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toContain("**");
    }
  });
});
