import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseGitNetwork } from "#lib/github/git-cli.js";
import { REMOTE_URL, REPO_DIR } from "#lib/github/git-remote.js";
import { cloneCommand } from "#lib/github/repo-sandbox.js";

/**
 * Runs the commands the `git` tool renders with the real git binary.
 *
 * @remarks
 * The parser tests check the text of each command. These check what the
 * commands do: a bare repository in a temporary directory stands in for
 * GitHub (git's own `insteadOf` rewrites the factory URL to it, for this
 * process only), a clone stands in for a station's checkout, and each
 * rendered command line runs unmodified apart from the checkout path. No
 * network is involved.
 */
const hasGit = spawnSync("git", ["--version"]).status === 0;
// CI sets this, so a runner without git fails the suite instead of skipping.
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

let root = "";
let remote = "";
let checkout = "";

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
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Runs a rendered tool command, the way the sandbox would: through a shell. */
const runTool = (...args: string[]) => {
  const parsed = parseGitNetwork(args);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  const command = parsed.invocation.commandLine
    .replaceAll(`'${REPO_DIR}'`, `'${checkout}'`)
    .replaceAll("/usr/bin/git", "git");
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...identity,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_KEY_2: "protocol.file.allow",
      GIT_CONFIG_KEY_3: "advice.detachedHead",
      GIT_CONFIG_VALUE_0: REMOTE_URL,
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_VALUE_2: "always",
      GIT_CONFIG_VALUE_3: "false",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
};

const commit = (cwd: string, file: string, message: string) => {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

beforeAll(() => {
  if (!hasGit) {
    return;
  }
  root = mkdtempSync(join(tmpdir(), "factory-git-"));
  remote = join(root, "remote.git");
  checkout = join(root, "repo");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", `file://${remote}`, seed);
  git(seed, "checkout", "-q", "-b", "main");
  commit(seed, "README.md", "initial commit");
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", "factory/existing");
  commit(seed, "feature.txt", "existing work");
  git(seed, "push", "-q", "origin", "factory/existing");
  // The station's checkout, made by the same command factoryInit runs.
  execFileSync("bash", ["-c", cloneCommand(`file://${remote}`)], {
    cwd: root,
    env: { ...process.env, ...identity },
    stdio: "ignore",
  });
});

afterAll(() => {
  if (root !== "") {
    rmSync(root, { force: true, recursive: true });
  }
});

describe.runIf(required)("the CLI contract tests are required here", () => {
  test("git is installed", () => {
    expect(hasGit).toBe(true);
  });
});

describe.skipIf(!hasGit)("the git tool's commands, run for real", () => {
  test("fetching a branch makes it available to a plain checkout in the shell", () => {
    expect(() =>
      git(checkout, "rev-parse", "--verify", "origin/factory/existing")
    ).toThrow();

    const fetched = runTool("fetch", "origin", "factory/existing");
    expect(fetched.status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/factory/existing")).toBe(
      git(remote, "rev-parse", "factory/existing")
    );

    // What the station's instructions say to do next, with no tool involved.
    git(checkout, "checkout", "-q", "factory/existing");
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "factory/existing"
    );
    expect(git(checkout, "log", "-1", "--format=%s")).toBe("existing work");
  });

  test("pushing a new feature branch creates exactly that branch on the remote", () => {
    git(checkout, "checkout", "-q", "-b", "factory/new-work", "origin/main");
    commit(checkout, "new.txt", "new work");
    const before = git(remote, "for-each-ref", "--format=%(refname)")
      .split("\n")
      .sort();

    const pushed = runTool("push", "origin", "factory/new-work");
    expect(pushed.status).toBe(0);

    const after = git(remote, "for-each-ref", "--format=%(refname)")
      .split("\n")
      .sort();
    expect(after).toEqual([...before, "refs/heads/factory/new-work"].sort());
    expect(git(remote, "rev-parse", "factory/new-work")).toBe(
      git(checkout, "rev-parse", "HEAD")
    );
    expect(git(remote, "rev-parse", "main")).toBe(
      git(checkout, "rev-parse", "origin/main")
    );
  });

  test("after a push the checkout knows it is in sync, so git status tells the truth", () => {
    expect(git(checkout, "rev-parse", "origin/factory/new-work")).toBe(
      git(checkout, "rev-parse", "factory/new-work")
    );
  });

  test("a second push to the same branch delivers a revision", () => {
    commit(checkout, "revision.txt", "address review findings");
    expect(runTool("push", "origin", "factory/new-work").status).toBe(0);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "address review findings"
    );
  });

  test("a push that would rewrite the remote branch is rejected by git, since force is unavailable", () => {
    git(checkout, "reset", "-q", "--hard", "HEAD~1");
    commit(checkout, "diverged.txt", "diverged history");
    const pushed = runTool("push", "origin", "factory/new-work");
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toMatch(/rejected|non-fast-forward/);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "address review findings"
    );
  });

  test("pull fast-forwards the checked-out branch from the remote", () => {
    git(checkout, "reset", "-q", "--hard", "origin/factory/new-work~1");
    const pulled = runTool("pull", "--ff-only", "origin", "factory/new-work");
    expect(pulled.status).toBe(0);
    expect(git(checkout, "log", "-1", "--format=%s")).toBe(
      "address review findings"
    );
  });

  test("ls-remote lists the remote's branches", () => {
    const listed = runTool("ls-remote", "--heads");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("refs/heads/main");
    expect(listed.stdout).toContain("refs/heads/factory/new-work");
  });

  test("a bare fetch refreshes every remote-tracking branch", () => {
    const seed = join(root, "seed");
    git(seed, "checkout", "-q", "main");
    commit(seed, "upstream.txt", "someone else merged");
    git(seed, "push", "-q", "origin", "main");
    expect(runTool("fetch").status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(
      git(remote, "rev-parse", "main")
    );
  });

  test("the default branch never moves, whatever the checkout's own remote config says", () => {
    const mainBefore = git(remote, "rev-parse", "main");
    // A model can rewrite the checkout's remotes and push defaults at will.
    git(checkout, "config", "remote.pushDefault", "origin");
    git(checkout, "config", "branch.factory/new-work.merge", "refs/heads/main");
    git(checkout, "config", "push.default", "upstream");
    git(checkout, "checkout", "-q", "factory/new-work");
    git(checkout, "reset", "-q", "--hard", "origin/factory/new-work");
    commit(checkout, "sneaky.txt", "try to land on main");
    expect(runTool("push", "origin", "factory/new-work").status).toBe(0);
    expect(git(remote, "rev-parse", "main")).toBe(mainBefore);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "try to land on main"
    );
  });
});
