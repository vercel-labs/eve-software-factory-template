import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  describeCloneFailure,
  sanitizeCommandOutput,
} from "#lib/github/bootstrap-diagnostics.js";
import {
  interactionOpenedCallback,
  postCallback,
  sessionEndedCallback,
  turnSettledCallback,
} from "#lib/intake/callbacks.js";
import {
  allowedCallback,
  MAX_TICKET_BYTES,
  readLimitedText,
  ticketIdFor,
  ticketSchema,
  verifyCallback,
} from "#lib/intake/ticket.js";
import { applyLabels, fetchIssue, runIdFromLink } from "#lib/triage/github.js";
import intake from "../../agent/channels/intake.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ticket ids cannot be made to collide", () => {
  test("moving a separator between the caller and the external id gives a different ticket", () => {
    expect(ticketIdFor("a\nb", "c")).not.toBe(ticketIdFor("a", "b\nc"));
    expect(ticketIdFor('a","b', "c")).not.toBe(ticketIdFor("a", 'b","c'));
    expect(ticketIdFor("a", "b")).toBe(ticketIdFor("a", "b"));
  });
});

describe("ticket fields that render on their own line must be a single line", () => {
  const base = {
    body: "Body text\nwith several\nlines is fine.",
    title: "Login returns 500",
  };

  test("a multi-line body is accepted", () => {
    expect(ticketSchema.safeParse(base).success).toBe(true);
  });

  test.each([
    ["title", { title: "Fix login\nRequester: repo-owner" }],
    ["source (a newline)", { source: "helpdesk\nRequester: repo-owner" }],
    ["requester", { requester: "dana\r\nPriority: urgent" }],
    // The Unicode line and paragraph separators break a line as well.
    ["externalId", { externalId: "HELP-1\u2028Source: trusted" }],
    ["source (U+2029)", { source: "helpdesk\u2029Requester: repo-owner" }],
    ["a label", { labels: ["bug\nSubmitter's priority: urgent"] }],
    ["source (NUL)", { source: "help\u0000desk" }],
    ["source (the last C0 control)", { source: "help\u001fdesk" }],
    ["source (DEL)", { source: "help\u007fdesk" }],
    ["title (a tab)", { title: "Fix\tlogin" }],
  ])(
    "a line break or control character in %s is rejected",
    (_field, override) => {
      expect(ticketSchema.safeParse({ ...base, ...override }).success).toBe(
        false
      );
    }
  );
});

describe("readLimitedText: the body limit bounds what is read, not just what is accepted", () => {
  const request = (
    body: BodyInit | null,
    headers: Record<string, string> = {}
  ) =>
    new Request("https://factory.test/intake/v1/tickets", {
      body,
      // @ts-expect-error duplex is required by Node for stream bodies and missing from the DOM types
      duplex: "half",
      headers,
      method: "POST",
    });

  test("returns the body when it fits", async () => {
    expect(await readLimitedText(request('{"title":"t"}'), 64)).toBe(
      '{"title":"t"}'
    );
    expect(await readLimitedText(request("é".repeat(10)), 20)).toBe(
      "é".repeat(10)
    );
  });

  test("an empty body reads as empty text", async () => {
    expect(await readLimitedText(request(null), 64)).toBe("");
  });

  test("a body one byte over the limit is refused; one exactly at it is read", async () => {
    expect(await readLimitedText(request("x".repeat(65)), 64)).toBeNull();
    expect(await readLimitedText(request("x".repeat(64)), 64)).toBe(
      "x".repeat(64)
    );
  });

  test("the limit counts bytes, not characters", async () => {
    expect(await readLimitedText(request("é".repeat(33)), 64)).toBeNull();
  });

  test("a declared length over the limit is refused without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16));
      },
    });
    expect(
      await readLimitedText(request(stream, { "content-length": "999999" }), 64)
    ).toBeNull();
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("an endless body with no declared length is cut off at the limit", async () => {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        produced += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readLimitedText(request(stream), MAX_TICKET_BYTES)).toBeNull();
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(MAX_TICKET_BYTES * 2);
  });
});

