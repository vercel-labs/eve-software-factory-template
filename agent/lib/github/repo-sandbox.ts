import type { VercelSandboxSession } from "eve/sandbox/vercel";
import {
  VercelSandbox,
  type VercelSandboxEnvironmentOptions,
} from "eve/sandbox/vercel";
import { FACTORY_REPO } from "../constants.js";
import {
  appAccessMessage,
  describeCloneFailure,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "./bootstrap-diagnostics.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "./bot-name.js";
import { basePolicy, EGRESS_SETUP_HINT, egressMode } from "./egress.js";
import { GIT_BINARY } from "./git-cli.js";
import { REMOTE_URL } from "./git-remote.js";
import {
  INSTALL_SCRIPTS_OFF_COMMAND,
  installScriptsBlocked,
} from "./install-scripts.js";
import { type LeaseDependencies, runLeasedGitCommand } from "./lease.js";
import { FACTORY_TOOLING_VERSION, installFactoryTooling } from "./tooling.js";

// Snapshot settings shared by every factory sandbox environment. One kept
// snapshot keeps storage flat across template rebuilds; the 14-day expiration
// (Vercel removes unresumable sandboxes after 14 days anyway) stops a quiet
// stretch from expiring the template.
const SNAPSHOT_OPTIONS = {
  keepLastSnapshots: { count: 1, deleteEvicted: true },
  resources: { vcpus: 4 },
  snapshotExpiration: 14 * 24 * 60 * 60 * 1000,
} satisfies VercelSandboxEnvironmentOptions;

/**
 * Create options shared by every factory sandbox environment, the root's
 * included.
 *
 * @remarks
 * `prepare` runs once per template snapshot: it installs `gh` and pnpm and
 * seeds the `gh` and `git` wrappers (`agent/lib/github/tooling.ts`). The
 * tooling version rides along in `env` so that a change to the installer or
 * a wrapper rebuilds every template (`FACTORY_TOOLING_VERSION` says why).
 */
export const FACTORY_SANDBOX_CREATE_OPTIONS = {
  ...SNAPSHOT_OPTIONS,
  env: { FACTORY_TOOLING_VERSION },
  prepare: installFactoryTooling,
} satisfies VercelSandboxEnvironmentOptions;

/**
 * Creates a station's Vercel Sandbox environment.
 *
 * @remarks
 * Each station calls this from its own `sandbox.ts`, so the environment's
 * generation is keyed to that file, the same as authoring `VercelSandbox
 * .environment()` directly there would be.
 */
export function createFactoryEnvironment() {
  return VercelSandbox.environment(FACTORY_SANDBOX_CREATE_OPTIONS);
}

/**
 * The options every factory sandbox is opened with, the root's included.
 *
 * @remarks
 * The network policy is the base egress policy (`egress.ts`): by default an
 * allowlist of GitHub and the public package registries. It is passed to
 * `open()`, not to the environment, because the template build has to reach
 * the image's package archive to install `gh`, and because a policy set on
 * the environment does not carry into a session anyway. `open()` applies it
 * when the sandbox is created, and every credential lease ends by putting
 * it back.
 */
export const factoryOpenOptions = () => ({ networkPolicy: basePolicy() });

/**
 * The command that makes a station's checkout, in a directory named `repo`.
 *
 * @remarks
 * A shallow clone tracks only the default branch: git writes a fetch
 * refspec for that one branch, and then refuses to treat any other
 * `origin/<branch>` as a remote-tracking branch, so a plain
 * `git checkout <branch>` fails even after the branch has been fetched.
 * Widening the refspec (configuration only, nothing extra is downloaded)
 * is what lets a station run `git fetch origin <branch>` and then check
 * the branch out the ordinary way.
 *
 * @param url - Interpolated unquoted, so only a URL the factory wrote
 * itself (`REMOTE_URL`), never caller input.
 */
export const cloneCommand = (url: string): string =>
  `${GIT_BINARY} clone --depth 50 ${url} repo && ${GIT_BINARY} -C repo config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`;

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * setup fails the session loudly instead of leaving a half-prepared sandbox
 * behind.
 *
 * @throws With the command and its output, credential-shaped text removed.
 */
async function runOrThrow(
  sandbox: VercelSandboxSession,
  command: string
): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    throw new Error(
      sanitizeCommandOutput(
        `Sandbox command failed (exit ${result.exitCode}): ${command}\n${String(
          result.stderr || result.stdout
        ).trim()}`
      )
    );
  }
}

