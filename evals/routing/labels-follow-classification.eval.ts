import { defineEval, type EveEvalSession } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  calledBeforeAny,
  ghLabelWrites,
  TRIAGE_TOOL,
  toolRequests,
  triageAppliesLabels,
} from "../helpers.js";

/** Stations that must not start before triage has run. */
const STATION_TOOLS = [
  "run_classifier",
  "run_researcher",
  "run_analyst",
  "run_implementer",
  "run_reviewer",
];

const appliesLabelsToIssueOne = (input: unknown): boolean =>
  triageAppliesLabels(input, 1);

export default defineEval({
  description:
    "Triaging a GitHub issue mirrors the result onto it as labels through the triage tool, never by hand: triage is called for issue #1 with label application on, the untrusted eval principal parks on that call because it writes labels (a progress comment may park alongside it), no station runs first, and no gh label write is issued. Needs at least one open issue (#1) on FACTORY_REPO.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    const turn = await t.send(
      "Triage issue #1 on the repository and mirror the result onto the issue as labels, then stop; do not run the analyst or any later station."
    );
    t.awaitingInput();
    t.calledTool(TRIAGE_TOOL, {
      input: appliesLabelsToIssueOne,
      status: "pending",
    });
    t.notCalledTool("run_analyst");
    t.notCalledTool("run_implementer");
    t.check(
      turn.session.pendingInteractions,
      satisfies(
        (pending: EveEvalSession["pendingInteractions"]) =>
          pending.some(
            (interaction) =>
              interaction.call?.name === TRIAGE_TOOL &&
              appliesLabelsToIssueOne(interaction.call.input)
          ),
        "the label-applying triage call for issue #1 is among the pending approvals"
      )
    );
    t.eventsSatisfy("triage runs before any station", (events) =>
      calledBeforeAny(events, TRIAGE_TOOL, STATION_TOOLS)
    );
    t.eventsSatisfy(
      "no label is written by hand with gh, before triage or alongside it",
      (events) => ghLabelWrites(toolRequests(events)).length === 0
    );
  },
});
