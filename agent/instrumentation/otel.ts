import { otel } from "eve/instrumentation/otel";

/**
 * Process-wide OpenTelemetry settings: every session's prompts, tool
 * arguments, and responses are recorded, whatever its audience.
 *
 * @remarks
 * eve's default records content for public conversations only. A session
 * that starts from a private repository is a private one, so by default
 * Vercel Agent Runs shows its spans with nothing in them, and the session's
 * stored run data is deleted when the run ends. A factory's runs are how
 * its operator sees what it did and why, so content is recorded for every
 * session, and run data is kept for the default period with it.
 *
 * The cost is where that content then lives: Agent Runs holds the issue
 * text, the code excerpts, and the model's output from a private
 * repository, for as long as traces are retained. A deployment that should
 * not send those there narrows this policy, or deletes this file to go
 * back to eve's default.
 */
export default otel({
  resource: {
    "deployment.environment": process.env.VERCEL_ENV ?? "development",
  },
  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  }),
});
