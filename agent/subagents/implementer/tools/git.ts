import { gitTool } from "../../../lib/github/tools.js";
import { environment } from "../sandbox.js";

/**
 * Networked `git` for the implementer, the one station that pushes. Feature
 * branches only: `main` and `master` are refused by name.
 */
export default gitTool({ environment, push: true });
