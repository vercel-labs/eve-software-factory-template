import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseGh } from "../lib/github/cli.js";
import { runGh } from "../lib/github/lease.js";
import { CI_STATUSES, diagnosePullRequestChecks } from "../lib/triage/ci.js";
import { CI_FAILURE_CAUSES } from "../lib/triage/decisions.js";
import type { GhRunner } from "../lib/triage/github.js";
import { environment } from "../sandbox.js";

/**
 * Reads a pull request's failing checks and sorts the failure by cause.
 *
 * @remarks
 * Most red-CI failures deserve an implementer and reviewer cycle; a
 * cancelled runner or a registry outage does not, and "fixing" one wastes
 * two attempts and pushes noise. This reads the checks and the failed-step
 * logs with `gh`, then asks the decision model one closed question about
 * the log (`agent/lib/triage/ci.ts`). It only reads, so it needs no
 * approval.
 */
export default defineTool({
  description:
    "Diagnose red CI on a pull request: lists the failing checks, reads the failed steps' logs, and classifies the cause as code, flaky, infrastructure, or configuration. fix_with_code is true when changing the branch is the right response, false when it is not, and null when no log could be read (status failing-no-log), in which case the cause is unknown. Call this before attempting any CI fix.",
  async execute({ pull_request }, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    const gh: GhRunner = (args) => {
      const parsed = parseGh(args);
      if (!parsed.ok || parsed.invocation.effect.kind !== "read") {
        throw new Error("CI diagnosis only reads.");
      }
      return runGh(sandbox, parsed.invocation, "repo-read");
    };
    return await diagnosePullRequestChecks(gh, pull_request, {
      decide,
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.object({
    pull_request: z
      .number()
      .int()
      .positive()
      .describe("The pull request number whose checks failed."),
  }),
  outputSchema: z.object({
    cancelled_checks: z.number(),
    cause: z.enum(CI_FAILURE_CAUSES).nullable(),
    confidence: z.number().nullable(),
    failing_checks: z.array(
      z.object({
        link: z.string().nullable(),
        name: z.string(),
        runId: z.string().nullable(),
        workflow: z.string().nullable(),
      })
    ),
    fix_with_code: z.boolean().nullable(),
    log_excerpt: z.string(),
    pending_checks: z.number(),
    status: z.enum(CI_STATUSES),
  }),
});
