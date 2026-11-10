import { disableTool } from "eve/tools";

/**
 * Disabled on the orchestrator.
 *
 * @remarks
 * The orchestrator routes work and never writes code, so it has no need to
 * run commands or change files, and its sandbox is where its `gh` tool
 * runs. Without a shell or a way to write files, the only process the
 * orchestrator can start in that sandbox is `gh` with an argv the allowlist
 * accepted, which is what makes the allowlist a real boundary. Reading the
 * checkout (`read_file`, `glob`, `grep`) is unaffected. Stations keep these
 * tools in their own sandboxes.
 */
export default disableTool();
