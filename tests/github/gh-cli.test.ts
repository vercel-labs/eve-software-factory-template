import { describe, expect, test } from "vitest";
import {
  bodiesToFiles,
  GH_COMMANDS,
  GH_ENVIRONMENT,
  ghCommandLine,
  MAX_GH_ARG_LENGTH,
  MAX_GH_ARGS,
  parseGh,
  shellQuote,
} from "#lib/github/cli.js";

const effectOf = (...argv: string[]) => {
  const result = parseGh(argv);
  if (!result.ok) {
    throw new Error(`expected ${argv.join(" ")} to parse: ${result.reason}`);
  }
  return result.invocation.effect;
};

const refusalOf = (...argv: string[]): string => {
  const result = parseGh(argv);
  if (result.ok) {
    throw new Error(`expected ${argv.join(" ")} to be refused`);
  }
  return result.reason;
};

describe("parseGh: reads", () => {
  test.each([
    [["issue", "view", "12"]],
    [["issue", "view", "12", "--comments", "--json", "title,body,labels"]],
    [["issue", "list", "--search", "login is broken", "--state", "all"]],
    [["issue", "status"]],
    [["label", "list", "--json", "name,description", "-L", "100"]],
    [["pr", "view", "34", "--json", "title,body,headRefName"]],
    [["pr", "view", "factory/bug-fix-login"]],
    [["pr", "diff", "34", "--name-only"]],
    [["pr", "checks", "34", "--json", "name,state,bucket"]],
    [["pr", "list", "--head", "factory/bug-fix-login", "--draft"]],
    [["repo", "view", "--json", "defaultBranchRef"]],
    [["repo", "view", "acme/widgets"]],
    [["run", "list", "--branch", "factory/x", "-w", "ci.yml"]],
    [["run", "view", "991", "--log-failed"]],
    [["workflow", "list"]],
    [["release", "list", "-L", "5"]],
    [["api", "repos/acme/widgets/commits/abc123/check-runs"]],
    [["api", "/repos/{owner}/{repo}/pulls/3/files", "--paginate"]],
    [["api", "repos/ACME/Widgets/branches", "-X", "GET"]],
    [
      [
        "api",
        "repos/acme/widgets/pulls/3",
        "-H",
        "Accept: application/vnd.github.diff",
      ],
    ],
  ])("%j is a read", (argv) => {
    expect(effectOf(...argv)).toEqual({ kind: "read" });
  });
});

