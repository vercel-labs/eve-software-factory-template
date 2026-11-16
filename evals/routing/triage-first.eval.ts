import { defineEval } from "eve/evals";
import { calledInOrder, TRIAGE_TOOL } from "../helpers.js";

export default defineEval({
  description:
    "A work item enters the pipeline through triage before any analysis happens: a clear item goes from triage straight to the analyst without the classifier station, and an explicit stop-after-analysis instruction keeps the implementer idle.",
  tags: ["slow", "needs-connect"],
  async test(t) {
    await t.send(
      "Work item: users report that password reset emails sometimes arrive twice. Triage this and produce the implementation plan, but stop after analysis and report the plan to me; do not implement anything yet."
    );
    t.succeeded();
    t.calledTool(TRIAGE_TOOL);
    t.calledTool("run_analyst");
    t.notCalledTool("run_classifier");
    t.notCalledTool("run_implementer");
    t.eventsSatisfy("triage runs before the analyst", (events) =>
      calledInOrder(events, [TRIAGE_TOOL, "run_analyst"])
    );
  },
});
