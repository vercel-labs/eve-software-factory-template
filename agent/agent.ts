import { defineAgent } from "eve";
import { MODELS } from "./lib/models.js";

/**
 * Output tokens a single session may spend before it stops to ask.
 *
 * @remarks
 * The orchestrator and each station count their own usage against this
 * limit; a station's spend is added to the orchestrator's when its `run_*`
 * tool settles.
 */
export const SESSION_OUTPUT_TOKEN_LIMIT = 100_000;

/** eve's default cap on uncached input tokens per session window. */
export const SESSION_INPUT_TOKEN_LIMIT = 40_000_000;

/**
 * Root agent runtime configuration: the model and session budget for
 * Foreman, the software factory orchestrator.
 *
 * @remarks
 * The rest of the agent's surface (channels, connections, memory, tools,
 * skills, subagents) is discovered from the filesystem under `agent/`.
 * Conversation history is compacted once it reaches 75% of the context
 * window.
 *
 * The usage limit is a runaway guard, not a hard stop: when a session
 * crosses it, eve asks on the session's channel whether to keep going, and
 * an approval starts a fresh window. A session with nobody to ask fails its
 * next model call instead. Authoring the callback replaces eve's default
 * input cap, so that cap is restated here.
 */
export default defineAgent({
  compaction: { threshold: 0.75 },
  limits: {
    sessionUsage: ({ window }) =>
      window.outputTokens >= SESSION_OUTPUT_TOKEN_LIMIT ||
      window.inputTokens - window.cacheReadTokens >= SESSION_INPUT_TOKEN_LIMIT,
  },
  model: MODELS.orchestrator,
});
