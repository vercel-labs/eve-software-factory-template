import {
  type CiFailureCause,
  diagnoseCiFailure,
  type TriageDependencies,
} from "./decisions.js";
import {
  type FailingCheck,
  fetchChecks,
  fetchFailedLogs,
  type GhRunner,
} from "./github.js";

/**
 * What a pull request's checks look like right now.
 *
 * - `passing`, `pending`, `cancelled`, `no-checks`: nothing is failing.
 * - `failing`: something failed and its log was read and judged.
 * - `failing-no-log`: something failed and no log could be read (an
 *   external CI system, a check with no Actions run behind it, or a token
 *   without Actions read access). The cause is unknown, not benign.
 */
export const CI_STATUSES = [
  "passing",
  "pending",
  "cancelled",
  "no-checks",
  "failing",
  "failing-no-log",
] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export interface CiDiagnosisReport {
  readonly cancelled_checks: number;
  readonly cause: CiFailureCause | null;
  readonly confidence: number | null;
  readonly failing_checks: FailingCheck[];
  /**
   * True when changing the branch is the right response, false when it is
   * not, and null when that could not be determined.
   */
  readonly fix_with_code: boolean | null;
  readonly log_excerpt: string;
  readonly pending_checks: number;
  readonly status: CiStatus;
}

/** How much of the failed log goes back to the orchestrator. */
export const LOG_EXCERPT_CHARACTERS = 6000;

/**
 * Reads a pull request's checks and, when something failed, sorts the
 * failure by cause.
 *
 * @remarks
 * The decision model is only consulted when there is a log to judge. With
 * failing checks and no readable log the answer is "unknown"
 * (`fix_with_code: null`), never "the code is fine": the caller decides what
 * to do with an unknown, and a wrong "not the code" would end the fix loop
 * on a real failure.
 */
export const diagnosePullRequestChecks = async (
  gh: GhRunner,
  pullRequest: number,
  dependencies: TriageDependencies
): Promise<CiDiagnosisReport> => {
  const checks = await fetchChecks(gh, pullRequest);
  const counts = {
    cancelled_checks: checks.cancelled,
    pending_checks: checks.pending,
  };
  if (checks.failing.length === 0) {
    let status: CiStatus = "passing";
    if (checks.pending > 0) {
      status = "pending";
    } else if (checks.cancelled > 0) {
      status = "cancelled";
    } else if (checks.total === 0) {
      status = "no-checks";
    }
    return {
      ...counts,
      cause: null,
      confidence: null,
      failing_checks: [],
      fix_with_code: false,
      log_excerpt: "",
      status,
    };
  }
  const failing = [...checks.failing];
  const log = await fetchFailedLogs(gh, failing);
  if (log.trim() === "") {
    return {
      ...counts,
      cause: null,
      confidence: null,
      failing_checks: failing,
      fix_with_code: null,
      log_excerpt: "",
      status: "failing-no-log",
    };
  }
  const diagnosis = await diagnoseCiFailure(log, dependencies);
  return {
    ...counts,
    ...diagnosis,
    failing_checks: failing,
    log_excerpt: log.slice(-LOG_EXCERPT_CHARACTERS),
    status: "failing",
  };
};
