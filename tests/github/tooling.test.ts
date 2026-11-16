import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ghShim, gitShim, SHIM_DIRECTORY } from "#lib/github/shims.js";
import {
  FACTORY_TOOLING_VERSION,
  INSTALL_SCRIPT,
  installFactoryTooling,
} from "#lib/github/tooling.js";

const DELIMITER = "FACTORY_WRAPPER_SCRIPT_END";

/** A wrapper as the installer writes it: the script, ending in one new line. */
const installed = (script: string): string => `${script.trimEnd()}\n`;

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factory-tooling-"));
});

afterAll(() => {
  if (root !== "") {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("INSTALL_SCRIPT", () => {
  test("passes the shell's syntax check", () => {
    const file = join(root, "install.sh");
    writeFileSync(file, INSTALL_SCRIPT);
    const checked = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });

  test("stops at the first failing step", () => {
    expect(INSTALL_SCRIPT.startsWith("set -e\n")).toBe(true);
  });

  test.each([
    ["gh", ghShim()],
    ["git", gitShim()],
  ])(
    "holds the %s wrapper word for word, inside a quoted heredoc",
    (name, script) => {
      // The quotes around the delimiter are what stop the installing shell
      // from expanding the `$` and backticks the wrapper is full of.
      expect(INSTALL_SCRIPT).toContain(
        `$SUDO tee ${SHIM_DIRECTORY}/${name} >/dev/null <<'${DELIMITER}'\n${installed(script)}${DELIMITER}\n$SUDO chmod 0755 ${SHIM_DIRECTORY}/${name}\n`
      );
      expect(script).not.toContain(DELIMITER);
    }
  );

  test.each([["gh"], ["git"]])(
    "fails the build unless %s resolves to the wrapper in /usr/local/bin",
    (name) => {
      expect(INSTALL_SCRIPT).toContain(
        `[ "$(command -v ${name})" = /usr/local/bin/${name} ] || {`
      );
    }
  );

  /*
   * A wrapper that held the delimiter would end its heredoc early, and the
   * rest of the wrapper would run as part of the installer. The module is
   * loaded again here with a `git` wrapper that does hold it.
   */
  test("refuses to load with a wrapper that contains the heredoc delimiter", async () => {
    vi.resetModules();
    vi.doMock("#lib/github/shims.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("#lib/github/shims.js")>()),
      gitShim: () => `#!/bin/sh\n# ${DELIMITER}\nexit 0\n`,
    }));
    try {
      await expect(import("#lib/github/tooling.js")).rejects.toThrow(
        "The git wrapper contains the heredoc delimiter."
      );
    } finally {
      vi.doUnmock("#lib/github/shims.js");
      vi.resetModules();
    }
  });

  test("checks the real binaries by absolute path, after the wrappers are in place", () => {
    const lines = INSTALL_SCRIPT.split("\n");
    expect(lines.slice(-3)).toEqual([
      "/usr/bin/gh --version",
      "/usr/bin/git --version",
      "pnpm --version",
    ]);
    expect(lines).toContain(
      "[ -x /usr/bin/gh ] || { echo 'the GitHub CLI is missing at /usr/bin/gh' >&2; exit 1; }"
    );
    expect(lines).toContain(
      "[ -x /usr/bin/git ] || { echo 'git is missing at /usr/bin/git' >&2; exit 1; }"
    );
  });
});

describe("INSTALL_SCRIPT: the part that writes the wrappers, run for real", () => {
  /*
   * The lines from `mkdir` to the last wrapper check, with /usr/local/bin
   * swapped for a temporary directory and SUDO empty. Everything else is the
   * installer's own text, so this is the heredoc a sandbox build runs.
   */
  const seedingPart = (directory: string): string => {
    const lines = INSTALL_SCRIPT.split("\n");
    const first = lines.indexOf(`$SUDO mkdir -p ${SHIM_DIRECTORY}`);
    const last = lines.indexOf("/usr/bin/gh --version");
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    // The swap below must not reach into a wrapper's own text.
    expect(ghShim()).not.toContain(SHIM_DIRECTORY);
    expect(gitShim()).not.toContain(SHIM_DIRECTORY);
    return [
      "set -e",
      'SUDO=""',
      ...lines
        .slice(first, last)
        .map((line) => line.replaceAll(SHIM_DIRECTORY, directory)),
    ].join("\n");
  };

  const runPart = (directory: string, path: string) =>
    spawnSync("sh", ["-c", seedingPart(directory)], {
      encoding: "utf8",
      env: { PATH: path },
    });

  test("writes both wrappers byte for byte, executable, and finds them first on PATH", () => {
    const directory = join(root, "bin");
    const result = runPart(directory, `${directory}:${process.env.PATH ?? ""}`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // tee's copy to standard output is discarded.
    expect(result.stdout).toBe("");

    expect(readdirSync(directory).sort()).toEqual(["gh", "git"]);
    expect(readFileSync(join(directory, "gh"), "utf8")).toBe(
      installed(ghShim())
    );
    expect(readFileSync(join(directory, "git"), "utf8")).toBe(
      installed(gitShim())
    );
    for (const name of ["gh", "git"]) {
      // biome-ignore lint/suspicious/noBitwiseOperators: reading permission bits.
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o755);
    }
  });

  test("the written wrappers still pass the shell's syntax check", () => {
    const directory = join(root, "bin");
    for (const name of ["gh", "git"]) {
      const checked = spawnSync("sh", ["-n", join(directory, name)], {
        encoding: "utf8",
      });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    }
  });

  test("fails when PATH does not put the wrappers first", () => {
    const directory = join(root, "unlisted");
    // The wrapper directory is not on PATH at all here, so `gh` resolves
    // to the developer's own or to nothing: either way, not the wrapper.
    const result = runPart(directory, process.env.PATH ?? "");
    expect(result.status).toBe(1);
    expect(result.stderr.startsWith("gh resolves to ")).toBe(true);
    expect(
      result.stderr.endsWith(`, not the factory wrapper at ${directory}/gh\n`)
    ).toBe(true);
    // It stopped at the first check: the git wrapper was never written.
    expect(readdirSync(directory)).toEqual(["gh"]);
  });
});

describe("FACTORY_TOOLING_VERSION", () => {
  test("is 16 lowercase hex characters", () => {
    expect(FACTORY_TOOLING_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is the start of the install script's SHA-256, so any change to it re-keys the sandboxes", () => {
    expect(FACTORY_TOOLING_VERSION).toBe(
      createHash("sha256").update(INSTALL_SCRIPT).digest("hex").slice(0, 16)
    );
  });

  // A wrapper is not this module's own text. The module is loaded again
  // with a `git` wrapper one comment longer, and nothing else changed.
  test("changes when a wrapper alone changes", async () => {
    vi.resetModules();
    vi.doMock("#lib/github/shims.js", async (importOriginal) => {
      const shims =
        await importOriginal<typeof import("#lib/github/shims.js")>();
      return { ...shims, gitShim: () => `${shims.gitShim()}# one more line\n` };
    });
    try {
      const changed = await import("#lib/github/tooling.js");
      expect(changed.INSTALL_SCRIPT).not.toBe(INSTALL_SCRIPT);
      expect(changed.INSTALL_SCRIPT).toContain("\n# one more line\n");
      expect(changed.FACTORY_TOOLING_VERSION).toMatch(/^[0-9a-f]{16}$/);
      expect(changed.FACTORY_TOOLING_VERSION).not.toBe(FACTORY_TOOLING_VERSION);
    } finally {
      vi.doUnmock("#lib/github/shims.js");
      vi.resetModules();
    }
  });
});

describe("installFactoryTooling", () => {
  const sandboxThat = (result: {
    exitCode: number;
    stderr?: string;
    stdout?: string;
  }) => {
    const commands: string[] = [];
    const sandbox = {
      run: async (input: { command: string }) => {
        commands.push(input.command);
        return { stderr: "", stdout: "", ...result };
      },
    };
    return { commands, sandbox: sandbox as never };
  };

  test("runs exactly the install script, once", async () => {
    const { commands, sandbox } = sandboxThat({ exitCode: 0 });
    await expect(installFactoryTooling(sandbox)).resolves.toBeUndefined();
    expect(commands).toEqual([INSTALL_SCRIPT]);
  });

  test("a failed install throws with the exit code and what the script said", async () => {
    const { sandbox } = sandboxThat({
      exitCode: 100,
      stderr: "E: Unable to locate package gh\n",
      stdout: "Reading package lists...",
    });
    await expect(installFactoryTooling(sandbox)).rejects.toThrow(
      "Installing the factory's sandbox tooling failed (exit 100): E: Unable to locate package gh"
    );
  });

  test("only the tail of a long error is kept, where the failure is", async () => {
    const stderr = `${"early noise\n".repeat(400)}gh resolves to /usr/bin/gh, not the factory wrapper at /usr/local/bin/gh\n`;
    const { sandbox } = sandboxThat({ exitCode: 1, stderr });
    const error = await installFactoryTooling(sandbox).catch(
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    const prefix = "Installing the factory's sandbox tooling failed (exit 1): ";
    expect(message.startsWith(prefix)).toBe(true);
    expect(message.slice(prefix.length)).toBe(stderr.trim().slice(-2000));
    expect(message.slice(prefix.length)).toHaveLength(2000);
    expect(
      message.endsWith(
        "gh resolves to /usr/bin/gh, not the factory wrapper at /usr/local/bin/gh"
      )
    ).toBe(true);
  });

  test("standard output stands in when the script wrote no error", async () => {
    const { sandbox } = sandboxThat({
      exitCode: 1,
      stdout: "npm error code EACCES\n",
    });
    await expect(installFactoryTooling(sandbox)).rejects.toThrow(
      "Installing the factory's sandbox tooling failed (exit 1): npm error code EACCES"
    );
  });
});
