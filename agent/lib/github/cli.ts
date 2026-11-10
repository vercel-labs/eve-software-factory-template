import { FACTORY_REPO } from "../constants.js";

/**
 * What a `gh` invocation does to the repository, as far as authorization is
 * concerned.
 *
 * @remarks
 * The factory drives GitHub through the real `gh` binary, so the argv is the
 * only thing standing between the model and the installation token's full
 * reach. Every invocation is parsed against the allowlist in this module and
 * reduced to one effect; `agent/lib/github/approval.ts` maps the effect and
 * the caller's trust class to run / park / deny. Anything the allowlist
 * doesn't name is `forbidden`, including every flag it doesn't name, so a new
 * `gh` feature is unreachable until someone decides what it is.
 *
 * - `read`: no change to GitHub.
 * - `label`: only adds or removes labels on one issue or pull request.
 * - `comment`: posts or edits the factory's own comment on one thread.
 * - `state`: closes or reopens an issue (reversible triage).
 * - `draft-pr`: opens a draft pull request, which cannot merge.
 * - `write`: any other reversible write (new issue, edits, assignees, ...).
 * - `ship`: anything that can put code in front of reviewers as ready.
 * - `forbidden`: never runs, for any caller.
 */
export type GhEffect =
  | { readonly kind: "read" }
  | { readonly kind: "label" }
  | { readonly kind: "comment"; readonly thread: number | null }
  | {
      readonly kind: "state";
      /** Thread the attached `--comment` lands on, when one was passed. */
      readonly commentThread: number | null;
      readonly withComment: boolean;
    }
  | { readonly kind: "draft-pr" }
  | { readonly kind: "write" }
  | { readonly kind: "ship" }
  | { readonly kind: "forbidden"; readonly reason: string };

/** A validated `gh` invocation, ready to hand to the sandbox. */
export interface GhInvocation {
  /** Normalized argv without the leading `gh` and without `--repo`. */
  readonly args: readonly string[];
  /** The command path, e.g. `issue comment`. */
  readonly command: string;
  readonly effect: Exclude<GhEffect, { kind: "forbidden" }>;
}

export type GhParseResult =
  | { readonly ok: true; readonly invocation: GhInvocation }
  | { readonly ok: false; readonly reason: string };

/** Upper bounds on what a single invocation may carry. */
export const MAX_GH_ARGS = 64;
export const MAX_GH_ARG_LENGTH = 65_536;

interface ParsedFlags {
  /** Canonical long flag name to its values (booleans store `"true"`). */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

interface CommandSpec {
  /** Boolean flags, as `long` or `short|long` (e.g. `c|comments`). */
  readonly bool?: readonly string[];
  readonly effect: (parsed: ParsedFlags) => GhEffect;
  readonly maxPositionals: number;
  readonly minPositionals?: number;
  /** Flags that consume a value, as `long` or `short|long`. */
  readonly value?: readonly string[];
}

const forbidden = (reason: string): GhEffect => ({ kind: "forbidden", reason });
const READ: GhEffect = { kind: "read" };
const WRITE: GhEffect = { kind: "write" };

const JSON_FLAGS = ["json", "q|jq", "t|template"] as const;

const [FACTORY_OWNER = "", FACTORY_NAME = ""] = FACTORY_REPO.split("/");

const NUMBER_PATTERN = /^#?(\d{1,10})$/;
const THREAD_URL_PATTERN =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d{1,10})(?:[/?#].*)?$/i;
const REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,200}[A-Za-z0-9])?$/;

const sameRepo = (owner: string, name: string): boolean =>
  owner.toLowerCase() === FACTORY_OWNER.toLowerCase() &&
  name.toLowerCase() === FACTORY_NAME.toLowerCase();

/**
 * Resolves an issue or pull request selector to its number.
 *
 * @returns The number, `null` for a selector that is valid but not a number
 * (a branch name on `gh pr ...`), or a refusal string.
 */
