import type { SessionStreamEvent } from "eve/client";
import { type GhEffect, parseGh } from "#lib/github/cli.js";

/**
 * The orchestrator's one GitHub tool: the real GitHub CLI, called with
 * `{ args: string[] }`.
 *
 * @remarks
 * Every GitHub read and write goes through this single tool, so its name says
 * nothing about what a call does. Evals classify a call by its argv instead,
 * with the project's own parser (see {@link ghEffectKind}).
 */
export const GH_TOOL = "gh";

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

/**
 * Every memory write tool the model can reach, shared and per-user alike.
 */
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

/**
 * One tool call the model requested, as the stream recorded it.
 */
export interface ToolRequest {
  /** The input as requested; `undefined` when the stream kept a reference only. */
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

/**
 * Returns the order in which tools were first called during a run.
 */
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

const ghArgs = (input: unknown): readonly string[] | null => {
  if (typeof input !== "object" || input === null || !("args" in input)) {
    return null;
  }
  const { args } = input;
  return Array.isArray(args) && args.every((arg) => typeof arg === "string")
    ? args
    : null;
};

const parseGhInput = (input: unknown) => {
  const args = ghArgs(input);
  return args === null ? null : parseGh(args);
};

/**
 * Classifies a `gh` tool input by what it does to the repository, using the
 * same parser the tool's approval policy runs on (`agent/lib/github/cli.ts`).
 *
 * @remarks
 * This is deny-by-default: an input counts as a `read` only when the parser
 * accepts the argv and names it a read. An argv the allowlist refuses, a
 * malformed input, and an input the stream kept only by reference all come
 * back `forbidden`, so a `gh` command nobody has classified yet fails every
 * read-only eval until someone decides what it is.
 */
export function ghEffectKind(input: unknown): GhEffect["kind"] {
  const parsed = parseGhInput(input);
  return parsed?.ok ? parsed.invocation.effect.kind : "forbidden";
}

/**
 * The command path of a `gh` tool input (like `issue create`), or `null`
 * when the allowlist refuses the argv.
 */
export function ghCommand(input: unknown): string | null {
  const parsed = parseGhInput(input);
  return parsed?.ok ? parsed.invocation.command : null;
}

/**
 * Builds an input matcher for `calledTool("gh", { input })` and
 * `requireInteraction({ toolName: "gh", input })`: the argv must parse to
 * the given command path and effect.
 */
export const ghInput =
  (expected: { command: string; effect: GhEffect["kind"] }) =>
  (input: unknown): boolean =>
    ghCommand(input) === expected.command &&
    ghEffectKind(input) === expected.effect;

/**
 * The `gh` calls among `requests` that are anything other than a read:
 * labels, comments, issue and pull request writes, ship-gate commands, and
 * every argv the allowlist refuses.
 */
export function ghWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return requests.filter(
    (request) =>
      request.name === GH_TOOL && ghEffectKind(request.input) !== "read"
  );
}

const LABEL_FLAG_PATTERN = /^--(?:add|remove)-label(?:=|$)/;

/**
 * The `gh` calls among `requests` that change labels on an issue or pull
 * request: a pure label edit, or a wider edit that carries a label flag.
 */
export function ghLabelWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return ghWrites(requests).filter(
    (request) =>
      ghEffectKind(request.input) === "label" ||
      (ghArgs(request.input) ?? []).some((arg) => LABEL_FLAG_PATTERN.test(arg))
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
 * Every requested call that writes to GitHub: a non-read `gh` call (see
 * {@link ghWrites}) or a `triage_work_item` call that applies labels.
 */
export function githubWrites(requests: readonly ToolRequest[]): ToolRequest[] {
  return requests.filter(
    (request) =>
      (request.name === GH_TOOL && ghEffectKind(request.input) !== "read") ||
      (request.name === TRIAGE_TOOL && triageAppliesLabels(request.input))
  );
}

/**
 * Label for {@link noGithubWrites} in `t.eventsSatisfy(label, predicate)`.
 */
export const NO_GITHUB_WRITES =
  "no GitHub write was requested: every gh call is an allowlisted read and triage applies no labels";

/**
 * `eventsSatisfy` predicate: no GitHub write was requested during the run,
 * whether or not it would have been approved.
 *
 * @remarks
 * This is the deny-by-default check read-only evals share. It replaces
 * `notCalledTool` over a list of write tools, which stopped meaning anything
 * once every GitHub operation became one `gh` tool.
 */
export function noGithubWrites(events: readonly SessionStreamEvent[]): boolean {
  return githubWrites(toolRequests(events)).length === 0;
}
