import { describe, expect, test } from "vitest";
import { MODELS } from "#lib/models.js";

const vendorOf = (id: string): string => id.split("/")[0] ?? "";

describe("MODELS", () => {
  test("the orchestrator runs on anthropic/claude-opus-5.5-fast", () => {
    expect(MODELS.orchestrator).toBe("anthropic/claude-opus-5.5-fast");
  });

  test("triage decisions run on google/gemini-decision-1", () => {
    expect(MODELS.decision).toBe("google/gemini-decision-1");
  });

  test("the implementer and the reviewer are on different vendors, so review stays independent", () => {
    expect(vendorOf(MODELS.implementer)).not.toBe("");
    expect(vendorOf(MODELS.reviewer)).not.toBe("");
    expect(vendorOf(MODELS.reviewer)).not.toBe(vendorOf(MODELS.implementer));
  });

  test("assigns a model to the orchestrator, every station, and the decision step", () => {
    expect(Object.keys(MODELS).sort()).toEqual([
      "analyst",
      "classifier",
      "decision",
      "implementer",
      "orchestrator",
      "researcher",
      "reviewer",
    ]);
  });

  test.each(Object.entries(MODELS))(
    "%s is a gateway id of the form <vendor>/<model>",
    (_name, id) => {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/);
      expect(id.split("/")).toHaveLength(2);
    }
  );
});
