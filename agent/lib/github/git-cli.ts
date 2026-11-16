import { shellQuote } from "./cli.js";
import {
  REMOTE_URL,
  REPO_DIR,
  validateBranch,
  validateRef,
} from "./git-remote.js";

/**
 * `git push`, the one git command that needs a credential able to write.
 *
 * @remarks
 * Stations run git in their shell, through the sandbox's `git` wrapper.
 * Every command that only reads from GitHub (`fetch`, `pull`, `ls-remote`,
 * `clone`) runs there as written, under a read-only credential. A push is
 * the only command that gets the `repo-push` token, so the `bash` tool takes
 * it out of the shell, parses it here, and runs a command the factory wrote
 * itself, by absolute path and against the literal repository URL.
 *
 * `git fetch` is parsed here too, for one case only: a deployment whose
 * GitHub App cannot issue a read-only token (see `FACTORY_TOKEN_FALLBACK`).
 * A shell command is never given a wider token than that, so there a fetch
 * can't run in the shell, and the runtime runs it the same way it runs a
 * push.
 */

/**
 * The image's own git, by absolute path, so nothing earlier on `PATH` can
 * stand in for it.
 */
export const GIT_BINARY = "/usr/bin/git";

/**
 * The one remote name a push accepts; it always means the factory
 * repository.
 */
const REMOTE_ALIAS = "origin";

/** Flags accepted for familiarity. They change nothing on the remote. */
const TOLERATED_FLAGS = new Set(["-u", "--set-upstream"]);

export const MAX_PUSH_ARGS = 8;

export interface PushRequest {
  /**
   * The branch to push, already validated, or null for the branch that is
   * checked out (`git push`, `git push origin HEAD`), which the caller
   * resolves in the sandbox and validates before pushing.
   */
  readonly branch: string | null;
}

export type PushParseResult =
  | { readonly ok: true; readonly push: PushRequest }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): PushParseResult => ({ ok: false, reason });

/**
 * Parses one `git push` into the branch it may update.
 *
 * @remarks
 * - The remote is never taken from the caller: `origin` is accepted as a
 *   word and the push goes to the literal repository URL, because a
 *   sandbox's remote configuration is writable by the model.
 * - The ref is a plain branch name or `HEAD`. A refspec with a colon, a
 *   leading `+`, or a `refs/` prefix is refused, so a push can only update
 *   the branch it names.
 * - No other flag is accepted: no force, delete, mirror, all, or tags.
 *
 * @param args - The words after `git push`.
 * @returns The branch to push (null for the checked-out one), or the
 * refusal, worded for the model.
 */
export const parseGitPush = (args: readonly string[]): PushParseResult => {
  if (args.length > MAX_PUSH_ARGS) {
    return refuse(`Too many arguments (limit ${MAX_PUSH_ARGS}).`);
  }
  const refs: string[] = [];
  for (const arg of args) {
    if (TOLERATED_FLAGS.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return refuse(
        `git push does not accept ${arg} here. Write it as: git push origin <branch>.`
      );
    }
    refs.push(arg);
  }
  // git reads the first word after the flags as the remote. The only remote
  // is the factory repository, so any other word there is a mistake.
  if (refs.length > 0 && refs[0] !== REMOTE_ALIAS) {
    return refuse(
      "The only remote is origin, the factory repository. Write it as: git push origin <branch>."
    );
  }
  const named = refs.slice(1);
  if (named.length > 1) {
    return refuse("git push takes one branch. Push branches one at a time.");
  }
  const [ref] = named;
  if (ref === undefined || ref === "HEAD") {
    return { ok: true, push: { branch: null } };
  }
  const refusal = validateBranch(ref);
  return refusal ? refuse(refusal) : { ok: true, push: { branch: ref } };
};

const git = (...parts: readonly string[]): string =>
  [GIT_BINARY, "-C", shellQuote(REPO_DIR), ...parts].join(" ");

/**
 * A shell fragment that stops the command when git's configuration files
 * rewrite URLs.
 *
 * @remarks
 * The runtime's git commands name the factory repository's URL literally,
 * so the remote a checkout has configured cannot send them elsewhere. A
 * `url.<base>.insteadOf` or `pushInsteadOf` rule can: git applies it to the
 * literal URL too, and the checkout's config files are the agent's to
 * write. The credential still only works on GitHub and, by default, only on
 * the factory repository, so the most a rule could do is aim a command at
 * another repository that a widened token (`FACTORY_TOKEN_FALLBACK`) also
 * covers. This refuses to run with such a rule in any of git's config
 * files: the checkout's own, its per-worktree file, the user's, and the
 * system's. Rules passed through the environment are the runtime's own and
 * are not looked at.
 *
 * @param path - The checkout the command runs in.
 * @returns A fragment that exits 1 when a rule is found. It has to run
 * before the command it guards.
 */