describe("parseGh: writes are classified by what they can do", () => {
  test("label-only edits are the label effect, on issues and pull requests", () => {
    expect(effectOf("issue", "edit", "12", "--add-label", "bug")).toEqual({
      kind: "label",
    });
    expect(
      effectOf(
        "pr",
        "edit",
        "7",
        "--add-label",
        "bug",
        "--remove-label",
        "triage"
      )
    ).toEqual({ kind: "label" });
  });

  test("an edit that touches anything besides labels is a write", () => {
    expect(
      effectOf(
        "issue",
        "edit",
        "12",
        "--add-label",
        "bug",
        "--title",
        "New title"
      )
    ).toEqual({ kind: "write" });
    expect(
      effectOf("issue", "edit", "12", "--add-assignee", "octocat")
    ).toEqual({
      kind: "write",
    });
    expect(effectOf("pr", "edit", "7", "--add-reviewer", "octocat")).toEqual({
      kind: "write",
    });
    expect(effectOf("pr", "edit", "7", "--body", "x")).toEqual({
      kind: "write",
    });
  });

  test("an edit that changes nothing is refused", () => {
    expect(refusalOf("issue", "edit", "12")).toMatch(/at least one flag/);
  });

  test("comments carry the thread they land on", () => {
    expect(
      effectOf(
        "issue",
        "comment",
        "12",
        "--body",
        "Classification is complete."
      )
    ).toEqual({
      kind: "comment",
      thread: 12,
    });
    expect(effectOf("pr", "comment", "#34", "-b", "CI fix attempt 1")).toEqual({
      kind: "comment",
      thread: 34,
    });
    expect(
      effectOf(
        "issue",
        "comment",
        "https://github.com/acme/widgets/issues/56",
        "--body",
        "note"
      )
    ).toEqual({ kind: "comment", thread: 56 });
  });

  test("a comment addressed by branch has no known thread", () => {
    expect(effectOf("pr", "comment", "factory/bug-x", "--body", "hi")).toEqual({
      kind: "comment",
      thread: null,
    });
  });

  test("a comment needs a body, since there is no editor", () => {
    expect(refusalOf("issue", "comment", "12")).toMatch(/--body/);
  });

  test("closing and reopening an issue is the state effect", () => {
    expect(effectOf("issue", "close", "12", "--reason", "not planned")).toEqual(
      {
        commentThread: 12,
        kind: "state",
        withComment: false,
      }
    );
    expect(
      effectOf("issue", "reopen", "12", "--comment", "Reopening.")
    ).toEqual({
      commentThread: 12,
      kind: "state",
      withComment: true,
    });
  });

  test("a draft pull request is the draft-pr effect", () => {
    expect(
      effectOf(
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/bug-fix-login",
        "--base",
        "main",
        "--title",
        "Fix login",
        "--body",
        "Closes #12"
      )
    ).toEqual({ kind: "draft-pr" });
  });

  test("a pull request that is not a draft is the ship effect", () => {
    expect(
      effectOf(
        "pr",
        "create",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body",
        "B"
      )
    ).toEqual({ kind: "ship" });
  });

  test("a draft that requests reviewers or assignees is a write, since it notifies people", () => {
    expect(
      effectOf(
        "pr",
        "create",
        "-d",
        "-H",
        "factory/x",
        "-t",
        "T",
        "-b",
        "B",
        "-r",
        "octocat"
      )
    ).toEqual({ kind: "write" });
  });

  test("pr create refuses to infer anything from a checkout", () => {
    expect(
      refusalOf("pr", "create", "--draft", "--title", "T", "--body", "B")
    ).toMatch(/--head/);
  });

  test("marking ready is the ship effect, and undoing it is a plain write", () => {
    expect(effectOf("pr", "ready", "34")).toEqual({ kind: "ship" });
    expect(effectOf("pr", "ready", "34", "--undo")).toEqual({ kind: "write" });
  });

  test("other writes", () => {
    expect(effectOf("issue", "create", "--title", "T", "--body", "B")).toEqual({
      kind: "write",
    });
    expect(effectOf("pr", "close", "34")).toEqual({ kind: "write" });
    expect(
      effectOf("label", "create", "needs-repro", "--color", "ff0000")
    ).toEqual({
      kind: "write",
    });
  });
});

describe("parseGh: what the factory may never run", () => {
  test.each([
    [["pr", "merge", "34", "--squash"]],
    [["pr", "review", "34", "--approve"]],
    [["pr", "checkout", "34"]],
    [["repo", "delete", "acme/widgets", "--yes"]],
    [["repo", "edit", "--visibility", "public"]],
    [["repo", "create", "acme/other"]],
    [["auth", "token"]],
    [["auth", "status", "--show-token"]],
    [["secret", "set", "X", "--body", "y"]],
    [["secret", "list"]],
    [["variable", "set", "X"]],
    [["ssh-key", "add", "key.pub"]],
    [["gist", "create", "file"]],
    [["release", "create", "v1"]],
    [["release", "delete", "v1"]],
    [["workflow", "run", "deploy.yml"]],
    [["run", "rerun", "1"]],
    [["run", "cancel", "1"]],
    [["extension", "install", "x/y"]],
    [["alias", "set", "x", "y"]],
    [["config", "set", "editor", "vim"]],
    [["codespace", "create"]],
    [["issue", "delete", "12"]],
    [["issue", "transfer", "12", "acme/other"]],
    [["label", "delete", "bug"]],
    [["browse"]],
    [["search", "code", "token"]],
  ])("%j is refused", (argv) => {
    expect(refusalOf(...argv)).toMatch(/not available to the factory/);
  });

  test("unknown flags are refused, including the browser and editor ones", () => {
    expect(refusalOf("issue", "view", "12", "--web")).toMatch(
      /does not accept --web/
    );
    expect(refusalOf("pr", "create", "--draft", "--web")).toMatch(
      /does not accept/
    );
    expect(refusalOf("issue", "comment", "12", "--editor")).toMatch(
      /does not accept/
    );
    expect(
      refusalOf("issue", "comment", "12", "--delete-last", "--yes")
    ).toMatch(/does not accept/);
    expect(refusalOf("pr", "close", "34", "--delete-branch")).toMatch(
      /does not accept/
    );
    expect(refusalOf("pr", "create", "--fill")).toMatch(/does not accept/);
  });

  test("short-flag clusters and glued values are refused rather than guessed at", () => {
    expect(refusalOf("issue", "view", "12", "-cw")).toMatch(
      /does not accept -cw/
    );
    expect(refusalOf("pr", "list", "-L5")).toMatch(/does not accept -L5/);
    expect(refusalOf("issue", "view", "12", "--c")).toMatch(
      /does not accept --c/
    );
    expect(refusalOf("issue", "view", "12", "--comments=true")).toMatch(
      /does not accept/
    );
  });

  test("a flag missing its value is refused", () => {
    expect(refusalOf("issue", "list", "--search")).toMatch(/needs a value/);
  });

  test("the end-of-flags marker is refused", () => {
    expect(refusalOf("issue", "view", "--", "12")).toMatch(/"--"/);
  });
});

