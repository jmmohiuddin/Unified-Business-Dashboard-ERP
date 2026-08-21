import { sql, type SQL } from "drizzle-orm";
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
 * The atomic allocator behind every number series.
 *
 * `UPDATE ... RETURNING` under the row lock, never `SELECT max()+1` and never
 * `count(*) + 1` — rule 5 above. Two POS terminals ringing up a sale in the
 * same millisecond must not both get INV-SALON-00042.
 *
 * The bootstrap path — no series row yet — is the part that is easy to get
 * wrong, and was. It used to `INSERT ... ON CONFLICT DO NOTHING` and then
 * return 1 regardless of who won, so two concurrent *first* documents both
 * received 00001 and the second died on the document's own unique index: the
 * race the series exists to prevent, reintroduced on the one day of the
 * tenant's life when nobody is watching for it. It is now a single
 * `INSERT ... ON CONFLICT DO UPDATE`, which makes the loser wait on the
 * winner's row and then increment it, so both callers leave with a distinct
 * number.
 *
 * The conflict is arbitrated on the PRIMARY KEY, derived deterministically
 * from the series identity, rather than on `numseries_uq`. That index is
 * `(tenant_id, business_unit_id, key)` and a tenant-wide series has a NULL
 * business unit; under NULLS DISTINCT it would arbitrate nothing and the
 * bootstrap would insert a second row every time two callers raced, after
 * which the two rows would hand out the same numbers forever.
 *
 * `firstValue` is what the series hands out the very first time. For documents
 * that is 1. For a series adopted over data that already exists it must be an
 * expression evaluated at bootstrap time — hence SQL rather than a number —
 * because a ledger that already holds 11,928 journals must not restart at
 * JV-000001 and then collide on every posting until it catches up.
 */
async function allocateSeriesValue(
  ctx: ServiceContext,
  businessUnitId: string | null,
  key: string,
  prefix: string,
  firstValue: SQL | number,
): Promise<number> {
  const bumped = await ctx.tx.execute<{ next_value: number }>(sql`
    UPDATE number_series
       SET next_value = next_value + 1
     WHERE tenant_id = ${ctx.tenantId}::uuid
       AND business_unit_id IS NOT DISTINCT FROM ${businessUnitId}::uuid
       AND key = ${key}
    RETURNING next_value - 1 AS next_value
  `);
  if (bumped.length > 0) return bumped[0]!.next_value;

  // No series configured — create one rather than failing the sale. An ERP
  // that refuses to take money because of a missing config row is unusable.
  const created = await ctx.tx.execute<{ next_value: number }>(sql`
    INSERT INTO number_series (id, tenant_id, business_unit_id, key, prefix, next_value)
    VALUES (md5(${ctx.tenantId}::text || ':' || ${businessUnitId ?? ""}::text || ':' || ${key}::text)::uuid,
            ${ctx.tenantId}::uuid, ${businessUnitId}::uuid, ${key}, ${prefix},
            (${firstValue})::bigint + 1)
    ON CONFLICT (id) DO UPDATE SET next_value = number_series.next_value + 1
    RETURNING next_value - 1 AS next_value
  `);
  return created[0]!.next_value;
}

/** Allocate the next document number atomically. */
export async function nextDocumentNumber(
  ctx: ServiceContext,
  businessUnitId: string,
  key: string,
  prefix: string,
): Promise<string> {
  const value = await allocateSeriesValue(ctx, businessUnitId, key, prefix, 1);
  return `${prefix}-${String(value).padStart(5, "0")}`;
}

/** Tenant-wide series backing `JV-000123`. See `nextJournalNumber`. */
const JOURNAL_SERIES_KEY = "journal";
const JOURNAL_PREFIX = "JV";

/**
 * Allocate the next journal number atomically.
 *
 * This was `SELECT LPAD((COUNT(*) + 1)::text, 6, '0') FROM journals`, in a file
 * whose own header rule 5 says document numbers never come from `count(*) + 1`
 * — the code contradicted the comment two hundred lines below it. Two payments
 * posting concurrently both counted 122 journals, both built JV-000123, and the
 * second commit died on `journals_number_uq`. The user saw "Something went
 * wrong. Nothing was saved." for a write that was entirely correct, with
 * nothing in the message they or an accountant could act on, and retrying could
 * lose the same race again. The count was also a full scan of `journals` on
 * every single posting, three times per invoice, growing with the ledger.
 *
 * The series is tenant-wide, not per business unit, because
 * `journals_number_uq` is `(tenant_id, journal_number)`: a per-business series
 * would hand the same JV-000123 to two branches and reproduce the defect it is
 * here to remove. It seeds itself above whatever the ledger already holds, so
 * adopting it on a live database does not replay numbers that are taken.
 *
 * The cost, stated plainly: one tenant-wide row is locked from allocation until
 * commit, so concurrent postings within a tenant queue behind each other for
 * the tail of their transaction. That is the price of a number that is unique
 * by construction, it is what `nextDocumentNumber` already pays per series, and
 * it is cheaper than the full scan of `journals` it replaces. Numbers are
 * allocated, not reserved: a rolled-back posting leaves a gap, which is
 * correct — a journal number is an identifier, not a count.
 */
