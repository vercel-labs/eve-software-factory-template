import { describe, expect, test } from "vitest";
import {
  CURRENT_BRANCH_COMMAND,
  GIT_BINARY,
  isRepoDirectory,
  MAX_FETCH_ARGS,
  MAX_PUSH_ARGS,
  parseGitFetch,
  parseGitPush,
  pushCommandLine,
  rewriteGuard,
} from "#lib/github/git-cli.js";
import { validateBranch, validateRef } from "#lib/github/git-remote.js";

/**
 * What every git command the runtime writes for a station's checkout starts
 * with: stop, with a message, when one of git's config files rewrites URLs.
 * Written out in full here; tests/github/git-real.test.ts runs it.
 */
const GUARD =
  "for scope in --local --worktree --global --system; do if /usr/bin/git -C '/workspace/repo' config \"$scope\" --includes --get-regexp '^url\\.' >/dev/null 2>&1; then echo 'A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.' >&2; exit 1; fi; done";

/** The branch a push was accepted for; null means the checked-out branch. */
const branchOf = (...args: string[]): string | null => {
  const result = parseGitPush(args);
  if (!result.ok) {
    throw new Error(
      `expected git push ${args.join(" ")} to parse: ${result.reason}`
    );
  }
  return result.push.branch;
};

const refusalOf = (...args: string[]): string => {
  const result = parseGitPush(args);
  if (result.ok) {
    throw new Error(`expected git push ${args.join(" ")} to be refused`);
  }
  return result.reason;
};

describe("parseGitPush: what a push may name", () => {
  test.each<[string[], string | null]>([
    // No branch named: the caller resolves the checked-out one and checks it.
    [[], null],
    [["origin"], null],
    [["origin", "HEAD"], null],
    [["-u", "origin", "HEAD"], null],
    [["-u"], null],
    // A branch of the factory's own.
    [["origin", "factory/bug-x"], "factory/bug-x"],
    [
      ["origin", "factory/feature-add-export.v2"],
      "factory/feature-add-export.v2",
    ],
    // The upstream flags are accepted for familiarity, wherever they sit.
    [["-u", "origin", "factory/bug-x"], "factory/bug-x"],
    [["--set-upstream", "origin", "factory/bug-x"], "factory/bug-x"],
    [["origin", "-u", "factory/bug-x"], "factory/bug-x"],
    [["origin", "factory/bug-x", "-u"], "factory/bug-x"],
  ])("git push %j pushes %j", (args, branch) => {
    expect(parseGitPush(args)).toEqual({ ok: true, push: { branch } });
  });

  test("the argument limit counts flags, and a push at the limit is read", () => {
    const flags = new Array<string>(MAX_PUSH_ARGS - 2).fill("-u");
    expect(MAX_PUSH_ARGS).toBe(8);
    expect(branchOf(...flags, "origin", "factory/x")).toBe("factory/x");
    expect(refusalOf(...flags, "-u", "origin", "factory/x")).toBe(
      "Too many arguments (limit 8)."
    );
  });
});

