import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * The clarification station.
 *
 * @remarks
 * Routine triage is not an agent turn: `triage_work_item` classifies a work
 * item with a decision model in one call. The orchestrator falls back to
 * this station when that says the item needs clarification (a decision
 * model can pick an option but cannot write the questions to ask), or when
 * triage itself is unavailable.
 *
 * Runs on a fast, cheap model because classification is a shaping step, not
 * an analysis step. The station receives only text (the work item plus any
 * thread context the orchestrator packs into `message`) and returns the
 * structured classification the rest of the pipeline routes on.
 * `needs_clarification` is the pipeline's stop signal; the orchestrator asks
 * the human instead of proceeding on guesses.
 *
 * `tool: false` hides the station from the orchestrator, which runs it
 * through the `run_classifier` workflow tool
 * (`agent/lib/stations/schemas.ts` says why the two names differ).
 */
export default defineAgent({
  description:
    "Classify an incoming work item: type (bug/feature/refactor/question/chore/security), " +
    "priority, complexity, affected area, and whether it is actionable or needs " +
    "clarification. Fast triage only; no analysis or implementation. The caller passes " +
    "the work item verbatim in the message.",
  model: MODELS.classifier,
  tool: false,
});
