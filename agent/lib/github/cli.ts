import { FACTORY_REPO } from "../constants.js";

/**
 * What a `gh` invocation does to the repository, as far as authorization is
 * concerned.
 *
 * @remarks
 * A station runs `gh` in its shell under a read-only credential, so only
 * reads work there. The orchestrator has no shell: its whole `bash` command
 * must be a list of `gh` commands with literal words
 * (`agent/lib/github/shell.ts`). Each command's words are parsed against the
 * allowlist in this module and reduced to one effect, and
 * `agent/lib/github/approval.ts` maps the effect and the caller's trust
 * class to run / park / deny. The runtime then runs the parsed words itself,
 * a write under a credential that can write issues and pull requests, so
 * this parse is what stands between the model and that credential. Anything
 * the allowlist doesn't name is `forbidden`, including every flag it doesn't
 * name, so a new `gh` feature is unreachable until someone decides what it
 * is.
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

/** Where a `--body` value sits in a validated argv. */
export interface BodyArgument {
  /** Index in `args` of the flag token (`--body`, `-b`, or `--body=...`). */
  readonly at: number;
  readonly content: string;
  /** How many argv elements the flag and its value take up: 1 or 2. */
  readonly span: 1 | 2;
}

/** A validated `gh` invocation, ready to hand to the sandbox. */
export interface GhInvocation {
  /** Normalized argv without the leading `gh` and without `--repo`. */
  readonly args: readonly string[];
  /**
   * The `--body` arguments, located by the same pass that validated the
   * argv. Anything that rewrites the argv works from these positions, never
   * from a second reading of the tokens.
   */
  readonly bodies: readonly BodyArgument[];
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

interface FlagOccurrence {
  /** Index of the flag token among the arguments after the command path. */
  readonly index: number;
  readonly long: string;
  readonly span: 1 | 2;
  readonly value: string;
}

interface ParsedFlags {
  /** Canonical long flag name to its values (booleans store `"true"`). */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  /** Every flag as it appeared, in order. */
  readonly occurrences: readonly FlagOccurrence[];
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
    if (!parsed.flags.has("body")) {
      return forbidden(
        "Pass the comment text with --body; there is no editor here."
      );
    }
    return { kind: "comment", thread };
  });

const stateEffect = (parsed: ParsedFlags): GhEffect =>
  onThread(parsed, false, (thread) => {
    for (const original of parsed.flags.get("duplicate-of") ?? []) {
      const resolved = threadNumber(original, false);
      if (typeof resolved === "string") {
        return forbidden(resolved);
      }
    }
    return {
      commentThread: thread,
      kind: "state",
      withComment: parsed.flags.has("comment"),
    };
  });

const EDIT_VALUE_FLAGS = [
  "add-assignee",
  "remove-assignee",
  "add-label",
  "remove-label",
  "b|body",
  "m|milestone",
  "t|title",
] as const;

