import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  COMPLEXITIES,
  PRIORITIES,
  WORK_ITEM_TYPES,
} from "#lib/triage/decisions.js";

/** The subset of JSON Schema the station schemas are written in. */
interface SchemaNode {
  readonly additionalProperties?: unknown;
  readonly description?: unknown;
  readonly enum?: unknown;
  readonly items?: SchemaNode;
  readonly minItems?: unknown;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly type?: unknown;
}

type Json = { [key: string]: Json } | Json[] | boolean | number | string | null;
interface JsonObject {
  [key: string]: Json;
}

// Every export of the module, so a schema added later is checked too.
const stationSchemas = await import("#lib/stations/schemas.js");

const SCHEMAS = Object.entries(stationSchemas) as [string, SchemaNode][];

/** Every schema node reachable from `root`, with a readable path to it. */
const nodesOf = (root: SchemaNode, path = "$"): [string, SchemaNode][] => [
  [path, root],
  ...Object.entries(root.properties ?? {}).flatMap(([key, child]) =>
    nodesOf(child, `${path}.${key}`)
  ),
  ...(root.items ? nodesOf(root.items, `${path}[]`) : []),
];

const typesOf = (node: SchemaNode): unknown[] =>
  Array.isArray(node.type) ? node.type : [node.type];

const objectNodesOf = (root: SchemaNode) =>
  nodesOf(root).filter(([, node]) => typesOf(node).includes("object"));

const JSON_TYPES = [
  "array",
  "boolean",
  "null",
  "number",
  "integer",
  "object",
  "string",
];

const validatorFor = (schema: SchemaNode) =>
  z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);

/** One hand-written, realistic output per station schema, by export name. */
const SAMPLES: Record<string, JsonObject> = {
  ANALYST_OUTPUT_SCHEMA: {
    acceptance_criteria: [
      "POST /login with a valid password returns 200.",
      "A regression test covers the null session case.",
    ],
    affected_surface: ["src/auth/session.ts", "the public /login route"],
    approach:
      "Guard the null session before reading its user; rejected a retry wrapper.",
    artifact_id: null,
    assumptions: ["The session store is unchanged."],
    open_questions: [],
    plan: ["Add the null guard in createSession.", "Add a regression test."],
    problem_statement:
      "createSession dereferences a null session after the deploy.",
    risks: ["Other callers may rely on the thrown error."],
    test_strategy: "Unit test createSession with a null store result.",
  },
  CLASSIFIER_OUTPUT_SCHEMA: {
    actionable: true,
    affected_area: "frontend/auth",
    complexity: "small",
    needs_clarification: false,
    priority: "high",
    questions: [],
    summary: "Login returns a 500 since the last deploy.",
    type: "bug",
  },
  IMPLEMENTER_OUTPUT_SCHEMA: {
    base: "main",
    branch: "factory/bug-login-500",
    change_summary: [
      { change: "Guard the null session.", path: "src/auth/session.ts" },
    ],
    deviations: [],
    known_limitations: ["No integration test for the SSO path."],
    pushed: true,
    verification: [{ command: "pnpm test", result: "pass: 212 tests" }],
  },
  RESEARCHER_OUTPUT_SCHEMA: {
    artifact_id: "research-login-500",
    findings: [
      {
        claim: "The session library returns null for expired cookies since v4.",
        confidence: "high",
        notes: "Changed in the v4.0.0 release notes.",
        sources: [
          {
            title: "Release notes v4.0.0",
            url: "https://example.com/releases/v4",
          },
        ],
      },
    ],
    gaps: ["No statement on SSO sessions."],
    summary: "The v4 upgrade changed the expired-cookie behaviour.",
  },
  REVIEWER_OUTPUT_SCHEMA: {
    blocking_findings: [],
    criteria_results: [
      {
        criterion: "POST /login with a valid password returns 200.",
        evidence: "The new test in session.test.ts asserts it and passes.",
        pass: true,
      },
    ],
    suggestions: ["Consider logging the null case."],
    summary: "Approve: both criteria pass and the change is minimal.",
    verdict: "approve",
  },
};

const sampleFor = (name: string): JsonObject => {
  const sample = SAMPLES[name];
  if (!sample) {
    throw new Error(`write a valid sample for ${name} in SAMPLES`);
  }
  return structuredClone(sample);
};

