import type { SandboxEnvironment } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";
import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { FACTORY_REPO } from "../constants.js";
import { ghPolicy, readOnlyGhPolicy } from "./approval.js";
import { MAX_GH_ARGS, parseGh } from "./cli.js";
import {
  GIT_NETWORK_SUBCOMMANDS,
  MAX_GIT_ARGS,
  parseGitNetwork,
} from "./git-cli.js";
import { REPO_DIR } from "./git-remote.js";
import {
  type CliResult,
  type LeaseDependencies,
  runGh,
  runGitNetwork,
} from "./lease.js";

/**
 * The factory's `gh` and `git` tools: the real binaries, run in a sandbox,
 * behind an argv allowlist and a credential lease.
 *
 * @remarks
 * These replace a GitHub API tool surface with the GitHub CLI itself. The
 * model writes ordinary `gh` and `git` commands; what keeps that safe is
 * layered:
 *
 * 1. The argv is parsed against an allowlist (`cli.ts`, `git-cli.ts`).
 *    Unknown commands and flags never run.
 * 2. The command's effect and the caller's trust class decide whether it
 *    runs, waits for a person, or is denied (`approval.ts`).
 * 3. The credential is leased for that one command, scoped to the factory
 *    repository and the permissions the command class needs, and never
 *    enters the sandbox (`lease.ts`).
 *
 * Each agent that needs a tool mounts it from its own `tools/` directory
 * with its own sandbox environment, since stations inherit nothing from the
 * orchestrator.
 */

type FactoryEnvironment = SandboxEnvironment<
  object | undefined,
  VercelSandboxSession
>;

const argsSchema = (max: number, example: string) =>
  z.object({
    args: z
      .array(z.string())
      .min(1)
      .max(max)
      .describe(
        `The command's arguments as an array, one element per argument, without the program name. Example: ${example}. No shell is involved, so never quote or escape.`
      ),
  });

const cliOutput = (result: CliResult) => {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.exitCode === 0) {
    return toolOutput.text(stdout || stderr || "(no output)");
  }
  return toolOutput.errorText(
    [stdout, stderr && `[stderr]\n${stderr}`, `[exit ${result.exitCode}]`]
      .filter(Boolean)
      .join("\n")
  );
};

const GH_READ_EXAMPLES =
  '["issue","view","12","--comments"], ["pr","view","34","--json","title,body,headRefName,isDraft"], ["pr","diff","34"], ["pr","checks","34"], ["run","view","991","--log-failed"], ["label","list"]';

/**
 * Builds a `gh` tool.
 *
 * @param options.environment - The mounting agent's own sandbox environment.
 * @param options.mode - `"full"` on the orchestrator: writes follow the
 * trust policy. `"read-only"` on a station: reads run, writes are denied.
 */
export const ghTool = (options: {
  environment: FactoryEnvironment;
  /** Overrides for the credential lease. The test suite's seam; unset in the app. */
  lease?: LeaseDependencies;
  mode: "full" | "read-only";
}) => {
  const full = options.mode === "full";
  return defineTool({
    approval: full ? ghPolicy : readOnlyGhPolicy,
    description: full
      ? `Run the GitHub CLI (gh) against ${FACTORY_REPO}: read issues, pull requests, checks, and CI logs; comment; label; create and edit issues; open pull requests. The repository is fixed, so leave out --repo. Only non-interactive flags work; pass text with --body. Examples: ${GH_READ_EXAMPLES}, ["issue","comment","12","--body","Classification is complete."], ["issue","edit","12","--add-label","bug"], ["pr","create","--draft","--head","factory/bug-fix-login","--base","main","--title","Fix login 500","--body","..."]. Merging is not available.`
      : `Run read-only GitHub CLI (gh) commands against ${FACTORY_REPO}: issues, pull requests, diffs, checks, and CI logs. The repository is fixed, so leave out --repo. Examples: ${GH_READ_EXAMPLES}. Commands that change anything on GitHub are refused here.`,
    async execute({ args }, ctx) {
      const parsed = parseGh(args);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }
      const { invocation } = parsed;
      if (!full && invocation.effect.kind !== "read") {
        throw new Error("This tool only runs read-only gh commands.");
      }
      const sandbox = await ctx.getSandbox(options.environment);
      return await runGh(
        sandbox,
        invocation,
        invocation.effect.kind === "read" ? "repo-read" : "repo-triage",
        options.lease
      );
    },
    inputSchema: argsSchema(MAX_GH_ARGS, '["pr","view","34"]'),
    toModelOutput: cliOutput,
  });
};

/**
 * Builds a station's networked `git` tool.
 *
 * @remarks
 * Local git (status, diff, branch, checkout, commit, log) is plain `git` in
 * the station's shell. This tool is for the commands that talk to GitHub,
 * which run under a credential lease.
 *
 * @param options.environment - The station's own sandbox environment.
 * @param options.push - Whether this station may push. Only the implementer
 * does; for everyone else `push` is refused before it reaches a sandbox.
 */
export const gitTool = (options: {
  environment: FactoryEnvironment;
  /** Overrides for the credential lease. The test suite's seam; unset in the app. */
  lease?: LeaseDependencies;
  push: boolean;
}) => {
  const allowed = GIT_NETWORK_SUBCOMMANDS.filter(
    (subcommand) => options.push || subcommand !== "push"
  );
  const check = (args: readonly string[]) => {
    const parsed = parseGitNetwork(args);
    if (!parsed.ok) {
      return parsed;
    }
    return parsed.invocation.mutatesRemote && !options.push
      ? ({
          ok: false,
          reason:
            "This station reads the repository and never pushes. Report what should change in your structured output.",
        } as const)
      : parsed;
  };
  return defineTool({
    approval: (ctx) => {
      const parsed = check(ctx.toolInput?.args ?? []);
      return parsed.ok
        ? "not-applicable"
        : { reason: parsed.reason, type: "denied" };
    },
    description: `Run a git command that talks to GitHub, in the ${REPO_DIR} checkout of ${FACTORY_REPO}: ${allowed.join(", ")}. The remote is always the factory repository; write it as origin. ${
      options.push
        ? 'Examples: ["fetch","origin","factory/bug-fix-login"] then check the branch out in the shell with git checkout factory/bug-fix-login; ["push","origin","factory/bug-fix-login"] to deliver your committed branch. Pushing to main or master, force pushes, and deleting branches are refused.'
        : 'Example: ["fetch","origin","factory/bug-fix-login"], then check the branch out in the shell with git checkout factory/bug-fix-login.'
    } Everything local (status, diff, checkout, commit, log) is plain git in the shell, not this tool.`,
    async execute({ args }, ctx) {
      const parsed = check(args);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }
      const sandbox = await ctx.getSandbox(options.environment);
      return await runGitNetwork(sandbox, parsed.invocation, options.lease);
    },
    inputSchema: argsSchema(MAX_GIT_ARGS, '["fetch","origin","factory/bug-x"]'),
    toModelOutput: cliOutput,
  });
};
