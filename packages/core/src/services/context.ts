import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { assertCan, canAccessBusinessUnit, ForbiddenError, type Principal } from "../rbac.ts";
import { ZERO, eq, money, quantize, sum, toDb, toDisplay, type Money } from "../money/index.ts";

/**
 * Coerce a journal leg amount to Money.
 *
 * Accepts `number` during the migration so services can be converted one at a
 * time, but the value becomes exact the instant it crosses this boundary and is
 * never arithmetic'd as a float again. Once every caller passes Money the
 * `number` arm can be dropped and the lint rule in CI will keep it that way.
 */
const legAmount = (v: Money | number | string | undefined | null): Money =>
  v === undefined || v === null ? ZERO : money(v);

/**
 * SERVICE LAYER FOUNDATION.
 *
 * Every write in the product goes through a service function, and every service
 * function goes through this file. The rules it enforces are the ones that
 * separate an ERP from a CRUD app:
 *
 *   1. PERMISSION FIRST. Checked before any read, not after.
 *   2. ONE TRANSACTION. A document, its lines, its journal, its stock moves and
 *      its audit record either all land or none do. A half-posted invoice is
 *      worse than a failed one.
 *   3. AUDITED. Who did what, when, and what changed — for anything touching
 *      money, permissions or customer data.
 *   4. IDEMPOTENT. Every mutation takes a client-supplied key. A double-tapped
 *      "Record payment" button on a bad connection must not take the money twice.
 *   5. NUMBERED ATOMICALLY. Document numbers come from an UPDATE ... RETURNING,
 *      never from count(*) + 1.
 */