/**
 * Every closed vocabulary in the station schemas, written out by hand: where
 * it sits (as steps into a sample, `0` for a list's entries) and what it
 * allows. The tests read the vocabularies from here, not from the schema, so
 * a schema that loses one fails instead of losing its test with it.
 */
const VOCABULARIES: Record<string, Record<string, readonly string[]>> = {
  ANALYST_OUTPUT_SCHEMA: {},
  CLASSIFIER_OUTPUT_SCHEMA: {
    complexity: ["trivial", "small", "medium", "large"],
    priority: ["critical", "high", "medium", "low"],
    type: ["bug", "feature", "refactor", "question", "chore", "security"],
  },
  IMPLEMENTER_OUTPUT_SCHEMA: {},
  RESEARCHER_OUTPUT_SCHEMA: {
    "findings.0.confidence": ["high", "medium", "low"],
  },
  REVIEWER_OUTPUT_SCHEMA: {
    verdict: ["approve", "request_changes", "reject"],
  },
};

const stepsOf = (where: string): (string | 0)[] =>
  where.split(".").map((step) => (step === "0" ? 0 : step));

/** The enums a schema declares, keyed the way `VOCABULARIES` is. */
const enumsOf = (
  root: SchemaNode,
  path: (string | 0)[] = []
): Record<string, unknown> => ({
  ...(root.enum === undefined ? {} : { [path.join(".")]: root.enum }),
  ...Object.assign(
    {},
    ...Object.entries(root.properties ?? {}).map(([key, child]) =>
      enumsOf(child, [...path, key])
    )
  ),
  ...(root.items ? enumsOf(root.items, [...path, 0]) : {}),
});

/**
 * Paths to every object in a hand-written sample, the sample itself
 * included. A list is entered through its first entry.
 */
