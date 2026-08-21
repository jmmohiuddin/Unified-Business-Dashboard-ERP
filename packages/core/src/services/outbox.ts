import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { reportError } from "../security/reporting.ts";
import { consoleProvider } from "./delivery/console.ts";
import {
  approvalThreshold,
  dailyExternalCap,
  deliveryEnabledInEnvironment,
} from "./delivery/registry.ts";
import {
  isConfigurationFault,
  type DeliveryChannel,
  type DeliveryProvider,
  type DeliveryResult,
  type OutboundMessage,
} from "./delivery/types.ts";

/**
 * OUTBOUND MESSAGE DELIVERY.
 *
 * Built before any provider was connected, and that ordering was deliberate.
 * Bolting consent and suppression onto a pipeline that already sends is how
 * businesses end up messaging people who asked them to stop — and in the UAE
 * that is a TDRA matter, not just a bad look.
 *
 * The gates a message passes before it can leave, in order:
 *
 *   1. KILL SWITCH — deployment-level (`NEXUS_DELIVERY_ENABLED`) and
 *      operational (`tenants.settings->>'delivery_paused'`). Either stops
 *      everything. See `delivery/registry.ts` for why there are two.
 *   2. CONSENT — hard opt-out blocks everything; marketing additionally needs
 *      an affirmative opt-in. Transactional (your invoice, your appointment)
 *      is permitted unless explicitly withdrawn.
 *   3. QUIET HOURS — nothing non-critical between 21:00 and 08:00 Gulf time.
 *      A rent reminder at 3am costs goodwill and gains nothing.
 *   4. CONTACTABILITY — a missing phone number is a suppression, not a failure.
 *   5. APPROVAL — a cycle about to contact more distinct people than the
 *      threshold is held until a human passes `approvedBy`.
 *   6. DAILY CAP — a ceiling on external messages per tenant per day, across
 *      every automation, independent of any rule's own cap.
 *   7. RETRY BUDGET — bounded attempts with backoff, so a provider outage
 *      cannot become a thousand-message replay when it recovers.
 *
 * A suppressed message is recorded as suppressed, never as failed. Conflating
 * the two hides real delivery problems behind a wall of expected skips.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DELIVERY LOG MUST NOT LIE. This is the wave-1 finding (H7) that shaped
 * the rewrite, and it was not a bug in the console provider — it was a bug in
 * this file's willingness to believe one. `consoleProvider` said `sent`, and
 * the code below stamped `status = 'success', sent_at = now(), provider =
 * 'console'` on a message written to a stdout stream and thrown away. An
 * operator reading that row concludes the tenant was told their cheque bounced.
 *
 * Two structural changes make the same class of defect unreachable rather than
 * merely fixed:
 *
 *   • The provider vocabulary distinguishes `delivered` from `simulated` and
 *     `not_configured` (see `delivery/types.ts`). A provider that did not send
 *     has words for that and does not have to pick the closest lie.
 *   • `success` is written in exactly ONE place, `markDelivered`, which is
 *     reachable only from `delivered` AND only with a provider message id.
 *     "It worked, I have no evidence" cannot produce a `sent_at`.
 *
 * A configuration fault — nothing configured, credentials rejected — leaves the
 * message `pending` and does NOT consume an attempt. The retry budget bounds
 * the damage of a FLAKY provider; spending it on an unset environment variable
 * leaves five permanently dead notifications and a correctly configured relay.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * TRANSACTION BOUNDARY (audit finding M6). `provider.send` used to be called
 * inside the caller's transaction, so a real SMTP handshake would hold one
 * Postgres connection open across up to two hundred sequential network round
 * trips, and a failure late in the batch rolled back the status updates of
 * everything already delivered — which the next run then sent again.
 *
 * `runOutboxCycle` splits it into three: CLAIM in a transaction, DELIVER with
 * no transaction held, RECORD in a second transaction. `dispatchOutbox` keeps
 * the old single-transaction signature by passing the same `tx` to all three
 * phases, so existing callers still compile and behave identically — but a
 * production sweep should call `runOutboxCycle`. See the note on `dispatchOutbox`.
 *
 * The claim is what makes the split safe: it sets `status = 'running'` and a
 * lease deadline in `next_attempt_at`, so a crash between phases returns the
 * message to the queue after the lease expires instead of stranding it, and two
 * overlapping cycles cannot both take the same row. The attempt is consumed at
 * CLAIM time, before the send — a process that dies mid-handshake has to be
 * assumed to have delivered, because the alternative is a customer receiving
 * the same message every time a serverless function times out.
 */

