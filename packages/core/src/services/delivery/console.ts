import type { DeliveryProvider } from "./types.ts";

/**
 * Development provider: logs instead of sending.
 *
 * Still the default, and still for the reason it always was — a misconfigured
 * environment must not be able to message real customers, and "it accidentally
 * sent" is far worse than "it accidentally didn't".
 *
 * WHAT CHANGED. It used to return `{ status: "sent" }`, and the outbox
 * consequently stamped `status = 'success', sent_at = now(), provider =
 * 'console'` on messages that had been written to a serverless stdout stream
 * and discarded (wave-1 finding H7). It now returns `simulated`, which the
 * outbox is structurally unable to record as a success: `markDelivered` is
 * reachable only from `delivered`, and `delivered` additionally requires a
 * provider message id, which this has no way to produce.
 *
 * It also no longer prints the title. A notification title in this product is
 * "Bank cheque 004412 — Fatima Al Marzooqi" or "Visa expires in 12 days —
 * Rajesh Kumar": a customer name, a document number and an inference about an
 * individual's immigration status, written to a log stream with a different
 * retention policy and a different audience from the database. The channel and
 * the notification id are enough to follow a message through the pipeline, and
 * the id joins straight back to the row that holds the rest.
 */
export const consoleProvider: DeliveryProvider = {
  name: "console",
  channels: ["in_app", "email", "sms", "whatsapp", "push"],
  async send(message) {
    console.log(
      `[outbox:${message.channel}] simulated — nothing sent (notification ${message.id})`,
    );
    return {
      outcome: "simulated",
      reason: "the console provider does not deliver — no message was sent",
    };
  },
};
