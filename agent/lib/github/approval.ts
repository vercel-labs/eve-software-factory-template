import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import {
  intakeIssueNumber,
  isAutonomous,
  isScheduleAppAuth,
  isTrusted,
} from "../trust.js";
import { type GhEffect, parseGh } from "./cli.js";

/**
 * The factory's authorization policy: what each class of caller may do on
 * GitHub, and to the factory's shared memory.
 *
 * @remarks
 * Trust is decided once, at dispatch, by the channels (`agent/lib/trust.ts`).
 * Every function here reads that stamp and returns one of three outcomes:
 * `not-applicable` (run), `user-approval` (stop and wait for a person), or
 * `denied`. There are three caller classes:
 *
 * - **Unattended** (the constructed autonomous principal: label intake, CI
 *   fixes, API intake). Nobody is watching, so nothing ever waits for
 *   approval; a call either runs or is denied.
 * - **Trusted** (a channel stamped the caller, or a schedule turn). Routine,
 *   reversible writes run without a prompt.
 * - **Everyone else** (the dev TUI, an unstamped session). Writes wait for a
 *   person.
 *
 * Shipping (anything that takes a pull request out of draft) waits for a
 * person no matter who asks, and is denied outright when nobody is watching.
 */

type Auth = SessionAuthContext | null;

const denied = (reason: string): ApprovalStatus => ({ reason, type: "denied" });

/**
 * Policy for routine, reversible repository writes: creating an issue,
 * editing one, assigning people, commenting on a pull request.
 */
export function writeDecision(auth: Auth): ApprovalStatus {
  if (isAutonomous(auth)) {
    return denied(
      "Unattended factory runs may only apply labels, comment on the thread they were dispatched from, close or reopen issues, and open draft pull requests."
    );
  }
  if (isTrusted(auth) || isScheduleAppAuth(auth)) {
    return "not-applicable";
  }
  return "user-approval";
}

/**
 * Policy for comments. An unattended run may comment on the one thread it
 * was dispatched from (stamped at dispatch) and nowhere else, so a
 * prompt-injected issue can't make it post across the repository.
 */
export function commentDecision(
  auth: Auth,
  thread: number | null
): ApprovalStatus {
  if (!isAutonomous(auth)) {
    return writeDecision(auth);
  }
  const intakeIssue = intakeIssueNumber(auth);
  if (intakeIssue !== null && thread === intakeIssue) {
    return "not-applicable";
  }
  return denied(
    intakeIssue === null
      ? "This unattended run has no thread to comment on. Put what you have to say in your final message instead."
      : `Unattended factory runs may comment only on the thread they were dispatched from (#${intakeIssue}), addressed by its number.`
  );
}

/**
 * Policy for label changes. Labels are how an unattended run mirrors its
 * triage onto the work item, so they run for it; other callers follow the
 * routine-write policy.
 */
export function labelDecision(auth: Auth): ApprovalStatus {
  return isAutonomous(auth) ? "not-applicable" : writeDecision(auth);
}

/**
 * The ship gate: anything that presents a pull request as ready. A person
 * approves it every time, and an unattended run is denied, because a draft
 * is the most the factory delivers on its own.
 */
export function shipDecision(auth: Auth): ApprovalStatus {
  if (isAutonomous(auth)) {
    return denied(
      "Unattended factory runs stop at a draft pull request; a person marks it ready."
    );
  }
  return "user-approval";
}

/**
 * Maps the effect of a `gh` invocation and the caller's trust class to an
 * approval outcome.
 *
 * @remarks
 * - Reads, closing or reopening an issue (reversible triage), and opening a
 *   draft pull request (it cannot merge) run for every caller.
 * - A close or reopen that also posts a comment is held to the comment
 *   policy, so neither the approval a comment needs nor an unattended run's
 *   comment scope can be sidestepped through `--comment`.
 */
export function ghEffectDecision(effect: GhEffect, auth: Auth): ApprovalStatus {
  switch (effect.kind) {
    case "read":
    case "draft-pr":
      return "not-applicable";
    case "label":
      return labelDecision(auth);
    case "comment":
      return commentDecision(auth, effect.thread);
    case "state":
      return effect.withComment
        ? commentDecision(auth, effect.commentThread)
        : "not-applicable";
    case "write":
      return writeDecision(auth);
    case "ship":
      return shipDecision(auth);
    case "forbidden":
      return denied(effect.reason);
    default:
      return effect satisfies never;
  }
}

interface GhToolInput {
  readonly args?: readonly string[];
}

/**
 * Approval policy for the orchestrator's `gh` tool.
 *
 * @remarks
 * An argv the allowlist refuses is denied here, with the reason, so the
 * model learns what would work without the command ever reaching a sandbox.
 */
export function ghPolicy(ctx: ApprovalContext<GhToolInput>): ApprovalStatus {
  const parsed = parseGh(ctx.toolInput?.args ?? []);
  if (!parsed.ok) {
    return denied(parsed.reason);
  }
  return ghEffectDecision(parsed.invocation.effect, ctx.session.auth.current);
}

/**
 * Approval policy for a station's `gh` tool: reads run, everything else is
 * denied.
 *
 * @remarks
 * Stations never return `user-approval`. An unattended run has nobody to
 * answer, and the orchestrator owns every write to GitHub anyway; a station
 * that wants something changed reports it in its structured output.
 */
export function readOnlyGhPolicy(
  ctx: ApprovalContext<GhToolInput>
): ApprovalStatus {
  const parsed = parseGh(ctx.toolInput?.args ?? []);
  if (!parsed.ok) {
    return denied(parsed.reason);
  }
  return parsed.invocation.effect.kind === "read"
    ? "not-applicable"
    : denied(
        "Stations read GitHub and leave the writing to the orchestrator. Report what should change in your structured output."
      );
}

/**
 * Policy for writing the factory brain (the shared memory slot).
 *
 * @remarks
 * The brain is context every future run trusts. Unattended runs work from
 * untrusted issue bodies, so they never write it; they don't get the tools
 * at all (`agent/lib/memory/brain.ts`), and this denial is the second lock.
 * Trusted callers write directly; the dev TUI waits for approval.
 */
export function factoryBrainPolicy(ctx: ApprovalContext): ApprovalStatus {
  const auth = ctx.session.auth.current;
  if (isAutonomous(auth)) {
    return denied(
      "Unattended factory runs may read the factory brain but not write to it."
    );
  }
  if (isTrusted(auth) || isScheduleAppAuth(auth)) {
    return "not-applicable";
  }
  return "user-approval";
}
