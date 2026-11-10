// One place to change every agent's model. Ids are Vercel AI Gateway strings (<provider>/<model>),
// so routing, credentials, and fallbacks stay on the gateway and no provider SDK is wired in.
// Each agent.ts reads its entry here (model: MODELS.<agent>) instead of hardcoding a string.
export const MODELS = {
  analyst: "openai/gpt-5.6-terra-fast",
  classifier: "openai/gpt-5.6-terra-fast",
  // Not an agent: the decision model behind `decide()` (agent/lib/triage/decisions.ts). It answers
  // closed questions (pick one, yes or no) in a single fast call, so mechanical judgments like
  // triage, label selection, and duplicate checks don't cost a full agent turn.
  decision: "typesafe-ai/jev",
  implementer: "anthropic/claude-fable-5", // the station that writes the code gets the strongest coding model
  orchestrator: "anthropic/claude-fable-5.2", // the main agent: routes work, checks handoffs, writes the PR
  researcher: "openai/gpt-5.6-terra-fast",
  reviewer: "openai/gpt-5.6-terra-fast", // different vendor than implementer on purpose: independent review
} as const;

export type FactoryModel = keyof typeof MODELS;
export type FactoryAgent = Exclude<FactoryModel, "decision">;
