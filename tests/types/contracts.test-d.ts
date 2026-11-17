import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { BashToolInput, BashToolOutput } from "eve/tools/bash";
import { describe, expectTypeOf, test } from "vitest";
import type { bashPolicy, shellDecision } from "#lib/github/approval.js";
import type {
  BodyArgument,
  GhEffect,
  GhInvocation,
  GhParseResult,
  parseGh,
} from "#lib/github/cli.js";
import type {
  PushParseResult,
  PushRequest,
  parseGitPush,
  pushCommandLine,
} from "#lib/github/git-cli.js";
import type {
  CliResult,
  LeaseDependencies,
  LeaseSandbox,
  runGitPush,
  ShellLease,
  TokenScope,
  withShellLease,
} from "#lib/github/lease.js";
import type {
  analyzeCommand,
  BodyFileArgument,
  GhStep,
  inlineBodyFiles,
  ShellAnalysis,
} from "#lib/github/shell.js";
import type { ShellRole } from "#lib/github/shims.js";
import type { bashTool, leaseExports } from "#lib/github/tools.js";
import type { Ticket } from "#lib/intake/ticket.js";
import type { FactoryAgent, FactoryModel, MODELS } from "#lib/models.js";
import type { StationResult } from "#lib/stations/result.js";
import type { Triage, TriageLane } from "#lib/triage/decisions.js";
import type { GhRunner } from "#lib/triage/github.js";

/** The keys of `T` that may be left out. */
type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type Parsed = ReturnType<typeof parseGh>;
type Accepted = Extract<Parsed, { ok: true }>;
type Refused = Extract<Parsed, { ok: false }>;