describe("parseGitPush: refusals", () => {
  test.each([["main"], ["master"], ["Main"], ["MASTER"]])(
    "a push to %s is refused, in any letter case",
    (branch) => {
      expect(refusalOf("origin", branch)).toBe(
        `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`
      );
    }
  );

  test.each([
    ["develop"],
    ["production"],
    ["release/1.0"],
    ["gh-pages"],
    ["feature/login"],
    ["factory"],
    ["my-factory/x"],
    ["Factory/x"],
    // The remote's name is not a branch either.
    ["origin"],
  ])("a push to %s is refused: not one of the factory's branches", (branch) => {
    expect(refusalOf("origin", branch)).toBe(
      `"${branch}" is not one of the factory's own branches. Push a branch named factory/<type>-<short-slug>.`
    );
  });

  test.each([
    [["--force", "origin", "factory/x"], "--force"],
    [["-f", "origin", "factory/x"], "-f"],
    [["origin", "factory/x", "--force"], "--force"],
    [["--force-with-lease", "origin", "factory/x"], "--force-with-lease"],
    [
      ["--force-with-lease=factory/x", "origin", "factory/x"],
      "--force-with-lease=factory/x",
    ],
    [["--delete", "origin", "factory/x"], "--delete"],
    [["-d", "origin", "factory/x"], "-d"],
    [["--mirror"], "--mirror"],
    [["--all"], "--all"],
    [["--tags"], "--tags"],
    [["origin", "--tags"], "--tags"],
    [["--no-verify", "origin", "factory/x"], "--no-verify"],
    [["--prune", "origin"], "--prune"],
    [
      ["--repo=https://example.test/x.git"],
      "--repo=https://example.test/x.git",
    ],
    [["--receive-pack=sh", "origin", "factory/x"], "--receive-pack=sh"],
    [["-o", "ci.skip", "origin", "factory/x"], "-o"],
    // A cluster that starts with a tolerated flag is still another flag.
    [["-uf", "origin", "factory/x"], "-uf"],
    [["--", "origin", "factory/x"], "--"],
  ])("git push %j is refused: the flag is not accepted", (args, flag) => {
    expect(refusalOf(...args)).toBe(
      `git push does not accept ${flag} here. Write it as: git push origin <branch>.`
    );
  });

  test.each([
    ["factory/x:main"],
    ["factory/x:factory/x"],
    ["HEAD:main"],
    ["HEAD:refs/heads/main"],
    [":factory/x"],
    ["+factory/x"],
    ["+factory/x:main"],
    ["factory/../main"],
    ["factory//x"],
    ["factory/x; rm -rf /"],
    ["$(id)"],
    ["a b"],
    ["factory/x~1"],
    ["factory/*"],
    [""],
  ])("git push origin %j is refused: not a branch name", (ref) => {
    expect(refusalOf("origin", ref)).toBe(
      `"${ref}" is not a valid branch name.`
    );
  });

  test.each([["refs/heads/factory/x"], ["refs/heads/main"], ["refs/tags/v1"]])(
    "git push origin %s is refused: a full ref, not a plain branch",
    (ref) => {
      expect(refusalOf("origin", ref)).toBe(
        `"${ref}" is not a plain branch name. Pass the branch name without a refs/ prefix.`
      );
    }
  );

  test.each([
    [["origin", "factory/x", "factory/y"]],
    [["origin", "factory/x", "HEAD"]],
    [["origin", "HEAD", "factory/x"]],
    [["-u", "origin", "factory/x", "main"]],
  ])("git push %j is refused: one branch at a time", (args) => {
    expect(refusalOf(...args)).toBe(
      "git push takes one branch. Push branches one at a time."
    );
  });

  test.each([
    [["upstream", "factory/x"]],
    [["https://github.com/acme/widgets.git", "factory/x"]],
    [["https://github.com/evil/repo.git", "factory/x"]],
    [["git@github.com:acme/widgets.git", "factory/x"]],
    [["../elsewhere", "factory/x"]],
    [["Origin", "factory/x"]],
    [[""]],
    // git reads the first word as the remote, so these name no branch.
    [["factory/x"]],
    [["HEAD"]],
    [["-u", "factory/x"]],
    [["factory/x", "origin"]],
  ])("git push %j is refused: origin is the only remote", (args) => {
    expect(refusalOf(...args)).toBe(
      "The only remote is origin, the factory repository. Write it as: git push origin <branch>."
    );
  });

  test("more arguments than the limit are refused before anything is read", () => {
    const many = new Array<string>(MAX_PUSH_ARGS + 1).fill("--force");
    expect(refusalOf(...many)).toBe("Too many arguments (limit 8).");
  });
});

/*
 * The runtime's git commands name the repository's URL literally, so the
 * remote a checkout has configured cannot send them elsewhere. A
 * `url.<base>.insteadOf` rule can: git applies it to a literal URL too, and
 * the checkout's config is the agent's to write. The guard refuses to run
 * with one in any of git's config files.
 */
describe("rewriteGuard", () => {
  // Each property below is read from what the function returns, so each
  // test stands on its own rather than on the literal above.
  const guard = rewriteGuard("/workspace/repo");

  test("is one shell fragment: each config file in turn, includes followed, any url.* key, a message on stderr and exit 1", () => {
    expect(guard).toBe(GUARD);
  });

  test("looks in the checkout's, the user's and the system's config files, and not at the environment, where the runtime's own settings travel", () => {
    expect(guard).toContain(
      "for scope in --local --worktree --global --system;"
    );
    expect(guard).not.toMatch(/GIT_CONFIG|--show-origin|-c /);
  });

  test("names git by absolute path, so a git earlier on PATH cannot answer for it", () => {
    expect(guard).toContain(" /usr/bin/git -C ");
    // The other `git` is in the message it prints.
    expect(guard.match(/\bgit\b/g)).toHaveLength(2);
  });

  test("ends without a separator, so a caller chooses how the command goes on", () => {
    expect(guard.endsWith("fi; done")).toBe(true);
  });

  test.each<[string, string]>([
    ["/workspace/repo", "'/workspace/repo'"],
    ["/vercel/sandbox", "'/vercel/sandbox'"],
    ["/tmp/my repo", "'/tmp/my repo'"],
    ["/tmp/it's here", "'/tmp/it'\\''s here'"],
    ["/tmp/$(id); x", "'/tmp/$(id); x'"],
  ])("the checkout path %j is quoted as one word", (path, quoted) => {
    expect(rewriteGuard(path)).toBe(
      GUARD.replace("'/workspace/repo'", () => quoted)
    );
  });
});