/**
 * Everything in `delivery/` is re-exported here rather than added to
 * `services/index.ts` separately: `outbox.ts` is already in the barrel, so the
 * providers reach `@nexus/core` — and the cron route — with no barrel edit,
 * which is a file this agent does not own.
 */
export * from "./delivery/index.ts";

const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 8;
const MAX_ATTEMPTS = 5;

/**
 * How long a claim is good for.
 *
 * Long enough that a slow relay finishing its handshake is not treated as a
 * crash; short enough that a genuinely dead process does not sit on a critical
 * alert for an hour. The cron's own `maxDuration` is 300s, so anything beyond
 * that is by definition a dead process and not a slow one.
 */
const CLAIM_LEASE_MINUTES = 10;

/**
 * Sources whose body is a CREDENTIAL and must not survive delivery.
 *
 * A user invite carries a single-use bearer token in its body — that is the
 * whole point of the link. `user_invites` stores only a hash of that token
 * precisely so a database read cannot be replayed into an account; queueing the
 * raw token in `notifications.body` would put it back, in plaintext, in a table
 * the in-app inbox renders and anyone with `dashboard:read` can list.
 *
 * So the body is cleared the moment the message reaches a terminal state. The
 * notification remains as evidence that an invite was sent, to whom and when —
 * which is what an auditor needs — without remaining as a way to accept it.
 */
const CREDENTIAL_BEARING_SOURCES = ["user_invites"] as const;

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

/**
 * The instant the tenant's current day began, as UTC.
 *
 * The daily cap has to be counted against a GULF day, not a UTC one. Counted
 * against UTC the cap resets at 04:00 local — in the middle of the working day
 * — so a runaway that started at 03:00 gets a fresh 200 messages four hours
 * later while the operator is still asleep.
 */
