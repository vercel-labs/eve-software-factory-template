import { describe, expect, test } from "vitest";
import {
  bashPolicy,
  factoryBrainPolicy,
  GH_ONLY,
  ghEffectDecision,
  labelDecision,
  MAX_GH_STEPS,
  shellAvailable,
  shellDecision,
  stationPolicy,
} from "#lib/github/approval.js";
import { parseGh } from "#lib/github/cli.js";
import {
  analyzeCommand,
  MAX_ANALYZED_LENGTH,
  type ShellAnalysis,
} from "#lib/github/shell.js";
import type { ShellRole } from "#lib/github/shims.js";
import {
  approvalContext,
  CALLERS,
  type CallerClass,
  ghCommand,
  outcome,
  reasonOf,
} from "../helpers.js";

const RUN = "not-applicable";
const ASK = "user-approval";
const DENY = "denied";

const ROLES = ["orchestrator", "reader", "implementer"] as const;
const STATIONS = ["reader", "implementer"] as const;
const CALLER_CLASSES = Object.keys(CALLERS) as CallerClass[];

/**
 * The callers nobody is watching: label intake and CI fixes, intake tickets,
 * and the summary-only run. They work from text nobody vetted, so on the
 * orchestrator they get no shell, only `gh`.
 */
const UNATTENDED = [
  "autonomous",
  "ticket",
  "summary",
] as const satisfies readonly CallerClass[];
/** Everyone else keeps the orchestrator's shell. */
const WITH_A_SHELL = [
  "trusted",
  "schedule",
  "untrusted",
  "anonymous",
] as const satisfies readonly CallerClass[];

/** What an unattended run on the orchestrator gets back for anything but `gh`. */
const NO_SHELL = { reason: GH_ONLY, type: "denied" };

/** What a command that waits for approval gets back when its text is in a file. */
const BODY_FILE_NEEDS_REVIEW =
  "This command waits for a person's approval, and they can only review what the command shows. Pass the text with --body instead of --body-file.";

/**
 * The orchestrator's `bash` approval for one `gh` command, written as the
 * shell command a model would type for that argv.
 */
const decide = (caller: CallerClass, ...args: string[]) =>
  bashPolicy("orchestrator")(
    approvalContext(CALLERS[caller], { command: ghCommand(args) })
  );

/** The approval for a whole command string, for any role. */
const decideCommand = (role: ShellRole, caller: CallerClass, command: string) =>
  bashPolicy(role)(approvalContext(CALLERS[caller], { command }));

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

