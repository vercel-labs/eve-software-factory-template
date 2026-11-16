import type { SandboxEnvironment } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";
import { defineTool } from "eve/tools";
import { type BashToolInput, type BashToolOutput, bash } from "eve/tools/bash";
import { FACTORY_BRANCH_PREFIX, FACTORY_REPO } from "../constants.js";
import {
  bashPolicy,
  GH_ONLY,
  MAX_GH_STEPS,
  shellAvailable,
} from "./approval.js";
import {
  type GhInvocation,
  MAX_GH_ARG_LENGTH,
  parseGh,
  shellQuote,
} from "./cli.js";
import { EGRESS_NOTE, egressMode } from "./egress.js";
import {
  CURRENT_BRANCH_COMMAND,
  isRepoDirectory,
  parseGitFetch,
  parseGitPush,
} from "./git-cli.js";
import { validateBranch } from "./git-remote.js";
import {
  type CliResult,
  type LeaseDependencies,
  type LeaseSandbox,
  NarrowTokenError,
  runGh,
  runGitFetch,
  runGitPush,
  withShellLease,
} from "./lease.js";
import {
  analyzeCommand,
  type GhStep,
  inlineBodyFiles,
  lexGitFetch,
  type ShellAnalysis,
} from "./shell.js";
import {
  LEASE_VARIABLE,
  REPO_VARIABLE,
  ROLE_VARIABLE,
  type ShellRole,
} from "./shims.js";

/**
 * The factory's `bash` tool: eve's own, with GitHub access wired in.
 *
 * @remarks
 * Agents use `git` and `gh` in the shell as they would anywhere. This wraps
 * eve's `bash` so that works without a token ever entering the sandbox, and
 * so that what a command may change still depends on who is asking.
 *
 * The orchestrator is the exception: it has no shell at all, only whole
 * `gh` commands that the runtime runs itself (`shellAvailable` in
 * `approval.ts` says why). What follows is how a station's command runs.
 *
 * Each command is sorted by `analyzeCommand` (`shell.ts`) and run one of
 * three ways:
 *
 * 1. Nothing that names `gh` or a networked `git` command: eve's `bash`, as
 *    is.
 * 2. Anything that names them: eve's `bash`, inside a read-only credential
 *    lease. The placeholder is exported into the command's environment,
 *    where the sandbox's `gh` and `git` wrappers (`shims.ts`) hand it to the
 *    real programs. Whatever the command is, it can read the factory
 *    repository and change nothing.
 * 3. A command that is nothing but `gh` commands and changes something, or
 *    nothing but one `git push`: not run by a shell at all. The runtime
 *    parses it against the allowlist, the approval policy checks the effect
 *    against the caller (`approval.ts`), and the runtime runs the parsed
 *    words itself, by absolute path, under a lease scoped to that kind of
 *    write (`lease.ts`).
 *
 * Each agent mounts the tool from its own `tools/bash.ts` with its own
 * sandbox environment, since stations inherit nothing from the orchestrator.
 *
 * What this does not do: isolate the implementer's push from the rest of
 * its sandbox. The push runs where the implementer has a shell, and while
 * it runs its placeholder can be read there (the process environment) by
 * anything else the implementer left running. So the branch rules decide
 * what a well-behaved run pushes; for a run taken over by its input, the
 * limit is the `repo-push` token: contents on the factory repository, which
 * is why branch protection on the default branch is required. The
 * orchestrator has no such gap, because nothing but the runtime's own
 * commands ever runs in its sandbox.
 */

type FactoryEnvironment = SandboxEnvironment<
  object | undefined,
  VercelSandboxSession
>;

/** Runs a command in the sandbox's shell and returns its final result. */
type Shell = (
  input: BashToolInput,
  ctx: Parameters<typeof bash.execute>[1]
) => Promise<BashToolOutput>;

/** eve's `bash`, reduced to its final result when it reports progress. */
const eveShell: Shell = async (input, ctx) => {
  const result = await bash.execute(input, ctx);
  if (!(Symbol.asyncIterator in result)) {
    return result;
  }
  let last: BashToolOutput | undefined;
  for await (const update of result) {
    last = update;
  }
  if (last === undefined) {
    throw new Error("The command produced no result.");
  }
  return last;
};

const completed = (result: CliResult): BashToolOutput => ({
  exitCode: result.exitCode,
  status: "completed",
  stderr: result.stderr,
  stdout: result.stdout,
  truncated: result.truncated,
});

