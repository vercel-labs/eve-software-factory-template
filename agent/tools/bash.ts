import { bashTool } from "../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * The orchestrator's shell, where it uses `gh` like any developer would.
 *
 * @remarks
 * Reads run under a read-only credential. A command that changes GitHub is
 * parsed against the allowlist and held to the caller's trust class before
 * the runtime runs it (`agent/lib/github/tools.ts`). The orchestrator never
 * pushes.
 */
export default bashTool({ environment, role: "orchestrator" });
