import { reportError } from "../../security/reporting.ts";
import { SmtpError, envelopeAddress, looksLikeEmail, sendMail, type SmtpConfig } from "./smtp.ts";
import {
  describeSafely,
  type DeliveryProvider,
  type DeliveryResult,
  type OutboundMessage,
} from "./types.ts";

/**
 * THE EMAIL PROVIDER — the one real delivery channel (FR-P03).
 *
 * Configured entirely from the environment and FAIL-CLOSED in both directions,
 * which is the requirement that shaped every branch below:
 *
 *   • With nothing configured it returns `not_configured` and says which
 *     variable is missing. It does NOT quietly fall back to the console
 *     provider. That fallback is precisely how the wave-1 defect stayed alive
 *     for a whole cycle: a pipeline that degrades to a no-op looks identical to
 *     a working one from every screen in the product.
 *   • With something configured but broken — bad credentials, a relay that
 *     offers no encryption while credentials are set — it ALSO returns
 *     `not_configured` rather than `transient_failure`, because those faults
 *     reject every message identically and retrying them per-message drains the
 *     queue's whole retry budget in an afternoon while telling nobody why.
 *
 * TWO LAYERS OF RETRY, deliberately, and they cover different failures.
 *
 *   In-process (here): a TCP reset, a greylisting 421, a relay restarting.
 *   Seconds apart, three attempts, exponential with jitter. These resolve
 *   themselves inside one dispatch and a cross-cycle retry would be absurdly
 *   slow for them — the cron is DAILY on the current plan (see the schedule
 *   note in the cron route), so "retry next cycle" means "retry tomorrow".
 *
 *   Cross-cycle (the outbox): a relay that is down for an hour, a mailbox over
 *   quota. Minutes to a day apart, bounded by MAX_ATTEMPTS, and durable across
 *   a process restart because the state is a row and not a variable.
 *
 * A PERMANENT failure short-circuits both. "550 no such user" is a verdict, and
 * asking again nine times over two days does not change it — it just hides the
 * relay's real outages behind a wall of known-dead addresses.
 *
 * PII. Nothing here logs a body, a subject or an address: `describeSafely`
 * scrubs every message that leaves, the SMTP trace records verbs and reply
 * codes only, and the address is passed to `reportError` as a boolean
 * ("hasAddress") rather than a value.
 */

/** In-process attempts before the message is handed back to the outbox. */
const IN_PROCESS_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

export interface EmailProviderOptions {
  smtp: SmtpConfig;
  /** `Nexus ERP <no-reply@example.ae>` — display name optional. */
  from: string;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so tests do not open sockets. */
  transport?: typeof sendMail;
}

/** Backoff with full jitter, so a relay recovering does not meet a thundering herd. */
function backoffMs(attempt: number): number {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.floor(Math.random() * ceiling);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createEmailProvider(opts: EmailProviderOptions): DeliveryProvider {
  const send = opts.transport ?? sendMail;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    name: "smtp",
    channels: ["email"],

    async send(message: OutboundMessage): Promise<DeliveryResult> {
      if (message.channel !== "email") {
        return {
          outcome: "not_configured",
          reason: `no provider is configured for the ${message.channel} channel`,
        };
      }
      const to = message.address ? envelopeAddress(message.address) : "";
      if (!to || !looksLikeEmail(to)) {
        // Contactability is normally settled by the outbox before a provider is
        // consulted, so reaching here means the stored address is malformed
        // rather than missing. Permanent: no number of retries fixes a typo.
        return { outcome: "permanent_failure", reason: "recipient address is not a valid mailbox" };
      }

      let last: SmtpError | null = null;

      for (let attempt = 1; attempt <= IN_PROCESS_ATTEMPTS; attempt++) {
        try {
          const { queueId } = await send(opts.smtp, {
            from: opts.from,
            to,
            subject: message.title,
            text: message.body ?? message.title,
          });
          return { outcome: "delivered", providerMessageId: queueId };
        } catch (err) {
          const smtp =
            err instanceof SmtpError
              ? err
              : new SmtpError(describeSafely(err), "transient");
          last = smtp;

          if (smtp.kind === "permanent") {
            return { outcome: "permanent_failure", reason: describeSafely(smtp.message) };
          }
          if (smtp.kind === "configuration") {
            // Loud, because nothing downstream will be. The outbox records the
            // reason on the row; this is what reaches the error sink and the
            // on-call channel.
            reportError(smtp, "delivery/email", {
              provider: "smtp",
              host: opts.smtp.host,
              port: opts.smtp.port,
            });
            return { outcome: "not_configured", reason: describeSafely(smtp.message) };
          }
          if (attempt < IN_PROCESS_ATTEMPTS) await sleep(backoffMs(attempt));
        }
      }

      return {
        outcome: "transient_failure",
        reason: `${describeSafely(last?.message ?? "delivery failed")} (after ${IN_PROCESS_ATTEMPTS} attempts)`,
      };
    },
  };
}

