import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { userScope } from "../lib/memory/scope.js";

/**
 * The `preferences` memory slot: each signed-in user's standing preferences,
 * kept in eve's built-in file memory (a private Vercel Blob store when
 * deployed, process-local storage in `eve dev`).
 *
 * @remarks
 * The model maintains the document with `preferences__save_memory` and
 * `preferences__remove_memory`, and eve recalls it before every turn, so
 * nothing has to be loaded by hand. The scope comes from the session's
 * resolved principal, never from model input, and is `null` for anyone who is
 * not a signed-in user: an unattended run has no preferences to read and no
 * tools to write any with.
 */
export default defineMemory({
  description:
    "Standing preferences of the user you are working for, like a default base branch, how they want pull request descriptions structured, or a default Linear team. Durable preferences they stated, never one-off instructions for a single task.",
  provider: fileMemory(),
  scope: userScope,
});
