import { disableTool } from "eve/tools";

/**
 * Disabled on the orchestrator.
 *
 * @remarks
 * The orchestrator routes work and never writes code, so it has no use for
 * a tool that changes files. It does have a shell (`agent/tools/bash.ts`),
 * which is there for `gh`. Leaving this tool off keeps the orchestrator's
 * tool list in line with its job; it is not a security boundary, since a
 * shell can write a file too. What bounds the shell is its credential, which
 * only reads (`agent/lib/github/tools.ts`). Reading the checkout
 * (`read_file`, `glob`, `grep`) is unaffected. Stations keep these tools in
 * their own sandboxes.
 */
export default disableTool();
