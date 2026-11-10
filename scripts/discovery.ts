import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads what eve discovers from `agent/`, and whether discovery is clean.
 *
 * @remarks
 * `eve info` exits 0 even when compilation fails, so its exit code can't
 * gate anything. This runs `eve info --json` and looks at the report itself.
 * It is the engine behind `pnpm run discovery` (part of `pnpm validate`) and
 * the surface tests in `tests/surface/`.
 *
 * Discovery evaluates the agent's modules, several of which require their
 * environment at load time. Values that are unset are filled with inert
 * placeholders, so the check works on a fresh clone and in CI with no
 * secrets.
 */

export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Placeholder environment for discovery. Names nothing real. */
export const DISCOVERY_ENVIRONMENT: Readonly<Record<string, string>> = {
  EVE_TELEMETRY_DISABLED: "1",
  FACTORY_REPO: "acme/widgets",
  GITHUB_CONNECTOR: "github/foreman-agent",
  LINEAR_CONNECTOR: "linear/foreman-agent",
};

export interface DiscoveredRoute {
  readonly method: string;
  readonly name: string;
  readonly urlPath: string;
}

export interface Discovery {
  readonly channels: readonly DiscoveredRoute[];
  readonly diagnostics: { readonly errors: number; readonly warnings: number };
  /** Memory slot names per agent; the orchestrator is keyed `root`. */
  readonly memory: Readonly<Record<string, readonly string[]>>;
  readonly model: string;
  /** Tool names per station. */
  readonly stationTools: Readonly<Record<string, readonly string[]>>;
  readonly status: string;
  readonly subagents: readonly string[];
  /** The orchestrator's tool names. */
  readonly tools: readonly string[];
}

interface InfoReport {
  artifacts?: { compiledManifest?: string };
  channels?: DiscoveredRoute[];
  diagnostics?: { errors?: number; warnings?: number };
  model?: unknown;
  status?: string;
  subagents?: string[];
  toolInputSchemas?: { subagents?: Record<string, Record<string, unknown>> };
  tools?: string[];
}

interface CompiledAgent {
  bindings?: Record<string, unknown>;
  subagents?: { agent?: CompiledAgent; name?: string; id?: string }[];
}

const MEMORY_BINDING = /^memory\/([^/]+)\.ts$|^memory\.ts$/;

const memorySlots = (agent: CompiledAgent | undefined): string[] =>
  Object.keys(agent?.bindings ?? {})
    .map((path) => {
      const match = path.match(MEMORY_BINDING);
      return match === null ? null : (match[1] ?? "memory");
    })
    .filter((slot): slot is string => slot !== null)
    .sort();

/**
 * Runs discovery and returns the parsed report.
 *
 * @throws When `eve info` can't run or prints something that isn't its JSON
 * report. A report with errors is returned, not thrown, so callers can show
 * the counts.
 */
export const discover = (): Discovery => {
  const result = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, "node_modules/eve/bin/eve.js"), "info", "--json"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...DISCOVERY_ENVIRONMENT, ...process.env },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  let report: InfoReport;
  try {
    report = JSON.parse(result.stdout) as InfoReport;
  } catch (error) {
    throw new Error(
      `eve info did not print a report (exit ${result.status}).\n${(result.stderr || result.stdout).slice(-2000)}`,
      { cause: error }
    );
  }
  let compiled: CompiledAgent = {};
  const manifestPath = report.artifacts?.compiledManifest;
  if (manifestPath) {
    try {
      compiled = JSON.parse(
        readFileSync(manifestPath, "utf8")
      ) as CompiledAgent;
    } catch {
      compiled = {};
    }
  }
  const subagents = [...(report.subagents ?? [])].sort();
  const memory: Record<string, string[]> = { root: memorySlots(compiled) };
  (compiled.subagents ?? []).forEach((entry, index) => {
    const name = entry.name ?? entry.id ?? subagents[index] ?? String(index);
    memory[name] = memorySlots(entry.agent);
  });
  const stationTools: Record<string, string[]> = {};
  for (const [name, tools] of Object.entries(
    report.toolInputSchemas?.subagents ?? {}
  )) {
    stationTools[name] = Object.keys(tools).sort();
  }
  return {
    channels: report.channels ?? [],
    diagnostics: {
      errors: report.diagnostics?.errors ?? 0,
      warnings: report.diagnostics?.warnings ?? 0,
    },
    memory,
    model: typeof report.model === "string" ? report.model : "",
    stationTools,
    status: report.status ?? "unknown",
    subagents,
    tools: [...(report.tools ?? [])].sort(),
  };
};

/** True when discovery is ready with no errors and no warnings. */
export const isClean = (discovery: Discovery): boolean =>
  discovery.status === "ready" &&
  discovery.diagnostics.errors === 0 &&
  discovery.diagnostics.warnings === 0;
