import { beforeEach, describe, expect, test } from "vitest";
import {
  type LeaseSandbox,
  resetTokenScopeMemo,
  TOKEN_SCOPES,
} from "#lib/github/lease.js";
import { ghTool, gitTool } from "#lib/github/tools.js";
import { approvalContext, CALLERS, outcome, reasonOf } from "../helpers.js";

/**
 * The tools as the model meets them: an input object in, an approval
 * decision, then a command in a sandbox. The sandbox and the token minter
 * are fakes; everything between them is the real code.
 */
const harness = (
  respond: { exitCode?: number; stderr?: string; stdout?: string } = {}
) => {
  const commands: string[] = [];
  const scopes: (readonly string[] | null)[] = [];
  const sandbox: LeaseSandbox = {
    name: "sbx_tools",
    run: async ({ command }) => {
      commands.push(command);
      return {
        exitCode: respond.exitCode ?? 0,
        stderr: respond.stderr ?? "",
        stdout: respond.stdout ?? "",
      };
    },
    setNetworkPolicy: async () => undefined,
    writeTextFile: async () => undefined,
  };
  const environment = {} as never;
  const lease = {
    id: () => "t",
    mint: async (permissions: readonly string[] | null) => {
      scopes.push(permissions);
      return "ghs_test_token_0123456789abcdefghij";
    },
  };
  const ctx = {
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox,
    session: { auth: { current: CALLERS.trusted, initiator: CALLERS.trusted } },
  } as never;
  return { commands, ctx, environment, lease, scopes };
};

type Tool = {
  approval: (ctx: never) => unknown;
  description: string;
  execute: (input: { args: string[] }, ctx: never) => Promise<unknown>;
  toModelOutput: (output: never) => unknown;
};

beforeEach(() => {
  resetTokenScopeMemo();
});

describe("the orchestrator's gh tool", () => {
  test("runs an allowed read with a read-scoped token", async () => {
    const h = harness({ stdout: "title: Login returns 500" });
    const tool = ghTool({
      environment: h.environment,
      lease: h.lease,
      mode: "full",
    }) as unknown as Tool;
    const result = await tool.execute({ args: ["issue", "view", "12"] }, h.ctx);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "title: Login returns 500",
    });
    expect(h.commands).toEqual(["/usr/bin/gh 'issue' 'view' '12'"]);
    expect(h.scopes[0]).toEqual([
      ...TOKEN_SCOPES["repo-read"].required,
      ...TOKEN_SCOPES["repo-read"].optional,
    ]);
  });

  test("runs a write with the triage-scoped token, which cannot write contents", async () => {
    const h = harness();
    const tool = ghTool({
      environment: h.environment,
      lease: h.lease,
      mode: "full",
    }) as unknown as Tool;
    await tool.execute(
      { args: ["issue", "edit", "12", "--add-label", "bug"] },
      h.ctx
    );
    expect(h.scopes[0]).toContain("issues:write");
    expect(h.scopes[0]).not.toContain("contents:write");
  });

  test("refuses a forbidden command at execution too, without touching the sandbox", async () => {
    const h = harness();
    const tool = ghTool({
      environment: h.environment,
      lease: h.lease,
      mode: "full",
    }) as unknown as Tool;
    await expect(
      tool.execute({ args: ["pr", "merge", "34"] }, h.ctx)
    ).rejects.toThrow(/not available to the factory/);
    await expect(
      tool.execute(
        { args: ["issue", "view", "1", "--repo", "evil/repo"] },
        h.ctx
      )
    ).rejects.toThrow(/only works on acme\/widgets/);
    expect(h.commands).toEqual([]);
    expect(h.scopes).toEqual([]);
  });

  test("its approval is the trust policy", () => {
    const tool = ghTool({
      environment: {} as never,
      mode: "full",
    }) as unknown as Tool;
    const ask = (caller: keyof typeof CALLERS, ...args: string[]) =>
      outcome(tool.approval(approvalContext(CALLERS[caller], { args })));
    expect(ask("untrusted", "issue", "view", "1")).toBe("not-applicable");
    expect(
      ask("untrusted", "issue", "create", "--title", "T", "--body", "B")
    ).toBe("user-approval");
    expect(ask("trusted", "pr", "ready", "3")).toBe("user-approval");
    expect(ask("autonomous", "pr", "ready", "3")).toBe("denied");
    expect(ask("trusted", "pr", "merge", "3")).toBe("denied");
  });

  test("output for the model: stdout on success, everything plus the exit code on failure", () => {
    const tool = ghTool({
      environment: {} as never,
      mode: "full",
    }) as unknown as Tool;
    const ok = JSON.stringify(
      tool.toModelOutput({
        exitCode: 0,
        stderr: "",
        stdout: "hello\n",
        truncated: false,
      } as never)
    );
    expect(ok).toContain("hello");
    const empty = JSON.stringify(
      tool.toModelOutput({
        exitCode: 0,
        stderr: "",
        stdout: "",
        truncated: false,
      } as never)
    );
    expect(empty).toContain("(no output)");
    const failed = JSON.stringify(
      tool.toModelOutput({
        exitCode: 1,
        stderr: "not found",
        stdout: "",
        truncated: false,
      } as never)
    );
    expect(failed).toContain("not found");
    expect(failed).toContain("[exit 1]");
  });
});

