import { defineAgent } from "eve";
import { MODELS } from "./lib/models.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Foreman, the software factory
 * orchestrator; the rest of the agent's surface (channels, connections,
 * extensions, tools, skills, subagents) is discovered from the filesystem
 * under `agent/`. Conversation history is compacted once it reaches 75% of
 * the context window. The output token limit caps each usage window while
 * leaving room for implementation work. Station sessions inherit this limit
 * and check their own usage; their usage also counts toward the root's window.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: {
    sessionUsage: ({ window }) => window.outputTokens >= 100_000,
  },
  model: MODELS.orchestrator,
});
