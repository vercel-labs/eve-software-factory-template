import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GH_COMMANDS, GH_WRITE_COMMANDS } from "#lib/github/cli.js";
import {
  GH_READER_HINT,
  GH_WRITE_HINT,
  ghShim,
  gitShim,
  LEASE_VARIABLE,
  NO_PUSH_HINT,
  PUSH_HINT,
  REPO_VARIABLE,
  ROLE_VARIABLE,
  SHIM_DIRECTORY,
} from "#lib/github/shims.js";

/**
 * Runs the `gh` and `git` wrapper scripts for real.
 *
 * @remarks
 * The wrappers are shell scripts, so the only honest test is to run them.
 * Each is generated with a stand-in for the real binary: a script that
 * prints the arguments and the environment it was given and exits with the
 * status the test asks for. Nothing here reaches GitHub or needs `gh`.
 */
const LEASE = "factory-3f0c9d1e-8a52-4b7e-9c1d-000000000001";
const REPO = "acme/widgets";

/** What the stand-in prints for a variable the wrapper did not set. */
const UNSET = "(unset)";

const REPORTED = [
  "GH_TOKEN",
  "GH_REPO",
  "GH_PROMPT_DISABLED",
  "GH_NO_UPDATE_NOTIFIER",
  "GIT_TERMINAL_PROMPT",
] as const;

const STAND_IN = [
  "#!/bin/sh",
  "printf 'argc=%s\\n' \"$#\"",
  'for argument in "$@"; do',
  "  printf '[%s]\\n' \"$argument\"",
  "done",
  ...REPORTED.map((name) => `printf '${name}=%s\\n' "\${${name}-${UNSET}}"`),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's braces, not a template's.
  'exit "${FAKE_EXIT:-0}"',
  "",
].join("\n");

/** The stand-in's exact output for these arguments and this environment. */
const ran = (
  args: readonly string[],
  environment: Partial<Record<(typeof REPORTED)[number], string>> = {}
): string =>
  [
    `argc=${args.length}`,
    ...args.map((arg) => `[${arg}]`),
    ...REPORTED.map((name) => `${name}=${environment[name] ?? UNSET}`),
    "",
  ].join("\n");

const GH_ENVIRONMENT = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  GH_REPO: REPO,
  GH_TOKEN: LEASE,
};

const NO_CREDENTIAL =
  "no GitHub credential is attached to this command. One is attached only when the bash command itself names gh or git, so run it directly in your bash command, not from inside a script.";

const leased = (role?: string): Record<string, string> => ({
  [LEASE_VARIABLE]: LEASE,
  [REPO_VARIABLE]: REPO,
  ...(role === undefined ? {} : { [ROLE_VARIABLE]: role }),
});

const basicHeader = (lease: string): string =>
  `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(
    `x-access-token:${lease}`
  ).toString("base64")}`;

// `sh` is always there. bash is checked too where it exists, since it is
// `sh` on some images and reads a script a little differently.
const SHELLS = [
  "sh",
  ...(spawnSync("bash", ["-c", "exit 0"]).status === 0 ? ["bash"] : []),
];

let root = "";
let gh = "";
let git = "";

const run = (
  shell: string,
  script: string,
  args: readonly string[],
  environment: Record<string, string> = {}
) =>
  spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    // Nothing from the developer's own environment but PATH.
    env: { PATH: process.env.PATH ?? "", ...environment },
  });

beforeAll(() => {
  // A space in the path shows the scripts quote the binary they wrap.
  root = mkdtempSync(join(tmpdir(), "factory shims-"));
  const real = join(root, "real binary");
  writeFileSync(real, STAND_IN);
  chmodSync(real, 0o755);
  gh = join(root, "gh");
  git = join(root, "git");
  writeFileSync(gh, ghShim(real));
  writeFileSync(git, gitShim(real));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
});

