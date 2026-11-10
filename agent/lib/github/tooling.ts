import type { VercelSandboxSession } from "eve/sandbox/vercel";
import { GH_BINARY } from "./cli.js";
import { GIT_BINARY } from "./git-cli.js";

/**
 * Bump when {@link installFactoryTooling} changes.
 *
 * @remarks
 * A sandbox template is keyed by its own source file and create options, not
 * by the modules it imports, so a change to this module alone would not
 * rebuild the template. Each sandbox passes this value in its create options
 * (`env`), which re-keys every template when it moves.
 */
export const FACTORY_TOOLING_VERSION = "1";

/**
 * Installs what the factory needs beyond eve's base image: the GitHub CLI
 * and pnpm.
 *
 * @remarks
 * Runs in a sandbox's `prepare` callback, once per template snapshot, never
 * per session.
 *
 * - `gh` comes from the image's own package archive (Ubuntu), signed and
 *   verified by apt. git already ships in the image.
 * - pnpm is no longer in the base image, and the documented
 *   `FACTORY_SETUP_COMMAND` is `pnpm install`, so it is installed here.
 *
 * The final checks pin the paths the tools invoke: a missing binary fails
 * the build, not the first run.
 */
export async function installFactoryTooling(
  sandbox: VercelSandboxSession
): Promise<void> {
  const result = await sandbox.run({
    command: [
      "set -e",
      'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
      `if [ ! -x ${GH_BINARY} ]; then`,
      "  $SUDO apt-get update",
      "  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y gh",
      "fi",
      "command -v pnpm >/dev/null 2>&1 || npm install -g pnpm || $SUDO npm install -g pnpm",
      `[ -x ${GH_BINARY} ] || { echo 'the GitHub CLI is missing at ${GH_BINARY}' >&2; exit 1; }`,
      `[ -x ${GIT_BINARY} ] || { echo 'git is missing at ${GIT_BINARY}' >&2; exit 1; }`,
      `${GH_BINARY} --version`,
      `${GIT_BINARY} --version`,
      "pnpm --version",
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Installing the factory's sandbox tooling failed (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout
      )
        .trim()
        .slice(-2000)}`
    );
  }
}
