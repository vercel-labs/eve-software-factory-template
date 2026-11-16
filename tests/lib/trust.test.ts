import type { SessionAuthContext } from "eve/context";
import { describe, expect, test } from "vitest";
import {
  AUTONOMOUS_PRINCIPAL,
  autonomousForTicket,
  INTAKE_CALLER_ATTRIBUTE,
  INTAKE_ISSUE_ATTRIBUTE,
  INTAKE_TICKET_ATTRIBUTE,
  intakeIssueNumber,
  isAutonomous,
  isScheduleAppAuth,
  isSummaryOnly,
  isTrusted,
  SCOPE_ATTRIBUTE,
  SUMMARY_SCOPE,
  stampAutonomous,
  stampSummary,
  stampTrusted,
  TRUSTED_ATTRIBUTE,
} from "#lib/trust.js";

/** A GitHub user as the GitHub channel projects one, deeply frozen. */
const githubUser = (
  attributes: SessionAuthContext["attributes"] = { login: "octocat" }
): SessionAuthContext =>
  Object.freeze({
    attributes: Object.freeze({ ...attributes }),
    authenticator: "github",
    issuer: "https://github.com",
    principalId: "github:583231",
    principalType: "user",
    subject: "583231",
  });

const SCHEDULE_APP: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};

const TICKET_ID = "0123456789abcdef0123456789abcdef";

describe("AUTONOMOUS_PRINCIPAL", () => {
  test("cannot collide with a real GitHub actor, whose principal is numeric", () => {
    expect(AUTONOMOUS_PRINCIPAL).toMatch(/^github:/);
    expect(AUTONOMOUS_PRINCIPAL).not.toMatch(/^github:\d+$/);
  });
});

describe("stampTrusted", () => {
  test("returns an auth the trust check accepts", () => {
    expect(isTrusted(stampTrusted(githubUser()))).toBe(true);
  });

  test("changes nothing but the trust stamp", () => {
    const auth = githubUser({ login: "octocat", teams: ["core", "infra"] });

    expect(stampTrusted(auth)).toEqual({
      ...auth,
      attributes: { ...auth.attributes, [TRUSTED_ATTRIBUTE]: "true" },
    });
  });

  test("does not mutate the auth it was given", () => {
    const auth = githubUser();
    const stamped = stampTrusted(auth);

    expect(stamped).not.toBe(auth);
    expect(stamped.attributes).not.toBe(auth.attributes);
    expect(auth).toEqual(githubUser());
    expect(isTrusted(auth)).toBe(false);
  });

  test("does not make the caller autonomous", () => {
    expect(isAutonomous(stampTrusted(githubUser()))).toBe(false);
  });

  test("overrides a pre-existing falsy trust value", () => {
    expect(
      isTrusted(stampTrusted(githubUser({ [TRUSTED_ATTRIBUTE]: "false" })))
    ).toBe(true);
  });
});

describe("stampAutonomous", () => {
  test("replaces the sender with the unattended service principal", () => {
    const stamped = stampAutonomous(githubUser(), 12);

    expect(stamped.principalId).toBe(AUTONOMOUS_PRINCIPAL);
    expect(stamped.principalType).toBe("service");
    expect(isAutonomous(stamped)).toBe(true);
  });

  test("carries the intake issue number, readable back as a number", () => {
    const stamped = stampAutonomous(githubUser(), 12);

    expect(stamped.attributes[INTAKE_ISSUE_ATTRIBUTE]).toBe("12");
    expect(intakeIssueNumber(stamped)).toBe(12);
  });

  test("keeps every other field and attribute of the auth", () => {
    const auth = githubUser({ login: "octocat", teams: ["core"] });

    expect(stampAutonomous(auth, 12)).toEqual({
      ...auth,
      attributes: { ...auth.attributes, [INTAKE_ISSUE_ATTRIBUTE]: "12" },
      principalId: AUTONOMOUS_PRINCIPAL,
      principalType: "service",
    });
  });

  test("does not mutate the auth it was given", () => {
    const auth = githubUser();
    const stamped = stampAutonomous(auth, 12);

    expect(stamped).not.toBe(auth);
    expect(stamped.attributes).not.toBe(auth.attributes);
    expect(auth).toEqual(githubUser());
    expect(isAutonomous(auth)).toBe(false);
  });

  test("does not grant trust to an untrusted labeler", () => {
    expect(isTrusted(stampAutonomous(githubUser(), 12))).toBe(false);
  });

  test("replaces an intake issue number the auth already carried", () => {
    const restamped = stampAutonomous(stampAutonomous(githubUser(), 12), 34);

    expect(intakeIssueNumber(restamped)).toBe(34);
  });
});

