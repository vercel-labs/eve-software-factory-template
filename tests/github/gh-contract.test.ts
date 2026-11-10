import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
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
 * command's help and check that every flag the allowlist accepts is one the
 * CLI really has, under the same short spelling.
 *
 * Reading help is local: no network, no credentials. The tests are skipped
 * where `gh` isn't installed (GitHub's hosted CI runners ship it).
 */
const hasGh = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;

const helpFor = (command: string): string =>
  execFileSync("gh", [...command.split(" "), "--help"], {
    encoding: "utf8",
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  });

describe.skipIf(!hasGh)(
  "the gh allowlist matches the installed GitHub CLI",
  () => {
    test.each(GH_COMMANDS.map((command) => [command]))(
      "gh %s exists and has every flag the allowlist accepts",
      (command) => {
        const help = helpFor(command);
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
  test("cover every command, and every short flag is one character", () => {
    expect(Object.keys(GH_COMMAND_FLAGS).sort()).toEqual([...GH_COMMANDS]);
    for (const pairs of Object.values(GH_COMMAND_SHORT_FLAGS)) {
      for (const [short, long] of pairs) {
        expect(short).toHaveLength(1);
        expect(long.length).toBeGreaterThan(1);
      }
    }
  });

  test("no command accepts a flag that opens a browser or an editor", () => {
    for (const flags of Object.values(GH_COMMAND_FLAGS)) {
      expect(flags).not.toContain("web");
      expect(flags).not.toContain("editor");
    }
  });
});