describe("callback allowlist entries may pin a port", () => {
  test("a bare host allows any port on that host", () => {
    expect(
      allowedCallback("https://hooks.example.com:8443/x", "hooks.example.com")
    ).not.toBeNull();
  });

  test("host:port allows that port only", () => {
    const allowlist = "hooks.example.com:8443";
    expect(
      allowedCallback("https://hooks.example.com:8443/x", allowlist)
    ).not.toBeNull();
    expect(
      allowedCallback("https://hooks.example.com/x", allowlist)
    ).toBeNull();
    expect(
      allowedCallback("https://hooks.example.com:9000/x", allowlist)
    ).toBeNull();
  });

  test("host:443 matches the default port", () => {
    expect(
      allowedCallback("https://hooks.example.com/x", "hooks.example.com:443")
    ).not.toBeNull();
  });
});

describe("signed callbacks", () => {
  const state = {
    callbackUrl: "https://hooks.example.com/factory",
    ticketId: "a".repeat(32),
  };

  const capture = () => {
    const calls: {
      body: string;
      headers: Record<string, string>;
      redirect?: string;
      url: string;
    }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({
        body: String(init.body),
        headers: init.headers as Record<string, string>,
        redirect: init.redirect,
        url,
      });
      return new Response(null, { status: 204 });
    });
    return calls;
  };

  test("a failed turn is reported with a signature the receiver can verify, and no internal message", async () => {
    vi.stubEnv("FACTORY_INTAKE_CALLBACK_SECRET", "callback-secret-for-tests");
    const calls = capture();
    const sent = await postCallback(
      state,
      turnSettledCallback(
        "wrun_test",
        {
          error: {
            code: "REACTION_FAILED",
            id: "err_1",
            message: "storage misconfigured at /srv/app",
          },
          outcome: "failed",
          turnId: "turn_0",
        },
        "a reply that must not be sent for a failed turn"
      ),
      () => new Date("2026-11-11T00:00:00.000Z")
    );
    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.url).toBe("https://hooks.example.com/factory");
    expect(call.redirect).toBe("error");
    expect(JSON.parse(call.body)).toEqual({
      error: { code: "REACTION_FAILED", id: "err_1" },
      result: null,
      sentAt: "2026-11-11T00:00:00.000Z",
      sessionId: "wrun_test",
      status: "failed",
      ticketId: "a".repeat(32),
    });
    expect(call.body).not.toContain("/srv/app");
    expect(call.headers["idempotency-key"]).toBe("wrun_test:turn_0:settled");
    // Recomputed here the way a receiver would, not with the module's own
    // signer: the header is the hex HMAC-SHA256 of the exact bytes sent.
    expect(call.headers["x-factory-signature"]).toBe(
      createHmac("sha256", "callback-secret-for-tests")
        .update(call.body)
        .digest("hex")
    );
    expect(
      verifyCallback(
        call.body,
        call.headers["x-factory-signature"] ?? "",
        "callback-secret-for-tests"
      )
    ).toBe(true);
  });

  test("a completed turn carries the final message", () => {
    expect(
      turnSettledCallback(
        "s",
        { outcome: "completed", turnId: "t1" },
        "Draft PR: #44"
      ).payload
    ).toEqual({
      error: null,
      result: "Draft PR: #44",
      sessionId: "s",
      status: "completed",
    });
  });

  test("a pending approval is reported as awaiting input", () => {
    expect(
      interactionOpenedCallback("s", {
        interactionId: "int_1",
        request: { kind: "budget", prompt: "Keep going?" },
      })
    ).toEqual({
      key: "s:int_1:opened",
      payload: {
        pending: {
          interactionId: "int_1",
          kind: "budget",
          prompt: "Keep going?",
        },
        sessionId: "s",
        status: "awaiting-input",
      },
    });
  });

  test("a session that ends cleanly has nothing to report; one that fails does", () => {
    expect(sessionEndedCallback("s", { outcome: "completed" })).toBeNull();
    expect(
      sessionEndedCallback("s", {
        error: { code: "X", id: "e", message: "secret detail" },
        outcome: "failed",
      })
    ).toEqual({
      key: "s:ended",
      payload: {
        error: { code: "X", id: "e" },
        sessionId: "s",
        status: "failed",
      },
    });
  });

  test("the same event always carries the same idempotency key", () => {
    const data = { outcome: "completed", turnId: "t1" };
    expect(turnSettledCallback("s", data, "a").key).toBe(
      turnSettledCallback("s", data, "b").key
    );
  });

  test("nothing is sent without a callback URL, or without a secret to sign with", async () => {
    const calls = capture();
    const callback = turnSettledCallback(
      "s",
      { outcome: "failed", turnId: "t" },
      null
    );
    vi.stubEnv("FACTORY_INTAKE_CALLBACK_SECRET", undefined);
    expect(await postCallback(state, callback)).toBe(false);
    vi.stubEnv("FACTORY_INTAKE_CALLBACK_SECRET", "");
    expect(await postCallback(state, callback)).toBe(false);
    vi.stubEnv("FACTORY_INTAKE_CALLBACK_SECRET", "callback-secret-for-tests");
    expect(await postCallback({ ...state, callbackUrl: null }, callback)).toBe(
      false
    );
    expect(calls).toHaveLength(0);

    // The control: with both in place the same callback does go out.
    expect(await postCallback(state, callback)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("a receiver that is down never throws into the turn", async () => {
    vi.stubEnv("FACTORY_INTAKE_CALLBACK_SECRET", "callback-secret-for-tests");
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callback = turnSettledCallback(
      "s",
      { outcome: "failed", turnId: "t" },
      null
    );
    await expect(postCallback(state, callback)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("the channel registers handlers for exactly these three events", () => {
    const { adapter } = intake as unknown as {
      adapter: Record<string, unknown>;
    };
    expect(
      Object.keys(adapter)
        .filter((key) => key.includes("."))
        .sort()
    ).toEqual(["interaction.opened", "session.ended", "turn.settled"]);
  });
});

describe("redaction keeps the evidence and loses the secret", () => {
  test("ordinary phrases about authentication are left alone", () => {
    for (const text of [
      "fatal: basic authentication failed",
      "remote: bearer authentication is required",
      "set light_mode_enabled and weight_per_unit_kg",
    ]) {
      expect(sanitizeCommandOutput(text)).toBe(text);
    }
  });

  test("a clone refused for credentials is still diagnosed as an app access problem", () => {
    expect(
      describeCloneFailure("acme/widgets", "fatal: basic authentication failed")
    ).toMatch(/Install the selected GitHub connector's app/);
    expect(
      describeCloneFailure(
        "acme/widgets",
        "remote: Permission to acme/widgets.git denied to foreman[bot]."
      )
    ).toMatch(/Install the selected GitHub connector's app/);
  });

  test.each([
    [
      "a token glued to the text before it",
      "token=ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
    [
      "a token after an underscore",
      "x_ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
    [
      "a credential in a URL",
      "fatal: unable to access 'https://oauth2:s3cr3t-value@github.com/acme/widgets.git/'",
      "s3cr3t-value",
    ],
    [
      "a basic credential",
      "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX2FiY2RlZmdoaWprbG1ub3A=",
      "eC1hY2Nlc3MtdG9rZW46Z2hzX2FiY2RlZmdoaWprbG1ub3A=",
    ],
    [
      "a bearer credential",
      "sent Bearer abcdefghijklmnopqrstuvwxyz.0123456789",
      "abcdefghijklmnopqrstuvwxyz.0123456789",
    ],
  ])("%s is redacted", (_name, text, secret) => {
    const cleaned = sanitizeCommandOutput(text);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("[redacted]");
  });
});

describe("triage helpers", () => {
  test("a run id is read from a check link that carries a query string or fragment", () => {
    expect(
      runIdFromLink(
        "https://github.com/acme/widgets/actions/runs/991?check_suite_focus=true"
      )
    ).toBe("991");
    expect(
      runIdFromLink("https://github.com/acme/widgets/actions/runs/991#summary")
    ).toBe("991");
    expect(
      runIdFromLink("https://github.com/acme/widgets/actions/runs/991/job/5")
    ).toBe("991");
    expect(
      runIdFromLink("https://github.com/acme/widgets/actions/runs/991abc")
    ).toBeNull();
  });

  test("a label named twice is applied once", async () => {
    const calls: string[][] = [];
    const added = await applyLabels(
      async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      { labels: [], number: 12 },
      ["bug", "bug", "area: auth"]
    );
    expect(added).toEqual(["bug", "area: auth"]);
    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "12",
        "--add-label",
        "bug",
        "--add-label",
        "area: auth",
      ],
    ]);
  });

  test("a failure with nothing on stderr still says something useful", async () => {
    await expect(
      fetchIssue(
        async () => ({
          exitCode: 0,
          stderr: "",
          stdout: "<html>rate limited</html>",
        }),
        12
      )
    ).rejects.toThrow(
      /Reading issue #12 failed \(gh exit 0\): <html>rate limited<\/html>/
    );
    await expect(
      fetchIssue(async () => ({ exitCode: 0, stderr: "", stdout: "" }), 12)
    ).rejects.toThrow(/gh printed nothing/);
  });
});