/**
 * Refuses to close or reopen a pull request through `gh issue close` or
 * `gh issue reopen`.
 *
 * @remarks
 * To GitHub a pull request is also an issue, and `gh issue close 34`
 * closes pull request #34. Closing an issue is reversible triage that runs
 * for every caller; closing a pull request is a write that an unattended
 * run is denied. The command alone can't tell the two apart, so this asks
 * GitHub which one the number is before the command runs, and fails closed
 * when it can't find out.
 *
 * @param thread - The issue number the command names. Null is refused.
 */
const assertIsIssue = async (
  sandbox: LeaseSandbox,
  thread: number | null,
  lease: LeaseDependencies | undefined
): Promise<void> => {
  const lookup = parseGh([
    "api",
    `repos/{owner}/{repo}/issues/${thread ?? ""}`,
    "--jq",
    'has("pull_request")',
  ]);
  if (thread === null || !lookup.ok) {
    throw new Error("Pass the issue by its number.");
  }
  const result = await runGh(sandbox, lookup.invocation, "repo-read", lease);
  const answer = result.stdout.trim();
  if (result.exitCode !== 0 || !(answer === "true" || answer === "false")) {
    throw new Error(
      `Could not confirm that #${thread} is an issue, so it was left alone: ${result.stderr.trim().slice(0, 300) || "gh gave no answer"}`
    );
  }
  if (answer === "true") {
    throw new Error(
      `#${thread} is a pull request, not an issue. Closing or reopening a pull request is gh pr close ${thread} or gh pr reopen ${thread}.`
    );
  }
};

/**
 * Reads a `--body-file` from the sandbox, never more than a body may hold.
 *
 * @remarks
 * The path is whatever the agent wrote, so the read is bounded where it
 * happens: `head` stops after one byte more than the limit, which is enough
 * to tell a file that is too long from one that fits, and keeps a device
 * file or a huge one from ever reaching the app runtime's memory.
 *
 * @throws When the file can't be read or is longer than
 * `MAX_GH_ARG_LENGTH` bytes.
 */
const readBodyFile = async (
  sandbox: LeaseSandbox,
  path: string
): Promise<string> => {
  const result = await sandbox.run({
    command: `/usr/bin/head -c ${MAX_GH_ARG_LENGTH + 1} -- ${shellQuote(path)}`,
  });
  if (result.exitCode !== 0) {
    throw new Error(`--body-file: ${path} does not exist or cannot be read.`);
  }
  const text = String(result.stdout ?? "");
  // `head` counts bytes, so the limit is checked in bytes too. Counting
  // characters here would let a cut-off file through whenever it holds a
  // character of more than one byte.
  if (Buffer.byteLength(text, "utf8") > MAX_GH_ARG_LENGTH) {
    throw new Error(
      `--body-file: ${path} is longer than ${MAX_GH_ARG_LENGTH} bytes.`
    );
  }
  return text;
};

export const BODY_FILE_CHANGED_COMMAND =
  "The text in the --body-file would change what this command does, so it was not run. Pass the text with --body instead.";

/** An invocation's words with every body's text blanked out. */
const withoutBodyText = (invocation: GhInvocation): string[] => {
  const words = [...invocation.args];
  for (const body of invocation.bodies) {
    if (body.span === 2) {
      words[body.at + 1] = "";
    } else {
      words[body.at] = (words[body.at] ?? "").slice(
        0,
        (words[body.at] ?? "").indexOf("=") + 1
      );
    }
  }
  return words;
};

/**
 * Whether a command with its body files read is the command that was
 * approved: the same command and effect, and word for word the same apart
 * from the body text.
 *
 * @param approved - The command as the approval policy read it, each
 * `--body-file` an empty `--body`.
 * @param resolved - The same command with the files' text in place.
 */
export const isApprovedCommand = (
  approved: GhInvocation,
  resolved: GhInvocation
): boolean =>
  resolved.command === approved.command &&
  JSON.stringify(resolved.effect) === JSON.stringify(approved.effect) &&
  resolved.bodies.length === approved.bodies.length &&
  JSON.stringify(withoutBodyText(resolved)) ===
    JSON.stringify(withoutBodyText(approved));

