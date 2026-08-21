/**
 * DELIVERY PROVIDERS.
 *
 * One module per channel behind one `DeliveryProvider` interface, plus the
 * registry that decides which of them (if any) is configured, plus the kill
 * switch that can stop all of them at once.
 *
 * The outbox above this boundary owns consent, quiet hours, contactability,
 * caps, approval and retry state. A provider owns exactly one thing: getting
 * one message to one address, and telling the truth about whether it did.
 * Nothing in here reads the database and nothing in here decides whether a
 * message SHOULD be sent — both of those belong to `outbox.ts`, and a provider
 * that could make either call would be a second, unreviewed copy of a control.
 */
export * from "./types.ts";
export * from "./console.ts";
export * from "./email.ts";
export * from "./registry.ts";
export {
  SmtpError,
  buildMessage,
  envelopeAddress,
  looksLikeEmail,
  sendMail,
  type SmtpConfig,
  type SmtpEnvelope,
  type SmtpFailureKind,
} from "./smtp.ts";