describe("parseGh: repository pinning", () => {
  test("--repo naming the factory repository is accepted and stripped", () => {
    const result = parseGh(["issue", "view", "12", "--repo", "acme/widgets"]);
    expect(result.ok && result.invocation.args).toEqual([
      "issue",
      "view",
      "12",
    ]);
    expect(parseGh(["-R", "Acme/Widgets", "pr", "view", "3"]).ok).toBe(true);
    expect(parseGh(["pr", "view", "3", "--repo=acme/widgets"]).ok).toBe(true);
    expect(
      parseGh(["pr", "view", "3", "-R", "https://github.com/acme/widgets"]).ok
    ).toBe(true);
  });

  test("repo view always names the factory repository, so it never depends on a checkout", () => {
    const bare = parseGh(["repo", "view", "--json", "defaultBranchRef"]);
    expect(bare.ok && bare.invocation.args).toEqual([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "acme/widgets",
    ]);
    const named = parseGh(["repo", "view", "acme/widgets"]);
    expect(named.ok && named.invocation.args).toEqual([
      "repo",
      "view",
      "acme/widgets",
    ]);
  });

  test.each([
    [["issue", "view", "12", "--repo", "evil/widgets"]],
    [["issue", "view", "12", "-R", "acme/other"]],
    [["issue", "view", "12", "--repo=acme/widgets-private"]],
    [["issue", "view", "12", "--repo", "acme/widgets/extra"]],
    [["issue", "view", "12", "--repo"]],
    [["repo", "view", "torvalds/linux"]],
  ])("%j is refused: another repository", (argv) => {
    expect(refusalOf(...argv)).toMatch(/only works on acme\/widgets/);
  });

  test("a thread URL on another repository is refused", () => {
    expect(
      refusalOf(
        "issue",
        "comment",
        "https://github.com/evil/repo/issues/1",
        "--body",
        "x"
      )
    ).toMatch(/is not on acme\/widgets/);
  });

  test("a selector that is neither a number nor a URL is refused for issues", () => {
    expect(refusalOf("issue", "view", "twelve")).toMatch(
      /not an issue or pull request number/
    );
    expect(refusalOf("issue", "view", "12; rm -rf /")).toMatch(/not an issue/);
  });
});

describe("parseGh: gh api is a read-only window onto the factory repository", () => {
  test.each([
    [["api", "repos/acme/widgets/issues", "-X", "POST"]],
    [["api", "repos/acme/widgets/issues/1", "--method", "PATCH"]],
    [["api", "repos/acme/widgets/git/refs/heads/x", "-X", "DELETE"]],
  ])("%j is refused: not GET", (argv) => {
    expect(refusalOf(...argv)).toMatch(/read-only/);
  });

  test("field flags, which turn a call into a POST, are not accepted", () => {
    expect(
      refusalOf("api", "repos/acme/widgets/issues", "-f", "title=x")
    ).toMatch(/does not accept -f/);
    expect(
      refusalOf("api", "repos/acme/widgets/issues", "--raw-field", "a=b")
    ).toMatch(/does not accept/);
    expect(
      refusalOf("api", "repos/acme/widgets/issues", "--input", "body.json")
    ).toMatch(/does not accept/);
  });

  test.each([
    [["api", "user"]],
    [["api", "graphql"]],
    [["api", "repos/evil/widgets/contents/x"]],
    [["api", "orgs/acme/members"]],
    [["api", "installation/repositories"]],
    [["api", "repos/acme"]],
    [["api", "https://api.github.com/repos/acme/widgets"]],
  ])("%j is refused: outside the repository", (argv) => {
    expect(refusalOf(...argv)).toMatch(
      /limited to repos\/acme\/widgets|not a plain API path/
    );
  });

  test.each([
    [["api", "repos/acme/widgets/../../evil/repo/contents/x"]],
    [["api", "repos/acme/widgets//x"]],
    [["api", "repos/acme/widgets/%2e%2e/%2e%2e/user"]],
    [["api", "repos/acme/widgets/..%2f..%2fuser"]],
    [["api", "repos/acme/widgets\\..\\x"]],
  ])("%j is refused: path traversal", (argv) => {
    expect(refusalOf(...argv)).toMatch(/not a plain API path/);
  });

  test("only Accept and API-version headers can be set", () => {
    expect(
      refusalOf(
        "api",
        "repos/acme/widgets/pulls/1",
        "-H",
        "Authorization: token ghp_x"
      )
    ).toMatch(/only Accept/);
    expect(
      parseGh([
        "api",
        "repos/acme/widgets/pulls/1",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ]).ok
    ).toBe(true);
  });
});

