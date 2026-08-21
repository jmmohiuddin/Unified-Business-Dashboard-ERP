"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { withTenant, uuidv7 } from "@nexus/db";
import { ServiceError, reportError, writeAudit, type ServiceContext } from "@nexus/core";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import {
  exceptionDetector,
  exceptionScopeFingerprint,
  isExceptionKey,
  probeException,
  resolveToday,
  type ExceptionKey,
} from "../data";
import type { ActionResult } from "../actions";

/**
 * DISMISSING AN EXCEPTION.  FR-V01: "Each exception is dismissable with a
 * reason, and dismissals are audited."
 *
 * In its own module because `lib/actions.ts` is shared and contended; the
 * patterns below (`writeBudget`, `buildContext`, `toResult`) are its patterns,
 * reproduced rather than imported because they are not exported — a "use
 * server" module may only export async functions.
 *
 * WHAT IS BEING WRITTEN, AND WHY IT IS NOT A SERVICE.
 *
 * The rest of the write layer lives in `packages/core/src/services` because it
 * posts to the ledger and a future mobile API must get the same lock. This one
 * does not: a dismissal changes nothing about the business, only about what one
 * person's home screen shows them. It touches no journal, no document and no
 * period. Putting it in `core` would mean exporting the whole exception-detector
 * table — which is a *presentation* concern, phrased in hrefs and sentences —
 * into the domain layer to keep the watermark honest. The permission check and
 * the audit record, which are the two things that actually matter, are both
 * enforced here, before the write.
 *
 * THE WATERMARK IS MEASURED SERVER-SIDE, ALWAYS.
 *
 * The counts stored on the dismissal are re-probed here rather than accepted
 * from the form. A client-supplied count is a client-supplied permission to
 * stay silent — post `count=999999` once and that exception never returns
 * however bad it gets. The browser sends a key, a reason and a retention
 * choice; every number comes from the database, inside the same transaction as
 * the insert, so the watermark cannot describe a state that never existed.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Session = Awaited<ReturnType<typeof requireSession>>;

async function buildContext(tx: Tx, session: Session): Promise<ServiceContext> {
  const h = await headers();
  const ip = h.get("x-client-ip");
  return {
    tx,
    tenantId: session.tenantId,
    principal: session.principal,
    today: resolveToday(session.timezone),
    baseCurrency: session.baseCurrency,
    ipAddress: ip && ip !== "local" ? ip : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

/** Same blunt per-user write throttle as every other mutating action. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/**
 * How long a dismissal holds, as offered on the dashboard.
 *
 * `worse` — the default and the one the design is built around — has no time
 * limit at all: the exception returns when it gets worse than the owner judged
 * it, and not before. The two snooze options exist because some exceptions are
 * genuinely a "not this week" rather than a judgement — a lease renewal
 * conversation booked for next month, say — and expressing that as a permanent
 * dismissal would be a lie the watermark cannot catch.
 */
const RETENTION_DAYS: Record<string, number | null> = {
  worse: null,
  "7": 7,
  "30": 30,
};

/**
 * The permission that governs the exception's underlying rows also governs
 * dismissing it.
 *
 * Not a separate `exception:dismiss` permission, because there is no coherent
 * user who may silence an exception they are not allowed to see: they cannot
 * read the reason it fired, and the only effect available to them would be to
 * suppress their own empty list. Gating on the read permission also means the
 * catalogue needs no new key, so this ships without a seed change.
 */
function requireVisible(session: Session, key: ExceptionKey): void {
  const detector = exceptionDetector(key);
  if (!session.principal.permissions.has(detector.permission)) {
    throw new ServiceError(
      `You do not have access to that exception (needs ${detector.permission}).`,
      "forbidden",
    );
  }
}

/**
 * Set an exception aside, with a reason, at its current magnitude.
 *
 * Upsert rather than insert: re-dismissing an exception that has come back
 * RAISES the watermark to the new state. Accumulating rows instead would leave
 * the feed choosing between several stale judgements, and the newest one is
 * always the only one that means anything.
 */
