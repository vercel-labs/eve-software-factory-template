import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The intake API's ticket contract and the pure helpers around it.
 *
 * @remarks
 * Kept apart from the channel (`agent/channels/intake.ts`) so the contract,
 * the id derivation, and the callback signature can be tested without a
 * running agent.
 */

/** Largest request body the intake endpoint reads. */
export const MAX_TICKET_BYTES = 64 * 1024;

/** Shortest shared secret the intake endpoint accepts as configured. */
export const MIN_INTAKE_TOKEN_LENGTH = 32;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const SINGLE_LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]*$/;

/**
 * A single-line ticket field of at most `max` characters.
 *
 * @remarks
 * Every field except `body` is a single line. Each one is rendered on a line
 * of its own in the session's first message, so a line break inside, say,
 * `source` would let a submitter write what looks like another field (a
 * requester without its "unverified" label).
 */
const singleLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(SINGLE_LINE, "must be a single line with no control characters");

/**
 * A work item submitted over HTTP. Strict: an unknown field is a 400, so a
 * caller finds out about a typo instead of having it silently dropped, and no
 * field can smuggle in something the handler never looked at.
 */
export const ticketSchema = z.strictObject({
  body: z.string().min(1).max(20_000),
  callbackUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  externalId: singleLine(200).optional(),
  labels: z.array(singleLine(50)).max(20).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  requester: singleLine(200).optional(),
  source: singleLine(100).optional(),
  title: singleLine(300),
});

export type Ticket = z.infer<typeof ticketSchema>;

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/**
 * Compares a presented secret with the configured one in constant time.
 *
 * @remarks
 * Both sides are hashed first, so the comparison never depends on either
 * string's length. An unset or too-short configured secret never matches:
 * a deployment that forgot to set one must not accept an empty bearer.
 */
export const secretMatches = (
  presented: string,
  configured: string | undefined
): boolean =>
  typeof configured === "string" &&
  configured.length >= MIN_INTAKE_TOKEN_LENGTH &&
  timingSafeEqual(sha256(presented), sha256(configured));

export const TICKET_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The ticket's id.
 *
 * @remarks
 * With an `externalId` it is a digest of the verified caller and that id, so
 * the same caller resubmitting the same ticket lands on the same id (and the
 * same session), while two callers can never collide or guess each other's.
 * The pair is hashed as JSON, not joined with a separator, so no choice of
 * caller id and external id can be read back as a different pair.
 * Without an `externalId` the id is random and every submission is a new
 * ticket.
 */
export const ticketIdFor = (
  callerId: string,
  externalId: string | undefined
): string =>
  externalId === undefined
    ? crypto.randomUUID().replaceAll("-", "")
    : sha256(JSON.stringify([callerId, externalId]))
        .toString("hex")
        .slice(0, 32);

/**
 * The channel address a ticket's session lives at.
 *
 * @remarks
 * The address carries a digest of the verified caller next to the ticket id,
 * so a ticket can only be found by the caller that submitted it. An id with
 * an `externalId` behind it is derived, not secret; without the caller in the
 * address, anyone holding a different valid credential who could guess a
 * support system's ticket number could read that ticket's status and result.
 */
export const ticketAddress = (ticketId: string, callerId: string): string =>
  `ticket:${sha256(callerId).toString("hex").slice(0, 16)}:${ticketId}`;

/**
 * Renders the ticket as the session's first message.
 *
 * @remarks
 * Everything here is untrusted text from the submitter. The requester is
 * labeled as unverified so the orchestrator never treats the name as an
 * identity.
 */
export const renderTicket = (ticket: Ticket): string => {
  const meta = [
    ticket.source && `Source: ${ticket.source}`,
    ticket.externalId && `External id: ${ticket.externalId}`,
    ticket.requester && `Requester (unverified): ${ticket.requester}`,
    ticket.priority && `Submitter's priority: ${ticket.priority}`,
    ticket.labels?.length && `Submitter's labels: ${ticket.labels.join(", ")}`,
  ].filter((line): line is string => typeof line === "string");
  return [`# ${ticket.title}`, ...meta, "", ticket.body].join("\n");
};

/**
 * Returns the callback URL when its host is on the allowlist, else null.
 *
 * @remarks
 * A caller-supplied URL the server will POST to is a request-forgery vector,
 * so callbacks only go to hosts the deployer listed in
 * `FACTORY_INTAKE_CALLBACK_HOSTS` (comma-separated). An entry is a host
 * name, which allows any port on that host, or `host:port`, which allows
 * that port only. Matching is exact: no wildcards and no subdomains.
 */
export const allowedCallback = (
  url: string | undefined,
  allowlist: string | undefined
): string | null => {
  if (url === undefined) {
    return null;
  }
  const hosts = (allowlist ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const withPort = `${hostname}:${parsed.port || "443"}`;
  return hosts.includes(hostname) || hosts.includes(withPort) ? url : null;
};

/** Hex HMAC-SHA256 of a callback body, sent as `x-factory-signature`. */
export const signCallback = (body: string, secret: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Verifies a callback signature; exported so receivers can reuse it.
 *
 * @remarks
 * The signature's shape is checked before it is decoded. Decoding hex is
 * lenient (it stops at the first character that isn't hex and drops a
 * trailing half byte), so without the check a valid signature followed by
 * anything at all would still verify.
 */
export const verifyCallback = (
  body: string,
  signature: string,
  secret: string
): boolean => {
  if (!SIGNATURE_PATTERN.test(signature)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(signCallback(body, secret), "hex")
  );
};

/**
 * Reduces a run failure to what an API caller should see: a stable code and
 * the id to quote when asking for the server-side log entry.
 *
 * @remarks
 * The runtime's own message is left out on purpose. It is written for the
 * operator, and can name internals (storage configuration, connector ids,
 * file paths) that the system submitting tickets has no business reading.
 */
export const publicError = (
  error: unknown
): { code: string; id: string | null } | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { code, id } = error as { code?: unknown; id?: unknown };
  return {
    code: typeof code === "string" ? code : "RUN_FAILED",
    id: typeof id === "string" ? id : null,
  };
};

/**
 * Reads a request body as text, giving up as soon as it exceeds `maxBytes`.
 *
 * @remarks
 * `request.text()` would buffer whatever the caller sends before any size
 * check could run. This refuses on a declared `content-length` over the
 * limit without reading at all, and otherwise reads chunk by chunk and stops
 * at the limit, so the bound holds for a caller that lies about the length
 * or sends none.
 *
 * @returns The body, or null when it is larger than `maxBytes`.
 */
export const readLimitedText = async (
  request: Request,
  maxBytes: number
): Promise<string | null> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: a stream is read one chunk at a time
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};
