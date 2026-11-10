import { ghTool } from "../../../lib/github/tools.js";
import { environment } from "../sandbox.js";

/** Read-only `gh` for this station. See `agent/lib/github/tools.ts`. */
export default ghTool({ environment, mode: "read-only" });