/**
 * Characters allowed in a bot name interpolated into a shell-quoted git
 * config command.
 */
const SAFE_BOT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The bot's commit identity, from the connector-resolved name.
 *
 * @remarks
 * Falls back to the static default when resolution fails (a commit identity
 * is needed even when the connector metadata is briefly unreachable) or when
 * the resolved name carries characters that don't belong in a shell-quoted
 * git config value; connector app slugs never do, but the name can also
 * arrive from an env override.
 */
async function gitIdentity(): Promise<{ email: string; name: string }> {
  const resolved = await resolveBotName().catch(() => FALLBACK_BOT_NAME);
  const safe = SAFE_BOT_NAME.test(resolved) ? resolved : FALLBACK_BOT_NAME;
  return {
    email: `${safe.toLowerCase()}[bot]@users.noreply.github.com`,
    name: `${safe}[bot]`,
  };
}

/**
 * Session-scoped setup shared by the analyst, implementer, and reviewer
 * sandboxes: fix git's ownership check, set the bot's commit identity, turn
 * package install scripts off, and clone the factory repository.
 *
 * @remarks
 * - Package managers are told not to run install scripts
 *   (`install-scripts.ts`) before anything installs a dependency, unless the
 *   deployer set `FACTORY_ALLOW_INSTALL_SCRIPTS=1`.
 * - The clone runs once per session, under a credential lease
 *   (`lease.ts`): a read-only token scoped to the factory repository, which
 *   the sandbox firewall attaches only to the clone's own requests and which
 *   never enters the sandbox.
 * - `FACTORY_SETUP_COMMAND` (e.g. `pnpm install`) then runs inside the fresh
 *   checkout with no GitHub credential at all. A setup command runs code
 *   the repository and its dependencies bring, so it gets plain network
 *   access and nothing else. The consequence: a setup step that needs to
 *   read a private GitHub repository has to bring its own credential (a
 *   registry token, a deploy key). The network it gets is the sandbox's
 *   base policy (`egress.ts`), so by default it reaches GitHub and the
 *   public package registries; a failure is reported with the setting that
 *   adds a host.
 * - The template snapshot is owned by the builder uid, not the session user;
 *   without the `safe.directory` entries every git command dies on "dubious
 *   ownership".
 *
 * @param lease - Overrides for the credential lease. The test suite's seam;
 * unset in the app.
 * @throws When the git settings, the clone, or the setup command fails. A
 * clone failure names `FACTORY_REPO` and the fix
 * (`bootstrap-diagnostics.ts`), keeps the original error as the cause, and
 * never carries the token.
 */
export async function factoryInit(
  sandbox: VercelSandboxSession,
  lease: LeaseDependencies = {}
): Promise<void> {
  const identity = await gitIdentity();
  await runOrThrow(
    sandbox,
    [
      `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`,
      ...(installScriptsBlocked() ? [INSTALL_SCRIPTS_OFF_COMMAND] : []),
    ].join(" && ")
  );
  let clone: Awaited<ReturnType<typeof runLeasedGitCommand>>;
  try {
    clone = await runLeasedGitCommand(sandbox, cloneCommand(REMOTE_URL), lease);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.startsWith("Could not mint")
        ? appAccessMessage(FACTORY_REPO)
        : describeCloneFailure(FACTORY_REPO, safeErrorMessage(error)),
      { cause: error }
    );
  }
  if (clone.exitCode !== 0) {
    throw new Error(
      describeCloneFailure(
        FACTORY_REPO,
        sanitizeCommandOutput(`${clone.stderr}\n${clone.stdout}`)
      )
    );
  }
  const setup = process.env.FACTORY_SETUP_COMMAND;
  if (setup) {
    try {
      await runOrThrow(sandbox, `cd repo && ${setup}`);
    } catch (error) {
      if (egressMode() === "open" || !(error instanceof Error)) {
        throw error;
      }
      throw new Error(`${error.message}\n${EGRESS_SETUP_HINT}`, {
        cause: error,
      });
    }
  }
}
