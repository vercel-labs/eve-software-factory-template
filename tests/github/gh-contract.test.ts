import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  GH_COMMAND_FLAG_KINDS,
  GH_COMMAND_FLAGS,
  GH_COMMAND_SHORT_FLAGS,
  GH_COMMANDS,
} from "#lib/github/cli.js";

/**
 * Holds the allowlist against the GitHub CLI itself.
 *
 * @remarks
 * The allowlist names commands and flags by hand, and the tool refuses
 * anything it doesn't name, so a flag spelled wrong there would be a command
 * the factory can never run. These tests ask the installed `gh` for each
 * command's help and check that the command exists and that every flag the
 * allowlist accepts is one the CLI really has, of the same kind and under
 * the same short spelling.
 *
 * Reading help is local: no network, no credentials. Where `gh` isn't
 * installed the tests are skipped, unless `FACTORY_REQUIRE_CLI_TESTS=1` says
 * they must run (CI sets it), in which case a missing `gh` is a failure.
 */
const hasGh = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
const required = process.env.FACTORY_REQUIRE_CLI_TESTS === "1";

/**
 * How the CLI's help lists a flag: `--name type` for one that takes a value,
 * `--name` or `--name[=true|false]` followed by the description for a switch.
 * Returns null when the flag has no line of its own.
 */
const helpKind = (help: string, flag: string): "bool" | "value" | null => {
  const [, rest] =
    help.match(
      new RegExp(
        `^\\s+(?:-\\w, )?--${flag}(?:\\[=true\\|false\\])?((?: {2,}| \\S|$).*)$`,
        "m"
      )
    ) ?? [];
  if (rest === undefined) {
    return null;
  }
  return /^ \S/.test(rest) ? "value" : "bool";
};

describe.runIf(required)("the CLI contract tests are required here", () => {
  test("the GitHub CLI is installed", () => {
    expect(hasGh).toBe(true);
  });
});

const helpFor = (command: string): string =>
  execFileSync("gh", [...command.split(" "), "--help"], {
    encoding: "utf8",
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  });

describe.skipIf(!(hasGh || required))(
  "the gh allowlist matches the installed GitHub CLI",
  () => {
    test.each(GH_COMMANDS.map((command) => [command]))(
      "gh %s takes a value for exactly the flags the allowlist reads one for",
      (command) => {
        const help = helpFor(command);
        const wrong = Object.entries(GH_COMMAND_FLAG_KINDS[command] ?? {})
          .filter(([flag, kind]) => helpKind(help, flag) !== kind)
          .map(
            ([flag, kind]) =>
              `--${flag}: allowlist says ${kind}, gh says ${helpKind(help, flag)}`
          );
        expect(wrong).toEqual([]);
      }
    );

    // `gh pr no-such-command --help` exits 0 and prints the help of `gh pr`,
    // so the usage line is what says the help is this command's own.
    test.each(GH_COMMANDS.map((command) => [command]))(
      "gh %s exists and has every flag the allowlist accepts",
      (command) => {
        const help = helpFor(command);
        expect(help).toMatch(
          new RegExp(`^USAGE\\n {2}gh ${command}(?: |$)`, "m")
        );
        const missing = (GH_COMMAND_FLAGS[command] ?? []).filter(
          (flag) => !new RegExp(`--${flag}\\b`).test(help)
        );
        expect(missing).toEqual([]);
      }
    );

    test.each(GH_COMMANDS.map((command) => [command]))(
      "gh %s uses the short spellings the allowlist accepts",
      (command) => {
        const help = helpFor(command);
        const wrong = (GH_COMMAND_SHORT_FLAGS[command] ?? [])
          .filter(
            ([short, long]) => !new RegExp(`-${short}, --${long}\\b`).test(help)
          )
          .map(([short, long]) => `-${short}/--${long}`);
        expect(wrong).toEqual([]);
      }
    );

    test("every command with a repository context accepts the repository override the tool relies on", () => {
      const withoutOverride = GH_COMMANDS.filter(
        (command) => !(command === "api" || command.startsWith("repo "))
      ).filter((command) => !/-R, --repo\b/.test(helpFor(command)));
      expect(withoutOverride).toEqual([]);
    });
  }
);

describe("the allowlist's flag views", () => {
  /*
   * The checks against the CLI above loop over these views, and a loop over
   * nothing passes. tests/github/gh-cli.test.ts holds each view to the flags
   * written out by hand; this is the same guard where the loops are.
   */
  test("are not empty: there are commands and flags to check, and every flag has a kind", () => {
    expect(GH_COMMANDS.length).toBeGreaterThan(0);
    expect(Object.values(GH_COMMAND_FLAGS).flat().length).toBeGreaterThan(0);
    for (const command of GH_COMMANDS) {
      expect(Object.keys(GH_COMMAND_FLAG_KINDS[command] ?? {}).sort()).toEqual([
        ...(GH_COMMAND_FLAGS[command] ?? []),
      ]);
    }
  });

  test("cover every command, and every short flag is one character", () => {
    expect(Object.keys(GH_COMMAND_FLAGS).sort()).toEqual([...GH_COMMANDS]);
    expect(Object.keys(GH_COMMAND_FLAG_KINDS).sort()).toEqual([...GH_COMMANDS]);
    expect(Object.keys(GH_COMMAND_SHORT_FLAGS).sort()).toEqual([
      ...GH_COMMANDS,
    ]);
    const shorts = Object.values(GH_COMMAND_SHORT_FLAGS).flat();
    expect(shorts.length).toBeGreaterThan(0);
    for (const [short, long] of shorts) {
      expect(short).toHaveLength(1);
      expect(long.length).toBeGreaterThan(1);
    }
  });

  test("no command accepts a flag that opens a browser or an editor", () => {
    expect(Object.keys(GH_COMMAND_FLAGS).length).toBeGreaterThan(0);
    for (const flags of Object.values(GH_COMMAND_FLAGS)) {
      expect(flags).not.toContain("web");
      expect(flags).not.toContain("editor");
    }
  });
});