describe("gh allowlist contracts", () => {
  test("GhEffect has exactly eight kinds", () => {
    expectTypeOf<GhEffect["kind"]>().toEqualTypeOf<
      | "read"
      | "label"
      | "comment"
      | "state"
      | "draft-pr"
      | "write"
      | "ship"
      | "forbidden"
    >();
  });

  test("a validated invocation can never carry the forbidden effect", () => {
    expectTypeOf<GhInvocation["effect"]["kind"]>().toEqualTypeOf<
      "read" | "label" | "comment" | "state" | "draft-pr" | "write" | "ship"
    >();
    expectTypeOf<GhInvocation["effect"]>().toEqualTypeOf<
      Exclude<GhEffect, { kind: "forbidden" }>
    >();
    expectTypeOf<
      Extract<GhInvocation["effect"], { kind: "forbidden" }>
    >().toBeNever();
  });

  test("an invocation carries its args, body positions, command, and effect, all read-only", () => {
    expectTypeOf<GhInvocation>().toEqualTypeOf<{
      readonly args: readonly string[];
      readonly bodies: readonly BodyArgument[];
      readonly command: string;
      readonly effect: Exclude<GhEffect, { kind: "forbidden" }>;
    }>();
  });

  test("comment and state effects say which thread they touch", () => {
    expectTypeOf<Extract<GhEffect, { kind: "comment" }>>().toEqualTypeOf<{
      readonly kind: "comment";
      readonly thread: number | null;
    }>();
    expectTypeOf<Extract<GhEffect, { kind: "state" }>>().toEqualTypeOf<{
      readonly kind: "state";
      readonly commentThread: number | null;
      readonly withComment: boolean;
    }>();
    expectTypeOf<Extract<GhEffect, { kind: "forbidden" }>>().toEqualTypeOf<{
      readonly kind: "forbidden";
      readonly reason: string;
    }>();
  });

  test("parseGh takes an argv and returns a union discriminated on ok", () => {
    expectTypeOf<Parameters<typeof parseGh>>().toEqualTypeOf<
      [argv: readonly string[]]
    >();
    expectTypeOf<Parsed>().toEqualTypeOf<GhParseResult>();
    expectTypeOf<Parsed["ok"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Accepted>().toEqualTypeOf<{
      readonly ok: true;
      readonly invocation: GhInvocation;
    }>();
    expectTypeOf<Refused>().toEqualTypeOf<{
      readonly ok: false;
      readonly reason: string;
    }>();
  });

  test("only an accepted parse has an invocation, and only a refused one a reason", () => {
    expectTypeOf<keyof Accepted>().toEqualTypeOf<"ok" | "invocation">();
    expectTypeOf<keyof Refused>().toEqualTypeOf<"ok" | "reason">();
    expectTypeOf<keyof Parsed>().toEqualTypeOf<"ok">();
  });

  test("a token lease is for reading, triage, or pushing, and nothing else", () => {
    expectTypeOf<TokenScope>().toEqualTypeOf<
      "repo-read" | "repo-triage" | "repo-push"
    >();
  });

  test("a gh runner maps an argv to an exit code and both output streams", () => {
    expectTypeOf<Parameters<GhRunner>>().toEqualTypeOf<
      [args: readonly string[]]
    >();
    expectTypeOf<Awaited<ReturnType<GhRunner>>>().toEqualTypeOf<{
      readonly exitCode: number;
      readonly stderr: string;
      readonly stdout: string;
    }>();
  });
});

describe("shell command contracts", () => {
  test("a role is the orchestrator, the implementer, or a reader, and nothing else", () => {
    expectTypeOf<ShellRole>().toEqualTypeOf<
      "implementer" | "orchestrator" | "reader"
    >();
  });

  test("analyzeCommand takes a command string and returns a ShellAnalysis", () => {
    expectTypeOf<Parameters<typeof analyzeCommand>>().toEqualTypeOf<
      [command: string]
    >();
    expectTypeOf<
      ReturnType<typeof analyzeCommand>
    >().toEqualTypeOf<ShellAnalysis>();
  });

  test("a command is one of exactly four kinds", () => {
    expectTypeOf<ShellAnalysis["kind"]>().toEqualTypeOf<
      "plain" | "shell" | "gh" | "push"
    >();
  });

  test("only the two kinds the runtime runs itself carry parsed words", () => {
    expectTypeOf<Extract<ShellAnalysis, { kind: "plain" }>>().toEqualTypeOf<{
      readonly kind: "plain";
    }>();
    expectTypeOf<Extract<ShellAnalysis, { kind: "shell" }>>().toEqualTypeOf<{
      readonly kind: "shell";
    }>();
    expectTypeOf<Extract<ShellAnalysis, { kind: "gh" }>>().toEqualTypeOf<{
      readonly kind: "gh";
      readonly steps: readonly GhStep[];
    }>();
    expectTypeOf<Extract<ShellAnalysis, { kind: "push" }>>().toEqualTypeOf<{
      readonly kind: "push";
      readonly args: readonly string[];
      readonly directory: string | null;
    }>();
  });

  test("a gh step is its words and how it follows the step before it", () => {
    expectTypeOf<GhStep>().toEqualTypeOf<{
      readonly after: "&&" | ";";
      readonly argv: readonly string[];
    }>();
  });

  test("inlineBodyFiles returns the rewritten argv with the files to read, or a reason", () => {
    type Inlined = ReturnType<typeof inlineBodyFiles>;
    expectTypeOf<Parameters<typeof inlineBodyFiles>>().toEqualTypeOf<
      [argv: readonly string[]]
    >();
    expectTypeOf<Extract<Inlined, { reason: string }>>().toEqualTypeOf<{
      readonly reason: string;
    }>();
    expectTypeOf<Exclude<Inlined, { reason: string }>>().toEqualTypeOf<{
      readonly argv: readonly string[];
      readonly files: readonly BodyFileArgument[];
    }>();
    expectTypeOf<BodyFileArgument>().toEqualTypeOf<{
      readonly at: number;
      readonly path: string;
    }>();
  });

  test("bashPolicy takes a role and returns an approval function", () => {
    expectTypeOf<Parameters<typeof bashPolicy>>().toEqualTypeOf<
      [role: ShellRole]
    >();
    expectTypeOf<ReturnType<typeof bashPolicy>>().toBeFunction();
    expectTypeOf<
      ReturnType<ReturnType<typeof bashPolicy>>
    >().toEqualTypeOf<ApprovalStatus>();
    // The policy takes one argument. It declares only the part of the input
    // it reads, so the contract is that eve's own bash context is accepted.
    type Context = Parameters<ReturnType<typeof bashPolicy>>;
    expectTypeOf<Context["length"]>().toEqualTypeOf<1>();
    expectTypeOf<Context[0]>().not.toBeAny();
    expectTypeOf<ApprovalContext<BashToolInput>>().toExtend<Context[0]>();
    expectTypeOf<
      NonNullable<Context[0]["toolInput"]>["command"]
    >().toEqualTypeOf<string | undefined>();
  });

  test("shellDecision maps an analysis, a role, and a caller to an approval status", () => {
    expectTypeOf<Parameters<typeof shellDecision>>().toEqualTypeOf<
      [
        analysis: ShellAnalysis,
        role: ShellRole,
        auth: SessionAuthContext | null,
      ]
    >();
    expectTypeOf<
      ReturnType<typeof shellDecision>
    >().toEqualTypeOf<ApprovalStatus>();
  });

  test("parseGitPush takes the words after push and returns a union discriminated on ok", () => {
    type Pushed = ReturnType<typeof parseGitPush>;
    expectTypeOf<Parameters<typeof parseGitPush>>().toEqualTypeOf<
      [args: readonly string[]]
    >();
    expectTypeOf<Pushed>().toEqualTypeOf<PushParseResult>();
    expectTypeOf<Extract<Pushed, { ok: true }>>().toEqualTypeOf<{
      readonly ok: true;
      readonly push: PushRequest;
    }>();
    expectTypeOf<Extract<Pushed, { ok: false }>>().toEqualTypeOf<{
      readonly ok: false;
      readonly reason: string;
    }>();
  });

  test("a push request names one branch, or none for the checked-out one, and nothing else", () => {
    expectTypeOf<PushRequest>().toEqualTypeOf<{
      readonly branch: string | null;
    }>();
    expectTypeOf<
      Extract<keyof PushRequest, "force" | "remote" | "refspec" | "delete">
    >().toBeNever();
    expectTypeOf<Parameters<typeof pushCommandLine>>().toEqualTypeOf<
      [branch: string]
    >();
  });

  test("the scope of a shell lease is not a parameter", () => {
    type Arguments = Parameters<typeof withShellLease>;
    expectTypeOf<Arguments["length"]>().toEqualTypeOf<3>();
    expectTypeOf<Arguments[1]>().toEqualTypeOf<LeaseDependencies>();
    expectTypeOf<Extract<Arguments[number], TokenScope>>().toBeNever();
    // What a caller may inject is the token source, the clock, and the
    // placeholder: all optional, and none of them a scope.
    expectTypeOf<keyof LeaseDependencies>().toEqualTypeOf<
      "id" | "installationToken" | "mint" | "now"
    >();
    expectTypeOf<OptionalKeys<LeaseDependencies>>().toEqualTypeOf<
      keyof LeaseDependencies
    >();
    // The sandbox it needs cannot run a command: only the caller's shell does.
    expectTypeOf<Arguments[0]>().toEqualTypeOf<
      Pick<LeaseSandbox, "name" | "setNetworkPolicy">
    >();
    expectTypeOf<keyof Arguments[0]>().toEqualTypeOf<
      "name" | "setNetworkPolicy"
    >();
    expectTypeOf<keyof LeaseSandbox>().toEqualTypeOf<
      "name" | "run" | "setNetworkPolicy" | "writeTextFile"
    >();
    // It resolves to whatever the command it ran resolved to.
    expectTypeOf<ReturnType<typeof withShellLease<"done">>>().toEqualTypeOf<
      Promise<"done">
    >();
  });

  test("a shell lease hands the command a placeholder and a redactor, never a token", () => {
    expectTypeOf<ShellLease>().toEqualTypeOf<{
      readonly placeholder: string;
      readonly redact: (text: string) => string;
    }>();
    expectTypeOf<keyof ShellLease>().toEqualTypeOf<"placeholder" | "redact">();
    expectTypeOf<
      Parameters<Parameters<typeof withShellLease>[2]>
    >().toEqualTypeOf<[lease: ShellLease]>();
  });

  test("runGitPush takes a sandbox and a branch name: its scope is not a parameter either", () => {
    expectTypeOf<Parameters<typeof runGitPush>>().toEqualTypeOf<
      [sandbox: LeaseSandbox, branch: string, dependencies?: LeaseDependencies]
    >();
    expectTypeOf<
      Extract<Parameters<typeof runGitPush>[number], TokenScope>
    >().toBeNever();
    expectTypeOf<ReturnType<typeof runGitPush>>().toEqualTypeOf<
      Promise<CliResult>
    >();
  });

  test("a command's result is its exit code, both streams, and whether they were cut: nothing that could carry a credential", () => {
    expectTypeOf<CliResult>().toEqualTypeOf<{
      readonly exitCode: number;
      readonly stderr: string;
      readonly stdout: string;
      readonly truncated: boolean;
    }>();
  });

  test("the tool is built for a role, and its seams are optional", () => {
    type Options = Parameters<typeof bashTool>[0];
    expectTypeOf<Options["role"]>().toEqualTypeOf<ShellRole>();
    expectTypeOf<Options["environment"]>().not.toBeAny();
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<"lease" | "shell">();
    expectTypeOf<Exclude<keyof Options, OptionalKeys<Options>>>().toEqualTypeOf<
      "environment" | "role"
    >();
    expectTypeOf<Options["lease"]>().toEqualTypeOf<
      LeaseDependencies | undefined
    >();
    expectTypeOf<
      Awaited<ReturnType<NonNullable<Options["shell"]>>>
    >().toEqualTypeOf<BashToolOutput>();
    expectTypeOf<
      Parameters<NonNullable<Options["shell"]>>[0]
    >().toEqualTypeOf<BashToolInput>();
  });

  test("leaseExports takes a placeholder and a role and returns one line of shell", () => {
    expectTypeOf<Parameters<typeof leaseExports>>().toEqualTypeOf<
      [placeholder: string, role: ShellRole]
    >();
    expectTypeOf<ReturnType<typeof leaseExports>>().toEqualTypeOf<string>();
  });
});

describe("intake ticket contract", () => {
  test("a ticket requires a string title and body", () => {
    expectTypeOf<Ticket["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Ticket["body"]>().toEqualTypeOf<string>();
    expectTypeOf<Exclude<keyof Ticket, OptionalKeys<Ticket>>>().toEqualTypeOf<
      "title" | "body"
    >();
  });

  test("a ticket's external id and callback URL are optional strings", () => {
    expectTypeOf<Ticket["externalId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Ticket["callbackUrl"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<OptionalKeys<Ticket>>().toEqualTypeOf<
      | "callbackUrl"
      | "externalId"
      | "labels"
      | "priority"
      | "requester"
      | "source"
    >();
  });

  test("a ticket has exactly these fields, and none that could name a principal", () => {
    expectTypeOf<Ticket>().toEqualTypeOf<{
      body: string;
      callbackUrl?: string | undefined;
      externalId?: string | undefined;
      labels?: string[] | undefined;
      priority?: "low" | "normal" | "high" | "urgent" | undefined;
      requester?: string | undefined;
      source?: string | undefined;
      title: string;
    }>();
    expectTypeOf<
      Extract<keyof Ticket, "auth" | "principalId" | "trusted" | "intakeIssue">
    >().toBeNever();
  });
});

describe("triage and station contracts", () => {
  test("triage routes an item to one of four lanes", () => {
    expectTypeOf<Triage["lane"]>().toEqualTypeOf<
      "pipeline" | "clarify" | "answer" | "duplicate"
    >();
    expectTypeOf<Triage["lane"]>().toEqualTypeOf<TriageLane>();
  });

  test("triage classifies with closed vocabularies", () => {
    expectTypeOf<Triage["type"]>().toEqualTypeOf<
      "bug" | "feature" | "refactor" | "question" | "chore" | "security"
    >();
    expectTypeOf<Triage["priority"]>().toEqualTypeOf<
      "critical" | "high" | "medium" | "low"
    >();
    expectTypeOf<Triage["complexity"]>().toEqualTypeOf<
      "trivial" | "small" | "medium" | "large"
    >();
    expectTypeOf<Triage["labels"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Triage["duplicates"]>().toEqualTypeOf<readonly number[]>();
  });

  test("a station settles as completed, cancelled, or failed, and only failed has an error", () => {
    expectTypeOf<StationResult["status"]>().toEqualTypeOf<
      "completed" | "cancelled" | "failed"
    >();
    expectTypeOf<
      Extract<StationResult, { status: "failed" }>["error"]
    >().toEqualTypeOf<{ readonly message: string }>();
    expectTypeOf<
      Extract<StationResult, { status: "completed" | "cancelled" }>["error"]
    >().toEqualTypeOf<undefined>();
  });
});

describe("model assignments", () => {
  test("MODELS assigns exactly the orchestrator, the five stations, and the decision step", () => {
    expectTypeOf<keyof typeof MODELS>().toEqualTypeOf<
      | "analyst"
      | "classifier"
      | "decision"
      | "implementer"
      | "orchestrator"
      | "researcher"
      | "reviewer"
    >();
    expectTypeOf<FactoryModel>().toEqualTypeOf<keyof typeof MODELS>();
  });

  test("the decision model is not an agent", () => {
    expectTypeOf<FactoryAgent>().toEqualTypeOf<
      | "analyst"
      | "classifier"
      | "implementer"
      | "orchestrator"
      | "researcher"
      | "reviewer"
    >();
  });

  test("the orchestrator and decision ids are pinned as literal types", () => {
    expectTypeOf<
      (typeof MODELS)["orchestrator"]
    >().toEqualTypeOf<"anthropic/claude-opus-5.5-fast">();
    expectTypeOf<
      (typeof MODELS)["decision"]
    >().toEqualTypeOf<"google/gemini-decision-1">();
  });
});
