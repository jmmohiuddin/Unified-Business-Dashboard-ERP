import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";

/**
 * OUTBOUND MESSAGE DELIVERY.
 *
 * Built before any provider is connected, and that ordering is deliberate.
 * Bolting consent and suppression onto a pipeline that already sends is how
 * businesses end up messaging people who asked them to stop — and in the UAE
 * that is a TDRA matter, not just a bad look.
 *
 * The gates a message passes before it can leave, in order:
 *
 *   1. CONSENT — hard opt-out blocks everything; marketing additionally needs
 *      an affirmative opt-in. Transactional (your invoice, your appointment)
 *      is permitted unless explicitly withdrawn.
 *   2. QUIET HOURS — nothing non-critical between 21:00 and 08:00 Gulf time.
 *      A rent reminder at 3am costs goodwill and gains nothing.
 *   3. CONTACTABILITY — a missing phone number is a suppression, not a failure.
 *   4. RETRY BUDGET — bounded attempts with backoff, so a provider outage
 *      cannot become a thousand-message replay when it recovers.
 *
 * A suppressed message is recorded as suppressed, never as failed. Conflating
 * the two hides real delivery problems behind a wall of expected skips.
 */

export type DeliveryChannel = "in_app" | "email" | "sms" | "whatsapp" | "push";

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
  status: "sent" | "suppressed" | "failed";
  providerMessageId?: string;
  reason?: string;
}

