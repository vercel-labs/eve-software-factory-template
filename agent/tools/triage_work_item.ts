import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { labelDecision } from "../lib/github/approval.js";
import {
  COMPLEXITIES,
  PRIORITIES,
  WORK_ITEM_TYPES,
} from "../lib/triage/decisions.js";
import { runTriage, sandboxGhRunner } from "../lib/triage/run.js";
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
    "Triage a work item in one fast step: type, priority, complexity, whether it is actionable or needs clarification or outside research, which existing repository labels fit, and whether it duplicates an existing issue. Pass issue_number for a GitHub issue (its labels are applied for you), or title and body for anything else. Returns a lane saying what to do next: pipeline, clarify, answer, or duplicate. Call this first for every work item, unless a triage result for it is already in your context.",
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    return await runTriage(
      {
        applyLabels: input.apply_labels,
        body: input.body,
        issueNumber: input.issue_number,
        title: input.title,
      },
      { decide, gh: sandboxGhRunner(sandbox), signal: ctx.abortSignal }
    );
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
