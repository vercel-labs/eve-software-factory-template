import { defineEvalConfig } from "eve/evals";

/**
 * Run-wide eval configuration.
 *
 * @remarks
 * The judge model scores `t.judge(...)` assertions only; it never changes the
 * agent under test. `typesafe-ai/jev` (the default model of `decide` from
 * `eve/ai`, which `t.judge` calls) is left implicit rather than named here.
 * The judge is a decision model, not an ordinary language model: a plain chat
 * model id such as `google/gemini-3.6-flash` doesn't route through the
 * decision API, so a different judge has to be a provider's decision model.
 * Run the default loop with `pnpm eval --tag fast`; see the README's evals
 * section for the full matrix.
 */
export default defineEvalConfig({});
