import { describe, expect, test } from "vitest";
import {
  factoryBrainPolicy,
  ghEffectDecision,
  ghPolicy,
  labelDecision,
  readOnlyGhPolicy,
  stationPolicy,
} from "#lib/github/approval.js";
import { parseGh } from "#lib/github/cli.js";
import {
  approvalContext,
  CALLERS,
  type CallerClass,
  outcome,
  reasonOf,
} from "../helpers.js";

const RUN = "not-applicable";
const ASK = "user-approval";
const DENY = "denied";

const decide = (caller: CallerClass, ...args: string[]) =>
  ghPolicy(approvalContext(CALLERS[caller], { args }));

/**
 * The whole authorization matrix: one row per kind of command, one column
 * per caller class. This table is the trust model; a change to it should be
 * a deliberate edit here, not a side effect.
 */
const MATRIX: readonly [
  what: string,
  args: string[],
  expected: Record<CallerClass, string>,
][] = [
  [
    "reading an issue",
    ["issue", "view", "12"],
    {
      anonymous: RUN,
      autonomous: RUN,
      schedule: RUN,
      summary: RUN,
      ticket: RUN,
      trusted: RUN,
      untrusted: RUN,
    },
  ],
  [
    "reading CI logs",
    ["run", "view", "99", "--log-failed"],
    {
      anonymous: RUN,
      autonomous: RUN,
      schedule: RUN,
      summary: RUN,
      ticket: RUN,
      trusted: RUN,
      untrusted: RUN,
    },
  ],
  [
    "labeling an issue",
    ["issue", "edit", "40", "--add-label", "bug"],
    {
      anonymous: ASK,
      autonomous: RUN,
      schedule: RUN,
      summary: DENY,
      ticket: RUN,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "commenting on the thread the run was dispatched from",
    ["issue", "comment", "12", "--body", "Analysis is complete."],
    {
      anonymous: ASK,
      autonomous: RUN,
      schedule: RUN,
      summary: RUN,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "commenting on a different thread",
    ["issue", "comment", "13", "--body", "hello"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "commenting on a pull request addressed by branch",
    ["pr", "comment", "factory/bug-x", "--body", "hello"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "closing an issue",
    ["issue", "close", "40", "--reason", "not planned"],
    {
      anonymous: RUN,
      autonomous: RUN,
      schedule: RUN,
      summary: DENY,
      ticket: RUN,
      trusted: RUN,
      untrusted: RUN,
    },
  ],
  [
    "closing another issue with a comment attached",
    ["issue", "close", "40", "--comment", "Duplicate of #7"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "closing the dispatching issue with a comment attached",
    ["issue", "close", "12", "--comment", "Fixed by #44"],
    {
      anonymous: ASK,
      autonomous: RUN,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "opening a draft pull request",
    [
      "pr",
      "create",
      "--draft",
      "--head",
      "factory/x",
      "--title",
      "T",
      "--body",
      "B",
    ],
    {
      anonymous: RUN,
      autonomous: RUN,
      schedule: RUN,
      summary: DENY,
      ticket: RUN,
      trusted: RUN,
      untrusted: RUN,
    },
  ],
  [
    "opening a draft pull request that requests a reviewer",
    [
      "pr",
      "create",
      "--draft",
      "--head",
      "factory/x",
      "--title",
      "T",
      "--body",
      "B",
      "--reviewer",
      "octocat",
    ],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "creating an issue",
    ["issue", "create", "--title", "T", "--body", "B"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "editing a pull request's description",
    ["pr", "edit", "34", "--body", "new"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: RUN,
      summary: DENY,
      ticket: DENY,
      trusted: RUN,
      untrusted: ASK,
    },
  ],
  [
    "opening a pull request that is not a draft",
    ["pr", "create", "--head", "factory/x", "--title", "T", "--body", "B"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: ASK,
      summary: DENY,
      ticket: DENY,
      trusted: ASK,
      untrusted: ASK,
    },
  ],
  [
    "marking a pull request ready",
    ["pr", "ready", "34"],
    {
      anonymous: ASK,
      autonomous: DENY,
      schedule: ASK,
      summary: DENY,
      ticket: DENY,
      trusted: ASK,
      untrusted: ASK,
    },
  ],
  [
    "merging a pull request",
    ["pr", "merge", "34", "--squash"],
    {
      anonymous: DENY,
      autonomous: DENY,
      schedule: DENY,
      summary: DENY,
      ticket: DENY,
      trusted: DENY,
      untrusted: DENY,
    },
  ],
  [
    "a mutating API call",
    ["api", "repos/acme/widgets/pulls/34/merge", "-X", "PUT"],
    {
      anonymous: DENY,
      autonomous: DENY,
      schedule: DENY,
      summary: DENY,
      ticket: DENY,
      trusted: DENY,
      untrusted: DENY,
    },
  ],
  [
    "a command against another repository",
    ["issue", "view", "1", "--repo", "evil/repo"],
    {
      anonymous: DENY,
      autonomous: DENY,
      schedule: DENY,
      summary: DENY,
      ticket: DENY,
      trusted: DENY,
      untrusted: DENY,
    },
  ],
];

describe("ghPolicy: the authorization matrix", () => {
  for (const [what, args, expected] of MATRIX) {
    describe(what, () => {
      for (const caller of Object.keys(expected) as CallerClass[]) {
        test(`${caller}: ${expected[caller]}`, () => {
          expect(outcome(decide(caller, ...args))).toBe(expected[caller]);
        });
      }
    });
  }

  test("an unattended run is never asked to wait for approval, whatever the command", () => {
    for (const [, args] of MATRIX) {
      for (const caller of ["autonomous", "ticket", "summary"] as const) {
        expect(outcome(decide(caller, ...args))).not.toBe(ASK);
      }
    }
  });

  test("shipping waits for a person even when the caller is trusted", () => {
    expect(outcome(decide("trusted", "pr", "ready", "34"))).toBe(ASK);
  });

  test("a denial says why, and names the thread an unattended run may use", () => {
    expect(
      reasonOf(decide("autonomous", "issue", "comment", "13", "--body", "x"))
    ).toContain("#12");
    expect(
      reasonOf(decide("ticket", "issue", "comment", "13", "--body", "x"))
    ).toMatch(/no thread to comment on/);
    expect(reasonOf(decide("trusted", "pr", "merge", "34"))).toMatch(
      /not available to the factory/
    );
    expect(reasonOf(decide("autonomous", "pr", "ready", "34"))).toMatch(
      /draft/
    );
  });

  test("missing or empty input is denied, not run", () => {
    expect(outcome(ghPolicy(approvalContext(CALLERS.trusted, {})))).toBe(DENY);
    expect(outcome(ghPolicy(approvalContext(CALLERS.trusted, undefined)))).toBe(
      DENY
    );
    expect(
      outcome(ghPolicy(approvalContext(CALLERS.trusted, { args: [] })))
    ).toBe(DENY);
  });

  test("a forged trusted attribute on the unattended principal changes nothing", () => {
    const forged = {
      ...CALLERS.autonomous,
      attributes: { ...CALLERS.autonomous.attributes, trusted: "true" },
    };
    expect(
      outcome(
        ghPolicy(
          approvalContext(forged, {
            args: ["issue", "create", "--title", "T", "--body", "B"],
          })
        )
      )
    ).toBe(DENY);
    expect(
      outcome(ghPolicy(approvalContext(forged, { args: ["pr", "ready", "1"] })))
    ).toBe(DENY);
  });
});

describe("ghEffectDecision", () => {
  test("every effect kind has a decision for every caller class", () => {
    const effects = [
      { kind: "read" },
      { kind: "label" },
      { kind: "comment", thread: 12 },
      { commentThread: 12, kind: "state", withComment: true },
      { kind: "draft-pr" },
      { kind: "write" },
      { kind: "ship" },
      { kind: "forbidden", reason: "no" },
    ] as const;
    for (const effect of effects) {
      for (const caller of Object.values(CALLERS)) {
        expect([RUN, ASK, DENY]).toContain(
          outcome(ghEffectDecision(effect, caller))
        );
      }
    }
  });
});

describe("readOnlyGhPolicy: a station's gh", () => {
  test.each(Object.keys(CALLERS) as CallerClass[])(
    "%s: reads run and nothing ever waits for approval",
    (caller) => {
      const run = (...args: string[]) =>
        outcome(readOnlyGhPolicy(approvalContext(CALLERS[caller], { args })));
      expect(run("issue", "view", "12", "--comments")).toBe(RUN);
      expect(run("pr", "diff", "34")).toBe(RUN);
      expect(run("issue", "comment", "12", "--body", "x")).toBe(DENY);
      expect(run("issue", "edit", "12", "--add-label", "bug")).toBe(DENY);
      expect(
        run(
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
      ).toBe(DENY);
      expect(run("pr", "ready", "34")).toBe(DENY);
      expect(run("pr", "merge", "34")).toBe(DENY);
    }
  );
});

describe("factoryBrainPolicy", () => {
  test.each<[CallerClass, string]>([
    ["trusted", RUN],
    ["schedule", RUN],
    ["untrusted", ASK],
    ["anonymous", ASK],
    ["autonomous", DENY],
    ["ticket", DENY],
    ["summary", DENY],
  ])("%s: %s", (caller, expected) => {
    expect(
      outcome(
        factoryBrainPolicy(approvalContext(CALLERS[caller], { text: "x" }))
      )
    ).toBe(expected);
  });
});

describe("the matrix covers every effect the parser can produce", () => {
  test("each effect kind appears in at least one matrix row", () => {
    const seen = new Set<string>(["forbidden"]);
    for (const [, args] of MATRIX) {
      const parsed = parseGh(args);
      if (parsed.ok) {
        seen.add(parsed.invocation.effect.kind);
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "comment",
        "draft-pr",
        "forbidden",
        "label",
        "read",
        "ship",
        "state",
        "write",
      ].sort()
    );
  });
});

describe("a summary-only run", () => {
  test("may read anything in the repository and comment on its own pull request, by number only", () => {
    expect(
      outcome(
        decide("summary", "pr", "view", "12", "--json", "title,body,files")
      )
    ).toBe(RUN);
    expect(outcome(decide("summary", "pr", "diff", "12"))).toBe(RUN);
    expect(
      outcome(decide("summary", "pr", "comment", "12", "--body", "Summary"))
    ).toBe(RUN);
    expect(
      outcome(decide("summary", "issue", "comment", "12", "--body", "Summary"))
    ).toBe(RUN);
    expect(
      outcome(
        decide("summary", "pr", "comment", "factory/x", "--body", "Summary")
      )
    ).toBe(DENY);
  });

  test("is denied the things an ordinary unattended run may do", () => {
    for (const args of [
      ["issue", "edit", "12", "--add-label", "bug"],
      ["issue", "close", "12"],
      ["issue", "reopen", "40"],
      [
        "pr",
        "create",
        "--draft",
        "--head",
        "factory/x",
        "--title",
        "T",
        "--body",
        "B",
      ],
    ]) {
      expect(outcome(decide("autonomous", ...args))).toBe(RUN);
      const status = decide("summary", ...args);
      expect(outcome(status)).toBe(DENY);
      expect(reasonOf(status)).toMatch(/only reads the pull request/);
    }
  });

  test("cannot start a station; every other caller can", () => {
    for (const [caller, auth] of Object.entries(CALLERS)) {
      expect(
        outcome(stationPolicy(approvalContext(auth, { message: "build it" })))
      ).toBe(caller === "summary" ? DENY : RUN);
    }
  });

  test("cannot have triage apply labels", () => {
    expect(outcome(labelDecision(CALLERS.summary))).toBe(DENY);
    expect(outcome(labelDecision(CALLERS.autonomous))).toBe(RUN);
  });

  test("a scope attribute on a principal that is not the unattended one grants and removes nothing", () => {
    const forged = {
      ...CALLERS.trusted,
      attributes: { ...CALLERS.trusted.attributes, factoryScope: "summary" },
    };
    expect(
      outcome(
        ghPolicy(
          approvalContext(forged, {
            args: ["issue", "edit", "1", "--add-label", "bug"],
          })
        )
      )
    ).toBe(RUN);
  });
});