/** A provider implementation. Swap in Twilio/Unifonic/SES behind this. */
export interface DeliveryProvider {
  name: string;
  channels: DeliveryChannel[];
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/**
 * Development provider: logs instead of sending.
 *
 * The default, on purpose. A misconfigured environment must not be able to
 * message real customers — the failure mode of "it accidentally sent" is far
 * worse than "it accidentally didn't".
 */
export const consoleProvider: DeliveryProvider = {
  name: "console",
  channels: ["in_app", "email", "sms", "whatsapp", "push"],
  async send(message) {
    console.log(
      `[outbox:${message.channel}] → ${message.address ?? "in-app"} :: ${message.title}`,
    );
    return { status: "sent", providerMessageId: `console-${message.id}` };
  },
};

const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 8;
const MAX_ATTEMPTS = 5;

/** Gulf Standard Time is UTC+4 with no daylight saving, so this is exact. */
function gulfHour(now: Date): number {
  return (now.getUTCHours() + 4) % 24;
}

export function inQuietHours(now: Date): boolean {
  const h = gulfHour(now);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** Exponential backoff: 1, 4, 9, 16 minutes. */
function nextAttemptDelayMinutes(attempts: number): number {
  return Math.min(60, attempts * attempts);
}

export interface DispatchOptions {
  /** Actually hand messages to the provider. Default false. */
  commit?: boolean;
  provider?: DeliveryProvider;
  now?: Date;
  limit?: number;
}

export interface DispatchSummary {
  considered: number;
  sent: number;
  suppressed: number;
  failed: number;
  deferred: number;
  detail: { id: string; title: string; outcome: string; reason?: string }[];
}

export async function dispatchOutbox(
  tx: Tx,
  opts: DispatchOptions = {},
): Promise<DispatchSummary> {
  const { commit = false, provider = consoleProvider, now = new Date(), limit = 200 } = opts;

  const pending = await tx.execute<{
    id: string; channel: DeliveryChannel; recipient_address: string | null;
    recipient_party_id: string | null; title: string; body: string | null;
    severity: string; is_marketing: boolean; attempts: number;
    allows_transactional: boolean | null; allows_marketing: boolean | null;
    opted_out_at: string | null; party_phone: string | null; party_email: string | null;
  }>(sql`
    SELECT n.id, n.channel, n.recipient_address, n.recipient_party_id, n.title, n.body,
           n.severity::text, n.is_marketing, n.attempts,
           c.allows_transactional, c.allows_marketing, c.opted_out_at::text,
           p.primary_phone AS party_phone, p.email AS party_email
      FROM notifications n
      LEFT JOIN parties p ON p.id = n.recipient_party_id
      LEFT JOIN communication_consents c
             ON c.party_id = n.recipient_party_id AND c.channel = n.channel
     WHERE n.status = 'pending'
       AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ${now.toISOString()}::timestamptz)
       AND n.attempts < ${MAX_ATTEMPTS}
     ORDER BY
       CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       n.created_at
     LIMIT ${limit}
  `);

  const summary: DispatchSummary = {
    considered: pending.length, sent: 0, suppressed: 0, failed: 0, deferred: 0, detail: [],
  };

  const quiet = inQuietHours(now);

  for (const n of pending) {
    const isCustomerFacing = n.recipient_party_id !== null && n.channel !== "in_app";

    // ── Gate 1: consent ───────────────────────────────────────────────────
    let suppression: string | null = null;
    if (isCustomerFacing) {
      if (n.opted_out_at) suppression = "recipient has opted out";
      else if (n.is_marketing && n.allows_marketing !== true) {
        suppression = "no marketing opt-in";
      } else if (!n.is_marketing && n.allows_transactional === false) {
        suppression = "transactional messages withdrawn";
      }
    }

    // ── Gate 2: quiet hours ───────────────────────────────────────────────
    if (!suppression && isCustomerFacing && quiet && n.severity !== "critical") {
      // Deferred, not suppressed — it goes out in the morning.
      if (commit) {
        const resume = new Date(now);
        resume.setUTCHours(QUIET_END_HOUR - 4, 5, 0, 0); // 08:05 Gulf
        if (resume <= now) resume.setUTCDate(resume.getUTCDate() + 1);
        await tx.execute(sql`
          UPDATE notifications SET next_attempt_at = ${resume.toISOString()}::timestamptz
           WHERE id = ${n.id}::uuid
        `);
      }
      summary.deferred++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "deferred", reason: "quiet hours" });
      continue;
    }

    // ── Gate 3: contactability ────────────────────────────────────────────
    const address =
      n.recipient_address ??
      (n.channel === "email" ? n.party_email
        : n.channel === "sms" || n.channel === "whatsapp" ? n.party_phone
        : null);
    if (!suppression && n.channel !== "in_app" && !address) {
      suppression = `no ${n.channel} address on file`;
    }

    if (suppression) {
      if (commit) {
        await tx.execute(sql`
          UPDATE notifications
             SET status = 'skipped', suppressed_reason = ${suppression}, updated_at = now()
           WHERE id = ${n.id}::uuid
        `);
      }
      summary.suppressed++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "suppressed", reason: suppression });
      continue;
    }

    if (!commit) {
      summary.sent++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "would send" });
      continue;
    }

    // ── Deliver ───────────────────────────────────────────────────────────
    let result: DeliveryResult;
    try {
      result = await provider.send({
        id: n.id, channel: n.channel, address, title: n.title, body: n.body,
        severity: n.severity, isMarketing: n.is_marketing, partyId: n.recipient_party_id,
      });
    } catch (err) {
      result = { status: "failed", reason: (err as Error).message };
    }

    if (result.status === "sent") {
      await tx.execute(sql`
        UPDATE notifications
           SET status = 'success', sent_at = now(), attempts = attempts + 1,
               provider = ${provider.name}, provider_message_id = ${result.providerMessageId ?? null},
               error = NULL, updated_at = now()
         WHERE id = ${n.id}::uuid
      `);
      summary.sent++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "sent" });
    } else {
      const attempts = n.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const retryAt = new Date(+now + nextAttemptDelayMinutes(attempts) * 60_000);
      await tx.execute(sql`
        UPDATE notifications
           SET status = ${exhausted ? "failed" : "pending"}::run_status,
               attempts = ${attempts},
               next_attempt_at = ${exhausted ? null : retryAt.toISOString()}::timestamptz,
               error = ${result.reason ?? "delivery failed"}, updated_at = now()
         WHERE id = ${n.id}::uuid
      `);
      summary.failed++;
      summary.detail.push({
        id: n.id, title: n.title,
        outcome: exhausted ? "failed (giving up)" : "failed (will retry)",
        reason: result.reason,
      });
    }
  }

  return summary;
}

/** Record an opt-out. The one write that must never be hard to perform. */
export async function recordOptOut(
  tx: Tx,
  tenantId: string,
  partyId: string,
  channel: DeliveryChannel,
  reason?: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO communication_consents
      (id, tenant_id, party_id, channel, allows_transactional, allows_marketing,
       opted_out_at, opted_out_reason, source)
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, ${partyId}::uuid, ${channel}::notification_channel,
       false, false, now(), ${reason ?? "requested"}, 'user_request')
    ON CONFLICT (party_id, channel) DO UPDATE
      SET allows_transactional = false, allows_marketing = false,
          opted_out_at = now(), opted_out_reason = EXCLUDED.opted_out_reason,
          updated_at = now()
  `);
}
