import type { SessionStreamEvent } from "eve/client";
import { type GhEffect, parseGh } from "#lib/github/cli.js";
import { analyzeCommand, inlineBodyFiles } from "#lib/github/shell.js";

/**
 * The tool every GitHub operation goes through: `bash`, called with
 * `{ command: string }`.
 *
 * @remarks
 * The orchestrator types `gh` commands into `bash` (there is no shell
 * behind it; the runtime runs them), so the tool's name says nothing about
 * what a call does. Evals classify a call by its command instead, with the
 * project's own code: `analyzeCommand` sorts the command the way the tool
 * does, and each `gh` command in it is parsed against the allowlist (see
 * {@link ghCalls} and {@link bashWritesGitHub}).
 */
export const BASH_TOOL = "bash";

/**
 * The decision-model triage tool. It is the first step for every work item,
 * and with an `issue_number` it applies the selected labels itself.
 */
export const TRIAGE_TOOL = "triage_work_item";

/**
 * The model-facing tools that write the shared factory brain (eve's file
 * memory, mounted as the `brain` slot).
 *
 * @remarks
 * Read-only evals assert `notCalledTool` over this list next to
 * {@link noGithubWrites}, so a read-only turn that reaches for the shared
 * brain fails. There is no read tool to allow: memory is recalled by eve
 * before each turn. Keep in sync with `agent/memory/brain.ts`.
 */
export const BRAIN_WRITE_TOOLS = [
  "brain__save_memory",
  "brain__remove_memory",
] as const;

/**
 * The model-facing tools that write the calling user's private preferences
 * (the `preferences` memory slot). Keep in sync with
 * `agent/memory/preferences.ts`.
 */
export const PREFERENCE_WRITE_TOOLS = [
  "preferences__save_memory",
  "preferences__remove_memory",
] as const;

/** Every memory write tool the model can reach, shared and per-user alike. */
export const MEMORY_WRITE_TOOLS = [
  ...BRAIN_WRITE_TOOLS,
  ...PREFERENCE_WRITE_TOOLS,
] as const;

/**
 * The tools a work item passes through on the build lane, in pipeline order:
 * triage, then the three stations.
 *
 * @remarks
 * Stations are opened by `run_<station>` workflow tools, so a station run is
 * an ordinary tool call here. `run_classifier` is deliberately absent: it
 * only runs on the clarification lane.
 */
export const PIPELINE_TOOLS = [
  TRIAGE_TOOL,
  "run_analyst",
  "run_implementer",
  "run_reviewer",
] as const;

/** One tool call the model requested, as the stream recorded it. */
export interface ToolRequest {
  /**
   * The input as requested; `undefined` when the stream kept a reference
   * only.
   */
  readonly input: unknown;
  readonly name: string;
}

/**
 * Returns every tool call requested during a run, in request order, read
 * from `call.requested` stream events.
 *
 * @remarks
 * A requested call counts whatever happened to it next (ran, parked for
 * approval, was denied), which is what "the agent tried to" assertions need.
 */
export function toolRequests(
  events: readonly SessionStreamEvent[]
): ToolRequest[] {
  const requests: ToolRequest[] = [];
  for (const event of events) {
    if (
      event.type === "call.requested" &&
      event.data.capability.kind === "tool"
    ) {
      requests.push({
        input: event.data.input,
        name: event.data.capability.name,
      });
    }
  }
  return requests;
}

/** Returns the order in which tools were first called during a run. */
export function firstCallOrder(
  events: readonly SessionStreamEvent[]
): string[] {
  const order: string[] = [];
  for (const { name } of toolRequests(events)) {
    if (!order.includes(name)) {
      order.push(name);
    }
  }
  return order;
}

/**
 * True when every named tool was called and their first calls happened in
 * the given order (other calls may interleave).
 */
export function calledInOrder(
  events: readonly SessionStreamEvent[],
  names: readonly string[]
): boolean {
  const order = firstCallOrder(events);
  const indices = names.map((name) => order.indexOf(name));
  return indices.every(
    (index, i) => index !== -1 && (i === 0 || index > (indices[i - 1] ?? -1))
  );
}

/**
 * True when `first` was called and no call to any of `others` was requested
 * before its first call.
 */
export function calledBeforeAny(
  events: readonly SessionStreamEvent[],
  first: string,
  others: readonly string[]
): boolean {
  const names = toolRequests(events).map((request) => request.name);
  const firstAt = names.indexOf(first);
  return (
    firstAt !== -1 &&
    !names.slice(0, firstAt).some((name) => others.includes(name))
  );
}

const bashCommand = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return null;
  }
  const { command } = input;
  return typeof command === "string" ? command : null;
};

/** One `gh` command in a `bash` call, as the allowlist reads it. */
export interface GhCall {
  /** The words after `gh`, as the shell lexer read them. */
  readonly argv: readonly string[];
  /**
   * The command path (like `issue create`), or `null` when the allowlist
   * refuses the command.
   */
  readonly command: string | null;
  /**
   * What the command does to the repository; `forbidden` when the allowlist
   * refuses it.
   */
  readonly effect: GhEffect["kind"];
}

const classifyGh = (argv: readonly string[]): GhCall => {
  const inlined = inlineBodyFiles(argv);
  const parsed = "reason" in inlined ? null : parseGh(inlined.argv);
  return parsed?.ok
    ? {
        argv,
        command: parsed.invocation.command,
        effect: parsed.invocation.effect.kind,
      }
    : { argv, command: null, effect: "forbidden" };
};

