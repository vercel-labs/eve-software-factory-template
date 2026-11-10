import { defineEval } from "eve/evals";
import { GH_TOOL, ghInput } from "../helpers.js";

const createsIssue = ghInput({ command: "issue create", effect: "write" });

export default defineEval({
  description:
    "Creating an issue from an untrusted session parks on an approval card with the gh issue create call itself pending; the eval principal is untrusted, so this is also what the dev TUI shows.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    const turn = await t.send(
      'Open a new issue on the repository titled "Track the flaky login test" with a one-line body. No need to summarize the repo first.'
    );
    t.awaitingInput();
    turn.session.requireInteraction({
      input: createsIssue,
      toolName: GH_TOOL,
    });
    t.calledTool(GH_TOOL, { input: createsIssue, status: "pending" });
  },
});
