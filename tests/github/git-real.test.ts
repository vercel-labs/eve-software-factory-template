import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  CURRENT_BRANCH_COMMAND,
  GIT_BINARY,
  parseGitFetch,
  pushCommandLine,
  rewriteGuard,
} from "#lib/github/git-cli.js";
import { REMOTE_URL, REPO_DIR } from "#lib/github/git-remote.js";
import { cloneCommand } from "#lib/github/repo-sandbox.js";

/**
 * Runs the git commands the factory writes with the real git binary.
 *
 * @remarks
 * The parser tests check the text of each command. These check what the
 * commands do. A bare repository in a temporary directory stands in for
 * GitHub (git's own `insteadOf` rewrites the factory URL to it, for this
 * process only), and a clone made by `cloneCommand` stands in for a
 * station's checkout. Each command line the runtime writes runs unmodified
 * apart from the checkout path and where git lives on this machine. What an
 * agent types in its own shell (`git fetch origin <branch>`,
 * `git checkout`) runs as plain git in that same clone. No network.
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
  // `git config --system` reads the system file even so, and the guard on
  // the runtime's commands asks it; this machine's own file is not the test's.
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** Plain git, as an agent runs it in its shell. Throws when git fails. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * Points a command the runtime wrote at this machine: the temporary checkout
 * for the sandbox's, and whichever git is installed for the image's.
 */
const localize = (command: string): string =>
  command
    .replaceAll(`'${REPO_DIR}'`, `'${checkout}'`)
    .replaceAll(GIT_BINARY, "git");

/**
 * Runs a command the runtime wrote, the way the sandbox would: through a shell.
 *
 * @param environment - Overrides, for a test that gives git a user-level or
 * system-level config file of its own.
 */