/**
 * Parses one `gh` step against the allowlist, reading any `--body-file`
 * from the sandbox so the text becomes the invocation's body.
 *
 * @remarks
 * The approval policy read this step before the file was, with an empty
 * body in its place, and a file's text is whatever is in the checkout: a
 * contributor's pull request can put anything there. So the step is parsed
 * twice, as approved and with the text in, and runs only when the two are
 * the same command ({@link isApprovedCommand}). Text can then fill a body
 * and do nothing else.
 *
 * @throws With the parser's reason when the step is not on the allowlist,
 * or {@link BODY_FILE_CHANGED_COMMAND} when the text changed the command.
 */
const resolveStep = async (
  sandbox: LeaseSandbox,
  step: GhStep
): Promise<GhInvocation> => {
  const inlined = inlineBodyFiles(step.argv);
  if ("reason" in inlined) {
    throw new Error(inlined.reason);
  }
  const approved = parseGh(inlined.argv);
  if (!approved.ok) {
    throw new Error(approved.reason);
  }
  if (inlined.files.length === 0) {
    return approved.invocation;
  }
  const argv = [...inlined.argv];
  for (const file of inlined.files) {
    // biome-ignore lint/performance/noAwaitInLoops: a command has one body file, rarely two
    argv[file.at] = await readBodyFile(sandbox, file.path);
  }
  const resolved = parseGh(argv);
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }
  if (!isApprovedCommand(approved.invocation, resolved.invocation)) {
    throw new Error(BODY_FILE_CHANGED_COMMAND);
  }
  return resolved.invocation;
};

/** Whether every step parses and only reads; unparseable steps count as no. */
const onlyReads = (steps: readonly GhStep[]): boolean =>
  steps.every((step) => {
    const inlined = inlineBodyFiles(step.argv);
    if ("reason" in inlined) {
      return false;
    }
    const parsed = parseGh(inlined.argv);
    return parsed.ok && parsed.invocation.effect.kind === "read";
  });

const STATION_GH_READS_ONLY = "This agent only runs read-only gh commands.";

/**
 * Why a station's `gh` list is not run by the runtime: the first step's own
 * refusal when one does not parse, else that stations only read.
 */
const stationRefusal = (steps: readonly GhStep[]): string => {
  for (const step of steps) {
    const inlined = inlineBodyFiles(step.argv);
    if ("reason" in inlined) {
      return inlined.reason;
    }
    const parsed = parseGh(inlined.argv);
    if (!parsed.ok) {
      return parsed.reason;
    }
  }
  return STATION_GH_READS_ONLY;
};

/**
 * Validates one `gh` step and runs it under the lease its effect calls for.
 *
 * @throws When the step is refused.
 */
const runGhStep = async (
  sandbox: LeaseSandbox,
  step: GhStep,
  role: ShellRole,
  lease: LeaseDependencies | undefined
): Promise<CliResult> => {
  const invocation = await resolveStep(sandbox, step);
  const { effect } = invocation;
  if (role !== "orchestrator" && effect.kind !== "read") {
    throw new Error(STATION_GH_READS_ONLY);
  }
  if (effect.kind === "state") {
    await assertIsIssue(sandbox, effect.commentThread, lease);
  }
  return await runGh(
    sandbox,
    invocation,
    effect.kind === "read" ? "repo-read" : "repo-triage",
    lease
  );
};

/**
 * Runs a list of `gh` commands, one validated invocation at a time, the way
 * a shell would run the list.
 *
 * @remarks
 * A step the runtime refuses (a missing `--body-file`, an issue number that
 * turns out to be a pull request) throws when nothing has run yet. Once an
 * earlier step has run, a refusal is reported as that step failing instead,
 * so the agent still sees what the earlier steps did and does not repeat a
 * comment that was already posted.
 *
 * Only the orchestrator's lists run here. A station's reads run in its
 * shell under the strict read-only lease, and it has no writes, so a
 * station's list is refused before any step runs: a read ahead of a write
 * in one list must not be run by the runtime, whose lease may be on a wider
 * token (`FACTORY_TOKEN_FALLBACK`) in a sandbox the station controls.
 *
 * @returns The steps' output joined in order, with the exit code of the
 * last step that ran.
 * @throws For a station, with the reason from `stationRefusal`.
 */
