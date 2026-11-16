import { connectGitHubCredentials } from "@vercel/connect/eve";

/**
 * Vercel Connect connector UID for the factory's GitHub App installation.
 *
 * @remarks
 * One connector serves every GitHub surface: the channel (webhooks, replies)
 * and the tokens leased to `gh` and `git` commands (`lease.ts`). The
 * fallback is this template's own connector UID; deployments set
 * `GITHUB_CONNECTOR` to their own.
 */
export const GITHUB_CONNECTOR =
  process.env.GITHUB_CONNECTOR ?? "github/foreman-agent";

/**
 * Connect-managed GitHub App credentials shared by the channel and the git
 * helpers.
 *
 * @remarks
 * Tokens are resolved lazily per use and never exposed to the model. The
 * channel uses these credentials directly; `gh` and `git` commands are
 * leased narrower tokens from the same connector
 * (`agent/lib/github/lease.ts`) and fall back to this one only when the
 * connector refuses to narrow and the deployer opted into that fallback.
 */
export const githubCredentials = connectGitHubCredentials(GITHUB_CONNECTOR);