function gulfDayStart(now: Date): Date {
  const shifted = new Date(+now + 4 * 3_600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(+shifted - 4 * 3_600_000);
}

export type OutboxOutcome =
  | "delivered"
  | "would send"
  | "suppressed"
  | "deferred"
  | "held"
  | "capped"
  | "unconfigured"
  | "failed";

export interface DispatchOptions {
  /** Actually hand messages to the provider. Default false. */
  commit?: boolean;
  provider?: DeliveryProvider;
  now?: Date;
  limit?: number;
  /**
   * The user id that approved a batch above the approval threshold.
   *
   * Deliberately not a boolean. An approval that cannot name who gave it is
   * not an approval, it is a flag someone set.
   */
  approvedBy?: string;
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface DispatchSummary {
  considered: number;
  /** Messages a provider accepted custody of. Never incremented on a dry run. */
  delivered: number;
  /** Dry run only: messages that passed every gate and would have been sent. */
  deliverable: number;
  /**
   * `delivered + deliverable`, and it exists only so that
   * `services/outbox-cli.ts` — a file this change does not own — still
   * compiles. The two are mutually exclusive by construction (a dry run
   * delivers nothing; a committing run has nothing merely deliverable), so
   * this can never over-claim: in commit mode it IS `delivered`.
   *
   * Do not add readers. It is the ambiguous word that caused wave-1 finding
   * H7 — "sent" meaning both "would have been sent" and "was sent" is what let
   * a no-op provider's result be stamped as a delivery. Delete it with the CLI
   * that needs it.
   */
  sent: number;
  suppressed: number;
  failed: number;
  deferred: number;
  /** Stopped by a kill switch or the approval gate. Still `pending`. */
  held: number;
  /** Stopped by the daily cap. Still `pending`. */
  capped: number;
  /** No provider, or a broken one. Still `pending`, no attempt consumed. */
  unconfigured: number;
  /**
   * Why delivery was refused wholesale, if it was. Set by the kill switches and
   * the approval gate — the cron turns this into a visible failed run rather
   * than a cheerful row that swept nothing.
   */
  haltedReason?: string;
  detail: { id: string; title: string; outcome: OutboxOutcome; reason?: string }[];
}

function emptySummary(): DispatchSummary {
  return {
    considered: 0, delivered: 0, deliverable: 0, sent: 0, suppressed: 0, failed: 0,
    deferred: 0, held: 0, capped: 0, unconfigured: 0, detail: [],
  };
}

/** Fill in the compatibility field. See the note on `DispatchSummary.sent`. */
function finalise(summary: DispatchSummary): DispatchSummary {
  summary.sent = summary.delivered + summary.deliverable;
  return summary;
}

/** A transaction runner. `withTenant({tenantId}, fn)` satisfies this. */
export type Transact = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

// A type alias rather than an interface: `tx.execute<T>` constrains T to
// `Record<string, unknown>`, and TypeScript grants an implicit index signature
// to type aliases but not to interfaces.
type PendingRow = {
  id: string;
  channel: DeliveryChannel;
  recipient_address: string | null;
  recipient_party_id: string | null;
  title: string;
  body: string | null;
  severity: string;
  is_marketing: boolean;
  attempts: number;
  source_table: string | null;
  allows_transactional: boolean | null;
  allows_marketing: boolean | null;
  opted_out_at: string | null;
  party_phone: string | null;
  party_email: string | null;
};

/** A message that passed every gate and is claimed for delivery. */
interface ClaimedMessage {
  message: OutboundMessage;
  sourceTable: string | null;
  attempts: number;
}

interface ClaimResult {
  summary: DispatchSummary;
  claimed: ClaimedMessage[];
}

/**
 * Is this message going to a PERSON outside the business?
 *
 * The distinction drives consent, quiet hours, the cap and the approval gate.
 * An `in_app` alert reaches an inbox that staff already chose to open; anything
 * addressed to a party on any other channel arrives on somebody's phone.
 */
function isCustomerFacing(row: { recipient_party_id: string | null; channel: DeliveryChannel }): boolean {
  return row.recipient_party_id !== null && row.channel !== "in_app";
}

/**
 * PHASE 1 — decide, record every verdict that is not a send, and claim the rest.
 *
 * Everything in here is a database decision made against one MVCC snapshot: the
 * consent state, the quiet-hours verdict and the cap headroom are all read
 * consistently, and the claim that follows them is written in the same
 * transaction. No provider is called, so this holds a connection for as long as
 * a handful of statements take and no longer.
 */
type ClaimOptions = DispatchOptions & { commit: boolean; now: Date; limit: number };

async function claim(tx: Tx, opts: ClaimOptions): Promise<ClaimResult> {
  const { commit, now, limit } = opts;
  const env = opts.env ?? process.env;
  const summary = emptySummary();
  const claimed: ClaimedMessage[] = [];

  // ── Gate 1: the kill switches ─────────────────────────────────────────────
  const envEnabled = deliveryEnabledInEnvironment(env);
  const [tenantRow] = await tx.execute<{ paused: string | null; paused_reason: string | null }>(sql`
    SELECT settings->>'delivery_paused' AS paused,
           settings->>'delivery_paused_reason' AS paused_reason
      FROM tenants
     LIMIT 1
  `);
  const tenantPaused = tenantRow?.paused === "true";

  const halts: string[] = [];
  if (!envEnabled) halts.push("NEXUS_DELIVERY_ENABLED is not \"true\"");
  if (tenantPaused) {
    halts.push(
      `delivery is paused for this tenant${tenantRow?.paused_reason ? ` (${tenantRow.paused_reason})` : ""}`,
    );
  }

  /**
   * Both switches are reported, not just the first.
   *
   * An operator who has already flipped the tenant pause and is watching
   * nothing happen needs to know the environment switch is also off, otherwise
   * they resume the tenant, see no change, and conclude the pause is broken.
   */
  const halted = halts.length > 0 ? halts.join("; ") : undefined;

  const pending = await tx.execute<PendingRow>(sql`
    SELECT n.id, n.channel, n.recipient_address, n.recipient_party_id, n.title, n.body,
           n.severity::text, n.is_marketing, n.attempts, n.source_table,
           c.allows_transactional, c.allows_marketing, c.opted_out_at::text,
           p.primary_phone AS party_phone, p.email AS party_email
      FROM notifications n
      LEFT JOIN parties p ON p.id = n.recipient_party_id
      LEFT JOIN communication_consents c
             ON c.party_id = n.recipient_party_id AND c.channel = n.channel
     WHERE (
             n.status = 'pending'
             -- Reclaim: a cycle that died between CLAIM and RECORD left rows
             -- 'running' with an expired lease. Without this they are stranded
             -- forever, which is the failure mode a status column invites.
             OR (n.status = 'running' AND n.next_attempt_at <= ${now.toISOString()}::timestamptz)
           )
       AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ${now.toISOString()}::timestamptz)
       AND n.attempts < ${MAX_ATTEMPTS}
     ORDER BY
       CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       n.created_at
     LIMIT ${limit}
     FOR UPDATE OF n SKIP LOCKED
  `);

  summary.considered = pending.length;
  summary.haltedReason = halted;

  if (halted) {
    // Nothing is written. A kill switch that mutated rows would make itself
    // hard to release — the operator's problem is a queue they want to send
    // LATER, not a queue they want marked.
    for (const n of pending) {
      summary.held++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "held", reason: halted });
    }
    return { summary, claimed };
  }

  const quiet = inQuietHours(now);

  // ── Gate 6 headroom: how much of today's external budget is left ──────────
  const cap = dailyExternalCap(env);
  const [{ used = 0 } = { used: 0 }] = await tx.execute<{ used: number }>(sql`
    SELECT COUNT(*)::int AS used
      FROM notifications
     WHERE channel <> 'in_app'
       AND recipient_party_id IS NOT NULL
       AND status = 'success'
       AND sent_at >= ${gulfDayStart(now).toISOString()}::timestamptz
  `);
  // A COUNT(*) of notification rows against a ceiling on message volume.
  let headroom = Math.max(0, cap - Number(used)); // money-guard-ignore: a row count, not an amount.

  // ── Passes 1: evaluate the per-message gates ─────────────────────────────
  const survivors: PendingRow[] = [];

  for (const n of pending) {
    const external = isCustomerFacing(n);

    // ── Gate 2: consent ───────────────────────────────────────────────────
    let suppression: string | null = null;
    if (external) {
      if (n.opted_out_at) suppression = "recipient has opted out";
      else if (n.is_marketing && n.allows_marketing !== true) {
        suppression = "no marketing opt-in";
      } else if (!n.is_marketing && n.allows_transactional === false) {
        suppression = "transactional messages withdrawn";
      }
    }

    // ── Gate 3: quiet hours ───────────────────────────────────────────────
    if (!suppression && external && quiet && n.severity !== "critical") {
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

    // ── Gate 4: contactability ────────────────────────────────────────────
    const address = resolveAddress(n);
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

    survivors.push(n);
  }

  // ── Gate 5: approval, on the shape of the whole batch ────────────────────
  const externalSurvivors = survivors.filter(isCustomerFacing);
  const distinctRecipients = new Set(externalSurvivors.map((n) => n.recipient_party_id)).size;
  const threshold = approvalThreshold(env);

  if (distinctRecipients > threshold && !opts.approvedBy) {
    const reason =
      `this cycle would contact ${distinctRecipients} distinct recipients, above the ` +
      `approval threshold of ${threshold} — re-run with an approver to release it`;
    summary.haltedReason = reason;
    // Loud. An approval gate that fires silently at 04:30 is a queue that
    // stopped for reasons nobody will discover until a customer complains.
    reportError(new Error(reason), "outbox/approval-gate", {
      recipients: distinctRecipients,
      threshold,
    });
    for (const n of externalSurvivors) {
      summary.held++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "held", reason });
    }
    // In-app alerts are released regardless: they reach an inbox rather than a
    // person's phone, and they are how the owner finds out this happened at all.
    const heldIds = new Set(externalSurvivors.map((n) => n.id));
    const inAppOnly = survivors.filter((n) => !heldIds.has(n.id));
    survivors.length = 0;
    survivors.push(...inAppOnly);
  }

  // ── Passes 2: cap, then claim ────────────────────────────────────────────
  for (const n of survivors) {
    const external = isCustomerFacing(n);

    // ── Gate 6: daily cap ─────────────────────────────────────────────────
    if (external) {
      if (headroom <= 0) {
        const reason = `daily external delivery cap of ${cap} reached for this tenant`;
        summary.capped++;
        summary.detail.push({ id: n.id, title: n.title, outcome: "capped", reason });
        continue;
      }
      headroom--;
    }

    if (!commit) {
      summary.deliverable++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "would send" });
      continue;
    }

    /**
     * In-app messages are settled here and never handed to a provider.
     *
     * The row IS the delivery — `loadInbox` reads `notifications` regardless of
     * `status`, so the alert is already on the owner's screen. Routing it
     * through a sender would invent a network hop for a message that has
     * arrived, and it is why the console provider ever had to claim `sent` for
     * something: this case had no other way through.
     */
    if (n.channel === "in_app") {
      await tx.execute(sql`
        UPDATE notifications
           SET status = 'success', sent_at = COALESCE(sent_at, now()), provider = 'in_app',
               error = NULL, updated_at = now()
         WHERE id = ${n.id}::uuid
      `);
      summary.delivered++;
      summary.detail.push({ id: n.id, title: n.title, outcome: "delivered", reason: "in-app inbox" });
      continue;
    }

    // Claim. The attempt is consumed HERE, before the send — see the boundary
    // note at the top of the file.
    const lease = new Date(+now + CLAIM_LEASE_MINUTES * 60_000);
    await tx.execute(sql`
      UPDATE notifications
         SET status = 'running', attempts = attempts + 1,
             next_attempt_at = ${lease.toISOString()}::timestamptz, updated_at = now()
       WHERE id = ${n.id}::uuid
    `);
    claimed.push({
      sourceTable: n.source_table,
      attempts: n.attempts + 1,
      message: {
        id: n.id, channel: n.channel, address: resolveAddress(n), title: n.title,
        body: n.body, severity: n.severity, isMarketing: n.is_marketing,
        partyId: n.recipient_party_id,
      },
    });
  }

  return { summary, claimed };
}

