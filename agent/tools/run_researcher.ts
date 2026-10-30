import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { RESEARCHER_OUTPUT_SCHEMA } from "../lib/stations/schemas.js";

/**
 * Blocking wrapper the orchestrator calls to run the `researcher` station.
 *
 * @remarks
 * - `defineAgent` has no `outputSchema` anymore; `ctx.agent().send()` takes one per message.
 * - Named `run_researcher`, not `researcher`: the compiler rejects a tool and a local subagent with the same public name.
 */
export default defineWorkflowTool({
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "caller doesn't already have. Runs refined searches against reliable sources and returns " +
    "cited findings with confidence levels, plus the gaps it couldn't verify. May save a " +
    "long research memo as an artifact and return its id for later stations. The caller " +
    "passes the question and any known context in the message.",
  async execute({ message }, ctx) {
    "use workflow";
    const response = await ctx.agent("researcher").send(message, {
      outputSchema: RESEARCHER_OUTPUT_SCHEMA,
      signal: ctx.abortSignal,
    });
    const result = await response.result();
    if (result.status === "failed") {
      throw new Error(`The researcher failed: ${result.error.message}`);
    }
    if (result.status === "cancelled") {
      throw new Error("The researcher was cancelled.");
    }
    if (result.data === undefined) {
      throw new Error("The researcher completed without structured output.");
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