const runWritten = (
  command: string,
  environment: Record<string, string> = {}
) =>
  spawnSync("bash", ["-c", localize(command)], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...identity,
      ...environment,
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

const push = (branch: string) => runWritten(pushCommandLine(branch));

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
  execFileSync(
    "bash",
    ["-c", cloneCommand(`file://${remote}`).replaceAll(GIT_BINARY, "git")],
    {
      cwd: root,
      env: { ...process.env, ...identity },
      stdio: "ignore",
    }
  );
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

describe.skipIf(!hasGit)("the factory's git commands, run for real", () => {
  test("the clone command names git by absolute path and leaves a checkout in repo", () => {
    expect(cloneCommand("https://github.com/acme/widgets.git")).toBe(
      "/usr/bin/git clone --depth 50 https://github.com/acme/widgets.git repo && /usr/bin/git -C repo config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'"
    );
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(checkout, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*"
    );
  });

  test("a plain fetch of a branch, then a plain checkout, works in the station's clone", () => {
    // A shallow clone knows only the default branch to begin with.
    expect(() =>
      git(checkout, "rev-parse", "--verify", "origin/factory/existing")
    ).toThrow();

    // What the station's instructions say to type, with no tool in between.
    git(checkout, "fetch", "-q", "origin", "factory/existing");
    expect(git(checkout, "rev-parse", "origin/factory/existing")).toBe(
      git(remote, "rev-parse", "factory/existing")
    );
    git(checkout, "checkout", "-q", "factory/existing");
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "factory/existing"
    );
    expect(git(checkout, "log", "-1", "--format=%s")).toBe("existing work");
  });

  test("without the widened refspec the same two commands fail, which is why the clone sets it", () => {
    const narrow = join(root, "narrow");
    git(root, "clone", "-q", "--depth", "50", `file://${remote}`, narrow);
    git(narrow, "fetch", "-q", "origin", "factory/existing");
    expect(() => git(narrow, "checkout", "-q", "factory/existing")).toThrow(
      /did not match/
    );
  });

  test("the current-branch command prints the branch that is checked out", () => {
    const current = runWritten(CURRENT_BRANCH_COMMAND);
    expect(current.status).toBe(0);
    expect(current.stdout).toBe("factory/existing\n");
  });

  test("the current-branch command fails on a detached HEAD, so a push has no branch to guess", () => {
    git(checkout, "checkout", "-q", "--detach", "HEAD");
    const current = runWritten(CURRENT_BRANCH_COMMAND);
    expect(current.status).not.toBe(0);
    expect(current.stdout).toBe("");
    git(checkout, "checkout", "-q", "factory/existing");
  });

  test("pushing a new feature branch creates exactly that branch on the remote", () => {
    git(checkout, "checkout", "-q", "-b", "factory/new-work", "origin/main");
    commit(checkout, "new.txt", "new work");
    const before = git(remote, "for-each-ref", "--format=%(refname)")
      .split("\n")
      .sort();

    const pushed = push("factory/new-work");
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
    expect(push("factory/new-work").status).toBe(0);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "address review findings"
    );
  });

  test("the push sends the named branch, whichever branch is checked out", () => {
    git(checkout, "checkout", "-q", "-b", "factory/side", "origin/main");
    commit(checkout, "side.txt", "side work");
    git(checkout, "checkout", "-q", "factory/new-work");
    const tracked = git(checkout, "rev-parse", "origin/factory/new-work");
    expect(push("factory/side").status).toBe(0);
    expect(git(remote, "log", "-1", "--format=%s", "factory/side")).toBe(
      "side work"
    );
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "address review findings"
    );
    // The tracking ref that moved is the pushed branch's, to that branch.
    expect(git(checkout, "rev-parse", "origin/factory/side")).toBe(
      git(checkout, "rev-parse", "factory/side")
    );
    expect(git(checkout, "rev-parse", "origin/factory/new-work")).toBe(tracked);
  });

  test("a push of a branch that does not exist fails and leaves the remote alone", () => {
    const before = git(remote, "for-each-ref");
    const pushed = push("factory/never-made");
    expect(pushed.status).not.toBe(0);
    expect(git(remote, "for-each-ref")).toBe(before);
    // The tracking ref is only written after a push that worked.
    expect(() =>
      git(checkout, "rev-parse", "--verify", "origin/factory/never-made")
    ).toThrow();
  });

  test("a push that would rewrite the remote branch is rejected by git, since force is unavailable", () => {
    git(checkout, "reset", "-q", "--hard", "HEAD~1");
    commit(checkout, "diverged.txt", "diverged history");
    const pushed = push("factory/new-work");
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toMatch(/rejected|non-fast-forward/);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "address review findings"
    );
  });

  test("a plain pull fast-forwards the checked-out branch from the remote", () => {
    git(checkout, "reset", "-q", "--hard", "origin/factory/new-work~1");
    git(checkout, "pull", "-q", "--ff-only", "origin", "factory/new-work");
    expect(git(checkout, "log", "-1", "--format=%s")).toBe(
      "address review findings"
    );
  });

  test("a plain fetch with no branch brings in every branch, new ones included", () => {
    const seed = join(root, "seed");
    git(seed, "checkout", "-q", "main");
    commit(seed, "upstream.txt", "someone else merged");
    git(seed, "push", "-q", "origin", "main");
    git(seed, "checkout", "-q", "-b", "factory/later");
    commit(seed, "later.txt", "later work");
    git(seed, "push", "-q", "origin", "factory/later");

    git(checkout, "fetch", "-q");
    expect(git(checkout, "rev-parse", "origin/main")).toBe(
      git(remote, "rev-parse", "main")
    );
    expect(git(checkout, "rev-parse", "origin/factory/later")).toBe(
      git(remote, "rev-parse", "factory/later")
    );
  });

  test("the default branch never moves, whatever the checkout's own remote config says", () => {
    const mainBefore = git(remote, "rev-parse", "main");
    const decoy = join(root, "decoy.git");
    git(root, "init", "-q", "--bare", decoy);
    // A model can rewrite the checkout's remotes and push defaults at will.
    git(checkout, "config", "remote.origin.pushurl", `file://${decoy}`);
    git(checkout, "config", "remote.pushDefault", "origin");
    git(checkout, "config", "branch.factory/new-work.merge", "refs/heads/main");
    git(checkout, "config", "push.default", "upstream");
    git(checkout, "checkout", "-q", "factory/new-work");
    git(checkout, "reset", "-q", "--hard", "origin/factory/new-work");
    commit(checkout, "sneaky.txt", "try to land on main");
    expect(push("factory/new-work").status).toBe(0);
    expect(git(remote, "rev-parse", "main")).toBe(mainBefore);
    expect(git(remote, "log", "-1", "--format=%s", "factory/new-work")).toBe(
      "try to land on main"
    );
    // The push went to the literal URL, not to where origin now points.
    expect(git(decoy, "for-each-ref")).toBe("");
  });
});

