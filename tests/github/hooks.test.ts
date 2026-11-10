import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ghPolicy } from "#lib/github/approval.js";
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
  isTrusted,
} from "#lib/trust.js";
import { approvalContext, outcome } from "../helpers.js";

/**
 * The dispatch hooks decide, on the signed webhook, whether a GitHub event
 * starts a run and as whom. These tests drive them with webhook-shaped
 * inputs and then feed the resulting identity to the real approval policy,
 * so each case checks the outcome that matters: what that run could do.
 */
type Role = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const context = (
  options: {
    permission?: Role | "error" | "throw";
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
  outcome(ghPolicy(approvalContext(auth as never, { args })));

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

  test("bots and the factory's own comments never dispatch", async () => {
    const ctx = context().ctx;
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
    expect(
      await onIssue(context({ permission: "error" }).ctx, labeled)
    ).toBeNull();
    expect(
      await onIssue(context({ permission: "throw" }).ctx, labeled)
    ).toBeNull();
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
    expect(intakeIssueNumber(result?.auth ?? null)).toBe(34);
    expect(
      can(result?.auth, "pr", "comment", "34", "--body", "CI fix attempt 1")
    ).toBe("not-applicable");
    expect(can(result?.auth, "pr", "comment", "35", "--body", "x")).toBe(
      "denied"
    );
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

  test("a pull request opened by a person dispatches an untrusted run", () => {
    const result = onPullRequest(context().ctx, pullRequest("opened"));
    expect(result?.context).toEqual([PR_SUMMARY_TASK]);
    expect(isTrusted(result?.auth ?? null)).toBe(false);
    expect(isAutonomous(result?.auth ?? null)).toBe(false);
    expect(can(result?.auth, "pr", "comment", "34", "--body", "Summary")).toBe(
      "user-approval"
    );
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