const runGhSteps = async (
  sandbox: LeaseSandbox,
  steps: readonly GhStep[],
  role: ShellRole,
  lease: LeaseDependencies | undefined
): Promise<BashToolOutput> => {
  if (steps.length > MAX_GH_STEPS) {
    throw new Error(`Run at most ${MAX_GH_STEPS} gh commands in one command.`);
  }
  if (role !== "orchestrator") {
    throw new Error(stationRefusal(steps));
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  let truncated = false;
  let ran = 0;
  for (const [index, step] of steps.entries()) {
    // As in a shell: `&&` skips its own step after a failure, and whatever
    // follows a later `;` still runs.
    if (index > 0 && step.after === "&&" && exitCode !== 0) {
      continue;
    }
    let result: CliResult;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the steps run in order, each depending on the last
      result = await runGhStep(sandbox, step, role, lease);
    } catch (error) {
      if (ran === 0) {
        throw error;
      }
      result = {
        exitCode: 1,
        stderr: error instanceof Error ? error.message : String(error),
        stdout: "",
        truncated: false,
      };
    }
    ran += 1;
    ({ exitCode } = result);
    truncated ||= result.truncated;
    if (result.stdout.trim()) {
      stdout.push(result.stdout.trimEnd());
    }
    if (result.stderr.trim()) {
      stderr.push(result.stderr.trimEnd());
    }
  }
  return {
    exitCode,
    status: "completed",
    stderr: stderr.join("\n"),
    stdout: stdout.join("\n"),
    truncated,
  };
};

/**
 * Runs the implementer's `git push`. With no branch named, the checked-out
 * one is resolved and held to `validateBranch` like any other.
 */
const runPush = async (
  sandbox: LeaseSandbox,
  analysis: Extract<ShellAnalysis, { kind: "push" }>,
  role: ShellRole,
  lease: LeaseDependencies | undefined
): Promise<BashToolOutput> => {
  if (role !== "implementer") {
    throw new Error("This agent never pushes.");
  }
  if (!isRepoDirectory(analysis.directory)) {
    throw new Error("A push runs in the repository checkout.");
  }
  const parsed = parseGitPush(analysis.args);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  let { branch } = parsed.push;
  if (branch === null) {
    const current = await sandbox.run({ command: CURRENT_BRANCH_COMMAND });
    const name = String(current.stdout ?? "").trim();
    if (current.exitCode !== 0 || name === "") {
      throw new Error(
        "Could not tell which branch is checked out. Name it: git push origin <branch>."
      );
    }
    const refusal = validateBranch(name);
    if (refusal) {
      throw new Error(refusal);
    }
    branch = name;
  }
  return completed(await runGitPush(sandbox, branch, lease));
};

export const WHOLE_COMMANDS_ONLY =
  "No read-only GitHub credential is available here, so gh cannot be used in this sandbox, and git reaches GitHub only as a whole command: git fetch origin <branch>, with every argument written out and no pipes, variables, or redirects. If the work needs something from GitHub that the task did not give you, say what in your structured output.";

/**
 * Runs a read without a shell, for a deployment whose GitHub App cannot
 * issue a read-only token.
 *
 * @remarks
 * A shell command is never given a token wider than read-only, whatever
 * `FACTORY_TOKEN_FALLBACK` allows (`withShellLease` in `lease.ts`), so when
 * that token can't be minted the command can't run in the shell. What the
 * runtime can still do is run one `git fetch` it parsed itself: the lease
 * for it follows the fallback setting, and is held to fetching the factory
 * repository at the firewall (`FETCH_PATH` in `lease.ts`), so the wider
 * token behind it can do nothing else from this sandbox.
 *
 * `gh` is not run here at all. Its reads and its writes are the same kind
 * of request to the firewall, so a `gh` read under a wider token would put
 * a credential that can write within reach of everything else running in
 * the station's sandbox.
 *
 * @param cause - The `NarrowTokenError` that ruled the shell out.
 * @throws With {@link WHOLE_COMMANDS_ONLY} for any other command.
 */
const runWithoutShell = async (
  sandbox: LeaseSandbox,
  command: string,
  role: ShellRole,
  lease: LeaseDependencies | undefined,
  cause: unknown
): Promise<BashToolOutput> => {
  const fetch = lexGitFetch(command);
  if (fetch && role !== "orchestrator" && isRepoDirectory(fetch.directory)) {
    const parsed = parseGitFetch(fetch.args);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    return completed(await runGitFetch(sandbox, parsed.commandLine, lease));
  }
  throw new Error(WHOLE_COMMANDS_ONLY, { cause });
};

/** The line that hands a lease to the sandbox's `gh` and `git` wrappers. */
export const leaseExports = (placeholder: string, role: ShellRole): string =>
  `export ${LEASE_VARIABLE}=${shellQuote(placeholder)} ${REPO_VARIABLE}=${shellQuote(FACTORY_REPO)} ${ROLE_VARIABLE}=${shellQuote(role)}`;

