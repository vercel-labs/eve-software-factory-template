import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type Discovery, discover, isClean } from "../../scripts/discovery.js";

/**
 * What eve actually discovers from `agent/`, read from `eve info --json`.
 *
 * @remarks
 * The rest of the suite tests modules; this tests the assembled agent: which
 * tools each agent ends up with, which routes are served, which memory slots
 * are bound. Discovery is offline and needs no credentials. A tool that
 * should not exist (a way for the orchestrator to write files, a leftover
 * `gh` or `git` tool beside the shell) fails here even though no
 * module-level test would notice.
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
    expect(discovery.model).toBe("anthropic/claude-opus-5.5-fast");
  });
});

describe("the orchestrator's tools", () => {
  test("are exactly the routing and triage surface, plus a shell for git and gh", () => {
    expect(discovery.tools).toEqual(
      [
        "bash",
        "diagnose_ci_failure",
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

  test("include a shell, where gh runs, and no gh or git tool beside it", () => {
    expect(discovery.tools).toContain("bash");
    expect(discovery.tools).not.toContain("gh");
    expect(discovery.tools).not.toContain("git");
  });

  test("include no way to write files and no generic subagent: the orchestrator routes work, it does not write code", () => {
    // The tools were discovered: an empty list would pass what follows.
    expect(discovery.tools).toContain("read_file");
    for (const tool of ["write_file", "edit_file", "agent"]) {
      expect(discovery.tools).not.toContain(tool);
    }
  });

  test("include none of the tools this version replaced", () => {
    expect(discovery.tools.length).toBeGreaterThan(0);
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
    "%s uses git and gh in its shell: no gh or git tool, and none of the old branch tools",
    (station) => {
      const tools = discovery.stationTools[station] ?? [];
      expect(tools).toContain("bash");
      expect(tools).not.toContain("gh");
      expect(tools).not.toContain("git");
      expect(tools).not.toContain("push_branch");
      expect(tools).not.toContain("checkout_branch");
    }
  );

  test("the stations that work in the repository have exactly these tools", () => {
    const workbench = [
      "bash",
      "edit_file",
      "glob",
      "grep",
      "read_artifact",
      "read_file",
      "web_fetch",
      "write_file",
    ];
    expect(discovery.stationTools.implementer).toEqual(workbench);
    expect(discovery.stationTools.reviewer).toEqual(workbench);
    expect(discovery.stationTools.analyst).toEqual(
      [...workbench, "save_artifact"].sort()
    );
  });

  test("the stations that do not work in the repository have exactly these tools, and no GitHub tool", () => {
    const basics = [
      "bash",
      "edit_file",
      "read_file",
      "web_fetch",
      "write_file",
    ];
    expect(discovery.stationTools.classifier).toEqual(basics);
    expect(discovery.stationTools.researcher).toEqual(
      [...basics, "save_artifact"].sort()
    );
  });

  test("no agent has a tool named gh or git: both are programs in the shell now", () => {
    // Every agent was discovered with tools: a missing list would pass.
    expect(Object.keys(discovery.stationTools).sort()).toEqual([
      "analyst",
      "classifier",
      "implementer",
      "researcher",
      "reviewer",
    ]);
    const lists = [discovery.tools, ...Object.values(discovery.stationTools)];
    for (const tools of lists) {
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.filter((tool) => tool === "gh" || tool === "git")).toEqual(
        []
      );
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
    const custom = discovery.channels.filter(
      (entry) => entry.name === "intake"
    );
    expect(custom).toHaveLength(2);
    for (const route of custom) {
      expect(route.urlPath.startsWith("/eve/")).toBe(false);
    }
  });
});

/**
 * The real discovery above is clean, so it cannot show what `discover` does
 * with a report that is not. Here the `eve info` process alone is replaced
 * by a canned report; reading it is the real code.
 */
