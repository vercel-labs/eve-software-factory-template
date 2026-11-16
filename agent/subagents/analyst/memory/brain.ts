import { factoryBrain } from "../../../lib/memory/brain.js";

/**
 * Read-only mount of the factory brain (`agent/lib/memory/brain.ts`). The
 * station recalls what the factory has learned about the repository; only
 * the orchestrator can write it.
 */
export default factoryBrain({ writable: false });
