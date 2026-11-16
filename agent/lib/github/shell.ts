/**
 * Reads a `bash` command for the `gh` and `git` commands it runs.
 *
 * @remarks
 * What a command may do on GitHub depends on who is asking, and a shell
 * string can hide a command anywhere (a pipe, a script, a variable), so the
 * factory does not try to judge arbitrary shell. It sorts every command
 * into one of four kinds and gives each kind a credential that fits (how
 * each kind is run is in `tools.ts`):
 *
 * - `plain`: nothing that talks to GitHub. Runs with no credential.
 * - `shell`: names `gh` or a networked `git` command somewhere, in any shape.
 *   Runs in the shell with a read-only credential, so whatever is inside, it
 *   can read the factory repository and change nothing.
 * - `gh`: the whole command is a list of `gh` commands with literal
 *   arguments. Only this shape can be parsed against the allowlist, checked
 *   against the caller's trust class, and given a credential that can write.
 * - `push`: the whole command is one `git push`. Only this shape can get the
 *   credential that writes repository contents.
 *
 * The lexer here is deliberately narrow. It accepts the quoting a model
 * writes for literal text and nothing that makes a shell compute a value.
 * A command it does not fully understand is `shell`, never an error: that is
 * the safe side, since `shell` cannot write.
 *
 * A `gh` or `push` command is run from the words parsed here, not handed
 * back to a shell, so a difference between this lexer and bash can never
 * turn an approved command into a different one.
 */

/** One `gh` command in a list, as the words after `gh`. */
export interface GhStep {
  /**
   * How the step follows the one before it: `&&` runs it only when that one
   * succeeded, `;` (or a new line) runs it regardless.
   */
  readonly after: "&&" | ";";
  readonly argv: readonly string[];
}

export type ShellAnalysis =
  | { readonly kind: "plain" }
  | { readonly kind: "shell" }
  | { readonly kind: "gh"; readonly steps: readonly GhStep[] }
  | {
      readonly kind: "push";
      /** The words after `push`. */
      readonly args: readonly string[];
      /** The directory named with `cd` or `git -C`, when there was one. */
      readonly directory: string | null;
    };

interface SimpleCommand {
  readonly after: "&&" | ";";
  readonly words: readonly string[];
}

/** Longest command the lexer will read; anything longer is `shell`. */
export const MAX_ANALYZED_LENGTH = 200_000;

const UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+/;
const BLANK = /^(?:[ \t]|\\\n)+/;
const CONTINUATION = "\\\n";
const HEREDOC_OPEN = /^"\$\(cat <<(['"])([A-Za-z_][A-Za-z0-9_]*)\1\n/;
const HEREDOC_CLOSE = /^\n?[ \t]*\)"/;
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"]);
const TRAILING_NEWLINES = /\n+$/;

/**
 * Reads a `"$(cat <<'EOF' ... EOF)"` word, the way a model passes text with
 * several lines to a flag. The delimiter must be quoted, which is what makes
 * the text literal in a real shell too.
 *
 * @returns The text and where the word ends, or null when the word at `at`
 * is not a complete heredoc of that form.
 */
const readHeredoc = (
  source: string,
  at: number
): { end: number; value: string } | null => {
  const open = source.slice(at, at + 80).match(HEREDOC_OPEN);
  if (!open) {
    return null;
  }
  const delimiter = open[2] ?? "";
  const bodyStart = at + open[0].length;
  // The heredoc ends at the first line that is exactly the delimiter.
  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (line === delimiter) {
      const close = source
        .slice(lineStart + delimiter.length)
        .match(HEREDOC_CLOSE);
      if (!close) {
        return null;
      }
      const body =
        lineStart === bodyStart ? "" : source.slice(bodyStart, lineStart - 1);
      return {
        end: lineStart + delimiter.length + close[0].length,
        // Command substitution drops the newlines at the end of its output.
        value: body.replace(TRAILING_NEWLINES, ""),
      };
    }
    if (lineEnd === -1) {
      return null;
    }
    lineStart = lineEnd + 1;
  }
  return null;
};

const readSingleQuoted = (
  source: string,
  at: number
): { end: number; value: string } | null => {
  const close = source.indexOf("'", at + 1);
  return close === -1
    ? null
    : { end: close + 1, value: source.slice(at + 1, close) };
};

const readDoubleQuoted = (
  source: string,
  at: number
): { end: number; value: string } | null => {
  let value = "";
  let index = at + 1;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === '"') {
      return { end: index + 1, value };
    }
    // A shell would compute these; a literal argument never needs them.
    if (character === "$" || character === "`") {
      return null;
    }
    if (character === "\\") {
      const next = source[index + 1] ?? "";
      if (next === "\n") {
        index += 2;
        continue;
      }
      if (DOUBLE_QUOTE_ESCAPES.has(next)) {
        value += next;
        index += 2;
        continue;
      }
    }
    value += character;
    index += 1;
  }
  return null;
};

