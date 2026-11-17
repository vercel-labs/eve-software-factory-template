import { FACTORY_LABEL } from "../constants.js";
import { parseGh } from "../github/cli.js";
import {
  type LeaseDependencies,
  type LeaseSandbox,
  runGh,
} from "../github/lease.js";
import {
  type TriageDependencies as DecisionDependencies,
  TRIAGE_LIMITS,
  triageWorkItem,
} from "./decisions.js";
import {
  applyLabels,
  fetchIssue,
  fetchLabels,
  findDuplicateCandidates,
  type GhRunner,
} from "./github.js";

/** What to triage: a GitHub issue by number, or an item's own text. */
export interface TriageRequest {
  /** Add the selected labels to the issue. Only applies with an issue. */
  readonly applyLabels: boolean;
  readonly body?: string;
  readonly issueNumber?: number;
  readonly title?: string;
}

/** The decision model's dependencies, plus the `gh` runner. */
export interface TriageDependencies extends DecisionDependencies {
  readonly gh: GhRunner;
}

/**
 * A `gh` runner on a sandbox: each command is parsed against the allowlist
 * and run by the runtime under the lease its effect calls for.
 *
 * @param sandbox - The orchestrator's sandbox, where its `gh` commands run.
 * @param lease - Overrides for the credential lease. The test suite's seam.
 */
export const sandboxGhRunner =
  (sandbox: LeaseSandbox, lease?: LeaseDependencies): GhRunner =>
  (args) => {
    const parsed = parseGh(args);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    const { invocation } = parsed;
    return runGh(
      sandbox,
      invocation,
      invocation.effect.kind === "read" ? "repo-read" : "repo-triage",
      lease
    );
  };

/**
 * Labels that record a decision about an issue, by GitHub's default names.
 *
 * @remarks
 * Whether an issue is a duplicate, invalid, or not going to be done is for
 * whoever reads it to decide, not for a label picker that was asked which
 * labels fit: a body that repeats another issue's wording reads as
 * `duplicate` to it whether or not any issue matches. Triage reports its
 * duplicate candidates separately, for the orchestrator to read first.
 */
export const VERDICT_LABELS: readonly string[] = [
  "duplicate",
  "invalid",
  "wontfix",
];

/**
 * Whether triage may offer a repository label to the decision model.
 *
 * @returns False for a verdict label, for the label that hands an issue to
 * the factory, and for a name with a comma in it, which `gh` would split
 * into two labels on `--add-label`.
 */
export const isOffered = (name: string): boolean => {
  const lower = name.trim().toLowerCase();
  return (
    !(name.includes(",") || VERDICT_LABELS.includes(lower)) &&
    lower !== FACTORY_LABEL.toLowerCase()
  );
};

/**
 * Triages one work item end to end: reads it, asks the decision model,
 * and applies the labels it chose.
 *
 * @remarks
 * This is the whole of what the `triage_work_item` tool does, kept apart
 * from the tool so the run can also do it before the orchestrator's first
 * turn (`pretriage.ts`). Both go through here, so they cannot drift.
 *
 * @returns The decision, the labels applied, the duplicates it named with
 * their titles, and the issue's own state when there was one.
 * @throws When there is nothing to triage, or a `gh` call or the decision
 * call fails.
 */
export const runTriage = async (
  request: TriageRequest,
  { gh, ...decision }: TriageDependencies
) => {
  const issue =
    request.issueNumber === undefined
      ? null
      : await fetchIssue(gh, request.issueNumber);
  const item = issue ?? {
    body: request.body ?? "",
    title: request.title ?? "",
  };
  if (item.title.trim() === "" && item.body.trim() === "") {
    throw new Error("Pass issue_number, or a title and body to triage.");
  }

  const [vocabulary, candidates] = await Promise.all([
    fetchLabels(gh),
    findDuplicateCandidates(gh, item.title, issue?.number ?? null),
  ]);
  const labels = vocabulary.filter((label) => isOffered(label.name));
  const triage = await triageWorkItem(item, labels, candidates, decision);

  const applied =
    issue !== null && request.applyLabels
      ? await applyLabels(gh, issue, triage.labels)
      : [];

  return {
    ...triage,
    applied_labels: applied,
    duplicate_candidates: candidates.filter((candidate) =>
      triage.duplicates.includes(candidate.number)
    ),
    issue:
      issue === null
        ? null
        : {
            existing_labels: issue.labels,
            number: issue.number,
            state: issue.state,
            title: issue.title,
          },
    labels_not_considered:
      vocabulary.length - Math.min(labels.length, TRIAGE_LIMITS.labels),
  };
};

export type TriageResult = Awaited<ReturnType<typeof runTriage>>;
