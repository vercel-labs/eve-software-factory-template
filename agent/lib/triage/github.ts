import type { DuplicateCandidate, RepoLabel, WorkItem } from "./decisions.js";

/**
 * The GitHub reads and writes triage needs, expressed as `gh` commands.
 *
 * @remarks
 * Every function takes a {@link GhRunner}, so the tools pass one that runs
 * the real binary under a credential lease, and the test suite passes one
 * that answers from fixtures. Nothing here talks to GitHub by any other
 * route.
 */
export type GhRunner = (args: readonly string[]) => Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}>;

const parseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const fail = (
  what: string,
  result: { exitCode: number; stderr: string; stdout: string }
) => {
  const detail =
    result.stderr.trim() || result.stdout.trim() || "gh printed nothing";
  return new Error(
    `${what} failed (gh exit ${result.exitCode}): ${detail.slice(0, 500)}`
  );
};

export interface FetchedIssue extends WorkItem {
  readonly labels: readonly string[];
  readonly number: number;
  readonly state: string;
}

/**
 * Reads one issue's title, body, state, and current labels.
 *
 * @throws When `gh` fails or its output is not an issue.
 */
export const fetchIssue = async (
  gh: GhRunner,
  number: number
): Promise<FetchedIssue> => {
  const result = await gh([
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,body,state,labels",
  ]);
  const issue = parseJson(result.stdout) as {
    body?: unknown;
    labels?: unknown;
    state?: unknown;
    title?: unknown;
  } | null;
  if (
    result.exitCode !== 0 ||
    issue === null ||
    typeof issue.title !== "string"
  ) {
    throw fail(`Reading issue #${number}`, result);
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return {
    body: typeof issue.body === "string" ? issue.body : "",
    labels: labels
      .map((label) => (label as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === "string"),
    number,
    state: typeof issue.state === "string" ? issue.state : "UNKNOWN",
    title: issue.title,
  };
};

export const LABEL_FETCH_LIMIT = 100;

/**
 * Reads the repository's label vocabulary, up to {@link LABEL_FETCH_LIMIT}.
 *
 * @throws When `gh` fails or its output is not a list.
 */
export const fetchLabels = async (gh: GhRunner): Promise<RepoLabel[]> => {
  const result = await gh([
    "label",
    "list",
    "--json",
    "name,description",
    "--limit",
    String(LABEL_FETCH_LIMIT),
  ]);
  const labels = parseJson(result.stdout);
  if (result.exitCode !== 0 || !Array.isArray(labels)) {
    throw fail("Listing labels", result);
  }
  return labels
    .filter(
      (label): label is { description?: unknown; name: string } =>
        typeof (label as { name?: unknown } | null)?.name === "string"
    )
    .map((label) => ({
      description:
        typeof label.description === "string" ? label.description : null,
      name: label.name,
    }));
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "but",
  "can",
  "cannot",
  "could",
  "does",
  "doesn",
  "error",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "issue",
  "not",
  "our",
  "should",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "when",
  "with",
  "would",
  "you",
  "your",
]);

const WORD_PATTERN = /[A-Za-z0-9][A-Za-z0-9_-]{2,}/g;
export const DUPLICATE_SEARCH_TERMS = 5;

/**
 * Builds the search query used to find possible duplicates of a work item.
 *
 * @remarks
 * The query is built from the title's most distinctive words, joined with
 * OR, limited to titles. Only plain word characters survive, so nothing from
 * an untrusted title can add a search qualifier (`repo:`, `author:`) of its
 * own.
 *
 * @returns The query, or null when the title has no usable words.
 */
export const duplicateSearchQuery = (title: string): string | null => {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const match of title.matchAll(WORD_PATTERN)) {
    const word = match[0].toLowerCase();
    if (!(STOP_WORDS.has(word) || seen.has(word))) {
      seen.add(word);
      words.push(word);
    }
  }
  if (words.length === 0) {
    return null;
  }
  // Longer words are the more distinctive ones; keep title order among ties.
  const chosen = [...words]
    .sort((a, b) => b.length - a.length)
    .slice(0, DUPLICATE_SEARCH_TERMS);
  const ordered = words.filter((word) => chosen.includes(word));
  return `${ordered.join(" OR ")} in:title`;
};

export const DUPLICATE_FETCH_LIMIT = 15;

/**
 * Finds existing issues that might report the same thing.
 *
 * @remarks
 * A failed search is not fatal to triage: it returns no candidates, and the
 * item is classified without a duplicate check.
 *
 * @param exclude - The work item's own issue number, left out of the
 * results; null when it is not an issue.
 */