const threadNumber = (
  selector: string | undefined,
  allowBranch: boolean
): number | null | string => {
  if (selector === undefined) {
    return null;
  }
  const [, plain] = selector.match(NUMBER_PATTERN) ?? [];
  if (plain !== undefined) {
    return Number(plain);
  }
  const [, owner, name, number] = selector.match(THREAD_URL_PATTERN) ?? [];
  if (owner !== undefined && name !== undefined && number !== undefined) {
    return sameRepo(owner, name)
      ? Number(number)
      : `"${selector}" is not on ${FACTORY_REPO}.`;
  }
  if (allowBranch && REF_PATTERN.test(selector) && !selector.includes("..")) {
    return null;
  }
  return `"${selector}" is not an issue or pull request number.`;
};

/** Validates the thread selector and returns `effect` or a refusal. */
const onThread = (
  parsed: ParsedFlags,
  allowBranch: boolean,
  effect: (thread: number | null) => GhEffect
): GhEffect => {
  const thread = threadNumber(parsed.positionals[0], allowBranch);
  return typeof thread === "string" ? forbidden(thread) : effect(thread);
};

const LABEL_FLAGS = new Set(["add-label", "remove-label"]);
const editEffect = (parsed: ParsedFlags, allowBranch: boolean): GhEffect =>
  onThread(parsed, allowBranch, () => {
    const names = [...parsed.flags.keys()];
    if (names.length === 0) {
      return forbidden("Pass at least one flag saying what to change.");
    }
    return names.every((name) => LABEL_FLAGS.has(name))
      ? { kind: "label" }
      : WRITE;
  });

const commentEffect = (parsed: ParsedFlags, allowBranch: boolean): GhEffect =>
  onThread(parsed, allowBranch, (thread) => {
    if (!(parsed.flags.has("body") || parsed.flags.has("body-file"))) {
      return forbidden(
        "Pass the comment with --body or --body-file; there is no editor here."
      );
    }
    return { kind: "comment", thread };
  });

const stateEffect = (parsed: ParsedFlags): GhEffect =>
  onThread(parsed, false, (thread) => ({
    commentThread: thread,
    kind: "state",
    withComment: parsed.flags.has("comment"),
  }));

const EDIT_VALUE_FLAGS = [
  "add-assignee",
  "remove-assignee",
  "add-label",
  "remove-label",
  "b|body",
  "F|body-file",
  "m|milestone",
  "t|title",
] as const;

const COMMENT_SPEC = (allowBranch: boolean): CommandSpec => ({
  bool: ["edit-last", "create-if-none"],
  effect: (parsed) => commentEffect(parsed, allowBranch),
  maxPositionals: 1,
  minPositionals: 1,
  value: ["b|body", "F|body-file"],
});

const API_HEADER_PATTERN = /^(accept|x-github-api-version)\s*:/i;
const API_PATH_UNSAFE = /\.\.|\/\/|%2e|%2f|%5c|\\/i;
const LEADING_SLASH = /^\//;

const apiEffect = (parsed: ParsedFlags): GhEffect => {
  const method = parsed.flags.get("method")?.[0] ?? "GET";
  if (method.toUpperCase() !== "GET") {
    return forbidden(
      "gh api is read-only here (GET). Use the matching gh subcommand to change something."
    );
  }
  for (const header of parsed.flags.get("header") ?? []) {
    if (!API_HEADER_PATTERN.test(header)) {
      return forbidden(
        "gh api accepts only Accept and X-GitHub-Api-Version headers."
      );
    }
  }
  const endpoint = (parsed.positionals[0] ?? "").replace(LEADING_SLASH, "");
  const [path = ""] = endpoint.split("?");
  if (API_PATH_UNSAFE.test(path)) {
    return forbidden(`"${endpoint}" is not a plain API path.`);
  }
  const [root, owner, name] = path.split("/");
  const targetsFactory =
    root === "repos" &&
    owner !== undefined &&
    name !== undefined &&
    ((owner === "{owner}" && name === "{repo}") || sameRepo(owner, name));
  return targetsFactory
    ? READ
    : forbidden(
        `gh api is limited to repos/${FACTORY_REPO}/... (or repos/{owner}/{repo}/...).`
      );
};

