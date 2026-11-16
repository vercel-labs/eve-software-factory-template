import type { GitHubChannelCredentials } from "eve/channels/github";
import { FACTORY_BRANCH_PREFIX, FACTORY_REPO } from "../constants.js";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Conservative subset of valid git branch names: alphanumeric segments
 * separated by `.`, `_`, `-` or `/`. Everything the git commands interpolate
 * has to match this, so shell metacharacters can never reach the command
 * line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/** Where the station sandboxes keep the factory repository checkout. */
export const REPO_DIR = "/workspace/repo";

/**
 * The URL the git commands the factory writes itself target, literally:
 * the clone, the orchestrator's checkout, and the push.
 *
 * @remarks
 * Git remote config inside a sandbox (`pushurl`, `pushDefault`, per-branch
 * remotes) is model-writable and must not be able to redirect a credential
 * that can write, so the push never goes through `origin`: the word is
 * accepted from the agent and this URL is what runs. A fetch an agent runs
 * in its own shell does use the checkout's `origin`, under a credential
 * that only reads.
 */
export const REMOTE_URL = `https://github.com/${FACTORY_REPO}.git`;

/**
 * Checks that a name is a plain branch name, safe to interpolate into a git
 * command.
 *
 * @remarks
 * This is the shape check alone, for commands that only read (fetch, pull,
 * ls-remote), where naming the default branch is legitimate. `refs/heads/x`
 * and `HEAD` are refused so a ref can't be reached under another name.
 *
 * @returns The refusal reason, or null when the name passes.
 */
export function validateRef(ref: string): string | null {
  if (!BRANCH_PATTERN.test(ref) || ref.includes("..") || ref.includes("//")) {
    return `"${ref}" is not a valid branch name.`;
  }
  if (ref.startsWith("refs/") || ref === "HEAD") {
    return `"${ref}" is not a plain branch name. Pass the branch name without a refs/ prefix.`;
  }
  return null;
}

/**
 * Checks that a branch is one the factory may push.
 *
 * @remarks
 * {@link validateRef} plus two rules about which branches are the factory's
 * to write:
 *
 * - The branch must carry the factory's own prefix (`FACTORY_BRANCH_PREFIX`,
 *   `factory/` by default). The factory delivers its work on branches it
 *   created and never touches anyone else's, and this is what keeps a push
 *   off `develop`, a release branch, `gh-pages`, or whatever a repository
 *   calls its default branch.
 * - `main` and `master` are refused by name regardless, so the rule still
 *   holds for a deployment that set the prefix to nothing.
 *
 * @returns The refusal reason, or null when the branch may be pushed.
 */
export function validateBranch(branch: string): string | null {
  const refusal = validateRef(branch);
  if (refusal) {
    return refusal;
  }
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  if (!branch.startsWith(FACTORY_BRANCH_PREFIX)) {
    return `"${branch}" is not one of the factory's own branches. Push a branch named ${FACTORY_BRANCH_PREFIX}<type>-<short-slug>.`;
  }
  return null;
}

/**
 * Resolves the Connect-managed installation token, minting when it is lazy.
 *
 * @throws When the connector exposes no installation token.
 */
export async function mintInstallationToken(
  credentials: GitHubChannelCredentials
): Promise<string> {
  const token = credentials.installationToken;
  if (token === undefined) {
    throw new Error("The GitHub connector exposes no installation token.");
  }
  return typeof token === "function" ? await token() : token;
}