describe("stampSummary", () => {
  test("is the unattended principal for that pull request, marked summary-only", () => {
    const auth = githubUser({ login: "octocat", teams: ["core"] });

    expect(stampSummary(auth, 57)).toEqual({
      ...auth,
      attributes: {
        ...auth.attributes,
        [INTAKE_ISSUE_ATTRIBUTE]: "57",
        [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE,
      },
      principalId: AUTONOMOUS_PRINCIPAL,
      principalType: "service",
    });
  });

  test("is recognized as summary-only, as unattended, and as scoped to its pull request", () => {
    const stamped = stampSummary(githubUser(), 57);

    expect(isSummaryOnly(stamped)).toBe(true);
    expect(isAutonomous(stamped)).toBe(true);
    expect(intakeIssueNumber(stamped)).toBe(57);
  });

  test("does not grant trust to whoever opened the pull request", () => {
    expect(isTrusted(stampSummary(githubUser(), 57))).toBe(false);
  });

  test("does not mutate the auth it was given", () => {
    const auth = githubUser();
    const stamped = stampSummary(auth, 57);

    expect(stamped).not.toBe(auth);
    expect(stamped.attributes).not.toBe(auth.attributes);
    expect(auth).toEqual(githubUser());
    expect(isSummaryOnly(auth)).toBe(false);
  });
});

describe("isSummaryOnly", () => {
  test("is false for no auth", () => {
    expect(isSummaryOnly(null)).toBe(false);
  });

  test.each([
    ["an ordinary unattended run", stampAutonomous(githubUser(), 57)],
    ["an intake ticket run", autonomousForTicket(TICKET_ID, "intake:token")],
    [
      "a user who put the scope in an attribute",
      githubUser({ [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE }),
    ],
    [
      "a trusted user who did the same",
      stampTrusted(githubUser({ [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE })),
    ],
    [
      "the schedule app with the scope",
      { ...SCHEDULE_APP, attributes: { [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE } },
    ],
    [
      "an unattended run with a differently cased scope",
      stampAutonomous(githubUser({ [SCOPE_ATTRIBUTE]: "Summary" }), 57),
    ],
    [
      "an unattended run with the scope in a list",
      stampAutonomous(githubUser({ [SCOPE_ATTRIBUTE]: [SUMMARY_SCOPE] }), 57),
    ],
    [
      "an unattended run with the scope under another key",
      stampAutonomous(githubUser({ scope: SUMMARY_SCOPE }), 57),
    ],
  ])("is false for %s", (_case, auth) => {
    expect(isSummaryOnly(auth)).toBe(false);
  });

  test("is true for an unattended run that carries the scope", () => {
    expect(
      isSummaryOnly(
        stampAutonomous(githubUser({ [SCOPE_ATTRIBUTE]: SUMMARY_SCOPE }), 57)
      )
    ).toBe(true);
  });
});

describe("autonomousForTicket", () => {
  const auth = autonomousForTicket(TICKET_ID, "intake:shared-token");

  test("is the unattended service principal, authenticated by intake", () => {
    expect(auth.principalId).toBe(AUTONOMOUS_PRINCIPAL);
    expect(auth.principalType).toBe("service");
    expect(auth.authenticator).toBe("intake");
    expect(isAutonomous(auth)).toBe(true);
  });

  test("records the ticket and the verified caller, and nothing else", () => {
    expect(auth).toEqual({
      attributes: {
        [INTAKE_CALLER_ATTRIBUTE]: "intake:shared-token",
        [INTAKE_TICKET_ATTRIBUTE]: TICKET_ID,
      },
      authenticator: "intake",
      principalId: AUTONOMOUS_PRINCIPAL,
      principalType: "service",
    });
  });

  test("is untrusted", () => {
    expect(auth.attributes).not.toHaveProperty(TRUSTED_ATTRIBUTE);
    expect(isTrusted(auth)).toBe(false);
  });

  test("has no intake issue, so no thread to comment on", () => {
    expect(auth.attributes).not.toHaveProperty(INTAKE_ISSUE_ATTRIBUTE);
    expect(intakeIssueNumber(auth)).toBeNull();
  });

  test("is not the schedule app principal", () => {
    expect(isScheduleAppAuth(auth)).toBe(false);
  });

  test("stays untrusted and issue-less whatever the ticket id and caller say", () => {
    const hostile = autonomousForTicket(
      INTAKE_ISSUE_ATTRIBUTE,
      TRUSTED_ATTRIBUTE
    );
    const numeric = autonomousForTicket("12", "true");

    for (const candidate of [hostile, numeric]) {
      expect(isTrusted(candidate)).toBe(false);
      expect(intakeIssueNumber(candidate)).toBeNull();
      expect(candidate.principalId).toBe(AUTONOMOUS_PRINCIPAL);
    }
  });

  test("builds a fresh object for every ticket", () => {
    const first = autonomousForTicket(TICKET_ID, "intake:shared-token");
    const second = autonomousForTicket(TICKET_ID, "intake:shared-token");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.attributes).not.toBe(second.attributes);
  });
});

describe("intakeIssueNumber", () => {
  const autonomousWith = (
    value: string | readonly string[] | undefined
  ): SessionAuthContext => ({
    attributes: value === undefined ? {} : { [INTAKE_ISSUE_ATTRIBUTE]: value },
    authenticator: "github",
    principalId: AUTONOMOUS_PRINCIPAL,
    principalType: "service",
  });

  test.each([
    ["1", 1],
    ["12", 12],
    ["4821", 4821],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("reads the stamp %j as issue %i", (stamped, issue) => {
    expect(intakeIssueNumber(autonomousWith(stamped))).toBe(issue);
  });

  test("returns null for no auth at all", () => {
    expect(intakeIssueNumber(null)).toBeNull();
  });

  test("returns null for an unattended run that carries no stamp", () => {
    expect(intakeIssueNumber(autonomousWith(undefined))).toBeNull();
  });

  test("returns null for a caller who is not the unattended principal, even with the stamp", () => {
    const forged = githubUser({ [INTAKE_ISSUE_ATTRIBUTE]: "12" });

    expect(intakeIssueNumber(forged)).toBeNull();
    expect(intakeIssueNumber(stampTrusted(forged))).toBeNull();
    expect(
      intakeIssueNumber({
        ...SCHEDULE_APP,
        attributes: { [INTAKE_ISSUE_ATTRIBUTE]: "12" },
      })
    ).toBeNull();
  });

  test.each([
    ["empty", ""],
    ["a word", "twelve"],
    ["a number with a suffix", "12abc"],
    ["a number with a hash", "#12"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["zero", "0"],
    ["negative zero", "-0"],
    ["negative", "-12"],
    ["a fraction", "12.5"],
    ["beyond the safe integer range", "9007199254740992"],
    ["astronomically large", "1e400"],
    ["a list of numbers", ["12", "13"]],
    ["a one-entry list", ["12"]],
  ])("returns null for a stamp that is %s", (_case, stamped) => {
    expect(intakeIssueNumber(autonomousWith(stamped))).toBeNull();
  });
});

describe("isAutonomous", () => {
  test("is false for no auth", () => {
    expect(isAutonomous(null)).toBe(false);
  });

  test("is true for the unattended principal, whoever authenticated it", () => {
    expect(isAutonomous(stampAutonomous(githubUser(), 1))).toBe(true);
    expect(
      isAutonomous(autonomousForTicket(TICKET_ID, "intake:shared-token"))
    ).toBe(true);
  });

  test.each([
    ["a GitHub user", githubUser()],
    ["a trusted GitHub user", stampTrusted(githubUser())],
    ["the schedule app", SCHEDULE_APP],
    [
      "a principal that only resembles it",
      { ...githubUser(), principalId: `${AUTONOMOUS_PRINCIPAL} ` },
    ],
    [
      "a differently cased principal",
      { ...githubUser(), principalId: AUTONOMOUS_PRINCIPAL.toUpperCase() },
    ],
    [
      "a user who put the name in an attribute",
      githubUser({ principalId: AUTONOMOUS_PRINCIPAL }),
    ],
    [
      "a user whose login is the name",
      githubUser({ login: "foreman-factory" }),
    ],
  ])("is false for %s", (_case, auth) => {
    expect(isAutonomous(auth)).toBe(false);
  });
});

describe("isTrusted", () => {
  test("is false for no auth", () => {
    expect(isTrusted(null)).toBe(false);
  });

  test("is true only for the exact stamp the channels write", () => {
    expect(isTrusted(githubUser({ [TRUSTED_ATTRIBUTE]: "true" }))).toBe(true);
  });

  test.each([
    ["no stamp", {}],
    ["false", { [TRUSTED_ATTRIBUTE]: "false" }],
    ["a different case", { [TRUSTED_ATTRIBUTE]: "TRUE" }],
    ["a truthy word", { [TRUSTED_ATTRIBUTE]: "yes" }],
    ["one", { [TRUSTED_ATTRIBUTE]: "1" }],
    ["padded", { [TRUSTED_ATTRIBUTE]: " true" }],
    ["a list containing true", { [TRUSTED_ATTRIBUTE]: ["true"] }],
    ["empty", { [TRUSTED_ATTRIBUTE]: "" }],
    ["a stamp under another key", { Trusted: "true", trust: "true" }],
  ])("is false when the stamp is %s", (_case, attributes) => {
    expect(isTrusted(githubUser(attributes))).toBe(false);
  });

  test("does not treat the unattended principal or the schedule app as trusted", () => {
    expect(isTrusted(stampAutonomous(githubUser(), 12))).toBe(false);
    expect(isTrusted(SCHEDULE_APP)).toBe(false);
  });
});

describe("isScheduleAppAuth", () => {
  test("is false for no auth", () => {
    expect(isScheduleAppAuth(null)).toBe(false);
  });

  test("is true for the app principal eve stamps on scheduled turns", () => {
    expect(isScheduleAppAuth(SCHEDULE_APP)).toBe(true);
  });

  test.each([
    ["another authenticator", { ...SCHEDULE_APP, authenticator: "github" }],
    ["another principal id", { ...SCHEDULE_APP, principalId: "eve:app2" }],
    ["another principal type", { ...SCHEDULE_APP, principalType: "user" }],
    ["a GitHub user", githubUser()],
    ["the unattended principal", stampAutonomous(githubUser(), 12)],
    [
      "a user who put the app's fields in attributes",
      githubUser({
        authenticator: "app",
        principalId: "eve:app",
        principalType: "runtime",
      }),
    ],
  ])("is false for %s", (_case, auth) => {
    expect(isScheduleAppAuth(auth)).toBe(false);
  });

  test("the schedule app is neither autonomous nor trusted", () => {
    expect(isAutonomous(SCHEDULE_APP)).toBe(false);
    expect(isTrusted(SCHEDULE_APP)).toBe(false);
  });
});
