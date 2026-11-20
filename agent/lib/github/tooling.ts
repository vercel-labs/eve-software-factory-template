import { createHash } from "node:crypto";
import type { VercelSandboxSession } from "eve/sandbox/vercel";
import { GH_BINARY } from "./cli.js";
import { GIT_BINARY } from "./git-cli.js";
import { ghShim, gitShim, SHIM_DIRECTORY } from "./shims.js";

/** Marks the end of a wrapper script inside the install command. */
const SCRIPT_END = "FACTORY_WRAPPER_SCRIPT_END";

const seed = (name: string, script: string): string[] => {
  if (script.includes(SCRIPT_END)) {
    throw new Error(`The ${name} wrapper contains the heredoc delimiter.`);
  }
  const path = `${SHIM_DIRECTORY}/${name}`;
  return [
    // A quoted delimiter keeps the shell from expanding anything in the script.
    `$SUDO tee ${path} >/dev/null <<'${SCRIPT_END}'`,
    script.trimEnd(),
    SCRIPT_END,
    `$SUDO chmod 0755 ${path}`,
    `[ "$(command -v ${name})" = ${path} ] || { echo "${name} resolves to $(command -v ${name}), not the factory wrapper at ${path}" >&2; exit 1; }`,
  ];
};

/**
 * The shell script that sets up a factory sandbox.
 * {@link installFactoryTooling} says what it installs and checks.
 */
export const INSTALL_SCRIPT = [
  "set -e",
  'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
  `if [ ! -x ${GH_BINARY} ]; then`,
  "  $SUDO apt-get update",
  "  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y gh",
  "fi",
  "command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@12.21.0 || $SUDO npm install -g pnpm@12.21.0",
  `[ -x ${GH_BINARY} ] || { echo 'the GitHub CLI is missing at ${GH_BINARY}' >&2; exit 1; }`,
  `[ -x ${GIT_BINARY} ] || { echo 'git is missing at ${GIT_BINARY}' >&2; exit 1; }`,
  `$SUDO mkdir -p ${SHIM_DIRECTORY}`,
  ...seed("gh", ghShim()),
  ...seed("git", gitShim()),
  `${GH_BINARY} --version`,
  `${GIT_BINARY} --version`,
  "pnpm --version",
].join("\n");

/**
 * Identifies the sandbox setup, wrappers included.
 *
 * @remarks
 * A sandbox template is keyed by its own source file and create options, not
 * by the modules it imports, so a change to the installer or to a wrapper
 * alone would not rebuild the template. Each sandbox passes this value in
 * its create options (`env`), and it is a digest of the whole install
 * script, so any change there re-keys every template with no number to
 * bump.
 */
export const FACTORY_TOOLING_VERSION = createHash("sha256")
  .update(INSTALL_SCRIPT)
  .digest("hex")
  .slice(0, 16);

/**
 * Prepares a factory sandbox beyond eve's base image.
 *
 * @remarks
 * Runs in a sandbox's `prepare` callback, once per template snapshot, never
 * per session.
 *
 * - `gh` comes from the image's own package archive (Ubuntu), signed and
 *   verified by apt. git already ships in the image.
 * - pnpm is installed when the image lacks it, because the documented
 *   `FACTORY_SETUP_COMMAND` is `pnpm install`.
 * - The `gh` and `git` wrappers (`shims.ts`) are written to
 *   `/usr/local/bin`, which comes before `/usr/bin` on `PATH`, so the names
 *   an agent types resolve to them.
 *
 * The checks pin the paths the factory relies on: a missing binary, or a
 * `PATH` that does not put the wrappers first, fails the build, not the
 * first run.
 *
 * @throws When the install script exits nonzero, with the end of its
 * output.
 */
export async function installFactoryTooling(
  sandbox: VercelSandboxSession
): Promise<void> {
  const result = await sandbox.run({ command: INSTALL_SCRIPT });
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