export interface EmailEnvIssue {
  key: string;
  message: string;
}

/**
 * Read the SMTP configuration out of the environment, or say exactly what is
 * missing.
 *
 * Returning the problems rather than throwing is what lets `resolveProvider`
 * put the missing variable NAME on every affected notification row and into the
 * cron's failure message. "Delivery is not configured" sends an operator
 * hunting; "SMTP_HOST is not set" does not.
 *
 * Secret values are never echoed — only key names — because this text lands in
 * `notifications.error`, which the in-app inbox renders.
 */
export function readEmailEnv(env: NodeJS.ProcessEnv = process.env): {
  config: EmailProviderOptions | null;
  issues: EmailEnvIssue[];
} {
  const issues: EmailEnvIssue[] = [];
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();

  if (!host) issues.push({ key: "SMTP_HOST", message: "SMTP_HOST is not set" });
  if (!from) issues.push({ key: "SMTP_FROM", message: "SMTP_FROM is not set" });
  else if (!looksLikeEmail(envelopeAddress(from))) {
    issues.push({ key: "SMTP_FROM", message: "SMTP_FROM is not a valid mailbox" });
  }

  const secure = env.SMTP_SECURE === "true";
  const port = Number(env.SMTP_PORT ?? (secure ? 465 : 587)); // money-guard-ignore: a TCP port, not an amount.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push({ key: "SMTP_PORT", message: "SMTP_PORT is not a valid port number" });
  }

  const user = env.SMTP_USER?.trim() || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  if (user && !password) {
    issues.push({ key: "SMTP_PASSWORD", message: "SMTP_USER is set but SMTP_PASSWORD is not" });
  }

  /**
   * The insecure escape hatches are for a local catcher and are refused in
   * production outright, not merely warned about.
   *
   * `TRUST_PROXY=false` shipped as a default in this codebase once and was
   * wrong in the unsafe direction for months. A variable whose only correct
   * value is "unset in production" needs the code to enforce that, because the
   * variable itself will eventually be copied into a Vercel project by someone
   * debugging at midnight.
   */
  const production = env.NODE_ENV === "production";
  const wantsInsecure = env.SMTP_ALLOW_INSECURE === "true";
  if (production && wantsInsecure) {
    issues.push({
      key: "SMTP_ALLOW_INSECURE",
      message: "SMTP_ALLOW_INSECURE must not be set in production",
    });
  }

  if (issues.length > 0) return { config: null, issues };

  return {
    config: {
      from: from!,
      smtp: {
        host: host!,
        port,
        secure,
        user,
        password,
        clientName: env.SMTP_CLIENT_NAME?.trim() || "nexus-erp",
        allowInsecureAuth: wantsInsecure && !production,
        allowSelfSigned: wantsInsecure && !production,
        // A socket deadline in milliseconds.
        timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 15_000), // money-guard-ignore: milliseconds, not an amount.
      },
    },
    issues: [],
  };
}