describe("parseGh: shape limits", () => {
  test("an empty argv is refused", () => {
    expect(refusalOf()).toMatch(/Pass a gh command/);
    expect(refusalOf("gh")).toMatch(/Pass a gh command/);
  });

  test("a leading gh is tolerated", () => {
    expect(effectOf("gh", "issue", "view", "12")).toEqual({ kind: "read" });
  });

  test("too many or too long arguments are refused", () => {
    const many = ["issue", "list", ...new Array(MAX_GH_ARGS).fill("--draft")];
    expect(refusalOf(...many)).toMatch(/Too many arguments/);
    expect(
      refusalOf(
        "issue",
        "comment",
        "1",
        "--body",
        "x".repeat(MAX_GH_ARG_LENGTH + 1)
      )
    ).toMatch(/too long/);
  });

  test("NUL bytes are refused", () => {
    expect(refusalOf("issue", "comment", "1", "--body", "a\0b")).toMatch(/NUL/);
  });

  test("the command list is sorted and free of destructive verbs", () => {
    expect([...GH_COMMANDS]).toEqual([...GH_COMMANDS].sort());
    for (const command of GH_COMMANDS) {
      expect(command).not.toMatch(/merge|delete|secret|auth|token|transfer/);
    }
  });
});

describe("shellQuote and ghCommandLine", () => {
  test("every character stays literal inside single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf /) `id` ; && | > \n \\")).toBe(
      "'$(rm -rf /) `id` ; && | > \n \\'"
    );
    expect(shellQuote("")).toBe("''");
  });

  test("the rendered command is the fixed binary plus quoted arguments, nothing else", () => {
    const result = parseGh([
      "issue",
      "close",
      "12",
      "--comment",
      "it's done; $(whoami) `id`",
    ]);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(ghCommandLine(result.invocation.args)).toBe(
      "/usr/bin/gh 'issue' 'close' '12' '--comment' 'it'\\''s done; $(whoami) `id`'"
    );
  });

  test("the environment pins the repository and carries no credential", () => {
    expect(GH_ENVIRONMENT).toEqual({
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      GH_REPO: "acme/widgets",
      NO_COLOR: "1",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });
});

describe("bodiesToFiles", () => {
  const invocationOf = (...argv: string[]) => {
    const result = parseGh(argv);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.invocation;
  };
  const pathFor = (index: number) => `/tmp/body-${index}.md`;

  test("moves the body out of the argv, whichever way the flag is spelled", () => {
    for (const flag of [
      ["--body", "Hello"],
      ["-b", "Hello"],
      ["--body=Hello"],
    ]) {
      expect(
        bodiesToFiles(invocationOf("issue", "comment", "12", ...flag), pathFor)
      ).toEqual({
        args: ["issue", "comment", "12", "--body-file", "/tmp/body-0.md"],
        files: [{ content: "Hello", path: "/tmp/body-0.md" }],
      });
    }
  });

  test("keeps every other argument in place", () => {
    const moved = bodiesToFiles(
      invocationOf(
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--body",
        "B",
        "--title",
        "T"
      ),
      pathFor
    );
    expect(moved.args).toEqual([
      "pr",
      "create",
      "--draft",
      "--head",
      "factory/x",
      "--body-file",
      "/tmp/body-0.md",
      "--title",
      "T",
    ]);
  });

  test("leaves commands without a text body untouched", () => {
    for (const argv of [
      ["issue", "view", "12"],
      ["run", "list", "-b", "main"],
      ["repo", "view", "-b", "main"],
      ["issue", "close", "12", "--comment", "done"],
    ]) {
      const invocation = invocationOf(...argv);
      expect(bodiesToFiles(invocation, pathFor)).toEqual({
        args: [...invocation.args],
        files: [],
      });
    }
  });
});

