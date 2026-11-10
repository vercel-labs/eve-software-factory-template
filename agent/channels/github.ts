import { githubChannel } from "eve/channels/github";
import { resolveBotName } from "../lib/github/bot-name.js";
import { githubCredentials } from "../lib/github/credentials.js";
import {
  onCheckSuite,
  onComment,
  onIssue,
  onPullRequest,
} from "../lib/github/hooks.js";

/**
 * GitHub channel: the factory's main intake and delivery surface, as
 * "Foreman".
 *
 * @remarks
 * - Credentials are brokered by Vercel Connect through the shared handle in
 *   `agent/lib/github/credentials.ts`; tokens are resolved per call and never
 *   exposed to the model.
 * - The name the factory answers to is resolved from the GitHub App's own
 *   slug (`agent/lib/github/bot-name.ts`), so the mention follows whatever
 *   the deployer named their app with no configuration, and a hardcoded
 *   handle can't collide with an unrelated GitHub user. `botName` is passed
 *   as the resolver function, not a resolved value: eve calls it on first
 *   use inside request handling, where the deployment's OIDC token exists
 *   (at module load it doesn't, so a value resolved here would pin the
 *   fallback), caches a fulfilled name, and retries a rejection on the next
 *   event.
 * - `onComment` replaces the built-in mention gate to add an authorization
 *   check: it keeps the default mention and ignore rules, then dispatches
 *   only when the commenter's `author_association` marks them as trusted with
 *   the repo (owner, member, or collaborator). The dispatch stamps the
 *   `trusted` auth attribute, which is what lets the approval policies run
 *   reversible writes without a card. Mentions from anyone else are
 *   acknowledged without a session, so arbitrary accounts on a public repo
 *   cannot drive the agent's write tools.
 * - `onIssue` is the unattended intake: adding the factory label hands the
 *   issue to the pipeline. Only the `labeled` action dispatches, and the
 *   labeler's repository permission is verified against the API first,
 *   because GitHub fires `labeled` even for labels attached at creation time
 *   and issue templates let unauthenticated reporters do exactly that; below
 *   triage, the event is acknowledged without a session. The factory label is
 *   matched against the issue's current `labels` array rather than a single
 *   "added label" field, because eve exposes the issue object as `issue.raw`,
 *   not the raw webhook payload that carries the just-added label. The turn
 *   itself runs unattended: the auth is rewritten to the constructed
 *   autonomous principal with the intake issue number stamped in, and the
 *   approval policies deny it everything except labels, progress comments on
 *   that one issue, closing or reopening issues, and draft pull requests.
 * - `onPullRequest` dispatches only on the `opened` action and skips PRs
 *   opened by bots, which covers Dependabot and the factory's own
 *   `foreman[bot]` pull requests. It is deliberately not gated by
 *   `author_association`: summarizing outside contributors' PRs is the point.
 *   Because that makes a stranger's text the run's input, the run is stamped
 *   summary-only: the approval policies let it read and comment on that one
 *   pull request and deny it everything else, stations included.
 * - `onCheckSuite` is the red-CI fix loop, scoped to the factory's own work:
 *   it dispatches only when a suite completes with a failure conclusion on a
 *   pull request whose head branch carries the factory prefix, so a person's
 *   red PR never triggers an uninvited fix. The session runs unattended under
 *   the autonomous principal, anchored to the pull request, and the injected
 *   task bounds the loop by counting earlier fix-attempt comments on the
 *   thread. Requires the connector to subscribe to the `check_suite` webhook
 *   event.
 * - Human-in-the-loop prompts are the channel's own (eve ≥ 0.34 posts them by
 *   default): when a session stops for approval or input, the channel renders
 *   the request as a comment with a mention-based reply instruction. Passing
 *   the `botName` resolver is what makes both the instruction and the reply's
 *   mention-stripping correct, and `onComment`'s gate is what keeps a reply
 *   an authorization signal: only mentions from owners, members, and
 *   collaborators ever reach the waiting session.
 */
export default githubChannel({
  botName: resolveBotName,
  credentials: githubCredentials,
  onCheckSuite,
  onComment,
  onIssue,
  onPullRequest,
});
