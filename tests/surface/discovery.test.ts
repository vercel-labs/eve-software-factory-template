import { beforeAll, describe, expect, test } from "vitest";
import { type Discovery, discover, isClean } from "../../scripts/discovery.js";

/**
 * What eve actually discovers from `agent/`, read from `eve info --json`.
 *
 * @remarks
 * The rest of the suite tests modules; this tests the assembled agent: which
 * tools each agent ends up with, which routes are served, which memory slots
 * are bound. Discovery is offline and needs no credentials. A tool that
 * should not exist (a shell on the orchestrator, a leftover API tool) fails
 * here even though no module-level test would notice.
 */
let discovery: Discovery;

beforeAll(() => {
  discovery = discover();
}, 120_000);

describe("discovery", () => {
  test("is ready, with no errors and no warnings", () => {
    expect(discovery.status).toBe("ready");
    expect(discovery.diagnostics).toEqual({ errors: 0, warnings: 0 });
    expect(isClean(discovery)).toBe(true);
  });

  test("the main agent runs on Fable 5.2", () => {
    expect(discovery.model).toBe("anthropic/claude-fable-5.2");
  });
});

describe("the orchestrator's tools", () => {
  test("are exactly the routing, triage, and GitHub CLI surface", () => {
    expect(discovery.tools).toEqual(
      [
        "diagnose_ci_failure",
        "gh",
        "glob",
        "grep",
        "read_artifact",
        "read_file",
        "run_analyst",
        "run_classifier",
        "run_implementer",
        "run_researcher",
        "run_reviewer",
        "triage_work_item",
        "web_fetch",
        "web_search",
      ].sort()
    );
  });

  test("include no shell and no way to write files, so gh is the only process it can start", () => {
    for (const tool of ["bash", "write_file", "edit_file", "agent"]) {
      expect(discovery.tools).not.toContain(tool);
    }
  });

  test("include none of the tools this version replaced", () => {
    const gone = discovery.tools.filter((tool) =>
      /^github__|user_preferences|factory_brain|push_branch|checkout_branch/.test(
        tool
      )
    );
    expect(gone).toEqual([]);
  });
});

describe("the stations", () => {
  test("are the five declared subagents", () => {
    expect(discovery.subagents).toEqual([
      "analyst",
      "classifier",
      "implementer",
      "researcher",
      "reviewer",
    ]);
  });

  test.each(["analyst", "implementer", "reviewer"])(
    "%s has the real git and gh, and none of the old branch tools",
    (station) => {
      const tools = discovery.stationTools[station] ?? [];
      expect(tools).toContain("gh");
      expect(tools).toContain("git");
      expect(tools).toContain("bash");
      expect(tools).not.toContain("push_branch");
      expect(tools).not.toContain("checkout_branch");
    }
  );

  test("the text-only stations have no GitHub access at all", () => {
    for (const station of ["classifier", "researcher"]) {
      const tools = discovery.stationTools[station] ?? [];
      expect(tools).not.toContain("gh");
      expect(tools).not.toContain("git");
    }
  });
});

describe("memory", () => {
  test("the orchestrator has the brain and per-user preferences as built-in memory slots", () => {
    expect(discovery.memory.root).toEqual(["brain", "preferences"]);
  });

  test("the stations that work in the repository mount the brain, and nobody else has memory", () => {
    expect(discovery.memory.analyst).toEqual(["brain"]);
    expect(discovery.memory.implementer).toEqual(["brain"]);
    expect(discovery.memory.reviewer).toEqual(["brain"]);
    expect(discovery.memory.classifier).toEqual([]);
    expect(discovery.memory.researcher).toEqual([]);
  });
});

describe("routes", () => {
  const routesOf = (name: string) =>
    discovery.channels
      .filter((route) => route.name === name)
      .map((route) => `${route.method} ${route.urlPath}`)
      .sort();

  test("the intake API serves ticket submission and status", () => {
    expect(routesOf("intake")).toEqual([
      "GET /intake/v1/tickets/:ticketId",
      "POST /intake/v1/tickets",
    ]);
  });

  test("the GitHub and Linear webhooks are still served", () => {
    expect(routesOf("github")).toEqual(["POST /eve/v1/github"]);
    expect(routesOf("linear")).toEqual(["POST /eve/v1/linear"]);
  });

  test("no custom route sits under eve's own prefix", () => {
    for (const route of discovery.channels.filter(
      (entry) => entry.name === "intake"
    )) {
      expect(route.urlPath.startsWith("/eve/")).toBe(false);
    }
  });
});
