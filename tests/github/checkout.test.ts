import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  type CheckoutSandbox,
  type CheckoutState,
  checkoutCommand,
  checkoutForTurn,
  headCommand,
  isCheckoutSandbox,
  planCheckout,
} from "#lib/github/checkout.js";
import { rewriteGuard } from "#lib/github/git-cli.js";
import { REMOTE_URL } from "#lib/github/git-remote.js";
import { resetTokenScopeMemo, type TokenMinter } from "#lib/github/lease.js";

/**
 * The orchestrator's per-turn checkout.
 *
 * @remarks
 * The checkout exists so the GitHub App's installation token is never left
 * attached to the root sandbox's git traffic, which is what eve's built-in
 * handler does. So the tests here are mostly about the credential: which
 * token is minted, that it is only reachable through a placeholder, and
 * that nothing is left behind when the command ends.
 */

const TOKEN = "ghs_REALTOKEN0123456789abcdefghijklmnop";

/*
 * Two stand-ins, both at the edge of the factory's own code, so the channel
 * module can be loaded and its `turn.started` handler called as eve would
 * call it:
 *
 * - `githubChannel` hands back the config it is given. Everything in that
 *   config is the factory's, and that is what is under test.
 * - Vercel Connect's `getToken` returns a fixed token and records what was
 *   asked of it. The handler passes no lease overrides, so this is where
 *   its token comes from. Every other test here injects its own minter and
 *   never reaches it.
 */
const connect = vi.hoisted(() => ({
  getToken: vi.fn(async (_connector: string, _options: unknown) => ""),
}));

