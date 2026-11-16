import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RUNNER_PATH } from "#lib/github/cli.js";
import { GIT_BINARY, pushCommandLine } from "#lib/github/git-cli.js";
import { REMOTE_URL, REPO_DIR } from "#lib/github/git-remote.js";
import {
  GIT_TIMEOUT_MS,
  type LeaseSandbox,
  leasePolicy,
  resetTokenScopeMemo,
  runGitPush,
  TOKEN_SCOPES,
  type TokenMinter,
} from "#lib/github/lease.js";
import {
  PUSH_SIGNED_SCRIPT,
  PUSH_VARIABLES,
  SIGNED_COMMITS_ENV,
  SIGNED_PUSH_TIMEOUT_MS,
  signedCommits,
  signedPushCommandLine,
  signedPushEnvironment,
} from "#lib/github/push-signed.js";
import { startGitDataApi } from "./support/git-data-api.js";

/**
 * The signed push: the script's text, the script run for real, and how the
 * runtime leases a credential to it.
 *
 * @remarks
 * The "for real" tests run `PUSH_SIGNED_SCRIPT` with Node.js and the real
 * git. A bare repository in a temporary directory stands in for GitHub: git
 * fetches from it over `file://`, and `support/git-data-api.ts` serves the
 * Git Data API on top of it over local HTTP. The checkout is shallow with a
 * widened fetch refspec, as a station's is. No network is involved.
 *
 * The text tests are claims about the script's code, so they read it with
 * its comments removed, and each has a counterpart among the "for real"
 * tests that holds the same property by running the script.
 */

const run = promisify(execFile);
const TOKEN = "ghs_SIGNEDPUSH0123456789abcdefghijklmnop";
const PLACEHOLDER = "factory-signed-test";
const APP_AUTHOR = "app[bot]";

const hasGit = spawnSync("git", ["--version"]).status === 0;
// CI sets this, so a runner without git fails the suite instead of skipping.
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

// Real git takes seconds per scenario on a busy machine: one push was seen
// to take six, past the default limit of five.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The script's code: every `//` comment removed, so a comment can neither
 * satisfy a text check nor trip one. A `//` inside a URL follows a colon,
 * not a space, and stays.
 */
const SCRIPT_CODE = PUSH_SIGNED_SCRIPT.split("\n")
  .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
  .join("\n");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signedCommits: the deployer's switch", () => {
  test("off unless the deployer turns it on", () => {
    vi.stubEnv(SIGNED_COMMITS_ENV, "");
    expect(signedCommits()).toBe(false);
  });

  test.each(["1", " 1 "])("%j turns it on", (value) => {
    vi.stubEnv(SIGNED_COMMITS_ENV, value);
    expect(signedCommits()).toBe(true);
  });

  test.each(["0", "true", "yes", "on"])("%j is not the opt-in", (value) => {
    vi.stubEnv(SIGNED_COMMITS_ENV, value);
    expect(signedCommits()).toBe(false);
  });
});