/**
 * Reads a `bash` tool input the way the tool's approval policy does
 * (`agent/lib/github/approval.ts`): when the whole command is a list of `gh`
 * commands with literal words, returns each one with its command path and
 * effect.
 *
 * @returns One entry per `gh` command, in order. Empty for every other
 * command, including one that names `gh` inside a pipe or a script: only a
 * command of this shape is parsed, approved, and given a credential that
 * can write.
 */
export function ghCalls(input: unknown): GhCall[] {
  const command = bashCommand(input);
  if (command === null) {
    return [];
  }
  const analysis = analyzeCommand(command);
  return analysis.kind === "gh"
    ? analysis.steps.map((step) => classifyGh(step.argv))
    : [];
}

/**
 * Whether a `bash` tool input asks for a change on GitHub.
 *
 * @remarks
 * This is deny-by-default. A command counts as harmless only when it is one
 * of three things:
 *
 * - `plain`: it names neither `gh` nor a networked `git` command. On the
 *   orchestrator it is refused; on a station it runs with no credential.
 * - `shell`: it names them in a shape the runtime does not parse (a pipe, a
 *   variable, a script). On the orchestrator it is refused; on a station it
 *   runs under a read-only credential. Either way it cannot write.
 * - a list of `gh` commands in which every one parses to a `read`.
 *
 * Everything else counts as a write: a `gh` list with a label, comment, or
 * any other non-read command, a `gh` command the allowlist refuses, a
 * `git push`, and an input the stream kept only by reference. So a `gh`
 * command nobody has classified yet fails every read-only eval until
 * someone decides what it is.
 */
export function bashWritesGitHub(input: unknown): boolean {
  const command = bashCommand(input);
  if (command === null) {
    return true;
  }
  const analysis = analyzeCommand(command);
  switch (analysis.kind) {
    case "plain":
    case "shell":
      return false;
    case "gh":
      return analysis.steps.some(
        (step) => classifyGh(step.argv).effect !== "read"
      );
    case "push":
      return true;
    default:
      return analysis satisfies never;
  }
}

/**
 * Builds an input matcher for `calledTool("bash", { input })` and
 * `requireInteraction({ toolName: "bash", input })`: the command must be a
 * list of `gh` commands, one of which parses to the given command path and
 * effect.
 */
export const ghInput =
  (expected: { command: string; effect: GhEffect["kind"] }) =>
  (input: unknown): boolean =>
    ghCalls(input).some(
      (call) =>
        call.command === expected.command && call.effect === expected.effect
    );

/**
 * The `bash` calls among `requests` that ask for a change on GitHub: labels,
 * comments, issue and pull request writes, ship-gate commands, a push, and
 * every `gh` command the allowlist refuses (see {@link bashWritesGitHub}).
 */
export function ghWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return requests.filter(
    (request) => request.name === BASH_TOOL && bashWritesGitHub(request.input)
  );
}

const LABEL_FLAG_PATTERN = /^--(?:add|remove)-label(?:=|$)/;

/**
 * The `bash` calls among `requests` that change labels on an issue or pull
 * request with `gh`: a pure label edit, or a wider edit that carries a label
 * flag.
 */
export function ghLabelWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return ghWrites(requests).filter((request) =>
    ghCalls(request.input).some(
      (call) =>
        call.effect === "label" ||
        (call.effect !== "read" &&
          call.argv.some((arg) => LABEL_FLAG_PATTERN.test(arg)))
    )
  );
}

/**
 * True when a `triage_work_item` input makes the tool apply labels to a
 * GitHub issue, mirroring the tool's own approval rule
 * (`agent/tools/triage_work_item.ts`): an `issue_number` is present and
 * `apply_labels` is not `false`.
 *
 * @param issueNumber - When given, the input must also name this issue.
 */
export function triageAppliesLabels(
  input: unknown,
  issueNumber?: number
): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const fields: { apply_labels?: unknown; issue_number?: unknown } = input;
  return (
    typeof fields.issue_number === "number" &&
    fields.apply_labels !== false &&
    (issueNumber === undefined || fields.issue_number === issueNumber)
  );
}

/**
 * Every requested call that writes to GitHub: a `bash` call that asks for a
 * change (see {@link ghWrites}) or a `triage_work_item` call that applies
 * labels.
 */
export function githubWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return requests.filter(
    (request) =>
      (request.name === BASH_TOOL && bashWritesGitHub(request.input)) ||
      (request.name === TRIAGE_TOOL && triageAppliesLabels(request.input))
  );
}

/** Label for {@link noGithubWrites} in `t.eventsSatisfy(label, predicate)`. */
export const NO_GITHUB_WRITES =
  "no GitHub write was requested: no bash command pushes or runs a gh command other than an allowlisted read, and triage applies no labels";

/**
 * `eventsSatisfy` predicate: no GitHub write was requested during the run,
 * whether or not it would have been approved.
 *
 * @remarks
 * This is the deny-by-default check read-only evals share. A list of write
 * tools to assert `notCalledTool` over would mean nothing here: every GitHub
 * operation is a `bash` call, and only its command says what it does.
 */
export function noGithubWrites(events: readonly SessionStreamEvent[]): boolean {
  return githubWrites(toolRequests(events)).length === 0;
}