/**
 * The allowlist: every `gh` command the factory may run, the flags each one
 * accepts, and the effect it has. Interactive and browser flags (`--web`,
 * `--editor`) are left out on purpose, so is every destructive command
 * (`pr merge`, `repo delete`, `secret`, `auth`, `release create`, ...).
 */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  api: {
    bool: ["paginate", "slurp", "i|include", "silent"],
    effect: apiEffect,
    maxPositionals: 1,
    minPositionals: 1,
    value: ["X|method", "H|header", "q|jq", "t|template", "cache"],
  },
  "issue close": {
    effect: stateEffect,
    maxPositionals: 1,
    minPositionals: 1,
    value: ["c|comment", "r|reason", "duplicate-of"],
  },
  "issue comment": COMMENT_SPEC(false),
  "issue create": {
    effect: (parsed) =>
      parsed.flags.has("title") &&
      (parsed.flags.has("body") || parsed.flags.has("body-file"))
        ? WRITE
        : forbidden("Pass --title and --body (or --body-file)."),
    maxPositionals: 0,
    value: [
      "a|assignee",
      "b|body",
      "F|body-file",
      "l|label",
      "m|milestone",
      "t|title",
    ],
  },
  "issue edit": {
    bool: ["remove-milestone"],
    effect: (parsed) => editEffect(parsed, false),
    maxPositionals: 1,
    minPositionals: 1,
    value: EDIT_VALUE_FLAGS,
  },
  "issue list": {
    effect: () => READ,
    maxPositionals: 0,
    value: [
      "a|assignee",
      "A|author",
      "app",
      "l|label",
      "L|limit",
      "mention",
      "m|milestone",
      "S|search",
      "s|state",
      ...JSON_FLAGS,
    ],
  },
  "issue reopen": {
    effect: stateEffect,
    maxPositionals: 1,
    minPositionals: 1,
    value: ["c|comment"],
  },
  "issue status": { effect: () => READ, maxPositionals: 0, value: JSON_FLAGS },
  "issue view": {
    bool: ["c|comments"],
    effect: (parsed) => onThread(parsed, false, () => READ),
    maxPositionals: 1,
    minPositionals: 1,
    value: JSON_FLAGS,
  },
  "label create": {
    bool: ["f|force"],
    effect: () => WRITE,
    maxPositionals: 1,
    minPositionals: 1,
    value: ["c|color", "d|description"],
  },
  "label list": {
    effect: () => READ,
    maxPositionals: 0,
    value: ["L|limit", "S|search", "order", "sort", ...JSON_FLAGS],
  },
  "pr checks": {
    bool: ["required"],
    effect: (parsed) => onThread(parsed, true, () => READ),
    maxPositionals: 1,
    minPositionals: 1,
    value: JSON_FLAGS,
  },
  "pr close": {
    effect: (parsed) => onThread(parsed, true, () => WRITE),
    maxPositionals: 1,
    minPositionals: 1,
    value: ["c|comment"],
  },
  "pr comment": COMMENT_SPEC(true),
  "pr create": {
    bool: ["d|draft", "no-maintainer-edit"],
    effect: (parsed) => {
      if (
        !(
          parsed.flags.has("head") &&
          parsed.flags.has("title") &&
          (parsed.flags.has("body") || parsed.flags.has("body-file"))
        )
      ) {
        return forbidden(
          "Pass --head, --title, and --body (or --body-file); nothing is inferred from a checkout here."
        );
      }
      if (!parsed.flags.has("draft")) {
        return { kind: "ship" };
      }
      // Requesting people on a draft notifies them, which is a write of its own.
      return parsed.flags.has("reviewer") || parsed.flags.has("assignee")
        ? WRITE
        : { kind: "draft-pr" };
    },
    maxPositionals: 0,
    value: [
      "a|assignee",
      "B|base",
      "b|body",
      "F|body-file",
      "H|head",
      "l|label",
      "m|milestone",
      "r|reviewer",
      "t|title",
    ],
  },
  "pr diff": {
    bool: ["name-only", "patch"],
    effect: (parsed) => onThread(parsed, true, () => READ),
    maxPositionals: 1,
    minPositionals: 1,
    value: ["color"],
  },
  "pr edit": {
    bool: ["remove-milestone"],
    effect: (parsed) => editEffect(parsed, true),
    maxPositionals: 1,
    minPositionals: 1,
    value: [...EDIT_VALUE_FLAGS, "add-reviewer", "remove-reviewer", "B|base"],
  },
  "pr list": {
    bool: ["d|draft"],
    effect: () => READ,
    maxPositionals: 0,
    value: [
      "a|assignee",
      "A|author",
      "app",
      "B|base",
      "H|head",
      "l|label",
      "L|limit",
      "S|search",
      "s|state",
      ...JSON_FLAGS,
    ],
  },
  "pr ready": {
    bool: ["undo"],
    // Back to draft is a plain write; out of draft is the ship gate.
    effect: (parsed) =>
      onThread(parsed, true, () =>
        parsed.flags.has("undo") ? WRITE : { kind: "ship" }
      ),
    maxPositionals: 1,
    minPositionals: 1,
  },
  "pr reopen": {
    effect: (parsed) => onThread(parsed, true, () => WRITE),
    maxPositionals: 1,
    minPositionals: 1,
    value: ["c|comment"],
  },
  "pr status": {
    bool: ["c|conflict-status"],
    effect: () => READ,
    maxPositionals: 0,
    value: JSON_FLAGS,
  },
  "pr view": {
    bool: ["c|comments"],
    effect: (parsed) => onThread(parsed, true, () => READ),
    maxPositionals: 1,
    minPositionals: 1,
    value: JSON_FLAGS,
  },
  "release list": {
    bool: ["exclude-drafts", "exclude-pre-releases"],
    effect: () => READ,
    maxPositionals: 0,
    value: ["L|limit", "O|order", ...JSON_FLAGS],
  },
  "release view": {
    effect: () => READ,
    maxPositionals: 1,
    value: JSON_FLAGS,
  },
  "repo view": {
    effect: (parsed) => {
      const [target] = parsed.positionals;
      if (target === undefined) {
        return READ;
      }
      const [owner = "", name = ""] = target.split("/");
      return sameRepo(owner, name)
        ? READ
        : forbidden(`This factory only works on ${FACTORY_REPO}.`);
    },
    maxPositionals: 1,
    value: ["b|branch", ...JSON_FLAGS],
  },
  "run list": {
    bool: ["a|all"],
    effect: () => READ,
    maxPositionals: 0,
    value: [
      "b|branch",
      "c|commit",
      "created",
      "e|event",
      "L|limit",
      "s|status",
      "u|user",
      "w|workflow",
      ...JSON_FLAGS,
    ],
  },
  "run view": {
    bool: ["exit-status", "log", "log-failed", "v|verbose"],
    effect: () => READ,
    maxPositionals: 1,
    value: ["a|attempt", "j|job", ...JSON_FLAGS],
  },
  "workflow list": {
    bool: ["a|all"],
    effect: () => READ,
    maxPositionals: 0,
    value: ["L|limit", ...JSON_FLAGS],
  },
  "workflow view": {
    bool: ["y|yaml"],
    effect: () => READ,
    maxPositionals: 1,
    minPositionals: 1,
    value: ["r|ref"],
  },
};

