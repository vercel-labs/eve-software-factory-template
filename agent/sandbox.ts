import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import {
  FACTORY_SANDBOX_CREATE_OPTIONS,
  factoryOpenOptions,
} from "./lib/github/repo-sandbox.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Pins the hosted Vercel Sandbox backend for local development and
 * production alike, so the same environment runs everywhere. Running
 * locally requires the project to be linked and authenticated to Vercel.
 *
 * The post-open init marks `/workspace` as a safe git directory before the
 * GitHub channel's per-turn checkout (`agent/lib/github/checkout.ts`) runs
 * there. The sandbox filesystem is owned by the builder uid, not the session
 * user, so without this git aborts every command with "detected dubious
 * ownership in repository at '/workspace'", the failed checkout is logged
 * and swallowed, and the turn runs with no working tree. The station
 * sandboxes handle the same hazard for `/workspace/repo` in
 * `agent/lib/github/repo-sandbox.ts`.
 *
 * The sandbox opens with the factory's base egress policy
 * (`agent/lib/github/egress.ts`), like every station's: GitHub and the
 * public package registries, unless the deployer opened egress.
 *
 * @see {@link https://vercel.com/docs/sandbox | Vercel Sandbox}
 */
export const environment = VercelSandbox.environment(
  FACTORY_SANDBOX_CREATE_OPTIONS
);

export default defineSandbox(async () => {
  const sandbox = await environment.open(factoryOpenOptions());
  const result = await sandbox.run({
    command: "git config --global --add safe.directory /workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout
      ).trim()}`
    );
  }
  return sandbox;
});
