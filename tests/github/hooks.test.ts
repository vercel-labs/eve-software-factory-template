import { getConnectorMetadata } from "@vercel/connect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bashPolicy, stationPolicy } from "#lib/github/approval.js";
import {
  CI_FIX_TASK,
  FACTORY_INTAKE_TASK,
  MAX_CI_FIX_ATTEMPTS,
  onCheckSuite,
  onComment,
  onIssue,
  onPullRequest,
  PR_SUMMARY_TASK,
} from "#lib/github/hooks.js";
import {
  AUTONOMOUS_PRINCIPAL,
  intakeIssueNumber,
  isAutonomous,
  isSummaryOnly,
  isTrusted,
  workItemIssue,
} from "#lib/trust.js";
import { approvalContext, ghCommand, outcome } from "../helpers.js";

/**
 * The dispatch hooks decide, on the signed webhook, whether a GitHub event
 * starts a run and as whom. These tests drive them with webhook-shaped
 * inputs and then feed the resulting identity to the real approval policy,
 * so each case checks the outcome that matters: what that run could do.
 *
 * The policy is the one on the orchestrator's `bash` tool, asked about the
 * `gh` command a dispatched run would type.
 */
type Role = "admin" | "maintain" | "write" | "triage" | "read" | "none";

// The factory's name normally comes from `FACTORY_BOT_NAME`, stubbed below.
// With that unset it is read from the connector's metadata, which this makes
// fail, so the path where the name cannot be resolved runs offline.
vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/connect")>()),
  getConnectorMetadata: vi.fn(() =>
    Promise.reject(new Error("metadata unreachable"))
  ),
}));

/**
 * A webhook context whose `github.request` stands in for the
 * collaborator-permission endpoint. `permission` picks the answer: a role
 * (returned as `role_name`), `"error"` for a response that is not ok, or
 * `"throw"` for a request that fails. `response` replaces the answer whole,
 * for the shapes GitHub sends that the shorthand cannot express.
 */
const context = (
  options: {
    permission?: Role | "error" | "throw";
    response?: { body: Record<string, unknown>; ok: boolean };
    senderLogin?: string;
    senderType?: "User" | "Bot";
  } = {}
) => {
  const requests: string[] = [];
  const ctx = {
    conversation: { issueNumber: 12, kind: "issue", pullRequestNumber: null },
    delivery: { id: "delivery-1" },
    github: {
      installationId: 99,
      request: async ({ path }: { path: string }) => {
        requests.push(path);
        if (options.response !== undefined) {
          return options.response;
        }
        if (options.permission === "throw") {
          throw new Error("network");
        }
        if (options.permission === "error") {
          return { body: {}, ok: false };
        }
        return { body: { role_name: options.permission ?? "write" }, ok: true };
      },
    },
    repository: {
      fullName: "acme/widgets",
      id: 1,
      name: "widgets",
      owner: "acme",
    },
    sender: {
      id: 583_231,
      login: options.senderLogin ?? "maintainer",
      type: options.senderType ?? "User",
    },
    thread: {},
  } as never;
  return { ctx, requests };
};

const comment = (
  body: string,
  association: string,
  author?: { login: string; type: string }
) =>
  ({
    author: author ?? { id: 1, login: "maintainer", type: "User" },
    body,
    htmlUrl: undefined,
    id: 1,
    raw: { author_association: association },
    url: undefined,
  }) as never;

const issue = (action: string, labels: unknown) =>
  ({ action, issueNumber: 12, raw: { labels } }) as never;

const can = (auth: unknown, ...args: string[]) =>
  outcome(
    bashPolicy("orchestrator")(
      approvalContext(auth as never, { command: ghCommand(args) })
    )
  );

