// One place to change every agent's model. Ids are Vercel AI Gateway strings
// (<provider>/<model>), so routing, credentials, and fallbacks stay on the
// gateway and no provider SDK is wired in. Each agent.ts reads its entry
// here (model: MODELS.<agent>) instead of hardcoding a string.
export const MODELS = {
  analyst: "openai/gpt-6.1-terra-fast",
  classifier: "openai/gpt-6.1-terra-fast",
  decision: "google/gemini-decision-1",
  implementer: "anthropic/claude-fable-5.2",
  orchestrator: "anthropic/claude-opus-5.5-fast",
  researcher: "anthropic/claude-opus-5.5",
  reviewer: "openai/gpt-6.1-sol-fast",
} as const;

export type FactoryModel = keyof typeof MODELS;
export type FactoryAgent = Exclude<FactoryModel, "decision">;
