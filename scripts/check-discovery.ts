import { discover, isClean } from "./discovery.ts";

/**
 * `pnpm run discovery`: fails unless eve discovers the agent cleanly.
 *
 * @remarks
 * Stands in for a bare `eve info` in `pnpm validate`, because `eve info`
 * exits 0 even when the agent fails to compile.
 */
const discovery = discover();
const { errors, warnings } = discovery.diagnostics;
const summary = `status ${discovery.status}, ${errors} error(s), ${warnings} warning(s); model ${discovery.model}; ${discovery.tools.length} tools, ${discovery.subagents.length} stations`;

if (isClean(discovery)) {
  console.log(`eve discovery is clean: ${summary}`);
} else {
  console.error(
    `eve discovery is not clean: ${summary}\nRun "npx eve info" for the diagnostics.`
  );
  process.exitCode = 1;
}
