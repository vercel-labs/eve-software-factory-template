import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  leasePolicy,
  mintScopedToken,
  resetTokenScopeMemo,
  runLeasedGitCommand,
  SCOPE_DOWNGRADE_TTL_MS,
  TOKEN_SCOPES,
  type TokenMinter,
} from "#lib/github/lease.js";
import {
  cloneCommand,
  FACTORY_SANDBOX_CREATE_OPTIONS,
  factoryInit,
} from "#lib/github/repo-sandbox.js";
import {
  FACTORY_TOOLING_VERSION,
  installFactoryTooling,
} from "#lib/github/tooling.js";

const TOKEN = "ghs_INITTOKEN0123456789abcdefghijklmnop";

type Step =
  | { kind: "policy"; policy: unknown }
  | { command: string; env: Record<string, string> | undefined; kind: "run" };

const fakeSandbox = (
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({})
) => {
  const steps: Step[] = [];
  const sandbox = {
    name: "sbx_init",
    run: async ({
      command,
      env,
    }: {
      command: string;
      env?: Record<string, string>;
    }) => {
      steps.push({ command, env, kind: "run" });
      const result = respond(command);
      return {
        exitCode: result.exitCode ?? 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      };
    },
    setNetworkPolicy: async (policy: unknown) => {
      steps.push({ kind: "policy", policy });
    },
    writeTextFile: async () => undefined,
  };
  return { sandbox: sandbox as never, steps };
};

const lease = () => {
  const requests: (readonly string[] | null)[] = [];
  const mint: TokenMinter = async (permissions) => {
    requests.push(permissions);
    return TOKEN;
  };
  return { dependencies: { id: () => "init", mint }, requests };
};

beforeEach(() => {
  resetTokenScopeMemo();
  vi.stubEnv("FACTORY_BOT_NAME", "foreman");
  vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
  vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("factoryInit: a station's checkout", () => {
  test("sets the bot identity, then clones under a read-only lease that ends before anything else runs", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox, steps } = fakeSandbox();
    const { dependencies, requests } = lease();
    await factoryInit(sandbox, dependencies);

    expect(
      steps.map((step) =>
        step.kind === "run"
          ? step.command.split(" ").slice(0, 2).join(" ")
          : `policy:${step.policy === "allow-all" ? "open" : "lease"}`
      )
    ).toEqual([
      "git config",
      "policy:lease",
      "git clone",
      "policy:open",
      "cd repo",
    ]);
    expect(steps[0]?.kind === "run" && steps[0].command).toContain(
      'user.name "foreman[bot]"'
    );
    expect(steps[0]?.kind === "run" && steps[0].command).toContain(
      'user.email "foreman[bot]@users.noreply.github.com"'
    );
    expect(steps[1]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-init"),
    });
    expect(steps[2]?.kind === "run" && steps[2].command).toBe(
      cloneCommand("https://github.com/acme/widgets.git")
    );
    expect(requests[0]).toEqual([
      ...TOKEN_SCOPES["repo-read"].required,
      ...TOKEN_SCOPES["repo-read"].optional,
    ]);
  });

  test("the setup command runs with no GitHub credential: open egress, no lease, no token in its environment", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    const setupIndex = steps.findIndex(
      (step) =>
        step.kind === "run" && step.command === "cd repo && pnpm install"
    );
    expect(setupIndex).toBeGreaterThan(0);
    expect(steps[setupIndex - 1]).toEqual({
      kind: "policy",
      policy: "allow-all",
    });
    expect(steps.slice(setupIndex).some((step) => step.kind === "policy")).toBe(
      false
    );
    const setup = steps[setupIndex];
    expect(setup?.kind === "run" && setup.env).toBeUndefined();
    expect(
      JSON.stringify(steps.filter((step) => step.kind === "run"))
    ).not.toContain(TOKEN);
  });

  test("without a setup command, nothing runs after the clone", async () => {
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
    expect(steps.filter((step) => step.kind === "run")).toHaveLength(2);
  });

  test("a repository the app cannot see is reported as a missing repository, and the lease still ends", async () => {
    const { sandbox, steps } = fakeSandbox((command) =>
      command.startsWith("git clone")
        ? {
            exitCode: 128,
            stderr:
              "remote: Repository not found.\nfatal: repository 'https://github.com/acme/widgets.git/' not found",
          }
        : {}
    );
    await expect(factoryInit(sandbox, lease().dependencies)).rejects.toThrow(
      /Cannot clone acme\/widgets: GitHub reports the repository as not found/
    );
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("a refused credential is reported as an app access problem", async () => {
    const { sandbox } = fakeSandbox((command) =>
      command.startsWith("git clone")
        ? {
            exitCode: 128,
            stderr:
              "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'",
          }
        : {}
    );
    await expect(factoryInit(sandbox, lease().dependencies)).rejects.toThrow(
      /Cannot access acme\/widgets\. Install the selected GitHub connector's app/
    );
  });

  test("a connector that cannot mint a token is reported the same way, before any clone is attempted", async () => {
    const { sandbox, steps } = fakeSandbox();
    await expect(
      factoryInit(sandbox, {
        mint: async () => {
          throw new Error("App authorization required");
        },
      })
    ).rejects.toThrow(/Cannot access acme\/widgets/);
    expect(
      steps.some(
        (step) => step.kind === "run" && step.command.startsWith("git clone")
      )
    ).toBe(false);
    expect(steps.some((step) => step.kind === "policy")).toBe(false);
  });

  test("a failing setup command fails the session, with its output", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox } = fakeSandbox((command) =>
      command.startsWith("cd repo")
        ? { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }
        : {}
    );
    await expect(factoryInit(sandbox, lease().dependencies)).rejects.toThrow(
      /ERR_PNPM_OUTDATED_LOCKFILE/
    );
  });
});