async function nextJournalNumber(ctx: ServiceContext): Promise<string> {
  const value = await allocateSeriesValue(
    ctx,
    null,
    JOURNAL_SERIES_KEY,
    JOURNAL_PREFIX,
    // Only ever evaluated once per tenant, on the posting that creates the
    // series. RLS scopes it to this tenant, which is the scope of the index it
    // has to stay clear of.
    sql`(SELECT COALESCE(MAX(substring(journal_number FROM '[0-9]+$')::bigint), 0) + 1 FROM journals)`,
  );
  return `${JOURNAL_PREFIX}-${String(value).padStart(6, "0")}`;
}

/**
 * Idempotency.
 *
 * The caller supplies a key; if that key has already produced a result within
 * this tenant, the original result is returned and nothing runs again. This is
 * what makes a retried request safe over a flaky mobile connection — the
 * dominant failure mode for staff working in a basement car park.
 *
 * Two properties have to hold, and neither used to.
 *
 * 1. THE KEY NAMES THE INTENT, NOT THE CALLER. The web client sent one key per
 *    mounted form, so a cashier who took AED 100 from Ahmed and then AED 250
 *    from Fatima through the same panel submitted the SAME key twice: the
 *    second call found the first key, replayed "PAY-00042 recorded", and the
 *    AED 250 never entered the ledger. Fatima held a receipt for money the
 *    ledger had never seen. The key is now a digest of the submitted payload
 *    (`apps/web/src/components/action-form.tsx`), and it is namespaced here
 *    with the operation so two services can never share a fingerprint. The
 *    tenant is already the leading column of `idempotency_uq`, so all three
 *    parts of the identity — tenant, operation, payload — are in the index.
 *
 * 2. THE CLAIM IS ATOMIC. This was SELECT -> fn() -> INSERT, which is
 *    check-then-act: under READ COMMITTED two concurrent submits both saw no
 *    row, both posted, both committed, and `ON CONFLICT DO NOTHING` discarded
 *    the duplicate KEY while keeping the duplicate MONEY. The insert now comes
 *    FIRST and the unique index arbitrates, so a loser is identified before it
 *    has posted anything rather than after.
 *
 * WHAT A LOSER DOES: it waits, then replays the winner's result. The losing
 * INSERT blocks on the winner's uncommitted row, so by the time the re-read
 * runs the winner has either committed — and its result is the honest answer to
 * a request that was byte-for-byte identical — or rolled back, in which case
 * the claim succeeds on the internal retry and this caller does the work
 * itself. Replaying is what keeps a double-tapped button silent, which is the
 * entire point of the feature; failing with a conflict would show an error for
 * a payment that did in fact go through, and the user's next move would be to
 * take the money again. `conflict` is therefore reserved for the one state
 * where the winner is neither committed nor gone — there the only safe answer
 * is "try again", never "posted".
 *
 * The claim row carries an empty envelope and is completed with
 * `{"result": …}`, so "claimed, still running" is a state we can recognise
 * instead of one that looks like a service which legitimately returned nothing.
 */
export async function withIdempotency<T>(
  ctx: ServiceContext,
  key: string | undefined,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();

  // `key` is varchar(120). Callers in this repo send a 32-char digest, so the
  // clip is unreachable; it truncates deterministically rather than letting the
  // database reject a payment over a long key.
  const scopedKey = `${operation}:${key}`.slice(0, 120);

  const claimed = await ctx.tx.execute<{ id: string }>(sql`
    INSERT INTO idempotency_keys (id, tenant_id, key, operation, result)
    VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${scopedKey}, ${operation}, '{}'::jsonb)
    ON CONFLICT (tenant_id, key) DO NOTHING
    RETURNING id
  `);

  if (claimed.length === 0) {
    const prior = await ctx.tx.execute<{ done: boolean; result: T }>(sql`
      SELECT jsonb_exists(result, 'result') AS done, result -> 'result' AS result
        FROM idempotency_keys
       WHERE tenant_id = ${ctx.tenantId}::uuid AND key = ${scopedKey}
    `);
    if (prior.length > 0 && prior[0]!.done) return prior[0]!.result;
    throw new ServiceError(
      "That request is already being processed. Try again in a moment.",
      "conflict",
    );
  }

  const result = await fn();

  await ctx.tx.execute(sql`
    UPDATE idempotency_keys
       SET result = jsonb_build_object('result', ${JSON.stringify(result ?? null)}::jsonb)
     WHERE tenant_id = ${ctx.tenantId}::uuid AND key = ${scopedKey}
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

  const journalNumber = await nextJournalNumber(ctx);

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