beforeEach(() => {
  vi.stubEnv("FACTORY_BOT_NAME", "foreman");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("onComment: who can start a run by mentioning the factory", () => {
  test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "a mention from a %s dispatches a trusted run",
    async (association) => {
      const result = await onComment(
        context().ctx,
        comment("@foreman fix this", association)
      );
      expect(result).not.toBeNull();
      expect(isTrusted(result?.auth ?? null)).toBe(true);
      expect(isAutonomous(result?.auth ?? null)).toBe(false);
      expect(
        can(result?.auth, "issue", "create", "--title", "T", "--body", "B")
      ).toBe("not-applicable");
      expect(can(result?.auth, "pr", "ready", "3")).toBe("user-approval");
    }
  );

  test.each([
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "NONE",
    "MANNEQUIN",
    "",
    // GitHub sends the association in capitals; nothing else is one.
    "owner",
    "Member",
  ])(
    "a mention from association %j dispatches nothing",
    async (association) => {
      expect(
        await onComment(
          context().ctx,
          comment("@foreman fix this", association)
        )
      ).toBeNull();
    }
  );

  test("a missing association dispatches nothing", async () => {
    const bare = {
      author: { id: 1, login: "x", type: "User" },
      body: "@foreman hi",
      id: 1,
      raw: {},
    };
    expect(await onComment(context().ctx, bare as never)).toBeNull();
  });

  test("a comment that does not mention the factory dispatches nothing, even from an owner", async () => {
    for (const body of [
      "please fix this",
      "@foreman-impostor fix",
      "email foreman@example.com",
    ]) {
      expect(await onComment(context().ctx, comment(body, "OWNER"))).toBeNull();
    }
  });

  test("the mention is matched case-insensitively", async () => {
    expect(
      await onComment(context().ctx, comment("@Foreman please", "OWNER"))
    ).not.toBeNull();
  });

  test("when the factory's own name cannot be resolved, a mention dispatches nothing, even from an owner", async () => {
    vi.stubEnv("FACTORY_BOT_NAME", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    vi.mocked(getConnectorMetadata).mockClear();
    expect(
      await onComment(context().ctx, comment("@foreman fix this", "OWNER"))
    ).toBeNull();
    // The name was looked up, and the lookup is what failed.
    expect(getConnectorMetadata).toHaveBeenCalledTimes(1);
  });

  test("bots and the factory's own comments never dispatch", async () => {
    const { ctx } = context();
    expect(
      await onComment(
        ctx,
        comment("@foreman go", "OWNER", {
          login: "dependabot[bot]",
          type: "Bot",
        })
      )
    ).toBeNull();
    expect(
      await onComment(
        ctx,
        comment("@foreman go", "OWNER", { login: "Foreman[bot]", type: "User" })
      )
    ).toBeNull();
    expect(
      await onComment(
        ctx,
        comment("@foreman go <!-- eve:github:prompt -->", "OWNER")
      )
    ).toBeNull();
  });
});

describe("onIssue: the factory label", () => {
  const labeled = issue("labeled", [{ name: "bug" }, { name: "factory" }]);

  test.each<Role>(["admin", "maintain", "write", "triage"])(
    "a %s applying the label dispatches an unattended run",
    async (permission) => {
      const { ctx, requests } = context({ permission });
      const result = await onIssue(ctx, labeled);
      expect(result?.context).toEqual([FACTORY_INTAKE_TASK]);
      expect(result?.auth?.principalId).toBe(AUTONOMOUS_PRINCIPAL);
      expect(result?.auth?.principalType).toBe("service");
      expect(intakeIssueNumber(result?.auth ?? null)).toBe(12);
      // The stamp that marks this run as one work item to triage up front.
      expect(workItemIssue(result?.auth ?? null)).toBe(12);
      expect(isTrusted(result?.auth ?? null)).toBe(false);
      expect(requests).toEqual([
        "/repos/acme/widgets/collaborators/maintainer/permission",
      ]);
    }
  );

  test("the run acts as the factory, never as the person who applied the label", async () => {
    const result = await onIssue(context({ permission: "admin" }).ctx, labeled);
    expect(result?.auth?.principalId).not.toContain("583231");
  });

  test("what that run may do: label, comment on its own issue, open a draft; nothing else", async () => {
    const auth = (await onIssue(context().ctx, labeled))?.auth;
    expect(can(auth, "issue", "edit", "12", "--add-label", "bug")).toBe(
      "not-applicable"
    );
    expect(can(auth, "issue", "comment", "12", "--body", "x")).toBe(
      "not-applicable"
    );
    expect(can(auth, "issue", "comment", "13", "--body", "x")).toBe("denied");
    expect(
      can(
        auth,
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body",
        "B"
      )
    ).toBe("not-applicable");
    expect(can(auth, "pr", "ready", "3")).toBe("denied");
    expect(can(auth, "issue", "create", "--title", "T", "--body", "B")).toBe(
      "denied"
    );
  });

  test.each<Role>(["read", "none"])(
    "a labeler with %s permission dispatches nothing",
    async (permission) => {
      expect(await onIssue(context({ permission }).ctx, labeled)).toBeNull();
    }
  );

  test("fails closed when the permission lookup errors or throws", async () => {
    for (const permission of ["error", "throw"] as const) {
      const { ctx, requests } = context({ permission });
      expect(await onIssue(ctx, labeled)).toBeNull();
      // The lookup ran, and its failure is what stopped the dispatch.
      expect(requests).toHaveLength(1);
    }
  });

  test("a response that is not ok dispatches nothing, whatever its body says", async () => {
    const { ctx, requests } = context({
      response: {
        body: { permission: "admin", role_name: "admin" },
        ok: false,
      },
    });
    expect(await onIssue(ctx, labeled)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  // GitHub answers with a coarse `permission` (read, write, admin) and a
  // finer `role_name`. Triage shows up as permission "read", so the role
  // name is the one to go by when both are there.
  test.each<[string, Record<string, unknown>, boolean]>([
    ["the role name alone", { role_name: "triage" }, true],
    [
      "a triage role under a read permission",
      { permission: "read", role_name: "triage" },
      true,
    ],
    ["the permission alone, from an older API", { permission: "write" }, true],
    ["a read permission alone", { permission: "read" }, false],
    ["an empty body", {}, false],
    ["a role that is not a string", { role_name: 1 }, false],
    [
      "a custom role over a read permission",
      { permission: "read", role_name: "docs-editor" },
      false,
    ],
  ])("the labeler's role is read from %s", async (_name, body, dispatches) => {
    const result = await onIssue(
      context({ response: { body, ok: true } }).ctx,
      labeled
    );
    expect(result !== null).toBe(dispatches);
  });

  test("a bot applying the label dispatches nothing, and its permission is never looked up", async () => {
    const { ctx, requests } = context({
      permission: "admin",
      senderType: "Bot",
    });
    expect(await onIssue(ctx, labeled)).toBeNull();
    expect(requests).toEqual([]);
  });

  test("other actions and other labels dispatch nothing", async () => {
    const { ctx, requests } = context({ permission: "admin" });
    expect(
      await onIssue(ctx, issue("opened", [{ name: "factory" }]))
    ).toBeNull();
    expect(
      await onIssue(ctx, issue("unlabeled", [{ name: "factory" }]))
    ).toBeNull();
    expect(await onIssue(ctx, issue("labeled", [{ name: "bug" }]))).toBeNull();
    expect(
      await onIssue(ctx, issue("labeled", [{ name: "Factory" }]))
    ).toBeNull();
    expect(await onIssue(ctx, issue("labeled", undefined))).toBeNull();
    expect(await onIssue(ctx, issue("labeled", "factory"))).toBeNull();
    expect(requests).toEqual([]);
  });

  test("a hostile login is encoded into the permission lookup, not interpolated", async () => {
    const { ctx, requests } = context({
      permission: "none",
      senderLogin: "x/../../../admin",
    });
    await onIssue(ctx, labeled);
    expect(requests).toEqual([
      "/repos/acme/widgets/collaborators/x%2F..%2F..%2F..%2Fadmin/permission",
    ]);
  });
});

describe("onCheckSuite: red CI on the factory's own pull requests", () => {
  const suite = (overrides: Record<string, unknown> = {}) =>
    ({
      action: "completed",
      app: { slug: "github-actions" },
      checkSuiteId: 1,
      conclusion: "failure",
      headSha: "abc",
      pullRequests: [34],
      raw: { check_suite: { head_branch: "factory/bug-fix-login" } },
      status: "completed",
      ...overrides,
    }) as never;

  test("a failed suite on a factory branch dispatches an unattended fix run on that pull request", () => {
    const result = onCheckSuite(context().ctx, suite());
    expect(result?.context).toEqual([CI_FIX_TASK]);
    expect(isAutonomous(result?.auth ?? null)).toBe(true);
    expect(isTrusted(result?.auth ?? null)).toBe(false);
    expect(isSummaryOnly(result?.auth ?? null)).toBe(false);
    expect(intakeIssueNumber(result?.auth ?? null)).toBe(34);
    // A red check is not a work item: nothing is triaged before this turn.
    expect(workItemIssue(result?.auth ?? null)).toBeNull();
    expect(
      can(result?.auth, "pr", "comment", "34", "--body", "CI fix attempt 1")
    ).toBe("not-applicable");
    expect(can(result?.auth, "pr", "comment", "35", "--body", "x")).toBe(
      "denied"
    );
  });

  test("a suite on several pull requests is anchored to the first", () => {
    const result = onCheckSuite(
      context().ctx,
      suite({ pullRequests: [34, 35] })
    );
    expect(intakeIssueNumber(result?.auth ?? null)).toBe(34);
  });

  test("the branch name is also read from the top level of the payload", () => {
    expect(
      onCheckSuite(context().ctx, suite({ raw: { head_branch: "factory/x" } }))
    ).not.toBeNull();
  });

  test.each<[string, Record<string, unknown>]>([
    [
      "a suite on a branch a person pushed",
      { raw: { check_suite: { head_branch: "feature/login" } } },
    ],
    [
      "a branch that only contains the prefix",
      { raw: { check_suite: { head_branch: "my-factory/x" } } },
    ],
    ["a passing suite", { conclusion: "success" }],
    ["a cancelled suite", { conclusion: "cancelled" }],
    ["a suite that timed out", { conclusion: "timed_out" }],
    ["a suite waiting on someone", { conclusion: "action_required" }],
    ["a neutral suite", { conclusion: "neutral" }],
    ["a suite with no conclusion yet", { conclusion: null }],
    ["a suite that has not completed", { action: "requested" }],
    ["a suite with no pull request", { pullRequests: [] }],
    ["a payload with no branch", { raw: {} }],
    ["a non-string branch", { raw: { check_suite: { head_branch: 7 } } }],
  ])("%s dispatches nothing", (_name, overrides) => {
    expect(onCheckSuite(context().ctx, suite(overrides))).toBeNull();
  });

  test("the task caps the loop and routes through diagnosis first", () => {
    expect(MAX_CI_FIX_ATTEMPTS).toBe(2);
    expect(CI_FIX_TASK).toContain("diagnose_ci_failure");
    expect(CI_FIX_TASK).toContain("fix_with_code");
    expect(CI_FIX_TASK).toContain(`already ${MAX_CI_FIX_ATTEMPTS}`);
  });
});

describe("onPullRequest: the summary comment", () => {
  const pullRequest = (action: string) =>
    ({ action, headSha: "abc", pullRequestNumber: 34, raw: {} }) as never;

  test("a pull request opened by anyone dispatches a summary-only run on that pull request", () => {
    const result = onPullRequest(context().ctx, pullRequest("opened"));
    expect(result?.context).toEqual([PR_SUMMARY_TASK]);
    expect(isSummaryOnly(result?.auth ?? null)).toBe(true);
    expect(isTrusted(result?.auth ?? null)).toBe(false);
    expect(intakeIssueNumber(result?.auth ?? null)).toBe(34);
    expect(result?.auth?.principalId).toBe(AUTONOMOUS_PRINCIPAL);
  });

  test("whatever the pull request says, that run can only read and comment on it", () => {
    const auth = onPullRequest(context().ctx, pullRequest("opened"))?.auth;
    expect(can(auth, "pr", "diff", "34")).toBe("not-applicable");
    expect(can(auth, "pr", "comment", "34", "--body", "Summary")).toBe(
      "not-applicable"
    );
    expect(can(auth, "pr", "comment", "35", "--body", "x")).toBe("denied");
    expect(can(auth, "issue", "close", "1")).toBe("denied");
    expect(can(auth, "issue", "edit", "34", "--add-label", "bug")).toBe(
      "denied"
    );
    expect(
      can(
        auth,
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body",
        "B"
      )
    ).toBe("denied");
    expect(can(auth, "pr", "ready", "34")).toBe("denied");
    expect(
      outcome(
        stationPolicy(
          approvalContext(auth as never, { message: "implement this" })
        )
      )
    ).toBe("denied");
  });

  test("bot-opened pull requests and other actions dispatch nothing", () => {
    expect(
      onPullRequest(context({ senderType: "Bot" }).ctx, pullRequest("opened"))
    ).toBeNull();
    for (const action of [
      "synchronize",
      "closed",
      "reopened",
      "edited",
      "ready_for_review",
    ]) {
      expect(onPullRequest(context().ctx, pullRequest(action))).toBeNull();
    }
  });
});

describe("the injected tasks name only tools the orchestrator has", () => {
  test("no task mentions the removed GitHub tools", () => {
    for (const task of [FACTORY_INTAKE_TASK, CI_FIX_TASK, PR_SUMMARY_TASK]) {
      expect(task).not.toMatch(
        /github__|push_branch|factory_brain|user_preferences/
      );
      expect(task).not.toContain("—");
    }
  });
});