describe("PUSH_SIGNED_SCRIPT: the text", () => {
  test("is literal: no backtick and no template placeholder, so what is written is what runs", () => {
    expect(PUSH_SIGNED_SCRIPT).not.toContain("`");
    expect(PUSH_SIGNED_SCRIPT).not.toContain("${");
  });

  test.each([
    ["as written", PUSH_SIGNED_SCRIPT],
    ["with its comments removed", SCRIPT_CODE],
  ])("is JavaScript that Node.js accepts, %s", (_case, text) => {
    const check = spawnSync(process.execPath, ["--check", "-"], {
      encoding: "utf8",
      input: text,
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  test("the comment-free text the checks below read has the code and none of the comments", () => {
    expect(PUSH_SIGNED_SCRIPT).toMatch(/^\/\/ Software factory signed push/m);
    expect(SCRIPT_CODE).not.toMatch(/(^|\s)\/\//m);
    expect(SCRIPT_CODE).toContain('"https://api.github.com"');
    expect(SCRIPT_CODE).toContain("main().catch(");
  });

  test("never forces: no force flag for git, and the one ref update says force: false", () => {
    expect(SCRIPT_CODE).not.toMatch(/--force|force: true|"-f"/);
    // Exactly one mention of force in the code, and it is the literal false.
    expect(SCRIPT_CODE.match(/force\b[^,}\n]*/g)).toEqual(["force: false"]);
  });

  test("reads nothing about the remote from the checkout's git config", () => {
    expect(SCRIPT_CODE).not.toMatch(
      /get-url|"config"|pushDefault|pushRemote|remote\.origin/
    );
    // The only remote a fetch names is the URL the runtime handed over.
    const fetches = SCRIPT_CODE.match(/"fetch",[^)]*/g) ?? [];
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/^"fetch", "--quiet", REMOTE, /);
    expect(SCRIPT_CODE).toContain(
      'const REMOTE = need("FACTORY_PUSH_REMOTE");'
    );
  });

  test("reads every variable the runtime sets, in code and not just in a comment", () => {
    const names = Object.values(PUSH_VARIABLES);
    expect(names).toHaveLength(8);
    for (const name of names) {
      const read =
        SCRIPT_CODE.includes(`need("${name}")`) ||
        SCRIPT_CODE.includes(`process.env.${name}`);
      expect(read, name).toBe(true);
    }
  });

  test("runs git by the path it is given, never by name", () => {
    expect(SCRIPT_CODE).not.toMatch(/(?:execFileSync|spawnSync)\("git"/);
    // Both places git starts take the binary from the runtime's variable.
    expect(SCRIPT_CODE).toContain('const GIT = need("FACTORY_PUSH_GIT");');
    expect(SCRIPT_CODE.match(/(?:execFileSync|spawnSync)\([^,]*/g)).toEqual([
      "execFileSync(GIT",
      "spawnSync(GIT",
    ]);
  });
});

describe("what the runtime tells the script", () => {
  test("the validated branch, the factory repository, the literal URL, the image's git, and the placeholder", () => {
    expect(signedPushEnvironment("factory/bug-x", PLACEHOLDER)).toEqual({
      FACTORY_PUSH_BRANCH: "factory/bug-x",
      FACTORY_PUSH_CREDENTIAL: PLACEHOLDER,
      FACTORY_PUSH_DIR: REPO_DIR,
      FACTORY_PUSH_GIT: GIT_BINARY,
      FACTORY_PUSH_GIT_PATH: RUNNER_PATH,
      FACTORY_PUSH_REMOTE: REMOTE_URL,
      FACTORY_PUSH_REPO: "acme/widgets",
    });
  });

  test("the API is GitHub's unless a test says otherwise: the runtime never sets it", () => {
    expect(
      Object.keys(signedPushEnvironment("factory/x", PLACEHOLDER))
    ).not.toContain(PUSH_VARIABLES.api);
  });

  test("the command line checks for a URL rewrite first, then runs the script and removes it", () => {
    const command = signedPushCommandLine("/tmp/factory-x-push-signed.cjs");
    expect(command).toMatch(
      /^for scope in --local --worktree --global --system; /
    );
    expect(command).toContain(
      "node '/tmp/factory-x-push-signed.cjs'; status=$?; rm -f '/tmp/factory-x-push-signed.cjs'; exit $status"
    );
    expect(spawnSync("sh", ["-n", "-c", command]).status).toBe(0);
  });

  test.runIf(hasGit)(
    "run for real, the command line exits as the script did and removes it, whether the script failed or not",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "factory-push-command-"));
      try {
        const checkout = join(directory, "repo");
        git(directory, "init", "-q", checkout);
        for (const code of [0, 3]) {
          const path = join(directory, `exits-${code}.cjs`);
          writeFileSync(path, `process.exit(${code});`);
          const command = signedPushCommandLine(path)
            .replaceAll(`'${REPO_DIR}'`, `'${checkout}'`)
            .replaceAll(GIT_BINARY, "git")
            .replace("; node '", `; '${process.execPath}' '`);
          expect(command).toContain(
            `; '${process.execPath}' '${path}'; status`
          );

          // This machine's own git config is kept out: a URL rewrite in it
          // would stop the command at the guard.
          const ran = spawnSync("sh", ["-c", command], {
            env: { ...process.env, ...identity },
          });
          expect(ran.status).toBe(code);
          expect(existsSync(path)).toBe(false);
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  );
});

type Step =
  | { kind: "policy"; policy: unknown }
  | {
      command: string;
      env: Record<string, string>;
      kind: "run";
      timed: boolean;
    }
  | { content: string; kind: "write"; path: string };

/** A sandbox that records what a push does to it. */
const recordingSandbox = (
  execute: (
    command: string,
    env: Record<string, string>
  ) => Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }> = async () => ({
    exitCode: 0,
    stderr: "",
    stdout: "",
  }),
  onWrite: (file: { content: string; path: string }) => void = () => undefined
) => {
  const steps: Step[] = [];
  const sandbox: LeaseSandbox = {
    name: "sbx_signed",
    run: async ({ command, env, signal }) => {
      steps.push({
        command,
        env: env ?? {},
        kind: "run",
        timed: signal !== undefined,
      });
      return await execute(command, env ?? {});
    },
    setNetworkPolicy: async (policy) => {
      steps.push({ kind: "policy", policy });
    },
    writeTextFile: async ({ content, path }) => {
      steps.push({ content, kind: "write", path });
      onWrite({ content, path });
    },
  };
  return { sandbox, steps };
};

describe("runGitPush with FACTORY_SIGNED_COMMITS=1: how the runtime leases the replay", () => {
  beforeEach(() => {
    resetTokenScopeMemo();
    vi.stubEnv(SIGNED_COMMITS_ENV, "1");
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
    vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "");
  });

  const push = async () => {
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (permissions) => {
      requests.push(permissions);
      return TOKEN;
    };
    const { sandbox, steps } = recordingSandbox();
    const result = await runGitPush(sandbox, "factory/bug-x", {
      id: () => "signed-test",
      mint,
    });
    return { requests, result, steps };
  };

  test("writes the script, leases, runs it, and ends the lease, in that order", async () => {
    const { steps } = await push();
    expect(steps.map((step) => step.kind)).toEqual([
      "write",
      "policy",
      "run",
      "policy",
    ]);
    expect(steps[0]).toEqual({
      content: PUSH_SIGNED_SCRIPT,
      kind: "write",
      path: `/tmp/${PLACEHOLDER}-push-signed.cjs`,
    });
    expect(steps[2]).toMatchObject({
      command: signedPushCommandLine(`/tmp/${PLACEHOLDER}-push-signed.cjs`),
    });
    expect(steps[3]).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("the token is the push scope and nothing wider: contents:write on the factory repository", async () => {
    const { requests } = await push();
    expect(requests).toEqual([TOKEN_SCOPES["repo-push"].required]);
    expect(requests[0]).toEqual(["contents:write"]);
  });

  test("the lease covers the API hosts as well as the git hosts, since the replay uses both", async () => {
    const { steps } = await push();
    expect(steps[1]).toEqual({
      kind: "policy",
      policy: leasePolicy("shell", TOKEN, PLACEHOLDER),
    });
  });

  test("the script gets the placeholder, never the token", async () => {
    const { steps } = await push();
    const text = JSON.stringify(steps.filter((step) => step.kind !== "policy"));
    expect(text).toContain(PLACEHOLDER);
    expect(text).not.toContain(TOKEN);
  });

  test("git runs with hooks off and HTTPS only, and its PATH goes to the script while node resolves from the sandbox's own", async () => {
    const { steps } = await push();
    const [, , ran] = steps;
    if (ran?.kind !== "run") {
      throw new Error("expected the push to run");
    }
    expect(ran.env.PATH).toBeUndefined();
    expect(ran.env.FACTORY_PUSH_GIT_PATH).toBe(RUNNER_PATH);
    expect(ran.env.GIT_TERMINAL_PROMPT).toBe("0");
    const config = Object.fromEntries(
      Array.from({ length: Number(ran.env.GIT_CONFIG_COUNT) }, (_, index) => [
        ran.env[`GIT_CONFIG_KEY_${index}`],
        ran.env[`GIT_CONFIG_VALUE_${index}`],
      ])
    );
    expect(config["core.hooksPath"]).toBe("/dev/null");
    expect(config["protocol.allow"]).toBe("never");
    expect(config["protocol.https.allow"]).toBe("always");
    expect(ran.env.FACTORY_PUSH_BRANCH).toBe("factory/bug-x");
    expect(ran.env.FACTORY_PUSH_REPO).toBe("acme/widgets");
    expect(ran.env.FACTORY_PUSH_REMOTE).toBe(REMOTE_URL);
  });

  test("it has a time limit, no longer than a plain push's: a tool call that outlived the platform would never take the lease off", async () => {
    const { steps } = await push();
    expect(steps[2]).toMatchObject({ timed: true });
    expect(SIGNED_PUSH_TIMEOUT_MS).toBeLessThanOrEqual(GIT_TIMEOUT_MS);
  });

  test("a failed replay still ends the lease", async () => {
    const { sandbox, steps } = recordingSandbox(async () => ({
      exitCode: 1,
      stderr: "error: updates were rejected",
      stdout: "",
    }));
    const result = await runGitPush(sandbox, "factory/bug-x", {
      id: () => "signed-test",
      mint: async () => TOKEN,
    });
    expect(result.exitCode).toBe(1);
    expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
  });

  test("without the setting the push is the plain git push it always was, and no script is written", async () => {
    vi.stubEnv(SIGNED_COMMITS_ENV, "");
    const { sandbox, steps } = recordingSandbox();
    await runGitPush(sandbox, "factory/bug-x", {
      id: () => "signed-test",
      mint: async () => TOKEN,
    });
    expect(steps.map((step) => step.kind)).toEqual(["policy", "run", "policy"]);
    expect(steps[0]).toEqual({
      kind: "policy",
      policy: leasePolicy("git", TOKEN, PLACEHOLDER),
    });
    expect(steps[1]).toMatchObject({
      command: pushCommandLine("factory/bug-x"),
    });
  });
});

describe.runIf(required)("the CLI contract tests are required here", () => {
  test("git is installed", () => {
    expect(hasGit).toBe(true);
  });
});

let root = "";
let bare = "";
let work = "";
let script = "";
let api: Awaited<ReturnType<typeof startGitDataApi>>;

/** The git this machine has, by absolute path. */
const REAL_GIT = hasGit
  ? execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  : "";
/** The PATH the script is told to give git. Not the PATH the script runs with. */
const GIT_PATH = `${dirname(REAL_GIT)}:/usr/bin:/bin`;
/** The binary the script is told to run: logs the PATH it got, then is git. */
let recordingGit = "";
let recordedPaths = "";
/** A `git` first on the script's own PATH. Running git by name would hit it. */
let decoyDirectory = "";
let decoyRan = "";

const executable = (path: string, lines: string[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${["#!/bin/sh", ...lines].join("\n")}\n`);
  chmodSync(path, 0o755);
};

const installGitDoubles = () => {
  recordingGit = join(root, "runtime", "git");
  recordedPaths = join(root, "runtime", "paths");
  decoyDirectory = join(root, "decoy");
  decoyRan = join(root, "decoy-ran");
  executable(recordingGit, [
    `printf '%s\\n' "$PATH" >> '${recordedPaths}'`,
    `exec '${REAL_GIT}' "$@"`,
  ]);
  executable(join(decoyDirectory, "git"), [
    `touch '${decoyRan}'`,
    `exec '${REAL_GIT}' "$@"`,
  ]);
};

const identity = {
  GIT_AUTHOR_EMAIL: "foreman[bot]@users.noreply.github.com",
  GIT_AUTHOR_NAME: "foreman[bot]",
  GIT_COMMITTER_EMAIL: "foreman[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "foreman[bot]",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_VALUE_0: "always",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const remote = (...args: string[]) => git(bare, ...args);

const write = (name: string, content: string, directory = work) => {
  mkdirSync(join(directory, name, ".."), { recursive: true });
  writeFileSync(join(directory, name), content);
};
const commit = (
  name: string,
  content: string,
  message: string,
  directory = work
) => {
  write(name, content, directory);
  git(directory, "add", name);
  git(directory, "commit", "-q", "-m", message);
};

/** Who GitHub says wrote a commit: the app, for one the script recreated. */
const authorOf = (ref: string) => remote("log", "-1", "--format=%an", ref);
const commitsOn = (ref: string, base = "main") =>
  remote("rev-list", "--reverse", `${base}..${ref}`)
    .split("\n")
    .filter(Boolean);

/** A checkout like a station's: shallow, with the fetch refspec widened. */
const cloneAs = (name: string, depth = "50") => {
  const directory = join(root, name);
  git(root, "clone", "-q", "--depth", depth, `file://${bare}`, directory);
  git(
    directory,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*"
  );
  return directory;
};

/** Pushes a commit to a branch from another clone, as a person would. */
const advance = (branch: string, file: string, content: string) => {
  const other = cloneAs(`other-${Math.random().toString(36).slice(2)}`);
  git(other, "fetch", "-q", "origin", branch);
  git(other, "checkout", "-q", branch);
  commit(file, content, `Change ${file} on ${branch}`, other);
  git(other, "push", "-q", "origin", branch);
};

const scriptEnv = (branch: string, overrides: Record<string, string> = {}) => ({
  ...process.env,
  ...identity,
  PATH: `${decoyDirectory}:${process.env.PATH ?? ""}`,
  [PUSH_VARIABLES.api]: api.url,
  [PUSH_VARIABLES.branch]: branch,
  [PUSH_VARIABLES.credential]: PLACEHOLDER,
  [PUSH_VARIABLES.directory]: work,
  [PUSH_VARIABLES.git]: recordingGit,
  [PUSH_VARIABLES.gitPath]: GIT_PATH,
  [PUSH_VARIABLES.remote]: `file://${bare}`,
  [PUSH_VARIABLES.repository]: "acme/widgets",
  ...overrides,
});

/** The message of a commit exactly as stored, trailing newline included. */
const rawMessage = (directory: string, ref: string): string => {
  const object = execFileSync(
    "git",
    ["-C", directory, "cat-file", "commit", ref],
    {
      encoding: "utf8",
    }
  );
  return object.slice(object.indexOf("\n\n") + 2);
};

/** The ref updates the script sent: a PATCH moves a branch that exists. */
const refUpdates = () =>
  api.requests.filter((request) => request.method === "PATCH");

/** Runs the script for `branch`. Async, so the stand-in API can answer. */
const push = async (
  branch: string,
  overrides: Record<string, string> = {}
): Promise<{ code: number; output: string }> => {
  try {
    const { stderr, stdout } = await run(process.execPath, [script], {
      env: scriptEnv(branch, overrides),
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code: number; stderr: string; stdout: string };
    return { code: failure.code, output: failure.stdout + failure.stderr };
  }
};

/**
 * The refusal tests below end with "GitHub keeps their commit". That only
 * means something if the stand-in would have let a wrong script through: it
 * must refuse what GitHub refuses, and obey a forced update as GitHub does.
 */
describe.runIf(hasGit)(
  "the stand-in for the Git Data API is as strict as GitHub where the script's safety rests on it",
  () => {
    let mainHead = "";
    let sibling = "";
    let child = "";

    const call = async (method: string, path: string, body?: object) => {
      const response = await fetch(`${api.url}/repos/acme/widgets${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        method,
      });
      return {
        payload: (await response.json()) as Record<string, unknown>,
        status: response.status,
      };
    };

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "factory-git-data-api-test-"));
      bare = join(root, "remote.git");
      git(root, "init", "-q", "--bare", "-b", "main", bare);
      const seed = join(root, "seed");
      git(root, "clone", "-q", `file://${bare}`, seed);
      git(seed, "checkout", "-q", "-b", "main");
      commit("README.md", "factory\n", "Initial commit", seed);
      git(seed, "push", "-q", "origin", "main");
      mainHead = remote("rev-parse", "main");
      const tree = remote("rev-parse", "main^{tree}");
      // Two commits on top of main: one becomes the branch, one is its sibling.
      child = remote("commit-tree", tree, "-p", mainHead, "-m", "Child");
      sibling = remote("commit-tree", tree, "-p", mainHead, "-m", "Sibling");
      remote("update-ref", "refs/heads/factory/x", child);
      api = await startGitDataApi(bare);
    });

    afterEach(async () => {
      await api.close();
      rmSync(root, { force: true, recursive: true });
    });

    test("a ref update that is not a fast-forward is refused, and the branch stays", async () => {
      for (const body of [{ sha: sibling }, { force: false, sha: sibling }]) {
        const reply = await call("PATCH", "/git/refs/heads/factory/x", body);
        expect(reply.status).toBe(422);
        expect(reply.payload.message).toBe("Update is not a fast forward");
      }
      expect(remote("rev-parse", "factory/x")).toBe(child);
    });

    test("the same update with force: true goes through, so a script that forced would be seen to overwrite", async () => {
      const reply = await call("PATCH", "/git/refs/heads/factory/x", {
        force: true,
        sha: sibling,
      });
      expect(reply.status).toBe(200);
      expect(remote("rev-parse", "factory/x")).toBe(sibling);
    });

    test("a fast-forward goes through without force", async () => {
      remote("update-ref", "refs/heads/factory/x", mainHead);
      const reply = await call("PATCH", "/git/refs/heads/factory/x", {
        force: false,
        sha: child,
      });
      expect(reply.status).toBe(200);
      expect(remote("rev-parse", "factory/x")).toBe(child);
    });

    test("a ref cannot be moved to, or created at, a commit the repository does not have", async () => {
      const missing = "1".repeat(40);
      expect(
        (await call("PATCH", "/git/refs/heads/factory/x", { sha: missing }))
          .status
      ).toBe(422);
      expect(
        (
          await call("POST", "/git/refs", {
            ref: "refs/heads/factory/new",
            sha: missing,
          })
        ).status
      ).toBe(422);
      expect(remote("rev-parse", "factory/x")).toBe(child);
      expect(remote("for-each-ref", "refs/heads/factory/new")).toBe("");
    });

    test("creating a ref that exists is refused, and the branch stays", async () => {
      const reply = await call("POST", "/git/refs", {
        ref: "refs/heads/factory/x",
        sha: sibling,
      });
      expect(reply.status).toBe(422);
      expect(remote("rev-parse", "factory/x")).toBe(child);
    });

    test("a tree with no entries, or naming a blob or base tree the repository lacks, is refused", async () => {
      const missing = "2".repeat(40);
      const entry = { mode: "100644", path: "a.txt", type: "blob" };
      const blob = await call("POST", "/git/blobs", {
        content: Buffer.from("a\n").toString("base64"),
        encoding: "base64",
      });
      expect(blob.status).toBe(201);
      const present = { ...entry, sha: blob.payload.sha };

      for (const body of [
        { tree: [] },
        { tree: [{ ...entry, sha: missing }] },
        { base_tree: missing, tree: [present] },
      ]) {
        expect((await call("POST", "/git/trees", body)).status).toBe(422);
      }
      // The same entry with nothing missing is accepted.
      expect(
        (await call("POST", "/git/trees", { tree: [present] })).status
      ).toBe(201);
    });

    test("a commit whose tree or parent the repository lacks is refused", async () => {
      const missing = "3".repeat(40);
      const tree = remote("rev-parse", "main^{tree}");
      for (const body of [
        { message: "x\n", parents: [mainHead], tree: missing },
        { message: "x\n", parents: [missing], tree },
      ]) {
        expect((await call("POST", "/git/commits", body)).status).toBe(422);
      }
      const made = await call("POST", "/git/commits", {
        message: "x\n",
        parents: [mainHead],
        tree,
      });
      expect(made.status).toBe(201);
      expect(authorOf(String(made.payload.sha))).toBe(APP_AUTHOR);
    });

    test("it records each request with its method, path, repository, body, and authorization", async () => {
      await fetch(`${api.url}/repos/acme/widgets/git/ref/heads/main`, {
        headers: { authorization: "Bearer recorded" },
      });
      expect(api.requests).toEqual([
        {
          authorization: "Bearer recorded",
          body: {},
          method: "GET",
          path: "/git/ref/heads/main",
          repository: "acme/widgets",
        },
      ]);
      expect(api.count("GET", "/git/ref/")).toBe(1);
      expect(api.count("PATCH", "/git/ref")).toBe(0);
    });
  }
);

describe.runIf(hasGit)("PUSH_SIGNED_SCRIPT: run for real", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "factory-push-signed-"));
    bare = join(root, "remote.git");
    script = join(root, "push-signed.cjs");
    writeFileSync(script, PUSH_SIGNED_SCRIPT);
    installGitDoubles();
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    const seed = join(root, "seed");
    git(root, "clone", "-q", `file://${bare}`, seed);
    git(seed, "checkout", "-q", "-b", "main");
    commit("README.md", "factory\n", "Initial commit", seed);
    commit("a.txt", "a\n", "Add a", seed);
    git(seed, "push", "-q", "origin", "main");
    work = cloneAs("repo");
    api = await startGitDataApi(bare);
  });

  afterEach(async () => {
    await api.close();
    rmSync(root, { force: true, recursive: true });
    // Whatever the scenario, nothing the script sent asked GitHub to force.
    expect(
      api.requests.filter((request) => (request.body.force ?? false) !== false)
    ).toEqual([]);
  });

  test("a new branch: every new commit is recreated by the app, with the same content, modes, and messages", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    write("run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(work, "run.sh"), 0o755);
    symlinkSync("b.txt", join(work, "link"));
    write("nested/deep/c.txt", "c\n");
    git(work, "add", "-A");
    git(
      work,
      "commit",
      "-q",
      "-m",
      "Add a script, a link, and a nested file\n\nWith a body."
    );
    const unsigned = git(work, "rev-parse", "HEAD");
    const tree = git(work, "rev-parse", "HEAD^{tree}");
    const message = rawMessage(work, unsigned);
    expect(message).toBe(
      "Add a script, a link, and a nested file\n\nWith a body.\n"
    );

    const result = await push("factory/feature-x");
    expect(result.output).toContain(
      "* [new branch]  factory/feature-x -> factory/feature-x (2 signed commits)"
    );
    expect(result.code).toBe(0);

    const pushed = commitsOn("factory/feature-x");
    expect(pushed).toHaveLength(2);
    for (const sha of pushed) {
      expect(authorOf(sha)).toBe(APP_AUTHOR);
    }
    // Same tree, so the same files, modes, and link; a different commit.
    expect(remote("rev-parse", "factory/feature-x^{tree}")).toBe(tree);
    expect(remote("rev-parse", "factory/feature-x")).not.toBe(unsigned);
    expect(remote("ls-tree", "-r", "factory/feature-x")).toMatch(
      /100755 blob \w+\trun\.sh/
    );
    expect(remote("ls-tree", "-r", "factory/feature-x")).toMatch(
      /120000 blob \w+\tlink/
    );
    // Byte for byte, down to the single trailing newline.
    expect(rawMessage(bare, "factory/feature-x")).toBe(message);
    expect(rawMessage(bare, "factory/feature-x~1")).toBe("Add b\n");
  });

  test("git is run by the path the runtime names and with the PATH the runtime gives it, never by name", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);

    // Every git the script started was the named binary, and each got the
    // runtime's PATH, not the one the script itself ran with.
    const paths = readFileSync(recordedPaths, "utf8").trim().split("\n");
    expect(paths.length).toBeGreaterThan(5);
    expect([...new Set(paths)]).toEqual([GIT_PATH]);
    expect(GIT_PATH).not.toBe(scriptEnv("factory/feature-x").PATH);
    // The `git` first on the script's own PATH never ran.
    expect(existsSync(join(decoyDirectory, "git"))).toBe(true);
    expect(existsSync(decoyRan)).toBe(false);
  });

  test("afterwards the local branch is the signed branch, the working tree is untouched, and git status is clean", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    write("scratch.txt", "not committed\n");
    expect((await push("factory/feature-x")).code).toBe(0);

    const head = remote("rev-parse", "factory/feature-x");
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(
      git(work, "rev-parse", "refs/remotes/origin/factory/feature-x")
    ).toBe(head);
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe(
      "factory/feature-x"
    );
    // The uncommitted file is still there, and nothing else changed.
    expect(git(work, "status", "--porcelain")).toBe("?? scratch.txt");
  });

  test("pushing again with nothing new says so and changes nothing", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    const head = remote("rev-parse", "factory/feature-x");
    const before = api.requests.length;

    const again = await push("factory/feature-x");
    expect(again).toEqual({ code: 0, output: "Everything up-to-date\n" });
    expect(remote("rev-parse", "factory/feature-x")).toBe(head);
    // One lookup of the branch, and no writes.
    expect(api.requests.slice(before).map((request) => request.method)).toEqual(
      ["GET"]
    );
  });

  test("a revision fast-forwards the branch: only the new commit is recreated, and only its new blob is uploaded", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    const first = remote("rev-parse", "factory/feature-x");
    const commitsBefore = api.count("POST", "/git/commits");
    const blobsBefore = api.count("POST", "/git/blobs");

    // One new file, and one whose content GitHub already has under b.txt.
    write("c.txt", "c\n");
    write("copy-of-b.txt", "b\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Address review");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(result.output).toContain("(1 signed commit)");
    expect(api.count("POST", "/git/commits") - commitsBefore).toBe(1);
    expect(api.count("POST", "/git/blobs") - blobsBefore).toBe(1);
    expect(remote("rev-parse", "factory/feature-x~1")).toBe(first);
    expect(remote("show", "factory/feature-x:copy-of-b.txt")).toBe("b");
    expect(git(work, "status", "--porcelain")).toBe("");

    // The branch moved by one ref update, and that update was not forced.
    const updates = refUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.path).toBe("/git/refs/heads/factory/feature-x");
    expect(updates[0]?.body).toEqual({
      force: false,
      sha: remote("rev-parse", "factory/feature-x"),
    });
  });

  test("a commit with more files than one batch of uploads arrives whole", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    for (let index = 0; index < 20; index += 1) {
      write(`many/file-${index}.txt`, `content ${index}\n`);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Add twenty files");
    const tree = git(work, "rev-parse", "HEAD^{tree}");
    expect((await push("factory/feature-x")).code).toBe(0);
    expect(api.count("POST", "/git/blobs")).toBe(20);
    expect(remote("rev-parse", "factory/feature-x^{tree}")).toBe(tree);
  });

  test("a deleted file is deleted on GitHub", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    git(work, "rm", "-q", "a.txt");
    git(work, "commit", "-q", "-m", "Remove a");
    expect((await push("factory/feature-x")).code).toBe(0);
    expect(remote("ls-tree", "-r", "--name-only", "factory/feature-x")).toBe(
      "README.md"
    );
  });

  test("a commit that changes no files is pushed, though GitHub's tree API would reject an empty tree request", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    git(work, "commit", "-q", "--allow-empty", "-m", "Trigger CI");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(api.count("POST", "/git/trees")).toBe(0);
    expect(remote("log", "-1", "--format=%s", "factory/feature-x")).toBe(
      "Trigger CI"
    );
  });

  test("a merge of the base branch stays a merge, and the base branch's own commits are not recreated", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    advance("main", "main.txt", "main\n");
    const mainHead = remote("rev-parse", "main");

    git(work, "fetch", "-q", "origin", "main");
    git(work, "merge", "-q", "--no-edit", "origin/main");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(result.output).toContain("(1 signed commit)");

    const parents = remote(
      "log",
      "-1",
      "--format=%P",
      "factory/feature-x"
    ).split(" ");
    expect(parents).toHaveLength(2);
    // The second parent is main's real commit, not a copy of it.
    expect(parents[1]).toBe(mainHead);
    expect(authorOf(mainHead)).not.toBe(APP_AUTHOR);
    expect(remote("merge-base", "factory/feature-x", "main")).toBe(mainHead);
  });

  test("a branch someone else moved is not overwritten: the push is refused, and GitHub keeps their commit", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    advance("factory/feature-x", "theirs.txt", "theirs\n");
    const theirs = remote("rev-parse", "factory/feature-x");

    commit("mine.txt", "mine\n", "My change");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(1);
    expect(result.output).toContain("updates were rejected");
    expect(result.output).toContain(
      "git pull --rebase origin factory/feature-x"
    );
    expect(remote("rev-parse", "factory/feature-x")).toBe(theirs);
    expect(api.count("PATCH", "/git/refs")).toBe(0);
  });

  // What a ref update carries when one is sent is held by the revision test
  // above; here the script stops before sending any.
  test("a rewritten branch is refused before any ref update is sent, and GitHub keeps what was pushed", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    const pushed = remote("rev-parse", "factory/feature-x");
    const before = api.requests.length;

    git(work, "commit", "-q", "--amend", "-m", "Rewritten");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(1);
    expect(result.output).toContain("updates were rejected");
    expect(remote("rev-parse", "factory/feature-x")).toBe(pushed);
    // It asked where the branch is, and sent nothing that writes.
    expect(api.requests.slice(before).map((request) => request.method)).toEqual(
      ["GET"]
    );
  });

  test("stale remote-tracking refs do not make it recreate commits GitHub already has", async () => {
    advance("main", "main.txt", "main\n");
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "factory/feature-x", "origin/main");
    commit("b.txt", "b\n", "Add b");
    // The checkout's own account of GitHub is wrong: it forgets main entirely.
    git(work, "update-ref", "-d", "refs/remotes/origin/main");
    git(work, "update-ref", "-d", "refs/remotes/origin/HEAD");

    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(result.output).toContain("(1 signed commit)");
    expect(api.count("POST", "/git/commits")).toBe(1);
    // The branch sits on main's real head, so a pull request shows one commit.
    expect(commitsOn("factory/feature-x")).toHaveLength(1);
    expect(remote("rev-parse", "factory/feature-x~1")).toBe(
      remote("rev-parse", "main")
    );
  });

  test("a remote-tracking ref that claims GitHub has a commit it lacks does not keep that commit's blobs from being uploaded", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "shared content\n", "Add b");
    // The checkout claims this commit is on GitHub. It is not.
    git(work, "update-ref", "refs/remotes/origin/phantom", "HEAD");
    git(work, "reset", "-q", "--hard", "origin/main");
    commit("copy.txt", "shared content\n", "Add the same content elsewhere");

    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(remote("show", "factory/feature-x:copy.txt")).toBe("shared content");
  });

  test("a tree GitHub refuses is sent once more before the push gives up", async () => {
    await api.close();
    // The branch lookup, the commit lookup, and the blob go through; the tree is refused once.
    api = await startGitDataApi(bare, { failures: [null, null, null, 422] });
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");

    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(api.count("POST", "/git/trees")).toBe(2);
    expect(remote("show", "factory/feature-x:b.txt")).toBe("b");
  });

  test("before a refused tree is sent again, the blobs it names that were not uploaded the first time are", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    // A file whose content the checkout knows GitHub has, so it is not sent.
    commit("copy-of-b.txt", "b\n", "Copy b");
    const unsigned = git(work, "rev-parse", "HEAD");
    await api.close();
    // The branch lookup and the commit lookup go through; the tree is refused once.
    api = await startGitDataApi(bare, { failures: [null, null, 422] });

    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(
      api.requests.map((request) => `${request.method} ${request.path}`)
    ).toEqual([
      "GET /git/ref/heads/factory/feature-x",
      `GET /git/commits/${unsigned}`,
      "POST /git/trees",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/factory/feature-x",
    ]);
    expect(remote("show", "factory/feature-x:copy-of-b.txt")).toBe("b");
  });

  test("a tree GitHub refuses twice ends the push with GitHub's message", async () => {
    await api.close();
    api = await startGitDataApi(bare, {
      failures: [null, null, null, 422, 422],
    });
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");

    const result = await push("factory/feature-x");
    expect(result.code).toBe(1);
    expect(result.output).toContain("POST /git/trees failed: 422");
    expect(remote("for-each-ref", "refs/heads/factory")).toBe("");
  });

  test("a branch that is not checked out is pushed and moved without touching HEAD", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    git(work, "checkout", "-q", "-b", "factory/other", "origin/main");
    const head = git(work, "rev-parse", "HEAD");

    expect((await push("factory/feature-x")).code).toBe(0);
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("factory/other");
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "rev-parse", "factory/feature-x")).toBe(
      remote("rev-parse", "factory/feature-x")
    );
    expect(existsSync(join(work, "b.txt"))).toBe(false);
  });

  test("a depth-1 checkout pushes without trying to recreate history it does not have", async () => {
    work = cloneAs("shallow", "1");
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(api.count("POST", "/git/commits")).toBe(1);
    expect(remote("rev-parse", "factory/feature-x~1")).toBe(
      remote("rev-parse", "main")
    );
  });

  test("a branch that does not exist locally is refused before GitHub is asked anything", async () => {
    const result = await push("factory/never-made");
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "there is no local branch factory/never-made"
    );
    expect(api.requests).toHaveLength(0);
  });

  test("Git LFS files are refused, by the commit's own .gitattributes, and nothing is pushed", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    write(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    write("model.bin", "version https://git-lfs.github.com/spec/v1\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Add a model");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "adds or changes Git LFS files, which a signed push cannot carry: model.bin"
    );
    expect(api.count("POST", "/git/refs")).toBe(0);
  });

  test("other changes in a repository that uses LFS push normally", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    write(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Track binaries with LFS");
    commit("notes.md", "notes\n", "Add notes");
    expect((await push("factory/feature-x")).code).toBe(0);
  });

  test("every request names the factory repository and carries the placeholder, never anything else", async () => {
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    expect((await push("factory/feature-x")).code).toBe(0);
    expect(api.requests.length).toBeGreaterThan(3);
    for (const request of api.requests) {
      expect(request.repository).toBe("acme/widgets");
      expect(request.authorization).toBe(`Bearer ${PLACEHOLDER}`);
    }
  });

  test("the checkout's remote configuration cannot aim the push anywhere else", async () => {
    const elsewhere = join(root, "elsewhere.git");
    git(root, "init", "-q", "--bare", "-b", "main", elsewhere);
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    // Everything a model could write to redirect an ordinary push.
    git(work, "config", "remote.origin.url", `file://${elsewhere}`);
    git(work, "config", "remote.origin.pushurl", `file://${elsewhere}`);
    git(work, "config", "remote.pushDefault", "elsewhere");
    git(work, "config", "branch.factory/feature-x.pushRemote", "elsewhere");
    git(work, "remote", "add", "elsewhere", `file://${elsewhere}`);

    expect((await push("factory/feature-x")).code).toBe(0);
    expect(authorOf("factory/feature-x")).toBe(APP_AUTHOR);
    expect(git(elsewhere, "for-each-ref")).toBe("");
  });

  test("a rate limit or a server error is retried, and the push goes through", async () => {
    await api.close();
    api = await startGitDataApi(bare, { failures: [500, 429] });
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(0);
    expect(authorOf("factory/feature-x")).toBe(APP_AUTHOR);
  }, 30_000);

  test("a refusal from GitHub ends the push with GitHub's message, and no ref moves", async () => {
    await api.close();
    api = await startGitDataApi(bare, { failures: [403] });
    git(work, "checkout", "-q", "-b", "factory/feature-x");
    commit("b.txt", "b\n", "Add b");
    const result = await push("factory/feature-x");
    expect(result.code).toBe(1);
    expect(result.output).toContain("failed: 403 injected failure");
    expect(remote("for-each-ref", "refs/heads/factory")).toBe("");
  });

  // The branch exists and would push, so only the check under test can be
  // what stops it; the message says which check did.
  test.each([
    [
      "a repository that is not owner/name",
      { [PUSH_VARIABLES.repository]: "acme/widgets/../other" },
      "error: not a repository: acme/widgets/../other\n",
    ],
    [
      "a branch with shell text in it",
      { [PUSH_VARIABLES.branch]: "factory/x;id" },
      "error: not a branch name: factory/x;id\n",
    ],
    [
      "a branch that climbs out of refs/heads",
      { [PUSH_VARIABLES.branch]: "factory/../../tags/v1" },
      "error: not a branch name: factory/../../tags/v1\n",
    ],
    [
      "no credential",
      { [PUSH_VARIABLES.credential]: "" },
      "error: FACTORY_PUSH_CREDENTIAL is not set\n",
    ],
  ])(
    "refuses %s, though the runtime never sends one",
    async (_label, overrides, message) => {
      git(work, "checkout", "-q", "-b", "factory/feature-x");
      commit("b.txt", "b\n", "Add b");
      const result = await push("factory/feature-x", overrides);
      expect(result).toEqual({ code: 1, output: message });
      expect(api.requests).toHaveLength(0);
    }
  );
});

