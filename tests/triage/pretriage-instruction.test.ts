import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  autonomousForTicket,
  stampAutonomous,
  stampIssueIntake,
  stampTrusted,
} from "#lib/trust.js";
import { CALLERS } from "../helpers.js";

/**
 * The dynamic instruction that puts the triage result in front of the
 * orchestrator: when it runs triage, how often, and what it returns. The
 * triage itself is replaced here (`tests/triage/pretriage.test.ts` covers
 * it); the eligibility check and everything around it are the real code.
 */

const { pretriage } = vi.hoisted(() => ({ pretriage: vi.fn() }));

vi.mock("#lib/triage/pretriage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/triage/pretriage.js")>()),
  pretriage,
}));

const { default: definition } = await import("#instructions/pretriage.js");

type Resolve = (ctx: unknown) => Promise<unknown>;
const resolve = (definition as unknown as Record<symbol, Resolve>)[
  Symbol.for("eve.dynamic")
] as Resolve;

const person = CALLERS.untrusted;

/** A dynamic context: a memo that keeps results by key, and a sandbox. */
const context = (
  auth: unknown,
  options: {
    message?: string;
    sandbox?: object;
    turnId?: string | null;
  } = {}
) => {
  const kept = new Map<string, unknown>();
  const keys: unknown[] = [];
  let sandboxes = 0;
  const turnId = options.turnId === undefined ? "turn_1" : options.turnId;
  const ctx = {
    getSandbox: async () => {
      sandboxes += 1;
      return (
        options.sandbox ?? {
          name: "sbx",
          setNetworkPolicy: async () => undefined,
        }
      );
    },
    memo: async (key: unknown, fn: () => Promise<unknown>) => {
      keys.push(key);
      const id = JSON.stringify(key);
      if (!kept.has(id)) {
        kept.set(id, await fn());
      }
      return kept.get(id);
    },
    session: { auth: { current: auth } },
    turn:
      turnId === null
        ? null
        : {
            id: turnId,
            input: [{ kind: "text", text: options.message ?? "hello" }],
            status: "running",
          },
  };
  return { ctx, keys, sandboxes: () => sandboxes };
};

beforeEach(() => {
  pretriage.mockReset();
  pretriage.mockResolvedValue("Triage has already run.");
});

describe("the pre-triage instruction", () => {
  test("a labeled issue: triage runs once for the turn and comes back as a user instruction", async () => {
    const auth = stampIssueIntake(person, 12);
    const { ctx, keys, sandboxes } = context(auth);
    expect(await resolve(ctx)).toMatchObject({
      content: "Triage has already run.",
      role: "user",
    });
    // Before every later model call of the turn it is asked again, and
    // answers from the memo.
    expect(await resolve(ctx)).toMatchObject({
      content: "Triage has already run.",
      role: "user",
    });
    expect(pretriage).toHaveBeenCalledTimes(1);
    expect(pretriage.mock.calls[0]?.slice(0, 2)).toEqual([
      { issueNumber: 12, kind: "issue" },
      auth,
    ]);
    expect(keys).toEqual([
      ["pretriage", "turn_1"],
      ["pretriage", "turn_1"],
    ]);
    expect(sandboxes()).toBe(1);
  });

  test("a later turn in the same session is triaged afresh", async () => {
    const auth = stampIssueIntake(person, 12);
    await resolve(context(auth, { turnId: "turn_1" }).ctx);
    const second = context(auth, { turnId: "turn_2" });
    await resolve(second.ctx);
    expect(pretriage).toHaveBeenCalledTimes(2);
    expect(second.keys).toEqual([["pretriage", "turn_2"]]);
  });

  test("an intake ticket is triaged from the message the turn opened with", async () => {
    const auth = autonomousForTicket("a".repeat(32), "intake:shared-token");
    const { ctx } = context(auth, { message: "# Export times out\n\nBody" });
    expect(await resolve(ctx)).toMatchObject({
      content: "Triage has already run.",
      role: "user",
    });
    expect(pretriage.mock.calls[0]?.[0]).toEqual({
      body: "Body",
      kind: "ticket",
      title: "Export times out",
    });
  });

  test.each([
    ["a maintainer's mention", stampTrusted(person)],
    ["a CI-fix run", stampAutonomous(person, 34)],
    ["a person no channel vouched for", person],
    ["nobody", null],
  ])(
    "%s: no instruction, no triage, and no sandbox is started",
    async (_name, auth) => {
      const { ctx, keys, sandboxes } = context(auth);
      expect(await resolve(ctx)).toBeNull();
      expect(pretriage).not.toHaveBeenCalled();
      expect(keys).toEqual([]);
      expect(sandboxes()).toBe(0);
    }
  );

  test("before the session's first turn exists there is nothing to triage", async () => {
    const { ctx } = context(stampIssueIntake(person, 12), { turnId: null });
    expect(await resolve(ctx)).toBeNull();
    expect(pretriage).not.toHaveBeenCalled();
  });

  test("a triage that yields nothing gives no instruction, and is not tried again for the turn", async () => {
    pretriage.mockResolvedValue(null);
    const { ctx } = context(stampIssueIntake(person, 12));
    expect(await resolve(ctx)).toBeNull();
    expect(await resolve(ctx)).toBeNull();
    expect(pretriage).toHaveBeenCalledTimes(1);
  });

  test("a triage that throws gives no instruction instead of failing the model call", async () => {
    pretriage.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ctx } = context(stampIssueIntake(person, 12));
    expect(await resolve(ctx)).toBeNull();
    expect(await resolve(ctx)).toBeNull();
    expect(pretriage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("a sandbox that cannot hold a credential lease gives no instruction", async () => {
    const { ctx } = context(stampIssueIntake(person, 12), {
      sandbox: { run: async () => undefined },
    });
    expect(await resolve(ctx)).toBeNull();
    expect(pretriage).not.toHaveBeenCalled();
  });
});
