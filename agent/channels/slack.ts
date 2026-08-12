import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  type SlackContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { stampTrusted } from "../lib/trust.js";

/**
 * Resolves a Slack mention or direct message into a dispatch decision.
 *
 * @remarks
 * Slack has no equivalent of GitHub's `author_association`, so workspace
 * membership is the gate: only members of the workspace the app is installed
 * in can address the bot, and every such caller is stamped trusted, the same
 * stance the Linear channel takes. Messages from other bots are dropped so a
 * chatty integration can't drive the factory or start a reply loop (eve
 * already filters the app's own messages before this runs). A message eve
 * can't attribute to a user yields no default auth, so it is dropped rather
 * than dispatched anonymously.
 *
 * @param ctx - The Slack channel context for the inbound message.
 * @param message - The inbound Slack message.
 * @returns A dispatch decision with trusted auth, or `null` to drop the message.
 */
const dispatchTrusted = (ctx: SlackContext, message: SlackMessage) => {
  if (message.author?.isBot) {
    return null;
  }
  const auth = defaultSlackAuth(message, ctx);
  return auth ? { auth: stampTrusted(auth) } : null;
};

/**
 * Slack channel: app mentions and direct messages in, threaded replies out,
 * via Vercel Connect.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect, which supplies the bot token and
 * verifies inbound webhooks, so there is no bot token or signing secret in the
 * code or environment beyond the connector UID (`SLACK_CONNECTOR`). Foreman
 * answers `@Foreman` mentions and DMs, runs the work item through the pipeline,
 * and reports back in the same thread; the finished product is still a draft
 * pull request on the factory repository.
 *
 * `onAppMention` handles `@mentions` and `onDirectMessage` handles DMs; both
 * dispatch through {@link dispatchTrusted}, so workspace members are trusted
 * and other bots are ignored. Thread continuation without a repeated mention
 * (`onMessage` with `ctx.isSubscribed()`) and prior-message context
 * (`threadContext`) are deliberately left off to keep the required Slack
 * scopes minimal; add them if the workspace grants channel history.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/foreman-agent"
  ),
  onAppMention: (ctx, message) => dispatchTrusted(ctx, message),
  onDirectMessage: (ctx, message) => dispatchTrusted(ctx, message),
});
