import { describe, expect, test } from "vitest";
import { FALLBACK_BOT_NAME, mentionPattern } from "#lib/github/bot-name.js";

// `resolveBotName` reads the connector's metadata over the network, so it is
// deliberately not exercised here.

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