/** Reads one piece of a word at `at`, or null when the text is not literal. */
const readPiece = (
  source: string,
  at: number
): { end: number; value: string } | null => {
  const character = source[at] ?? "";
  if (character === "'") {
    return readSingleQuoted(source, at);
  }
  if (character === '"') {
    return readHeredoc(source, at) ?? readDoubleQuoted(source, at);
  }
  if (character === "\\") {
    // Outside quotes a backslash makes the next character literal. (Before
    // a new line it is a continuation, which the callers have dealt with.)
    const next = source[at + 1];
    return next === undefined || next === "\n"
      ? null
      : { end: at + 2, value: next };
  }
  const [plain] = source.slice(at, at + 4096).match(UNQUOTED) ?? [];
  return plain === undefined ? null : { end: at + plain.length, value: plain };
};

const isWordBreak = (character: string): boolean =>
  character === "" ||
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === ";" ||
  character === "&";

/** Reads one whole word (adjacent pieces run together) starting at `at`. */
const readWord = (
  source: string,
  at: number
): { end: number; value: string } | null => {
  let value = "";
  let index = at;
  while (!isWordBreak(source[index] ?? "")) {
    // A backslash before a new line joins the two lines, as in a shell.
    if (source.startsWith(CONTINUATION, index)) {
      index += CONTINUATION.length;
      continue;
    }
    const piece = readPiece(source, index);
    if (!piece) {
      return null;
    }
    value += piece.value;
    index = piece.end;
  }
  return { end: index, value };
};

/** How many characters of blank space (or line continuation) start at `at`. */
const blankLength = (source: string, at: number): number => {
  const [blank = ""] = source.slice(at, at + 4096).match(BLANK) ?? [];
  return blank.length;
};

/** The list operator at `at`: `;`, `&&`, or null for a lone `&`. */
const joinerAt = (source: string, at: number): "&&" | ";" | null => {
  if (source[at] === ";") {
    return ";";
  }
  return source.startsWith("&&", at) ? "&&" : null;
};

/**
 * Splits a command into simple commands of literal words.
 *
 * @returns The commands, or null when the text uses anything beyond literal
 * words joined by `&&`, `;`, or new lines: a pipe, a redirect, a variable, a
 * substitution, a glob, a comment. Null too for a list a shell would
 * reject, such as `;` or `&&` with no command before it. A `NAME=value`
 * prefix is not caught here: it reads as a word, and `analyzeCommand`
 * sorts it out.
 */
export const lexLiteralCommands = (
  source: string
): readonly SimpleCommand[] | null => {
  if (source.length > MAX_ANALYZED_LENGTH || source.includes("\0")) {
    return null;
  }
  const commands: SimpleCommand[] = [];
  // Held in one object because `finish` changes both between words.
  const pending: { after: "&&" | ";"; words: string[] } = {
    after: ";",
    words: [],
  };
  /** Ends the command being read. False when there is none to end. */
  const finish = (next: "&&" | ";"): boolean => {
    if (pending.words.length === 0) {
      return false;
    }
    commands.push({ after: pending.after, words: pending.words });
    pending.words = [];
    pending.after = next;
    return true;
  };
  let index = 0;
  while (index < source.length) {
    const blank = blankLength(source, index);
    if (blank > 0) {
      index += blank;
      continue;
    }
    const character = source[index] ?? "";
    if (character === "\n") {
      // A new line ends a command. With none to end it is an empty line,
      // which a shell also allows after `&&`, where the list carries on.
      finish(";");
      index += 1;
      continue;
    }
    if (character === ";" || character === "&") {
      const joiner = joinerAt(source, index);
      if (!(joiner && finish(joiner))) {
        return null;
      }
      index += joiner.length;
      continue;
    }
    const word = readWord(source, index);
    if (!word) {
      return null;
    }
    pending.words.push(word.value);
    index = word.end;
  }
  finish(";");
  // A list may end with `;` or a new line, never with `&&`.
  return pending.after === "&&" ? null : commands;
};

const NAMES_GH = /(?:^|[^\w./-])gh(?:[^\w-]|$)/;
const GIT_WORD = /(?:^|[^\w./-])git(?=\s)/;
const SEGMENT_END = /[;|&\n]/;
const NETWORK_SUBCOMMAND =
  /(?:^|\s)(?:fetch|pull|push|clone|ls-remote)(?:[^\w-]|$)/;

/**
 * Whether some command in the text has a `git` followed, before that
 * command ends, by the name of a subcommand that talks to a remote.
 *
 * @remarks
 * The text is cut at every `;`, `|`, `&`, and new line, and each piece is
 * looked at once: is there a `git`, and after the first one, one of the
 * names. That does not work out which word is the subcommand, so it is
 * right about `git -C 'my repo' fetch` and `git --git-dir .git fetch`, and
 * wrong in the harmless direction (see {@link namesGitHub}) about
 * `git commit -m "fetch fix"`. It is one pass over the text, whatever the
 * text is.
 */
const namesGitNetwork = (command: string): boolean =>
  command.split(SEGMENT_END).some((segment) => {
    const at = segment.search(GIT_WORD);
    return at !== -1 && NETWORK_SUBCOMMAND.test(segment.slice(at));
  });