/** Every command path the allowlist knows, for error messages and docs. */
export const GH_COMMANDS: readonly string[] = Object.keys(COMMANDS).sort();

/**
 * The long flags each allowlisted command accepts, besides `--repo`.
 *
 * @remarks
 * A read-only view of the allowlist, so the test suite can hold it against
 * the installed GitHub CLI's own help output and catch a flag that was
 * misremembered or has since been renamed.
 */
export const GH_COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(COMMANDS).map(([command, spec]) => [
      command,
      [...(spec.value ?? []), ...(spec.bool ?? [])]
        .map((entry) => entry.split("|").at(-1) ?? entry)
        .sort(),
    ])
  );

/** The short spelling each flag accepts, as `[short, long]` pairs per command. */
export const GH_COMMAND_SHORT_FLAGS: Readonly<
  Record<string, readonly (readonly [string, string])[]>
> = Object.fromEntries(
  Object.entries(COMMANDS).map(([command, spec]) => [
    command,
    [...(spec.value ?? []), ...(spec.bool ?? [])]
      .map((entry) => entry.split("|"))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([short, long]) => [short, long] as const),
  ])
);

interface FlagTable {
  readonly bool: ReadonlySet<string>;
  /** Short or long spelling (without dashes) to the canonical long name. */
  readonly names: ReadonlyMap<string, string>;
}