describe("discover: reading a report", () => {
  const spawnSync = vi.fn();
  let directory = "";

  const report = (value: object | string, status = 0) => {
    spawnSync.mockReturnValue({
      status,
      stderr: "eve: stderr text",
      stdout: typeof value === "string" ? value : JSON.stringify(value),
    });
  };
  const load = async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    return await import("../../scripts/discovery.js");
  };

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    spawnSync.mockReset();
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
      directory = "";
    }
  });

  test.each([
    [
      "errors",
      { diagnostics: { errors: 2, warnings: 0 }, status: "ready" },
      { diagnostics: { errors: 2, warnings: 0 }, status: "ready" },
    ],
    [
      "warnings",
      { diagnostics: { errors: 0, warnings: 1 }, status: "ready" },
      { diagnostics: { errors: 0, warnings: 1 }, status: "ready" },
    ],
    [
      "a status that is not ready",
      { diagnostics: {}, status: "failed" },
      { diagnostics: { errors: 0, warnings: 0 }, status: "failed" },
    ],
    [
      "no status at all",
      { diagnostics: { errors: 0, warnings: 0 } },
      { diagnostics: { errors: 0, warnings: 0 }, status: "unknown" },
    ],
  ])(
    "a report with %s is returned with its counts, and is not clean",
    async (_case, value, expected) => {
      report(value);
      const engine = await load();
      const read = engine.discover();

      expect(read).toMatchObject(expected);
      expect(engine.isClean(read)).toBe(false);
    }
  );

  test("a ready report with no errors and no warnings is clean", async () => {
    report({ diagnostics: { errors: 0, warnings: 0 }, status: "ready" });
    const engine = await load();

    expect(engine.isClean(engine.discover())).toBe(true);
  });

  test("output that is not a report throws, with the exit code and what eve printed", async () => {
    report("Error: could not compile agent/", 1);
    const engine = await load();

    expect(() => engine.discover()).toThrow(
      "eve info did not print a report (exit 1).\neve: stderr text"
    );
  });

  test("it runs eve info --json in the project, with placeholders only for what the environment lacks", async () => {
    report({ status: "ready" });
    vi.stubEnv("LINEAR_CONNECTOR", undefined);
    const engine = await load();
    engine.discover();
    vi.unstubAllEnvs();

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnSync.mock.calls[0] ?? [];
    expect(binary).toBe(process.execPath);
    expect(args).toEqual([
      join(engine.PROJECT_ROOT, "node_modules/eve/bin/eve.js"),
      "info",
      "--json",
    ]);
    expect(options.cwd).toBe(engine.PROJECT_ROOT);
    // Set by the suite, so kept; unset above, so filled in.
    expect(options.env.GITHUB_CONNECTOR).toBe("github/test-agent");
    expect(options.env.LINEAR_CONNECTOR).toBe("linear/foreman-agent");
  });

  test("tools, stations, and memory slots are read from the report and its compiled manifest, sorted", async () => {
    directory = mkdtempSync(join(tmpdir(), "factory-discovery-"));
    const manifest = join(directory, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        // Listed out of order: the slots come back sorted.
        bindings: Object.fromEntries(
          [
            "memory/preferences.ts",
            "memory/brain.ts",
            "tools/triage_work_item.ts",
          ].map((path) => [path, {}])
        ),
        subagents: [
          { agent: { bindings: { "memory/brain.ts": {} } }, name: "analyst" },
          { agent: { bindings: { "tools/x.ts": {} } }, id: "classifier" },
        ],
      })
    );
    report({
      artifacts: { compiledManifest: manifest },
      channels: [{ method: "POST", name: "intake", urlPath: "/intake/v1" }],
      model: "vendor/model",
      status: "ready",
      subagents: ["classifier", "analyst"],
      toolInputSchemas: {
        subagents: {
          analyst: Object.fromEntries([
            ["grep", {}],
            ["bash", {}],
          ]),
        },
      },
      tools: ["web_fetch", "bash"],
    });
    const engine = await load();

    expect(engine.discover()).toEqual({
      channels: [{ method: "POST", name: "intake", urlPath: "/intake/v1" }],
      diagnostics: { errors: 0, warnings: 0 },
      memory: {
        analyst: ["brain"],
        classifier: [],
        root: ["brain", "preferences"],
      },
      model: "vendor/model",
      stationTools: { analyst: ["bash", "grep"] },
      status: "ready",
      subagents: ["analyst", "classifier"],
      tools: ["bash", "web_fetch"],
    });
  });
});
