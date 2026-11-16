import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { githubCredentials } from "#lib/github/credentials.js";
import {
  mintChannelToken,
  mintScopedToken,
  resetTokenScopeMemo,
  TOKEN_SCOPES,
  type TokenMinter,
} from "#lib/github/lease.js";

const NARROW = "ghs_NARROWCHANNEL0123456789abcdefghijkl";
const WIDE = "ghs_WIDEINSTALLATION0123456789abcdefghi";

/**
 * What the channel module hands to eve, and what it asks Vercel Connect for.
 *
 * @remarks
 * `agent/channels/github.ts` calls `githubChannel(...)` when it loads, so the
 * wiring tests replace that one function with a recorder and read the real
 * configuration the module passed. `getToken` is the Connect call every mint
 * ends in; it is replaced so a mint with no injected minter stays offline and
 * the request it would have sent can be read.
 */
const recorded = vi.hoisted(() => ({
  channelConfigs: [] as unknown[],
  tokenRequests: [] as unknown[][],
}));

vi.mock("eve/channels/github", () => ({
  githubChannel: (config: unknown) => {
    recorded.channelConfigs.push(config);
    return config;
  },
}));

vi.mock("@vercel/connect", async (original) => ({
  ...(await original<typeof import("@vercel/connect")>()),
  getToken: (...request: unknown[]) => {
    recorded.tokenRequests.push(request);
    return Promise.resolve("ghs_FROMCONNECT0123456789abcdefghijklmn");
  },
}));

beforeEach(() => {
  resetTokenScopeMemo();
  vi.stubEnv("FACTORY_TOKEN_FALLBACK", "");
  vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mintChannelToken: the token the GitHub channel itself uses", () => {
  test("is narrowed to issues and pull requests on the factory repository, contents read-only", async () => {
    const requests: (readonly string[] | null)[] = [];
    const mint: TokenMinter = async (requested) => {
      requests.push(requested);
      return NARROW;
    };
    expect(await mintChannelToken({ mint })).toBe(NARROW);
    const [permissions] = requests;
    expect(permissions).toEqual([
      ...TOKEN_SCOPES["repo-triage"].required,
      ...TOKEN_SCOPES["repo-triage"].optional,
    ]);
    // What the channel does: comment and react (issues, pull requests), read
    // the thread and a pull request's files (contents, pull requests).
    expect(permissions).toContain("issues:write");
    expect(permissions).toContain("pull_requests:write");
    expect(permissions).toContain("contents:read");
    // What it never needs: pushing, merging, workflows, administration.
    expect(permissions).not.toContain("contents:write");
    expect(permissions?.join(" ")).not.toMatch(/workflows|administration/);
  });

  test("never asks the connector for its unscoped token while narrowing works", async () => {
    let installationCalls = 0;
    const token = await mintChannelToken({
      installationToken: async () => {
        installationCalls += 1;
        return WIDE;
      },
      mint: async () => NARROW,
    });
    expect(token).toBe(NARROW);
    expect(installationCalls).toBe(0);
  });

  test("an installation without the optional CI permissions still gets a narrowed token", async () => {
    const mint: TokenMinter = async (permissions) => {
      if (permissions?.includes("checks:read")) {
        throw new Error("422: permissions not granted to this installation");
      }
      return NARROW;
    };
    let installationCalls = 0;
    const token = await mintChannelToken({
      installationToken: async () => {
        installationCalls += 1;
        return WIDE;
      },
      mint,
    });
    expect(token).toBe(NARROW);
    expect(installationCalls).toBe(0);
  });

  test("falls back to the connector's token, and says so, when the connector refuses to narrow: the channel must still be able to answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const token = await mintChannelToken({
      installationToken: async () => WIDE,
      mint: async () => {
        throw new Error("422: cannot narrow");
      },
    });
    expect(token).toBe(WIDE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /could not be narrowed.*using the connector's installation token/
    );
  });

  test("the fallback does not depend on FACTORY_TOKEN_FALLBACK, and never leaks into the leased scopes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refuse: TokenMinter = async () => {
      throw new Error("422: cannot narrow");
    };
    for (const setting of ["", "none", "repository"]) {
      resetTokenScopeMemo();
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting);
      let installationCalls = 0;
      const installationToken = async () => {
        installationCalls += 1;
        return WIDE;
      };
      // The repository-wide rung (null) is refused too, so only the
      // connector's own token is left.
      expect(await mintChannelToken({ installationToken, mint: refuse })).toBe(
        WIDE
      );
      expect(installationCalls).toBe(1);
      // A leased repo-triage token (the orchestrator's gh writes) does not
      // inherit what the channel fell back to: it is still refused.
      await expect(
        mintScopedToken("repo-triage", { installationToken, mint: refuse })
      ).rejects.toThrow(
        /Could not mint a GitHub token for scope "repo-triage"/
      );
      expect(installationCalls).toBe(1);
    }
  });

  test("fails with the narrowing error when there is no connector token to fall back to", async () => {
    await expect(
      mintChannelToken({
        mint: async () => {
          throw new Error("422: cannot narrow");
        },
      })
    ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-triage"/);
  });
});

describe("the channel is wired to the narrowed token", () => {
  interface ChannelConfig {
    credentials: Record<string, unknown> & {
      installationToken: () => Promise<string>;
    };
  }

  /** The configuration `agent/channels/github.ts` passed to `githubChannel`. */
  const channelConfig = async (): Promise<ChannelConfig> => {
    await import("#channels/github.js");
    expect(recorded.channelConfigs).toHaveLength(1);
    return recorded.channelConfigs[0] as ChannelConfig;
  };

  beforeEach(() => {
    recorded.tokenRequests.length = 0;
  });

  test("the channel's installationToken asks Connect for the repo-triage permissions on the factory repository alone", async () => {
    const { credentials } = await channelConfig();
    expect(await credentials.installationToken()).toBe(
      "ghs_FROMCONNECT0123456789abcdefghijklmn"
    );
    expect(recorded.tokenRequests).toEqual([
      [
        "github/test-agent",
        {
          authorizationDetails: [
            {
              org: "acme",
              permissions: [
                "contents:read",
                "issues:write",
                "pull_requests:write",
                "actions:read",
                "checks:read",
                "statuses:read",
              ],
              repositories: ["widgets"],
              type: "github_app_installation",
            },
          ],
          subject: { type: "app" },
        },
      ],
    ]);
  });

  test("it is not the connector's own installationToken, which carries every permission the app holds", async () => {
    const { credentials } = await channelConfig();
    expect(typeof githubCredentials.installationToken).toBe("function");
    expect(credentials.installationToken).not.toBe(
      githubCredentials.installationToken
    );
  });

  test("it keeps the connector's webhook verifier and app slug: every other credential is the shared one", async () => {
    const { credentials } = await channelConfig();
    const { installationToken: _narrowed, ...kept } = credentials;
    const { installationToken: _wide, ...shared } = githubCredentials;
    expect(Object.keys(kept).sort()).toEqual(["appSlug", "webhookVerifier"]);
    for (const [name, value] of Object.entries(shared)) {
      expect(kept[name]).toBe(value);
    }
  });
});
