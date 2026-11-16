import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { labelDecision } from "../lib/github/approval.js";
import { parseGh } from "../lib/github/cli.js";
import { runGh } from "../lib/github/lease.js";
import {
  COMPLEXITIES,
  PRIORITIES,
  TRIAGE_LIMITS,
  triageWorkItem,
  WORK_ITEM_TYPES,
} from "../lib/triage/decisions.js";
import {
  applyLabels,
  fetchIssue,
  fetchLabels,
  findDuplicateCandidates,
  type GhRunner,
} from "../lib/triage/github.js";
import { environment } from "../sandbox.js";

const inputSchema = z.object({
  apply_labels: z
    .boolean()
    .default(true)
    .describe(
      "Add the selected labels to the issue. Only applies with issue_number."
    ),
  body: z
    .string()
    .max(40_000)
    .optional()
    .describe("The work item's text, verbatim, when it is not a GitHub issue."),
  issue_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The GitHub issue to triage. Its title, body, and labels are read for you."
    ),
  title: z
    .string()
    .max(500)
    .optional()
    .describe("The work item's title, when it is not a GitHub issue."),
});

/**
 * Fast triage for one work item, by a decision model instead of an agent
 * turn.
 *
 * @remarks
 * One call classifies the item, picks its labels from the repository's own
 * vocabulary, checks it against likely duplicates, and says where it goes
 * next. The decision model can only choose among the options it is given
 * (`agent/lib/triage/decisions.ts`), so the labels it returns always exist,
 * and injected text in the work item has nothing to steer.
 *
 * Applying labels is a write, so the tool's approval follows the label
 * policy: unattended and trusted runs apply them directly, anyone else is
 * asked first. Reads need no approval.
 */
export default defineTool({
  approval: (ctx) =>
    ctx.toolInput?.issue_number !== undefined &&
    ctx.toolInput.apply_labels !== false
      ? labelDecision(ctx.session.auth.current)
      : "not-applicable",
  description:
    "Triage a work item in one fast step: type, priority, complexity, whether it is actionable or needs clarification or outside research, which existing repository labels fit, and whether it duplicates an existing issue. Pass issue_number for a GitHub issue (its labels are applied for you), or title and body for anything else. Returns a lane saying what to do next: pipeline, clarify, answer, or duplicate. Call this first for every work item.",
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    const gh: GhRunner = (args) => {
      const parsed = parseGh(args);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }
      const { invocation } = parsed;
      return runGh(
        sandbox,
        invocation,
        invocation.effect.kind === "read" ? "repo-read" : "repo-triage"
      );
    };

    const issue =
      input.issue_number === undefined
        ? null
        : await fetchIssue(gh, input.issue_number);
    const item = issue ?? {
      body: input.body ?? "",
      title: input.title ?? "",
    };
    if (item.title.trim() === "" && item.body.trim() === "") {
      throw new Error("Pass issue_number, or a title and body to triage.");
    }

    const [vocabulary, candidates] = await Promise.all([
      fetchLabels(gh),
      findDuplicateCandidates(gh, item.title, issue?.number ?? null),
    ]);
    // `gh` splits --add-label on commas, so a label with a comma in its name
    // can't be applied this way; leave it out rather than fail the triage.
    const labels = vocabulary.filter((label) => !label.name.includes(","));
    const triage = await triageWorkItem(item, labels, candidates, {
      decide,
      signal: ctx.abortSignal,
    });

    const applied =
      issue !== null && input.apply_labels
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
  },
  inputSchema,
  outputSchema: z.object({
    actionable: z.boolean(),
    applied_labels: z.array(z.string()),
    complexity: z.enum(COMPLEXITIES),
    confidence: z.object({
      complexity: z.number().nullable(),
      priority: z.number().nullable(),
      type: z.number().nullable(),
    }),
    duplicate_candidates: z.array(
      z.object({
        number: z.number(),
        state: z.string().optional(),
        title: z.string(),
      })
    ),
    duplicates: z.array(z.number()),
    issue: z
      .object({
        existing_labels: z.array(z.string()),
        number: z.number(),
        state: z.string(),
        title: z.string(),
      })
      .nullable(),
    labels: z.array(z.string()),
    labels_not_considered: z
      .number()
      .describe(
        "How many repository labels were not evaluated (beyond the limit, or not applicable by name). When above zero, a fitting label may have been missed."
      ),
    lane: z.enum(["pipeline", "clarify", "answer", "duplicate"]),
    needs_clarification: z.boolean(),
    needs_research: z.boolean(),
    priority: z.enum(PRIORITIES),
    type: z.enum(WORK_ITEM_TYPES),
  }),
});
