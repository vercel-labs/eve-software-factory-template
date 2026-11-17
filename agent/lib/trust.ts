import type { SessionAuthContext } from "eve/context";

/**
 * Constructed principal for unattended factory runs (an issue labeled
 * `factory`, a red CI run on a factory pull request, or a ticket submitted
 * through the intake API).
 *
 * @remarks
 * Real GitHub actors project as numeric `github:<id>` principals, so this
 * fixed login can never collide with one. The GitHub and intake channels
 * stamp it at dispatch; the approval policies (`github/approval.ts`) deny it
 * everything except labels, progress comments on its own intake issue,
 * closing or reopening issues, and draft pull requests, because an
 * unattended turn has nobody to answer an approval card and would park
 * forever.
 */
export const AUTONOMOUS_PRINCIPAL = "github:foreman-factory";

/**
 * Auth attribute marking a caller the dispatching channel decided to trust.
 *
 * @remarks
 * Trust is decided once, at dispatch, on the signed webhook: the GitHub
 * channel stamps it only for commenters whose `author_association` is
 * OWNER, MEMBER, or COLLABORATOR; the Linear channel stamps it for every
 * Agent Session, because workspace membership is the gate there. Nothing
 * downstream re-derives trust from model-readable content.
 */
export const TRUSTED_ATTRIBUTE = "trusted";

/**
 * Returns a copy of `auth` carrying the {@link TRUSTED_ATTRIBUTE} stamp.
 *
 * @remarks
 * Channels call this at dispatch, next to the authorization decision itself,
 * so the stamp and the gate can never drift apart.
 */
export function stampTrusted(auth: SessionAuthContext): SessionAuthContext {
  return {
    ...auth,
    attributes: { ...auth.attributes, [TRUSTED_ATTRIBUTE]: "true" },
  };
}

/**
 * Auth attribute carrying the issue number an unattended run was dispatched
 * from.
 *
 * @remarks
 * Stamped by {@link stampAutonomous} at dispatch, on the signed webhook, so
 * the approval policies can scope an unattended run's comment writes to its
 * own intake thread. Attribute values are strings; read it back through
 * {@link intakeIssueNumber}.
 */
export const INTAKE_ISSUE_ATTRIBUTE = "intakeIssue";

/**
 * Rewrites a channel auth into the unattended factory principal, carrying the
 * intake issue number.
 *
 * @remarks
 * The GitHub channel calls this when the factory label is applied or a
 * factory pull request's CI fails: the webhook sender's identity is replaced
 * (the turn must never run as the labeler), and the number is stamped so
 * `commentDecision` (`github/approval.ts`) can let the run narrate on its
 * own thread and nowhere else.
 *
 * @param intakeIssue - The issue or pull request number the run was
 * dispatched from, taken from the signed webhook, never from model input.
 */
export function stampAutonomous(
  auth: SessionAuthContext,
  intakeIssue: number
): SessionAuthContext {
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [INTAKE_ISSUE_ATTRIBUTE]: String(intakeIssue),
    },
    principalId: AUTONOMOUS_PRINCIPAL,
    principalType: "service",
  };
}

/**
 * Auth attribute narrowing what an unattended run is for.
 *
 * @remarks
 * Its one value today is {@link SUMMARY_SCOPE}. A run without the attribute
 * is an ordinary unattended run.
 */
export const SCOPE_ATTRIBUTE = "factoryScope";

/** Scope of a run dispatched to summarize a pull request someone opened. */
export const SUMMARY_SCOPE = "summary";

/**
 * Rewrites a channel auth into the summary-only principal for a pull
 * request.
 *
 * @remarks
 * A pull request can be opened by anyone, and its title, description, and
 * diff are what the run reads, so this is the dispatch with the least
 * trustworthy input the factory has. The run is therefore the unattended
 * principal narrowed further: the approval policies let it read and post
 * on that one pull request, and deny it everything else, the stations
 * included. Text in a pull request can make it write a bad summary; it
 * cannot make it push a branch or close an issue.
 *
 * @param pullRequest - The pull request's number, from the signed webhook.
 */
