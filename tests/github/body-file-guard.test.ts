import { afterEach, describe, expect, test, vi } from "vitest";
import type { LeaseSandbox } from "#lib/github/lease.js";
import { BODY_FILE_CHANGED_COMMAND, bashTool } from "#lib/github/tools.js";
import { CALLERS } from "../helpers.js";

/**
 * The guard between what the approval policy read and what runs, with the
 * parser made to fail.
 *
 * @remarks
 * A `--body-file` is read after approval, and the command is parsed again
 * with the file's text in it. The parser is written so that text cannot
 * change the command, and `tests/github/tools.test.ts` checks that it does
 * not. This file is for the day the parser is wrong: `parseGh` is wrapped
 * so that, for one marked text, it reads the command the way the faulty
 * parser once did (the `--draft` after the body lost), and the runner has
 * to refuse rather than run a command nobody approved.
 */

const FAULT = "TEXT-THAT-BREAKS-THE-PARSER";

vi.mock("#lib/github/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/github/cli.js")>();
  return {
    ...actual,
    parseGh: (argv: readonly string[]) =>
      actual.parseGh(
        argv.includes(FAULT) ? argv.filter((word) => word !== "--draft") : argv
      ),
  };
});

const COMMAND =
  "gh pr create --head factory/x --base main --title t --body-file notes.md --draft";

const run = async (text: string) => {
  const commands: string[] = [];
  const sandbox: LeaseSandbox = {
    name: `sbx_guard_${text.length}`,
    run: async ({ command }) => {
      commands.push(command);
      return {
        exitCode: 0,
        stderr: "",
        stdout: command.startsWith("/usr/bin/head") ? text : "",
      };
    },
    setNetworkPolicy: async () => undefined,
    writeTextFile: async () => undefined,
  };
  const tool = bashTool({
    environment: {} as never,
    lease: { id: () => "guard", mint: async () => "ghs_guard_token" },
    role: "orchestrator",
  });
  const ctx = {
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox,
    session: {
      auth: { current: CALLERS.trusted, initiator: CALLERS.trusted },
    },
  } as never;
  let result: Error | null = null;
  try {
    await tool.execute({ command: COMMAND }, ctx);
  } catch (error) {
    result = error as Error;
  }
  return { commands, result };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a body file whose text makes the parser read another command", () => {
  test("is refused, and gh never runs", async () => {
    const { commands, result } = await run(FAULT);
    expect(result?.message).toBe(BODY_FILE_CHANGED_COMMAND);
    // The file was read; nothing after it ran.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^\/usr\/bin\/head /);
  });

  test("ordinary text through the same wrapped parser runs the draft, so the refusal is the guard's", async () => {
    const { commands, result } = await run("An ordinary description.");
    expect(result).toBeNull();
    expect(commands.at(-1)).toMatch(
      /^\/usr\/bin\/gh 'pr' 'create' .*'--body-file' '[^']+' '--draft'; status=/
    );
  });
});