/**
 * Whether a command names `gh` or a `git` command that talks to a remote.
 *
 * @remarks
 * Deliberately loose. A false yes costs one read-only credential the command
 * does not use; a false no means the command runs without a credential and
 * the `gh` or `git` wrapper in the sandbox says so.
 */
export const namesGitHub = (command: string): boolean =>
  NAMES_GH.test(command) || namesGitNetwork(command);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Reads a list that is nothing but one `git <subcommand>`, optionally after
 * `cd <dir> &&` or with `git -C <dir>`.
 *
 * @returns The words after the subcommand and the directory named, or null
 * when the list is any other shape.
 */
const gitCommandOf = (
  commands: readonly SimpleCommand[],
  subcommand: string
): { args: readonly string[]; directory: string | null } | null => {
  let directory: string | null = null;
  let rest = commands;
  const [first, second] = commands;
  if (
    first?.words[0] === "cd" &&
    first.words.length === 2 &&
    second?.after === "&&"
  ) {
    directory = first.words[1] ?? null;
    rest = commands.slice(1);
  }
  const [command] = rest;
  if (rest.length !== 1 || command?.words[0] !== "git") {
    return null;
  }
  const [flag, value, ...afterFlag] = command.words.slice(1);
  let words = command.words.slice(1);
  if (flag === "-C" && value !== undefined && directory === null) {
    directory = value;
    words = afterFlag;
  }
  return words[0] === subcommand ? { args: words.slice(1), directory } : null;
};

/**
 * The words after `fetch` when the whole command is one `git fetch`, else
 * null. For the one case where a fetch can't run in the shell (see
 * `parseGitFetch`).
 */
export const lexGitFetch = (
  command: string
): { args: readonly string[]; directory: string | null } | null => {
  const commands = lexLiteralCommands(command);
  return commands ? gitCommandOf(commands, "fetch") : null;
};

const HELP_WORDS = new Set(["help", "version", "-h"]);

const asksForHelp = (command: SimpleCommand): boolean =>
  command.words.length === 1 ||
  HELP_WORDS.has(command.words[1] ?? "") ||
  command.words.includes("--help") ||
  command.words.includes("--version");

/** Sorts a `bash` command into the kind that decides its credential. */
export const analyzeCommand = (command: string): ShellAnalysis => {
  // Too long to read: treated as naming GitHub, which can only read.
  if (command.length > MAX_ANALYZED_LENGTH) {
    return { kind: "shell" };
  }
  if (!namesGitHub(command)) {
    return { kind: "plain" };
  }
  const commands = lexLiteralCommands(command);
  if (!commands || commands.length === 0) {
    return { kind: "shell" };
  }
  // `NAME=value gh ...` would run with an environment the factory didn't set.
  if (commands.some((entry) => ASSIGNMENT.test(entry.words[0] ?? ""))) {
    return { kind: "shell" };
  }
  // `gh --help` and `gh --version` ask the CLI about itself. They are not
  // in the allowlist and need no approval; the wrapper passes them through.
  if (commands.some((entry) => entry.words[0] === "gh" && asksForHelp(entry))) {
    return { kind: "shell" };
  }
  if (commands.every((entry) => entry.words[0] === "gh")) {
    return {
      kind: "gh",
      steps: commands.map((entry) => ({
        after: entry.after,
        argv: entry.words.slice(1),
      })),
    };
  }
  const push = gitCommandOf(commands, "push");
  return push ? { kind: "push", ...push } : { kind: "shell" };
};

/** A `--body-file` argument rewritten to `--body`, with where its text goes. */
export interface BodyFileArgument {
  /** Index in the rewritten argv of the `--body` value to fill in. */
  readonly at: number;
  readonly path: string;
}

const BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);
const BODY_FILE_PREFIX = "--body-file=";

/**
 * Rewrites `--body-file <path>` to `--body <text>`, leaving the text empty
 * and recording which file it comes from.
 *
 * @remarks
 * A file is the easy way to pass long text in a shell, and the allowlist
 * knows only `--body`. So the file is read by the runtime and its text
 * passed as the body: the command that runs is still one the parser saw
 * whole. `gh api` is left alone, where `-F` means something else and is
 * refused by the allowlist anyway.
 *
 * @returns The rewritten argv and the files to read, or why not.
 */
export const inlineBodyFiles = (
  argv: readonly string[]
):
  | {
      readonly argv: readonly string[];
      readonly files: readonly BodyFileArgument[];
    }
  | { readonly reason: string } => {
  if (argv[0] === "api") {
    return { argv, files: [] };
  }
  const rewritten: string[] = [];
  const files: BodyFileArgument[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    let path: string | undefined;
    if (BODY_FILE_FLAGS.has(arg)) {
      path = argv[index + 1];
      index += 1;
    } else if (arg.startsWith(BODY_FILE_PREFIX)) {
      path = arg.slice(BODY_FILE_PREFIX.length);
    } else {
      rewritten.push(arg);
      continue;
    }
    if (path === undefined || path === "" || path === "-") {
      return {
        reason:
          "--body-file needs the path of a file. Reading the body from standard input is not available.",
      };
    }
    rewritten.push("--body", "");
    files.push({ at: rewritten.length - 1, path });
  }
  return { argv: rewritten, files };
};
