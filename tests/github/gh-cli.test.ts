import { describe, expect, test } from "vitest";
import {
  bodiesToFiles,
  GH_COMMAND_FLAG_KINDS,
  GH_COMMAND_FLAGS,
  GH_COMMAND_SHORT_FLAGS,
  GH_COMMANDS,
  GH_ENVIRONMENT,
  GH_WRITE_COMMANDS,
  type GhEffect,
  ghCommandLine,
  MAX_GH_ARG_LENGTH,
  MAX_GH_ARGS,
  parseGh,
  RUNNER_PATH,
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
    // gh upper-cases the method, so this is a GET too.
    [["api", "repos/acme/widgets/branches", "-X", "get"]],
    // A query string is not part of the path.
    [["api", "repos/acme/widgets?per_page=1"]],
    [["api", "repos/acme/widgets/commits?path=src//lib&since=a..b"]],
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

  test("an issue has no branch, so a comment on one is addressed by number or URL only", () => {
    expect(refusalOf("issue", "comment", "factory/bug-x", "--body", "hi")).toBe(
      '"factory/bug-x" is not an issue or pull request number.'
    );
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
    expect(
      effectOf(
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body",
        "B",
        "--assignee",
        "octocat"
      )
    ).toEqual({ kind: "write" });
  });

  test("pr create refuses to infer anything from a checkout: head, title, and body are all required", () => {
    const all = ["--head", "factory/x", "--title", "T", "--body", "B"];
    expect(effectOf("pr", "create", "--draft", ...all)).toEqual({
      kind: "draft-pr",
    });
    for (const missing of ["--head", "--title", "--body"]) {
      const at = all.indexOf(missing);
      const rest = [...all.slice(0, at), ...all.slice(at + 2)];
      expect(rest).toHaveLength(4);
      expect(refusalOf("pr", "create", "--draft", ...rest)).toBe(
        "Pass --head, --title, and --body; nothing is inferred from a checkout here."
      );
    }
  });

  test("issue create needs a title and a body, since there is no editor", () => {
    expect(refusalOf("issue", "create", "--title", "T")).toBe(
      "Pass --title and --body."
    );
    expect(refusalOf("issue", "create", "--body", "B")).toBe(
      "Pass --title and --body."
    );
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
    // Unlike an issue, a pull request reopened is not the state effect,
    // which runs for every caller.
    expect(effectOf("pr", "reopen", "34")).toEqual({ kind: "write" });
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

  test("a word that is a property of every object is not a command", () => {
    for (const word of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(refusalOf(word)).toMatch(/not available to the factory/);
      expect(refusalOf("pr", word)).toMatch(/not available to the factory/);
    }
  });

  test("a command takes the positional arguments it names, no more and no fewer", () => {
    expect(refusalOf("issue", "view", "12", "13")).toBe(
      "gh issue view takes at most 1 positional argument(s)."
    );
    expect(refusalOf("pr", "ready", "34", "35")).toBe(
      "gh pr ready takes at most 1 positional argument(s)."
    );
    expect(refusalOf("issue", "list", "open")).toBe(
      "gh issue list takes at most 0 positional argument(s)."
    );
    expect(refusalOf("issue", "view")).toBe(
      "gh issue view needs 1 positional argument(s), like an issue or pull request number."
    );
    expect(refusalOf("pr", "ready")).toBe(
      "gh pr ready needs 1 positional argument(s), like an issue or pull request number."
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

  test.each([
    ["main..factory/x"],
    ["factory/x; rm -rf /"],
    ["$(id)"],
    ["a b"],
    ["-"],
    [".hidden"],
  ])(
    "a pull request selector %j is neither a number, a URL, nor a plain branch name",
    (selector) => {
      expect(effectOf("pr", "view", "factory/bug-x")).toEqual({ kind: "read" });
      for (const command of ["view", "diff", "checks", "ready", "close"]) {
        expect(refusalOf("pr", command, selector)).toBe(
          `"${selector}" is not an issue or pull request number.`
        );
      }
    }
  );
});

describe("parseGh: gh api is a read-only window onto the factory repository", () => {
  test.each([
    [["api", "repos/acme/widgets/issues", "-X", "POST"]],
    [["api", "repos/acme/widgets/issues/1", "--method", "PATCH"]],
    [["api", "repos/acme/widgets/git/refs/heads/x", "-X", "DELETE"]],
    // gh upper-cases the method before sending it.
    [["api", "repos/acme/widgets/issues", "-X", "post"]],
    [["api", "repos/acme/widgets/issues/1", "--method=Patch"]],
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
    // The owner and name are in the right places, under the wrong root.
    [["api", "orgs/acme/widgets"]],
    [["api", "users/{owner}/{repo}"]],
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
    [["api", "repos/acme/widgets/%2E%2E/%2E%2E/user"]],
    [["api", "repos/acme/widgets/x%2Fy"]],
    [["api", "repos/acme/widgets/x%5cy"]],
    [["api", "repos/acme/widgets/x%5Cy"]],
    [["api", "repos/acme/widgets\\x"]],
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
    expect(GH_COMMANDS.length).toBeGreaterThan(0);
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
      PATH: "/usr/bin:/bin",
    });
  });

  test("the runner's PATH is the image's own directories, which skips the wrappers in /usr/local/bin", () => {
    expect(RUNNER_PATH).toBe("/usr/bin:/bin");
    expect(GH_ENVIRONMENT.PATH).toBe(RUNNER_PATH);
    expect(RUNNER_PATH.split(":")).not.toContain("/usr/local/bin");
  });
});

describe("GH_WRITE_COMMANDS: the commands that always change GitHub", () => {
  /*
   * One valid invocation of every command on the allowlist with the effect
   * it has, written out by hand. The sandbox's `gh` wrapper refuses the
   * commands in GH_WRITE_COMMANDS by name, so the list has to agree with
   * what the parser says each command does.
   */
  const READ: GhEffect = { kind: "read" };
  const WRITE: GhEffect = { kind: "write" };
  const REPRESENTATIVE: Record<string, [argv: string[], effect: GhEffect]> = {
    api: [["api", "repos/acme/widgets/branches"], READ],
    "issue close": [
      ["issue", "close", "12"],
      { commentThread: 12, kind: "state", withComment: false },
    ],
    "issue comment": [
      ["issue", "comment", "12", "--body", "note"],
      { kind: "comment", thread: 12 },
    ],
    "issue create": [["issue", "create", "--title", "t", "--body", "b"], WRITE],
    "issue edit": [
      ["issue", "edit", "12", "--add-label", "bug"],
      { kind: "label" },
    ],
    "issue list": [["issue", "list"], READ],
    "issue reopen": [
      ["issue", "reopen", "12"],
      { commentThread: 12, kind: "state", withComment: false },
    ],
    "issue status": [["issue", "status"], READ],
    "issue view": [["issue", "view", "12"], READ],
    "label create": [["label", "create", "bug"], WRITE],
    "label list": [["label", "list"], READ],
    "pr checks": [["pr", "checks", "34"], READ],
    "pr close": [["pr", "close", "34"], WRITE],
    "pr comment": [
      ["pr", "comment", "34", "--body", "note"],
      { kind: "comment", thread: 34 },
    ],
    "pr create": [
      [
        "pr",
        "create",
        "--head",
        "factory/x",
        "--title",
        "t",
        "--body",
        "b",
        "--draft",
      ],
      { kind: "draft-pr" },
    ],
    "pr diff": [["pr", "diff", "34"], READ],
    "pr edit": [["pr", "edit", "34", "--title", "t"], WRITE],
    "pr list": [["pr", "list"], READ],
    "pr ready": [["pr", "ready", "34"], { kind: "ship" }],
    "pr reopen": [["pr", "reopen", "34"], WRITE],
    "pr status": [["pr", "status"], READ],
    "pr view": [["pr", "view", "34"], READ],
    "release list": [["release", "list"], READ],
    "release view": [["release", "view", "v1.0.0"], READ],
    "repo view": [["repo", "view"], READ],
    "run list": [["run", "list"], READ],
    "run view": [["run", "view", "991"], READ],
    "workflow list": [["workflow", "list"], READ],
    "workflow view": [["workflow", "view", "ci.yml"], READ],
  };

  test("the table above covers every command on the allowlist, and nothing else", () => {
    expect(Object.keys(REPRESENTATIVE).sort()).toEqual([...GH_COMMANDS]);
    expect(GH_COMMANDS).toHaveLength(29);
  });

  test("every write command is on the allowlist, once", () => {
    expect(GH_WRITE_COMMANDS.length).toBeGreaterThan(0);
    for (const command of GH_WRITE_COMMANDS) {
      expect(GH_COMMANDS).toContain(command);
    }
    expect(new Set(GH_WRITE_COMMANDS).size).toBe(GH_WRITE_COMMANDS.length);
  });

  test("the write commands, by name", () => {
    expect([...GH_WRITE_COMMANDS].sort()).toEqual([
      "issue close",
      "issue comment",
      "issue create",
      "issue edit",
      "issue reopen",
      "label create",
      "pr close",
      "pr comment",
      "pr create",
      "pr edit",
      "pr ready",
      "pr reopen",
    ]);
  });

  test.each(Object.entries(REPRESENTATIVE))(
    "gh %s has the effect written above, and is a read exactly when it is not a write command",
    (command, [argv, effect]) => {
      // The invocation starts with the command path it stands for.
      expect(argv.slice(0, command.split(" ").length).join(" ")).toBe(command);
      expect(effectOf(...argv)).toEqual(effect);
      expect(effect.kind === "read").toBe(!GH_WRITE_COMMANDS.includes(command));
    }
  );

  test.each([
    [["pr", "ready", "34", "--undo"]],
    [["pr", "create", "--head", "factory/x", "--title", "t", "--body", "b"]],
    [["issue", "edit", "12", "--title", "t"]],
    [["issue", "close", "12", "--comment", "done"]],
    [["pr", "edit", "34", "--add-label", "bug"]],
    [["label", "create", "bug", "--force"]],
  ])("%j, another shape of a write command, is not a read either", (argv) => {
    expect(effectOf(...argv).kind).not.toBe("read");
  });
});

/*
 * Every flag the allowlist accepts, command by command, written out by
 * hand in the allowlist's own notation: `long`, or `short|long`. A flag is a
 * decision: what it does to the command's effect has to be settled before
 * the factory may pass it. So a flag added to a command, renamed, or moved
 * between the two kinds fails here until this table says the same.
 */
const FLAGS: Record<string, { bool?: string[]; value?: string[] }> = {
  api: {
    bool: ["i|include", "paginate", "silent", "slurp"],
    value: ["cache", "H|header", "q|jq", "X|method", "t|template"],
  },
  "issue close": { value: ["c|comment", "duplicate-of", "r|reason"] },
  "issue comment": {
    bool: ["create-if-none", "edit-last"],
    value: ["b|body"],
  },
  "issue create": {
    value: ["a|assignee", "b|body", "l|label", "m|milestone", "t|title"],
  },
  "issue edit": {
    bool: ["remove-milestone"],
    value: [
      "add-assignee",
      "add-label",
      "b|body",
      "m|milestone",
      "remove-assignee",
      "remove-label",
      "t|title",
    ],
  },
  "issue list": {
    value: [
      "app",
      "a|assignee",
      "A|author",
      "q|jq",
      "json",
      "l|label",
      "L|limit",
      "mention",
      "m|milestone",
      "S|search",
      "s|state",
      "t|template",
    ],
  },
  "issue reopen": { value: ["c|comment"] },
  "issue status": { value: ["q|jq", "json", "t|template"] },
  "issue view": {
    bool: ["c|comments"],
    value: ["q|jq", "json", "t|template"],
  },
  "label create": { bool: ["f|force"], value: ["c|color", "d|description"] },
  "label list": {
    value: [
      "q|jq",
      "json",
      "L|limit",
      "order",
      "S|search",
      "sort",
      "t|template",
    ],
  },
  "pr checks": { bool: ["required"], value: ["q|jq", "json", "t|template"] },
  "pr close": { value: ["c|comment"] },
  "pr comment": { bool: ["create-if-none", "edit-last"], value: ["b|body"] },
  "pr create": {
    bool: ["d|draft", "no-maintainer-edit"],
    value: [
      "a|assignee",
      "B|base",
      "b|body",
      "H|head",
      "l|label",
      "m|milestone",
      "r|reviewer",
      "t|title",
    ],
  },
  "pr diff": { bool: ["name-only", "patch"], value: ["color"] },
  "pr edit": {
    bool: ["remove-milestone"],
    value: [
      "add-assignee",
      "add-label",
      "add-reviewer",
      "B|base",
      "b|body",
      "m|milestone",
      "remove-assignee",
      "remove-label",
      "remove-reviewer",
      "t|title",
    ],
  },
  "pr list": {
    bool: ["d|draft"],
    value: [
      "app",
      "a|assignee",
      "A|author",
      "B|base",
      "H|head",
      "q|jq",
      "json",
      "l|label",
      "L|limit",
      "S|search",
      "s|state",
      "t|template",
    ],
  },
  "pr ready": { bool: ["undo"] },
  "pr reopen": { value: ["c|comment"] },
  "pr status": {
    bool: ["c|conflict-status"],
    value: ["q|jq", "json", "t|template"],
  },
  "pr view": { bool: ["c|comments"], value: ["q|jq", "json", "t|template"] },
  "release list": {
    bool: ["exclude-drafts", "exclude-pre-releases"],
    value: ["q|jq", "json", "L|limit", "O|order", "t|template"],
  },
  "release view": { value: ["q|jq", "json", "t|template"] },
  "repo view": { value: ["b|branch", "q|jq", "json", "t|template"] },
  "run list": {
    bool: ["a|all"],
    value: [
      "b|branch",
      "c|commit",
      "created",
      "e|event",
      "q|jq",
      "json",
      "L|limit",
      "s|status",
      "t|template",
      "u|user",
      "w|workflow",
    ],
  },
  "run view": {
    bool: ["exit-status", "log", "log-failed", "v|verbose"],
    value: ["a|attempt", "j|job", "q|jq", "json", "t|template"],
  },
  "workflow list": {
    bool: ["a|all"],
    value: ["q|jq", "json", "L|limit", "t|template"],
  },
  "workflow view": { bool: ["y|yaml"], value: ["r|ref"] },
};

describe("the flags each command accepts are the ones written out here", () => {
  const longOf = (entry: string): string => entry.split("|").at(-1) ?? entry;
  /** How a flag may be typed: `--long`, and `-s` when it has a short form. */
  const spellings = (entry: string): string[] => {
    const parts = entry.split("|");
    return parts.length === 2
      ? [`-${parts[0]}`, `--${parts[1]}`]
      : [`--${entry}`];
  };
  const longs = (command: string): string[] =>
    [...(FLAGS[command]?.value ?? []), ...(FLAGS[command]?.bool ?? [])]
      .map(longOf)
      .sort();
  const NOT_A_FLAG = "--no-such-flag";
  const unknownFlag = (command: string): string =>
    `gh ${command} does not accept ${NOT_A_FLAG} here. Allowed flags: ${longs(
      command
    )
      .map((long) => `--${long}`)
      .join(", ")}. Pass each flag and its value as separate arguments.`;

  test("the table covers every command on the allowlist", () => {
    expect(Object.keys(FLAGS).sort()).toEqual([...GH_COMMANDS]);
  });

  describe.each(Object.keys(FLAGS))("gh %s", (command) => {
    const words = command.split(" ");

    test("the parser accepts exactly these flags: its refusal of any other lists them", () => {
      expect(refusalOf(...words, NOT_A_FLAG)).toBe(unknownFlag(command));
    });

    test("each flag that takes a value takes one, under either spelling", () => {
      for (const flag of (FLAGS[command]?.value ?? []).flatMap(spellings)) {
        expect(refusalOf(...words, flag)).toBe(
          `gh ${command}: ${flag} needs a value.`
        );
      }
    });

    // Were a switch read as taking a value, it would swallow the word after
    // it, and the refusal would no longer be about that word.
    test("each switch stands alone, under either spelling: the word after it is read on its own", () => {
      for (const flag of (FLAGS[command]?.bool ?? []).flatMap(spellings)) {
        expect(refusalOf(...words, flag, NOT_A_FLAG)).toBe(
          unknownFlag(command)
        );
      }
    });
  });

  /*
   * The three views of the allowlist that tests/github/gh-contract.test.ts
   * holds against the installed GitHub CLI. An empty or partial view would
   * make every check there pass, so each is held to the table here first.
   */
  test("GH_COMMAND_FLAGS lists these flags, by long name", () => {
    expect(GH_COMMAND_FLAGS).toEqual(
      Object.fromEntries(
        Object.keys(FLAGS).map((command) => [command, longs(command)])
      )
    );
  });

  test("GH_COMMAND_FLAG_KINDS says which of them take a value", () => {
    expect(GH_COMMAND_FLAG_KINDS).toEqual(
      Object.fromEntries(
        Object.entries(FLAGS).map(([command, { bool = [], value = [] }]) => [
          command,
          Object.fromEntries([
            ...value.map((entry) => [longOf(entry), "value"]),
            ...bool.map((entry) => [longOf(entry), "bool"]),
          ]),
        ])
      )
    );
  });

  test("GH_COMMAND_SHORT_FLAGS pairs each short spelling with its long one", () => {
    const pairs = (entries: readonly (readonly string[])[]): string[] =>
      entries.map((pair) => pair.join("|")).sort();
    const expected = Object.fromEntries(
      Object.entries(FLAGS).map(([command, { bool = [], value = [] }]) => [
        command,
        [...value, ...bool].filter((entry) => entry.includes("|")).sort(),
      ])
    );
    expect(
      Object.fromEntries(
        Object.entries(GH_COMMAND_SHORT_FLAGS).map(([command, entries]) => [
          command,
          pairs(entries),
        ])
      )
    ).toEqual(expected);
    expect(Object.values(expected).flat().length).toBeGreaterThan(50);
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

  test("a body glued to its flag takes one argument, so the one after it is kept", () => {
    expect(
      bodiesToFiles(
        invocationOf(
          "issue",
          "create",
          "--body=B",
          "--title",
          "T",
          "--label",
          "bug"
        ),
        pathFor
      )
    ).toEqual({
      args: [
        "issue",
        "create",
        "--body-file",
        "/tmp/body-0.md",
        "--title",
        "T",
        "--label",
        "bug",
      ],
      files: [{ content: "B", path: "/tmp/body-0.md" }],
    });
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
      [["release", "view", "v1..2"], /not a release tag/],
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

/**
 * `-R/--repo` is removed where it is a flag, and only there. Text that reads
 * like the flag but is another flag's value (a body, a title) stays that
 * value: taking it for the flag would hand the next word to the flag before
 * it, and a `--body` followed by `--draft` would swallow the `--draft`.
 */
describe("parseGh: the repository flag is a flag only where a flag can be", () => {
  const parsed = (argv: string[]) => {
    const result = parseGh(argv);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.invocation;
  };

  const PR = ["pr", "create", "--head", "factory/x", "--base", "main"];

  test.each([
    "--repo=acme/widgets",
    "--repo=https://github.com/acme/widgets.git",
    "--repo=evil/other",
    "--repo",
    "-R",
  ])(
    "a body that reads %j is the body, and the draft stays a draft",
    (text) => {
      const invocation = parsed([
        ...PR,
        "--title",
        "t",
        "--body",
        text,
        "--draft",
      ]);
      expect(invocation.effect).toEqual({ kind: "draft-pr" });
      expect(invocation.bodies.map((body) => body.content)).toEqual([text]);
      expect(invocation.args).toEqual([
        ...PR,
        "--title",
        "t",
        "--body",
        text,
        "--draft",
      ]);
    }
  );

  test("a title that reads like the flag is the title", () => {
    const invocation = parsed([
      ...PR,
      "--title",
      "-R",
      "--body",
      "b",
      "--draft",
    ]);
    expect(invocation.effect).toEqual({ kind: "draft-pr" });
    expect(invocation.args).toContain("-R");
  });

  test("a comment body that reads like the flag does not swallow the flag after it", () => {
    const invocation = parsed([
      "issue",
      "comment",
      "12",
      "--body",
      "--repo=acme/widgets",
      "--edit-last",
    ]);
    expect(invocation.bodies.map((body) => body.content)).toEqual([
      "--repo=acme/widgets",
    ]);
    expect(invocation.args).toEqual([
      "issue",
      "comment",
      "12",
      "--body",
      "--repo=acme/widgets",
      "--edit-last",
    ]);
  });

  test.each([
    [["-R", "acme/widgets", "issue", "view", "12"]],
    [["issue", "-R", "acme/widgets", "view", "12"]],
    [["issue", "view", "--repo=acme/widgets", "12"]],
    [["issue", "view", "12", "--repo", "acme/widgets"]],
    [["issue", "view", "12", "-R", "https://github.com/acme/widgets"]],
  ])(
    "%j: the flag itself is still checked and removed, wherever it sits",
    (argv) => {
      expect(parsed(argv).args).toEqual(["issue", "view", "12"]);
    }
  );

  test.each([
    [["-R", "evil/other", "issue", "view", "12"]],
    [["issue", "--repo=evil/other", "view", "12"]],
    [["issue", "view", "12", "-R", "evil/other"]],
    [["issue", "view", "12", "--repo=evil/other"]],
    [["issue", "view", "12", "-R"]],
    [[...PR, "--title", "t", "--body", "b", "--draft", "-R", "evil/other"]],
  ])(
    "%j: the flag naming another repository, or none, is still refused",
    (argv) => {
      const result = parseGh(argv);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe(
        "This factory only works on acme/widgets."
      );
    }
  );

  test("the flag after a body is removed, and the body's position still points at the body", () => {
    const invocation = parsed([
      "issue",
      "comment",
      "-R",
      "acme/widgets",
      "12",
      "--body",
      "hello",
      "--repo=acme/widgets",
    ]);
    expect(invocation.args).toEqual([
      "issue",
      "comment",
      "12",
      "--body",
      "hello",
    ]);
    expect(invocation.bodies).toEqual([{ at: 3, content: "hello", span: 2 }]);
  });
});
