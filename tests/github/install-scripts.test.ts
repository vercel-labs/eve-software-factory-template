import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  INSTALL_SCRIPT_SETTINGS,
  INSTALL_SCRIPTS_ENV,
  INSTALL_SCRIPTS_OFF_COMMAND,
  installScriptsBlocked,
} from "#lib/github/install-scripts.js";

/**
 * The install-script settings, as text and against the real package
 * managers.
 *
 * @remarks
 * The text tests hold the command to what a station session may run more
 * than once. The rest run the command with the real `sh` in a temporary
 * home directory, then install a fixture project with whichever of npm,
 * pnpm, and Yarn this machine has: the project depends on a local package
 * whose `postinstall` writes a marker file, and has a `postinstall` of its
 * own. Everything is local (`file:` dependencies), so no registry is
 * reached.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installScriptsBlocked: the deployer's switch", () => {
  test("install scripts are off unless the deployer turns them on", () => {
    vi.stubEnv(INSTALL_SCRIPTS_ENV, "");
    expect(installScriptsBlocked()).toBe(true);
  });

  test.each(["1", " 1 "])("%j turns them on", (value) => {
    vi.stubEnv(INSTALL_SCRIPTS_ENV, value);
    expect(installScriptsBlocked()).toBe(false);
  });

  test.each(["0", "true", "yes", "on"])(
    "%j is not the opt-in, so they stay off",
    (value) => {
      vi.stubEnv(INSTALL_SCRIPTS_ENV, value);
      expect(installScriptsBlocked()).toBe(true);
    }
  );
});

describe("INSTALL_SCRIPTS_OFF_COMMAND: the text", () => {
  test("covers npm, both pnpm config locations, and both Yarn generations", () => {
    expect(INSTALL_SCRIPT_SETTINGS.map((setting) => setting.line)).toEqual([
      "ignore-scripts=true",
      "ignoreScripts: true",
      "ignore-scripts true",
      "enableScripts: false",
    ]);
    expect(INSTALL_SCRIPTS_OFF_COMMAND).toContain('"$HOME/.npmrc"');
    expect(INSTALL_SCRIPTS_OFF_COMMAND).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
      '"${XDG_CONFIG_HOME:-$HOME/.config}/pnpm"/config.yaml'
    );
    expect(INSTALL_SCRIPTS_OFF_COMMAND).toContain('"$HOME/.yarnrc"');
    expect(INSTALL_SCRIPTS_OFF_COMMAND).toContain('"$HOME/.yarnrc.yml"');
  });

  test("only appends a line that is not there yet, and never truncates a file", () => {
    for (const { line } of INSTALL_SCRIPT_SETTINGS) {
      expect(INSTALL_SCRIPTS_OFF_COMMAND).toContain(`grep -qxF -- '${line}'`);
    }
    // `>>` only: a single `>` would wipe whatever else the file holds.
    expect(
      INSTALL_SCRIPTS_OFF_COMMAND.replaceAll("2>/dev/null", "")
    ).not.toMatch(/[^>]>[^>]/);
  });

  test("is one command line that sh accepts", () => {
    expect(INSTALL_SCRIPTS_OFF_COMMAND).not.toContain("\n");
    expect(
      spawnSync("sh", ["-n", "-c", INSTALL_SCRIPTS_OFF_COMMAND]).status
    ).toBe(0);
  });
});

/**
 * Where corepack keeps the package managers it has already downloaded.
 *
 * @remarks
 * `pnpm` and `yarn` are often corepack shims. Under a fresh home directory a
 * shim finds no cached copy and downloads one, which would make these tests
 * reach the network. So the scenarios point corepack at this machine's real
 * cache and forbid it to download; a package manager that is not already
 * there is treated as not installed, and its tests are skipped. Under
 * `FACTORY_REQUIRE_CLI_TESTS=1` that is a failure for npm and pnpm, which CI
 * certainly has (it runs this suite with pnpm); Yarn stays optional.
 */
const COREPACK = {
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_HOME:
    process.env.COREPACK_HOME ??
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "node",
      "corepack"
    ),
};

