/**
 * Turns off package install scripts in a station's sandbox.
 *
 * @remarks
 * An install script (`preinstall`, `install`, `postinstall`) is how a
 * compromised package usually gets to run code, and whatever it leaves in a
 * station sandbox is still there when the implementer's push runs (see the
 * push paragraph in `agent/lib/github/tools.ts`). So each station session
 * writes the user-level "do not run install scripts" setting
 * ({@link INSTALL_SCRIPT_SETTINGS}) before `FACTORY_SETUP_COMMAND` runs:
 *
 * - npm, and pnpm up to 10, read `~/.npmrc`.
 * - pnpm 11 and later read only pnpm's own `config.yaml`. pnpm is installed
 *   unpinned (`tooling.ts`), so both are written.
 * - Yarn 1 reads `~/.yarnrc`; Yarn 2 and later read `~/.yarnrc.yml`.
 *
 * What it does, checked against the real package managers in
 * `tests/github/install-scripts.test.ts`:
 *
 * - It covers the install scripts of dependencies and of the repository's
 *   own `package.json`. Scripts run by name (`pnpm run build`, `npm test`)
 *   are untouched, which is how the stations build and test.
 * - With pnpm it also wins over the repository's build allowlist
 *   (`allowBuilds`): an approved dependency is still not built and the
 *   install still exits 0, so the first sign is a later failure in
 *   whatever needed the build.
 *
 * A repository whose install step does real work in a script names that
 * step in `FACTORY_SETUP_COMMAND` (`pnpm install && pnpm run generate`), or
 * the deployer sets {@link INSTALL_SCRIPTS_ENV} to `1`.
 *
 * These are files in a sandbox where the agent has a shell: a default, not
 * a boundary. They stop the automatic case, which is the one an attacker
 * who controls a package relies on.
 */

/** Set to `1` to let package managers run install scripts in the sandbox. */
export const INSTALL_SCRIPTS_ENV = "FACTORY_ALLOW_INSTALL_SCRIPTS";

/** Whether install scripts stay off, read when a session starts. */
export const installScriptsBlocked = (): boolean =>
  process.env[INSTALL_SCRIPTS_ENV]?.trim() !== "1";

/** One settings line and the file it belongs in, as the shell names it. */
interface Setting {
  readonly file: string;
  readonly line: string;
}

/** pnpm's own config directory, as the shell resolves it. */
const PNPM_CONFIG_DIR =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, expanded by the sandbox's shell
  '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm"';

export const INSTALL_SCRIPT_SETTINGS: readonly Setting[] = [
  { file: '"$HOME/.npmrc"', line: "ignore-scripts=true" },
  { file: `${PNPM_CONFIG_DIR}/config.yaml`, line: "ignoreScripts: true" },
  { file: '"$HOME/.yarnrc"', line: "ignore-scripts true" },
  { file: '"$HOME/.yarnrc.yml"', line: "enableScripts: false" },
];

/**
 * The shell command that writes the settings.
 *
 * @remarks
 * Safe to run again on the same sandbox, which eve does when a session's
 * initialization is retried: a line is appended only when the file does not
 * already hold exactly that line, so a file never grows and anything else
 * in it is kept.
 */
export const INSTALL_SCRIPTS_OFF_COMMAND = [
  `mkdir -p ${PNPM_CONFIG_DIR}`,
  ...INSTALL_SCRIPT_SETTINGS.map(
    ({ file, line }) =>
      `{ grep -qxF -- '${line}' ${file} 2>/dev/null || printf '%s\\n' '${line}' >> ${file}; }`
  ),
].join(" && ");
