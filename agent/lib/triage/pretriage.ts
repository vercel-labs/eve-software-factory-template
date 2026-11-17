import type { SessionAuthContext } from "eve/context";
import { labelDecision } from "../github/approval.js";
import { isTicketRun, workItemIssue } from "../trust.js";
import {
  runTriage,
  type TriageDependencies,
  type TriageResult,
} from "./run.js";

/**
 * Triage before the orchestrator's first turn.
 *
 * @remarks
 * When a run starts from a labeled issue or an intake ticket, the work item
 * is known before any model has read it. The orchestrator's first model
 * call would only be spent on asking for `triage_work_item`, so the run
 * does that itself: the same triage, by the same code (`runTriage`), with
 * the result handed to the orchestrator as an instruction ahead of its
 * input. It then starts from the lane.
 *
 * It is for those two kinds of run only. A mention has to be read by the
 * orchestrator before anyone knows whether it is a work item at all, and a
 * CI-fix or summary run is not one.
 *
 * Nothing here can fail a run: a triage that errors or takes too long
 * yields no instruction, and the orchestrator calls `triage_work_item`
 * itself, as it does on every other run.
 */

/** What a run was started to work on, as far as dispatch knows. */
export type PretriageTarget =
  | { readonly issueNumber: number; readonly kind: "issue" }
  | { readonly body: string; readonly kind: "ticket"; readonly title: string };

/** How long pre-triage may hold up the first model call. */
export const PRETRIAGE_TIMEOUT_MS = 60_000;

const TITLE_PREFIX = "# ";

/**
 * Reads a ticket back out of the message the intake channel sent
 * (`renderTicket` in `agent/lib/intake/ticket.ts`).
 *
 * @remarks
 * A ticket's title is validated as a single line, so the first line is the
 * title and nothing in the body can pass for it. Everything after it (the
 * submitter's own claims, then the body) is the text to triage.
 *
 * @returns The title and text, or null when the message is not a ticket.
 */
export const parseTicketMessage = (
  message: string
): { body: string; title: string } | null => {
  const end = message.indexOf("\n");
  const first = end === -1 ? message : message.slice(0, end);
  if (!first.startsWith(TITLE_PREFIX)) {
    return null;
  }
  const title = first.slice(TITLE_PREFIX.length).trim();
  return title === ""
    ? null
    : { body: end === -1 ? "" : message.slice(end + 1).trim(), title };
};

/**
 * Decides whether a run is one to triage up front, from its dispatch stamps.
 *
 * @param auth - The turn's caller, as the channel stamped it.
 * @param message - The text the turn opened with. Only read for a ticket.
 * @returns What to triage, or null for every other run: a mention, a CI
 * fix, a summary, a Linear session, the dev TUI.
 */
export const pretriageTarget = (
  auth: SessionAuthContext | null,
  message: string
): PretriageTarget | null => {
  const issueNumber = workItemIssue(auth);
  if (issueNumber !== null) {
    return { issueNumber, kind: "issue" };
  }
  if (!isTicketRun(auth)) {
    return null;
  }
  const ticket = parseTicketMessage(message);
  return ticket === null ? null : { ...ticket, kind: "ticket" };
};

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const listed = (values: readonly string[]): string =>
  values.length === 0 ? "none" : values.join(", ");

/**
 * Writes the triage result as the instruction the orchestrator starts with.
 *
 * @remarks
 * Every value here is one the decision model chose from a closed list, a
 * label a maintainer named, or a number. The titles of the issue and of its
 * possible duplicates are left out on purpose: anyone can write those, and
 * an instruction is read with more weight than a tool's result.
 *
 * For an issue it also says what not to repeat. Each tool call is another
 * round trip to the orchestrator's model, and without being told, the
 * orchestrator reads the issue twice, lists the labels, and loads the
 * triage skill on every run. It does have to read the issue once: a
 * labeled-issue run starts with the issue's number and title only.
 */
export const pretriageInstruction = (
  target: PretriageTarget,
  result: TriageResult
): string =>
  [
    `Triage has already run for this work item${target.kind === "issue" ? ` (issue #${target.issueNumber})` : ""}, before your turn. Do not call triage_work_item for it again. Start from the lane below, as the triage section describes.`,
    "",
    `- lane: ${result.lane}`,
    `- type: ${result.type}`,
    `- priority: ${result.priority}`,
    `- complexity: ${result.complexity}`,
    `- actionable: ${yesNo(result.actionable)}`,
    `- needs_clarification: ${yesNo(result.needs_clarification)}`,
    `- needs_research: ${yesNo(result.needs_research)}`,
    target.kind === "issue"
      ? `- labels applied to the issue: ${listed(result.applied_labels)}`
      : `- repository labels that fit: ${listed(result.labels)}`,
    `- possible duplicates to read before acting on that lane: ${listed(result.duplicates.map((number) => `#${number}`))}`,
    ...(target.kind === "issue"
      ? [
          "",
          `- Read the issue once, with gh issue view ${target.issueNumber} --json title,body,author,state,comments. That is everything about it; do not read it a second time.`,
          "- Labels are settled. Do not list labels, and change one only to remove a label that is plainly wrong.",
          "- Load the triaging-issues skill only on the duplicate or clarify lane.",
        ]
      : []),
  ].join("\n");

/** Resolves to `fallback` if `work` has not settled in time. */
const within = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });

/**
 * Triages the run's work item and returns the instruction for it.
 *
 * @remarks
 * Labels are a write, and this path has no tool approval in front of it,
 * so the label policy is asked here: labels are applied only when it lets
 * this caller apply them without a person (`labelDecision`). Today every
 * eligible run is unattended, where it does.
 *
 * @param auth - The turn's caller, for the label policy.
 * @param dependencies.timeoutMs - How long to wait. Defaults to
 * {@link PRETRIAGE_TIMEOUT_MS}.
 * @returns The instruction, or null when triage failed or ran out of time.
 */
export const pretriage = (
  target: PretriageTarget,
  auth: SessionAuthContext | null,
  dependencies: TriageDependencies & { readonly timeoutMs?: number }
): Promise<string | null> => {
  const { timeoutMs = PRETRIAGE_TIMEOUT_MS, ...triage } = dependencies;
  const request =
    target.kind === "issue"
      ? {
          applyLabels: labelDecision(auth) === "not-applicable",
          issueNumber: target.issueNumber,
        }
      : { applyLabels: false, body: target.body, title: target.title };
  return within(
    runTriage(request, triage).then((result) =>
      pretriageInstruction(target, result)
    ),
    timeoutMs,
    null
  );
};