export function stampSummary(
  auth: SessionAuthContext,
  pullRequest: number
): SessionAuthContext {
  const autonomous = stampAutonomous(auth, pullRequest);
  return {
    ...autonomous,
    attributes: { ...autonomous.attributes, [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE },
  };
}

/** Whether the session is a summary-only run (see {@link stampSummary}). */
export function isSummaryOnly(auth: SessionAuthContext | null): boolean {
  return (
    isAutonomous(auth) && auth?.attributes[SCOPE_ATTRIBUTE] === SUMMARY_SCOPE
  );
}

/**
 * Auth attribute marking an unattended run as the intake of one GitHub
 * issue: the run a maintainer started by labeling it.
 *
 * @remarks
 * {@link INTAKE_ISSUE_ATTRIBUTE} alone does not say this. A CI-fix run and
 * a summary run carry a thread number too, and neither is a work item to
 * triage. Only `onIssue` sets this stamp.
 */
export const WORK_ITEM_ATTRIBUTE = "factoryWorkItem";

/** The one value of {@link WORK_ITEM_ATTRIBUTE}. */
export const ISSUE_WORK_ITEM = "issue";

/**
 * Stamps an unattended run as the intake of a GitHub issue.
 *
 * @param issue - The issue the factory label was applied to.
 * @returns {@link stampAutonomous} for that issue, marked as a work item.
 */
export function stampIssueIntake(
  auth: SessionAuthContext,
  issue: number
): SessionAuthContext {
  const autonomous = stampAutonomous(auth, issue);
  return {
    ...autonomous,
    attributes: {
      ...autonomous.attributes,
      [WORK_ITEM_ATTRIBUTE]: ISSUE_WORK_ITEM,
    },
  };
}

/**
 * The issue an unattended run was started to work on.
 *
 * @returns Null unless the run carries the issue-intake stamp and a valid
 * issue number, and is not a summary-only run.
 */
export function workItemIssue(auth: SessionAuthContext | null): number | null {
  return auth?.attributes[WORK_ITEM_ATTRIBUTE] === ISSUE_WORK_ITEM &&
    !isSummaryOnly(auth)
    ? intakeIssueNumber(auth)
    : null;
}

/** Whether the session is an unattended run for an intake API ticket. */
export function isTicketRun(auth: SessionAuthContext | null): boolean {
  const ticket = auth?.attributes[INTAKE_TICKET_ATTRIBUTE];
  return isAutonomous(auth) && typeof ticket === "string" && ticket !== "";
}

/**
 * Auth attribute carrying the intake API ticket an unattended run was
 * dispatched for.
 */
export const INTAKE_TICKET_ATTRIBUTE = "intakeTicket";

/**
 * Auth attribute recording which verified API caller submitted the ticket.
 * Informational only: no policy reads it.
 */
export const INTAKE_CALLER_ATTRIBUTE = "intakeCaller";

/**
 * Builds the unattended factory principal for a ticket submitted through the
 * intake API.
 *
 * @remarks
 * The principal is constructed from the verified caller and the server-made
 * ticket id alone. Nothing in the request body reaches it, so a ticket can't
 * choose who its run acts as. It carries no intake issue number, which means
 * the approval policies give it no thread to comment on: an API run can read
 * the repository, apply labels, close or reopen an issue, and open a draft
 * pull request, and nothing else.
 *
 * @param ticketId - The id the server made for the ticket.
 * @param callerId - The verified API caller's principal id.
 */
export function autonomousForTicket(
  ticketId: string,
  callerId: string
): SessionAuthContext {
  return {
    attributes: {
      [INTAKE_CALLER_ATTRIBUTE]: callerId,
      [INTAKE_TICKET_ATTRIBUTE]: ticketId,
    },
    authenticator: "intake",
    principalId: AUTONOMOUS_PRINCIPAL,
    principalType: "service",
  };
}

/**
 * The issue number an unattended run was dispatched from.
 *
 * @returns Null when the session is not an unattended run, or carries no
 * valid issue number (an intake API ticket carries none).
 */
export function intakeIssueNumber(
  auth: SessionAuthContext | null
): number | null {
  if (!isAutonomous(auth)) {
    return null;
  }
  const stamped = auth?.attributes[INTAKE_ISSUE_ATTRIBUTE];
  if (typeof stamped !== "string" || stamped === "") {
    return null;
  }
  const issue = Number(stamped);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

/** Whether the session runs unattended under {@link AUTONOMOUS_PRINCIPAL}. */
export function isAutonomous(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.principalId === AUTONOMOUS_PRINCIPAL;
}

/**
 * Whether the dispatching channel stamped this caller as trusted.
 *
 * @remarks
 * This is the single caller check for routine repository writes. New
 * capabilities gate on this predicate (or {@link isAutonomous} /
 * {@link isScheduleAppAuth}) rather than inventing their own.
 */
export function isTrusted(auth: SessionAuthContext | null): boolean {
  return auth !== null && auth.attributes[TRUSTED_ATTRIBUTE] === "true";
}

/**
 * Whether the session is the app principal eve stamps on
 * schedule-dispatched turns.
 *
 * @remarks
 * No schedule ships in this template, but the approval policies already
 * recognize the principal so a schedule added later (see the README's
 * extending section) inherits sensible write behavior: reversible writes run,
 * anything that ships still parks for a person. It is never a user identity.
 */
export function isScheduleAppAuth(auth: SessionAuthContext | null): boolean {
  return (
    auth !== null &&
    auth.authenticator === "app" &&
    auth.principalId === "eve:app" &&
    auth.principalType === "runtime"
  );
}
