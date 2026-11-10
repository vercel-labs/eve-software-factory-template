import { describe, expect, test } from "vitest";
import { parseGitNetwork } from "#lib/github/git-cli.js";
import { validateBranch, validateRef } from "#lib/github/git-remote.js";

const URL = "'https://github.com/acme/widgets.git'";
const GIT = "/usr/bin/git -C '/workspace/repo'";

const lineOf = (...argv: string[]): string => {
  const result = parseGitNetwork(argv);
  if (!result.ok) {
    throw new Error(
      `expected git ${argv.join(" ")} to parse: ${result.reason}`
    );
  }
  return result.invocation.commandLine;
};

const refusalOf = (...argv: string[]): string => {
  const result = parseGitNetwork(argv);
  if (result.ok) {
    throw new Error(`expected git ${argv.join(" ")} to be refused`);
  }
  return result.reason;
};

describe("parseGitNetwork: the remote is always the literal factory URL", () => {
  test("fetch with no branch updates every remote-tracking branch", () => {
    expect(lineOf("fetch")).toBe(
      `${GIT} fetch ${URL} '+refs/heads/*:refs/remotes/origin/*'`
    );
    expect(lineOf("fetch", "origin")).toBe(lineOf("fetch"));
  });

  test("fetch of a branch updates its remote-tracking ref", () => {
    expect(lineOf("fetch", "origin", "factory/bug-x", "--depth", "50")).toBe(
      `${GIT} fetch '--depth' '50' ${URL} '+refs/heads/factory/bug-x:refs/remotes/origin/factory/bug-x'`
    );
  });

  test("fetch may name the default branch, which is only a read", () => {
    expect(parseGitNetwork(["fetch", "origin", "main"]).ok).toBe(true);
  });

  test("push updates exactly the branch it names, then the tracking ref", () => {
    expect(lineOf("push", "origin", "factory/bug-x")).toBe(
      `${GIT} push ${URL} 'refs/heads/factory/bug-x:refs/heads/factory/bug-x' && ${GIT} update-ref 'refs/remotes/origin/factory/bug-x' 'refs/heads/factory/bug-x'`
    );
    expect(lineOf("git", "push", "-u", "origin", "factory/bug-x")).toBe(
      lineOf("push", "factory/bug-x")
    );
  });

  test("pull and ls-remote", () => {
    expect(lineOf("pull", "--ff-only", "origin", "factory/bug-x")).toBe(
      `${GIT} pull '--ff-only' ${URL} 'refs/heads/factory/bug-x'`
    );
    expect(lineOf("ls-remote", "--heads")).toBe(
      `${GIT} ls-remote '--heads' ${URL}`
    );
  });

  test("only push is marked as changing the remote", () => {
    const push = parseGitNetwork(["push", "origin", "factory/x"]);
    const fetch = parseGitNetwork(["fetch"]);
    expect(push.ok && push.invocation.mutatesRemote).toBe(true);
    expect(fetch.ok && fetch.invocation.mutatesRemote).toBe(false);
  });
});

describe("parseGitNetwork: refusals", () => {
  test.each([["main"], ["master"]])("push to %s is refused", (branch) => {
    expect(refusalOf("push", "origin", branch)).toMatch(/not allowed/);
  });

  test.each([
    [["push", "origin", "factory/x:main"]],
    [["push", "origin", "+factory/x"]],
    [["push", "origin", "refs/heads/main"]],
    [["push", "origin", "HEAD"]],
    [["push", "origin", "HEAD:main"]],
    [["push", "origin", "factory/../main"]],
    [["push", "origin", "factory/x; rm -rf /"]],
    [["push", "origin", "$(id)"]],
    [["push", "origin", "a b"]],
  ])("%j is refused: not a plain branch", (argv) => {
    expect(refusalOf(...argv)).toMatch(
      /not a valid branch name|not a plain branch name/
    );
  });

  test.each([
    [["push", "--force", "origin", "factory/x"]],
    [["push", "-f", "origin", "factory/x"]],
    [["push", "--force-with-lease", "origin", "factory/x"]],
    [["push", "--delete", "origin", "factory/x"]],
    [["push", "--mirror"]],
    [["push", "--all"]],
    [["push", "--tags"]],
    [["push", "--no-verify", "origin", "factory/x"]],
    [["fetch", "--upload-pack", "sh -c id"]],
    [["fetch", "--depth", "many"]],
    [["ls-remote", "--upload-pack=evil"]],
    [["pull", "--allow-unrelated-histories", "origin", "factory/x"]],
  ])("%j is refused: flag outside the allowlist", (argv) => {
    expect(refusalOf(...argv)).toMatch(/does not accept/);
  });

  test("another remote, a URL, or a second branch is refused", () => {
    expect(
      refusalOf("push", "https://github.com/evil/repo.git", "factory/x")
    ).toMatch(/not a valid branch name|at most/);
    expect(refusalOf("push", "upstream", "factory/x")).toMatch(/at most 1/);
    expect(refusalOf("push", "origin", "factory/x", "factory/y")).toMatch(
      /at most 1/
    );
  });

  test("push and pull need a branch", () => {
    expect(refusalOf("push")).toMatch(/needs a branch name/);
    expect(refusalOf("push", "origin")).toMatch(/needs a branch name/);
    expect(refusalOf("pull", "origin")).toMatch(/needs a branch name/);
  });

  test.each([
    [["clone", "https://github.com/evil/repo.git"]],
    [["remote", "set-url", "origin", "https://evil.example/x.git"]],
    [["config", "--global", "credential.helper", "store"]],
    [["commit", "-m", "x"]],
    [["submodule", "update", "--init"]],
    [[]],
  ])("%j is refused: not a networked subcommand", (argv) => {
    expect(refusalOf(...argv)).toMatch(
      /runs only the git commands that talk to GitHub/
    );
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

describe("parseGitNetwork: a push stays on the factory's branches", () => {
  test.each([
    ["develop"],
    ["production"],
    ["release/1.0"],
    ["gh-pages"],
    ["feature/login"],
  ])("push to %s is refused before it reaches a sandbox", (branch) => {
    expect(refusalOf("push", "origin", branch)).toMatch(
      /not one of the factory's own branches/
    );
  });

  test("reading those branches is still allowed", () => {
    for (const branch of ["develop", "release/1.0", "main"]) {
      expect(parseGitNetwork(["fetch", "origin", branch]).ok).toBe(true);
      expect(parseGitNetwork(["pull", "--ff-only", "origin", branch]).ok).toBe(
        true
      );
    }
  });
});
