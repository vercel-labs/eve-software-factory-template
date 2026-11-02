import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { CLASSIFIER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `classifier` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent().send()` takes one per message.
 * - Named `run_classifier`, not `classifier`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Classify an incoming work item: type (bug/feature/refactor/question/chore/security), " +
    "priority, complexity, affected area, and whether it is actionable or needs " +
    "clarification. Fast triage only; no analysis or implementation. The caller passes " +
    "the work item verbatim in the message.",
  async execute({ message }, ctx) {
    "use workflow";
    const response = await ctx.agent("classifier").send(message, {
      outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
      signal: ctx.abortSignal,
    });
    const result = await response.result();
    if (result.status === "failed") {
      throw new Error(`The classifier failed: ${result.error.message}`);
    }
    if (result.status === "cancelled") {
      throw new Error("The classifier was cancelled.");
    }
    if (result.data === undefined) {
      throw new Error("The classifier completed without structured output.");
    }
    return result.data;
  },
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        "Everything the station needs; it does not see your conversation history."
      ),
  }),
});