describe("the commands the runtime writes for a push", () => {
  const GIT = "/usr/bin/git -C '/workspace/repo'";

  test("git is named by absolute path", () => {
    expect(GIT_BINARY).toBe("/usr/bin/git");
  });

  test("the guard comes first; then the push updates exactly the branch it names on the literal repository URL, then the tracking ref", () => {
    expect(pushCommandLine("factory/bug-x")).toBe(
      `${GUARD}; ${GIT} push 'https://github.com/acme/widgets.git' 'refs/heads/factory/bug-x:refs/heads/factory/bug-x' && ${GIT} update-ref 'refs/remotes/origin/factory/bug-x' 'refs/heads/factory/bug-x'`
    );
  });

  test.each(["factory/x", "factory/bug-fix-login", "factory/a.b_c"])(
    "the push of %s starts with the guard for the station's checkout",
    (branch) => {
      expect(
        pushCommandLine(branch).startsWith(
          `${rewriteGuard("/workspace/repo")}; /usr/bin/git -C '/workspace/repo' push `
        )
      ).toBe(true);
    }
  );

  test("the remote is never the checkout's origin, which a model can rewrite", () => {
    expect(pushCommandLine("factory/x")).not.toMatch(/\borigin\b(?!\/)/);
  });

  test("the command that reads the checked-out branch", () => {
    expect(CURRENT_BRANCH_COMMAND).toBe(
      "/usr/bin/git -C '/workspace/repo' symbolic-ref --short HEAD"
    );
  });
});

describe("isRepoDirectory", () => {
  test.each([
    [null],
    ["repo"],
    ["./repo"],
    ["repo/"],
    ["./repo/"],
    ["repo//"],
    ["/workspace/repo"],
    ["/workspace/repo/"],
  ])("%j is the station's checkout", (directory) => {
    expect(isRepoDirectory(directory)).toBe(true);
  });

  test.each([
    [""],
    ["."],
    [".."],
    ["/"],
    ["other"],
    ["Repo"],
    ["repo2"],
    ["repo/sub"],
    ["repo/.."],
    ["repo/../other"],
    ["../repo"],
    ["sub/repo"],
    ["/repo"],
    ["/tmp/repo"],
    ["/workspace"],
    ["/workspace/repo/sub"],
    ["/workspace/repo/.."],
    ["/workspace/other"],
    ["/workspace/../workspace/repo"],
    ["~/repo"],
    ["workspace/repo"],
  ])("%j is not", (directory) => {
    expect(isRepoDirectory(directory)).toBe(false);
  });
});

describe("validateRef and validateBranch", () => {
  test("plain branch names pass the shape check", () => {
    for (const name of [
      "factory/bug-x",
      "feature_1",
      "release-1.2",
      "a",
      "main",
    ]) {
      expect(validateRef(name)).toBeNull();
    }
  });

  test("only the factory's own branches may be pushed", () => {
    expect(validateBranch("factory/bug-x")).toBeNull();
    expect(validateBranch("factory/feature-add-export.v2")).toBeNull();
    for (const name of [
      "develop",
      "production",
      "release/1.0",
      "gh-pages",
      "feature/login",
      "factory",
      "my-factory/x",
      "Factory/x",
    ]) {
      expect(validateBranch(name)).toMatch(
        /not one of the factory's own branches/
      );
    }
  });

  test("the default branch passes the shape check and fails the push check, in any letter case", () => {
    expect(validateRef("main")).toBeNull();
    for (const name of ["main", "master", "Main", "MASTER"]) {
      expect(validateBranch(name)).toMatch(/not allowed/);
    }
  });

  test.each([
    "",
    "-x",
    "x-",
    ".x",
    "x.",
    "a..b",
    "a//b",
    "a b",
    "a:b",
    "a~1",
    "a^",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "refs/heads/x",
    "HEAD",
    "x\n",
    "é",
  ])("%j is refused by both", (name) => {
    expect(validateRef(name)).not.toBeNull();
    expect(validateBranch(name)).not.toBeNull();
  });
});

/**
 * `git fetch` normally runs in the agent's shell. It is parsed here only for
 * a deployment that cannot issue a read-only token, where the runtime runs
 * the fetch itself.
 */