describe("runLeasedGitCommand", () => {
  test("always leases a read-only token, whatever the command", async () => {
    const { sandbox } = fakeSandbox();
    const { dependencies, requests } = lease();
    await runLeasedGitCommand(sandbox, "git clone x repo", dependencies);
    expect(requests[0]).not.toContain("contents:write");
  });
});

describe("the token ladder", () => {
  const refusing = (
    accept: (permissions: readonly string[] | null) => boolean
  ) => {
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (permissions) => {
      requests.push(permissions);
      if (!accept(permissions)) {
        throw new Error("refused");
      }
      return TOKEN;
    };
    return { mint, requests };
  };

  test("with FACTORY_TOKEN_FALLBACK=installation the last rung is the connector's installation token, and using it is logged", async () => {
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "installation");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { mint, requests } = refusing(() => false);
    const token = await mintScopedToken("repo-read", {
      installationToken: async () => "ghs_installation_token_0123456789abcdef",
      mint,
    });
    expect(token).toBe("ghs_installation_token_0123456789abcdef");
    expect(requests).toEqual([
      [
        ...TOKEN_SCOPES["repo-read"].required,
        ...TOKEN_SCOPES["repo-read"].optional,
      ],
      TOKEN_SCOPES["repo-read"].required,
      null,
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /unscoped installation token/
    );
  });

  test.each(["", "none", "off", "1", "true", "REPOSITORY-ish"])(
    "FACTORY_TOKEN_FALLBACK=%j never reaches the wide rungs",
    async (setting) => {
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
      let installationCalls = 0;
      const { mint, requests } = refusing(() => false);
      await expect(
        mintScopedToken("repo-push", {
          installationToken: async () => {
            installationCalls += 1;
            return "ghs_never";
          },
          mint,
        })
      ).rejects.toThrow(/Could not mint a GitHub token/);
      expect(requests).toEqual([["contents:write"]]);
      expect(installationCalls).toBe(0);
    }
  );

  test("a narrower-than-ideal result is retried at full width once the memo expires", async () => {
    let clock = 1_000_000;
    const installation: { grantsChecks: boolean } = { grantsChecks: false };
    const { mint, requests } = refusing(
      (permissions) =>
        installation.grantsChecks ||
        !(permissions ?? []).includes("checks:read")
    );
    const dependencies = { mint, now: () => clock };
    await mintScopedToken("repo-read", dependencies);
    expect(requests).toHaveLength(2);

    // Within the window the remembered rung is used directly.
    clock += SCOPE_DOWNGRADE_TTL_MS - 1;
    await mintScopedToken("repo-read", dependencies);
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)).toEqual(TOKEN_SCOPES["repo-read"].required);

    // After it, the full set is tried again, and this time the installation grants it.
    installation.grantsChecks = true;
    clock += 2;
    await mintScopedToken("repo-read", dependencies);
    expect(requests.at(-1)).toContain("checks:read");

    // A full-width result is remembered for good.
    clock += SCOPE_DOWNGRADE_TTL_MS * 100;
    await mintScopedToken("repo-read", dependencies);
    expect(requests.at(-1)).toContain("checks:read");
    expect(requests).toHaveLength(5);
  });

  test("a transient failure on every rung is not remembered", async () => {
    let fail = true;
    const { mint, requests } = refusing(() => !fail);
    await expect(mintScopedToken("repo-triage", { mint })).rejects.toThrow();
    fail = false;
    await mintScopedToken("repo-triage", { mint });
    expect(requests.at(-1)).toEqual([
      ...TOKEN_SCOPES["repo-triage"].required,
      ...TOKEN_SCOPES["repo-triage"].optional,
    ]);
  });
});

describe("sandbox tooling", () => {
  test("every factory sandbox installs the tooling at build and is re-keyed by its version", () => {
    expect(FACTORY_SANDBOX_CREATE_OPTIONS.prepare).toBe(installFactoryTooling);
    expect(FACTORY_SANDBOX_CREATE_OPTIONS.env).toEqual({
      FACTORY_TOOLING_VERSION,
    });
  });

  test("the installer puts gh and pnpm in place and checks the paths the tools invoke", async () => {
    const { sandbox, steps } = fakeSandbox();
    await installFactoryTooling(sandbox);
    const [run] = steps;
    const script = run?.kind === "run" ? run.command : "";
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(script).toContain("apt-get install -y gh");
    expect(script).toContain("npm install -g pnpm");
    expect(script).toContain("[ -x /usr/bin/gh ]");
    expect(script).toContain("[ -x /usr/bin/git ]");
    expect(steps).toHaveLength(1);
  });

  test("the install script and the clone command are valid shell", async () => {
    const { sandbox, steps } = fakeSandbox();
    await installFactoryTooling(sandbox);
    const [run] = steps;
    for (const script of [
      run?.kind === "run" ? run.command : "exit 1 (",
      cloneCommand("https://github.com/acme/widgets.git"),
    ]) {
      const check = spawnSync("bash", ["-n", "-c", script], {
        encoding: "utf8",
      });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    }
  });

  test("a failed install fails the build with the tail of the output", async () => {
    const { sandbox } = fakeSandbox(() => ({
      exitCode: 100,
      stderr: "E: Unable to locate package gh",
    }));
    await expect(installFactoryTooling(sandbox)).rejects.toThrow(
      /sandbox tooling failed \(exit 100\): E: Unable to locate package gh/
    );
  });
});
