import { defineSandbox } from "eve/sandbox";
import {
  createFactoryEnvironment,
  factoryInit,
  factoryOpenOptions,
} from "../../lib/github/repo-sandbox.js";

/**
 * Analyst sandbox: a ready-to-read checkout of the factory repository.
 *
 * @remarks
 * Stations share nothing with the root, so this one opens its own sandbox
 * from the shared builders in `agent/lib/github/repo-sandbox.ts`, which
 * hold the full account of the clone and setup. The analyst only reads; its
 * instructions forbid modification.
 */
export const environment = createFactoryEnvironment();

export default defineSandbox(async () => {
  const sandbox = await environment.open(factoryOpenOptions());
  await factoryInit(sandbox);
  return sandbox;
});
