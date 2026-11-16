import type { GitHubChannelState } from "eve/channels/github";
import { FACTORY_REPO } from "../constants.js";
import { shellQuote } from "./cli.js";
import { GIT_BINARY, rewriteGuard } from "./git-cli.js";
import { REMOTE_URL, validateRef } from "./git-remote.js";
import {
  type LeaseDependencies,
  type LeaseSandbox,
  runLeasedGitCommand,
} from "./lease.js";

/**
 * The orchestrator's per-turn checkout of the factory repository.
 *
 * @remarks
 * eve's GitHub channel checks the repository out into the root sandbox when
 * a turn starts, so the orchestrator can read the code. Its built-in handler
 * does that by setting a sandbox firewall policy that adds the GitHub App's
 * installation token to every git request to github.com, from any process,
 * and it never takes the policy off again. Anything that ran in that
 * sandbox afterwards could push with a token that holds every permission
 * the app has. The orchestrator has no shell, so nothing of its own runs
 * there, but the factory does not rest on that alone: no token is left
 * standing on any sandbox.
 *
 * So the factory replaces the handler (`agent/channels/github.ts`) with this
 * checkout, which goes through the same credential lease as everything
 * else: a read-only token, attached only to requests that carry a one-off
 * placeholder, and removed when the command ends. Keep it that way; never
 * hand `turn.started` back to the channel's default.
 */

const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** What the checkout needs from the channel's per-conversation state. */
export type CheckoutState = Pick<
  GitHubChannelState,
  | "baseSha"
  | "defaultBranch"
  | "headRef"
  | "headSha"
  | "owner"
  | "pullRequestNumber"
  | "repo"
>;

export interface CheckoutPlan {
  /**
   * A second commit to fetch, so a pull request can be diffed against its
   * base.
   */
  readonly base: string | null;
  /**
   * What to fetch: a commit, a pull request's head ref, a branch, or `HEAD`.
   */
  readonly ref: string;
  /** The commit to check out when it is known up front, else null. */
  readonly sha: string | null;
}

const branchRef = (name: string | null): string | null =>
  name !== null && validateRef(name) === null ? `refs/heads/${name}` : null;

/**
 * Decides what to fetch for a conversation.
 *
 * @remarks
 * Every value here ends up in a git command, and some of it (a fork's
 * branch name) is chosen by whoever opened the pull request. A commit is
 * used only when it is a full hash, a pull request is fetched through
 * GitHub's own `refs/pull/<n>/head`, and a branch name is used only when it
 * is a plain one. Failing all of those, the default branch is fetched.
 *
 * @returns The plan, or null when the event is for a repository other than
 * the factory's own, which the factory never checks out.
 */
export const planCheckout = (state: CheckoutState): CheckoutPlan | null => {
  if (
    `${state.owner}/${state.repo}`.toLowerCase() !== FACTORY_REPO.toLowerCase()
  ) {
    return null;
  }
  const sha =
    state.headSha !== null && FULL_SHA.test(state.headSha)
      ? state.headSha
      : null;
  const base =
    state.pullRequestNumber !== null &&
    state.baseSha !== null &&
    FULL_SHA.test(state.baseSha)
      ? state.baseSha
      : null;
  if (sha !== null) {
    return { base, ref: sha, sha };
  }
  if (
    state.pullRequestNumber !== null &&
    Number.isSafeInteger(state.pullRequestNumber) &&
    state.pullRequestNumber > 0
  ) {
    return { base, ref: `refs/pull/${state.pullRequestNumber}/head`, sha };
  }
  return {
    base,
    ref: branchRef(state.headRef) ?? branchRef(state.defaultBranch) ?? "HEAD",
    sha,
  };
};

const git = (path: string, ...parts: readonly string[]): string =>
  [GIT_BINARY, "-C", shellQuote(path), ...parts].join(" ");

/** The command that reads the commit currently checked out at `path`. */
export const headCommand = (path: string): string =>
  `${git(path, "rev-parse", "HEAD")} 2>/dev/null`;

/**
 * The command that brings `path` to the planned commit.
 *
 * @returns A command whose last output line is the commit checked out. It
 * fetches, so it needs a read lease.
 */
export const checkoutCommand = (path: string, plan: CheckoutPlan): string =>
  [
    `mkdir -p ${shellQuote(path)}`,
    git(path, "init", "-q"),
    `{ ${rewriteGuard(path)}; }`,
    `(${git(path, "remote", "remove", "origin")} >/dev/null 2>&1 || true)`,
    git(path, "remote", "add", "origin", shellQuote(REMOTE_URL)),
    git(path, "fetch", "--depth", "1", "origin", shellQuote(plan.ref)),
    git(path, "checkout", "--detach", shellQuote(plan.sha ?? "FETCH_HEAD")),
    ...(plan.base === null
      ? []
      : [git(path, "fetch", "--depth", "1", "origin", shellQuote(plan.base))]),
    git(path, "rev-parse", "HEAD"),
  ].join(" && ");

/** The sandbox a checkout needs: a lease-capable one that can resolve paths. */
export type CheckoutSandbox = LeaseSandbox & {
  readonly resolvePath: (path: string) => string;
};

/**
 * Checks the factory repository out into the sandbox's workspace root.
 *
 * @param lease - Overrides for the credential lease. The test suite's seam;
 * unset in the app.
 * @returns Where the checkout is and which commit it is at, or null when
 * the conversation is for another repository.
 * @throws When the fetch or checkout fails.
 */
export async function checkoutForTurn(
  sandbox: CheckoutSandbox,
  state: CheckoutState,
  lease: LeaseDependencies = {}
): Promise<{ path: string; sha: string } | null> {
  const plan = planCheckout(state);
  if (plan === null) {
    return null;
  }
  const path = sandbox.resolvePath(".");
  if (plan.sha !== null) {
    // Already there: no token is minted and nothing is fetched.
    const head = await sandbox.run({ command: headCommand(path) });
    if (head.exitCode === 0 && String(head.stdout).trim() === plan.sha) {
      return { path, sha: plan.sha };
    }
  }
  const result = await runLeasedGitCommand(
    sandbox,
    checkoutCommand(path, plan),
    lease
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Checking out ${FACTORY_REPO} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-600) || result.stdout.trim().slice(-600)}. Verify the GitHub App is installed on the repository.`
    );
  }
  const sha = result.stdout.trim().split("\n").at(-1) ?? "";
  return { path, sha: FULL_SHA.test(sha) ? sha : (plan.sha ?? plan.ref) };
}

/** Whether a sandbox handle can hold a credential lease and resolve paths. */
export const isCheckoutSandbox = (
  sandbox: object
): sandbox is CheckoutSandbox =>
  "setNetworkPolicy" in sandbox &&
  "name" in sandbox &&
  "resolvePath" in sandbox;
