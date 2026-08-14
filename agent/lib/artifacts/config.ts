/**
 * Key layout, bounds, and id handling for handoff artifacts.
 *
 * @remarks
 * A handoff artifact is a Markdown document one station produces and another reads, passed by id
 * rather than by pasting its text through the orchestrator's context. The id is the whole
 * contract, so this module owns both directions of it: {@link artifactId} builds one that is
 * readable enough to debug, and {@link artifactKey} maps it back to a Blob key while refusing
 * anything that could escape the reserved prefix.
 *
 * Ids are model-supplied on read, which is why {@link ARTIFACT_ID_PATTERN} is strict rather than
 * forgiving. Without it a caller could pass `../factory-brain/<hash>.md` and read a managed
 * document through a tool that was never meant to reach one.
 */

/**
 * Reserved Blob path prefix for handoff artifacts.
 *
 * @remarks
 * The artifact tools own this prefix exclusively. Any general-purpose Blob tool must treat it as
 * off-limits (see `isReservedArtifactPath` / `isReservedArtifactUrl`) so it can't be used as a
 * side channel to read or overwrite a handoff document: artifacts are only reachable through the
 * `save_artifact` and `read_artifact` tools, by a validated id.
 */
export const ARTIFACTS_PREFIX = "artifacts/";

/**
 * Maximum size of an artifact's Markdown body, in characters.
 *
 * @remarks
 * Generous enough for a full analysis or a long research memo, bounded so one call can't push an
 * unreasonable payload through the reader's context on the other side.
 *
 * @defaultValue 200_000
 */
export const MAX_ARTIFACT_LENGTH = 200_000;

/**
 * Maximum length of an artifact title, in characters.
 */
export const MAX_ARTIFACT_TITLE_LENGTH = 200;

/**
 * The kinds of artifact a station can save.
 *
 * @remarks
 * A closed set rather than free text: the kind travels with the id into another station's
 * message, and a reader that knows it is holding an `analysis` treats it differently from
 * `research-notes`. Add a kind here when a new handoff shape appears rather than letting callers
 * invent one.
 */
export const ARTIFACT_KINDS = ["research-notes", "analysis"] as const;

/**
 * Characters allowed in the slug portion of an artifact id.
 */
const SLUG_DISALLOWED = /[^a-z0-9]+/g;
const SLUG_TRIM = /^-+|-+$/g;

/**
 * Shape every artifact id must match: `<kind>-<slug>-<suffix>`, lowercase and hyphenated.
 *
 * @remarks
 * Anchored, with no dots or slashes permitted, so a validated id cannot traverse out of
 * {@link ARTIFACTS_PREFIX} when it is interpolated into a Blob key.
 */
export const ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Length of the random suffix appended to an artifact id.
 */
const SUFFIX_LENGTH = 6;

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Whether a Blob pathname falls under the reserved artifacts prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. `drafts/post.md`.
 * @returns `true` when the path is reserved for handoff artifacts.
 */
export const isReservedArtifactPath = (pathname: string): boolean =>
  pathname.startsWith(ARTIFACTS_PREFIX);

/**
 * Whether a Blob URL points at a reserved handoff artifact.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns `true` when the URL addresses a reserved handoff artifact.
 */
export const isReservedArtifactUrl = (url: string): boolean => {
  try {
    return isReservedArtifactPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Reduce a title to the slug portion of an id.
 *
 * @remarks
 * The length cap is applied before the trim, not after. Cutting a hyphenated slug at a fixed
 * offset regularly lands on a hyphen, and a trailing one would collide with the separator before
 * the random suffix to produce `--`, which {@link ARTIFACT_ID_PATTERN} rejects.
 *
 * @param title - Human-readable artifact title.
 * @returns A lowercase hyphenated slug, capped so ids stay readable.
 */
const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(SLUG_DISALLOWED, "-")
    .slice(0, 48)
    .replace(SLUG_TRIM, "") || "untitled";

/**
 * Build an id for a newly saved artifact.
 *
 * @remarks
 * Readable rather than opaque, because these ids show up in station messages and in logs, and
 * `analysis-dedupe-reset-emails-k3f9qz` is far easier to reason about than a bare UUID. The
 * random suffix keeps two analyses of the same work item from colliding.
 *
 * @param kind - One of {@link ARTIFACT_KINDS}.
 * @param title - Human-readable title the id is derived from.
 * @returns The artifact id.
 */
export const artifactId = (kind: string, title: string): string => {
  const suffix = Math.random()
    .toString(36)
    .slice(2, 2 + SUFFIX_LENGTH)
    .padEnd(SUFFIX_LENGTH, "0");
  return `${kind}-${slugify(title)}-${suffix}`;
};

/**
 * Map an artifact id to its Blob key.
 *
 * @remarks
 * Returns `null` for anything that fails {@link ARTIFACT_ID_PATTERN}, which is the guard that
 * keeps a model-supplied id inside the reserved namespace. Callers treat `null` as "not found"
 * rather than surfacing the distinction, so a probe learns nothing from the difference.
 *
 * @param id - Model-supplied artifact id.
 * @returns The Blob key, or `null` when the id is not a valid artifact id.
 */
export const artifactKey = (id: string): string | null =>
  ARTIFACT_ID_PATTERN.test(id) ? `${ARTIFACTS_PREFIX}${id}.md` : null;
