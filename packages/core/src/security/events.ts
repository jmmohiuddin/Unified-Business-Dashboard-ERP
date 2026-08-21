/**
 * SECURITY EVENT STREAM.
 *
 * Separate from the business audit log, which records *what changed*. This
 * records *what was attempted* — including the things that failed, which is
 * precisely where an attack shows up first. A successful login is unremarkable;
 * forty failed ones followed by a success is the whole story.
 *
 * Emitted as structured JSON on stdout so any log shipper (CloudWatch, Loki,
 * Datadog) can ingest it without an agent or a vendor SDK in the application.
 * The alert hook is a plain function so wiring PagerDuty or a Slack webhook is
 * one implementation, not a refactor.
 */

export type SecurityEventKind =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.login.throttled"
  | "auth.lockout"
  | "auth.mfa.challenge"
  | "auth.mfa.failure"
  | "auth.mfa.recovery_used"
  | "auth.logout"
  | "session.revoked"
  | "authz.denied"
  | "tenant.cross_access_attempt"
  | "pii.decrypted"
  | "pii.key_rotated"
  | "data.exported"
  | "data.erased"
  | "config.problem";

export type Severity = "info" | "notice" | "warning" | "critical";

export interface SecurityEvent {
  kind: SecurityEventKind;
  severity: Severity;
  at: string;
  tenantId?: string;
  userId?: string;
  actorRole?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** Free-form context. Redacted before it leaves this module. */
  detail?: Record<string, unknown>;
}

/** Events that should page someone rather than sit in a log. */
const ALERTABLE: SecurityEventKind[] = [
  "auth.lockout",
  "tenant.cross_access_attempt",
  "auth.mfa.recovery_used",
  "data.erased",
  "pii.key_rotated",
];

export type AlertSink = (event: SecurityEvent) => void | Promise<void>;

let alertSink: AlertSink | null = null;

/** Wire a pager here. Left unset, alertable events still reach the log. */
export function setAlertSink(sink: AlertSink | null): void {
  alertSink = sink;
}

/**
 * Redaction.
 *
 * A security log that leaks the credentials it is reporting on is worse than no
 * log, because it concentrates them in a system that is usually less protected
 * than the database. Emails are partially masked — enough to correlate events
 * for the same account without publishing the address in plaintext.
 */
const SENSITIVE_KEYS =
  /pass|secret|token|hash|cookie|authorization|iban|emirates|passport|national|card|cvv|otp|code/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Anything envelope-shaped is ciphertext; never echo it.
    return value.startsWith("p1.") || value.startsWith("$argon2") ? "[redacted]" : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "[redacted]";
    } else if (k === "email" && typeof v === "string") {
      out[k] = maskEmail(v);
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[redacted]";
  const head = local.slice(0, 2);
  return `${head}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * Emit an event.
 *
 * Never throws. A logging failure must not take down the operation being
 * logged — the alternative is a log bug that becomes an availability incident.
 */
export function securityEvent(event: Omit<SecurityEvent, "at">): void {
  const full: SecurityEvent = {
    ...event,
    at: new Date().toISOString(),
    detail: event.detail ? (redact(event.detail) as Record<string, unknown>) : undefined,
  };

  try {
    // One JSON object per line — the format every log shipper parses natively.
    const line = JSON.stringify({ log: "security", ...full });
    if (full.severity === "critical" || full.severity === "warning") {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    console.error(JSON.stringify({ log: "security", kind: full.kind, at: full.at }));
  }

  if (alertSink && (ALERTABLE.includes(full.kind) || full.severity === "critical")) {
    try {
      // `void` alone catches only a synchronous throw. An AlertSink may return a
      // promise — every realistic one posts to a webhook — and a rejected
      // promise escaping here is an unhandled rejection, which on Node 18+
      // terminates the process by default. The alerting outage would then take
      // down the very thing it was watching. Adopt the promise and swallow it.
      Promise.resolve(alertSink(full)).catch(() => {});
    } catch {
      // An alerting outage must not break authentication.
    }
  }
}

/** Convenience wrappers so call sites read as prose. */
export const security = {
  loginSuccess: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.login.success", severity: "info" }),
  loginFailure: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.login.failure", severity: "notice" }),
  throttled: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.login.throttled", severity: "warning" }),
  lockout: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.lockout", severity: "critical" }),
  mfaFailure: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.mfa.failure", severity: "warning" }),
  recoveryUsed: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "auth.mfa.recovery_used", severity: "critical" }),
  denied: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "authz.denied", severity: "warning" }),
  crossTenant: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "tenant.cross_access_attempt", severity: "critical" }),
  piiDecrypted: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "pii.decrypted", severity: "notice" }),
  exported: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "data.exported", severity: "warning" }),
  erased: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "data.erased", severity: "critical" }),
  /**
   * A control could not be verified at runtime.
   *
   * Critical on purpose, so it reaches the alert sink: the boot probes fail
   * *open* on an indeterminate result rather than refusing to serve traffic on
   * a network blip, and this event is what stops that from being silent.
   */
  configProblem: (d: Omit<SecurityEvent, "at" | "kind" | "severity">) =>
    securityEvent({ ...d, kind: "config.problem", severity: "critical" }),
};
