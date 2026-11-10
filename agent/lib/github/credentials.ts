import { connectGitHubCredentials } from "@vercel/connect/eve";

/**
 * Vercel Connect connector UID for the factory's GitHub App installation.
 *
 * @remarks
 * One connector serves every GitHub surface: the channel (webhooks, replies)
 * and the tokens leased to the `gh` and `git` tools (`lease.ts`), which the
 * orchestrator and the station sandboxes read, clone, fetch, and push with. The fallback is this template's own
 * connector UID; deployments set `GITHUB_CONNECTOR` to their own.
 */
export const GITHUB_CONNECTOR =
  process.env.GITHUB_CONNECTOR ?? "github/foreman-agent";

/**
 * Connect-managed GitHub App credentials shared by the channel and the git
 * helpers.
 *
 * @remarks
 * Tokens are resolved lazily per use and never exposed to the model. The
 * channel uses these credentials directly; the `gh` and `git` tools lease
 * narrower tokens from the same connector (`agent/lib/github/lease.ts`) and
 * fall back to this one only when the connector refuses to narrow.
 */
export const githubCredentials = connectGitHubCredentials(GITHUB_CONNECTOR);
