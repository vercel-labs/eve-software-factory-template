import { Experimental_DecisionMockModelV4 as DecisionMockModel } from "ai/test";
import { decide } from "eve/ai";
import { describe, expect, test } from "vitest";
import { parseGh } from "#lib/github/cli.js";
import {
  type LeaseSandbox,
  MAX_OUTPUT_CHARACTERS,
  runGh,
} from "#lib/github/lease.js";
import { diagnosePullRequestChecks } from "#lib/triage/ci.js";
import type { GhRunner } from "#lib/triage/github.js";

/**
 * CI diagnosis end to end: `gh` answers come from fixtures, the decision is
 * made by eve's real `decide()` against a scripted model, and everything
 * between them is the real code.
 */
const check = (name: string, bucket: string, link: string | null = null) => ({
  bucket,
  link,
  name,
  state: bucket.toUpperCase(),
  workflow: "CI",
});

const RUN_LINK = "https://github.com/acme/widgets/actions/runs/991/job/5";

const harness = (options: {
  cause?: string;
  checks?: unknown;
  checksStderr?: string;
  log?: string | null;
}) => {
  const calls: string[][] = [];
  const judged: string[] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "checks") {
      return options.checks === undefined
        ? { exitCode: 1, stderr: options.checksStderr ?? "", stdout: "" }
        : { exitCode: 1, stderr: "", stdout: JSON.stringify(options.checks) };
    }
    if (args[0] === "run" && args[1] === "view") {
      return options.log === null || options.log === undefined
        ? {
            exitCode: 1,
            stderr: "HTTP 403: Resource not accessible by integration",
            stdout: "",
          }
        : { exitCode: 0, stderr: "", stdout: options.log };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const model = new DecisionMockModel({
    doDecide: async (call) => {
      judged.push(JSON.stringify(call.state));
      return {
        answers: { cause: { choice: options.cause ?? "code", type: "choice" } },
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  });
  return { calls, dependencies: { decide, model }, gh, judged };
};

describe("diagnosePullRequestChecks", () => {
  test("a failure the code caused: the log is read, judged, and excerpted", async () => {
    const h = harness({
      cause: "code",
      checks: [check("test", "fail", RUN_LINK), check("lint", "pass")],
      log: "FAIL src/login.test.ts\nexpected 200, received 500",
    });
    const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
    expect(report).toEqual({
      cancelled_checks: 0,
      cause: "code",
      confidence: null,
      failing_checks: [
        { link: RUN_LINK, name: "test", runId: "991", workflow: "CI" },
      ],
      fix_with_code: true,
      log_excerpt: "FAIL src/login.test.ts\nexpected 200, received 500",
      pending_checks: 0,
      status: "failing",
    });
    expect(h.calls).toEqual([
      ["pr", "checks", "34", "--json", "name,state,bucket,link,workflow"],
      ["run", "view", "991", "--log-failed"],
    ]);
    expect(h.judged).toHaveLength(1);
  });

  test("pending and cancelled checks are counted next to a failure", async () => {
    const h = harness({
      checks: [
        check("test", "fail", RUN_LINK),
        check("e2e", "pending"),
        check("deploy", "pending"),
        check("nightly", "cancel"),
        check("lint", "pass"),
      ],
      log: "FAIL src/login.test.ts",
    });
    const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
    expect(report).toMatchObject({
      cancelled_checks: 1,
      pending_checks: 2,
      status: "failing",
    });
    expect(report.failing_checks.map((failing) => failing.name)).toEqual([
      "test",
    ]);
  });

  test("the excerpt is the bounded tail of the log, not all of it", async () => {
    const h = harness({
      checks: [check("test", "fail", RUN_LINK)],
      log: `HEAD-MARKER${"x".repeat(20_000)}TAIL-MARKER`,
    });
    const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
    // 6000 is LOG_EXCERPT_CHARACTERS, written out so raising it fails here.
    expect(report.log_excerpt).toHaveLength(6000);
    expect(report.log_excerpt.endsWith("TAIL-MARKER")).toBe(true);
    expect(report.log_excerpt).not.toContain("HEAD-MARKER");
  });

  test.each(["flaky", "infrastructure", "configuration"])(
    "a %s failure is reported as not fixable with code",
    async (cause) => {
      const h = harness({
        cause,
        checks: [check("test", "fail", RUN_LINK)],
        log: "runner lost",
      });
      const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
      expect(report).toMatchObject({
        cause,
        fix_with_code: false,
        status: "failing",
      });
    }
  );

  test("failing checks with no readable log are unknown, never 'the code is fine'", async () => {
    const h = harness({
      checks: [check("vercel", "fail", "https://vercel.com/acme/widgets/abc")],
      log: null,
    });
    const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
    expect(report).toMatchObject({
      cancelled_checks: 0,
      cause: null,
      fix_with_code: null,
      log_excerpt: "",
      pending_checks: 0,
      status: "failing-no-log",
    });
    expect(report.failing_checks).toHaveLength(1);
    expect(h.judged).toEqual([]);
  });

  test("a log that could not be fetched is also unknown", async () => {
    const h = harness({ checks: [check("test", "fail", RUN_LINK)], log: null });
    const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
    expect(report.status).toBe("failing-no-log");
    expect(report.fix_with_code).toBeNull();
    expect(h.judged).toEqual([]);
  });

  test.each<[string, unknown, string, [number, number]]>([
    [
      "all passing",
      [check("test", "pass"), check("docs", "skipping")],
      "passing",
      [0, 0],
    ],
    [
      "still running",
      [check("test", "pending"), check("lint", "pass")],
      "pending",
      [1, 0],
    ],
    [
      "cancelled by a newer push",
      [check("test", "cancel"), check("lint", "pass")],
      "cancelled",
      [0, 1],
    ],
    [
      "pending wins over cancelled",
      [check("a", "cancel"), check("b", "pending")],
      "pending",
      [1, 1],
    ],
    ["no checks at all", [], "no-checks", [0, 0]],
  ])(
    "%s: nothing to fix, no log read, no decision made",
    async (_name, checks, status, [pending, cancelled]) => {
      const h = harness({ checks });
      const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
      expect(report).toEqual({
        cancelled_checks: cancelled,
        cause: null,
        confidence: null,
        failing_checks: [],
        fix_with_code: false,
        log_excerpt: "",
        pending_checks: pending,
        status,
      });
      expect(h.calls).toHaveLength(1);
      expect(h.judged).toEqual([]);
    }
  );

  test("gh's own 'no checks reported' is the no-checks status", async () => {
    const h = harness({
      checksStderr: "no checks reported on the 'factory/x' branch",
    });
    expect(
      (await diagnosePullRequestChecks(h.gh, 34, h.dependencies)).status
    ).toBe("no-checks");
  });

  test("a pull request that cannot be read is an error, not a diagnosis", async () => {
    const h = harness({ checksStderr: "no pull requests found" });
    await expect(
      diagnosePullRequestChecks(h.gh, 34, h.dependencies)
    ).rejects.toThrow(/Reading checks for #34 failed/);
  });
});

describe("the failure at the end of a long log reaches the decision", () => {
  const FAILURE =
    "##[error]Process completed with exit code 1: expected 200, received 500";
  const longLog = `${"setup step output line\n".repeat(8000)}${FAILURE}`;

  test("the lease keeps the tail of a run log, where the failure is", async () => {
    expect(longLog.length).toBeGreaterThan(MAX_OUTPUT_CHARACTERS * 2);
    const sandbox: LeaseSandbox = {
      name: "sbx_ci",
      run: async () => ({ exitCode: 0, stderr: "", stdout: longLog }),
      setNetworkPolicy: async () => undefined,
      writeTextFile: async () => undefined,
    };
    const parsed = parseGh(["run", "view", "991", "--log-failed"]);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    const result = await runGh(sandbox, parsed.invocation, "repo-read", {
      mint: async () => "ghs_test_token_0123456789abcdefghij",
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith(FAILURE)).toBe(true);
    expect(result.stdout.startsWith("[earlier output truncated]")).toBe(true);
  });

  test("other commands keep the head, where their answer is", async () => {
    const sandbox: LeaseSandbox = {
      name: "sbx_ci_head",
      run: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: `FIRST LINE\n${"x".repeat(MAX_OUTPUT_CHARACTERS * 2)}`,
      }),
      setNetworkPolicy: async () => undefined,
      writeTextFile: async () => undefined,
    };
    const parsed = parseGh(["pr", "diff", "34"]);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    const result = await runGh(sandbox, parsed.invocation, "repo-read", {
      mint: async () => "ghs_test_token_0123456789abcdefghij",
    });
    expect(result.stdout.startsWith("FIRST LINE")).toBe(true);
    expect(result.stdout.endsWith("[output truncated]")).toBe(true);
  });

  test("through the whole diagnosis, the judged text and the excerpt both contain the failing line", async () => {
    const sandbox: LeaseSandbox = {
      name: "sbx_ci_full",
      run: async ({ command }) =>
        command.includes("'checks'")
          ? {
              exitCode: 1,
              stderr: "",
              stdout: JSON.stringify([check("test", "fail", RUN_LINK)]),
            }
          : { exitCode: 0, stderr: "", stdout: longLog },
      setNetworkPolicy: async () => undefined,
      writeTextFile: async () => undefined,
    };
    const gh: GhRunner = (args) => {
      const parsed = parseGh(args);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }
      return runGh(sandbox, parsed.invocation, "repo-read", {
        mint: async () => "ghs_test_token_0123456789abcdefghij",
      });
    };
    const h = harness({ cause: "code" });
    const report = await diagnosePullRequestChecks(gh, 34, h.dependencies);
    expect(report.status).toBe("failing");
    expect(report.log_excerpt.endsWith(FAILURE)).toBe(true);
    expect(h.judged).toHaveLength(1);
    const [judged] = h.judged as [string];
    expect(judged).toContain("expected 200, received 500");
    // The decision sees at most 16,000 characters of log (CI_LOG_CHARACTERS,
    // written out), far less than the 60,000 the lease let through.
    expect(judged.length).toBeLessThan(17_000);
  });
});
