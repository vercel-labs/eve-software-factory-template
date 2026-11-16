import { describe, expect, test } from "vitest";
import { type StationResult, stationOutput } from "#lib/stations/result.js";

describe("stationOutput", () => {
  test("returns a completed station's structured output as-is", () => {
    const data = { summary: "Login returns 500", type: "bug" };

    expect(stationOutput("classifier", { data, status: "completed" })).toBe(
      data
    );
  });

  test.each([
    ["zero", 0],
    ["false", false],
    ["an empty string", ""],
    ["an empty list", []],
    ["an empty object", {}],
  ])(
    "returns output that is %s rather than treating it as missing",
    (_case, data) => {
      expect(stationOutput("analyst", { data, status: "completed" })).toEqual(
        data
      );
    }
  );

  test("throws naming the station and its error when the station failed", () => {
    const result: StationResult = {
      error: {
        message: "The model answered in prose, not the requested structure.",
      },
      status: "failed",
    };

    expect(() => stationOutput("reviewer", result)).toThrow(
      /reviewer station failed: The model answered in prose/
    );
  });

  test("throws for a failed station even when it carries partial data", () => {
    const result: StationResult = {
      data: { verdict: "approve" },
      error: { message: "Budget exhausted." },
      status: "failed",
    };

    expect(() => stationOutput("reviewer", result)).toThrow(
      /reviewer station failed: Budget exhausted\./
    );
  });

  test("throws naming the station when it was cancelled", () => {
    expect(() => stationOutput("implementer", { status: "cancelled" })).toThrow(
      /implementer station was cancelled/
    );
  });

  test("throws for a cancelled station even when it carries partial data", () => {
    expect(() =>
      stationOutput("implementer", {
        data: { branch: "factory/bug-login", pushed: false },
        status: "cancelled",
      })
    ).toThrow(/implementer station was cancelled/);
  });

  test.each([
    ["no data", { status: "completed" }],
    ["undefined data", { data: undefined, status: "completed" }],
    ["null data", { data: null, status: "completed" }],
  ] as const)(
    "throws naming the station when it completed with %s",
    (_case, result) => {
      expect(() => stationOutput("researcher", result)).toThrow(
        /researcher station finished without the structured result/
      );
    }
  );

  test.each([
    ["failed", { error: { message: "boom" }, status: "failed" }],
    ["cancelled", { status: "cancelled" }],
    ["completed without data", { status: "completed" }],
  ] as const)(
    "names whichever station it was told about when it %s",
    (_case, result) => {
      for (const station of [
        "classifier",
        "analyst",
        "a station with spaces",
      ]) {
        expect(() => stationOutput(station, result)).toThrow(
          `The ${station} station `
        );
      }
    }
  );

  test("throws real Error instances, which surface as tool errors", () => {
    const outcomes: StationResult[] = [
      { error: { message: "boom" }, status: "failed" },
      { status: "cancelled" },
      { status: "completed" },
    ];

    for (const result of outcomes) {
      expect(() => stationOutput("analyst", result)).toThrow(Error);
    }
  });
});
