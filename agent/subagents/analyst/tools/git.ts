import { gitTool } from "../../../lib/github/tools.js";
import { environment } from "../sandbox.js";

/** Networked `git` for this station: fetch and pull, never push. */
export default gitTool({ environment, push: false });
