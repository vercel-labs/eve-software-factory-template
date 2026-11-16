import type { MemoryScopeContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { isAutonomous } from "../trust.js";

/**
 * Memory scope for per-user slots: one document per signed-in user, and no
 * memory at all for anyone else.
 *
 * @remarks
 * eve's `byPrincipal` already separates callers by authenticator, issuer,
 * and principal id, and turns memory off for anonymous and runtime callers.
 * This adds the factory's own rule on top: only a `user` principal has
 * preferences. The constructed service principals that unattended runs
 * execute under (label intake, CI fixes, API intake) resolve to `null`, so a
 * prompt-injected issue can't leave "preferences" behind for the next
 * unattended run to obey.
 */
export const userScope = (context: MemoryScopeContext): string | null => {
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user" || isAutonomous(caller)) {
    return null;
  }
  return byPrincipal(context);
};
