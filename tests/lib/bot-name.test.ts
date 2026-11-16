import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FALLBACK_BOT_NAME, mentionPattern } from "#lib/github/bot-name.js";

// `resolveBotName` reads the connector's metadata over the network. That one
// call is replaced here; everything `resolveBotName` does with the answer
// is the real code.
const getConnectorMetadata = vi.hoisted(() => vi.fn());
vi.mock("@vercel/connect", async (original) => ({
  ...(await original<object>()),
  getConnectorMetadata,
}));

describe("resolveBotName", () => {
  // The resolved name is kept for the life of the module, so each test
  // loads the module afresh.
  const load = async () =>
    (await import("#lib/github/bot-name.js")).resolveBotName;
  const slug = (appSlug: unknown) => ({ vendor: { appSlug } });

  beforeEach(() => {
    vi.resetModules();
    getConnectorMetadata.mockReset();
    vi.stubEnv("FACTORY_BOT_NAME", undefined);
    vi.stubEnv("GITHUB_APP_SLUG", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("FACTORY_BOT_NAME wins, then GITHUB_APP_SLUG, and neither asks the connector", async () => {
    const resolveBotName = await load();
    vi.stubEnv("GITHUB_APP_SLUG", "from-slug");
    expect(await resolveBotName()).toBe("from-slug");
    vi.stubEnv("FACTORY_BOT_NAME", "from-name");
    expect(await resolveBotName()).toBe("from-name");
    expect(getConnectorMetadata).not.toHaveBeenCalled();
  });

  test("with no override, the name is the connector's app slug, asked for once", async () => {
    getConnectorMetadata.mockResolvedValue(slug("foreman-agent"));
    const resolveBotName = await load();

    expect(await resolveBotName()).toBe("foreman-agent");
    expect(await resolveBotName()).toBe("foreman-agent");
    expect(getConnectorMetadata).toHaveBeenCalledTimes(1);
    expect(getConnectorMetadata).toHaveBeenCalledWith("github/test-agent");
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["not text", 42],
    ["longer than a name may be before it goes into a pattern", "a".repeat(81)],
  ])("refuses a slug that is %s", async (_case, appSlug) => {
    getConnectorMetadata.mockResolvedValue(slug(appSlug));
    const resolveBotName = await load();

    await expect(resolveBotName()).rejects.toThrow(
      "Connector github/test-agent metadata carries no usable GitHub App slug."
    );
  });

  test("accepts a slug at the length limit", async () => {
    getConnectorMetadata.mockResolvedValue(slug("a".repeat(80)));

    expect(await (await load())()).toBe("a".repeat(80));
  });

  test.each([
    ["an unreachable connector", () => Promise.reject(new Error("offline"))],
    ["an unusable slug", () => Promise.resolve(slug(""))],
  ])("does not remember %s: the next call asks again", async (_case, first) => {
    getConnectorMetadata
      .mockImplementationOnce(first)
      .mockResolvedValue(slug("foreman-agent"));
    const resolveBotName = await load();

    await expect(resolveBotName()).rejects.toThrow();
    expect(await resolveBotName()).toBe("foreman-agent");
    expect(getConnectorMetadata).toHaveBeenCalledTimes(2);
  });
});

describe("mentionPattern", () => {
  const foreman = mentionPattern("Foreman");

  test.each([
    "@Foreman",
    "@Foreman please take this",
    "Hey @Foreman, can you look?",
    "cc @Foreman.",
    "(@Foreman)",
    "thanks @Foreman!",
    "@Foreman: status?",
    "line one\n@Foreman\nline three",
    "ping @Foreman's queue",
    "> quoted @Foreman",
  ])("matches the mention in %j", (text) => {
    expect(foreman.test(text)).toBe(true);
  });

  test.each(["@foreman", "@FOREMAN", "@fOrEmAn take this"])(
    "matches %j whatever its case",
    (text) => {
      expect(foreman.test(text)).toBe(true);
    }
  );

  test.each([
    ["a longer handle", "@Foremans"],
    ["a longer handle with digits", "@Foreman2"],
    ["a hyphenated handle", "@Foreman-extra"],
    ["a handle ending in a hyphen", "@Foreman-"],
    ["an underscored handle", "@Foreman_x"],
    ["a different handle sharing the prefix", "@ForemanBot please"],
    ["the name without an @", "Foreman, take this"],
    ["a shorter handle", "@Forema"],
    ["an @ separated from the name", "@ Foreman"],
    ["an empty comment", ""],
  ])("does not match %s", (_case, text) => {
    expect(foreman.test(text)).toBe(false);
  });

  test("gives the same answer every time it is asked", () => {
    const text = "Hey @Foreman, can you look?";

    expect([
      foreman.test(text),
      foreman.test(text),
      foreman.test(text),
    ]).toEqual([true, true, true]);
  });

  test("matches the default persona's own name", () => {
    expect(
      mentionPattern(FALLBACK_BOT_NAME).test(`@${FALLBACK_BOT_NAME} hi`)
    ).toBe(true);
  });

  test("matches a hyphenated app slug whole", () => {
    const pattern = mentionPattern("foreman-agent");

    expect(pattern.test("@foreman-agent take this")).toBe(true);
    expect(pattern.test("@Foreman-Agent[bot]")).toBe(true);
    expect(pattern.test("@foreman take this")).toBe(false);
    expect(pattern.test("@foreman-agent-staging take this")).toBe(false);
  });

  test("reads a dot in the name literally", () => {
    const pattern = mentionPattern("a.b");

    expect(pattern.test("@a.b hello")).toBe(true);
    expect(pattern.test("@axb hello")).toBe(false);
    expect(pattern.test("@a-b hello")).toBe(false);
  });

  test.each([
    ["a star", "bot*", "@bot*", ["@bot", "@bottt", "@bo"]],
    ["a plus", "c++", "@c++", ["@c", "@cc", "@c+"]],
    ["a question mark", "bots?", "@bots?", ["@bot", "@bots"]],
    ["an alternation", "a|b", "@a|b", ["@a", "@b", "b"]],
    ["a group", "(bot)", "@(bot)", ["@bot"]],
    ["a character class", "[bot]", "@[bot]", ["@b", "@o", "@t"]],
    ["a quantifier", "o{2}", "@o{2}", ["@oo"]],
    ["anchors", "^bot$", "@^bot$", ["@bot"]],
    ["a wildcard run", ".*", "@.*", ["@anything", "@", "anything"]],
    ["a backslash class", "\\w+", "@\\w+", ["@word", "@w"]],
  ])("reads %s in the name literally", (_case, name, mention, lookalikes) => {
    const pattern = mentionPattern(name);

    expect(pattern.test(`hello ${mention} there`)).toBe(true);
    for (const lookalike of lookalikes) {
      expect(pattern.test(`hello ${lookalike} there`), lookalike).toBe(false);
    }
  });

  test("builds a pattern from any name without throwing", () => {
    for (const name of [
      "(",
      ")",
      "[",
      "\\",
      "a{",
      "*",
      "+?",
      "$^",
      "\u{1f916}bot",
    ]) {
      expect(() => mentionPattern(name)).not.toThrow();
    }
  });

  test("answers quickly for a name built to make a naive pattern backtrack", () => {
    const pattern = mentionPattern("(a+)+$");

    expect(pattern.test(`@${"a".repeat(5000)}!`)).toBe(false);
    expect(pattern.test("ping @(a+)+$ now")).toBe(true);
  });
});
