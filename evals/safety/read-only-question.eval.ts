import { defineEval } from "eve/evals";
import {
  BRAIN_WRITE_TOOLS,
  NO_GITHUB_WRITES,
  noGithubWrites,
} from "../helpers.js";

export default defineEval({
  description:
    "A read-only question about the repository is answered with reads alone: no GitHub write is attempted, the shared factory brain is not written, and no station with side effects runs.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "What is this repository about, and what does its README say about getting started?"
    );
    t.succeeded();
    t.notCalledTool("run_implementer");
    t.eventsSatisfy(NO_GITHUB_WRITES, noGithubWrites);
    for (const tool of BRAIN_WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