export const findDuplicateCandidates = async (
  gh: GhRunner,
  title: string,
  exclude: number | null
): Promise<DuplicateCandidate[]> => {
  const query = duplicateSearchQuery(title);
  if (query === null) {
    return [];
  }
  const result = await gh([
    "issue",
    "list",
    "--state",
    "all",
    "--search",
    query,
    "--json",
    "number,title,state",
    "--limit",
    String(DUPLICATE_FETCH_LIMIT),
  ]);
  const issues = parseJson(result.stdout);
  if (result.exitCode !== 0 || !Array.isArray(issues)) {
    return [];
  }
  return issues
    .filter(
      (issue): issue is { number: number; state?: unknown; title: string } => {
        const candidate = issue as { number?: unknown; title?: unknown } | null;
        return (
          typeof candidate?.number === "number" &&
          typeof candidate.title === "string" &&
          candidate.number !== exclude
        );
      }
    )
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      ...(typeof issue.state === "string" ? { state: issue.state } : {}),
    }));
};

/**
 * Adds labels to an issue, skipping the ones it already has.
 *
 * @returns The labels that were actually added.
 * @throws When the edit fails.
 */
export const applyLabels = async (
  gh: GhRunner,
  issue: { readonly labels: readonly string[]; readonly number: number },
  labels: readonly string[]
): Promise<string[]> => {
  const missing = [...new Set(labels)].filter(
    (label) => !issue.labels.includes(label)
  );
  if (missing.length === 0) {
    return [];
  }
  const result = await gh([
    "issue",
    "edit",
    String(issue.number),
    ...missing.flatMap((label) => ["--add-label", label]),
  ]);
  if (result.exitCode !== 0) {
    throw fail(`Labeling issue #${issue.number}`, result);
  }
  return missing;
};

export interface FailingCheck {
  readonly link: string | null;
  readonly name: string;
  readonly runId: string | null;
  readonly workflow: string | null;
}

const RUN_ID_PATTERN = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;

/** Extracts the Actions run id from a check's details link, when it has one. */
export const runIdFromLink = (link: string | null): string | null => {
  const [, runId] = link?.match(RUN_ID_PATTERN) ?? [];
  return runId ?? null;
};

export interface CheckSummary {
  /** Checks a person or a newer push cancelled: neither passing nor failing. */
  readonly cancelled: number;
  readonly failing: readonly FailingCheck[];
  readonly pending: number;
  readonly total: number;
}

const NO_CHECKS = /no checks reported/i;

/**
 * Reads a pull request's checks and picks out the failing ones.
 *
 * @remarks
 * `gh pr checks` exits non-zero whenever a check is failing or pending, so
 * the exit code says nothing here; the JSON is the answer. A pull request
 * with no checks at all is reported by `gh` as an error with no JSON, and
 * comes back from here as an empty summary.
 *
 * @throws When `gh` prints no JSON for any other reason.
 */
export const fetchChecks = async (
  gh: GhRunner,
  pullRequest: number
): Promise<CheckSummary> => {
  const result = await gh([
    "pr",
    "checks",
    String(pullRequest),
    "--json",
    "name,state,bucket,link,workflow",
  ]);
  const checks = parseJson(result.stdout);
  if (!Array.isArray(checks)) {
    if (NO_CHECKS.test(result.stderr)) {
      return { cancelled: 0, failing: [], pending: 0, total: 0 };
    }
    throw fail(`Reading checks for #${pullRequest}`, result);
  }
  const rows = checks as readonly {
    bucket?: unknown;
    link?: unknown;
    name?: unknown;
    workflow?: unknown;
  }[];
  return {
    cancelled: rows.filter((check) => check.bucket === "cancel").length,
    failing: rows
      .filter((check) => check.bucket === "fail")
      .map((check) => {
        const link = typeof check.link === "string" ? check.link : null;
        return {
          link,
          name: typeof check.name === "string" ? check.name : "unknown",
          runId: runIdFromLink(link),
          workflow: typeof check.workflow === "string" ? check.workflow : null,
        };
      }),
    pending: rows.filter((check) => check.bucket === "pending").length,
    total: rows.length,
  };
};

export const MAX_RUNS_READ = 2;

/**
 * Reads the failed-step logs of the runs behind the failing checks, for at
 * most {@link MAX_RUNS_READ} runs.
 *
 * @remarks
 * A run whose log can't be read contributes nothing rather than failing the
 * diagnosis.
 *
 * @returns The logs, or an empty string when there is no log to judge.
 */
export const fetchFailedLogs = async (
  gh: GhRunner,
  failing: readonly FailingCheck[]
): Promise<string> => {
  const runIds = [
    ...new Set(failing.map((check) => check.runId).filter((id) => id !== null)),
  ].slice(0, MAX_RUNS_READ);
  const results = await Promise.all(
    runIds.map((runId) => gh(["run", "view", runId, "--log-failed"]))
  );
  return results
    .filter((result) => result.exitCode === 0 && result.stdout.trim() !== "")
    .map((result) => result.stdout)
    .join("\n");
};