describe("a station's gh tool", () => {
  test("runs reads", async () => {
    const h = harness({ stdout: "diff" });
    const tool = ghTool({
      environment: h.environment,
      lease: h.lease,
      mode: "read-only",
    }) as unknown as Tool;
    await tool.execute({ args: ["pr", "diff", "34"] }, h.ctx);
    expect(h.commands).toEqual(["/usr/bin/gh 'pr' 'diff' '34'"]);
  });

  test("denies every write at approval and refuses it again at execution", async () => {
    const h = harness();
    const tool = ghTool({
      environment: h.environment,
      lease: h.lease,
      mode: "read-only",
    }) as unknown as Tool;
    for (const args of [
      ["issue", "comment", "12", "--body", "x"],
      ["issue", "edit", "12", "--add-label", "bug"],
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
      ["pr", "ready", "34"],
    ]) {
      for (const caller of Object.values(CALLERS)) {
        expect(outcome(tool.approval(approvalContext(caller, { args })))).toBe(
          "denied"
        );
      }
      await expect(tool.execute({ args }, h.ctx)).rejects.toThrow(/read-only/);
    }
    expect(h.commands).toEqual([]);
  });
});

describe("the implementer's git tool", () => {
  test("pushes a feature branch with a contents-write token", async () => {
    const h = harness();
    const tool = gitTool({
      environment: h.environment,
      lease: h.lease,
      push: true,
    }) as unknown as Tool;
    await tool.execute({ args: ["push", "origin", "factory/bug-x"] }, h.ctx);
    expect(h.commands[0]).toContain(
      "push 'https://github.com/acme/widgets.git' 'refs/heads/factory/bug-x:refs/heads/factory/bug-x'"
    );
    expect(h.scopes[0]).toEqual(["contents:write", "workflows:write"]);
  });

  test("denies a push to the default branch for every caller, with the reason", async () => {
    const h = harness();
    const tool = gitTool({
      environment: h.environment,
      lease: h.lease,
      push: true,
    }) as unknown as Tool;
    for (const caller of Object.values(CALLERS)) {
      const status = tool.approval(
        approvalContext(caller, { args: ["push", "origin", "main"] })
      );
      expect(outcome(status)).toBe("denied");
      expect(reasonOf(status)).toMatch(/not allowed/);
    }
    await expect(
      tool.execute({ args: ["push", "origin", "main"] }, h.ctx)
    ).rejects.toThrow(/not allowed/);
    expect(h.commands).toEqual([]);
  });

  test("never waits for approval: a station has nobody to ask", () => {
    const tool = gitTool({
      environment: {} as never,
      push: true,
    }) as unknown as Tool;
    for (const args of [
      ["push", "origin", "factory/x"],
      ["fetch"],
      ["push", "--force", "origin", "factory/x"],
      [],
    ]) {
      for (const caller of Object.values(CALLERS)) {
        expect(["not-applicable", "denied"]).toContain(
          outcome(tool.approval(approvalContext(caller, { args })))
        );
      }
    }
  });
});

describe("a read-only station's git tool", () => {
  test("fetches with a read-scoped token", async () => {
    const h = harness();
    const tool = gitTool({
      environment: h.environment,
      lease: h.lease,
      push: false,
    }) as unknown as Tool;
    await tool.execute({ args: ["fetch", "origin", "factory/bug-x"] }, h.ctx);
    expect(h.commands[0]).toContain(
      "fetch 'https://github.com/acme/widgets.git'"
    );
    expect(h.scopes[0]).not.toContain("contents:write");
  });

  test("refuses to push, at approval and at execution", async () => {
    const h = harness();
    const tool = gitTool({
      environment: h.environment,
      lease: h.lease,
      push: false,
    }) as unknown as Tool;
    const status = tool.approval(
      approvalContext(CALLERS.trusted, {
        args: ["push", "origin", "factory/x"],
      })
    );
    expect(outcome(status)).toBe("denied");
    expect(reasonOf(status)).toMatch(/never pushes/);
    await expect(
      tool.execute({ args: ["push", "origin", "factory/x"] }, h.ctx)
    ).rejects.toThrow(/never pushes/);
    expect(h.commands).toEqual([]);
    expect(tool.description).not.toContain('["push"');
  });
});