function resolveAddress(n: PendingRow): string | null {
  return (
    n.recipient_address ??
    (n.channel === "email"
      ? n.party_email
      : n.channel === "sms" || n.channel === "whatsapp"
        ? n.party_phone
        : null)
  );
}

/**
 * PHASE 3 — write down what actually happened.
 *
 * Every branch corresponds to exactly one provider outcome, and `success` has
 * exactly one branch. That is the invariant this whole rewrite exists to
 * establish, so it is worth stating plainly: if you are adding an outcome, the
 * question to answer is "what does this row look like to somebody investigating
 * a complaint six months from now", and the answer must never be "delivered"
 * unless a remote system named the message.
 */
async function record(
  tx: Tx,
  now: Date,
  provider: DeliveryProvider,
  claimedMessage: ClaimedMessage,
  result: DeliveryResult,
  summary: DispatchSummary,
): Promise<void> {
  const { message, attempts, sourceTable } = claimedMessage;
  const clearBody = sourceTable !== null &&
    (CREDENTIAL_BEARING_SOURCES as readonly string[]).includes(sourceTable);

  if (result.outcome === "delivered") {
    /**
     * The single writer of `success`.
     *
     * The provider message id is REQUIRED, not decorative. It is the evidence
     * that separates "the far side accepted custody" from "the function
     * returned without throwing", and demanding it is what makes a no-op
     * provider structurally unable to produce a `sent_at`.
     */
    if (!result.providerMessageId) {
      summary.failed++;
      summary.detail.push({
        id: message.id, title: message.title, outcome: "failed",
        reason: "provider reported delivery without an identifier",
      });
      reportError(
        new Error(`provider ${provider.name} returned delivered with no message id`),
        "outbox/provider-contract",
      );
      await tx.execute(sql`
        UPDATE notifications
           SET status = 'failed', next_attempt_at = NULL,
               error = 'provider reported delivery without an identifier',
               updated_at = now()
         WHERE id = ${message.id}::uuid
      `);
      return;
    }

    await tx.execute(sql`
      UPDATE notifications
         SET status = 'success', sent_at = now(), next_attempt_at = NULL,
             provider = ${provider.name}, provider_message_id = ${result.providerMessageId},
             error = NULL,
             body = ${clearBody ? sql`NULL` : sql`body`},
             updated_at = now()
       WHERE id = ${message.id}::uuid
    `);
    summary.delivered++;
    summary.detail.push({ id: message.id, title: message.title, outcome: "delivered" });
    return;
  }

  if (isConfigurationFault(result.outcome)) {
    /**
     * Not the message's fault, so not the message's retry budget.
     *
     * The attempt consumed at claim time is given back and the row returns to
     * `pending` with the reason recorded — an operator who sets SMTP_HOST
     * tomorrow gets the whole queue delivered, not a queue of five-times-failed
     * corpses. The short delay stops a cron with a shorter period from spinning
     * on a misconfiguration.
     */
    const retryAt = new Date(+now + 15 * 60_000);
    await tx.execute(sql`
      UPDATE notifications
         SET status = 'pending', attempts = ${Math.max(0, attempts - 1)},
             next_attempt_at = ${retryAt.toISOString()}::timestamptz,
             error = ${result.reason ?? "delivery is not configured"}, updated_at = now()
       WHERE id = ${message.id}::uuid
    `);
    summary.unconfigured++;
    summary.detail.push({
      id: message.id, title: message.title, outcome: "unconfigured", reason: result.reason,
    });
    return;
  }

  /**
   * A real failure. Permanent spends the whole budget at once; transient spends
   * one and backs off.
   *
   * A permanent failure is a verdict, not a bad day — "550 no such user" does
   * not become true on the fourth ask, and leaving it in the retry queue hides
   * the relay's genuine outages behind a wall of known-dead addresses. The body
   * of a credential-bearing message is cleared here too: an invite that will
   * never be delivered must not leave a live token in a table anyone with
   * `dashboard:read` can list.
   */
  const permanent = result.outcome === "permanent_failure";
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
  const retryAt = new Date(+now + nextAttemptDelayMinutes(attempts) * 60_000);

  await tx.execute(sql`
    UPDATE notifications
       SET status = ${exhausted ? "failed" : "pending"}::run_status,
           attempts = ${exhausted ? MAX_ATTEMPTS : attempts},
           next_attempt_at = ${exhausted ? null : retryAt.toISOString()}::timestamptz,
           error = ${result.reason ?? "delivery failed"},
           body = ${exhausted && clearBody ? sql`NULL` : sql`body`},
           updated_at = now()
     WHERE id = ${message.id}::uuid
  `);
  summary.failed++;
  summary.detail.push({
    id: message.id,
    title: message.title,
    outcome: "failed",
    reason:
      `${result.reason ?? "delivery failed"} — ` +
      (permanent ? "permanent, not retrying" : exhausted ? "giving up" : "will retry"),
  });
}

