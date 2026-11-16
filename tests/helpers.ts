import type { SessionAuthContext } from "eve/context";
import { shellQuote } from "#lib/github/cli.js";
import {
  autonomousForTicket,
  stampAutonomous,
  stampSummary,
  stampTrusted,
} from "#lib/trust.js";

/**
 * The caller classes the factory distinguishes, as the channels would stamp
 * them. Shared by every test that exercises an authorization decision.
 */
const person: SessionAuthContext = {
  attributes: { user_login: "octocat" },
  authenticator: "github",
  principalId: "github:583231",
  principalType: "user",
};

export const CALLERS = {
  /** Nobody resolved at all. */
  anonymous: null,
  /** Unattended run dispatched from issue or pull request #12. */
  autonomous: stampAutonomous(person, 12),
  /** A turn dispatched by an eve schedule. */
  schedule: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  /** Run dispatched to summarize pull request #12, opened by anyone. */
  summary: stampSummary(person, 12),
  /** Unattended run dispatched for an intake API ticket: no thread at all. */
  ticket: autonomousForTicket("a".repeat(32), "intake:shared-token"),
  /** A maintainer who mentioned the factory. */
  trusted: stampTrusted(person),
  /** A signed-in person no channel vouched for (the dev TUI, a PR author). */
  untrusted: person,
} as const satisfies Record<string, SessionAuthContext | null>;

export type CallerClass = keyof typeof CALLERS;

/**
 * The parts of an approval context the factory's policies read. The caller
 * is both the one taking this turn (`current`) and the one who started the
 * session (`initiator`); a test about the difference builds its own context.
 */
export const approvalContext = <TInput>(
  caller: SessionAuthContext | null,
  toolInput: TInput
) =>
  ({
    abortSignal: new AbortController().signal,
    callId: "call_test",
    session: {
      auth: { current: caller, initiator: caller },
      id: "session_test",
    },
    toolInput,
    toolName: "test",
  }) as never;

/**
 * Normalizes an approval status to its outcome word. eve's `ApprovalStatus`
 * admits `undefined` and booleans next to the words: `false` continues
 * without a prompt and `true` waits. `undefined` is read as "not-applicable"
 * here too, so a policy that returned nothing at all looks like one that
 * let the call run; a test that has to tell a decision from a missing one
 * compares the raw status instead.
 */
export const outcome = (status: unknown): string => {
  if (status === undefined || status === false) {
    return "not-applicable";
  }
  if (status === true) {
    return "user-approval";
  }
  return typeof status === "string"
    ? status
    : (status as { type: string }).type;
};

/** The reason on a denial, or "" for anything that carries none. */
export const reasonOf = (status: unknown): string =>
  typeof status === "object" && status !== null
    ? String((status as { reason?: unknown }).reason ?? "")
    : "";

/**
 * Writes a `gh` argv as the `bash` command a model would type for it, every
 * argument single-quoted so the words survive exactly.
 */
export const ghCommand = (args: readonly string[]): string =>
  ["gh", ...args.map(shellQuote)].join(" ");
