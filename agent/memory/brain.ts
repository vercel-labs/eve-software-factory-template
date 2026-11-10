import { factoryBrain } from "../lib/memory/brain.js";

/**
 * The `brain` memory slot on the orchestrator: recalled every turn, written
 * through `brain__save_memory` and `brain__remove_memory` by trusted callers
 * only. See `agent/lib/memory/brain.ts`.
 */
export default factoryBrain({ writable: true });