// Asked from the temporary directory, as the scenarios are, so a
// `packageManager` pin in this repository cannot answer for them.
const version = (binary: string) =>
  spawnSync(binary, ["--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, ...COREPACK },
  });

const npmVersion = version("npm");
const pnpmVersion = version("pnpm");
const yarnVersion = version("yarn");
const hasNpm = npmVersion.status === 0;
const hasPnpm = pnpmVersion.status === 0;
const hasYarn1 =
  yarnVersion.status === 0 && String(yarnVersion.stdout).startsWith("1.");
// CI sets this, so a runner without npm or pnpm fails the suite instead of
// skipping their tests.
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

describe.runIf(required)("the CLI contract tests are required here", () => {
  test.each([
    ["npm", npmVersion],
    ["pnpm", pnpmVersion],
  ])(
    "%s is installed, and runs without downloading anything",
    (_name, probe) => {
      expect(probe.status, String(probe.error ?? probe.stderr)).toBe(0);
      expect(String(probe.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/);
    }
  );
});

let root = "";

/**
 * A repository's own approval for the dependency's install script, in every
 * spelling pnpm 9 to 11 reads. Without it pnpm 10 and later skip a
 * dependency's script whatever the settings say, and a test of the settings
 * would pass with or without them.
 */
const PNPM_APPROVES_THE_DEPENDENCY = [
  "packages:",
  '  - "."',
  "allowBuilds:",
  '  "fixture-dependency@file:../dep": true',
  "onlyBuiltDependencies:",
  "  - fixture-dependency",
  "",
].join("\n");

/** A home directory, a marker directory, and a fresh copy of the fixture. */
const scenario = (name: string, options: { pnpmApproves?: boolean } = {}) => {
  const base = join(root, name);
  const home = join(base, "home");
  const marks = join(base, "marks");
  const dependency = join(base, "dep");
  const project = join(base, "proj");
  for (const directory of [home, marks, dependency, project]) {
    mkdirSync(directory, { recursive: true });
  }
  const mark = (file: string) =>
    `node -e "require('fs').writeFileSync(process.env.MARKS+'/${file}','x')"`;
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      scripts: { postinstall: mark("dependency-ran") },
      version: "1.0.0",
    })
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      dependencies: { "fixture-dependency": "file:../dep" },
      name: "fixture-project",
      private: true,
      scripts: { build: mark("build-ran"), postinstall: mark("root-ran") },
      version: "1.0.0",
    })
  );
  if (options.pnpmApproves) {
    writeFileSync(
      join(project, "pnpm-workspace.yaml"),
      PNPM_APPROVES_THE_DEPENDENCY
    );
  }
  const env = {
    HOME: home,
    MARKS: marks,
    // Yarn 1 and pnpm both look for a cache; keep it inside the scenario.
    npm_config_cache: join(base, "npm-cache"),
    PATH: process.env.PATH ?? "",
    ...COREPACK,
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(base, "data"),
  };
  const run = (command: string, args: readonly string[], cwd = project) =>
    spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: 90_000 });
  return {
    home,
    marks: () => readdirSync(marks).sort(),
    run,
    settle: () => run("sh", ["-c", INSTALL_SCRIPTS_OFF_COMMAND], base),
  };
};

