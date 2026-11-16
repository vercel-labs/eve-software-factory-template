import { get, put } from "@vercel/blob";

/**
 * The factory's Blob layer: where handoff artifacts live, and the helpers
 * that read and write them.
 *
 * @remarks
 * The store is private and holds handoff artifacts only. Memory does not go
 * through this module: user preferences and the factory brain are eve
 * memory slots (`agent/memory/`), stored by eve's own file-memory backend.
 *
 * The helpers carry the store's posture (private access, exact pathnames,
 * Markdown) in one place. They stay neutral about errors: API failures
 * propagate, and each tool maps them to its own output shape.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */

/** Blob path prefix holding handoff artifacts passed between stations. */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * Read a Markdown document from the store by its exact key.
 *
 * @remarks
 * Reads through the authenticated `get` path rather than listing and
 * fetching a public URL, so one call resolves both existence and content. A
 * missing document is a normal state (`found: false`), not an error.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @returns The document `content` and `uploadedAt` (ISO string) when found.
 * @throws When the Blob API call fails; the caller maps it onto its own
 * output shape.
 */
export const readDocument = async (
  key: string
): Promise<
  { found: false } | { content: string; found: true; uploadedAt: string }
> => {
  const result = await get(key, { access: "private" });
  if (!result?.stream) {
    return { found: false };
  }
  return {
    content: await new Response(result.stream).text(),
    found: true,
    uploadedAt: result.blob.uploadedAt.toISOString(),
  };
};

/**
 * Write a Markdown document to the store at its exact key.
 *
 * @remarks
 * Carries the store's shared write posture: private access (the store is
 * provisioned private, so a document is read only with the project's
 * credentials, never by its URL), no random suffix (the key is the
 * identity), Markdown content type. Overwrite is the caller's decision: handoff
 * artifacts are write-once.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @returns The stored blob's metadata.
 */
export const writeDocument = (
  key: string,
  contents: string,
  options: { allowOverwrite: boolean }
) =>
  put(key, contents, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite,
    contentType: "text/markdown",
  });