const flagTable = (spec: CommandSpec): FlagTable => {
  const names = new Map<string, string>();
  const bool = new Set<string>();
  const register = (entry: string, isBool: boolean) => {
    const parts = entry.split("|");
    const long = parts.at(-1) ?? entry;
    for (const part of parts) {
      names.set(part, long);
    }
    if (isBool) {
      bool.add(long);
    }
  };
  for (const entry of spec.value ?? []) {
    register(entry, false);
  }
  for (const entry of spec.bool ?? []) {
    register(entry, true);
  }
  return { bool, names };
};

const describeFlags = (spec: CommandSpec): string => {
  const entries = [...(spec.value ?? []), ...(spec.bool ?? [])].map((entry) => {
    const parts = entry.split("|");
    return `--${parts.at(-1)}`;
  });
  return entries.length === 0 ? "none" : entries.sort().join(", ");
};

const REPO_FLAGS = new Set(["-R", "--repo"]);
const GITHUB_URL_PREFIX = /^https:\/\/github\.com\//i;
const GIT_SUFFIX = /\.git$/;

const isFactoryRepoValue = (value: string): boolean => {
  const trimmed = value.replace(GITHUB_URL_PREFIX, "");
  const [owner = "", name = "", ...rest] = trimmed.split("/");
  return rest.length === 0 && sameRepo(owner, name.replace(GIT_SUFFIX, ""));
};

/**
 * Removes `-R/--repo` after checking it names the factory repository. The
 * runner pins the repository through the environment instead, so the flag is
 * never what decides where a command lands.
 */
const stripRepoFlag = (
  args: readonly string[]
): { args: string[] } | { reason: string } => {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    let value: string | undefined;
    if (REPO_FLAGS.has(arg)) {
      value = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--repo=")) {
      value = arg.slice("--repo=".length);
    } else {
      kept.push(arg);
      continue;
    }
    if (value === undefined || !isFactoryRepoValue(value)) {
      return { reason: `This factory only works on ${FACTORY_REPO}.` };
    }
  }
  return { args: kept };
};

interface FlagToken {
  /** The value glued on with `=`, or null when the flag stands alone. */
  readonly inline: string | null;
  /** The canonical long name. */
  readonly long: string;
}

/**
 * Resolves one `-x` / `--name` / `--name=value` token against the command's
 * flag table, or returns null when the command doesn't accept it.
 *
 * @remarks
 * A short flag is exactly one character and a long flag is more than one.
 * Clusters (`-cw`), glued short values (`-L5`), and a short name spelled
 * long (`--b`) all resolve to null rather than being guessed at.
 */
