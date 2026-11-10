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
import { CI_LOG_CHARACTERS } from "#lib/triage/decisions.js";
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
    expect(h.calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
      "pr checks 34",
      "run view 991",
    ]);
    expect(h.judged).toHaveLength(1);
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
      cause: null,
      fix_with_code: null,
      log_excerpt: "",
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

  test.each<[string, unknown, string]>([
    [
      "all passing",
      [check("test", "pass"), check("docs", "skipping")],
      "passing",
    ],
    [
      "still running",
      [check("test", "pending"), check("lint", "pass")],
      "pending",
    ],
    [
      "cancelled by a newer push",
      [check("test", "cancel"), check("lint", "pass")],
      "cancelled",
    ],
    [
      "pending wins over cancelled",
      [check("a", "cancel"), check("b", "pending")],
      "pending",
    ],
    ["no checks at all", [], "no-checks"],
  ])(
    "%s: nothing to fix, no log read, no decision made",
    async (_name, checks, status) => {
      const h = harness({ checks });
      const report = await diagnosePullRequestChecks(h.gh, 34, h.dependencies);
      expect(report).toMatchObject({
        cause: null,
        failing_checks: [],
        fix_with_code: false,
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
    expect(h.judged[0]).toContain("expected 200, received 500");
    expect(h.judged[0]?.length).toBeLessThan(CI_LOG_CHARACTERS + 1000);
  });
});
