import { decide } from "eve/ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseGh } from "../lib/github/cli.js";
import { runGh } from "../lib/github/lease.js";
import {
  CI_FAILURE_CAUSES,
  diagnoseCiFailure,
} from "../lib/triage/decisions.js";
import {
  fetchChecks,
  fetchFailedLogs,
  type GhRunner,
} from "../lib/triage/github.js";
import { environment } from "../sandbox.js";

/** How much of the failed log goes back to the orchestrator. */
const LOG_EXCERPT_CHARACTERS = 6000;

const outputSchema = z.object({
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
  fix_with_code: z.boolean(),
  log_excerpt: z.string(),
  pending_checks: z.number(),
  status: z.enum(["passing", "pending", "failing", "failing-no-log"]),
});

type Diagnosis = z.infer<typeof outputSchema>;

/**
 * Reads a pull request's failing checks and sorts the failure by cause.
 *
 * @remarks
 * The red-CI loop used to spend an implementer and reviewer cycle on every
 * failure. Most failures deserve that; a cancelled runner or a registry
 * outage does not, and "fixing" one wastes two attempts and pushes noise.
 * This reads the checks and the failed-step logs with `gh`, then asks the
 * decision model one closed question about the log. It only reads, so it
 * needs no approval.
 */
export default defineTool({
  description:
    "Diagnose red CI on a pull request: lists the failing checks, reads the failed steps' logs, and classifies the cause as code, flaky, infrastructure, or configuration. fix_with_code is true only when changing the branch is the right response. Call this before attempting any CI fix.",
  async execute({ pull_request }, ctx): Promise<Diagnosis> {
    const sandbox = await ctx.getSandbox(environment);
    const gh: GhRunner = (args) => {
      const parsed = parseGh(args);
      if (!parsed.ok || parsed.invocation.effect.kind !== "read") {
        throw new Error("CI diagnosis only reads.");
      }
      return runGh(sandbox, parsed.invocation, "repo-read");
    };

    const checks = await fetchChecks(gh, pull_request);
    if (checks.failing.length === 0) {
      return {
        cause: null,
        confidence: null,
        failing_checks: [],
        fix_with_code: false,
        log_excerpt: "",
        pending_checks: checks.pending,
        status: checks.pending > 0 ? "pending" : "passing",
      };
    }
    const log = await fetchFailedLogs(gh, checks.failing);
    if (log.trim() === "") {
      return {
        cause: null,
        confidence: null,
        failing_checks: [...checks.failing],
        fix_with_code: false,
        log_excerpt: "",
        pending_checks: checks.pending,
        status: "failing-no-log",
      };
    }
    const diagnosis = await diagnoseCiFailure(log, {
      decide,
      signal: ctx.abortSignal,
    });
    return {
      ...diagnosis,
      failing_checks: [...checks.failing],
      log_excerpt: log.slice(-LOG_EXCERPT_CHARACTERS),
      pending_checks: checks.pending,
      status: "failing",
    };
  },
  inputSchema: z.object({
    pull_request: z
      .number()
      .int()
      .positive()
      .describe("The pull request number whose checks failed."),
  }),
  outputSchema,
});
