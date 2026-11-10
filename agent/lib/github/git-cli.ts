import { shellQuote } from "./cli.js";
import {
  REMOTE_URL,
  REPO_DIR,
  validateBranch,
  validateRef,
} from "./git-remote.js";

/**
 * The networked `git` subcommands a station may run with the factory's
 * credential.
 *
 * @remarks
 * Everything local (status, diff, branch, commit, checkout, log) is plain
 * `git` in the station's shell and needs no credential. Only the four
 * commands that talk to GitHub come through here, because they are the ones
 * that run while the installation token is attached at the sandbox firewall.
 */
export const GIT_NETWORK_SUBCOMMANDS = [
  "fetch",
  "ls-remote",
  "pull",
  "push",
] as const;

export type GitNetworkSubcommand = (typeof GIT_NETWORK_SUBCOMMANDS)[number];

/** A validated networked git invocation, ready to hand to the sandbox. */
export interface GitInvocation {
  /** Branches named by the invocation, already validated. */
  readonly branches: readonly string[];
  /** The full shell command, with the literal remote URL in place. */
  readonly commandLine: string;
  /** Whether the command changes the remote (only `push` does). */
  readonly mutatesRemote: boolean;
  readonly subcommand: GitNetworkSubcommand;
}

export type GitParseResult =
  | { readonly invocation: GitInvocation; readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const MAX_GIT_ARGS = 16;

/** The image's own git, by absolute path, so nothing earlier on PATH can stand in for it. */
export const GIT_BINARY = "/usr/bin/git";

/** The one remote name the tool accepts; it always means the factory repository. */
const REMOTE_ALIAS = "origin";

const DEPTH_PATTERN = /^[1-9]\d{0,5}$/;

interface SubcommandSpec {
  readonly bool: readonly string[];
  /** Flags accepted for familiarity but not forwarded. */
  readonly dropped?: readonly string[];
  readonly maxRefs: number;
  readonly minRefs: number;
  readonly value?: Readonly<Record<string, RegExp>>;
}

const SPECS: Readonly<Record<GitNetworkSubcommand, SubcommandSpec>> = {
  fetch: {
    bool: ["--prune", "--tags", "--no-tags", "--unshallow"],
    maxRefs: 8,
    minRefs: 0,
    value: { "--depth": DEPTH_PATTERN },
  },
  "ls-remote": { bool: ["--heads", "--tags"], maxRefs: 8, minRefs: 0 },
  pull: {
    bool: ["--ff-only", "--rebase", "--no-rebase"],
    maxRefs: 1,
    minRefs: 1,
  },
  push: {
    bool: [],
    dropped: ["-u", "--set-upstream"],
    maxRefs: 1,
    minRefs: 1,
  },
};

const isSubcommand = (value: string): value is GitNetworkSubcommand =>
  (GIT_NETWORK_SUBCOMMANDS as readonly string[]).includes(value);

interface Split {
  readonly flags: readonly string[];
  readonly refs: readonly string[];
}

const splitArgs = (
  subcommand: GitNetworkSubcommand,
  rest: readonly string[]
): Split | string => {
  const spec = SPECS[subcommand];
  const flags: string[] = [];
  const refs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("-")) {
      refs.push(arg);
      continue;
    }
    if (spec.dropped?.includes(arg)) {
      continue;
    }
    if (spec.bool.includes(arg)) {
      flags.push(arg);
      continue;
    }
    const pattern = spec.value?.[arg];
    const value = rest[index + 1];
    if (pattern && value !== undefined && pattern.test(value)) {
      flags.push(arg, value);
      index += 1;
      continue;
    }
    const allowed = [
      ...spec.bool,
      ...Object.keys(spec.value ?? {}),
      ...(spec.dropped ?? []),
    ];
    return `git ${subcommand} does not accept ${arg} here. Allowed flags: ${
      allowed.length === 0 ? "none" : allowed.join(", ")
    }.`;
  }
  // The only remote is the factory repository; the name is a courtesy.
  const named = refs[0] === REMOTE_ALIAS ? refs.slice(1) : refs;
  if (named.length < spec.minRefs) {
    return `git ${subcommand} needs a branch name, like: ${subcommand} origin factory/bug-fix-login.`;
  }
  if (named.length > spec.maxRefs) {
    return `git ${subcommand} takes at most ${spec.maxRefs} branch name(s).`;
  }
  return { flags, refs: named };
};

const git = (...parts: readonly string[]): string =>
  [GIT_BINARY, "-C", shellQuote(REPO_DIR), ...parts].join(" ");

const render = (
  subcommand: GitNetworkSubcommand,
  { flags, refs }: Split
): string => {
  const flagText = flags.map(shellQuote);
  const url = shellQuote(REMOTE_URL);
  switch (subcommand) {
    case "fetch": {
      const specs =
        refs.length === 0
          ? ["+refs/heads/*:refs/remotes/origin/*"]
          : refs.map((ref) => `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
      return git("fetch", ...flagText, url, ...specs.map(shellQuote));
    }
    case "ls-remote":
      return git("ls-remote", ...flagText, url, ...refs.map(shellQuote));
    case "pull":
      return git(
        "pull",
        ...flagText,
        url,
        ...refs.map((ref) => shellQuote(`refs/heads/${ref}`))
      );
    case "push": {
      const [branch = ""] = refs;
      const ref = `refs/heads/${branch}`;
      // Keep origin/<branch> in step so `git status` tells the truth afterwards.
      return `${git("push", url, shellQuote(`${ref}:${ref}`))} && ${git(
        "update-ref",
        shellQuote(`refs/remotes/origin/${branch}`),
        shellQuote(ref)
      )}`;
    }
    default:
      return subcommand satisfies never;
  }
};

/**
 * Parses a networked git argv into a command that can only reach the factory
 * repository.
 *
 * @remarks
 * - The remote is never taken from the caller: `origin` is accepted as a
 *   word and replaced with the literal repository URL, because a sandbox's
 *   remote configuration is writable by the model.
 * - Refs are plain branch names. A refspec with a colon, a leading `+`, or a
 *   `refs/` prefix is refused, so a push can only update the branch it names,
 *   and `push` additionally refuses the protected branches.
 * - Force flags, `--delete`, `--mirror`, `--all`, and `--tags` on push are
 *   not in the allowlist.
 *
 * @param argv - The arguments after `git` (a leading `git` is tolerated).
 */
export const parseGitNetwork = (argv: readonly string[]): GitParseResult => {
  const args = argv[0] === "git" ? argv.slice(1) : argv;
  const [subcommand = "", ...rest] = args;
  if (!isSubcommand(subcommand)) {
    return {
      ok: false,
      reason: `This tool runs only the git commands that talk to GitHub: ${GIT_NETWORK_SUBCOMMANDS.join(", ")}. Run everything else (status, diff, checkout, commit, log) as plain git in the shell.`,
    };
  }
  if (args.length > MAX_GIT_ARGS) {
    return {
      ok: false,
      reason: `Too many arguments (limit ${MAX_GIT_ARGS}).`,
    };
  }
  const split = splitArgs(subcommand, rest);
  if (typeof split === "string") {
    return { ok: false, reason: split };
  }
  for (const ref of split.refs) {
    const refusal =
      subcommand === "push" ? validateBranch(ref) : validateRef(ref);
    if (refusal) {
      return { ok: false, reason: refusal };
    }
  }
  return {
    invocation: {
      branches: split.refs,
      commandLine: render(subcommand, split),
      mutatesRemote: subcommand === "push",
      subcommand,
    },
    ok: true,
  };
};
