import { describe, expectTypeOf, test } from "vitest";
import type {
  GhEffect,
  GhInvocation,
  GhParseResult,
  parseGh,
} from "#lib/github/cli.js";
import type { TokenScope } from "#lib/github/lease.js";
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

  test("an invocation carries its args, command, and effect, all read-only", () => {
    expectTypeOf<GhInvocation>().toEqualTypeOf<{
      readonly args: readonly string[];
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
    >().toEqualTypeOf<"anthropic/claude-fable-5.2">();
    expectTypeOf<
      (typeof MODELS)["decision"]
    >().toEqualTypeOf<"typesafe-ai/jev">();
  });
});