const objectPathsIn = (
  value: Json,
  path: (string | 0)[] = []
): (string | 0)[][] => {
  if (Array.isArray(value)) {
    return value.length === 0
      ? []
      : objectPathsIn(value[0] as Json, [...path, 0]);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return [
    path,
    ...Object.entries(value).flatMap(([key, child]) =>
      objectPathsIn(child, [...path, key])
    ),
  ];
};

/** The value at `path` in a sample. */
const valueAt = (sample: Json, path: readonly (string | 0)[]): Json =>
  path.reduce<Json>(
    (value, step) => (value as Record<string | number, Json>)[step] as Json,
    sample
  );

/** Returns a copy of `sample` with the value at `path` replaced by `change`. */
const withChange = (
  sample: Json,
  path: readonly (string | 0)[],
  change: (value: Json) => Json
): Json => {
  const [step, ...rest] = path;
  if (step === undefined) {
    return change(sample);
  }
  if (Array.isArray(sample)) {
    if (sample.length === 0) {
      throw new Error(
        "the sample needs at least one entry in every list of objects"
      );
    }
    return sample.map((entry, index) =>
      index === 0 ? withChange(entry, rest, change) : entry
    );
  }
  if (sample === null || typeof sample !== "object" || !(step in sample)) {
    throw new Error(`the sample has nothing at ${path.join(".")}`);
  }
  return { ...sample, [step]: withChange(sample[step] as Json, rest, change) };
};

describe("station output schemas: structure", () => {
  test("there is a schema for each of the five stations", () => {
    expect(SCHEMAS.map(([name]) => name).sort()).toEqual([
      "ANALYST_OUTPUT_SCHEMA",
      "CLASSIFIER_OUTPUT_SCHEMA",
      "IMPLEMENTER_OUTPUT_SCHEMA",
      "RESEARCHER_OUTPUT_SCHEMA",
      "REVIEWER_OUTPUT_SCHEMA",
    ]);
  });

  describe.each(SCHEMAS)("%s", (name, schema) => {
    test("is a closed object schema", () => {
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    });

    test("closes every nested object too", () => {
      for (const [path, node] of objectNodesOf(schema)) {
        expect(node.additionalProperties, path).toBe(false);
        expect(node.properties, path).toBeTypeOf("object");
      }
    });

    test("requires every property it declares, at every depth, each once", () => {
      for (const [path, node] of objectNodesOf(schema)) {
        const declared = Object.keys(node.properties ?? {});
        const required = node.required ?? [];

        expect(Array.isArray(node.required), path).toBe(true);
        expect(declared.length, path).toBeGreaterThan(0);
        expect([...required].sort(), path).toEqual([...declared].sort());
      }
    });

    test("has exactly the closed vocabularies written out above", () => {
      expect(enumsOf(schema)).toEqual(VOCABULARIES[name]);
    });

    test("gives every property a known JSON type", () => {
      for (const [path, node] of nodesOf(schema)) {
        const types = typesOf(node);

        expect(types.length, path).toBeGreaterThan(0);
        for (const type of types) {
          expect(JSON_TYPES, `${path} has type ${String(type)}`).toContain(
            type
          );
        }
      }
    });

    test("says what every list holds", () => {
      for (const [path, node] of nodesOf(schema)) {
        if (typesOf(node).includes("array")) {
          expect(node.items, path).toBeTypeOf("object");
          expect(node.items?.type, `${path}[]`).toBeDefined();
        }
      }
    });

    test("writes every enum as a non-empty list of distinct strings", () => {
      for (const [path, node] of nodesOf(schema)) {
        if (node.enum === undefined) {
          continue;
        }
        const values = node.enum as unknown[];

        expect(Array.isArray(values), path).toBe(true);
        expect(values.length, path).toBeGreaterThan(0);
        expect(new Set(values).size, path).toBe(values.length);
        for (const value of values) {
          expect(value, path).toBeTypeOf("string");
          expect(value, path).not.toBe("");
        }
        expect(node.type, path).toBe("string");
      }
    });

    test("writes every description as non-empty text", () => {
      for (const [path, node] of nodesOf(schema)) {
        if (node.description !== undefined) {
          expect(node.description, path).toBeTypeOf("string");
          expect(String(node.description).trim(), path).not.toBe("");
        }
      }
    });

    test("is plain JSON, as eve's outputSchema needs", () => {
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    });
  });
});

describe("station output schemas: validation", () => {
  test("every exported schema has a hand-written sample, and nothing else does", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      SCHEMAS.map(([name]) => name).sort()
    );
  });

  describe.each(SCHEMAS)("%s", (name, schema) => {
    const validator = validatorFor(schema);
    const valid = (value: Json) => validator.safeParse(value).success;

    test("accepts a realistic output", () => {
      const result = validator.safeParse(sampleFor(name));

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });

    test("rejects an output with an extra key, at any depth", () => {
      const paths = objectPathsIn(sampleFor(name));

      expect(paths.length).toBe(objectNodesOf(schema).length);
      for (const path of paths) {
        const extended = withChange(sampleFor(name), path, (value) => ({
          ...(value as JsonObject),
          unexpected_key: "x",
        }));

        expect(valid(extended), `extra key at $.${path.join(".")}`).toBe(false);
      }
    });

    test.each(Object.entries(VOCABULARIES[name] ?? {}))(
      "accepts each listed value at $.%s, and nothing else",
      (where, values) => {
        const sample = sampleFor(name);
        const path = stepsOf(where);

        for (const value of values) {
          expect(valid(withChange(sample, path, () => value)), value).toBe(
            true
          );
          expect(
            valid(withChange(sample, path, () => value.toUpperCase())),
            value.toUpperCase()
          ).toBe(false);
        }
        expect(
          valid(withChange(sample, path, () => "not-a-listed-value"))
        ).toBe(false);
      }
    );

    test("rejects an output missing any key of the sample, at any depth", () => {
      const sample = sampleFor(name);
      const paths = objectPathsIn(sample);

      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        const keys = Object.keys(valueAt(sample, path) as JsonObject);

        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
          const without = withChange(sample, path, (value) => {
            const { [key]: _removed, ...rest } = value as JsonObject;
            return rest;
          });

          expect(valid(without), `without ${key} at $.${path.join(".")}`).toBe(
            false
          );
        }
      }
    });

    test("rejects an output whose value has the wrong type", () => {
      for (const key of Object.keys(schema.properties ?? {})) {
        const sample = sampleFor(name);
        const wrong = typeof sample[key] === "number" ? "a string" : 12_345;

        expect(
          valid({ ...sample, [key]: wrong }),
          `${key} as ${typeof wrong}`
        ).toBe(false);
      }
    });

    test.each([
      ["a list", [sampleFor(name)]],
      ["a string", JSON.stringify(sampleFor(name))],
      ["null", null],
      ["an empty object", {}],
    ])("rejects %s in place of the output object", (_case, value) => {
      expect(valid(value)).toBe(false);
    });
  });
});