const readFlagToken = (arg: string, table: FlagTable): FlagToken | null => {
  const isLong = arg.startsWith("--");
  const body = arg.slice(isLong ? 2 : 1);
  const equals = isLong ? body.indexOf("=") : -1;
  const spelled = equals === -1 ? body : body.slice(0, equals);
  if (isLong === (spelled.length === 1)) {
    return null;
  }
  const long = table.names.get(spelled);
  return long === undefined
    ? null
    : { inline: equals === -1 ? null : body.slice(equals + 1), long };
};

type FlagValue =
  | { readonly consumed: 0 | 1; readonly value: string }
  | "unknown"
  | "missing";

/** Works out a flag's value, and whether it used up the next argument. */
const readFlagValue = (
  token: FlagToken,
  table: FlagTable,
  next: string | undefined
): FlagValue => {
  if (table.bool.has(token.long)) {
    return token.inline === null ? { consumed: 0, value: "true" } : "unknown";
  }
  if (token.inline !== null) {
    return { consumed: 0, value: token.inline };
  }
  return next === undefined ? "missing" : { consumed: 1, value: next };
};

const parseFlags = (
  command: string,
  spec: CommandSpec,
  rest: readonly string[]
): ParsedFlags | string => {
  const table = flagTable(spec);
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const unknown = (arg: string) =>
    `gh ${command} does not accept ${arg} here. Allowed flags: ${describeFlags(spec)}. Pass each flag and its value as separate arguments.`;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--") {
      return `gh ${command} does not accept "--" here.`;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const token = readFlagToken(arg, table);
    const read =
      token === null ? "unknown" : readFlagValue(token, table, rest[index + 1]);
    if (token === null || read === "unknown") {
      return unknown(arg);
    }
    if (read === "missing") {
      return `gh ${command}: ${arg} needs a value.`;
    }
    flags.set(token.long, [...(flags.get(token.long) ?? []), read.value]);
    index += read.consumed;
  }
  if (positionals.length > spec.maxPositionals) {
    return `gh ${command} takes at most ${spec.maxPositionals} positional argument(s).`;
  }
  if (positionals.length < (spec.minPositionals ?? 0)) {
    return `gh ${command} needs ${spec.minPositionals} positional argument(s), like an issue or pull request number.`;
  }
  return { flags, positionals };
};

const checkShape = (args: readonly string[]): string | null => {
  if (args.length === 0) {
    return 'Pass a gh command, like ["issue", "view", "12"].';
  }
  if (args.length > MAX_GH_ARGS) {
    return `Too many arguments (limit ${MAX_GH_ARGS}).`;
  }
  for (const arg of args) {
    if (arg.length > MAX_GH_ARG_LENGTH) {
      return `An argument is too long (limit ${MAX_GH_ARG_LENGTH} characters). Write long text to a file and pass --body-file.`;
    }
    if (arg.includes("\0")) {
      return "Arguments cannot contain NUL bytes.";
    }
  }
  return null;
};

/**
 * Parses a `gh` argv against the allowlist.
 *
 * @param argv - The arguments after `gh` (a leading `gh` is tolerated).
 * @returns The normalized invocation and its effect, or the reason it is
 * refused. Refusal reasons are written for the model: they say what would
 * work instead.
 */
