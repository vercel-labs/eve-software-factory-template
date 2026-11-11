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
 * One class of run is the exception: an unattended run on the orchestrator
 * has no shell at all, only whole `gh` commands that the runtime runs
 * itself (`shellAvailable` in `approval.ts` says why).
 *
 * Otherwise, each command is sorted by `analyzeCommand` (`shell.ts`) and run
 * one of three ways:
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
 * What this does not do: isolate a write from the rest of the sandbox. A
 * command of the third kind runs in the same sandbox where the agent has a
 * shell, and while it runs, its placeholder can be read there (the process
 * environment, a temp file name) by anything else the agent left running:
 * a command issued alongside it, or one started in the background earlier.
 * So where the agent has a shell (a station, or an attended run on the
 * orchestrator), the allowlist and the trust policy decide what a
 * well-behaved run does; for a run that has been taken over by its input,
 * the limit is what
 * the leased token can do (`repo-triage`: issues and pull requests, never
 * contents; `repo-push`: contents on the implementer). Queueing commands
 * would not change that, since a background process outlives its command.
 * Closing it needs the writes to run somewhere the agent has no shell.
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
 * Parses one `gh` step against the allowlist, reading any `--body-file`
 * from the sandbox so the text becomes the invocation's body.
 */
/**
 * Reads a `--body-file` from the sandbox, never more than a body may hold.
 *
 * @remarks
 * The path is whatever the agent wrote, so the read is bounded where it
 * happens: `head` stops after one byte more than the limit, which is enough
 * to tell a file that is too long from one that fits, and keeps a device
 * file or a huge one from ever reaching the app runtime's memory.
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

const resolveStep = async (
  sandbox: LeaseSandbox,
  step: GhStep
): Promise<GhInvocation> => {
  const inlined = inlineBodyFiles(step.argv);
  if ("reason" in inlined) {
    throw new Error(inlined.reason);
  }
  const argv = [...inlined.argv];
  for (const file of inlined.files) {
    // biome-ignore lint/performance/noAwaitInLoops: a command has one body file, rarely two
    argv[file.at] = await readBodyFile(sandbox, file.path);
  }
  const parsed = parseGh(argv);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.invocation;
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

/** Runs one validated `gh` step under the lease its effect calls for. */
const runGhStep = async (
  sandbox: LeaseSandbox,
  step: GhStep,
  role: ShellRole,
  lease: LeaseDependencies | undefined
): Promise<CliResult> => {
  const invocation = await resolveStep(sandbox, step);
  const { effect } = invocation;
  if (role !== "orchestrator" && effect.kind !== "read") {
    throw new Error("This agent only runs read-only gh commands.");
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
  "No read-only GitHub credential is available here, so gh and git reach GitHub only as a whole command: one or more gh commands joined with &&, or git fetch origin <branch>, with every argument written out and no pipes, variables, or redirects.";

/**
 * Runs a read without a shell, for a deployment whose GitHub App cannot
 * issue a read-only token.
 *
 * @remarks
 * A shell command is never given a token wider than read-only, whatever
 * `FACTORY_TOKEN_FALLBACK` allows, so when that token can't be minted the
 * command can't run in the shell. What the runtime can still do is run a
 * read it parsed itself: a list of `gh` reads, or one `git fetch`. Those go
 * through the validated runners, which do follow the fallback setting.
 * Anything else is refused with the form that works.
 */
const runWithoutShell = async (
  sandbox: LeaseSandbox,
  command: string,
  analysis: ShellAnalysis,
  role: ShellRole,
  lease: LeaseDependencies | undefined,
  cause: unknown
): Promise<BashToolOutput> => {
  if (analysis.kind === "gh") {
    return await runGhSteps(sandbox, analysis.steps, role, lease);
  }
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
  orchestrator: `${READS} A command that changes GitHub (comment, label, create, edit, close, reopen, gh pr create) has to be the whole command: only gh commands, joined with && when there are several, every argument written out, with no pipes, variables, or redirects. For text with several lines, or with a dollar sign or a backtick in it, use --body "$(cat <<'EOF' ... EOF)" or --body-file <path>. Examples: gh issue comment 12 --body "Classification is complete."; gh issue edit 12 --add-label bug; gh pr create --draft --head factory/bug-fix-login --base main --title "Fix login 500" --body-file pr-body.md. An unattended run has no shell, only gh: whole gh commands, no pipes, no other programs; shape output with --json and --jq. Merging and pushing are not available.`,
  reader: `${READS} gh is read-only here and this agent never pushes.`,
};

/**
 * Builds an agent's `bash` tool.
 *
 * @param options.environment - The mounting agent's own sandbox environment.
 * @param options.role - `"orchestrator"`: `gh` writes follow the trust
 * policy, no push. `"implementer"`: `gh` reads, and `git push` to the
 * factory's own branches. `"reader"`: `gh` and `git` read only.
 */
export const bashTool = (options: {
  environment: FactoryEnvironment;
  /** Overrides for the credential lease. The test suite's seam; unset in the app. */
  lease?: LeaseDependencies;
  role: ShellRole;
  /** Runs a command in the sandbox's shell. The test suite's seam; eve's `bash` in the app. */
  shell?: Shell;
}) => {
  const { lease, role } = options;
  const shell: Shell = options.shell ?? eveShell;
  return defineTool({
    ...bash,
    approval: bashPolicy(role),
    description: `${bash.description}\n\n${GITHUB_NOTES[role]}`,
    async execute(input: BashToolInput, ctx): Promise<BashToolOutput> {
      const analysis = analyzeCommand(input.command);
      // An unattended run on the orchestrator has no shell: only gh, run by
      // the runtime. The approval policy has already said so; this holds
      // even if it is ever bypassed.
      const hasShell = shellAvailable(role, ctx.session.auth.current);
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
          analysis,
          role,
          lease,
          error
        );
      }
    },
  });
};