export const rewriteGuard = (path: string): string =>
  `for scope in --local --worktree --global --system; do if ${GIT_BINARY} -C ${shellQuote(path)} config "$scope" --includes --get-regexp '^url\\.' >/dev/null 2>&1; then echo 'A git URL rewrite (url.<base>.insteadOf) is configured in this sandbox. Remove it and run the command again.' >&2; exit 1; fi; done`;

/** Prints the name of the branch checked out in the station's clone. */
export const CURRENT_BRANCH_COMMAND = git("symbolic-ref", "--short", "HEAD");

/**
 * The command that pushes one branch to the factory repository.
 *
 * @param branch - A branch name that passed `validateBranch`.
 */
export const pushCommandLine = (branch: string): string => {
  const ref = `refs/heads/${branch}`;
  // Keep origin/<branch> in step so `git status` tells the truth afterwards.
  return `${rewriteGuard(REPO_DIR)}; ${git("push", shellQuote(REMOTE_URL), shellQuote(`${ref}:${ref}`))} && ${git(
    "update-ref",
    shellQuote(`refs/remotes/origin/${branch}`),
    shellQuote(ref)
  )}`;
};

const DEPTH_PATTERN = /^[1-9]\d{0,5}$/;
const FETCH_FLAGS = new Set(["--prune", "--no-tags", "--unshallow"]);
export const MAX_FETCH_ARGS = 12;

export type FetchParseResult =
  | { readonly commandLine: string; readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const refuseFetch = (reason: string): FetchParseResult => ({
  ok: false,
  reason,
});

/**
 * Parses the words after `git fetch` into a command the runtime can run.
 *
 * @remarks
 * `origin` and plain branch names only, as for a push; with no branch the
 * fetch covers every branch. Each branch lands on `origin/<branch>`, so a
 * plain `git checkout <branch>` works afterwards.
 *
 * @returns The command line, guarded and against the literal URL, or the
 * refusal, worded for the model.
 */
export const parseGitFetch = (args: readonly string[]): FetchParseResult => {
  if (args.length > MAX_FETCH_ARGS) {
    return refuseFetch(`Too many arguments (limit ${MAX_FETCH_ARGS}).`);
  }
  const flags: string[] = [];
  const refs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (FETCH_FLAGS.has(arg)) {
      flags.push(arg);
    } else if (arg === "--depth" && DEPTH_PATTERN.test(args[index + 1] ?? "")) {
      flags.push(arg, args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("-")) {
      return refuseFetch(
        `git fetch does not accept ${arg} here. Write it as: git fetch origin <branch>.`
      );
    } else {
      refs.push(arg);
    }
  }
  if (refs.length > 0 && refs[0] !== REMOTE_ALIAS) {
    return refuseFetch(
      "The only remote is origin, the factory repository. Write it as: git fetch origin <branch>."
    );
  }
  const branches = refs.slice(1);
  for (const branch of branches) {
    const refusal = validateRef(branch);
    if (refusal) {
      return refuseFetch(refusal);
    }
  }
  const specs =
    branches.length === 0
      ? ["+refs/heads/*:refs/remotes/origin/*"]
      : branches.map(
          (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`
        );
  return {
    commandLine: `${rewriteGuard(REPO_DIR)}; ${git(
      "fetch",
      ...flags.map(shellQuote),
      shellQuote(REMOTE_URL),
      ...specs.map(shellQuote)
    )}`,
    ok: true,
  };
};

const TRAILING_SLASHES = /\/+$/;
const LEADING_DOT_SLASH = /^\.\//;

/**
 * Whether a directory named with `cd` or `git -C` is the station's clone.
 * A push always runs there, so naming any other directory is refused.
 *
 * @param directory - The directory the command named, or null when it
 * named none, which counts as the clone.
 */
export const isRepoDirectory = (directory: string | null): boolean => {
  if (directory === null) {
    return true;
  }
  const trimmed = directory.replace(TRAILING_SLASHES, "");
  return (
    trimmed === REPO_DIR ||
    trimmed.replace(LEADING_DOT_SLASH, "") === REPO_DIR.split("/").at(-1)
  );
};
