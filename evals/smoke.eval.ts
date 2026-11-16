import { defineEval } from "eve/evals";
import { NO_GITHUB_WRITES, noGithubWrites } from "./helpers.js";

export default defineEval({
  description:
    "A greeting doesn't spin up the factory line: the agent answers directly, runs neither the implementer nor the reviewer, and writes nothing to GitHub.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "Hi! What are you and what can you do for me on this repository?"
    );
    t.succeeded();
    t.notCalledTool("run_implementer");
    t.notCalledTool("run_reviewer");
    t.eventsSatisfy(NO_GITHUB_WRITES, noGithubWrites);
  },
});