describe("parseGitFetch", () => {
  // Like a push, a fetch the runtime writes starts with the guard.
  const GIT = `${GUARD}; /usr/bin/git -C '/workspace/repo' fetch`;
  const URL = "'https://github.com/acme/widgets.git'";
  const spec = (branch: string) =>
    `'+refs/heads/${branch}:refs/remotes/origin/${branch}'`;

  test.each<[string[], string]>([
    [[], `${GIT} ${URL} '+refs/heads/*:refs/remotes/origin/*'`],
    [["origin"], `${GIT} ${URL} '+refs/heads/*:refs/remotes/origin/*'`],
    [["origin", "main"], `${GIT} ${URL} ${spec("main")}`],
    [
      ["origin", "factory/bug-x", "main"],
      `${GIT} ${URL} ${spec("factory/bug-x")} ${spec("main")}`,
    ],
    [["--prune", "origin", "main"], `${GIT} '--prune' ${URL} ${spec("main")}`],
    [
      ["--depth", "50", "origin", "main"],
      `${GIT} '--depth' '50' ${URL} ${spec("main")}`,
    ],
    [
      ["origin", "main", "--no-tags", "--unshallow"],
      `${GIT} '--no-tags' '--unshallow' ${URL} ${spec("main")}`,
    ],
  ])(
    "fetch %j is rendered behind the guard, against the literal repository URL",
    (args, line) => {
      expect(parseGitFetch(args)).toEqual({ commandLine: line, ok: true });
      expect(
        line.startsWith(
          `${rewriteGuard("/workspace/repo")}; /usr/bin/git -C '/workspace/repo' fetch `
        )
      ).toBe(true);
    }
  );

  test.each<[string[], RegExp]>([
    [["upstream", "main"], /only remote is origin/],
    [["main"], /only remote is origin/],
    [["https://github.com/evil/repo.git", "main"], /only remote is origin/],
    [["origin", "refs/heads/main"], /not a plain branch name/],
    [["origin", "HEAD"], /not a plain branch name/],
    [["origin", "+main"], /not a valid branch name/],
    [["origin", "main:evil"], /not a valid branch name/],
    [["origin", "a..b"], /not a valid branch name/],
    [["origin", "$(id)"], /not a valid branch name/],
    [["--upload-pack=touch /tmp/x", "origin"], /does not accept --upload-pack/],
    [["--all"], /does not accept --all/],
    [["--tags"], /does not accept --tags/],
    [["-f", "origin", "main"], /does not accept -f/],
    [["--depth", "0", "origin"], /does not accept --depth/],
    [["--depth", "x", "origin"], /does not accept --depth/],
    [["--depth", "5x", "origin"], /does not accept --depth/],
    [["--depth", "-1", "origin"], /does not accept --depth/],
    [["--depth", "1234567", "origin"], /does not accept --depth/],
    [["--depth=5", "origin"], /does not accept --depth=5/],
    [["--force", "origin", "main"], /does not accept --force/],
    [["--prune-tags", "origin"], /does not accept --prune-tags/],
    [["--update-head-ok", "origin", "main"], /does not accept/],
    [["--refmap=x", "origin", "main"], /does not accept --refmap=x/],
    [["-u", "origin", "main"], /does not accept -u/],
    [["--depth"], /does not accept --depth/],
    [["--recurse-submodules", "origin"], /does not accept/],
    [["-c", "core.sshCommand=id", "origin"], /does not accept -c/],
  ])("fetch %j is refused", (args, reason) => {
    const parsed = parseGitFetch(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toMatch(reason);
  });

  test("a fetch at the argument limit is read, and one over it is refused", () => {
    expect(MAX_FETCH_ARGS).toBe(12);
    const atLimit = ["origin", ...new Array<string>(11).fill("main")];
    expect(parseGitFetch(atLimit).ok).toBe(true);
    expect(parseGitFetch([...atLimit, "main"])).toEqual({
      ok: false,
      reason: "Too many arguments (limit 12).",
    });
  });

  test("the deepest fetch accepted has six digits", () => {
    const parsed = parseGitFetch(["--depth", "999999", "origin"]);
    expect(parsed.ok && parsed.commandLine).toBe(
      `${GIT} '--depth' '999999' ${URL} '+refs/heads/*:refs/remotes/origin/*'`
    );
  });

  test("nothing a caller passes reaches the command unquoted", () => {
    const parsed = parseGitFetch(["--depth", "5", "origin", "factory/a-b_c.d"]);
    expect(parsed.ok && parsed.commandLine).toBe(
      `${GIT} '--depth' '5' ${URL} ${spec("factory/a-b_c.d")}`
    );
  });
});