/**
 * The production entry point: claim, deliver, record — three phases, and the
 * network calls happen with no transaction held (audit finding M6).
 *
 *   await runOutboxCycle((fn) => withTenant({ tenantId }, fn), { commit: true });
 *
 * `transact` is called twice on a committing run and once on a dry run. Passing
 * a function that reuses one transaction is legal and is exactly what
 * `dispatchOutbox` does — but a caller doing that in production is choosing to
 * hold a Postgres connection across every SMTP handshake in the batch.
 */
export async function runOutboxCycle(
  transact: Transact,
  opts: DispatchOptions = {},
): Promise<DispatchSummary> {
  const commit = opts.commit ?? false;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const provider = opts.provider ?? consoleProvider;

  const { summary, claimed } = await transact((tx) =>
    claim(tx, { ...opts, commit, now, limit }),
  );

  if (claimed.length === 0) return finalise(summary);

  // ── Deliver. No transaction is held here, deliberately. ──────────────────
  const results: { claimed: ClaimedMessage; result: DeliveryResult }[] = [];
  for (const item of claimed) {
    let result: DeliveryResult;
    try {
      result = await provider.send(item.message);
    } catch (err) {
      /**
       * A throw is not a verdict.
       *
       * A provider that threw might have delivered — the exception could have
       * come from reading the reply to a message the relay already queued. It
       * is therefore treated as transient (retry, bounded) rather than
       * permanent, and the attempt consumed at claim time stands.
       */
      result = { outcome: "transient_failure", reason: describeThrow(err) };
      reportError(err, "outbox/provider", { provider: provider.name, channel: item.message.channel });
    }
    results.push({ claimed: item, result });
  }

  await transact(async (tx) => {
    for (const { claimed: item, result } of results) {
      await record(tx, now, provider, item, result, summary);
    }
  });

  return finalise(summary);
}