describe("the orchestrator's gh commands: the authorization matrix", () => {
  for (const [what, args, expected] of MATRIX) {
    describe(what, () => {
      // The policy only ever sees a command string. If the words read back
      // from it were not the words written, every outcome below would be
      // about some other command.
      test("the command string is read back as one gh command with the same words", () => {
        expect(analyzeCommand(ghCommand(args))).toEqual({
          kind: "gh",
          steps: [{ after: ";", argv: args }],
        });
      });

      for (const caller of Object.keys(expected) as CallerClass[]) {
        test(`${caller}: ${expected[caller]}`, () => {
          expect(
            outcome(
              shellDecision(
                analyzeCommand(ghCommand(args)),
                "orchestrator",
                CALLERS[caller]
              )
            )
          ).toBe(expected[caller]);
          // The tool's approval is that decision, read from the session.
          expect(outcome(decide(caller, ...args))).toBe(expected[caller]);
        });
      }
    });
  }

  test("every caller class has a column in every row", () => {
    for (const [, , expected] of MATRIX) {
      expect(Object.keys(expected).sort()).toEqual([...CALLER_CLASSES].sort());
    }
  });

  test("an unattended run is never asked to wait for approval, whatever the command", () => {
    for (const [, args] of MATRIX) {
      for (const caller of UNATTENDED) {
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

  // `gh` alone prints the CLI's own help. It changes nothing and is not in
  // the allowlist, so it is not held to it: it is a shell command, and the
  // wrapper in the sandbox passes it to the real gh. That makes it a
  // question of who has a shell, like any other shell command.
  describe("gh with no command, or asking for help, runs in the shell", () => {
    const HELP = [
      "gh",
      "gh ",
      "gh;",
      "gh issue view 12 && gh",
      "gh --help",
      "gh issue comment --help",
      "gh --version",
      "gh help",
      "gh version",
      "gh -h",
    ];

    test.each(HELP)("%j is a shell command, not a gh list", (command) => {
      expect(analyzeCommand(command)).toEqual({ kind: "shell" });
    });

    test.each(WITH_A_SHELL)(
      "orchestrator, %s: there is nothing to approve",
      (caller) => {
        for (const command of HELP) {
          expect(decideCommand("orchestrator", caller, command)).toBe(RUN);
        }
      }
    );

    test.each(UNATTENDED)(
      "orchestrator, %s: denied, because the run has no shell to ask gh about itself in",
      (caller) => {
        for (const command of HELP) {
          expect(decideCommand("orchestrator", caller, command)).toEqual(
            NO_SHELL
          );
        }
      }
    );

    test.each(STATIONS)("%s: runs for every caller", (role) => {
      for (const command of HELP) {
        for (const caller of CALLER_CLASSES) {
          expect(decideCommand(role, caller, command)).toBe(RUN);
        }
      }
    });
  });

  describe("missing or empty input names nothing on GitHub", () => {
    const EMPTY = [{}, undefined, { command: "" }, { command: "  \n" }];

    test("it is a plain command", () => {
      expect(analyzeCommand("")).toEqual({ kind: "plain" });
      expect(analyzeCommand("  \n")).toEqual({ kind: "plain" });
    });

    test.each(WITH_A_SHELL)(
      "%s: there is nothing to approve and no credential to get",
      (caller) => {
        const policy = bashPolicy("orchestrator");
        for (const input of EMPTY) {
          expect(policy(approvalContext(CALLERS[caller], input))).toBe(RUN);
        }
      }
    );

    // Even an empty command is a shell command, and there is no shell.
    test.each(UNATTENDED)(
      "%s: denied like any command that is not gh",
      (caller) => {
        const policy = bashPolicy("orchestrator");
        for (const input of EMPTY) {
          expect(policy(approvalContext(CALLERS[caller], input))).toEqual(
            NO_SHELL
          );
        }
      }
    );
  });

  test("a forged trusted attribute on the unattended principal changes nothing", () => {
    const forged = {
      ...CALLERS.autonomous,
      attributes: { ...CALLERS.autonomous.attributes, trusted: "true" },
    };
    const policy = bashPolicy("orchestrator");
    expect(
      outcome(
        policy(
          approvalContext(forged, {
            command: "gh issue create --title T --body B",
          })
        )
      )
    ).toBe(DENY);
    expect(
      outcome(policy(approvalContext(forged, { command: "gh pr ready 1" })))
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

describe.each(STATIONS)("a station's gh (%s): reads only", (role) => {
  test.each(CALLER_CLASSES)(
    "%s: reads run and nothing ever waits for approval",
    (caller) => {
      const run = (...args: string[]) =>
        outcome(
          shellDecision(analyzeCommand(ghCommand(args)), role, CALLERS[caller])
        );
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

  test("across the whole matrix: a read runs, every other row is denied, for every caller", () => {
    let reads = 0;
    for (const [what, args] of MATRIX) {
      const parsed = parseGh(args);
      const isRead = parsed.ok && parsed.invocation.effect.kind === "read";
      reads += isRead ? 1 : 0;
      for (const caller of CALLER_CLASSES) {
        const status = shellDecision(
          analyzeCommand(ghCommand(args)),
          role,
          CALLERS[caller]
        );
        expect(`${what}: ${outcome(status)}`).toBe(
          `${what}: ${isRead ? RUN : DENY}`
        );
        // The tool's approval is the same decision.
        expect(outcome(decideCommand(role, caller, ghCommand(args)))).toBe(
          outcome(status)
        );
      }
    }
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(MATRIX.length);
  });

  test("a write is sent back to the orchestrator; a command outside the allowlist keeps the parser's reason", () => {
    expect(
      reasonOf(decideCommand(role, "trusted", "gh issue comment 12 --body x"))
    ).toMatch(/Stations read GitHub and leave the writing to the orchestrator/);
    expect(reasonOf(decideCommand(role, "trusted", "gh pr merge 34"))).toMatch(
      /not available to the factory/
    );
    expect(
      reasonOf(
        decideCommand(role, "trusted", "gh issue view 1 --repo evil/repo")
      )
    ).toMatch(/only works on acme\/widgets/);
  });

  test("a list is denied when any step writes, wherever it sits", () => {
    for (const command of [
      "gh issue view 12 && gh issue comment 12 --body x",
      "gh issue comment 12 --body x && gh issue view 12",
      "gh issue view 12; gh pr ready 34",
      "gh issue view 12\ngh pr merge 34",
    ]) {
      for (const caller of CALLER_CLASSES) {
        expect(outcome(decideCommand(role, caller, command))).toBe(DENY);
      }
    }
    for (const caller of CALLER_CLASSES) {
      expect(
        outcome(
          decideCommand(role, caller, "gh issue view 12 && gh pr diff 34")
        )
      ).toBe(RUN);
    }
  });
});

describe("commands the runtime cannot read in full", () => {
  const PLAIN = [
    "",
    "ls -la",
    "git status",
    'git commit -am "Fix the login redirect"',
    "pnpm test 2>&1 | tail -40",
  ];
  const SHELL = [
    "gh issue view 12 --json title | jq .title",
    "git fetch origin main",
    "echo $(gh issue list)",
    // Each of these would be a write if it reached GitHub with a token that
    // writes. In the shell the token only reads, so there is nothing to
    // approve; the write simply does not happen.
    'gh issue comment 13 --body "$(cat notes.md)"',
    "gh pr merge 34 --squash > /dev/null",
    "gh pr ready 34 || true",
    "GH_REPO=evil/repo gh issue create --title T --body B",
    "git push --force origin main && echo done",
    "git push origin factory/x; gh pr ready 34",
  ];

  test("the examples are what they claim to be", () => {
    for (const command of PLAIN) {
      expect(analyzeCommand(command)).toEqual({ kind: "plain" });
    }
    for (const command of SHELL) {
      expect(analyzeCommand(command)).toEqual({ kind: "shell" });
    }
  });

  const KINDS = [
    { kind: "plain" },
    { kind: "shell" },
  ] satisfies ShellAnalysis[];

  // A station's work is running code, whoever started the run.
  test.each(STATIONS)(
    "%s: plain and shell commands run for every caller class, the summary-only run included",
    (role) => {
      for (const analysis of KINDS) {
        for (const caller of CALLER_CLASSES) {
          expect(shellDecision(analysis, role, CALLERS[caller])).toBe(RUN);
        }
      }
      for (const command of [...PLAIN, ...SHELL]) {
        for (const caller of CALLER_CLASSES) {
          expect(decideCommand(role, caller, command)).toBe(RUN);
        }
      }
    }
  );

  describe("the orchestrator's shell is for callers somebody answers for", () => {
    test("the two groups below are every caller class, each once", () => {
      expect([...UNATTENDED, ...WITH_A_SHELL].sort()).toEqual(
        [...CALLER_CLASSES].sort()
      );
    });

    test.each(WITH_A_SHELL)(
      "%s: plain and shell commands run, with nothing to approve",
      (caller) => {
        expect(shellAvailable("orchestrator", CALLERS[caller])).toBe(true);
        for (const analysis of KINDS) {
          expect(shellDecision(analysis, "orchestrator", CALLERS[caller])).toBe(
            RUN
          );
        }
        for (const command of [...PLAIN, ...SHELL]) {
          expect(decideCommand("orchestrator", caller, command)).toBe(RUN);
        }
      }
    );

    // An unattended run works from an issue body, a stranger's pull request,
    // a ticket. A shell would let that text start programs next to the
    // commands the runtime runs with a credential that writes.
    test.each(UNATTENDED)(
      "%s: every plain and shell command is denied and told to use gh on its own",
      (caller) => {
        expect(shellAvailable("orchestrator", CALLERS[caller])).toBe(false);
        for (const analysis of KINDS) {
          expect(
            shellDecision(analysis, "orchestrator", CALLERS[caller])
          ).toEqual(NO_SHELL);
        }
        for (const command of [...PLAIN, ...SHELL]) {
          expect(decideCommand("orchestrator", caller, command)).toEqual(
            NO_SHELL
          );
        }
      }
    );

    test.each(UNATTENDED)(
      "%s: a command too long to read is a shell command, so it is denied as well",
      (caller) => {
        const command = `gh issue comment 12 --body "${"x".repeat(MAX_ANALYZED_LENGTH)}"`;
        expect(analyzeCommand(command)).toEqual({ kind: "shell" });
        expect(decideCommand("orchestrator", caller, command)).toEqual(
          NO_SHELL
        );
        expect(decideCommand("orchestrator", "trusted", command)).toBe(RUN);
      }
    );

    test.each(UNATTENDED)(
      "%s: whole gh commands are still decided by the matrix, reads included",
      (caller) => {
        expect(decideCommand("orchestrator", caller, "gh issue view 12")).toBe(
          RUN
        );
        expect(
          decideCommand(
            "orchestrator",
            caller,
            "gh pr view 34 --json title --jq .title && gh pr diff 34"
          )
        ).toBe(RUN);
      }
    );

    test.each(STATIONS)("%s: every caller has a shell", (role) => {
      for (const caller of CALLER_CLASSES) {
        expect(shellAvailable(role, CALLERS[caller])).toBe(true);
      }
    });

    test("the denial says what does work, in words an agent can act on", () => {
      expect(GH_ONLY).toBe(
        "This run has no shell, only gh. Run gh commands on their own: one command, or several joined with &&, every argument written out, with no pipes and no other programs. Use --json and --jq to shape the output."
      );
      // Agent-facing text carries no em dashes.
      expect(GH_ONLY).not.toContain("—");
    });
  });
});

describe("deciding takes time in proportion to the command, not to what it says", () => {
  const elapsed = (command: string): number => {
    const start = performance.now();
    bashPolicy("orchestrator")(
      approvalContext(CALLERS.autonomous, { command })
    );
    return performance.now() - start;
  };

  test("a long ordinary command is decided at once", () => {
    const command = `gh issue comment 12 --body "${"word ".repeat(10_000)}"`;
    expect(elapsed(command)).toBeLessThan(250);
    expect(elapsed(`git ${"--no-pager ".repeat(2000)}status`)).toBeLessThan(
      250
    );
  });

  // An earlier pattern for "git, some options, a network subcommand" could
  // read `-C -C` as one option with a value or as two options, so a run of
  // n such words was tried about 1.6^n ways before it gave up: 34 of them
  // took half a second and 60 took hours, on text an issue body can steer,
  // in the app runtime. These hold the replacement to a single pass.
  test.each([
    ["with no network subcommand", `git${" -C".repeat(400)} status`],
    ["ending in one", `git${" -C".repeat(400)} fetch`],
    ["of long options", `git${" --x=y".repeat(400)} status`],
    ["after many gits", `${"git -C ".repeat(400)}status`],
    ["of spaces", `git${" ".repeat(20_000)}status`],
  ])("a run of git options %s does not stall the runtime", (_name, command) => {
    expect(elapsed(command)).toBeLessThan(250);
  });
});

describe("a list of gh commands is decided by its strictest step", () => {
  const READ = "gh issue view 12";
  const LABEL = "gh issue edit 12 --add-label bug";
  const SHIP = "gh pr ready 34";
  const MERGE = "gh pr merge 34";
  const list = (command: string, caller: CallerClass = "trusted") =>
    decideCommand("orchestrator", caller, command);

  test("alone, for a trusted caller, the four steps run, run, wait, and are denied", () => {
    expect(outcome(list(READ))).toBe(RUN);
    expect(outcome(list(LABEL))).toBe(RUN);
    expect(outcome(list(SHIP))).toBe(ASK);
    expect(outcome(list(MERGE))).toBe(DENY);
  });

  test.each<[string, string, string, string]>([
    ["denied beats waiting for approval", MERGE, SHIP, DENY],
    ["denied beats running", MERGE, LABEL, DENY],
    ["waiting for approval beats running", SHIP, LABEL, ASK],
    ["two steps that run, run", READ, LABEL, RUN],
  ])(
    "%s, in either order and with any separator",
    (_name, strict, lenient, expected) => {
      for (const separator of [" && ", "; ", "\n"]) {
        expect(outcome(list(`${strict}${separator}${lenient}`))).toBe(expected);
        expect(outcome(list(`${lenient}${separator}${strict}`))).toBe(expected);
      }
    }
  );

  test("with all three outcomes in one list, the denial decides, and its reason is the one reported", () => {
    const status = list(`${LABEL} && ${SHIP} && ${MERGE}`);
    expect(outcome(status)).toBe(DENY);
    expect(reasonOf(status)).toMatch(/gh pr merge is not available/);
  });

  test("a step that would never run in a shell still counts: nothing is approved on the hope that an earlier step fails", () => {
    expect(outcome(list(`gh issue view 999999 && ${SHIP}`))).toBe(ASK);
    expect(outcome(list(`gh issue view 999999 && ${MERGE}`))).toBe(DENY);
  });

  test("an unattended run cannot carry a write to another thread in behind one to its own", () => {
    const own = 'gh issue comment 12 --body "Analysis is complete."';
    const other = 'gh issue comment 13 --body "hello"';
    expect(outcome(list(own, "autonomous"))).toBe(RUN);
    for (const command of [
      `${own} && ${other}`,
      `${other}; ${own}`,
      `${own}\n${SHIP}`,
      `${own} && gh issue create --title T --body B`,
    ]) {
      const status = list(command, "autonomous");
      expect(outcome(status)).toBe(DENY);
    }
    expect(reasonOf(list(`${own} && ${other}`, "autonomous"))).toContain("#12");
  });

  test("no list ever makes an unattended run wait for approval", () => {
    const steps = MATRIX.map(([, args]) => ghCommand(args));
    for (const first of steps) {
      for (const second of steps) {
        for (const caller of UNATTENDED) {
          expect(outcome(list(`${first} && ${second}`, caller))).not.toBe(ASK);
        }
      }
    }
  });

  // Each step is a lease and a process in the sandbox, and a list is one
  // approval, so a list has a length a person can still read.
  describe("a list holds a dozen commands at most", () => {
    const TOO_MANY = {
      reason: "Run at most 12 gh commands in one command.",
      type: "denied",
    };
    const SEPARATORS = [" && ", "; ", "\n"];
    /** `count` steps: `last` at the end, reads before it. */
    const listOf = (count: number, last = READ, separator = " && ") =>
      [...new Array<string>(count - 1).fill(READ), last].join(separator);

    test("the limit is twelve", () => {
      expect(MAX_GH_STEPS).toBe(12);
    });

    test("the lists below are read as that many gh commands", () => {
      for (const count of [12, 13]) {
        for (const separator of SEPARATORS) {
          const analysis = analyzeCommand(listOf(count, READ, separator));
          expect(analysis.kind).toBe("gh");
          expect(analysis.kind === "gh" && analysis.steps.length).toBe(count);
        }
      }
    });

    test.each(ROLES)(
      "%s: twelve reads run for every caller, with any separator",
      (role) => {
        for (const separator of SEPARATORS) {
          for (const caller of CALLER_CLASSES) {
            expect(
              decideCommand(role, caller, listOf(12, READ, separator))
            ).toBe(RUN);
          }
        }
      }
    );

    test("twelve steps are still decided by the strictest one", () => {
      expect(outcome(list(listOf(12, LABEL)))).toBe(RUN);
      expect(outcome(list(listOf(12, LABEL), "untrusted"))).toBe(ASK);
      expect(outcome(list(listOf(12, SHIP)))).toBe(ASK);
      const merge = list(listOf(12, MERGE));
      expect(outcome(merge)).toBe(DENY);
      expect(reasonOf(merge)).toMatch(/gh pr merge is not available/);
      expect(outcome(list(listOf(12, SHIP), "autonomous"))).toBe(DENY);
    });

    test.each(ROLES)(
      "%s: thirteen are denied for every caller, reads though they all are",
      (role) => {
        for (const separator of SEPARATORS) {
          for (const caller of CALLER_CLASSES) {
            expect(
              decideCommand(role, caller, listOf(13, READ, separator))
            ).toEqual(TOO_MANY);
          }
        }
      }
    );

    test("the count is what denies a longer list, whatever its steps would have got", () => {
      for (const last of [LABEL, SHIP, MERGE]) {
        for (const count of [13, 14, 40]) {
          expect(list(listOf(count, last))).toEqual(TOO_MANY);
          expect(list(listOf(count, last), "untrusted")).toEqual(TOO_MANY);
        }
      }
    });
  });
});

/*
 * The file is read when the command runs, which is after any approval. So
 * where the same command with --body would run, or be denied, the file
 * changes nothing; where it would wait for a person, that person would be
 * agreeing to text they never saw, and the command is denied instead.
 */
describe("--body-file is decided like --body, except where a person would have to approve text they cannot see", () => {
  /** The row's argv with every `--body <text>` rewritten by `spell`. */
  const withBodyFile = (
    args: readonly string[],
    spell: (path: string) => string[]
  ): string[] =>
    args.flatMap((arg, index) => {
      if (arg === "--body") {
        return spell("notes.md");
      }
      return args[index - 1] === "--body" ? [] : [arg];
    });

  const SPELLINGS: [string, (path: string) => string[]][] = [
    ["--body-file notes.md", (path) => ["--body-file", path]],
    ["--body-file=notes.md", (path) => [`--body-file=${path}`]],
    ["-F notes.md", (path) => ["-F", path]],
  ];

  const ROWS_WITH_A_BODY = MATRIX.filter(([, args]) => args.includes("--body"));

  test("the matrix has rows to check this against, with every outcome among them", () => {
    expect(ROWS_WITH_A_BODY.length).toBeGreaterThanOrEqual(8);
    const outcomes = ROWS_WITH_A_BODY.flatMap(([, , expected]) =>
      Object.values(expected)
    );
    for (const each of [RUN, ASK, DENY]) {
      expect(outcomes).toContain(each);
    }
  });

  describe.each(SPELLINGS)("%s", (_spelling, spell) => {
    for (const [what, args, expected] of ROWS_WITH_A_BODY) {
      test(`${what}: as with --body where that runs or is denied, and denied where that would wait`, () => {
        const fromFile = withBodyFile(args, spell);
        expect(fromFile).not.toContain("--body");
        const parsed = parseGh(args);
        const isRead = parsed.ok && parsed.invocation.effect.kind === "read";
        for (const caller of CALLER_CLASSES) {
          const status = decide(caller, ...fromFile);
          if (expected[caller] === ASK) {
            expect([caller, status]).toEqual([
              caller,
              { reason: BODY_FILE_NEEDS_REVIEW, type: "denied" },
            ]);
          } else {
            // The same outcome, for the same reason.
            expect([caller, status]).toEqual([caller, decide(caller, ...args)]);
            expect(outcome(status)).toBe(expected[caller]);
          }
          // A station never waits for anyone, so there the file changes nothing.
          for (const role of STATIONS) {
            const onStation = decideCommand(role, caller, ghCommand(fromFile));
            expect(outcome(onStation)).toBe(isRead ? RUN : DENY);
            expect(reasonOf(onStation)).not.toBe(BODY_FILE_NEEDS_REVIEW);
          }
        }
      });
    }
  });

  test.each<[string, CallerClass, string]>([
    [
      "a comment from a caller no channel vouched for",
      "untrusted",
      "gh issue comment 12",
    ],
    ["a comment from nobody in particular", "anonymous", "gh pr comment 34"],
    [
      "a pull request that is not a draft, where the ship gate waits even for a trusted caller",
      "trusted",
      "gh pr create --head factory/x --title T",
    ],
    [
      "the same from a schedule turn",
      "schedule",
      "gh pr create --head factory/x --title T",
    ],
  ])(
    "%s waits for approval with --body, and is denied with any spelling of --body-file",
    (_name, caller, command) => {
      expect(
        decideCommand("orchestrator", caller, `${command} --body text`)
      ).toBe(ASK);
      for (const file of [
        "--body-file notes.md",
        "--body-file=notes.md",
        "-F notes.md",
        "--body-file 'my notes.md'",
      ]) {
        expect(
          decideCommand("orchestrator", caller, `${command} ${file}`)
        ).toEqual({ reason: BODY_FILE_NEEDS_REVIEW, type: "denied" });
      }
    }
  );

  test("the denial tells the agent to pass the text where the approver can read it", () => {
    expect(BODY_FILE_NEEDS_REVIEW).toContain(
      "Pass the text with --body instead of --body-file."
    );
    expect(
      reasonOf(decide("untrusted", "issue", "comment", "12", "-F", "notes.md"))
    ).toBe(BODY_FILE_NEEDS_REVIEW);
  });

  test.each<[string, CallerClass, string]>([
    ["a trusted caller's comment", "trusted", "gh issue comment 12"],
    ["a schedule turn's new issue", "schedule", "gh issue create --title T"],
    [
      "an unattended run's comment on its own thread",
      "autonomous",
      "gh issue comment 12",
    ],
    ["a summary on its own pull request", "summary", "gh pr comment 12"],
    [
      "a draft pull request from anyone at all",
      "anonymous",
      "gh pr create --draft --head factory/x --title T",
    ],
  ])(
    "%s has nobody to wait for, so it runs from a file as it does from --body",
    (_name, caller, command) => {
      expect(
        decideCommand("orchestrator", caller, `${command} --body text`)
      ).toBe(RUN);
      expect(
        decideCommand("orchestrator", caller, `${command} --body-file notes.md`)
      ).toBe(RUN);
    }
  );

  test("a command that is denied anyway keeps its own reason", () => {
    const elsewhere = decide(
      "autonomous",
      "issue",
      "comment",
      "13",
      "-F",
      "n.md"
    );
    expect(outcome(elsewhere)).toBe(DENY);
    expect(reasonOf(elsewhere)).toContain("#12");
    const merge = decide(
      "untrusted",
      "pr",
      "merge",
      "34",
      "--body-file",
      "n.md"
    );
    expect(outcome(merge)).toBe(DENY);
    expect(reasonOf(merge)).toMatch(/gh pr merge is not available/);
  });

  test("an unattended run never waits, so a file never changes what it gets", () => {
    for (const [, args] of ROWS_WITH_A_BODY) {
      for (const [, spell] of SPELLINGS) {
        for (const caller of UNATTENDED) {
          expect(decide(caller, ...withBodyFile(args, spell))).toEqual(
            decide(caller, ...args)
          );
        }
      }
    }
  });

  test("in a list, one step that waits with its text in a file denies the list", () => {
    const read = "gh issue view 12";
    const fromFile = "gh issue comment 12 --body-file notes.md";
    for (const command of [`${read} && ${fromFile}`, `${fromFile}; ${read}`]) {
      expect(decideCommand("orchestrator", "untrusted", command)).toEqual({
        reason: BODY_FILE_NEEDS_REVIEW,
        type: "denied",
      });
      // For a trusted caller the comment runs, so the list does.
      expect(decideCommand("orchestrator", "trusted", command)).toBe(RUN);
    }
    // A step that waits with its text in view does not rescue it.
    expect(
      decideCommand("orchestrator", "trusted", `${fromFile} && gh pr ready 34`)
    ).toBe(ASK);
    expect(
      decideCommand(
        "orchestrator",
        "untrusted",
        `gh pr ready 34 && ${fromFile}`
      )
    ).toEqual({ reason: BODY_FILE_NEEDS_REVIEW, type: "denied" });
  });

  test("the thread a comment lands on is still read from the command, not from the file", () => {
    expect(
      outcome(decide("autonomous", "issue", "comment", "12", "-F", "notes.md"))
    ).toBe(RUN);
    expect(
      outcome(decide("autonomous", "issue", "comment", "13", "-F", "notes.md"))
    ).toBe(DENY);
  });

  test.each([
    ["standard input", ["issue", "comment", "12", "--body-file", "-"]],
    ["an empty path", ["issue", "comment", "12", "--body-file="]],
    ["no path", ["issue", "comment", "12", "--body-file"]],
  ])(
    "a body read from %s is denied for every caller and role",
    (_name, args) => {
      for (const role of ROLES) {
        for (const caller of CALLER_CLASSES) {
          const status = decideCommand(role, caller, ghCommand(args));
          expect(outcome(status)).toBe(DENY);
          expect(reasonOf(status)).toMatch(
            /--body-file needs the path of a file/
          );
        }
      }
    }
  );

  test("a body given twice, once each way, is refused like any repeated flag", () => {
    const status = decide(
      "trusted",
      "issue",
      "comment",
      "12",
      "--body",
      "x",
      "--body-file",
      "notes.md"
    );
    expect(outcome(status)).toBe(DENY);
    expect(reasonOf(status)).toMatch(/pass --body once/);
  });

  test("gh api keeps its own -F, which the allowlist refuses", () => {
    const status = decide(
      "trusted",
      "api",
      "repos/acme/widgets/issues",
      "-F",
      "title=x"
    );
    expect(outcome(status)).toBe(DENY);
    expect(reasonOf(status)).toMatch(/gh api does not accept -F/);
  });
});

describe("git push", () => {
  const push = (role: ShellRole, caller: CallerClass, command: string) =>
    decideCommand(role, caller, command);

  const ACCEPTED = [
    "git push origin factory/x",
    "git push -u origin factory/x",
    "git push --set-upstream origin factory/bug-fix-login",
    "git push",
    "git push origin",
    "git push origin HEAD",
    "cd repo && git push origin factory/x",
    "cd ./repo/ && git push",
    "cd /workspace/repo && git push origin factory/x",
    "git -C repo push origin factory/x",
    "git -C /workspace/repo push origin HEAD",
  ];

  test("each accepted form is read as a push", () => {
    for (const command of ACCEPTED) {
      expect(analyzeCommand(command).kind).toBe("push");
    }
  });

  test("the implementer's push runs for every caller: the branch rules are the gate, not the trust class", () => {
    for (const command of ACCEPTED) {
      for (const caller of CALLER_CLASSES) {
        expect(push("implementer", caller, command)).toBe(RUN);
      }
    }
  });

  test.each<[ShellRole, RegExp]>([
    [
      "orchestrator",
      /The orchestrator never pushes\. The implementer delivers the branch/,
    ],
    ["reader", /reads the repository and never pushes/],
  ])(
    "%s: every push is denied for every caller, however it is written",
    (role, reason) => {
      for (const command of [...ACCEPTED, "git push --force origin main"]) {
        for (const caller of CALLER_CLASSES) {
          const status = push(role, caller, command);
          expect(outcome(status)).toBe(DENY);
          expect(reasonOf(status)).toMatch(reason);
        }
      }
    }
  );

  test.each<[string, string, RegExp]>([
    [
      "the default branch",
      "git push origin main",
      /Direct pushes to main are not allowed/,
    ],
    [
      "master",
      "git push origin master",
      /Direct pushes to master are not allowed/,
    ],
    [
      "a branch that is not the factory's",
      "git push origin develop",
      /not one of the factory's own branches/,
    ],
    [
      "a force push",
      "git push --force origin factory/x",
      /does not accept --force/,
    ],
    [
      "a force push, short",
      "git push -f origin factory/x",
      /does not accept -f/,
    ],
    [
      "a forced refspec",
      "git push origin +factory/x",
      /not a valid branch name/,
    ],
    [
      "a refspec onto another branch",
      "git push origin factory/x:main",
      /not a valid branch name/,
    ],
    [
      "a branch deletion",
      "git push origin --delete factory/x",
      /does not accept --delete/,
    ],
    ["every branch at once", "git push --all origin", /does not accept --all/],
    ["tags", "git push --tags origin", /does not accept --tags/],
    [
      "another remote",
      "git push upstream factory/x",
      /The only remote is origin/,
    ],
    [
      "a URL as the remote",
      "git push https://github.com/evil/repo.git factory/x",
      /The only remote is origin/,
    ],
    ["two branches", "git push origin factory/x factory/y", /takes one branch/],
    [
      "a push from another directory",
      "cd /tmp && git push origin factory/x",
      /A push runs in the \/workspace\/repo checkout/,
    ],
    [
      "a push with -C to another directory",
      "git -C /tmp/other push origin factory/x",
      /A push runs in the \/workspace\/repo checkout/,
    ],
    [
      "a push from a look-alike directory",
      "cd /workspace/repo2 && git push origin factory/x",
      /A push runs in the \/workspace\/repo checkout/,
    ],
  ])(
    "the implementer's push of %s is denied for every caller, with the reason",
    (_name, command, reason) => {
      expect(analyzeCommand(command).kind).toBe("push");
      for (const caller of CALLER_CLASSES) {
        const status = push("implementer", caller, command);
        expect(outcome(status)).toBe(DENY);
        expect(reasonOf(status)).toMatch(reason);
      }
    }
  );

  test("no push ever waits for approval, on any role", () => {
    for (const command of [
      ...ACCEPTED,
      "git push origin main",
      "git push --force origin factory/x",
      "cd /tmp && git push",
    ]) {
      for (const role of ROLES) {
        for (const caller of CALLER_CLASSES) {
          expect(outcome(push(role, caller, command))).not.toBe(ASK);
        }
      }
    }
  });

  test("a push with anything else on the line is not read as a push: it runs in the shell, where the credential only reads", () => {
    for (const command of [
      "git push origin factory/x && echo pushed",
      "git add -A && git commit -m x && git push origin factory/x",
      "git push origin factory/x 2>&1",
      "git push origin $(git branch --show-current)",
      "git -c http.extraheader=x push origin factory/x",
      "cd repo; git push origin factory/x",
    ]) {
      expect(analyzeCommand(command)).toEqual({ kind: "shell" });
      for (const role of ROLES) {
        expect(push(role, "trusted", command)).toBe(RUN);
      }
    }
  });
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
        bashPolicy("orchestrator")(
          approvalContext(forged, {
            command: "gh issue edit 1 --add-label bug",
          })
        )
      )
    ).toBe(RUN);
  });
});
