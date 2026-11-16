import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { stationPolicy } from "../lib/github/approval.js";
import { stationOutput } from "../lib/stations/result.js";
import { CLASSIFIER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `classifier` station.
 *
 * @remarks
 * Attaches the output schema per call, and throws when the station fails,
 * is cancelled, or returns no data (`stationOutput` in
 * `agent/lib/stations/result.ts`), so the orchestrator sees a tool error
 * instead of an empty result. Named `run_classifier`, not `classifier`:
 * the compiler rejects a tool and a local subagent with the same public
 * name.
 */
export default defineWorkflowTool({
  approval: stationPolicy,
  description:
    "Classify a work item with a language model and write the specific clarifying " +
    "questions to ask about it: type, priority, complexity, affected area, whether it is " +
    "actionable, and the questions. Use it when triage_work_item returns the clarify lane, " +
    "or when triage_work_item fails. The caller passes the work item verbatim in the message.",
  async execute({ message }, ctx) {
    "use workflow";
    const response = await ctx.agent("classifier").send(message, {
      outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
      signal: ctx.abortSignal,
    });
    return stationOutput("classifier", await response.result());
  },
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        "Everything the station needs; it does not see your conversation history."
      ),
  }),
});
