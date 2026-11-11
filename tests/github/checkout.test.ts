import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CheckoutSandbox,
  type CheckoutState,
  checkoutCommand,
  checkoutForTurn,
  headCommand,
  isCheckoutSandbox,
  planCheckout,
} from "#lib/github/checkout.js";
import { REMOTE_URL } from "#lib/github/git-remote.js";
import { resetTokenScopeMemo, type TokenMinter } from "#lib/github/lease.js";

/**
 * The orchestrator's per-turn checkout.
 *
 * @remarks
 * This checkout exists to keep one thing from happening: the GitHub App's
 * installation token being left attached to the root sandbox's git traffic,
 * which is what eve's built-in handler does and which the orchestrator's
 * shell could then use. So the tests here are mostly about the credential:
 * which token is minted, that it is only reachable through a placeholder,
 * and that nothing is left behind when the command ends.
 */

const TOKEN = "ghs_REALTOKEN0123456789abcdefghijklmnop";
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
  test("uses git by absolute path, the literal repository URL, and quotes every value", () => {
    expect(
      checkoutCommand("/workspace", { base: BASE, ref: SHA, sha: SHA })
    ).toBe(
      [
        "mkdir -p '/workspace'",
        "/usr/bin/git -C '/workspace' init -q",
        "(/usr/bin/git -C '/workspace' remote remove origin >/dev/null 2>&1 || true)",
        `/usr/bin/git -C '/workspace' remote add origin '${REMOTE_URL}'`,
        `/usr/bin/git -C '/workspace' fetch --depth 1 origin '${SHA}'`,
        `/usr/bin/git -C '/workspace' checkout --detach '${SHA}'`,
        `/usr/bin/git -C '/workspace' fetch --depth 1 origin '${BASE}'`,
        "/usr/bin/git -C '/workspace' rev-parse HEAD",
      ].join(" && ")
    );
  });

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
    expect(requests[0]?.some((entry) => entry.endsWith(":write"))).toBe(false);
    expect(requests[0]).toContain("contents:read");

    const policy = JSON.stringify(steps.at(1));
    // The token is swapped in only for a request that carries the placeholder.
    expect(policy).toContain(basic("factory-lease-1"));
    expect(policy).toContain(basic(TOKEN));
    expect(policy).toContain('"match"');

    const [, , run] = steps;
    expect(run?.kind === "run" && run.command).toBe(
      checkoutCommand("/workspace", { base: null, ref: SHA, sha: SHA })
    );
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
    for (const step of steps) {
      if (step.kind !== "policy" || step.policy === "allow-all") {
        continue;
      }
      const { allow } = step.policy as {
        allow: Record<string, { match?: unknown; transform?: unknown }[]>;
      };
      for (const rules of Object.values(allow)) {
        for (const rule of rules) {
          expect(rule.match).toBeDefined();
        }
      }
    }
  });
});

describe("isCheckoutSandbox", () => {
  test("needs a name, a network policy, and path resolution", () => {
    expect(isCheckoutSandbox(fakeSandbox().sandbox)).toBe(true);
    expect(isCheckoutSandbox({ run: () => undefined })).toBe(false);
    expect(
      isCheckoutSandbox({ name: "x", resolvePath: () => "", run: () => 0 })
    ).toBe(false);
  });
});

describe("the channel uses this checkout, not eve's built-in one", () => {
  test("agent/channels/github.ts overrides turn.started with checkoutForTurn", () => {
    const source = readFileSync("agent/channels/github.ts", "utf8");
    expect(source).toMatch(/events:\s*\{[\s\S]*"turn\.started"/);
    expect(source).toContain("checkoutForTurn(sandbox, state)");
  });
});

/**
 * The rendered command, run with the real git against a local bare
 * repository standing in for GitHub (git's own `insteadOf`, this process
 * only). No network.
 */
const hasGit = spawnSync("git", ["--version"]).status === 0;
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
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...identity },
    }).trim();

  /** Runs a rendered command with the factory URL pointed at the bare repo. */
  const runRendered = (command: string): string => {
    const local = command.replaceAll(
      "/usr/bin/git",
      execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
    );
    return execFileSync("sh", ["-c", local], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...identity,
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
        GIT_CONFIG_KEY_1: "protocol.file.allow",
        GIT_CONFIG_KEY_2: "advice.detachedHead",
        GIT_CONFIG_KEY_3: "uploadpack.allowAnySHA1InWant",
        GIT_CONFIG_VALUE_0: REMOTE_URL,
        GIT_CONFIG_VALUE_1: "always",
        GIT_CONFIG_VALUE_2: "false",
        GIT_CONFIG_VALUE_3: "true",
      },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  };

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
    // The base commit is there to diff against.
    expect(git(path, "cat-file", "-t", base)).toBe("commit");
    expect(git(path, "remote", "get-url", "origin")).toBe(REMOTE_URL);
  });

  test("checks out a branch through FETCH_HEAD", () => {
    const path = join(root, "by-branch");
    const plan = planCheckout(state({ headRef: "factory/feature" }));
    expect(plan).not.toBeNull();
    if (plan) {
      runRendered(checkoutCommand(path, plan));
    }
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
  });

  test("checks out the default branch when nothing is known", () => {
    const path = join(root, "by-default");
    const plan = planCheckout(state());
    if (plan) {
      runRendered(checkoutCommand(path, plan));
    }
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
});