describe.runIf(hasNpm)("INSTALL_SCRIPTS_OFF_COMMAND: run for real", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "factory-install-scripts-"));
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  test("writes each setting once, and running it again changes nothing", () => {
    const { home, settle } = scenario("idempotent");
    expect(settle().status).toBe(0);
    const files = [
      join(home, ".npmrc"),
      join(home, ".config/pnpm/config.yaml"),
      join(home, ".yarnrc"),
      join(home, ".yarnrc.yml"),
    ];
    const first = files.map((file) => readFileSync(file, "utf8"));
    expect(first).toEqual([
      "ignore-scripts=true\n",
      "ignoreScripts: true\n",
      "ignore-scripts true\n",
      "enableScripts: false\n",
    ]);
    expect(settle().status).toBe(0);
    expect(settle().status).toBe(0);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(first);
  });

  test("keeps whatever a file already holds", () => {
    const { home, settle } = scenario("existing");
    writeFileSync(join(home, ".npmrc"), "registry=https://npm.example.test/\n");
    expect(settle().status).toBe(0);
    expect(readFileSync(join(home, ".npmrc"), "utf8")).toBe(
      "registry=https://npm.example.test/\nignore-scripts=true\n"
    );
  });

  test("the fixture bites: without the settings, npm runs the dependency's script and the project's own", () => {
    const { marks, run } = scenario("npm-baseline");
    const install = run("npm", ["install", "--no-audit", "--no-fund"]);
    expect(install.status).toBe(0);
    expect(marks()).toEqual(["dependency-ran", "root-ran"]);
  }, 120_000);

  test("npm: with the settings, no install script runs, and a script run by name still does", () => {
    const { marks, run, settle } = scenario("npm");
    expect(settle().status).toBe(0);
    const install = run("npm", ["install", "--no-audit", "--no-fund"]);
    expect(install.status).toBe(0);
    expect(marks()).toEqual([]);
    expect(run("npm", ["run", "build"]).status).toBe(0);
    expect(marks()).toEqual(["build-ran"]);
  }, 120_000);

  test.runIf(hasPnpm)(
    "the fixture bites: without the settings, pnpm runs the project's own script, and the dependency's once the repository approves it",
    () => {
      const plain = scenario("pnpm-baseline");
      // No exit code here: pnpm 11 fails an install that skipped a build.
      plain.run("pnpm", ["install", "--offline"]);
      expect(plain.marks()).toContain("root-ran");

      const approved = scenario("pnpm-baseline-approved", {
        pnpmApproves: true,
      });
      const install = approved.run("pnpm", ["install", "--offline"]);
      expect(install.status, install.stdout + install.stderr).toBe(0);
      expect(approved.marks()).toEqual(["dependency-ran", "root-ran"]);
    },
    120_000
  );

  test.runIf(hasPnpm)(
    "pnpm: the settings win over the repository's own approval of a dependency's script, and the install still succeeds",
    () => {
      const { marks, run, settle } = scenario("pnpm-approved", {
        pnpmApproves: true,
      });
      expect(settle().status).toBe(0);
      const install = run("pnpm", ["install", "--offline"]);
      expect(install.status, install.stdout + install.stderr).toBe(0);
      expect(marks()).toEqual([]);
      expect(existsSync(join(root, "pnpm-approved/proj/node_modules"))).toBe(
        true
      );
    },
    120_000
  );

  test.runIf(hasPnpm)(
    "pnpm: with the settings, no install script runs, the install succeeds, and a script run by name still does",
    () => {
      const { marks, run, settle } = scenario("pnpm");
      expect(settle().status).toBe(0);
      const install = run("pnpm", ["install", "--offline"]);
      expect(install.status, install.stdout + install.stderr).toBe(0);
      expect(marks()).toEqual([]);
      expect(run("pnpm", ["run", "build"]).status).toBe(0);
      expect(marks()).toEqual(["build-ran"]);
    },
    120_000
  );

  test.runIf(hasYarn1)(
    "the fixture bites: without the settings, Yarn 1 runs the dependency's script and the project's own",
    () => {
      const { marks, run } = scenario("yarn-baseline");
      const install = run("yarn", ["install", "--offline", "--no-lockfile"]);
      expect(install.status, install.stdout + install.stderr).toBe(0);
      expect(marks()).toEqual(["dependency-ran", "root-ran"]);
    },
    120_000
  );

  test.runIf(hasYarn1)(
    "Yarn 1: with the settings, no install script runs",
    () => {
      const { marks, run, settle } = scenario("yarn");
      expect(settle().status).toBe(0);
      const install = run("yarn", ["install", "--offline", "--no-lockfile"]);
      expect(install.status, install.stdout + install.stderr).toBe(0);
      expect(marks()).toEqual([]);
      expect(existsSync(join(root, "yarn", "proj", "node_modules"))).toBe(true);
    },
    120_000
  );
});