describe.runIf(hasGit)(
  "the whole path, for real: runGitPush, the command line, the script, and git",
  () => {
    beforeEach(async () => {
      resetTokenScopeMemo();
      vi.stubEnv(SIGNED_COMMITS_ENV, "1");
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
      root = mkdtempSync(join(tmpdir(), "factory-push-signed-e2e-"));
      bare = join(root, "remote.git");
      git(root, "init", "-q", "--bare", "-b", "main", bare);
      const seed = join(root, "seed");
      git(root, "clone", "-q", `file://${bare}`, seed);
      git(seed, "checkout", "-q", "-b", "main");
      commit("README.md", "factory\n", "Initial commit", seed);
      git(seed, "push", "-q", "origin", "main");
      work = cloneAs("repo");
      api = await startGitDataApi(bare);
    });

    afterEach(async () => {
      await api.close();
      rmSync(root, { force: true, recursive: true });
    });

    /**
     * A sandbox that really runs what it is given, on this machine: the
     * script the runtime wrote lands in the temporary directory, and the
     * command runs through `sh` with the checkout, git, GitHub, and the API
     * pointed at their local stand-ins. Everything else, the runtime's git
     * configuration included, is passed through as the runtime set it.
     *
     * The command is rewritten by text, so a rewrite that matched nothing
     * throws instead of running a command that still names the sandbox.
     * `scriptWasThere` records, per run, whether the script the runtime
     * wrote was on disk when its command started.
     */
    const localSandbox = () => {
      const scriptWasThere: boolean[] = [];
      const localScript = join(root, `${PLACEHOLDER}-push-signed.cjs`);
      const recording = recordingSandbox(
        async (command, env) => {
          const localized = command
            .replaceAll(`'${REPO_DIR}'`, `'${work}'`)
            .replaceAll(GIT_BINARY, "git")
            .replaceAll("node '/tmp/", `'${process.execPath}' '${root}/`)
            .replaceAll("rm -f '/tmp/", `rm -f '${root}/`);
          const expected = [
            `git -C '${work}' config`,
            `; '${process.execPath}' '${localScript}'; status=$?`,
            `; rm -f '${localScript}'; exit $status`,
          ];
          const left = [GIT_BINARY, `'${REPO_DIR}'`, "node '"];
          if (
            !expected.every((text) => localized.includes(text)) ||
            left.some((text) => localized.includes(text))
          ) {
            throw new Error(`the command was not localized: ${localized}`);
          }
          scriptWasThere.push(existsSync(localScript));
          const count = Number(env.GIT_CONFIG_COUNT);
          const { FACTORY_PUSH_GIT_PATH: _path, ...rest } = env;
          try {
            const { stderr, stdout } = await run("sh", ["-c", localized], {
              env: {
                ...process.env,
                ...rest,
                // The runtime allows HTTPS only; the stand-in for GitHub is a file.
                GIT_CONFIG_COUNT: String(count + 1),
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                [`GIT_CONFIG_KEY_${count}`]: "protocol.file.allow",
                [`GIT_CONFIG_VALUE_${count}`]: "always",
                [PUSH_VARIABLES.api]: api.url,
                [PUSH_VARIABLES.directory]: work,
                [PUSH_VARIABLES.git]: "git",
                [PUSH_VARIABLES.remote]: `file://${bare}`,
              },
            });
            return { exitCode: 0, stderr, stdout };
          } catch (error) {
            const failure = error as {
              code: number;
              stderr: string;
              stdout: string;
            };
            return {
              exitCode: failure.code,
              stderr: failure.stderr,
              stdout: failure.stdout,
            };
          }
        },
        ({ content, path }) => {
          if (path !== `/tmp/${PLACEHOLDER}-push-signed.cjs`) {
            throw new Error(`unexpected file written: ${path}`);
          }
          writeFileSync(localScript, content);
        }
      );
      return { ...recording, localScript, scriptWasThere };
    };

    const runPush = async (branch: string) => {
      const { localScript, sandbox, scriptWasThere, steps } = localSandbox();
      const result = await runGitPush(sandbox, branch, {
        id: () => "signed-test",
        mint: async () => TOKEN,
      });
      return { localScript, result, scriptWasThere, steps };
    };

    test("the implementer's branch arrives on GitHub as commits the app made, and the script is gone afterwards", async () => {
      git(work, "checkout", "-q", "-b", "factory/bug-fix-login");
      commit("fix.ts", "export const fixed = true;\n", "Fix login 500");
      commit("fix.test.ts", "test('fixed', () => {});\n", "Cover the fix");

      const { localScript, result, scriptWasThere, steps } = await runPush(
        "factory/bug-fix-login"
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(2 signed commits)");
      expect(result.stdout).toContain(`To ${`file://${bare}`}`);

      expect(commitsOn("factory/bug-fix-login")).toHaveLength(2);
      expect(authorOf("factory/bug-fix-login")).toBe(APP_AUTHOR);
      expect(remote("show", "factory/bug-fix-login:fix.ts")).toBe(
        "export const fixed = true;"
      );
      expect(git(work, "rev-parse", "HEAD")).toBe(
        remote("rev-parse", "factory/bug-fix-login")
      );
      expect(git(work, "status", "--porcelain")).toBe("");
      // The script was on disk when its command started, and is not now.
      expect(scriptWasThere).toEqual([true]);
      expect(existsSync(localScript)).toBe(false);
      expect(steps.at(-1)).toEqual({ kind: "policy", policy: "allow-all" });
      expect(api.requests.length).toBeGreaterThan(3);
      for (const request of api.requests) {
        expect(request.authorization).toBe(`Bearer ${PLACEHOLDER}`);
      }
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
    });

    test("a second push after a revision fast-forwards", async () => {
      git(work, "checkout", "-q", "-b", "factory/bug-fix-login");
      commit("fix.ts", "export const fixed = true;\n", "Fix login 500");
      expect((await runPush("factory/bug-fix-login")).result.exitCode).toBe(0);
      commit("fix.ts", "export const fixed = 1;\n", "Address review");
      const { result } = await runPush("factory/bug-fix-login");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(1 signed commit)");
      expect(commitsOn("factory/bug-fix-login")).toHaveLength(2);
      expect(refUpdates().map((request) => request.body)).toEqual([
        { force: false, sha: remote("rev-parse", "factory/bug-fix-login") },
      ]);
    });

    test("a URL rewrite in the checkout's config stops the push before the script runs", async () => {
      git(work, "checkout", "-q", "-b", "factory/bug-fix-login");
      commit("fix.ts", "export const fixed = true;\n", "Fix login 500");
      git(
        work,
        "config",
        "url.https://example.test/.insteadOf",
        "https://github.com/"
      );
      const { result, scriptWasThere } = await runPush("factory/bug-fix-login");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("A git URL rewrite");
      expect(api.requests).toHaveLength(0);
      expect(remote("for-each-ref", "refs/heads/factory")).toBe("");
      // The command did run, with the script in place: the guard stopped it.
      expect(scriptWasThere).toEqual([true]);
    });

    test("the runtime's hooks-off setting reaches the script's git: a hook in the checkout does not run", async () => {
      git(work, "checkout", "-q", "-b", "factory/bug-fix-login");
      commit("fix.ts", "export const fixed = true;\n", "Fix login 500");
      const marker = join(root, "hook-ran");
      for (const hook of [
        "reference-transaction",
        "post-checkout",
        "pre-push",
      ]) {
        const path = join(work, ".git", "hooks", hook);
        writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(path, 0o755);
      }
      const { result } = await runPush("factory/bug-fix-login");
      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
      // The hooks are live: the same kind of ref change, made without the
      // runtime's setting, runs one.
      git(work, "update-ref", "refs/heads/factory/control", "HEAD");
      expect(existsSync(marker)).toBe(true);
    });
  }
);
