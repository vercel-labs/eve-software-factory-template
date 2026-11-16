import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import {
  intakeIssueNumber,
  isAutonomous,
  isScheduleAppAuth,
  isSummaryOnly,
  isTrusted,
} from "../trust.js";
import { type GhEffect, parseGh } from "./cli.js";
import { isRepoDirectory, parseGitPush } from "./git-cli.js";
import { REPO_DIR } from "./git-remote.js";
import {
  analyzeCommand,
  inlineBodyFiles,
  type ShellAnalysis,
} from "./shell.js";
import type { ShellRole } from "./shims.js";

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
 * - Unattended (the constructed autonomous principal: label intake, CI
 *   fixes, API intake). Nobody is watching, so nothing ever waits for
 *   approval; a call either runs or is denied. A summary-only run (a pull
 *   request someone opened) is the same principal narrowed further: it
 *   reads, and comments on that one pull request.
 * - Trusted (a channel stamped the caller, or a schedule turn). Routine,
 *   reversible writes run without a prompt.
 * - Everyone else (the dev TUI, an unstamped session). Writes wait for a
 *   person.
 *
 * Shipping (anything that takes a pull request out of draft) waits for a
 * person no matter who asks, and is denied outright when nobody is watching.
 */

type Auth = SessionAuthContext | null;

const denied = (reason: string): ApprovalStatus => ({ reason, type: "denied" });

const SUMMARY_ONLY =
  "This run only reads the pull request and posts its summary on that pull request.";

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
 *
 * @param thread - The issue or pull request number the comment lands on,
 * or null when the command names it some other way (a branch, say). An
 * unattended run is denied on null.
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
  if (isSummaryOnly(auth)) {
    return denied(SUMMARY_ONLY);
  }
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
 * What a summary-only run may do: read, and comment on the pull request it
 * was dispatched for.
 */
function summaryDecision(effect: GhEffect, auth: Auth): ApprovalStatus {
  if (effect.kind === "read") {
    return "not-applicable";
  }
  if (effect.kind === "forbidden") {
    return denied(effect.reason);
  }
  return effect.kind === "comment" &&
    effect.thread !== null &&
    effect.thread === intakeIssueNumber(auth)
    ? "not-applicable"
    : denied(SUMMARY_ONLY);
}

/**
 * Approval policy for the tools that start a station.
 *
 * @remarks
 * A station run costs real work and, for the implementer, ends in a pushed
 * branch, so the one caller class with no business building anything is
 * denied here: a summary-only run. Everyone else is unaffected; what their
 * run may go on to do with the result is still decided call by call.
 */
export function stationPolicy(ctx: ApprovalContext): ApprovalStatus {
  return isSummaryOnly(ctx.session.auth.current)
    ? denied(SUMMARY_ONLY)
    : "not-applicable";
}

/**
 * Maps the effect of a `gh` invocation and the caller's trust class to an
 * approval outcome.
 *
 * @remarks
 * - A summary-only run is held to `summaryDecision` instead.
 * - Otherwise reads, closing or reopening an issue (reversible triage), and
 *   opening a draft pull request (it cannot merge) run for every caller.
 * - A close or reopen that also posts a comment is held to the comment
 *   policy, so neither the approval a comment needs nor an unattended run's
 *   comment scope can be sidestepped through `--comment`.
 */