const READS = `git and gh work here as usual, against ${FACTORY_REPO} (leave out --repo). Reading works anywhere in a command, pipes included: gh issue view 12 --comments, gh pr view 34 --json title,body,headRefName,isDraft, gh pr diff 34, gh pr checks 34, gh run view 991 --log-failed, gh label list, git fetch origin <branch>.`;

const GITHUB_NOTES: Readonly<Record<ShellRole, string>> = {
  implementer: `${READS} gh is read-only here. To deliver your committed branch, make git push the whole command: git push origin <branch>. Only branches that start with ${FACTORY_BRANCH_PREFIX} can be pushed; force pushes and deleting branches are refused.`,
  orchestrator: `Here this runs gh, the GitHub CLI, and nothing else. gh works against ${FACTORY_REPO} (leave out --repo). Every command is one gh command, or several joined with &&, with every argument written out: no pipes, no variables, no redirects, no other programs. Shape what comes back with --json and --jq. Examples: gh issue view 12 --comments; gh pr view 34 --json title,body,headRefName,isDraft; gh pr diff 34; gh run view 991 --log-failed; gh issue comment 12 --body "Classification is complete."; gh issue edit 12 --add-label bug && gh issue comment 12 --body "Labeled."; gh pr create --draft --head factory/bug-fix-login --base main --title "Fix login 500" --body "...". For text with several lines, or with a dollar sign or a backtick in it, use --body "$(cat <<'EOF' ... EOF)". Merging and pushing are not available.`,
  reader: `${READS} gh is read-only here and this agent never pushes.`,
};

/**
 * The GitHub notes for a role, plus the egress note where the role has a
 * shell and its sandbox is held to the allowlist.
 */
export const githubNotes = (role: ShellRole): string =>
  role !== "orchestrator" && egressMode() === "restricted"
    ? `${GITHUB_NOTES[role]} ${EGRESS_NOTE}`
    : GITHUB_NOTES[role];

/**
 * Builds an agent's `bash` tool.
 *
 * @param options.environment - The mounting agent's own sandbox environment.
 * @param options.lease - Overrides for the credential lease. The test
 * suite's seam; unset in the app.
 * @param options.role - `"orchestrator"`: `gh` writes follow the trust
 * policy, no push. `"implementer"`: `gh` reads, and `git push` to the
 * factory's own branches. `"reader"`: `gh` and `git` read only.
 * @param options.shell - Runs a command in the sandbox's shell. The test
 * suite's seam; eve's `bash` in the app.
 */
export const bashTool = (options: {
  environment: FactoryEnvironment;
  lease?: LeaseDependencies;
  role: ShellRole;
  shell?: Shell;
}) => {
  const { lease, role } = options;
  const shell: Shell = options.shell ?? eveShell;
  return defineTool({
    ...bash,
    approval: bashPolicy(role),
    description: `${bash.description}\n\n${githubNotes(role)}`,
    async execute(input: BashToolInput, ctx): Promise<BashToolOutput> {
      const analysis = analyzeCommand(input.command);
      // The orchestrator has no shell: only gh, run by the runtime. The
      // approval policy has already said so; this holds even if it is ever
      // bypassed.
      const hasShell = shellAvailable(role);
      if (!hasShell && analysis.kind !== "gh") {
        throw new Error(GH_ONLY);
      }
      if (analysis.kind === "plain") {
        return await shell(input, ctx);
      }
      const sandbox: LeaseSandbox = await ctx.getSandbox(options.environment);
      if (analysis.kind === "push") {
        return await runPush(sandbox, analysis, role, lease);
      }
      if (analysis.kind === "gh" && !(hasShell && onlyReads(analysis.steps))) {
        return await runGhSteps(sandbox, analysis.steps, role, lease);
      }
      try {
        return await withShellLease(
          sandbox,
          lease ?? {},
          async ({ placeholder, redact }) => {
            const output = await shell(
              {
                ...input,
                command: `${leaseExports(placeholder, role)}\n${input.command}`,
              },
              ctx
            );
            return {
              ...output,
              stderr: redact(output.stderr),
              stdout: redact(output.stdout),
            };
          }
        );
      } catch (error) {
        if (!(error instanceof NarrowTokenError)) {
          throw error;
        }
        return await runWithoutShell(
          sandbox,
          input.command,
          role,
          lease,
          error
        );
      }
    },
  });
};
