import { factoryBrain } from "../lib/memory/brain.js";

/**
 * The `brain` memory slot on the orchestrator: recalled every turn, written
 * through `brain__save_memory` and `brain__remove_memory` under the trust
 * gate in `agent/lib/memory/brain.ts` (unattended runs get no write tools).
 */
export default factoryBrain({ writable: true });
