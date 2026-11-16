import { defineEval } from "eve/evals";
import { calledInOrder, TRIAGE_TOOL } from "../helpers.js";

export default defineEval({
  description:
    "An ambiguous work item stops the pipeline at triage: triage sends it down the clarification path, the classifier station supplies the questions, the agent asks the requester instead of building on guesses, and nothing reaches the implementer.",
  tags: ["slow"],
  async test(t) {
    const turn = await t.send(
      "Something is wrong with the emails, you know the one I mean. Fix it properly this time."
    );
    t.calledTool(TRIAGE_TOOL);
    t.calledTool("run_classifier");
    t.notCalledTool("run_implementer");
    t.notCalledTool("run_reviewer");
    t.eventsSatisfy("triage runs before the classifier", (events) =>
      calledInOrder(events, [TRIAGE_TOOL, "run_classifier"])
    );
    const questions = turn.session.pendingInteractions
      .map((interaction) => interaction.request.prompt)
      .join("\n");
    t.judge(
      "Does the submission ask the user specific clarifying questions about which email problem they mean, rather than proceeding to build something or claiming work was done?",
      {
        on:
          turn.reply ||
          questions ||
          "(the run parked on a question instead of replying)",
      }
    ).atLeast(0.5);
  },
});
