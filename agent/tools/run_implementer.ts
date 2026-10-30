import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { IMPLEMENTER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `implementer` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent().send()` takes one per message.
 * - Named `run_implementer`, not `implementer`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Execute an approved implementation plan in a checkout of the factory repository: " +
    "write the code on a feature branch, run the repository's own checks, commit, and " +
    "push the branch. Returns the branch name, per-file change summary, verification " +
    "results, and deviations. The caller passes the work item, classification, and full " +
    "analysis in the message, plus an artifact id when the analyst saved its full detail " +
    "as one; on a revision run it also passes the existing branch and the reviewer's " +
    "findings.",
  async execute({ message }, ctx) {
    "use workflow";
    const response = await ctx.agent("implementer").send(message, {
      outputSchema: IMPLEMENTER_OUTPUT_SCHEMA,
      signal: ctx.abortSignal,
    });
    const result = await response.result();
    if (result.status === "failed") {
      throw new Error(`The implementer failed: ${result.error.message}`);
    }
    if (result.status === "cancelled") {
      throw new Error("The implementer was cancelled.");
    }
    if (result.data === undefined) {
      throw new Error("The implementer completed without structured output.");
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
