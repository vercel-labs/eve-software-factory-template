import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";

/**
 * The factory's shared Blob layer: the reserved-namespace registry and the
 * document helpers every Blob-backed tool reads and writes through.
 *
 * @remarks
 * Everything the factory stores lives in one Blob store, so the path layout
 * is a shared concern rather than a per-feature one. This module owns it:
 * the reserved prefixes, what each holds, and which tool owns it. Any
 * general-purpose Blob tool added later must consult
 * {@link reservedNamespaceForPath} / {@link reservedNamespaceForUrl} before
 * acting, so a managed document (a handoff artifact, eve's memory
 * documents) can't be reached or overwritten through a generic file
 * operation.
 *
 * Memory does not go through this module: user preferences and the factory
 * brain are eve memory slots (`agent/memory/`), stored by eve's own
 * file-memory backend. The prefixes those documents had before they became
 * slots stay reserved here, so whatever an older deployment left behind is
 * still out of reach of a generic tool.
 *
 * Feature modules import their prefix from here rather than declaring their
 * own: adding a namespace is a single edit in this file, and the guards can
 * only be complete if one module sees every prefix.
 *
 * The document helpers carry the store's shared posture (public access,
 * exact pathnames, Markdown) in one place. They stay neutral about errors:
 * API failures propagate, and each tool maps them to its own output shape.
 * Authorization resolves from the ambient Vercel OIDC credentials.
 */

/**
 * Blob path prefix eve's file memory writes under when it shares the
 * application's store (`BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN` instead of
 * the dedicated `EVE_MEMORY_BLOB` store).
 */
export const EVE_MEMORY_PREFIX = "eve/memory/";

/**
 * Legacy prefix: per-user preference files written before preferences
 * became a memory slot.
 */
export const LEGACY_USER_PREFERENCES_PREFIX = "user-preferences/";

/** Legacy prefix: the factory brain written before it became a memory slot. */
export const LEGACY_FACTORY_BRAIN_PREFIX = "factory-brain/";

/** Blob path prefix holding handoff artifacts passed between stations. */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * A Blob path prefix that a general-purpose Blob tool must not touch.
 *
 * @remarks
 * `writeTool` and `readTool` name what owns the namespace, so a guard can
 * tell the model where to go instead of only refusing.
 */
interface ReservedNamespace {
  /** Human-readable description of what the namespace holds. */
  readonly label: string;
  /** What reads it: a tool name, or a phrase naming the mechanism. */
  readonly readTool: string;
  /** What owns writes: a tool name, or a phrase naming the mechanism. */
  readonly writeTool: string;
}

/**
 * Every reserved prefix, keyed by the prefix itself.
 *
 * @remarks
 * Add a namespace here and every guard call site starts covering it, with
 * no change at the call sites.
 */
const RESERVED_NAMESPACES: Readonly<Record<string, ReservedNamespace>> = {
  [ARTIFACTS_PREFIX]: {
    label: "handoff artifacts",
    readTool: "read_artifact",
    writeTool: "save_artifact",
  },
  [EVE_MEMORY_PREFIX]: {
    label: "the agent's memory documents",
    readTool: "your recalled memory",
    writeTool:
      "the save_memory and remove_memory tools of the matching memory slot",
  },
  [LEGACY_FACTORY_BRAIN_PREFIX]: {
    label: "the factory brain from an earlier version",
    readTool: "your recalled memory",
    writeTool: "brain__save_memory",
  },
  [LEGACY_USER_PREFERENCES_PREFIX]: {
    label: "user preferences from an earlier version",
    readTool: "your recalled memory",
    writeTool: "preferences__save_memory",
  },
};

/**
 * Leading slashes, stripped from a pathname or URL path before the
 * reserved-prefix check.
 */
const LEADING_SLASHES = /^\/+/;

/**
 * Find the reserved namespace a Blob pathname falls under, if any.
 *
 * @remarks
 * Leading slashes are stripped first because `@vercel/blob`'s `put` drops
 * them, so a caller-supplied `/factory-brain/x.md` would land inside the
 * reserved namespace unless the guard sees the normalized form.
 *
 * @param pathname - A Blob object pathname, e.g. `drafts/post.md`.
 * @returns The matching namespace, or `null` when the path is not reserved.
 */
export const reservedNamespaceForPath = (
  pathname: string
): ReservedNamespace | null => {
  const normalized = pathname.replace(LEADING_SLASHES, "");
  for (const [prefix, namespace] of Object.entries(RESERVED_NAMESPACES)) {
    if (normalized.startsWith(prefix)) {
      return namespace;
    }
  }
  return null;
};

/**
 * Find the reserved namespace a Blob URL points at, if any.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path. Unparseable
 * input is treated as not reserved; the caller's own URL validation handles
 * malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns The matching namespace, or `null` when the URL is not reserved.
 */
export const reservedNamespaceForUrl = (
  url: string
): ReservedNamespace | null => {
  try {
    return reservedNamespaceForPath(new URL(url).pathname);
  } catch {
    return null;
  }
};

/**
 * Build the refusal message for a write blocked by a reserved namespace.
 *
 * @returns A message naming the owning tool, for the model to act on.
 */
export const reservedWriteMessage = (namespace: ReservedNamespace): string =>
  `That path is reserved for ${namespace.label}: use ${namespace.writeTool} instead.`;

/**
 * Build the refusal message for a read blocked by a reserved namespace.
 *
 * @returns A message naming the owning read tool.
 */
export const reservedReadMessage = (namespace: ReservedNamespace): string =>
  `That path holds ${namespace.label}: use ${namespace.readTool} instead.`;

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
  const result = await get(key, { access: "public" });
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
 * Carries the store's shared write posture: public access (the store is
 * provisioned public; unguessability comes from the suffixed keys the
 * feature modules derive), no random suffix (the key is the identity),
 * Markdown content type. Overwrite is the caller's decision: handoff
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
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite,
    contentType: "text/markdown",
  });

/**
 * Delete a document from the store by its exact key.
 *
 * @remarks
 * Checks existence first so callers can tell "deleted" from "nothing to
 * delete": `del` itself is silent about missing objects.
 *
 * @param key - The exact Blob pathname, derived by the owning feature module.
 * @returns Whether a document existed at the key (and was deleted).
 */
export const deleteDocument = async (
  key: string
): Promise<{ existed: boolean }> => {
  try {
    await head(key);
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return { existed: false };
    }
    throw error;
  }
  await del(key);
  return { existed: true };
};