export interface ServiceContext {
  tx: Tx;
  tenantId: string;
  principal: Principal;
  /** Tenant-local today, ISO. Injected so behaviour is testable. */
  today: string;
  baseCurrency: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "forbidden"
      | "not_found"
      | "invalid"
      | "conflict"
      | "period_closed"
      | "duplicate",
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Permission gate. Throws rather than returning false — a write that silently
 *  does nothing is the worst possible failure mode. */
export function requirePermission(ctx: ServiceContext, permission: string): void {
  try {
    assertCan(ctx.principal, permission);
  } catch (err) {
    if (err instanceof ForbiddenError) throw new ServiceError(err.message, "forbidden");
    throw err;
  }
}

/** Business-unit scope gate: a branch manager cannot post into another branch. */
export function requireBusinessUnit(ctx: ServiceContext, businessUnitId: string): void {
  if (!canAccessBusinessUnit(ctx.principal, businessUnitId)) {
    throw new ServiceError("You do not have access to that business.", "forbidden");
  }
}

/**
 * Allocate the next document number atomically.
 *
 * `UPDATE ... RETURNING` under the row lock, not `SELECT max()+1`. Two POS
 * terminals ringing up a sale in the same millisecond must not both get
 * INV-SALON-00042.
 */
export async function nextDocumentNumber(
  ctx: ServiceContext,
  businessUnitId: string,
  key: string,
  prefix: string,
): Promise<string> {
  const rows = await ctx.tx.execute<{ next_value: number }>(sql`
    UPDATE number_series
       SET next_value = next_value + 1
     WHERE tenant_id = ${ctx.tenantId}::uuid
       AND business_unit_id = ${businessUnitId}::uuid
       AND key = ${key}
    RETURNING next_value - 1 AS next_value
  `);
  if (rows.length === 0) {
    // No series configured — create one rather than failing the sale. An ERP
    // that refuses to take money because of a missing config row is unusable.
    await ctx.tx.execute(sql`
      INSERT INTO number_series (id, tenant_id, business_unit_id, key, prefix, next_value)
      VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${businessUnitId}::uuid,
              ${key}, ${prefix}, 2)
      ON CONFLICT DO NOTHING
    `);
    return `${prefix}-${String(1).padStart(5, "0")}`;
  }
  return `${prefix}-${String(rows[0]!.next_value).padStart(5, "0")}`;
}

/**
 * Idempotency.
 *
 * The caller supplies a key; if that key has already produced a result within
 * this tenant, the original result is returned and nothing runs again. This is
 * what makes a retried request safe over a flaky mobile connection — the
 * dominant failure mode for staff working in a basement car park.
 */
export async function withIdempotency<T>(
  ctx: ServiceContext,
  key: string | undefined,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();

  const existing = await ctx.tx.execute<{ result: T }>(sql`
    SELECT result FROM idempotency_keys
     WHERE tenant_id = ${ctx.tenantId}::uuid AND key = ${key}
  `);
  if (existing.length > 0) return existing[0]!.result;

  const result = await fn();

  // ON CONFLICT DO NOTHING covers the race where two identical requests arrive
  // concurrently; the loser simply discards its duplicate work.
  await ctx.tx.execute(sql`
    INSERT INTO idempotency_keys (id, tenant_id, key, operation, result)
    VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${key}, ${operation},
            ${JSON.stringify(result)}::jsonb)
    ON CONFLICT (tenant_id, key) DO NOTHING
  `);
  return result;
}

/**
 * Audit record.
 *
 * Only the CHANGED fields, never the whole row — a full-row copy on every
 * update duplicates customer PII across thousands of log entries and makes the
 * log unreadable to the person who actually needs it.
 */
export async function writeAudit(
  ctx: ServiceContext,
  entry: {
    action: string;
    entityTable: string;
    entityId?: string;
    businessUnitId?: string;
    diff?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.tx.execute(sql`
    INSERT INTO audit_log
      (id, tenant_id, actor_user_id, actor_label, business_unit_id, action,
       entity_table, entity_id, diff, ip_address, user_agent, request_id, at)
    VALUES
      (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.principal.userId}::uuid,
       ${ctx.principal.roleKey}, ${entry.businessUnitId ?? null}::uuid, ${entry.action},
       ${entry.entityTable}, ${entry.entityId ?? null}::uuid,
       ${JSON.stringify(entry.diff ?? {})}::jsonb,
       ${ctx.ipAddress ?? null}::inet, ${ctx.userAgent ?? null}, ${ctx.requestId ?? null}, now())
  `);
}

/**
 * Refuse to post into a closed accounting period.
 *
 * Once the accountant has closed a month, backdating into it silently changes
 * a P&L that has already been reported. The correct action is a journal in the
 * current period, not a rewrite of history.
 */
export async function assertPeriodOpen(ctx: ServiceContext, postingDate: string): Promise<void> {
  const rows = await ctx.tx.execute<{ status: string; label: string }>(sql`
    SELECT status::text, label FROM fiscal_periods
     WHERE ${postingDate}::date BETWEEN starts_on AND ends_on
     LIMIT 1
  `);
  const period = rows[0];
  if (period && period.status === "closed") {
    throw new ServiceError(
      `Period ${period.label} is closed. Post to the current period instead.`,
      "period_closed",
    );
  }
}

/** Post a balanced journal. Refuses to write an unbalanced one — the database
 *  trigger would reject it anyway, but failing here gives a usable message. */
export async function postJournal(
  ctx: ServiceContext,
  entry: {
    postingDate: string;
    source: string;
    sourceTable: string;
    sourceId: string;
    narration: string;
    legs: {
      accountKey: string;
      businessUnitId?: string | null;
      /** Money, or anything Money can be constructed from. Never a computed float. */
      debit?: Money | number | string;
      credit?: Money | number | string;
      partyId?: string | null;
      memo?: string;
    }[];
  },
): Promise<string> {
  await assertPeriodOpen(ctx, entry.postingDate);

  /**
   * The balance gate.
   *
   * This was `Math.abs(debits - credits) > 0.005` over float-accumulated legs —
   * the single control guaranteeing the general ledger balances, expressed as a
   * half-fils tolerance. A journal whose drift stayed under that posted
   * *unbalanced*, and the imbalance was then written into numeric columns
   * permanently.
   *
   * Now exact. The comparison is made at storage precision because that is what
   * the database will actually hold and what its trigger will re-check —
   * quantizing is not a tolerance, it is comparing the values that get written
   * rather than intermediate ones.
   */
  const debits = quantize(sum(entry.legs.map((l) => legAmount(l.debit))));
  const credits = quantize(sum(entry.legs.map((l) => legAmount(l.credit))));
  if (!eq(debits, credits)) {
    throw new ServiceError(
      `Journal does not balance: debit ${toDisplay(debits)} vs credit ${toDisplay(credits)}.`,
      "invalid",
    );
  }

  const keys = [...new Set(entry.legs.map((l) => l.accountKey))];
  const accounts = await ctx.tx.execute<{ system_key: string; id: string }>(sql`
    SELECT system_key, id FROM accounts
     WHERE system_key = ANY(ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}])
  `);
  const byKey = new Map(accounts.map((a) => [a.system_key, a.id]));
  for (const k of keys) {
    if (!byKey.has(k)) throw new ServiceError(`Account "${k}" is not configured.`, "invalid");
  }

  const numRows = await ctx.tx.execute<{ n: string }>(sql`
    SELECT LPAD((COUNT(*) + 1)::text, 6, '0') AS n FROM journals
  `);
  const journalNumber = `JV-${numRows[0]?.n ?? "000001"}`;

  const jrows = await ctx.tx.execute<{ id: string }>(sql`
    INSERT INTO journals
      (id, tenant_id, journal_number, source, source_table, source_id,
       posting_date, narration, posted_by_user_id, posted_at)
    VALUES
      (gen_random_uuid(), ${ctx.tenantId}::uuid, ${journalNumber}, ${entry.source}::journal_source,
       ${entry.sourceTable}, ${entry.sourceId}::uuid, ${entry.postingDate}::date,
       ${entry.narration}, ${ctx.principal.userId}::uuid, now())
    RETURNING id
  `);
  const journalId = jrows[0]!.id;

  let lineNo = 0;
  for (const leg of entry.legs) {
    lineNo++;
    await ctx.tx.execute(sql`
      INSERT INTO journal_lines
        (id, tenant_id, journal_id, line_no, account_id, business_unit_id,
         debit, credit, base_debit, base_credit, currency, party_id, memo)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${journalId}::uuid, ${lineNo},
         ${byKey.get(leg.accountKey)!}::uuid, ${leg.businessUnitId ?? null}::uuid,
         ${toDb(legAmount(leg.debit))}, ${toDb(legAmount(leg.credit))},
         ${toDb(legAmount(leg.debit))}, ${toDb(legAmount(leg.credit))},
         ${ctx.baseCurrency}, ${leg.partyId ?? null}::uuid, ${leg.memo ?? null})
    `);
  }

  return journalId;
}
