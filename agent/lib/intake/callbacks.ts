import { publicError, signCallback } from "./ticket.js";

/**
 * Status callbacks for tickets submitted through the intake API.
 *
 * @remarks
 * The channel (`agent/channels/intake.ts`) turns session events into the
 * callbacks built here. They live apart from it because eve only runs a
 * channel's event handlers inside a live session, and this is logic worth
 * exercising without one: what a receiver is told, how it is signed, and
 * what happens when the receiver is down.
 */

/** Durable per-session channel state. Plain JSON only. */
export interface IntakeState {
  callbackUrl: string | null;
  ticketId: string;
}

export interface IntakeCallback {
  /**
   * Sent as the `idempotency-key` header: the same event always has the same
   * key.
   */
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const CALLBACK_TIMEOUT_MS = 10_000;

/**
 * A turn finished: completed (with the final message), failed, or cancelled.
 */
export const turnSettledCallback = (
  sessionId: string,
  data: { error?: unknown; outcome: string; turnId: string },
  result: string | null
): IntakeCallback => ({
  key: `${sessionId}:${data.turnId}:settled`,
  payload: {
    error: publicError(data.error),
    result: data.outcome === "completed" ? result : null,
    sessionId,
    status: data.outcome,
  },
});

/**
 * The run stopped to ask something (an approval, a question, a budget
 * check).
 */
export const interactionOpenedCallback = (
  sessionId: string,
  data: {
    interactionId: string;
    request: { kind: string; prompt: string };
  }
): IntakeCallback => ({
  key: `${sessionId}:${data.interactionId}:opened`,
  payload: {
    pending: {
      interactionId: data.interactionId,
      kind: data.request.kind,
      prompt: data.request.prompt,
    },
    sessionId,
    status: "awaiting-input",
  },
});

/**
 * The session ended. Only a failure is worth a callback: a clean end was
 * already reported when its last turn settled.
 */
export const sessionEndedCallback = (
  sessionId: string,
  data: { error?: unknown; outcome: string }
): IntakeCallback | null =>
  data.outcome === "failed"
    ? {
        key: `${sessionId}:ended`,
        payload: {
          error: publicError(data.error),
          sessionId,
          status: "failed",
        },
      }
    : null;

/**
 * POSTs a signed status update to the ticket's callback URL, when it has one.
 *
 * @remarks
 * Never throws: an unhandled error in a channel event handler would fail the
 * turn, and a lost callback must not. `GET /intake/v1/tickets/:ticketId`
 * stays the source of truth. Callbacks are only sent when
 * `FACTORY_INTAKE_CALLBACK_SECRET` is set, so a receiver can always verify
 * the `x-factory-signature` header (hex HMAC-SHA256 of the body). The body
 * carries `sentAt`, inside what is signed, so a receiver can refuse a
 * captured callback replayed later, and the `idempotency-key` header lets it
 * drop a repeat of one it already handled. Redirects are refused: the URL
 * was checked against the allowlist, and wherever a redirect points was not.
 *
 * @param now - The clock `sentAt` is read from; injectable for tests.
 * @returns Whether a callback was sent and accepted by the network layer.
 */
export const postCallback = async (
  state: IntakeState,
  callback: IntakeCallback,
  now: () => Date = () => new Date()
): Promise<boolean> => {
  const secret = process.env.FACTORY_INTAKE_CALLBACK_SECRET;
  if (state.callbackUrl === null || !secret) {
    return false;
  }
  const body = JSON.stringify({
    ticketId: state.ticketId,
    ...callback.payload,
    sentAt: now().toISOString(),
  });
  try {
    await fetch(state.callbackUrl, {
      body,
      headers: {
        "content-type": "application/json",
        "idempotency-key": callback.key,
        "x-factory-signature": signCallback(body, secret),
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    console.warn("intake callback failed", {
      error: error instanceof Error ? error.message : String(error),
      key: callback.key,
    });
    return false;
  }
};
