import { bashTool } from "../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * How the orchestrator runs `gh`.
 *
 * @remarks
 * The orchestrator types `gh` commands the way a developer would, and that
 * is all this accepts: one `gh` command, or several joined with `&&`. There
 * is no shell behind it. The runtime parses each command against the
 * allowlist, holds it to the caller's trust class, and runs it itself
 * (`agent/lib/github/tools.ts`), so nothing the orchestrator reads can start
 * a program in the sandbox where its writes run. The orchestrator never
 * pushes.
 */
export default bashTool({ environment, role: "orchestrator" });