describe("parseGh: what the adversarial review found", () => {
  describe("a single-valued flag is accepted once, because gh honours the last one", () => {
    test.each([
      [
        [
          "api",
          "repos/acme/widgets/pulls/5/merge",
          "--method",
          "GET",
          "--method",
          "PUT",
        ],
      ],
      [
        [
          "api",
          "repos/acme/widgets/git/refs/heads/x",
          "-X",
          "GET",
          "-X",
          "DELETE",
        ],
      ],
      [
        [
          "api",
          "repos/acme/widgets/pulls/5/merge",
          "--method=GET",
          "-X",
          "PUT",
        ],
      ],
      [["api", "repos/acme/widgets/issues/1", "-X", "GET", "--method=PATCH"]],
    ])("%j is refused: the method is given twice", (argv) => {
      expect(refusalOf(...argv)).toMatch(/pass --method once/);
    });

    test.each([
      [
        [
          "pr",
          "create",
          "--draft",
          "--head",
          "factory/x",
          "--head",
          "main",
          "--title",
          "T",
          "--body",
          "B",
        ],
        "head",
      ],
      [
        [
          "pr",
          "create",
          "--draft",
          "--head",
          "factory/x",
          "--base",
          "a",
          "--base",
          "b",
          "--title",
          "T",
          "--body",
          "B",
        ],
        "base",
      ],
      [["issue", "comment", "12", "--body", "one", "--body", "two"], "body"],
      [["issue", "close", "12", "--comment", "a", "--comment", "b"], "comment"],
      [
        ["issue", "list", "--search", "a", "--search", "repo:other/x"],
        "search",
      ],
      [
        [
          "pr",
          "create",
          "--draft",
          "--draft",
          "--head",
          "factory/x",
          "--title",
          "T",
          "--body",
          "B",
        ],
        "draft",
      ],
      [["issue", "edit", "12", "--title", "a", "--title", "b"], "title"],
    ])("%j is refused: --%s is given twice", (argv, flag) => {
      expect(refusalOf(...argv)).toBe(
        `gh ${argv.slice(0, 2).join(" ")}: pass --${flag} once.`
      );
    });

    test("flags whose values gh adds together may repeat", () => {
      expect(
        effectOf(
          "issue",
          "edit",
          "12",
          "--add-label",
          "bug",
          "--add-label",
          "area: auth",
          "--remove-label",
          "triage"
        )
      ).toEqual({ kind: "label" });
      expect(
        effectOf(
          "api",
          "repos/acme/widgets/pulls/1",
          "-H",
          "Accept: application/json",
          "-H",
          "X-GitHub-Api-Version: 2022-11-28"
        )
      ).toEqual({ kind: "read" });
      expect(
        effectOf("issue", "list", "--label", "bug", "--label", "p1")
      ).toEqual({ kind: "read" });
    });

    test("every repeated header is still checked", () => {
      expect(
        refusalOf(
          "api",
          "repos/acme/widgets/pulls/1",
          "-H",
          "Accept: x",
          "-H",
          "Authorization: token t"
        )
      ).toMatch(/only Accept/);
    });
  });

  describe("the command that runs is the command that was classified", () => {
    test("a flag swallowed as another flag's value stays swallowed in the rewritten argv", () => {
      const result = parseGh([
        "pr",
        "create",
        "--title",
        "--body",
        "--draft",
        "--head",
        "factory/x",
        "--body",
        "real body",
      ]);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      // `--body` here is the title's value, so the only body is the last one.
      expect(result.invocation.effect).toEqual({ kind: "draft-pr" });
      expect(result.invocation.bodies).toEqual([
        { at: 7, content: "real body", span: 2 },
      ]);
      expect(
        bodiesToFiles(result.invocation, (index) => `/tmp/b${index}.md`)
      ).toEqual({
        args: [
          "pr",
          "create",
          "--title",
          "--body",
          "--draft",
          "--head",
          "factory/x",
          "--body-file",
          "/tmp/b0.md",
        ],
        files: [{ content: "real body", path: "/tmp/b0.md" }],
      });
    });

    test("a body that looks like a flag is content, not a flag", () => {
      const result = parseGh([
        "issue",
        "comment",
        "12",
        "--body",
        "--edit-last",
      ]);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(bodiesToFiles(result.invocation, () => "/tmp/b.md")).toEqual({
        args: ["issue", "comment", "12", "--body-file", "/tmp/b.md"],
        files: [{ content: "--edit-last", path: "/tmp/b.md" }],
      });
    });

    test("body positions survive --repo being stripped from in front of them", () => {
      const result = parseGh([
        "-R",
        "acme/widgets",
        "issue",
        "comment",
        "12",
        "--body=hello",
      ]);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.invocation.bodies).toEqual([
        { at: 3, content: "hello", span: 1 },
      ]);
      expect(bodiesToFiles(result.invocation, () => "/tmp/b.md").args).toEqual([
        "issue",
        "comment",
        "12",
        "--body-file",
        "/tmp/b.md",
      ]);
    });
  });

  describe("--body-file is not something a caller can pass", () => {
    test.each([
      [["issue", "comment", "12", "--body-file", "/proc/self/environ"]],
      [["issue", "comment", "12", "-F", "/etc/passwd"]],
      [["issue", "create", "--title", "T", "--body-file", "notes.md"]],
      [
        [
          "pr",
          "create",
          "--draft",
          "--head",
          "factory/x",
          "--title",
          "T",
          "--body-file=/tmp/x",
        ],
      ],
      [["pr", "edit", "3", "-F", "x"]],
    ])("%j is refused", (argv) => {
      expect(refusalOf(...argv)).toMatch(/does not accept/);
    });
  });

  describe("selectors cannot walk out of the repository", () => {
    test.each([
      [
        ["run", "view", "1/../../../../repos/other/repo/actions/runs/5"],
        /not a run id/,
      ],
      [["run", "view", "991", "--job", "../.."], /--job takes a number/],
      [["run", "view", "991", "--attempt", "1;id"], /--attempt takes a number/],
      [["release", "view", "../../.."], /not a release tag/],
      [["workflow", "view", "../.."], /not a workflow id or file name/],
      [["workflow", "view", "a/b.yml"], /not a workflow id or file name/],
      [["repo", "view", "acme/widgets/extra"], /only works on acme\/widgets/],
      [
        ["repo", "view", "github.com/acme/widgets"],
        /only works on acme\/widgets/,
      ],
      [
        [
          "issue",
          "close",
          "9",
          "--duplicate-of",
          "https://github.com/other/repo/issues/1",
        ],
        /is not on acme\/widgets/,
      ],
      [
        ["issue", "close", "9", "--duplicate-of", "other/repo#1"],
        /not an issue or pull request number/,
      ],
    ])("%j is refused", (argv, reason) => {
      expect(refusalOf(...argv)).toMatch(reason);
    });

    test("the ordinary forms still work", () => {
      expect(
        effectOf("run", "view", "991", "--job", "55", "--log-failed")
      ).toEqual({ kind: "read" });
      expect(effectOf("run", "view")).toEqual({ kind: "read" });
      expect(effectOf("release", "view", "v1.2.0")).toEqual({ kind: "read" });
      expect(effectOf("workflow", "view", "ci.yml", "--yaml")).toEqual({
        kind: "read",
      });
      expect(effectOf("workflow", "view", "12345")).toEqual({ kind: "read" });
      expect(
        effectOf("issue", "close", "9", "--duplicate-of", "7")
      ).toMatchObject({ kind: "state" });
    });
  });

  describe("searches stay inside the repository", () => {
    test.each([
      [["issue", "list", "--search", "repo:other/private secret"]],
      [["issue", "list", "--search", "login REPO:other/private"]],
      [["pr", "list", "-S", "org:other is:open"]],
      [["pr", "list", "--search", "user:someone"]],
      [["issue", "list", "--search", "(owner:other)"]],
      [["issue", "list", "--search=-repo:acme/widgets"]],
      [["label", "list", "--search", "repo:other/x"]],
    ])("%j is refused", (argv) => {
      expect(refusalOf(...argv)).toMatch(/Searches stay inside acme\/widgets/);
    });

    test("ordinary qualifiers and words are fine", () => {
      for (const query of [
        "login 500 in:title",
        "is:open label:bug author:octocat",
        "the repository: it broke",
        "monorepo: build fails",
        "password reset in:title,body",
      ]) {
        expect(
          effectOf("issue", "list", "--state", "all", "--search", query)
        ).toEqual({ kind: "read" });
      }
    });
  });
});
