import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * Station 3: implementation.
 *
 * @remarks
 * Executes the analyst's plan in its own checkout of the factory repository,
 * verifies the work with the repository's own checks, commits on a feature
 * branch, and pushes it with `git push` in its shell. The station's `bash`
 * tool takes that one command out of the shell, parses it, and runs the
 * push itself (`agent/lib/github/tools.ts`). The push is the station's only
 * side effect, and it is bounded in code: only branches under the factory's
 * own prefix (`FACTORY_BRANCH_PREFIX`), never main or master, no force and
 * no deletes; the credential is leased for that one command at the sandbox
 * firewall and scoped to repository contents. A pushed branch can still
 * start whatever the repository runs on a push, so the default branch needs
 * branch protection all the same. The pull request is opened later by the
 * orchestrator, after review.
 *
 * `tool: false` hides the station from the orchestrator, which runs it
 * through the `run_implementer` workflow tool
 * (`agent/lib/stations/schemas.ts` says why the two names differ).
 */
export default defineAgent({
  description:
    "Execute an approved implementation plan in a checkout of the factory repository: " +
    "write the code on a feature branch, run the repository's own checks, commit, and " +
    "push the branch. Returns the branch name, per-file change summary, verification " +
    "results, and deviations. The caller passes the work item, classification, and full " +
    "analysis in the message, plus an artifact id when the analyst saved its full detail " +
    "as one; on a revision run it also passes the existing branch and the reviewer's " +
    "findings.",
  model: MODELS.implementer,
  tool: false,
});