export async function dismissExceptionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const rawKey = str(formData, "key");
    if (!isExceptionKey(rawKey)) throw new ServiceError("Unknown exception.", "invalid");
    const key: ExceptionKey = rawKey;

    const reason = str(formData, "reason");
    if (!reason) {
      throw new ServiceError("Say why you are setting this aside — it goes on the audit log.", "invalid");
    }
    if (reason.length > 500) {
      throw new ServiceError("Keep the reason under 500 characters.", "invalid");
    }

    const retention = str(formData, "retention") ?? "worse";
    if (!(retention in RETENTION_DAYS)) {
      throw new ServiceError("Choose when this should come back.", "invalid");
    }
    const days = RETENTION_DAYS[retention] ?? null;

    const detector = exceptionDetector(key);
    requireVisible(session, key);

    const allowed = session.principal.businessUnitIds;
    const fingerprint = exceptionScopeFingerprint(allowed);
    const today = resolveToday(session.timezone);

    const outcome = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) => {
        const signal = await probeException(tx, key, today, allowed);
        if (signal.count <= 0) {
          // Nothing to set aside. Refusing is not pedantry: writing a zero
          // watermark would suppress the exception's *first* appearance later,
          // which is the one appearance that matters most.
          throw new ServiceError("That exception is no longer firing.", "conflict");
        }

        const id = uuidv7();
        const rows = await tx.execute<{ id: string }>(sql`
          INSERT INTO exception_dismissals
            (id, tenant_id, user_id, exception_key, reason,
             dismissed_count, dismissed_amount, dismissed_depth_days,
             scope_fingerprint, expires_at)
          VALUES
            (${id}::uuid, ${session.tenantId}::uuid, ${session.userId}::uuid,
             ${key}, ${reason},
             ${signal.count}, ${signal.amount ?? 0}, ${signal.depthDays},
             ${fingerprint},
             ${days === null ? sql`NULL::timestamptz` : sql`now() + ${`${days} days`}::interval`})
          ON CONFLICT (tenant_id, user_id, exception_key) WHERE deleted_at IS NULL
          DO UPDATE SET
            reason = EXCLUDED.reason,
            dismissed_count = EXCLUDED.dismissed_count,
            dismissed_amount = EXCLUDED.dismissed_amount,
            dismissed_depth_days = EXCLUDED.dismissed_depth_days,
            scope_fingerprint = EXCLUDED.scope_fingerprint,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
          RETURNING id
        `);

        await writeAudit(await buildContext(tx, session), {
          action: "exception.dismiss",
          entityTable: "exception_dismissals",
          entityId: rows[0]?.id ?? id,
          diff: {
            exceptionKey: key,
            reason,
            retention,
            expiresInDays: days,
            // The state the judgement was made about. Without it the audit
            // record says a decision was taken but not what it was taken about.
            watermark: {
              count: signal.count,
              amount: signal.amount,
              depthDays: signal.depthDays,
            },
            scopeFingerprint: fingerprint,
            businessUnitIds: allowed,
          },
        });

        return signal;
      },
    );

    revalidatePath("/");
    const back =
      days === null
        ? "It comes back if it gets worse."
        : `It comes back in ${days} days, or sooner if it gets worse.`;
    return {
      ok: true,
      message: `${detector.label} set aside. ${back}`,
      data: { key, count: outcome.count },
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Put a dismissed exception back on the list.
 *
 * Soft delete, not a hard one. The dismissal is the record of a judgement and
 * the audit entry points at its id; deleting the row would leave an audit trail
 * referring to something that no longer exists. The unique index is partial on
 * `deleted_at IS NULL`, so the same exception can be set aside again afterwards.
 */
export async function restoreExceptionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const rawKey = str(formData, "key");
    if (!isExceptionKey(rawKey)) throw new ServiceError("Unknown exception.", "invalid");
    const key: ExceptionKey = rawKey;
    const detector = exceptionDetector(key);
    requireVisible(session, key);

    await withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE exception_dismissals
           SET deleted_at = now(), updated_at = now()
         WHERE user_id = ${session.userId}::uuid
           AND exception_key = ${key}
           AND deleted_at IS NULL
        RETURNING id
      `);
      if (rows.length === 0) throw new ServiceError("It is already back on the list.", "not_found");

      await writeAudit(await buildContext(tx, session), {
        action: "exception.restore",
        entityTable: "exception_dismissals",
        entityId: rows[0]!.id,
        diff: { exceptionKey: key },
      });
    });

    revalidatePath("/");
    return { ok: true, message: `${detector.label} is back on the list.` };
  } catch (err) {
    return toResult(err);
  }
}
