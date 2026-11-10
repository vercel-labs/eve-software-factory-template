import { ghTool } from "../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * The orchestrator's `gh`: the GitHub CLI against the factory repository,
 * with writes gated by the trust policy. See `agent/lib/github/tools.ts`.
 */
export default ghTool({ environment, mode: "full" });
