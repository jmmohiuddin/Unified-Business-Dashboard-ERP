/**
 * WHAT A PROVIDER IS ALLOWED TO CLAIM.
 *
 * The wave-1 finding this file exists to make impossible: `consoleProvider`
 * returned `{ status: "sent" }`, the outbox believed it, and
 * `notifications.status` was stamped `success` with a `sent_at` for a message
 * that had been written to a serverless stdout stream and discarded. The
 * delivery log asserted a delivery that never happened, which is strictly worse
 * than having no delivery log — an operator reading it concludes the tenant was
 * told about their bounced cheque.
 *
 * The root cause was the vocabulary, not the console provider. The old result
 * type had exactly three words — sent, suppressed, failed — and NONE of them
 * meant "I am not a real sender" or "nobody has configured me". A provider with
 * nothing truthful to say has to pick the closest lie, and the closest lie was
 * `sent`.
 *
 * So the outcomes below are deliberately more numerous than a delivery
 * pipeline strictly needs, and each one exists because the outbox must take a
 * DIFFERENT action for it:
 *
 *   delivered         a remote system accepted custody of the message and
 *                     named it. This is the ONLY outcome that may produce
 *                     `status = 'success'`, and a provider must not return it
 *                     without an identifier from the far side.
 *   transient_failure the far side was there and said "not now", or was not
 *                     there at all. Retry with backoff.
 *   permanent_failure the far side was there and said "never" — no such
 *                     mailbox, message rejected. Retrying this forever is how a
 *                     queue fills with corpses and a real outage is invisible
 *                     underneath them, so it consumes the whole retry budget at
 *                     once.
 *   not_configured    there is no provider for this channel, or the one there
 *                     is cannot authenticate. NOT a message-level failure: the
 *                     message is fine and will deliver unchanged the moment an
 *                     operator fixes the environment. It must therefore NOT
 *                     burn an attempt, and it must be loud.
 *   simulated         a development provider ran and sent nothing. Same
 *                     treatment as `not_configured`, different words, because
 *                     an operator seeing "simulated" in production has a
 *                     different problem from one seeing "not configured".
 *
 * `suppressed` is absent on purpose. Consent, quiet hours and contactability
 * are decided by the outbox BEFORE a provider is consulted — a provider is
 * never in a position to know that a recipient opted out, and a provider that
 * could suppress would be a second, unreviewed copy of the consent gate.
 */

export type DeliveryChannel = "in_app" | "email" | "sms" | "whatsapp" | "push";

export type DeliveryOutcome =
  | "delivered"
  | "transient_failure"
  | "permanent_failure"
  | "not_configured"
  | "simulated";

/** Outcomes that mean the message left the building. Exactly one, by design. */
export function isDelivered(outcome: DeliveryOutcome): boolean {
  return outcome === "delivered";
}

/**
 * Outcomes that must not consume the message's retry budget.
 *
 * A five-attempt budget spent on "SMTP_HOST is unset" leaves five permanently
 * dead notifications and an environment that is now correctly configured. The
 * budget exists to bound the damage of a FLAKY provider, not to punish a
 * message for an operator's typo.
 */
export function isConfigurationFault(outcome: DeliveryOutcome): boolean {
  return outcome === "not_configured" || outcome === "simulated";
}

export interface OutboundMessage {
  id: string;
  channel: DeliveryChannel;
  address: string | null;
  title: string;
  body: string | null;
  severity: string;
  isMarketing: boolean;
  partyId: string | null;
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  /**
   * The far side's own identifier for the message — an SMTP queue id, a
   * provider message id. Required for `delivered` and refused without one by
   * `dispatchOutbox`: "it worked, I have no evidence" is the shape of the bug
   * this whole file is about.
   */
  providerMessageId?: string;
  /**
   * Why, in words safe to store and log.
   *
   * MUST NOT contain the message body or the recipient address. Providers here
   * are responsible for scrubbing before they return; `describeSafely` below
   * is the shared way to do it.
   */
  reason?: string;
}

/**
 * A provider implementation.
 *
 * `send` must not throw for an ordinary delivery failure — a thrown error is
 * treated by the outbox as a transient failure of unknown shape, which is the
 * conservative reading but loses the transient/permanent distinction that stops
 * a dead address retrying forever.
 */
export interface DeliveryProvider {
  name: string;
  channels: DeliveryChannel[];
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/**
 * The half of an error that is safe to put in `notifications.error` and in a
 * log line.
 *
 * Node's socket errors carry the host and port, an SMTP rejection quotes the
 * envelope back at you ("550 5.1.1 <fatima@example.ae>: no such user"), and
 * both end up in a column that the in-app inbox renders. Email addresses,
 * phone numbers and anything that looks like a bracketed envelope are removed
 * here rather than at each call site, because "remember to scrub" is not a
 * control.
 */
export function describeSafely(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input);
  return raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[address]")
    .replace(/<[^>\s]*>/g, "<[address]>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
