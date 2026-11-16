import { disableTool } from "eve/tools";

/**
 * Disabled on the orchestrator. Do not re-enable it.
 *
 * @remarks
 * With no shell and no tool that writes a file, nothing the orchestrator
 * reads can put a file or a process in the sandbox where the runtime runs
 * its approved `gh` writes. `agent/tools/edit_file.ts` has the full account.
 */
export default disableTool();
