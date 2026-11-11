import { disableTool } from "eve/tools";

/**
 * Disabled on the orchestrator. Do not re-enable it.
 *
 * @remarks
 * The orchestrator routes work and never writes code, so it has no use for
 * a tool that changes files. It matters for safety as well: the runtime runs
 * the orchestrator's approved `gh` writes in the orchestrator's sandbox, and
 * that is only safe while nothing the orchestrator reads can put a file or a
 * process there. It has no shell (`agent/tools/bash.ts` accepts only `gh`
 * commands, which the runtime runs) and, with this tool off, no way to write
 * a file. Reading the checkout (`read_file`, `glob`, `grep`) is unaffected.
 * Stations keep these tools in their own sandboxes.
 */
export default disableTool();
