import { bashTool } from "../../../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * The station's shell (`bashTool` in `agent/lib/github/tools.ts`). `git` and
 * `gh` read the factory repository here; nothing this station runs can
 * change GitHub.
 */
export default bashTool({ environment, role: "reader" });
