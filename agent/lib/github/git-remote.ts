import type { GitHubChannelCredentials } from "eve/channels/github";
import { FACTORY_REPO } from "../constants.js";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Conservative subset of valid git branch names: alphanumeric segments
 * separated by `.`, `_`, `-` or `/`. Everything the git commands interpolate
 * has to match this, so shell metacharacters can never reach the command
 * line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Where the station sandboxes keep the factory repository checkout.
 */
export const REPO_DIR = "/workspace/repo";

/**
 * The URL every clone, fetch, and push targets, literally.
 *
 * @remarks
 * Git remote config inside a sandbox (`pushurl`, `pushDefault`, per-branch
 * remotes) is model-writable and must not be able to redirect the brokered
 * credential, so the git helpers never go through `origin`.
 */
export const REMOTE_URL = `https://github.com/${FACTORY_REPO}.git`;

/**
 * Returns the refusal reason, or null when the name is a plain branch name
 * that is safe to interpolate into a git command.
 *
 * @remarks
 * This is the shape check alone, for commands that only read (fetch, pull,
 * ls-remote), where naming the default branch is legitimate. `refs/heads/x`
 * and `HEAD` are refused so a ref can't be reached under another name.
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
 * Returns the refusal reason, or null when the branch may be pushed.
 *
 * @remarks
 * {@link validateRef} plus the protected-branch rule: the factory delivers
 * pull requests, never direct pushes to the default branch.
 */
export function validateBranch(branch: string): string | null {
  const refusal = validateRef(branch);
  if (refusal) {
    return refusal;
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  return null;
}

/**
 * Resolves the Connect-managed installation token, minting when it is lazy.
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
