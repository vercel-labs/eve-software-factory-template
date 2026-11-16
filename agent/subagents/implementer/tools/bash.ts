import { bashTool } from "../../../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * The implementer's shell (`bashTool` in `agent/lib/github/tools.ts`). `gh`
 * reads; `git push` delivers the branch, and only to the factory's own
 * branches.
 */
export default bashTool({ environment, role: "implementer" });