export function ghEffectDecision(effect: GhEffect, auth: Auth): ApprovalStatus {
  if (isSummaryOnly(auth)) {
    return summaryDecision(effect, auth);
  }
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

const STATION_READS_ONLY =
  "Stations read GitHub and leave the writing to the orchestrator. Report what should change in your structured output.";

const isDenied = (status: ApprovalStatus): boolean =>
  typeof status === "object" && status.type === "denied";

/** The outcome that stops the most: denied, then waiting, then running. */
const strictest = (statuses: readonly ApprovalStatus[]): ApprovalStatus =>
  statuses.find(isDenied) ??
  statuses.find((status) => status === "user-approval") ??
  "not-applicable";

/**
 * Whether an agent has a shell, or only `gh`.
 *
 * @remarks
 * The stations have one; their work is running code. The orchestrator does
 * not, on any run. It routes work and talks to GitHub, and for that it needs
 * `gh` and nothing else, so its `bash` accepts only whole `gh` commands,
 * which the runtime parses and runs itself.
 *
 * The reason is where a write runs. The runtime runs an approved `gh` write
 * in the orchestrator's sandbox, with a credential that can change issues
 * and pull requests. If the orchestrator could start programs of its own in
 * that sandbox, a run steered by the text it reads (an issue body, a pull
 * request from a stranger, a comment) could leave something there to pick
 * that credential up. With no shell there is nothing in the sandbox but
 * what the runtime put there, and the allowlist and this policy are the
 * limit on what the orchestrator can do to GitHub, for every caller.
 */
export const shellAvailable = (role: ShellRole): boolean =>
  role !== "orchestrator";

export const GH_ONLY =
  "There is no shell here, only gh. Run gh commands on their own: one command, or several joined with &&, every argument written out, with no pipes and no other programs. Use --json and --jq to shape the output.";

/** How many `gh` commands one bash command may hold. */
export const MAX_GH_STEPS = 12;

const BODY_FILE_NEEDS_REVIEW =
  "This command waits for a person's approval, and they can only review what the command shows. Pass the text with --body instead of --body-file.";

const ghStepDecision = (
  argv: readonly string[],
  role: ShellRole,
  auth: Auth
): ApprovalStatus => {
  const inlined = inlineBodyFiles(argv);
  if ("reason" in inlined) {
    return denied(inlined.reason);
  }
  const parsed = parseGh(inlined.argv);
  if (!parsed.ok) {
    return denied(parsed.reason);
  }
  const { effect } = parsed.invocation;
  if (role !== "orchestrator") {
    return effect.kind === "read"
      ? "not-applicable"
      : denied(STATION_READS_ONLY);
  }
  const decision = ghEffectDecision(effect, auth);
  // A file's text is read when the command runs, after any approval, so an
  // approver would be agreeing to text they never saw.
  return decision === "user-approval" && inlined.files.length > 0
    ? denied(BODY_FILE_NEEDS_REVIEW)
    : decision;
};

/**
 * The outcome for a `git push`: it runs or is denied, never waits. The
 * same checks run again when the push does (`runPush` in `tools.ts`).
 */
const pushDecision = (
  analysis: Extract<ShellAnalysis, { kind: "push" }>,
  role: ShellRole
): ApprovalStatus => {
  if (role !== "implementer") {
    return denied(
      role === "orchestrator"
        ? "The orchestrator never pushes. The implementer delivers the branch; open the pull request from it."
        : "This station reads the repository and never pushes. Report what should change in your structured output."
    );
  }
  if (!isRepoDirectory(analysis.directory)) {
    return denied(
      `A push runs in the ${REPO_DIR} checkout. Write it as: git push origin <branch>.`
    );
  }
  const parsed = parseGitPush(analysis.args);
  return parsed.ok ? "not-applicable" : denied(parsed.reason);
};

/**
 * Maps a `bash` command, read by `analyzeCommand`, to an approval outcome.
 *
 * @remarks
 * - A command that talks to GitHub in no way the runtime can read in full
 *   (`plain`, `shell`) gets no credential, or one that only reads, so there
 *   is nothing to approve. It runs, except on the orchestrator, which has
 *   no shell (see {@link shellAvailable}).
 * - A list of `gh` commands is held to the allowlist and to the caller's
 *   trust class, one command at a time, and the strictest outcome decides
 *   for the list. On a station only reads run.
 * - A push runs for the implementer alone, and only in the form the push
 *   parser accepts.
 *
 * Stations never get `user-approval` back: an unattended run has nobody to
 * answer, and the orchestrator owns every write to GitHub anyway.
 */
export function shellDecision(
  analysis: ShellAnalysis,
  role: ShellRole,
  auth: Auth
): ApprovalStatus {
  switch (analysis.kind) {
    case "plain":
    case "shell":
      return shellAvailable(role) ? "not-applicable" : denied(GH_ONLY);
    case "gh":
      if (analysis.steps.length > MAX_GH_STEPS) {
        return denied(
          `Run at most ${MAX_GH_STEPS} gh commands in one command.`
        );
      }
      return strictest(
        analysis.steps.map((step) => ghStepDecision(step.argv, role, auth))
      );
    case "push":
      return pushDecision(analysis, role);
    default:
      return analysis satisfies never;
  }
}

interface BashToolInput {
  readonly command?: string;
}

/** Approval policy for an agent's `bash` tool. */
export const bashPolicy =
  (role: ShellRole) =>
  (ctx: ApprovalContext<BashToolInput>): ApprovalStatus =>
    shellDecision(
      analyzeCommand(ctx.toolInput?.command ?? ""),
      role,
      ctx.session.auth.current
    );

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