describe("station output schemas: specific contracts", () => {
  const enumOf = (schema: SchemaNode, key: string) =>
    schema.properties?.[key]?.enum;

  test("the classifier uses the same vocabularies as fast triage", () => {
    const classifier: SchemaNode = stationSchemas.CLASSIFIER_OUTPUT_SCHEMA;

    expect(enumOf(classifier, "type")).toEqual([...WORK_ITEM_TYPES]);
    expect(enumOf(classifier, "priority")).toEqual([...PRIORITIES]);
    expect(enumOf(classifier, "complexity")).toEqual([...COMPLEXITIES]);
  });

  test("the reviewer's verdict is approve, request_changes, or reject", () => {
    expect(
      stationSchemas.REVIEWER_OUTPUT_SCHEMA.properties.verdict.enum
    ).toEqual(["approve", "request_changes", "reject"]);
  });

  test.each([
    ["ANALYST_OUTPUT_SCHEMA", stationSchemas.ANALYST_OUTPUT_SCHEMA],
    ["RESEARCHER_OUTPUT_SCHEMA", stationSchemas.RESEARCHER_OUTPUT_SCHEMA],
  ] as const)(
    "%s takes an artifact id that is text or null, and nothing else",
    (name, schema) => {
      const validator = validatorFor(schema);
      const withArtifact = (artifact_id: Json) =>
        validator.safeParse({ ...sampleFor(name), artifact_id }).success;

      expect(withArtifact(null)).toBe(true);
      expect(withArtifact("analysis-login-500")).toBe(true);
      expect(withArtifact(7)).toBe(false);
      expect(withArtifact(false)).toBe(false);
      expect(withArtifact(["analysis-login-500"])).toBe(false);
    }
  );

  test("the analyst must give at least one plan step and one acceptance criterion", () => {
    const validator = validatorFor(stationSchemas.ANALYST_OUTPUT_SCHEMA);
    const sample = sampleFor("ANALYST_OUTPUT_SCHEMA");

    expect(validator.safeParse({ ...sample, plan: [] }).success).toBe(false);
    expect(
      validator.safeParse({ ...sample, acceptance_criteria: [] }).success
    ).toBe(false);
    expect(
      validator.safeParse({ ...sample, assumptions: [], risks: [] }).success
    ).toBe(true);
  });

  test("a research finding must cite at least one source with a url and a title", () => {
    const validator = validatorFor(stationSchemas.RESEARCHER_OUTPUT_SCHEMA);
    const sample = sampleFor("RESEARCHER_OUTPUT_SCHEMA");
    const withSources = (sources: Json) =>
      validator.safeParse(
        withChange(sample, ["findings", 0, "sources"], () => sources)
      ).success;

    expect(withSources([])).toBe(false);
    expect(withSources([{ url: "https://example.com" }])).toBe(false);
    expect(withSources([{ title: "Untraceable" }])).toBe(false);
    expect(withSources([{ title: "Docs", url: "https://example.com" }])).toBe(
      true
    );
    expect(validator.safeParse({ ...sample, findings: [] }).success).toBe(true);
  });

  test("a review result must say pass or fail as a boolean for each criterion", () => {
    const validator = validatorFor(stationSchemas.REVIEWER_OUTPUT_SCHEMA);
    const sample = sampleFor("REVIEWER_OUTPUT_SCHEMA");
    const withPass = (pass: Json) =>
      validator.safeParse(
        withChange(sample, ["criteria_results", 0, "pass"], () => pass)
      ).success;

    expect(withPass(false)).toBe(true);
    expect(withPass("true")).toBe(false);
    expect(withPass(1)).toBe(false);
    expect(withPass(null)).toBe(false);
  });

  test("the implementer must say whether it pushed, as a boolean", () => {
    const validator = validatorFor(stationSchemas.IMPLEMENTER_OUTPUT_SCHEMA);
    const sample = sampleFor("IMPLEMENTER_OUTPUT_SCHEMA");

    expect(validator.safeParse({ ...sample, pushed: false }).success).toBe(
      true
    );
    expect(validator.safeParse({ ...sample, pushed: "yes" }).success).toBe(
      false
    );
  });
});