afterAll(() => {
  if (root !== "") {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("the wrapper scripts themselves", () => {
  test.each([
    ["gh", () => ghShim()],
    ["git", () => gitShim()],
  ])(
    "the %s wrapper is a POSIX sh script that ends with a new line",
    (_name, script) => {
      expect(script().startsWith("#!/bin/sh\n")).toBe(true);
      expect(script().endsWith("\n")).toBe(true);
    }
  );

  test("by default they wrap the image's own binaries, by absolute path", () => {
    expect(ghShim()).toContain("\nreal='/usr/bin/gh'\n");
    expect(gitShim()).toContain("\nreal='/usr/bin/git'\n");
  });

  test("they are installed ahead of /usr/bin on PATH", () => {
    expect(SHIM_DIRECTORY).toBe("/usr/local/bin");
  });

  test.each(SHELLS)("both pass the %s syntax check", (shell) => {
    for (const script of [gh, git]) {
      const checked = spawnSync(shell, ["-n", script], { encoding: "utf8" });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    }
  });

  test("both run as executables, through their own first line", () => {
    for (const script of [gh, git]) {
      const result = spawnSync(script, ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.stdout).toBe(ran(["--version"]));
      expect(result.status).toBe(0);
    }
  });

  test.each([
    ["GH_WRITE_HINT", GH_WRITE_HINT],
    ["GH_READER_HINT", GH_READER_HINT],
    ["PUSH_HINT", PUSH_HINT],
    ["NO_PUSH_HINT", NO_PUSH_HINT],
  ])("%s holds nothing a shell acts on inside double quotes", (_name, hint) => {
    // The hints are echoed from inside double quotes in the scripts.
    expect(hint).not.toMatch(/['"$`\\]/);
    expect(hint).not.toContain("\n");
    expect(hint.length).toBeGreaterThan(0);
  });
});

describe.each(SHELLS)("the gh wrapper, run by %s", (shell) => {
  const runGh = (
    args: readonly string[],
    environment: Record<string, string> = {}
  ) => run(shell, gh, args, environment);

  describe("help and version need no credential", () => {
    test.each([
      [["--version"]],
      [["version"]],
      [["--help"]],
      [["help"]],
      [["help", "issue"]],
      [["-h"]],
      [["issue", "list", "--help"]],
      // Help for a command the factory cannot run is still only help.
      [["pr", "merge", "--help"]],
      [[]],
    ])("%j goes straight to gh, with or without a lease", (args) => {
      for (const environment of [{}, leased("reader")]) {
        const result = runGh(args, environment);
        // No token is attached: help does not talk to GitHub.
        expect(result.stdout).toBe(ran(args));
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    });
  });

  describe("commands outside the factory's list", () => {
    test.each([
      [["pr", "merge", "12"], "pr merge"],
      [["auth", "token"], "auth token"],
      [["repo", "delete", "acme/widgets", "--yes"], "repo delete"],
      [["secret", "list"], "secret list"],
      [["release", "create", "v1"], "release create"],
      [["pr", "review", "12", "--approve"], "pr review"],
      [["ISSUE", "LIST"], "ISSUE LIST"],
    ])("%j is refused and names what is available", (args, path) => {
      for (const environment of [{}, leased("orchestrator")]) {
        const result = runGh(args, environment);
        expect(result.status).toBe(2);
        expect(result.stderr).toBe(
          `gh ${path} is not available to the factory. Available: ${GH_COMMANDS.join(", ")}.\n`
        );
        expect(result.stdout).toBe("");
      }
    });
  });

  test("a command that is one unknown word is refused the same way", () => {
    const result = runGh(["browse"], leased("orchestrator"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `is not available to the factory. Available: ${GH_COMMANDS.join(", ")}.`
    );
    expect(result.stdout).toBe("");
  });

  describe("without a lease", () => {
    test.each<[string, Record<string, string>]>([
      ["nothing set", {}],
      ["an empty lease", { [LEASE_VARIABLE]: "", [REPO_VARIABLE]: REPO }],
      ["a lease and no repository", { [LEASE_VARIABLE]: LEASE }],
      ["a repository and no lease", { [REPO_VARIABLE]: REPO }],
    ])(
      "%s: the command stops and says no credential is attached",
      (_name, environment) => {
        const result = runGh(["issue", "list"], environment);
        expect(result.status).toBe(4);
        expect(result.stderr).toBe(`gh: ${NO_CREDENTIAL}\n`);
        expect(result.stdout).toBe("");
      }
    );
  });

  describe("a command that changes GitHub", () => {
    test("the orchestrator is told how to write the command so it can run", () => {
      const result = runGh(
        ["issue", "close", "12", "--comment", "done"],
        leased("orchestrator")
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(`gh issue close ${GH_WRITE_HINT}\n`);
      expect(result.stdout).toBe("");
    });

    test.each([["reader"], ["implementer"], [undefined]])(
      "role %j is told this agent only reads",
      (role) => {
        const result = runGh(
          ["pr", "create", "--title", "t", "--body", "b"],
          leased(role)
        );
        expect(result.status).toBe(2);
        expect(result.stderr).toBe(`gh pr create ${GH_READER_HINT}\n`);
        expect(result.stdout).toBe("");
      }
    );
  });

  describe("the repository is pinned", () => {
    test.each([
      [["issue", "list", "--repo", "other/repo"]],
      [["issue", "list", "-R", "other/repo"]],
      [["issue", "list", "--repo=other/repo"]],
      [["issue", "list", "--repo", "https://github.com/other/repo"]],
      [["issue", "list", "--repo", "acme/widgets-fork"]],
      [["issue", "list", "--repo", "acme"]],
      [["issue", "list", "--repo", "evil.example/acme/widgets"]],
      [["issue", "view", "12", "-R", "acme/widgets", "-R", "other/repo"]],
    ])("%j is refused: another repository", (args) => {
      const result = runGh(args, leased("reader"));
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        "gh works on acme/widgets only; leave out --repo.\n"
      );
      expect(result.stdout).toBe("");
    });

    test.each([
      [["issue", "list", "--repo", "acme/widgets"]],
      [["issue", "list", "-R", "ACME/Widgets"]],
      [["issue", "list", "--repo=Acme/WIDGETS"]],
      [["issue", "list", "--repo", "https://github.com/acme/widgets"]],
      [["issue", "list", "--repo", "https://github.com/acme/widgets.git"]],
      [["issue", "list", "--repo", "HTTPS://GitHub.com/Acme/Widgets.git"]],
      [["issue", "list", "--repo", "github.com/acme/widgets"]],
      [["issue", "list", "-R", "acme/widgets.git"]],
    ])("%j runs: the factory repository, however it is spelled", (args) => {
      const result = runGh(args, leased("reader"));
      expect(result.stdout).toBe(ran(args, GH_ENVIRONMENT));
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    test("the configured repository is compared without regard to letter case", () => {
      const result = runGh(["issue", "list", "-R", "acme/widgets"], {
        ...leased("reader"),
        [REPO_VARIABLE]: "Acme/Widgets",
      });
      expect(result.stdout).toBe(
        ran(["issue", "list", "-R", "acme/widgets"], {
          ...GH_ENVIRONMENT,
          GH_REPO: "Acme/Widgets",
        })
      );
      expect(result.status).toBe(0);
    });
  });

  describe("a read", () => {
    test.each([
      [["issue", "view", "12", "--comments"]],
      [["api", "repos/acme/widgets/pulls/3/files", "--paginate"]],
      [
        [
          "issue",
          "list",
          "--search",
          'it\'s "quoted" $HOME `id` $(id) \\ * ? ; & | > # ~',
          "--json",
          "number,title",
        ],
      ],
      [["issue", "list", "--search", "line one\nline two\n\nline four"]],
      [["issue", "list", "--search", "", "--label", "  spaced  "]],
      [["pr", "view", "factory/x", "--jq", '.title | @sh "echo \\(.)"']],
      [["issue", "list", "--search", "-R"]],
    ])(
      "%j reaches gh with the same arguments, the placeholder, and the repository",
      (args) => {
        const result = runGh(args, leased("reader"));
        expect(result.stdout).toBe(ran(args, GH_ENVIRONMENT));
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    );

    test.each([["orchestrator"], ["reader"], ["implementer"], [undefined]])(
      "role %j reads the same way",
      (role) => {
        const result = runGh(["pr", "list"], leased(role));
        expect(result.stdout).toBe(ran(["pr", "list"], GH_ENVIRONMENT));
        expect(result.status).toBe(0);
      }
    );

    test.each([[1], [4], [7], [127]])(
      "gh's exit status %i is the wrapper's",
      (status) => {
        const environment = { ...leased("reader"), FAKE_EXIT: String(status) };
        expect(runGh(["issue", "list"], environment).status).toBe(status);
        expect(runGh(["--version"], environment).status).toBe(status);
      }
    );
  });

  describe("every command on the factory's list", () => {
    const writes = new Set(GH_WRITE_COMMANDS);

    test.each(GH_COMMANDS.filter((command) => !writes.has(command)))(
      "gh %s reaches gh",
      (command) => {
        const args = command.split(" ");
        const result = runGh(args, leased("reader"));
        expect(result.stdout).toBe(ran(args, GH_ENVIRONMENT));
        expect(result.status).toBe(0);
      }
    );

    test.each([...GH_WRITE_COMMANDS])(
      "gh %s does not reach gh, for any role",
      (command) => {
        for (const role of ["orchestrator", "reader", "implementer"]) {
          const result = runGh(command.split(" "), leased(role));
          expect(result.stdout).toBe("");
          expect(result.status).toBe(2);
          expect(result.stderr.startsWith(`gh ${command} changes GitHub`)).toBe(
            true
          );
        }
      }
    );
  });
});

describe.each(SHELLS)("the git wrapper, run by %s", (shell) => {
  const runGit = (
    args: readonly string[],
    environment: Record<string, string> = {}
  ) => run(shell, git, args, environment);

  describe("commands that stay on this machine", () => {
    test.each([
      [["status"]],
      [["commit", "-m", "x"]],
      [["commit", "-m", 'fix: it\'s "done" $HOME `id`\n\nsecond paragraph']],
      [["-C", "dir", "log"]],
      [["-c", "a=b", "diff"]],
      [["--no-pager", "log", "--oneline", "-5"]],
      [["--git-dir", ".git", "--work-tree", ".", "status"]],
      [["checkout", "-b", "factory/x"]],
      [["remote", "-v"]],
      [["config", "--get", "remote.origin.url"]],
      [["--version"]],
      [[]],
      // A networked word that is not the subcommand changes nothing.
      [["stash", "push"]],
      [["checkout", "fetch"]],
      [["-C", "push", "status"]],
      [["-c", "alias.fetch=status", "log"]],
      [["branch", "-D", "pull"]],
    ])("%j reaches git unchanged, with or without a lease", (args) => {
      for (const environment of [{}, leased("implementer")]) {
        const result = runGit(args, environment);
        expect(result.stdout).toBe(ran(args));
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    });

    test("git's exit status is the wrapper's", () => {
      expect(runGit(["diff", "--exit-code"], { FAKE_EXIT: "1" }).status).toBe(
        1
      );
      expect(runGit(["status"], { FAKE_EXIT: "128" }).status).toBe(128);
    });
  });

  describe("commands that talk to a remote, under a lease", () => {
    test.each([
      [["fetch"]],
      [["fetch", "origin", "factory/x"]],
      [["pull", "--ff-only", "origin", "main"]],
      [["clone", "https://github.com/acme/widgets.git", "a directory"]],
      [["ls-remote", "--heads", "origin"]],
      [["push", "origin", "factory/x"]],
      // The subcommand is found after git's own options.
      [["-C", "dir", "fetch", "origin"]],
      [["-c", "a=b", "fetch"]],
      [["--no-pager", "fetch"]],
      [["--git-dir", ".git", "--work-tree", ".", "pull"]],
      [["--git-dir=.git", "ls-remote"]],
      [["-C", "status", "push"]],
      [["fetch", "origin", 'it\'s a "ref" $HOME\nwith a new line']],
    ])(
      "%j gets the credential as one leading -c pair, and nothing else changes",
      (args) => {
        const result = runGit(args, leased("implementer"));
        expect(result.stdout).toBe(
          ran(["-c", basicHeader(LEASE), ...args], { GIT_TERMINAL_PROMPT: "0" })
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    );

    test("the header is the placeholder as a Basic credential, never a token", () => {
      expect(basicHeader(LEASE)).toBe(
        "http.https://github.com/.extraheader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46ZmFjdG9yeS0zZjBjOWQxZS04YTUyLTRiN2UtOWMxZC0wMDAwMDAwMDAwMDE="
      );
    });

    test("a long placeholder still gives a header on one line", () => {
      // base64 wraps its output at 76 columns unless the wrapper undoes it.
      const long = `factory-${"0123456789abcdef".repeat(12)}`;
      const result = runGit(["fetch"], { [LEASE_VARIABLE]: long });
      expect(result.stdout).toBe(
        ran(["-c", basicHeader(long), "fetch"], { GIT_TERMINAL_PROMPT: "0" })
      );
    });

    test("a fetch that fails says nothing more than git did", () => {
      const result = runGit(["fetch", "origin"], {
        ...leased("reader"),
        FAKE_EXIT: "128",
      });
      expect(result.status).toBe(128);
      expect(result.stderr).toBe("");
    });

    test("a push that works says nothing more than git did", () => {
      const result = runGit(["push", "origin", "factory/x"], leased("reader"));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    test("a failed push tells the implementer how to write a push", () => {
      const result = runGit(["push", "origin", "factory/x"], {
        ...leased("implementer"),
        FAKE_EXIT: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${PUSH_HINT}\n`);
    });

    test.each([["reader"], ["orchestrator"], [undefined]])(
      "a failed push tells role %j that it never pushes",
      (role) => {
        const result = runGit(["-C", "repo", "push", "origin", "factory/x"], {
          ...leased(role),
          FAKE_EXIT: "128",
        });
        expect(result.status).toBe(128);
        expect(result.stderr).toBe(`git push: ${NO_PUSH_HINT}\n`);
      }
    );
  });

  describe("commands that talk to a remote, without a lease", () => {
    test.each([
      [["fetch", "origin", "factory/x"]],
      [["pull"]],
      [["clone", "https://github.com/acme/widgets.git"]],
      [["ls-remote"]],
      [["push", "origin", "factory/x"]],
      [["-C", "dir", "fetch"]],
    ])("%j runs unchanged and adds nothing when it works", (args) => {
      const result = runGit(args);
      expect(result.stdout).toBe(ran(args));
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    test.each([
      [["fetch", "origin"], "fetch"],
      [["pull"], "pull"],
      [["clone", "https://github.com/acme/widgets.git"], "clone"],
      [["ls-remote"], "ls-remote"],
      [["push", "origin", "factory/x"], "push"],
      [["-C", "dir", "fetch"], "fetch"],
    ])(
      "%j that fails keeps its status and adds the hint",
      (args, subcommand) => {
        const result = runGit(args, {
          FAKE_EXIT: "128",
          [ROLE_VARIABLE]: "reader",
        });
        expect(result.stdout).toBe(ran(args));
        expect(result.status).toBe(128);
        expect(result.stderr).toBe(
          `git ${subcommand}: if this needed GitHub, ${NO_CREDENTIAL}\n`
        );
      }
    );
  });
});

/*
 * The same wrapper around the real git, with a bare repository in a
 * temporary directory as the remote. No network is involved.
 */
const realGit = spawnSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).stdout.trim();
const hasGit = realGit !== "";
// CI sets this, so a runner without git fails the suite instead of skipping.
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

describe.runIf(required)("the CLI contract tests are required here", () => {
  test("git is installed", () => {
    expect(hasGit).toBe(true);
  });
});

describe.skipIf(!hasGit)("the git wrapper around the real git", () => {
  const identity = {
    GIT_AUTHOR_EMAIL: "factory@example.test",
    GIT_AUTHOR_NAME: "Factory Test",
    GIT_COMMITTER_EMAIL: "factory@example.test",
    GIT_COMMITTER_NAME: "Factory Test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  let wrapper = "";
  let remote = "";
  let seed = "";
  let checkout = "";

  /** The real git, with no wrapper in between. */
  const plain = (cwd: string, ...args: string[]): string =>
    execFileSync(realGit, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...identity },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  /** The wrapper, under a lease unless the test says otherwise. */
  const wrapped = (
    cwd: string,
    args: readonly string[],
    environment: Record<string, string> = leased("implementer")
  ) =>
    spawnSync("sh", [wrapper, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...identity, ...environment },
    });

  const commit = (cwd: string, file: string, message: string) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    plain(cwd, "add", file);
    plain(cwd, "commit", "-q", "-m", message);
  };

  beforeAll(() => {
    const home = join(root, "real");
    mkdirSync(home);
    wrapper = join(home, "git");
    writeFileSync(wrapper, gitShim(realGit));
    chmodSync(wrapper, 0o755);
    remote = join(home, "remote.git");
    seed = join(home, "seed");
    checkout = join(home, "repo");
    plain(home, "init", "-q", "--bare", "-b", "main", remote);
    plain(home, "clone", "-q", remote, seed);
    plain(seed, "checkout", "-q", "-B", "main");
    commit(seed, "README.md", "initial commit");
    plain(seed, "push", "-q", "origin", "main");
    plain(home, "clone", "-q", remote, checkout);
    // Pushed after the clone, so the checkout has yet to hear of it.
    plain(seed, "checkout", "-q", "-b", "factory/existing");
    commit(seed, "feature.txt", "existing work");
    plain(seed, "push", "-q", "origin", "factory/existing");
  });

  test("fetch under a lease brings in a branch the checkout did not have", () => {
    expect(() =>
      plain(checkout, "rev-parse", "--verify", "origin/factory/existing")
    ).toThrow();

    const fetched = wrapped(checkout, ["fetch", "origin", "factory/existing"]);
    expect(fetched.status).toBe(0);
    expect(plain(checkout, "rev-parse", "origin/factory/existing")).toBe(
      plain(remote, "rev-parse", "factory/existing")
    );
  });

  test("status and log print what git prints, lease or not", () => {
    writeFileSync(join(checkout, "untracked.txt"), "x\n");
    for (const environment of [leased("implementer"), {}]) {
      const status = wrapped(
        checkout,
        ["status", "--short", "--branch"],
        environment
      );
      expect(status.status).toBe(0);
      expect(status.stdout.trim()).toBe(
        plain(checkout, "status", "--short", "--branch")
      );
      expect(status.stdout).toContain("?? untracked.txt");

      const log = wrapped(
        seed,
        ["-C", checkout, "log", "-1", "--format=%s"],
        environment
      );
      expect(log.status).toBe(0);
      expect(log.stdout).toBe("initial commit\n");
    }
  });

  test("a commit message with quotes and new lines is recorded as written", () => {
    const message = 'fix: it\'s "quoted" $HOME `id`\n\nSecond paragraph.';
    writeFileSync(join(checkout, "work.txt"), "work\n");
    expect(wrapped(checkout, ["add", "work.txt"]).status).toBe(0);
    expect(wrapped(checkout, ["commit", "-q", "-m", message]).status).toBe(0);
    expect(plain(checkout, "log", "-1", "--format=%B")).toBe(message);
  });

  test("ls-remote and clone work under a lease", () => {
    const listed = wrapped(checkout, ["ls-remote", "--heads", "origin"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("refs/heads/main");
    expect(listed.stdout).toContain("refs/heads/factory/existing");

    const second = join(root, "real", "second clone");
    expect(wrapped(root, ["clone", "-q", remote, second]).status).toBe(0);
    expect(plain(second, "log", "-1", "--format=%s")).toBe("initial commit");
  });

  test("git's own failure passes through with its message and status", () => {
    const failed = wrapped(checkout, ["fetch", "origin", "factory/missing"]);
    expect(failed.status).toBe(128);
    expect(failed.stderr).toMatch(/couldn't find remote ref factory\/missing/);
    expect(failed.stderr).not.toContain("credential");

    const unleased = wrapped(
      checkout,
      ["fetch", "origin", "factory/missing"],
      {}
    );
    expect(unleased.status).toBe(128);
    expect(unleased.stderr).toMatch(/couldn't find remote ref/);
    expect(unleased.stderr).toContain(
      `git fetch: if this needed GitHub, ${NO_CREDENTIAL}`
    );
  });

  test("the credential never lands in the checkout's configuration", () => {
    expect(plain(checkout, "config", "--local", "--list")).not.toMatch(
      /extraheader|x-access-token|Authorization/i
    );
  });
});
