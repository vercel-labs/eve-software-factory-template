import { decide } from "eve/ai";
import { defineDynamic, defineInstructions } from "eve/instructions";
import type { LeaseSandbox } from "../lib/github/lease.js";
import { pretriage, pretriageTarget } from "../lib/triage/pretriage.js";
import { sandboxGhRunner } from "../lib/triage/run.js";

/**
 * The triage result, in place before the orchestrator's first turn on a
 * labeled issue or an intake ticket (`agent/lib/triage/pretriage.ts`).
 *
 * @remarks
 * A dynamic instruction runs before every model call, so the work sits in
 * a memo keyed on the turn: triage runs once when the turn starts, and a
 * later turn in the same session (an issue labeled again after its
 * questions were answered) is triaged afresh. A failed triage is kept as
 * null like any other result, so it is not retried before every call.
 *
 * Every other run returns before the sandbox is asked for, so a mention, a
 * Linear session, or the dev TUI never starts one here. The result is a
 * user instruction: it joins the conversation once, ahead of the turn's
 * input.
 */
export default defineDynamic(async (ctx) => {
  const auth = ctx.session.auth.current;
  const message = (ctx.turn?.input ?? [])
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
  const target = pretriageTarget(auth, message);
  if (target === null || ctx.turn === null) {
    return null;
  }
  const content = await ctx.memo(["pretriage", ctx.turn.id], async () => {
    try {
      const sandbox = await ctx.getSandbox();
      if (!("setNetworkPolicy" in sandbox && "name" in sandbox)) {
        return null;
      }
      return await pretriage(target, auth, {
        decide,
        gh: sandboxGhRunner(sandbox as unknown as LeaseSandbox),
      });
    } catch (error) {
      console.warn("[factory] Triage before the first turn failed:", error);
      return null;
    }
  });
  return content === null
    ? null
    : defineInstructions({ content, role: "user" });
});
