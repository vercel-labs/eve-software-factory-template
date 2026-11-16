import { describe, expect, test } from "vitest";
import instrumentation from "#instrumentation/otel.js";

/**
 * The process-wide trace policy. eve's default records a conversation's
 * content only when its audience is public, which leaves every run on a
 * private repository empty in Agent Runs; the factory records all of them.
 */
describe("the trace policy records content for every session", () => {
  const { tracePolicy } = instrumentation.options;

  test.each(
    (["public", "private", "unknown"] as const).flatMap((audience) =>
      (["production", "preview", "development"] as const).map(
        (environment) => [audience, environment] as const
      )
    )
  )(
    "a %s session in %s is emitted with its inputs and outputs",
    (audience, environment) => {
      expect(tracePolicy).toBeTypeOf("function");
      expect(tracePolicy?.({ audience, environment } as never)).toEqual({
        emit: true,
        recordInputs: true,
        recordOutputs: true,
      });
    }
  );
});
