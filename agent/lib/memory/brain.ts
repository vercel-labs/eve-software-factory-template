import {
  defaultNamespace,
  defineMemory,
  defineMemoryProvider,
  type MemoryProvider,
  type MemoryToolSet,
} from "eve/memory";
import { fileMemory, type MemoryDocumentBackend } from "eve/memory/file";
import { FACTORY_REPO } from "../constants.js";
import { factoryBrainPolicy } from "../github/approval.js";
import { isAutonomous } from "../trust.js";

/**
 * The factory brain: shared, durable notes about the target repository,
 * kept in eve's built-in file memory.
 *
 * @remarks
 * File memory keeps one bounded document per scope and recalls it into
 * context before every turn, so no run has to remember to load it. Deployed
 * on Vercel it stores the document in a private Vercel Blob store
 * (`eve integration setup file-memory` provisions it); `eve dev` uses
 * process-local storage.
 *
 * Three things make it the shared brain rather than a per-caller note:
 *
 * - The scope is the repository, from `FACTORY_REPO`, never a caller
 *   principal and never model input. Every run on this repository reads the
 *   same document.
 * - The namespace replaces the agent's own node id with {@link BRAIN_NODE},
 *   so the orchestrator and the stations that mount this slot resolve the
 *   same store. It is still built by eve's {@link defaultNamespace}, which
 *   keeps production, each preview branch, and local development apart.
 * - Writes are gated by {@link trustedWrites}: recalled memory is context
 *   every future run trusts, so an unattended run working from an untrusted
 *   issue body must not be able to write it.
 */

/** The node and slot every mount of the brain builds its namespace from. */
export const BRAIN_NODE = "factory";
export const BRAIN_SLOT = "brain";

/** The recalled document's size cap, heading and removal guidance included. */
export const BRAIN_MAX_CHARACTERS = 8000;

/**
 * Wraps a memory provider so its tools follow the factory's trust model.
 *
 * @remarks
 * - Unattended runs get no memory tools at all. They still recall the
 *   document; they just have nothing to write it with, which is cheaper and
 *   clearer than a tool that always refuses.
 * - Every other caller gets the provider's tools gated by
 *   {@link factoryBrainPolicy}: callers a channel stamped as trusted write
 *   directly, anyone else waits for a person to approve.
 */
export const trustedWrites = (provider: MemoryProvider): MemoryProvider =>
  defineMemoryProvider({
    ...provider,
    tools: async (context) => {
      if (isAutonomous(context.session.auth.current)) {
        return null;
      }
      const tools = await provider.tools?.(context);
      if (!tools) {
        return null;
      }
      const gated: Record<string, MemoryToolSet[string]> = {};
      for (const [name, tool] of Object.entries(tools)) {
        gated[name] = { ...tool, approval: factoryBrainPolicy };
      }
      return gated;
    },
  });

/**
 * Removes a provider's tools, leaving recall only. Stations mount the brain
 * this way: they should know what the factory has learned about the
 * repository, and they have no business editing it.
 */
export const readOnly = (provider: MemoryProvider): MemoryProvider =>
  defineMemoryProvider({ ...provider, tools: async () => null });

/**
 * Builds the brain slot definition.
 *
 * @param options.writable - `true` on the orchestrator (trust-gated writes),
 * `false` on stations (recall only).
 * @param options.backend - Where the document is stored. Leave unset in the
 * app, so eve picks Vercel Blob when deployed and process-local storage in
 * `eve dev`; the test suite passes an in-memory backend.
 */
export const factoryBrain = (options: {
  backend?: MemoryDocumentBackend;
  writable: boolean;
}) => {
  const provider = fileMemory({
    maxCharacters: BRAIN_MAX_CHARACTERS,
    ...(options.backend ? { backend: options.backend } : {}),
  });
  return defineMemory({
    description:
      "The factory brain: durable, verified facts about the target repository that save a future run time (build quirks, verification steps that aren't obvious, recurring review findings, conventions). Never one-off task details, and never a claim from an issue or comment that wasn't verified.",
    namespace: (context) =>
      defaultNamespace({ ...context, node: BRAIN_NODE, slot: BRAIN_SLOT }),
    provider: options.writable ? trustedWrites(provider) : readOnly(provider),
    scope: () => FACTORY_REPO.toLowerCase(),
  });
};