/** Scrub before an exception message reaches a database column or a log line. */
function describeThrow(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[address]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Single-transaction dispatch. Kept for the CLI and for tests.
 *
 * Behaviourally identical to `runOutboxCycle`, with all three phases sharing
 * the caller's transaction — which means the provider is called with a Postgres
 * connection held open, the exact shape audit finding M6 describes. That is
 * harmless for a dry run (no provider is called) and acceptable for a
 * hand-driven CLI against a laptop database.
 *
 * It is NOT acceptable for the scheduled sweep, and the reason is not
 * theoretical: with a real relay this holds one connection across up to 200
 * sequential SMTP handshakes, and a failure late in the batch rolls back the
 * status updates for messages already delivered — so the next run sends them
 * again. `apps/web/src/app/api/cron/[job]/route.ts` must call `runOutboxCycle`.
 */
export async function dispatchOutbox(
  tx: Tx,
  opts: DispatchOptions = {},
): Promise<DispatchSummary> {
  return runOutboxCycle((fn) => fn(tx), opts);
}

/**
 * THE PANIC BUTTON.
 *
 * One UPDATE, effective from the next claim, no redeploy — which is what
 * "immediately" has to mean for a control whose purpose is stopping something
 * already in progress. `NEXUS_DELIVERY_ENABLED` is the fail-closed default and
 * cannot serve this role: changing an environment variable on Vercel requires a
 * build, and a build takes longer than the automation does.
 *
 * Stored on `tenants.settings` rather than in a new table, because a switch
 * that needs a migration to exist is a switch that is not there during the
 * incident that needs it. The RLS policy on `tenants` is
 * `id = current_setting('app.tenant_id')`, so this can only ever pause the
 * caller's own tenant.
 *
 * `settings:update` rather than a new permission key: the catalogue already has
 * it (`packages/db/src/seed/reference.ts`) and both `owner` and `super_admin`
 * hold `*`. Introducing a key nobody holds is how a control ships that can
 * never fire.
 *
 * Resuming is deliberately NOT symmetrical in one respect — the reason and the
 * actor are kept in `settings` after a resume, so "why was delivery off between
 * Tuesday and Thursday" has an answer that survives the resume.
 */
export async function pauseDelivery(
  tx: Tx,
  actorUserId: string,
  reason: string,
): Promise<void> {
  /**
   * The `::text` casts are load-bearing, not decoration.
   *
   * `jsonb_build_object` is variadic over `"any"`, so Postgres cannot infer a
   * bare placeholder's type and refuses the whole statement with `42P18 could
   * not determine data type of parameter $1`. Without the casts this function
   * throws every time it is called — a panic button that fails at the moment
   * somebody needs it, which is worse than not having one, because the operator
   * spends the incident debugging the switch instead of the automation.
   */
  await tx.execute(sql`
    UPDATE tenants
       SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
             'delivery_paused', 'true',
             'delivery_paused_reason', ${reason.slice(0, 200)}::text,
             'delivery_paused_by', ${actorUserId}::text,
             'delivery_paused_at', now()::text
           ),
           updated_at = now()
     WHERE id = current_setting('app.tenant_id', true)::uuid
  `);
}

export async function resumeDelivery(tx: Tx, actorUserId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE tenants
       SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
             'delivery_paused', 'false',
             'delivery_resumed_by', ${actorUserId}::text,
             'delivery_resumed_at', now()::text
           ),
           updated_at = now()
     WHERE id = current_setting('app.tenant_id', true)::uuid
  `);
}

export async function isDeliveryPaused(tx: Tx): Promise<boolean> {
  const [row] = await tx.execute<{ paused: string | null }>(sql`
    SELECT settings->>'delivery_paused' AS paused FROM tenants LIMIT 1
  `);
  return row?.paused === "true";
}

export interface EnqueueInput {
  channel: DeliveryChannel;
  /** Required for every channel except `in_app`. */
  address?: string | null;
  partyId?: string | null;
  userId?: string | null;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  severity?: "info" | "opportunity" | "warning" | "critical";
  /** Deduplication. See the note below on why a null one is a real choice. */
  dedupeKey?: string | null;
  sourceTable?: string | null;
  sourceId?: string | null;
  isMarketing?: boolean;
}

/**
 * Put one message in the outbox.
 *
 * The automation runner writes its own notification rows because it needs the
 * `ON CONFLICT` return value to count duplicates; this is for the one-off
 * writers — the first of which is the user invite, which has had no way to
 * reach the person being invited since it shipped in wave 2.
 *
 * DEDUPE. `notifications_dedupe_uq` is UNIQUE (tenant_id, dedupe_key), so a key
 * makes re-enqueueing a no-op. `dedupe_key` is NULLABLE and Postgres treats
 * NULLs as distinct, which means omitting it opts OUT of deduplication
 * entirely — that is occasionally right (a re-issued invite genuinely is a new
 * message) and it is never the safe default, so it is an explicit parameter
 * rather than something a caller can forget. Returns null when a duplicate was
 * suppressed, so the caller can tell "queued" from "already queued".
 *
 * No permission check here on purpose: this is a primitive, and the permission
 * that matters is the one guarding the ACTION that produced the message —
 * `user:invite` for an invite. A check here would be a second, weaker gate that
 * invites callers to think the first one is optional.
 */
export async function enqueueNotification(
  tx: Tx,
  tenantId: string,
  input: EnqueueInput,
): Promise<{ id: string } | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO notifications
      (id, tenant_id, channel, recipient_user_id, recipient_party_id, recipient_address,
       title, body, action_url, severity, source_table, source_id, dedupe_key,
       status, is_marketing)
    VALUES
      (gen_random_uuid(), ${tenantId}::uuid, ${input.channel}::notification_channel,
       ${input.userId ?? null}::uuid, ${input.partyId ?? null}::uuid,
       ${input.address ?? null}, ${input.title}, ${input.body ?? null},
       ${input.actionUrl ?? null}, ${input.severity ?? "info"}::insight_severity,
       ${input.sourceTable ?? null}, ${input.sourceId ?? null}::uuid,
       ${input.dedupeKey ?? null}, 'pending', ${input.isMarketing ?? false})
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING id
  `);
  return rows[0] ?? null;
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