const COMMENT_SPEC = (allowBranch: boolean): CommandSpec => ({
  bool: ["edit-last", "create-if-none"],
  effect: (parsed) => commentEffect(parsed, allowBranch),
  maxPositionals: 1,
  minPositionals: 1,
  value: ["b|body"],
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

const SEARCH_SCOPE_QUALIFIER = /(?:^|\s|\()-?(?:repo|org|user|owner):/i;
const NUMERIC_ID = /^\d{1,20}$/;
const WORKFLOW_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * A read that lists or searches. `gh` scopes the search to the factory
 * repository by adding its own `repo:` qualifier; a second one in the query
 * would widen the search to wherever it points, so qualifiers that choose a
 * repository or an owner are refused.
 */
const listEffect = (parsed: ParsedFlags): GhEffect => {
  for (const query of parsed.flags.get("search") ?? []) {
    if (SEARCH_SCOPE_QUALIFIER.test(query)) {
      return forbidden(
        `Searches stay inside ${FACTORY_REPO}; leave out repo:, org:, user:, and owner: qualifiers.`
      );
    }
  }
  return READ;
};

/** Accepts a selector only when it matches `pattern`; a missing one is fine. */
const selectorEffect =
  (pattern: RegExp, what: string) =>
  (parsed: ParsedFlags): GhEffect => {
    const [selector] = parsed.positionals;
    return selector === undefined || pattern.test(selector)
      ? READ
      : forbidden(`"${selector}" is not ${what}.`);
  };

const runViewEffect = (parsed: ParsedFlags): GhEffect => {
  for (const flag of ["job", "attempt"]) {
    for (const value of parsed.flags.get(flag) ?? []) {
      if (!NUMERIC_ID.test(value)) {
        return forbidden(`--${flag} takes a number.`);
      }
    }
  }
  return selectorEffect(NUMERIC_ID, "a run id")(parsed);
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
      parsed.flags.has("title") && parsed.flags.has("body")
        ? WRITE
        : forbidden("Pass --title and --body."),
    maxPositionals: 0,
    value: ["a|assignee", "b|body", "l|label", "m|milestone", "t|title"],
  },
  "issue edit": {
    bool: ["remove-milestone"],
    effect: (parsed) => editEffect(parsed, false),
    maxPositionals: 1,
    minPositionals: 1,
    value: EDIT_VALUE_FLAGS,
  },
  "issue list": {
    effect: listEffect,
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
    effect: listEffect,
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
          parsed.flags.has("body")
        )
      ) {
        return forbidden(
          "Pass --head, --title, and --body; nothing is inferred from a checkout here."
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
    effect: listEffect,
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
    effect: (parsed) => {
      const [tag] = parsed.positionals;
      return tag === undefined || (REF_PATTERN.test(tag) && !tag.includes(".."))
        ? READ
        : forbidden(`"${tag}" is not a release tag.`);
    },
    maxPositionals: 1,
    value: JSON_FLAGS,
  },
  "repo view": {
    effect: (parsed) => {
      const [target] = parsed.positionals;
      if (target === undefined) {
        return READ;
      }
      return isFactoryRepoValue(target)
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
    effect: runViewEffect,
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
    effect: selectorEffect(WORKFLOW_SELECTOR, "a workflow id or file name"),
    maxPositionals: 1,
    minPositionals: 1,
    value: ["r|ref"],
  },
};

/** Every command path the allowlist knows, for error messages and docs. */
export const GH_COMMANDS: readonly string[] = Object.keys(COMMANDS).sort();

/**
 * The commands that change something on GitHub, whatever their arguments.
 *
 * @remarks
 * Every other command in the allowlist only reads. The sandbox's `gh`
 * wrapper uses the list to send a write back to the caller with the form
 * that works, before it reaches GitHub (`agent/lib/github/shims.ts`).
 * `tests/github/gh-cli.test.ts` holds it against the effects the parser
 * reports.
 */
export const GH_WRITE_COMMANDS: readonly string[] = [
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
];

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

/**
 * The short spelling each flag accepts, as `[short, long]` pairs per
 * command.
 */
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

/**
 * Whether each flag takes a value (`"value"`) or is a switch (`"bool"`), per
 * command.
 *
 * @remarks
 * The parser decides from this whether the next argument belongs to a flag.
 * A flag recorded under the wrong kind would make the parser read the
 * arguments differently from the GitHub CLI, so the test suite holds this
 * against the CLI's help as well.
 */
export const GH_COMMAND_FLAG_KINDS: Readonly<
  Record<string, Readonly<Record<string, "bool" | "value">>>
> = Object.fromEntries(
  Object.entries(COMMANDS).map(([command, spec]) => [
    command,
    Object.fromEntries([
      ...(spec.value ?? []).map(
        (entry) => [entry.split("|").at(-1) ?? entry, "value"] as const
      ),
      ...(spec.bool ?? []).map(
        (entry) => [entry.split("|").at(-1) ?? entry, "bool"] as const
      ),
    ]),
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

const REPO_REFUSAL = `This factory only works on ${FACTORY_REPO}.`;

/**
 * Reads a `-R/--repo` flag at `args[index]`.
 *
 * @returns How many arguments the flag takes up, 0 when `args[index]` is not
 * a repository flag, or the refusal when it names another repository.
 */
const readRepoFlag = (
  args: readonly string[],
  index: number
): 0 | 1 | 2 | { reason: string } => {
  const arg = args[index] ?? "";
  let value: string | undefined;
  let span: 1 | 2;
  if (REPO_FLAGS.has(arg)) {
    value = args[index + 1];
    span = 2;
  } else if (arg.startsWith("--repo=")) {
    value = arg.slice("--repo=".length);
    span = 1;
  } else {
    return 0;
  }
  return value === undefined || !isFactoryRepoValue(value)
    ? { reason: REPO_REFUSAL }
    : span;
};

/**
 * Removes `-R/--repo` from the words before and between the command path,
 * after checking it names the factory repository.
 *
 * @remarks
 * `gh` accepts the flag anywhere, including ahead of the command
 * (`gh -R owner/repo pr view 3`). No flag that takes a value can come before
 * the command path is complete, so here a word that looks like the flag is
 * the flag. The scan stops at the second plain word or at any other flag;
 * what follows is read by {@link stripRepoFlagFromRest}, which knows the
 * command's flags.
 */
const stripLeadingRepoFlag = (
  args: readonly string[]
): { args: string[] } | { reason: string } => {
  const kept: string[] = [];
  let words = 0;
  let index = 0;
  while (index < args.length && words < 2) {
    const span = readRepoFlag(args, index);
    if (typeof span === "object") {
      return span;
    }
    if (span > 0) {
      index += span;
      continue;
    }
    const arg = args[index] ?? "";
    if (arg.startsWith("-")) {
      break;
    }
    kept.push(arg);
    words += 1;
    index += 1;
  }
  return { args: [...kept, ...args.slice(index)] };
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

const positionalRefusal = (
  command: string,
  spec: CommandSpec,
  count: number
): string | null => {
  if (count > spec.maxPositionals) {
    return `gh ${command} takes at most ${spec.maxPositionals} positional argument(s).`;
  }
  if (count < (spec.minPositionals ?? 0)) {
    return `gh ${command} needs ${spec.minPositionals} positional argument(s), like an issue or pull request number.`;
  }
  return null;
};

/**
 * Flags that may be given more than once, because `gh` adds their values
 * together.
 *
 * @remarks
 * Every other flag is refused the second time it appears. For a
 * single-valued flag `gh` keeps the last occurrence, so a check that looked
 * at the first one would approve one command and run another: with
 * `--method GET --method PUT`, the request that goes out is a PUT.
 */
const REPEATABLE_FLAGS = new Set([
  "add-assignee",
  "add-label",
  "add-reviewer",
  "assignee",
  "header",
  "label",
  "remove-assignee",
  "remove-label",
  "remove-reviewer",
  "reviewer",
]);

/**
 * Reads the flag at `rest[index]`, with its value when it takes one.
 *
 * @returns Where the flag sits and what it carries, or the refusal.
 */
const readFlag = (
  command: string,
  spec: CommandSpec,
  table: FlagTable,
  rest: readonly string[],
  index: number
): FlagOccurrence | string => {
  const arg = rest[index] ?? "";
  const token = readFlagToken(arg, table);
  const read =
    token === null ? "unknown" : readFlagValue(token, table, rest[index + 1]);
  if (token === null || read === "unknown") {
    return `gh ${command} does not accept ${arg} here. Allowed flags: ${describeFlags(spec)}. Pass each flag and its value as separate arguments.`;
  }
  if (read === "missing") {
    return `gh ${command}: ${arg} needs a value.`;
  }
  return {
    index,
    long: token.long,
    span: read.consumed === 1 ? 2 : 1,
    value: read.value,
  };
};

/**
 * Removes `-R/--repo` from the arguments after the command path, after
 * checking it names the factory repository. The runner pins the repository
 * through the environment instead, so the flag never decides where a
 * command lands.
 *
 * @remarks
 * The scan knows which of the command's flags take a value and steps over
 * each value unread. Without that, text that happens to read `--repo=...`
 * (a comment body, a title) would be taken for the flag and removed, and
 * the flag before it would take the next word as its value instead: a
 * `--body` followed by `--draft` would swallow the `--draft`.
 */
const stripRepoFlagFromRest = (
  table: FlagTable,
  rest: readonly string[]
): { rest: string[] } | { reason: string } => {
  const kept: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index] ?? "";
    const span = readRepoFlag(rest, index);
    if (typeof span === "object") {
      return span;
    }
    if (span > 0) {
      index += span;
      continue;
    }
    kept.push(arg);
    index += 1;
    const token =
      arg.startsWith("-") && arg !== "-" && arg !== "--"
        ? readFlagToken(arg, table)
        : null;
    const read =
      token === null ? null : readFlagValue(token, table, rest[index]);
    if (read !== null && typeof read === "object" && read.consumed === 1) {
      kept.push(rest[index] ?? "");
      index += 1;
    }
  }
  return { rest: kept };
};

const parseFlags = (
  command: string,
  spec: CommandSpec,
  rest: readonly string[]
): ParsedFlags | string => {
  const table = flagTable(spec);
  const flags = new Map<string, string[]>();
  const occurrences: FlagOccurrence[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--") {
      return `gh ${command} does not accept "--" here.`;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const flag = readFlag(command, spec, table, rest, index);
    if (typeof flag === "string") {
      return flag;
    }
    const earlier = flags.get(flag.long);
    if (earlier !== undefined && !REPEATABLE_FLAGS.has(flag.long)) {
      return `gh ${command}: pass --${flag.long} once.`;
    }
    flags.set(flag.long, [...(earlier ?? []), flag.value]);
    occurrences.push(flag);
    index += flag.span - 1;
  }
  return (
    positionalRefusal(command, spec, positionals.length) ?? {
      flags,
      occurrences,
      positionals,
    }
  );
};

const checkShape = (args: readonly string[]): string | null => {
  if (args.length === 0) {
    return "Pass a gh command, like gh issue view 12.";
  }
  if (args.length > MAX_GH_ARGS) {
    return `Too many arguments (limit ${MAX_GH_ARGS}).`;
  }
  for (const arg of args) {
    if (arg.length > MAX_GH_ARG_LENGTH) {
      return `An argument is too long (limit ${MAX_GH_ARG_LENGTH} characters). Shorten it.`;
    }
    if (arg.includes("\0")) {
      return "Arguments cannot contain NUL bytes.";
    }
  }
  return null;
};

/**
 * Parses the words of one `gh` command against the allowlist.
 *
 * @remarks
 * The words come from the shell lexer (`analyzeCommand` in `shell.ts`), which
 * hands over literal words only, or from the factory's own code (the triage
 * and CI tools). The allowlist itself never accepts `--body-file`: when a
 * caller passes one, `inlineBodyFiles` in `shell.ts` turns it into `--body`
 * before the words arrive here, and the runtime reads the file's text into
 * it.
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
  const leading = stripLeadingRepoFlag(withoutBinary);
  if ("reason" in leading) {
    return { ok: false, reason: leading.reason };
  }
  const [first = "", second = ""] = leading.args;
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
  const rest = stripRepoFlagFromRest(
    flagTable(spec),
    leading.args.slice(commandLength)
  );
  if ("reason" in rest) {
    return { ok: false, reason: rest.reason };
  }
  const stripped = {
    args: [...leading.args.slice(0, commandLength), ...rest.rest],
  };
  const parsed = parseFlags(command, spec, rest.rest);
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
  const bodies = parsed.occurrences
    .filter((occurrence) => occurrence.long === "body")
    .map((occurrence) => ({
      at: commandLength + occurrence.index,
      content: occurrence.value,
      span: occurrence.span,
    }));
  return {
    invocation: { args, bodies, command, effect },
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
 * `PATH` for a command the runtime runs itself under a lease.
 *
 * @remarks
 * `gh` shells out to `git`, and `git` to its helpers. This points those
 * lookups at the image's own directories and past the sandbox's `gh` and
 * `git` wrappers in `/usr/local/bin`, which are for the agent's shell. It is
 * a default, not a guarantee: the sandbox runs commands through a login
 * shell, whose start-up files the agent can write.
 */
export const RUNNER_PATH = "/usr/bin:/bin";

/**
 * Environment every `gh` invocation runs with, besides the per-call
 * placeholder token the runner adds.
 *
 * @remarks
 * `GH_REPO` pins the repository, so the command lands on the factory
 * repository even though no flag says so. `PATH` is {@link RUNNER_PATH}.
 */
export const GH_ENVIRONMENT: Readonly<Record<string, string>> = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  GH_REPO: FACTORY_REPO,
  NO_COLOR: "1",
  PATH: RUNNER_PATH,
};

/** Where the sandbox image's package manager installs the GitHub CLI. */
export const GH_BINARY = "/usr/bin/gh";

/** Renders the shell command for a validated argv. */
export const ghCommandLine = (args: readonly string[]): string =>
  [GH_BINARY, ...args.map(shellQuote)].join(" ");

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
 * The rewrite works from the positions the parser recorded
 * ({@link GhInvocation.bodies}), so the command that runs is the command
 * that was classified and approved, token for token, with only the body
 * arguments swapped. The allowlist never accepts `--body-file` (see
 * {@link parseGh}), so the only one that reaches `gh` is the one written
 * here, pointing at a file this function named.
 *
 * @param pathFor - Names the file for the nth body.
 * @returns The argv with each body swapped for `--body-file <path>`, and
 * the files to write before it runs.
 */
export const bodiesToFiles = (
  invocation: GhInvocation,
  pathFor: (index: number) => string
): { args: string[]; files: BodyFile[] } => {
  const files: BodyFile[] = [];
  const args: string[] = [];
  let next = 0;
  for (const body of [...invocation.bodies].sort((a, b) => a.at - b.at)) {
    args.push(...invocation.args.slice(next, body.at));
    const path = pathFor(files.length);
    files.push({ content: body.content, path });
    args.push("--body-file", path);
    next = body.at + body.span;
  }
  args.push(...invocation.args.slice(next));
  return { args, files };
};