export const parseGh = (argv: readonly string[]): GhParseResult => {
  const withoutBinary = argv[0] === "gh" ? argv.slice(1) : argv;
  const shape = checkShape(withoutBinary);
  if (shape) {
    return { ok: false, reason: shape };
  }
  const stripped = stripRepoFlag(withoutBinary);
  if ("reason" in stripped) {
    return { ok: false, reason: stripped.reason };
  }
  const [first = "", second = ""] = stripped.args;
  const pair = `${first} ${second}`;
  let command: string;
  if (Object.hasOwn(COMMANDS, pair)) {
    command = pair;
  } else if (Object.hasOwn(COMMANDS, first)) {
    command = first;
  } else {
    return {
      ok: false,
      reason: `gh ${[first, second].filter(Boolean).join(" ")} is not available to the factory. Available: ${GH_COMMANDS.join(", ")}.`,
    };
  }
  const spec = COMMANDS[command] as CommandSpec;
  const commandLength = command.split(" ").length;
  const parsed = parseFlags(command, spec, stripped.args.slice(commandLength));
  if (typeof parsed === "string") {
    return { ok: false, reason: parsed };
  }
  const effect = spec.effect(parsed);
  if (effect.kind === "forbidden") {
    return { ok: false, reason: effect.reason };
  }
  // `gh repo view` with no argument describes the repository of the current
  // directory, which depends on where the command happens to run. Naming the
  // repository keeps the command's meaning independent of any checkout.
  const args =
    command === "repo view" && parsed.positionals.length === 0
      ? [...stripped.args, FACTORY_REPO]
      : stripped.args;
  return {
    invocation: { args, command, effect },
    ok: true,
  };
};

/**
 * Quotes one argument for a POSIX shell.
 *
 * @remarks
 * Sandbox commands are shell strings, and `gh` arguments carry
 * model-written prose (comment and pull request bodies). Single quotes make
 * every character literal; the only character that needs care is the single
 * quote itself.
 */
export const shellQuote = (arg: string): string =>
  `'${arg.replaceAll("'", "'\\''")}'`;

/**
 * Environment every `gh` invocation runs with, besides the per-call
 * placeholder token the runner adds.
 *
 * @remarks
 * `GH_REPO` pins the repository, so the command lands on the factory
 * repository even though no flag says so. The fixed `PATH` keeps a
 * model-writable directory from shadowing a binary `gh` shells out to.
 */
export const GH_ENVIRONMENT: Readonly<Record<string, string>> = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  GH_REPO: FACTORY_REPO,
  NO_COLOR: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
};

/** Where the sandbox image's package manager installs the GitHub CLI. */
export const GH_BINARY = "/usr/bin/gh";

/** Renders the shell command for a validated argv. */
export const ghCommandLine = (args: readonly string[]): string =>
  [GH_BINARY, ...args.map(shellQuote)].join(" ");

/** Commands whose `-b/--body` flag carries free text (not a branch). */
const BODY_COMMANDS = new Set([
  "issue comment",
  "issue create",
  "issue edit",
  "pr comment",
  "pr create",
  "pr edit",
]);

export interface BodyFile {
  readonly content: string;
  readonly path: string;
}

/**
 * Moves every `--body` value into a file and passes `--body-file` instead.
 *
 * @remarks
 * Bodies are the longest and least predictable strings the factory hands to
 * a shell: pull request descriptions and comments written by a model from
 * untrusted issue text. Sending them as files keeps them off the command
 * line entirely, which sidesteps both the kernel's argument-size limit and
 * any doubt about quoting.
 *
 * @param pathFor - Names the file for the nth body.
 */
export const bodiesToFiles = (
  invocation: GhInvocation,
  pathFor: (index: number) => string
): { args: string[]; files: BodyFile[] } => {
  if (!BODY_COMMANDS.has(invocation.command)) {
    return { args: [...invocation.args], files: [] };
  }
  const args: string[] = [];
  const files: BodyFile[] = [];
  const add = (content: string) => {
    const path = pathFor(files.length);
    files.push({ content, path });
    args.push("--body-file", path);
  };
  for (let index = 0; index < invocation.args.length; index += 1) {
    const arg = invocation.args[index] ?? "";
    if (arg === "-b" || arg === "--body") {
      add(invocation.args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--body=")) {
      add(arg.slice("--body=".length));
    } else {
      args.push(arg);
    }
  }
  return { args, files };
};
