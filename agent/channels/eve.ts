import { localDev, vercelOidc } from "eve/channels/auth";
import { type EveAuthFn, eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The per-user `preferences` memory slot is scoped to a `user` principal. In
 * production the channels supply one; the eve dev TUI authenticates with
 * `localDev()`, whose `local-dev` principal is not a user, so the slot would
 * stay off. This shim defers the trust decision to `localDev()`, returning
 * `null` for anything it would reject, so it never affects production, and
 * only upgrades the resolved principal to a user.
 *
 * `allowAgentInfo` keeps `GET /eve/v1/info` readable for this caller. eve
 * serves that route to service, runtime, and local-dev principals only, and
 * the upgrade to `user` would otherwise lock out `eve eval`, which reads it
 * before it starts. `allowToolStubs` lets local evals stub tools.
 */
const localDevUser: EveAuthFn = async (request) => {
  const local = await localDevAuth(request);
  return local
    ? {
        ...local,
        allowAgentInfo: true,
        allowToolStubs: true,
        principalType: "user",
      }
    : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