/*
 * git applies a `url.<base>.insteadOf` rule even to the literal URL the push
 * and the fetch name, and the checkout's config is the agent's to write. So
 * each command starts with a guard that refuses to run while any of git's
 * config files holds such a rule.
 *
 * This file's own rewrite, which points the factory URL at the bare
 * repository, travels in the environment (GIT_CONFIG_COUNT), where the
 * runtime's own settings travel and where the guard does not look.
 */
describe.skipIf(!hasGit)("a URL rewrite in git's config files", () => {
  const REFUSED =
    "A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.\n";
  let decoy = "";
  let savedConfig = "";
  let made = 0;

  const configFile = () => join(checkout, ".git", "config");
  const refsOf = (repository: string) => git(repository, "for-each-ref");
  const rule = (base: string, key = "insteadOf", value = REMOTE_URL) =>
    `[url "${base}"]\n\t${key} = ${value}\n`;

  /** A branch with one new commit on it, ready to push. */
  const newBranch = (): string => {
    made += 1;
    const branch = `factory/guarded-${made}`;
    git(checkout, "checkout", "-q", "-b", branch, "origin/main");
    commit(checkout, `guarded-${made}.txt`, `guarded work ${made}`);
    return branch;
  };

  /** The push was stopped by the guard: nothing left the checkout. */
  const expectRefused = (
    pushed: ReturnType<typeof runWritten>,
    branch: string,
    before: { decoy: string; remote: string }
  ) => {
    expect(pushed.status).toBe(1);
    expect(pushed.stderr).toBe(REFUSED);
    expect(pushed.stdout).toBe("");
    expect(refsOf(remote)).toBe(before.remote);
    expect(refsOf(decoy)).toBe(before.decoy);
    // Nor does the checkout believe the branch was delivered.
    expect(() =>
      git(checkout, "rev-parse", "--verify", `origin/${branch}`)
    ).toThrow();
  };

  beforeAll(() => {
    decoy = join(root, "rewrite-decoy.git");
    git(root, "init", "-q", "--bare", decoy);
  });

  beforeEach(() => {
    savedConfig = readFileSync(configFile(), "utf8");
  });

  afterEach(() => {
    writeFileSync(configFile(), savedConfig);
    rmSync(join(checkout, ".git", "config.worktree"), { force: true });
  });

  test("the guard is valid shell, and in a checkout with no rule it prints nothing and lets the command go on", () => {
    const syntax = spawnSync("sh", ["-n", "-c", rewriteGuard(REPO_DIR)], {
      encoding: "utf8",
    });
    expect([syntax.status, syntax.stderr]).toEqual([0, ""]);
    const guarded = runWritten(`${rewriteGuard(REPO_DIR)}; echo went on`);
    expect([guarded.status, guarded.stdout, guarded.stderr]).toEqual([
      0,
      "went on\n",
      "",
    ]);
  });

  test("with no rule in any file the push goes through, though the environment this test runs git in holds one", () => {
    const branch = newBranch();
    const pushed = runWritten(pushCommandLine(branch));
    expect(pushed.status).toBe(0);
    expect(pushed.stderr).not.toContain("A git URL rewrite");
    expect(git(remote, "rev-parse", branch)).toBe(
      git(checkout, "rev-parse", "HEAD")
    );
    expect(git(checkout, "rev-parse", `origin/${branch}`)).toBe(
      git(checkout, "rev-parse", branch)
    );
    // And no config file of git's was given the rule along the way.
    expect(readFileSync(configFile(), "utf8")).not.toMatch(/\[url /i);
  });

  test.each<[string, (decoyUrl: string) => [key: string, value: string]]>([
    [
      "url.<decoy>.insteadOf for the factory URL",
      (decoyUrl) => [`url.${decoyUrl}.insteadOf`, REMOTE_URL],
    ],
    [
      "url.<decoy>.pushInsteadOf for the factory URL",
      (decoyUrl) => [`url.${decoyUrl}.pushInsteadOf`, REMOTE_URL],
    ],
    [
      "a rule for all of github.com",
      (decoyUrl) => [`url.${decoyUrl}.insteadOf`, "https://github.com/"],
    ],
    [
      "a rule written in capitals",
      (decoyUrl) => [`URL.${decoyUrl}.INSTEADOF`, REMOTE_URL],
    ],
    // The guard does not work out which URLs a rule would catch.
    [
      "a rule about some other host entirely",
      () => [
        "url.https://mirror.example.test/.insteadOf",
        "https://example.test/",
      ],
    ],
    [
      "any other url.<base> setting",
      () => ["url.https://mirror.example.test/.note", "x"],
    ],
  ])(
    "%s in the checkout's .git/config: the rendered push exits 1 with the guard's message and pushes nothing",
    (_name, setting) => {
      const branch = newBranch();
      const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
      git(checkout, "config", ...setting(`file://${decoy}`));
      expectRefused(runWritten(pushCommandLine(branch)), branch, before);
    }
  );

  test("without the guard that rule would have sent the push to the decoy, which is what the guard is for", () => {
    const branch = newBranch();
    const remoteBefore = refsOf(remote);
    git(checkout, "config", `url.file://${decoy}.insteadOf`, REMOTE_URL);
    const guard = `${rewriteGuard(REPO_DIR)}; `;
    const written = pushCommandLine(branch);
    expect(written.startsWith(guard)).toBe(true);
    // The checkout's rule is longer than the environment's, so git prefers it.
    const unguarded = runWritten(written.slice(guard.length));
    expect(unguarded.status).toBe(0);
    expect(refsOf(remote)).toBe(remoteBefore);
    expect(git(decoy, "rev-parse", branch)).toBe(
      git(checkout, "rev-parse", "HEAD")
    );
  });

  test("a rule in a file the checkout's config includes is found as well", () => {
    const branch = newBranch();
    const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
    const included = join(root, "included.gitconfig");
    writeFileSync(included, rule(`file://${decoy}`));
    git(checkout, "config", "include.path", included);
    expectRefused(runWritten(pushCommandLine(branch)), branch, before);
  });

  test.each<[string, string]>([
    ["the user's config file (GIT_CONFIG_GLOBAL)", "GIT_CONFIG_GLOBAL"],
    ["the system's config file (GIT_CONFIG_SYSTEM)", "GIT_CONFIG_SYSTEM"],
  ])(
    "a rule in %s is refused too, with the checkout's own config clean",
    (_name, variable) => {
      const branch = newBranch();
      const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
      const file = join(root, `${variable.toLowerCase()}.gitconfig`);
      writeFileSync(file, rule(`file://${decoy}`));
      const environment: Record<string, string> =
        variable === "GIT_CONFIG_SYSTEM"
          ? { GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_SYSTEM: file }
          : { GIT_CONFIG_GLOBAL: file };
      expectRefused(
        runWritten(pushCommandLine(branch), environment),
        branch,
        before
      );

      // The same file without the rule changes nothing: the push goes through.
      writeFileSync(file, "[user]\n\tname = Someone Else\n");
      expect(runWritten(pushCommandLine(branch), environment).status).toBe(0);
      expect(git(remote, "rev-parse", branch)).toBe(
        git(checkout, "rev-parse", "HEAD")
      );
    }
  );

  test("once the rule is removed, the same command goes through, as the message says", () => {
    const branch = newBranch();
    const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
    const key = `url.file://${decoy}.insteadOf`;
    git(checkout, "config", key, REMOTE_URL);
    expectRefused(runWritten(pushCommandLine(branch)), branch, before);
    git(checkout, "config", "--unset", key);
    expect(runWritten(pushCommandLine(branch)).status).toBe(0);
    expect(git(remote, "rev-parse", branch)).toBe(
      git(checkout, "rev-parse", "HEAD")
    );
    expect(refsOf(decoy)).toBe(before.decoy);
  });

  describe("the fetch the runtime writes", () => {
    const fetchOf = (...args: string[]): string => {
      const parsed = parseGitFetch(args);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }
      return parsed.commandLine;
    };

    let advanced = 0;

    /** Moves `branch` on the remote one commit ahead of what the checkout has. */
    const advance = (branch: string): string => {
      const seed = join(root, "seed");
      git(seed, "fetch", "-q", "origin");
      git(seed, "checkout", "-q", "-B", branch, `origin/${branch}`);
      advanced += 1;
      commit(seed, `advance-${advanced}.txt`, "moved on the remote");
      git(seed, "push", "-q", "origin", branch);
      return git(remote, "rev-parse", branch);
    };

    test("with no rule in any file it brings the branch in", () => {
      const tip = advance("factory/existing");
      const fetched = runWritten(fetchOf("origin", "factory/existing"));
      expect(fetched.status).toBe(0);
      expect(git(checkout, "rev-parse", "origin/factory/existing")).toBe(tip);
    });

    test.each(["insteadOf", "pushInsteadOf"])(
      "with url.<base>.%s in the checkout's config it exits 1 with the guard's message and fetches nothing",
      (key) => {
        const before = git(checkout, "rev-parse", "origin/factory/existing");
        const tip = advance("factory/existing");
        expect(tip).not.toBe(before);
        git(checkout, "config", `url.file://${decoy}.${key}`, REMOTE_URL);
        const fetched = runWritten(fetchOf("origin", "factory/existing"));
        expect(fetched.status).toBe(1);
        expect(fetched.stderr).toBe(REFUSED);
        expect(fetched.stdout).toBe("");
        expect(git(checkout, "rev-parse", "origin/factory/existing")).toBe(
          before
        );
      }
    );
  });

  /*
   * git reads a fourth file besides the checkout's, the user's and the
   * system's: with `extensions.worktreeConfig` on, `.git/config.worktree`,
   * which `git config --local` leaves out and `--worktree` reads. Both the
   * switch and the file are in the checkout, where the agent writes, so the
   * guard asks about that file too.
   */
  test("a rule in the checkout's worktree config (.git/config.worktree) is refused like one in .git/config", () => {
    const branch = newBranch();
    const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
    git(checkout, "config", "extensions.worktreeConfig", "true");
    git(
      checkout,
      "config",
      "--worktree",
      `url.file://${decoy}.insteadOf`,
      REMOTE_URL
    );
    expectRefused(runWritten(pushCommandLine(branch)), branch, before);
  });

  // With that switch on, `--worktree` no longer falls back to `.git/config`,
  // so the two files are asked about separately.
  test("with the worktree config switched on, a rule in .git/config is still refused", () => {
    const branch = newBranch();
    const before = { decoy: refsOf(decoy), remote: refsOf(remote) };
    git(checkout, "config", "extensions.worktreeConfig", "true");
    git(checkout, "config", `url.file://${decoy}.insteadOf`, REMOTE_URL);
    // The rule is in `.git/config` only: asked alone, `--worktree` finds none.
    expect(() =>
      git(checkout, "config", "--worktree", "--get-regexp", "^url\\.")
    ).toThrow();
    expect(
      git(checkout, "config", "--local", "--get-regexp", "^url\\.")
    ).toContain(REMOTE_URL);
    expectRefused(runWritten(pushCommandLine(branch)), branch, before);
  });
});