vi.mock("eve/channels/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("eve/channels/github")>()),
  githubChannel: (config: unknown) => config,
}));

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/connect")>()),
  getToken: connect.getToken,
}));
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const basic = (secret: string) =>
  `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;

const state = (overrides: Partial<CheckoutState> = {}): CheckoutState => ({
  baseSha: null,
  defaultBranch: null,
  headRef: null,
  headSha: null,
  owner: "acme",
  pullRequestNumber: null,
  repo: "widgets",
  ...overrides,
});

type Step =
  | { kind: "policy"; policy: unknown }
  | { command: string; env: Record<string, string>; kind: "run" };

const fakeSandbox = (
  respond: (command: string) => {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  } = () => ({})
) => {
  const steps: Step[] = [];
  const sandbox: CheckoutSandbox = {
    name: "sbx_root",
    resolvePath: (path) => (path === "." ? "/workspace" : `/workspace/${path}`),
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
    writeTextFile: async () => undefined,
  };
  return { sandbox, steps };
};

const lease = () => {
  const requests: (readonly string[] | null)[] = [];
  const mint: TokenMinter = async (permissions) => {
    requests.push(permissions);
    return TOKEN;
  };
  return { deps: { id: () => "lease-1", mint }, requests };
};

describe("planCheckout", () => {
  test.each<[string, Partial<CheckoutState>, ReturnType<typeof planCheckout>]>([
    [
      "a known head commit is fetched and checked out by its hash",
      { headSha: SHA },
      { base: null, ref: SHA, sha: SHA },
    ],
    [
      "a pull request without a known commit goes through GitHub's own pull ref",
      { headRef: "feature", pullRequestNumber: 34 },
      { base: null, ref: "refs/pull/34/head", sha: null },
    ],
    [
      "a pull request also fetches its base commit, for the diff",
      { baseSha: BASE, headSha: SHA, pullRequestNumber: 34 },
      { base: BASE, ref: SHA, sha: SHA },
    ],
    [
      "a base commit is ignored outside a pull request",
      { baseSha: BASE, headSha: SHA },
      { base: null, ref: SHA, sha: SHA },
    ],
    [
      "an issue with a known default branch fetches that branch",
      { defaultBranch: "main" },
      { base: null, ref: "refs/heads/main", sha: null },
    ],
    [
      "a head branch is preferred to the default branch",
      { defaultBranch: "main", headRef: "factory/bug-x" },
      { base: null, ref: "refs/heads/factory/bug-x", sha: null },
    ],
    [
      "with nothing known, the remote's default branch is fetched",
      {},
      { base: null, ref: "HEAD", sha: null },
    ],
    [
      "a short or malformed commit is not trusted as a commit",
      { defaultBranch: "main", headSha: "abc123" },
      { base: null, ref: "refs/heads/main", sha: null },
    ],
    [
      "a malformed base commit is dropped",
      { baseSha: "--upload-pack=x", headSha: SHA, pullRequestNumber: 1 },
      { base: null, ref: SHA, sha: SHA },
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(planCheckout(state(overrides))).toEqual(expected);
  });

  // A fork's branch name is chosen by whoever opened the pull request.
  test.each([
    "--upload-pack=touch /tmp/x",
    "-f",
    "a b",
    "refs/heads/main",
    "HEAD",
    "x;rm -rf /",
    "$(id)",
    "a..b",
  ])("a branch name like %j is never used as a ref", (headRef) => {
    expect(planCheckout(state({ headRef }))).toEqual({
      base: null,
      ref: "HEAD",
      sha: null,
    });
  });

  test.each([
    ["another repository", { owner: "acme", repo: "other" }],
    ["another owner", { owner: "evil", repo: "widgets" }],
  ])("an event for %s is not checked out", (_name, overrides) => {
    expect(planCheckout(state(overrides))).toBeNull();
  });

  test("the factory repository matches in any letter case", () => {
    expect(
      planCheckout(state({ owner: "ACME", repo: "Widgets" }))
    ).not.toBeNull();
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "a pull request number of %s falls back to a branch",
    (pullRequestNumber) => {
      expect(planCheckout(state({ pullRequestNumber }))?.ref).toBe("HEAD");
    }
  );
});

describe("checkoutCommand", () => {
  test("uses git by absolute path, the literal repository URL, and quotes every value; once there is a repository to ask, it stops if git's config rewrites URLs", () => {
    expect(
      checkoutCommand("/workspace", { base: BASE, ref: SHA, sha: SHA })
    ).toBe(
      [
        "mkdir -p '/workspace'",
        "/usr/bin/git -C '/workspace' init -q",
        // The workspace outlives the turn, so nothing is fetched while its
        // git config holds a rewrite rule, however one got there.
        "{ for scope in --local --worktree --global --system; do if /usr/bin/git -C '/workspace' config \"$scope\" --includes --get-regexp '^url\\.' >/dev/null 2>&1; then echo 'A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.' >&2; exit 1; fi; done; }",
        "(/usr/bin/git -C '/workspace' remote remove origin >/dev/null 2>&1 || true)",
        `/usr/bin/git -C '/workspace' remote add origin '${REMOTE_URL}'`,
        `/usr/bin/git -C '/workspace' fetch --depth 1 origin '${SHA}'`,
        `/usr/bin/git -C '/workspace' checkout --detach '${SHA}'`,
        `/usr/bin/git -C '/workspace' fetch --depth 1 origin '${BASE}'`,
        "/usr/bin/git -C '/workspace' rev-parse HEAD",
      ].join(" && ")
    );
  });

  test.each(["/workspace", "/vercel/sandbox", "/tmp/it's a path"])(
    "the guard is the one for the workspace at %s, as the step right after git init and before anything touches a remote",
    (path) => {
      const steps = checkoutCommand(path, {
        base: null,
        ref: "HEAD",
        sha: null,
      }).split(" && ");
      expect(steps[1]?.endsWith(" init -q")).toBe(true);
      expect(steps[2]).toBe(`{ ${rewriteGuard(path)}; }`);
      expect(steps.slice(0, 2).join(" ")).not.toMatch(/remote|fetch/);
      expect(steps.slice(3).every((step) => !step.includes("for scope"))).toBe(
        true
      );
    }
  );

  test("a ref that is not a commit is checked out from FETCH_HEAD", () => {
    const command = checkoutCommand("/workspace", {
      base: null,
      ref: "refs/pull/34/head",
      sha: null,
    });
    expect(command).toContain("fetch --depth 1 origin 'refs/pull/34/head'");
    expect(command).toContain("checkout --detach 'FETCH_HEAD'");
  });

  test("the remote is always the factory repository", () => {
    expect(REMOTE_URL).toBe("https://github.com/acme/widgets.git");
  });
});

describe("checkoutForTurn", () => {
  beforeAll(() => {
    resetTokenScopeMemo();
  });

  test("fetches under a read-only lease that matches only the placeholder, and removes it afterwards", async () => {
    const { sandbox, steps } = fakeSandbox((command) =>
      command.includes("fetch") ? { stdout: `${SHA}\n` } : { exitCode: 1 }
    );
    const { deps, requests } = lease();
    const result = await checkoutForTurn(
      sandbox,
      state({ headSha: SHA }),
      deps
    );

    expect(result).toEqual({ path: "/workspace", sha: SHA });
    // The probe, the lease going on, the checkout, the lease coming off.
    expect(steps.map((step) => step.kind)).toEqual([
      "run",
      "policy",
      "run",
      "policy",
    ]);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });

    // Read-only: no permission in the request can write.
    expect(requests).toHaveLength(1);
    const [permissions] = requests;
    expect(permissions).toContain("contents:read");
    expect(permissions?.filter((entry) => !entry.endsWith(":read"))).toEqual(
      []
    );

    const policy = JSON.stringify(steps.at(1));
    // The token is swapped in only for a request that carries the placeholder.
    expect(policy).toContain(basic("factory-lease-1"));
    expect(policy).toContain(basic(TOKEN));
    expect(policy).toContain('"match"');

    const [, , run] = steps;
    expect(run).toMatchObject({
      command: checkoutCommand("/workspace", {
        base: null,
        ref: SHA,
        sha: SHA,
      }),
      kind: "run",
    });
    // The process holds the placeholder, never the token.
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(JSON.stringify(run)).toContain(basic("factory-lease-1"));
  });

  test("is a no-op when the workspace is already at the commit: no token, no policy", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({ stdout: `${SHA}\n` }));
    const { deps, requests } = lease();
    const result = await checkoutForTurn(
      sandbox,
      state({ headSha: SHA }),
      deps
    );

    expect(result).toEqual({ path: "/workspace", sha: SHA });
    expect(steps).toEqual([
      { command: headCommand("/workspace"), env: {}, kind: "run" },
    ]);
    expect(requests).toEqual([]);
  });

  test.each<[string, { exitCode?: number; stdout?: string }]>([
    ["the probe failed, whatever it printed", { exitCode: 1, stdout: SHA }],
    ["the workspace is at another commit", { stdout: `${BASE}\n` }],
  ])("fetches when %s", async (_name, probe) => {
    const { sandbox, steps } = fakeSandbox((command) =>
      command.includes("fetch") ? { stdout: `${SHA}\n` } : probe
    );
    const { deps, requests } = lease();
    await checkoutForTurn(sandbox, state({ headSha: SHA }), deps);
    expect(steps.map((step) => step.kind)).toEqual([
      "run",
      "policy",
      "run",
      "policy",
    ]);
    expect(requests).toHaveLength(1);
  });

  test("an event for another repository touches nothing", async () => {
    const { sandbox, steps } = fakeSandbox();
    const { deps, requests } = lease();
    expect(
      await checkoutForTurn(sandbox, state({ repo: "other" }), deps)
    ).toBeNull();
    expect(steps).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a failed fetch throws, and the lease is still removed", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({
      exitCode: 128,
      stderr: "fatal: repository not found",
    }));
    const { deps } = lease();
    await expect(
      checkoutForTurn(sandbox, state({ defaultBranch: "main" }), deps)
    ).rejects.toThrow(
      /Checking out acme\/widgets failed \(exit 128\).*not found/
    );
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("reports the commit git printed when the ref was not a commit", async () => {
    const { sandbox } = fakeSandbox(() => ({ stdout: `noise\n${SHA}\n` }));
    const { deps } = lease();
    expect(
      await checkoutForTurn(sandbox, state({ pullRequestNumber: 34 }), deps)
    ).toEqual({ path: "/workspace", sha: SHA });
  });

  test("no policy this checkout sets adds a credential to a request that lacks the placeholder", async () => {
    const { sandbox, steps } = fakeSandbox(() => ({ stdout: `${SHA}\n` }));
    const { deps } = lease();
    await checkoutForTurn(sandbox, state({ defaultBranch: "main" }), deps);
    const rules = steps.flatMap((step) => {
      if (step.kind !== "policy" || step.policy === "allow-all") {
        return [];
      }
      const { allow } = step.policy as {
        allow: Record<string, { match?: unknown; transform?: unknown }[]>;
      };
      return Object.values(allow).flat();
    });
    // The lease did set rules, and each of them carries the token.
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(JSON.stringify(rule.transform)).toContain(basic(TOKEN));
      expect(JSON.stringify(rule.match)).toContain(basic("factory-lease-1"));
    }
  });

  test.each<[string, Partial<CheckoutState>, string]>([
    ["the planned commit", { headSha: SHA }, SHA],
    ["the planned ref", { pullRequestNumber: 34 }, "refs/pull/34/head"],
  ])(
    "reports %s when git printed nothing that is a commit",
    async (_name, overrides, expected) => {
      const { sandbox } = fakeSandbox((command) =>
        command.includes("fetch")
          ? { stdout: "not a commit\n" }
          : { exitCode: 1 }
      );
      const { deps } = lease();
      expect(await checkoutForTurn(sandbox, state(overrides), deps)).toEqual({
        path: "/workspace",
        sha: expected,
      });
    }
  );
});

describe("isCheckoutSandbox", () => {
  const whole = {
    name: "x",
    resolvePath: () => "",
    run: () => 0,
    setNetworkPolicy: () => undefined,
  };

  test("a sandbox with a name, a network policy, and path resolution qualifies", () => {
    expect(isCheckoutSandbox(fakeSandbox().sandbox)).toBe(true);
    expect(isCheckoutSandbox(whole)).toBe(true);
  });

  test.each(["name", "setNetworkPolicy", "resolvePath"] as const)(
    "one without %s does not",
    (missing) => {
      const { [missing]: _dropped, ...rest } = whole;
      expect(isCheckoutSandbox(rest)).toBe(false);
    }
  );
});

/*
 * The handler in `agent/channels/github.ts`, called the way eve calls it.
 * The channel module is the real one; only `githubChannel` and Connect's
 * `getToken` are stand-ins (see the top of this file).
 */
describe("the channel's turn.started handler is the factory's own, not eve's built-in one", () => {
  interface TurnContext {
    channel: {
      state: CheckoutState & { checkoutPath: string | null };
      thread: { react: (emoji: string) => Promise<void> };
    };
    getSandbox: () => Promise<object>;
  }
  type TurnStarted = (event: unknown, ctx: TurnContext) => Promise<void>;

  const turnStarted = async (): Promise<TurnStarted> => {
    const channel = (await import("#channels/github.js")) as unknown as {
      default: { events?: Record<string, TurnStarted | undefined> };
    };
    const handler = channel.default.events?.["turn.started"];
    if (typeof handler !== "function") {
      throw new Error("the channel leaves turn.started to eve's default");
    }
    return handler;
  };

  /** A turn's context: a fake sandbox, the thread's reactions, the state. */
  const turn = (
    overrides: Partial<CheckoutState>,
    options: {
      react?: (emoji: string) => Promise<void>;
      respond?: Parameters<typeof fakeSandbox>[0];
      sandbox?: object;
    } = {}
  ) => {
    const reactions: string[] = [];
    const { sandbox, steps } = fakeSandbox(options.respond);
    const ctx: TurnContext = {
      channel: {
        state: { ...state(overrides), checkoutPath: null },
        thread: {
          react:
            options.react ??
            (async (emoji) => {
              reactions.push(emoji);
            }),
        },
      },
      getSandbox: async () => options.sandbox ?? sandbox,
    };
    return { ctx, reactions, steps };
  };

  /** The checkout fetched: every command with `fetch` in it prints the commit. */
  const fetched = (command: string) =>
    command.includes("fetch") ? { stdout: `${SHA}\n` } : { exitCode: 1 };

  const warnings = () =>
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeAll(() => {
    resetTokenScopeMemo();
    connect.getToken.mockImplementation(async () => TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    connect.getToken.mockClear();
  });

  test("it reacts, checks the repository out under a read-only lease that is taken off again, and records where the checkout is and its commit", async () => {
    const handler = await turnStarted();
    const { ctx, reactions, steps } = turn(
      { pullRequestNumber: 34 },
      { respond: fetched }
    );
    await handler({}, ctx);

    expect(reactions).toEqual(["eyes"]);
    // The lease going on, the checkout, the lease coming off.
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    const [on, run, off] = steps;
    expect(run).toMatchObject({
      command: checkoutCommand("/workspace", {
        base: null,
        ref: "refs/pull/34/head",
        sha: null,
      }),
      kind: "run",
    });
    expect(off).toEqual({ kind: "policy", policy: "allow-all" });

    // The token is the one minted here, for reading only, and it sits behind
    // a placeholder: the command holds the placeholder, never the token.
    expect(connect.getToken).toHaveBeenCalledTimes(1);
    const [, request] = connect.getToken.mock.calls[0] ?? [];
    const [details] = (
      request as { authorizationDetails: { permissions?: string[] }[] }
    ).authorizationDetails;
    expect(details?.permissions).toContain("contents:read");
    expect(
      details?.permissions?.filter((entry) => !entry.endsWith(":read"))
    ).toEqual([]);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    const header = run?.kind === "run" ? run.env.GIT_CONFIG_VALUE_0 : "";
    const [, credential = ""] = header.split("Authorization: Basic ");
    expect(Buffer.from(credential, "base64").toString()).toMatch(
      /^x-access-token:factory-[0-9a-f-]{36}$/
    );
    // The policy swaps exactly that placeholder for the token.
    expect(JSON.stringify(on)).toContain(`"exact":"Basic ${credential}"`);
    expect(JSON.stringify(on)).toContain(basic(TOKEN));

    expect(ctx.channel.state.checkoutPath).toBe("/workspace");
    expect(ctx.channel.state.headSha).toBe(SHA);
  });

  test("a workspace already at the commit is recorded without a token or a policy", async () => {
    const handler = await turnStarted();
    const { ctx, reactions, steps } = turn(
      { headSha: SHA },
      { respond: () => ({ stdout: `${SHA}\n` }) }
    );
    await handler({}, ctx);
    expect(reactions).toEqual(["eyes"]);
    expect(steps).toEqual([
      { command: headCommand("/workspace"), env: {}, kind: "run" },
    ]);
    expect(connect.getToken).not.toHaveBeenCalled();
    expect(ctx.channel.state.checkoutPath).toBe("/workspace");
    expect(ctx.channel.state.headSha).toBe(SHA);
  });

  test("a reaction that fails is logged, and the checkout still happens", async () => {
    const warn = warnings();
    const handler = await turnStarted();
    const failure = new Error("403: resource not accessible");
    const { ctx, steps } = turn(
      { pullRequestNumber: 34 },
      {
        react: () => Promise.reject(failure),
        respond: fetched,
      }
    );
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([
      ["[factory] GitHub reaction failed:", failure],
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(ctx.channel.state.checkoutPath).toBe("/workspace");
  });

  test("a checkout that fails is logged, the lease still comes off, and the turn goes on with nothing recorded", async () => {
    const warn = warnings();
    const handler = await turnStarted();
    const { ctx, reactions, steps } = turn(
      { pullRequestNumber: 34 },
      {
        respond: () => ({ exitCode: 128, stderr: "fatal: not found" }),
      }
    );
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(reactions).toEqual(["eyes"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [label, error] = warn.mock.calls[0] ?? [];
    expect(label).toBe("[factory] GitHub checkout failed:");
    expect(String(error)).toMatch(
      /Checking out acme\/widgets failed \(exit 128\)/
    );
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
    expect(ctx.channel.state.checkoutPath).toBeNull();
    expect(ctx.channel.state.headSha).toBeNull();
  });

  test("a sandbox that cannot hold a lease is not checked out into: nothing runs there and no token is minted", async () => {
    const warn = warnings();
    const handler = await turnStarted();
    const commands: string[] = [];
    // Everything a checkout would call, except the network policy.
    const bare = {
      name: "sbx_local",
      resolvePath: () => "/workspace",
      run: async ({ command }: { command: string }) => {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: `${SHA}\n` };
      },
    };
    const { ctx, reactions } = turn(
      { pullRequestNumber: 34 },
      { sandbox: bare }
    );
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(reactions).toEqual(["eyes"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain(
      "The checkout needs a sandbox with a network policy"
    );
    expect(commands).toEqual([]);
    expect(connect.getToken).not.toHaveBeenCalled();
    expect(ctx.channel.state.checkoutPath).toBeNull();
  });

  test("an event for another repository is reacted to and nothing is checked out", async () => {
    const handler = await turnStarted();
    const { ctx, reactions, steps } = turn({ headSha: SHA, repo: "other" });
    await handler({}, ctx);
    expect(reactions).toEqual(["eyes"]);
    expect(steps).toEqual([]);
    expect(ctx.channel.state.checkoutPath).toBeNull();
    expect(ctx.channel.state.headSha).toBe(SHA);
  });
});

/*
 * The rendered command, run with the real git against a local bare
 * repository standing in for GitHub (git's own `insteadOf`, this process
 * only). No network.
 */
const hasGit = spawnSync("git", ["--version"]).status === 0;
// CI sets this, so a runner without git fails the suite instead of skipping.
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

describe.runIf(required)("the CLI contract tests are required here", () => {
  test("git is installed", () => {
    expect(hasGit).toBe(true);
  });
});

describe.skipIf(!hasGit)("the checkout command, run for real", () => {
  let root = "";
  let remote = "";
  let head = "";
  let base = "";

  const identity = {
    GIT_AUTHOR_EMAIL: "factory@example.test",
    GIT_AUTHOR_NAME: "Factory Test",
    GIT_COMMITTER_EMAIL: "factory@example.test",
    GIT_COMMITTER_NAME: "Factory Test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // The guard asks `git config --system`, which reads the system file
    // even so; this machine's own file is not the test's.
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...identity },
    }).trim();

  /** The rendered command, with whichever git this machine has. */
  const localize = (command: string): string =>
    command.replaceAll(
      "/usr/bin/git",
      execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
    );

  /**
   * The environment a rendered command runs in here: the factory URL pointed
   * at the bare repository. That rewrite is the test's own and travels in
   * the environment, where the command's guard does not look.
   */
  const rendered = (overrides: Record<string, string> = {}) => ({
    ...process.env,
    ...identity,
    ...overrides,
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_KEY_2: "advice.detachedHead",
    GIT_CONFIG_KEY_3: "uploadpack.allowAnySHA1InWant",
    GIT_CONFIG_VALUE_0: REMOTE_URL,
    GIT_CONFIG_VALUE_1: "always",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_VALUE_3: "true",
  });

  /** Runs a rendered command with the factory URL pointed at the bare repo. */
  const runRendered = (command: string): string =>
    execFileSync("sh", ["-c", localize(command)], {
      encoding: "utf8",
      env: rendered(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

  /** The same, for a command that may fail: its status and both streams. */
  const tryRendered = (
    command: string,
    overrides: Record<string, string> = {}
  ) =>
    spawnSync("sh", ["-c", localize(command)], {
      encoding: "utf8",
      env: rendered(overrides),
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "factory-checkout-"));
    remote = join(root, "remote.git");
    const seed = join(root, "seed");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    git(root, "clone", "-q", `file://${remote}`, seed);
    git(seed, "checkout", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "base\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "base");
    base = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", "origin", "main");
    git(seed, "checkout", "-q", "-b", "factory/feature");
    writeFileSync(join(seed, "feature.txt"), "feature\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "feature");
    head = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", "origin", "factory/feature");
  });

  afterAll(() => {
    if (root !== "") {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("checks out a commit by its hash into an empty directory, and prints it", () => {
    const path = join(root, "by-sha");
    const printed = runRendered(
      checkoutCommand(path, { base, ref: head, sha: head })
    );
    expect(printed.split("\n").at(-1)).toBe(head);
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("feature\n");
    // The base commit was fetched too, to diff against.
    expect(git(path, "cat-file", "-t", base)).toBe("commit");
    expect(git(path, "remote", "get-url", "origin")).toBe(REMOTE_URL);
  });

  /** The plan for an event on the factory repository, which always has one. */
  const planned = (overrides: Partial<CheckoutState> = {}) => {
    const plan = planCheckout(state(overrides));
    if (plan === null) {
      throw new Error("no plan for an event on the factory repository");
    }
    return plan;
  };

  test("checks out a branch through FETCH_HEAD", () => {
    const path = join(root, "by-branch");
    const plan = planned({ headRef: "factory/feature" });
    expect(plan).toEqual({
      base: null,
      ref: "refs/heads/factory/feature",
      sha: null,
    });
    runRendered(checkoutCommand(path, plan));
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
  });

  test("checks out the default branch when nothing is known", () => {
    const path = join(root, "by-default");
    const plan = planned();
    expect(plan.ref).toBe("HEAD");
    runRendered(checkoutCommand(path, plan));
    expect(git(path, "rev-parse", "HEAD")).toBe(base);
  });

  test("runs again over an existing checkout and moves it to the new commit", () => {
    const path = join(root, "again");
    runRendered(checkoutCommand(path, { base: null, ref: base, sha: base }));
    expect(git(path, "rev-parse", "HEAD")).toBe(base);
    runRendered(checkoutCommand(path, { base: null, ref: head, sha: head }));
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(runRendered(headCommand(path))).toBe(head);
  });

  /*
   * The orchestrator's workspace is kept between turns. A
   * `url.<base>.insteadOf` rule in it, however it got there, would send the
   * next turn's fetch, and the token leased for it, to another repository.
   * The command stops before it fetches.
   */
  describe("a workspace whose git config rewrites URLs", () => {
    const REFUSED =
      "A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.\n";
    let made = 0;

    /** A workspace checked out at the base commit, as an earlier turn left it. */
    const workspace = (): string => {
      made += 1;
      const path = join(root, `guarded-${made}`);
      runRendered(checkoutCommand(path, { base: null, ref: base, sha: base }));
      expect(git(path, "rev-parse", "HEAD")).toBe(base);
      return path;
    };
    const next = (path: string) =>
      checkoutCommand(path, { base: null, ref: head, sha: head });

    /** The command stopped at the guard: the workspace is as it was. */
    const expectRefused = (
      result: ReturnType<typeof tryRendered>,
      path: string
    ) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(REFUSED);
      expect(result.stdout).toBe("");
      expect(git(path, "rev-parse", "HEAD")).toBe(base);
      // The new commit was never fetched.
      expect(
        spawnSync("git", ["-C", path, "cat-file", "-e", `${head}^{commit}`], {
          env: { ...process.env, ...identity },
        }).status
      ).not.toBe(0);
    };

    test.each<[string, (decoy: string) => [key: string, value: string]]>([
      [
        "url.<decoy>.insteadOf for the factory URL",
        (decoy) => [`url.file://${decoy}.insteadOf`, REMOTE_URL],
      ],
      [
        "url.<decoy>.pushInsteadOf for the factory URL",
        (decoy) => [`url.file://${decoy}.pushInsteadOf`, REMOTE_URL],
      ],
      [
        "a rule about some other host entirely",
        () => ["url.https://mirror.example.test/.insteadOf", "https://x.test/"],
      ],
    ])(
      "%s in the workspace's config: the checkout exits 1 with the guard's message, and the workspace stays where it was",
      (_name, setting) => {
        const path = workspace();
        const decoy = join(root, `decoy-${made}.git`);
        git(root, "init", "-q", "--bare", decoy);
        git(path, "config", ...setting(decoy));
        expectRefused(tryRendered(next(path)), path);
        // The remote the earlier turn configured is as it was.
        expect(git(path, "config", "--get", "remote.origin.url")).toBe(
          REMOTE_URL
        );
        expect(git(decoy, "for-each-ref")).toBe("");
      }
    );

    test("the guard runs before the remote is touched: a directory that is a repository with a rule and no remote is left with no remote", () => {
      made += 1;
      const path = join(root, `guarded-${made}`);
      git(root, "init", "-q", path);
      git(path, "config", "url.file:///nowhere.insteadOf", REMOTE_URL);
      const result = tryRendered(next(path));
      expect([result.status, result.stderr]).toEqual([1, REFUSED]);
      expect(git(path, "remote")).toBe("");
    });

    test("a rule in the user's config file (GIT_CONFIG_GLOBAL) is refused too", () => {
      const path = workspace();
      const file = join(root, "global.gitconfig");
      writeFileSync(
        file,
        `[url "file:///nowhere"]\n\tinsteadOf = ${REMOTE_URL}\n`
      );
      expectRefused(tryRendered(next(path), { GIT_CONFIG_GLOBAL: file }), path);
    });

    test("with the rule removed, the same command moves the workspace to the new commit", () => {
      const path = workspace();
      const key = "url.file:///nowhere.insteadOf";
      git(path, "config", key, REMOTE_URL);
      expectRefused(tryRendered(next(path)), path);
      git(path, "config", "--unset", key);
      const result = tryRendered(next(path));
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe(head);
      expect(git(path, "rev-parse", "HEAD")).toBe(head);
    });

    test("with no rule in any file the checkout goes through, though the environment this test runs git in holds one", () => {
      const path = workspace();
      const result = tryRendered(next(path));
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("A git URL rewrite");
      expect(git(path, "rev-parse", "HEAD")).toBe(head);
    });
  });
});
