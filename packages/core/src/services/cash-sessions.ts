import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@nexus/db";
import * as M from "../money/index.ts";
import { can } from "../rbac.ts";
import {
  ServiceError,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * CASH POINT FLOAT AND BLIND DAY CLOSE — FR-M07.
 *
 * The salon and the parking kiosk are cash-first. `cash_registers` and
 * `cash_register_sessions` have existed since the first migration, complete
 * with `opening_float`, `expected_cash`, `counted_cash` and `variance`, and
 * until this file nothing in the product wrote a single one of them. The
 * automation engine has shipped a `cash_variance` detector the whole time,
 * querying a column no code path ever populated, so the alert could not fire
 * and its silence read as "no variances" rather than "no measurement".
 *
 * Three properties make this feature worth anything at all. Each is enforced
 * here, in the service, not in the screen that happens to call it.
 *
 * ── 1. THE COUNT IS BLIND ────────────────────────────────────────────────────
 *
 * WF-05 §4.2 states it as a non-negotiable implementation note: the expected
 * figure must not be present in any payload sent to the client while the
 * session is open. If the cashier can see what the till "should" hold, the
 * count stops being evidence and becomes transcription — a person who is short
 * AED 120 types 1,840 and the control records a perfect day forever.
 *
 * Hiding the number in the UI does not achieve this; the value would still be
 * in the HTML, in the RSC payload, and one devtools panel away. So the
 * guarantee is structural, in four layers:
 *
 *   a. THE FIGURE DOES NOT EXIST YET. `expected_cash` is NULL for the entire
 *      life of an open session. It is computed for the first time inside
 *      `submitCashCount`, *after* the counted amount has arrived, and written
 *      in the same UPDATE. There is no stored expected figure to leak.
 *   b. ONE SUMMING QUERY, ONE CALLER. The SQL that totals a session's cash
 *      movements lives in `expectedCashForSession` and is called from exactly
 *      one place — `submitCashCount`, after the count. The board loader that
 *      feeds the screen runs the same shape of query with `COUNT(*)` where the
 *      sum would be, so "12 entries today" can be rendered without shipping
 *      anything the expected total can be reconstructed from.
 *   c. THE READ PATH IS ASSERTED. `assertBlind` re-checks every open-session
 *      row on its way out and throws if a key named after the expected figure,
 *      the count or the variance has appeared. A future `SELECT *` refactor
 *      fails loudly instead of quietly restoring the leak.
 *   d. THE COUNT IS IRREVOCABLE. Even a leak would buy nothing, because
 *      `submitCashCount` claims the row with `WHERE counted_cash IS NULL` and
 *      refuses a second count. The reconciliation is returned to the cashier —
 *      that is WF-05 §4.2 step 2 — but by then the number they typed is
 *      already permanent.
 *
 * ── 2. VARIANCE REACHES THE LEDGER ───────────────────────────────────────────
 *
 * counted − expected, posted against `CASH_OVER_SHORT` and the till's own cash
 * account. A variance that is recorded on the session row and nowhere else
 * leaves the cash account disagreeing with the drawer by a growing amount that
 * nothing in the accounts explains. Zero variance posts nothing — an empty
 * journal is noise in the ledger, not evidence.
 *
 * ── 3. A BIG VARIANCE IS NOT ONE PERSON'S DECISION ───────────────────────────
 *
 * Above a configurable threshold the close needs a reason *and* a manager's
 * acknowledgement. The PRD requires the acknowledgement "before the session
 * closes"; WF-05 §4.3 shows the cashier finishing their step and being told
 * "Rashid will be asked to acknowledge this". Both are satisfied by making the
 * close two-phase rather than one: the count is locked immediately, the session
 * enters `counted`, and only `acknowledgeCashVariance` sets `closed_at` and
 * posts the journal. The cashier can go home; the session is not closed, and
 * the screen says so.
 */

/* ── Configuration ─────────────────────────────────────────────────────────── */

/**
 * The account till variance lands in.
 *
 * PRD FR-M07 is explicit that it is a *cash over and short* account and never
 * miscellaneous expense or a suspense bucket, because the whole value of the
 * measurement is that it is separable and trendable. Referenced by system key,
 * as every posting in this codebase is; the chart-of-accounts seed owns the
 * code and the name.
 */
export const CASH_OVER_SHORT_KEY = "CASH_OVER_SHORT";

/**
 * Who may open a till and submit a count.
 *
 * `pos:open_drawer` is the existing permission for physically opening a cash
 * drawer, which is exactly this action, and it is already granted to the roles
 * that handle cash (owner, general manager, branch manager, salon manager,
 * sales staff) and withheld from the ones that must not (barber, auditor,
 * marketing). No new permission key is invented here: an unseeded key is held
 * by nobody, so introducing one would make the whole feature unreachable until
 * a seed run that this change does not control.
 */
export const CASH_SESSION_PERMISSION = "pos:open_drawer";

/**
 * Who may acknowledge a variance above the threshold, and who may close a till
 * they did not open.
 *
 * `payment:void` is the nearest existing "supervises cash, is not the cashier"
 * grant: held by owner, accountant, general manager and salon manager, and NOT
 * by sales staff, receptionist, branch manager or barber. That separation is
 * the entire point — an acknowledgement the cashier can give themselves is not
 * an acknowledgement. See the report note: a dedicated `cash:acknowledge`
 * permission would be better and needs a seed change this file cannot make.
 */
export const CASH_VARIANCE_ACK_PERMISSION = "payment:void";

/** Either of these may look at the register screen: the people who work a till,
 *  and the people who read the numbers it produces. */
export const CASH_VIEW_PERMISSIONS = ["pos:read", "report:read"];

/**
 * Default acknowledgement threshold, in base currency.
 *
 * PLACEHOLDER. Q-11 ("cash variance threshold requiring manager
 * acknowledgement") is open and is the owner's to answer — it is a policy
 * decision about how much drift is normal in his businesses, not an
 * engineering one, and a number invented here would be indistinguishable from
 * a decided one six months from now. AED 20 is used because it is the figure
 * WF-05 §4.2 and §4.3 draw on the screens this implements, so the built
 * product matches the specified product until the real answer arrives.
 *
 * Overridable per tenant via `tenants.settings->>'cashVarianceThreshold'`.
 */
export const DEFAULT_CASH_VARIANCE_THRESHOLD = "20";

/** Where the override lives. One key, so the settings screen that eventually
 *  writes it and the service that reads it cannot drift apart. */
export const CASH_VARIANCE_THRESHOLD_SETTING = "cashVarianceThreshold";

/**
 * Read the tenant's threshold, falling back to the placeholder.
 *
 * A malformed stored value falls back rather than throwing. The alternative is
 * that one bad character in a settings blob makes every till in the group
 * uncloseable, which is a far worse failure than acknowledging a variance that
 * a corrected setting would have waved through. Negative values are rejected
 * for the same reason a negative one would be meaningless: the comparison is
 * against |variance|.
 */
export async function resolveCashVarianceThreshold(tx: Tx): Promise<M.Money> {
  const rows = await tx.execute<{ value: string | null }>(sql`
    SELECT settings ->> ${CASH_VARIANCE_THRESHOLD_SETTING} AS value FROM tenants LIMIT 1
  `);
  const stored = rows[0]?.value;
  if (stored) {
    try {
      const parsed = M.money(stored);
      if (parsed.isFinite() && !M.isNegative(parsed)) return parsed;
    } catch {
      // Fall through to the default below.
    }
  }
  return M.money(DEFAULT_CASH_VARIANCE_THRESHOLD);
}

/* ── Shared shapes ─────────────────────────────────────────────────────────── */

/**
 * A session's lifecycle, derived rather than stored.
 *
 * `cash_register_sessions` has no status column and this feature deliberately
 * does not add one: the three states are already implied, exactly and without
 * the possibility of a status that disagrees with the amounts beside it.
 *
 *   open     counted_cash IS NULL  — the drawer is in use, nothing is known
 *   counted  counted_cash IS NOT NULL, closed_at IS NULL — counted, over the
 *            threshold, waiting on a reason and a manager
 *   closed   closed_at IS NOT NULL — done, journal posted if there was a variance
 */
export type CashSessionState = "open" | "counted" | "closed";

type RegisterRow = {
  session_id: string;
  register_id: string;
  register_name: string;
  business_unit_id: string;
  account_id: string;
  account_key: string | null;
  opened_by_user_id: string | null;
  opened_at: string;
  opening_float: string;
  closed_at: string | null;
  counted_cash: string | null;
  expected_cash: string | null;
  variance: string | null;
  variance_note: string | null;
}

/** Lock and load one session with everything a close needs. */
async function lockSession(ctx: ServiceContext, sessionId: string): Promise<RegisterRow> {
  const rows = await ctx.tx.execute<RegisterRow>(sql`
    SELECT s.id AS session_id, r.id AS register_id, r.name AS register_name,
           r.business_unit_id, r.account_id, a.system_key AS account_key,
           s.opened_by_user_id, s.opened_at::text, s.opening_float,
           s.closed_at::text, s.counted_cash, s.expected_cash, s.variance,
           s.variance_note
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.cash_register_id
      JOIN accounts a ON a.id = r.account_id
     WHERE s.id = ${sessionId}::uuid
       FOR UPDATE OF s
  `);
  const row = rows[0];
  if (!row) throw new ServiceError("That cash session was not found.", "not_found");
  return row;
}

/**
 * May this principal act on this session?
 *
 * A cashier closes their own till. Anyone else needs the supervisor grant —
 * otherwise one member of staff can count another's drawer, and a variance can
 * be attributed to a person who never touched the money. Refusing outright
 * would be worse: a cashier who goes home sick leaves a till nobody can close,
 * and the next shift's takings pile into a session that is not theirs.
 */
function requireSessionHolder(ctx: ServiceContext, row: RegisterRow, verb: string): void {
  const isHolder = row.opened_by_user_id !== null && row.opened_by_user_id === ctx.principal.userId;
  if (isHolder || can(ctx.principal, CASH_VARIANCE_ACK_PERMISSION)) return;
  throw new ServiceError(
    `${row.register_name} was opened by someone else. A manager has to ${verb} it.`,
    "forbidden",
  );
}

/* ── Registers ─────────────────────────────────────────────────────────────── */

export const createCashRegisterInput = z.object({
  businessUnitId: z.uuid(),
  name: z.string().min(1).max(100),
  /**
   * The GL account this till's cash sits in, by system key. Defaults to the
   * shared cash-in-hand account, which is correct for a group with one till
   * and is checked for ambiguity at open time when it is not.
   */
  accountKey: z.string().min(1).max(40).default("CASH"),
  locationId: z.uuid().nullable().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface CreateCashRegisterResult {
  cashRegisterId: string;
  name: string;
}

/**
 * Register a cash point.
 *
 * Gated on `settings:update` rather than the till permission: adding a cash
 * point is configuration — it decides which account a shift's cash lands in —
 * and a cashier who can create tills can create one pointed at an account
 * nobody reconciles.
 */
export async function createCashRegister(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CreateCashRegisterResult> {
  const input = createCashRegisterInput.parse(raw);
  requirePermission(ctx, "settings:update");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "createCashRegister", async () => {
    const bu = await ctx.tx.execute<{ id: string }>(sql`
      SELECT id FROM business_units WHERE id = ${input.businessUnitId}::uuid AND is_active = true
    `);
    if (bu.length === 0) throw new ServiceError("Business not found.", "not_found");

    // The account is resolved by system key here, at setup, rather than at
    // close: a till whose account cannot be named is a till whose variance
    // cannot be posted, and discovering that at 22:00 with a drawer of cash on
    // the counter is the wrong time to discover it.
    const account = await ctx.tx.execute<{ id: string; name: string; is_postable: boolean }>(sql`
      SELECT id, name, is_postable FROM accounts
       WHERE system_key = ${input.accountKey} AND is_active = true
    `);
    if (account.length === 0) {
      throw new ServiceError(
        `No account is configured with the key "${input.accountKey}".`,
        "invalid",
      );
    }
    if (!account[0]!.is_postable) {
      throw new ServiceError(
        `"${account[0]!.name}" is a grouping account and cannot hold a till's cash.`,
        "invalid",
      );
    }

    const duplicate = await ctx.tx.execute<{ id: string }>(sql`
      SELECT id FROM cash_registers
       WHERE business_unit_id = ${input.businessUnitId}::uuid
         AND lower(name) = lower(${input.name}) AND deleted_at IS NULL
    `);
    if (duplicate.length > 0) {
      throw new ServiceError(`This business already has a till called "${input.name}".`, "duplicate");
    }

    const created = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO cash_registers
        (id, tenant_id, business_unit_id, location_id, account_id, name, is_active)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${input.locationId ?? null}::uuid, ${account[0]!.id}::uuid, ${input.name}, true)
      RETURNING id
    `);
    const cashRegisterId = created[0]!.id;

    await writeAudit(ctx, {
      action: "cash_register.create",
      entityTable: "cash_registers",
      entityId: cashRegisterId,
      businessUnitId: input.businessUnitId,
      diff: { name: input.name, accountKey: input.accountKey },
    });

    return { cashRegisterId, name: input.name };
  });
}

/* ── Opening ───────────────────────────────────────────────────────────────── */

/** Money arriving from a form is a string; money arriving from the API may be a
 *  number. Both are handed straight to Decimal and never touch a float. */
const moneyLike = z.union([
  z.number(),
  z.string().trim().regex(/^-?\d{1,15}(\.\d{1,4})?$/, "Enter an amount like 1835.50"),
]);

export const openCashSessionInput = z.object({
  cashRegisterId: z.uuid(),
  openingFloat: moneyLike,
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface OpenCashSessionResult {
  sessionId: string;
  registerName: string;
  openingFloat: number;
}

/**
 * Open a till for a shift.
 *
 * The opening float is a DECLARED COUNT, not a ledger balance: the cashier says
 * how much is physically in the drawer at the start. Nothing is posted, because
 * nothing has moved — the cash was already in the cash account overnight. It is
 * the baseline the close is measured against, which is why it is recorded by a
 * named person at a recorded time.
 */
export async function openCashSession(
  ctx: ServiceContext,
  raw: unknown,
): Promise<OpenCashSessionResult> {
  const input = openCashSessionInput.parse(raw);
  requirePermission(ctx, CASH_SESSION_PERMISSION);

  const openingFloat = M.money(input.openingFloat);
  if (M.isNegative(openingFloat)) {
    throw new ServiceError("A float cannot be negative.", "invalid");
  }

  return withIdempotency(ctx, input.idempotencyKey, "openCashSession", async () => {
    const registers = await ctx.tx.execute<{
      id: string; name: string; business_unit_id: string; account_id: string;
      is_active: boolean; account_key: string | null;
    }>(sql`
      SELECT r.id, r.name, r.business_unit_id, r.account_id, r.is_active,
             a.system_key AS account_key
        FROM cash_registers r
        JOIN accounts a ON a.id = r.account_id
       WHERE r.id = ${input.cashRegisterId}::uuid AND r.deleted_at IS NULL
    `);
    const register = registers[0];
    if (!register) throw new ServiceError("That cash point was not found.", "not_found");
    requireBusinessUnit(ctx, register.business_unit_id);
    if (!register.is_active) {
      throw new ServiceError(`${register.name} is no longer in use.`, "invalid");
    }
    if (!register.account_key) {
      throw new ServiceError(
        `${register.name} points at an account with no system key, so its variance could not be posted. Fix the account before opening the till.`,
        "invalid",
      );
    }

    /**
     * One open session per till, and one open session per cash ACCOUNT.
     *
     * The first is obvious. The second is the one that would have been missed:
     * the expected figure is the net movement on the till's account over the
     * session window, so two tills sharing one account and open at the same
     * time each count the other's takings as their own, and both close with a
     * variance that is the other's turnover. Refusing here — with a message
     * that says what to do about it — is the only place this is cheap to fix.
     */
    const clash = await ctx.tx.execute<{ id: string; name: string; same_register: boolean }>(sql`
      SELECT s.id, r.name, (r.id = ${input.cashRegisterId}::uuid) AS same_register
        FROM cash_register_sessions s
        JOIN cash_registers r ON r.id = s.cash_register_id
       WHERE s.closed_at IS NULL
         AND r.business_unit_id = ${register.business_unit_id}::uuid
         AND r.account_id = ${register.account_id}::uuid
       ORDER BY same_register DESC
       LIMIT 1
    `);
    if (clash.length > 0) {
      throw new ServiceError(
        clash[0]!.same_register
          ? `${register.name} is already open. Close the current session before starting a new one.`
          : `${clash[0]!.name} is open on the same cash account. Close it first, or give each till its own cash account.`,
        "conflict",
      );
    }

    const created = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO cash_register_sessions
        (id, tenant_id, cash_register_id, opened_by_user_id, opened_at, opening_float)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.cashRegisterId}::uuid,
         ${ctx.principal.userId}::uuid, now(), ${M.toDb(openingFloat)})
      RETURNING id
    `);
    const sessionId = created[0]!.id;

    await writeAudit(ctx, {
      action: "cash_session.open",
      entityTable: "cash_register_sessions",
      entityId: sessionId,
      businessUnitId: register.business_unit_id,
      diff: { register: register.name, openingFloat: M.toDb(openingFloat) },
    });

    return {
      sessionId,
      registerName: register.name,
      openingFloat: M.toNumber(openingFloat),
    };
  });
}

/* ── Expected cash ─────────────────────────────────────────────────────────── */

/**
 * What the drawer SHOULD hold, per the books.
 *
 * opening float + every debit to the till's account − every credit to it, over
 * the session window. The ledger is the system of record for what moved; the
 * float is the baseline it moved from. Using the account's absolute balance
 * instead would be wrong — that balance carries every previous shift and every
 * banking, and none of that is in the drawer now.
 *
 * THIS FUNCTION IS THE ONLY PLACE THE EXPECTED FIGURE IS COMPUTED, and it has
 * exactly one caller: `submitCashCount`, below, after the counted amount has
 * been received. That is layer (b) of the blind-count guarantee in the file
 * header. If you add a second caller, you are almost certainly about to break
 * the control — the read path wants `countMovements`, which returns no amount.
 *
 * Lines with no business unit are not attributed to any till. A posting that
 * does not say which business it belongs to cannot be known to belong to this
 * one, and guessing would import another unit's cash into this drawer's
 * expectation.
 */
async function expectedCashForSession(
  ctx: ServiceContext,
  row: RegisterRow,
): Promise<{ expected: M.Money; movements: number }> {
  const totals = await ctx.tx.execute<{ net: string; moves: number }>(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS net,
           COUNT(*)::int AS moves
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ${row.account_id}::uuid
       AND jl.business_unit_id = ${row.business_unit_id}::uuid
       AND j.posted_at IS NOT NULL
       AND j.posted_at >= ${row.opened_at}::timestamptz
       AND j.posted_at <= now()
  `);
  const net = M.fromDb(totals[0]?.net);
  return {
    expected: M.quantize(M.add(M.fromDb(row.opening_float), net)),
    movements: totals[0]?.moves ?? 0,
  };
}

/* ── The variance posting ──────────────────────────────────────────────────── */

/**
 * Move the difference into the ledger and close the session.
 *
 * Short (counted < expected): the drawer holds less than the books say, so the
 * cash account is credited down to the truth and the loss is an expense.
 * Over: the reverse. One account either way, so a till that is over on Monday
 * and short on Tuesday nets out in a line an accountant can actually read.
 *
 * A zero variance posts nothing. There is no journal to write — debit and
 * credit would both be zero — and a ledger full of empty entries makes the
 * real ones harder to find.
 */
async function closeWithVariance(
  ctx: ServiceContext,
  row: RegisterRow,
  variance: M.Money,
): Promise<string | null> {
  const closed = await ctx.tx.execute<{ id: string }>(sql`
    UPDATE cash_register_sessions
       SET closed_at = now(), updated_at = now()
     WHERE id = ${row.session_id}::uuid AND closed_at IS NULL
    RETURNING id
  `);
  if (closed.length === 0) {
    throw new ServiceError(`${row.register_name} has already been closed.`, "conflict");
  }

  if (M.isZero(M.quantize(variance))) return null;

  const magnitude = M.abs(variance);
  const isOver = M.gt(variance, M.ZERO);
  const cashKey = row.account_key;
  if (!cashKey) {
    throw new ServiceError(
      `${row.register_name} points at an account with no system key, so the variance cannot be posted.`,
      "invalid",
    );
  }

  return postJournal(ctx, {
    postingDate: ctx.today,
    source: "manual",
    sourceTable: "cash_register_sessions",
    sourceId: row.session_id,
    narration: `Cash ${isOver ? "over" : "short"} — ${row.register_name}`,
    legs: isOver
      ? [
          { accountKey: cashKey, businessUnitId: row.business_unit_id, debit: magnitude },
          {
            accountKey: CASH_OVER_SHORT_KEY,
            businessUnitId: row.business_unit_id,
            credit: magnitude,
            memo: row.variance_note ?? undefined,
          },
        ]
      : [
          {
            accountKey: CASH_OVER_SHORT_KEY,
            businessUnitId: row.business_unit_id,
            debit: magnitude,
            memo: row.variance_note ?? undefined,
          },
          { accountKey: cashKey, businessUnitId: row.business_unit_id, credit: magnitude },
        ],
  });
}

/* ── The blind count ───────────────────────────────────────────────────────── */

export const submitCashCountInput = z.object({
  sessionId: z.uuid(),
  countedCash: moneyLike,
  /** Optional here because the cashier does not yet know it will be needed —
   *  that is the whole point of a blind count. Supplied afterwards by
   *  `recordCashVarianceReason` when the reconciliation asks for it. */
  reason: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface CashCountResult {
  sessionId: string;
  registerName: string;
  state: CashSessionState;
  countedCash: number;
  expectedCash: number;
  variance: number;
  threshold: number;
  /** True when the variance is over the threshold — a reason and an
   *  acknowledgement are required before the till is actually closed. */
  requiresAcknowledgement: boolean;
  reasonRecorded: boolean;
  journalId: string | null;
  movements: number;
}

/**
 * Submit the counted cash. THIS IS THE ONLY WAY THE EXPECTED FIGURE IS EVER
 * PRODUCED, AND IT PRODUCES IT AFTER THE COUNT.
 *
 * The order of operations is the control, so it is worth being explicit about
 * why it is what it is:
 *
 *   1. The count arrives from the client. Nothing has been disclosed.
 *   2. The row is locked and validated — right session, right person, not
 *      already counted.
 *   3. The expected figure is computed for the first time.
 *   4. Count, expected and variance are written in ONE UPDATE guarded by
 *      `counted_cash IS NULL`. Two concurrent submits cannot both win, and it
 *      is impossible for `expected_cash` to exist on a row that has no count —
 *      which is exactly the state a leak would need.
 *   5. Only now is the reconciliation returned. WF-05 §4.2's step 2 panel is
 *      this return value; there is no earlier request that could have carried
 *      it.
 *
 * A second call is refused rather than replayed as an update, so a cashier who
 * dislikes the answer cannot re-count into it. `withIdempotency` still replays
 * an identical retry, which is the connection-dropped case and is safe: same
 * key, same payload, same original answer.
 */
export async function submitCashCount(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CashCountResult> {
  const input = submitCashCountInput.parse(raw);
  requirePermission(ctx, CASH_SESSION_PERMISSION);

  const counted = M.money(input.countedCash);
  if (M.isNegative(counted)) {
    throw new ServiceError("A count cannot be negative.", "invalid");
  }

  return withIdempotency(ctx, input.idempotencyKey, "submitCashCount", async () => {
    const row = await lockSession(ctx, input.sessionId);
    requireBusinessUnit(ctx, row.business_unit_id);
    requireSessionHolder(ctx, row, "close");

    if (row.closed_at !== null) {
      throw new ServiceError(`${row.register_name} has already been closed.`, "conflict");
    }
    if (row.counted_cash !== null) {
      throw new ServiceError(
        `A count has already been submitted for ${row.register_name}. It cannot be counted twice.`,
        "conflict",
      );
    }

    const { expected, movements } = await expectedCashForSession(ctx, row);
    const variance = M.quantize(M.sub(M.quantize(counted), expected));
    const threshold = await resolveCashVarianceThreshold(ctx.tx);
    const requiresAcknowledgement = M.gt(M.abs(variance), threshold);

    const claimed = await ctx.tx.execute<{ id: string }>(sql`
      UPDATE cash_register_sessions
         SET counted_cash = ${M.toDb(counted)},
             expected_cash = ${M.toDb(expected)},
             variance = ${M.toDb(variance)},
             variance_note = ${input.reason ?? null},
             updated_at = now()
       WHERE id = ${row.session_id}::uuid
         AND counted_cash IS NULL
         AND closed_at IS NULL
      RETURNING id
    `);
    if (claimed.length === 0) {
      throw new ServiceError(
        `A count has already been submitted for ${row.register_name}. It cannot be counted twice.`,
        "conflict",
      );
    }

    await writeAudit(ctx, {
      action: "cash_session.count",
      entityTable: "cash_register_sessions",
      entityId: row.session_id,
      businessUnitId: row.business_unit_id,
      diff: {
        register: row.register_name,
        counted: M.toDb(counted),
        expected: M.toDb(expected),
        variance: M.toDb(variance),
        threshold: M.toDb(threshold),
      },
    });

    let journalId: string | null = null;
    let state: CashSessionState = "counted";
    if (!requiresAcknowledgement) {
      // Within tolerance: this is the ordinary end of a shift and does not need
      // a second person. The journal posts now, under the cashier's own hand.
      journalId = await closeWithVariance(ctx, { ...row, variance_note: input.reason ?? null }, variance);
      state = "closed";
    }

    return {
      sessionId: row.session_id,
      registerName: row.register_name,
      state,
      countedCash: M.toNumber(counted),
      expectedCash: M.toNumber(expected),
      variance: M.toNumber(variance),
      threshold: M.toNumber(threshold),
      requiresAcknowledgement,
      reasonRecorded: input.reason !== undefined,
      journalId,
      movements,
    };
  });
}

/* ── Reason and acknowledgement ────────────────────────────────────────────── */

export const recordCashVarianceReasonInput = z.object({
  sessionId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

/**
 * Record what the cashier says happened.
 *
 * WF-05 §4.3 offers "Recount", "Paid out, no receipt", "Wrong change" and
 * "Don't know" as one-tap answers, and is explicit that "Don't know" is a
 * deliberate option: forcing a false reason produces worse data than an honest
 * blank, and the account exists to make a pattern visible, not to extract a
 * confession. So this validates that a reason is PRESENT, never that it is a
 * good one.
 *
 * Writable only while the session is still open — once a manager has
 * acknowledged and the journal has posted, the note is part of the record
 * behind a ledger entry and editing it would rewrite the explanation of money
 * that has already moved.
 */
export async function recordCashVarianceReason(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ sessionId: string; registerName: string }> {
  const input = recordCashVarianceReasonInput.parse(raw);
  requirePermission(ctx, CASH_SESSION_PERMISSION);

  const row = await lockSession(ctx, input.sessionId);
  requireBusinessUnit(ctx, row.business_unit_id);
  requireSessionHolder(ctx, row, "explain");

  if (row.closed_at !== null) {
    throw new ServiceError(
      `${row.register_name} is closed. Its variance note is part of a posted journal and cannot be changed.`,
      "conflict",
    );
  }
  if (row.counted_cash === null) {
    throw new ServiceError("Count the drawer first.", "invalid");
  }

  await ctx.tx.execute(sql`
    UPDATE cash_register_sessions
       SET variance_note = ${input.reason}, updated_at = now()
     WHERE id = ${row.session_id}::uuid AND closed_at IS NULL
  `);

  await writeAudit(ctx, {
    action: "cash_session.reason",
    entityTable: "cash_register_sessions",
    entityId: row.session_id,
    businessUnitId: row.business_unit_id,
    diff: { register: row.register_name, reason: input.reason },
  });

  return { sessionId: row.session_id, registerName: row.register_name };
}

export const acknowledgeCashVarianceInput = z.object({
  sessionId: z.uuid(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface AcknowledgeCashVarianceResult {
  sessionId: string;
  registerName: string;
  variance: number;
  journalId: string | null;
}

/**
 * A manager signs off a variance, and only then does the till close.
 *
 * Two refusals here carry the requirement:
 *
 *   · The acknowledger must hold `CASH_VARIANCE_ACK_PERMISSION`, which the
 *     cashier roles do not. Self-acknowledgement by the person who counted is
 *     possible only for someone who already supervises cash — an owner closing
 *     his own pocket float — and that is the correct exception, not a hole.
 *   · A reason must already be recorded. PRD FR-M07 asks for a reason AND an
 *     acknowledgement; acknowledging a blank is a signature on nothing.
 */
export async function acknowledgeCashVariance(
  ctx: ServiceContext,
  raw: unknown,
): Promise<AcknowledgeCashVarianceResult> {
  const input = acknowledgeCashVarianceInput.parse(raw);
  requirePermission(ctx, CASH_VARIANCE_ACK_PERMISSION);

  return withIdempotency(ctx, input.idempotencyKey, "acknowledgeCashVariance", async () => {
    const row = await lockSession(ctx, input.sessionId);
    requireBusinessUnit(ctx, row.business_unit_id);

    if (row.closed_at !== null) {
      throw new ServiceError(`${row.register_name} has already been closed.`, "conflict");
    }
    if (row.counted_cash === null) {
      throw new ServiceError(
        `${row.register_name} has not been counted yet, so there is nothing to acknowledge.`,
        "invalid",
      );
    }
    if (!row.variance_note || row.variance_note.trim() === "") {
      throw new ServiceError(
        "Record what happened before acknowledging. \"Don't know\" is an acceptable answer; blank is not.",
        "invalid",
      );
    }

    const variance = M.fromDb(row.variance);
    const journalId = await closeWithVariance(ctx, row, variance);

    await writeAudit(ctx, {
      action: "cash_session.acknowledge",
      entityTable: "cash_register_sessions",
      entityId: row.session_id,
      businessUnitId: row.business_unit_id,
      diff: {
        register: row.register_name,
        variance: M.toDb(variance),
        reason: row.variance_note,
        journalId,
      },
    });

    return {
      sessionId: row.session_id,
      registerName: row.register_name,
      variance: M.toNumber(variance),
      journalId,
    };
  });
}

/* ── The register screen ───────────────────────────────────────────────────── */

/**
 * Key fragments that must never appear on an open session's row.
 *
 * Substrings rather than whole names, so `expectedCash`, `expected_cash` and a
 * helpfully-renamed `tillExpected` all trip it. `entryCount` deliberately does
 * not match "counted" — the number of movements is safe, their total is not.
 */
const LEAKY_KEY_FRAGMENTS = [
  "expect",
  "counted",
  "variance",
  "takings",
  "netmovement",
  "movementtotal",
  "drawertotal",
];

/**
 * The blind-count assertion — layer (c) of the guarantee in the file header.
 *
 * `listOpenSessions` selects a fixed column list that excludes the expected
 * figure, and its row type has no field for one, so this cannot fire today.
 * That is the point: it is here for the change six months from now that adds
 * `s.expected_cash` to the SELECT "just for the totals row", which typechecks,
 * renders nothing visible, and silently ends the control. This turns that into
 * a loud failure on the first request.
 *
 * Throws rather than filtering. A screen that quietly drops the field would
 * ship the leak to every other consumer of the same function.
 */
export function assertBlind<T extends object>(rows: T[], where: string): T[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const flat = key.toLowerCase().replace(/[^a-z]/g, "");
      const leak = LEAKY_KEY_FRAGMENTS.find((fragment) => flat.includes(fragment));
      if (leak) {
        throw new ServiceError(
          `Blind count violated: ${where} returned "${key}" for an open session. ` +
            `The expected figure must not reach the client before the count is submitted (WF-05 §4.2).`,
          "invalid",
        );
      }
    }
  }
  return rows;
}

export interface OpenCashSession {
  sessionId: string;
  registerId: string;
  registerName: string;
  businessUnitName: string;
  colorToken: string;
  openedAt: string;
  openedBy: string;
  openedByUserId: string | null;
  openingFloat: number;
  entryCount: number;
  /** Counted but over the threshold: waiting on a reason and/or a manager. */
  awaitingAcknowledgement: boolean;
  /**
   * What the cashier said happened, on a session that is counted but not yet
   * closed. Named `closeNote` rather than `varianceNote` on purpose:
   * `assertBlind` refuses any key containing "variance", and this is the one
   * variance-adjacent field that carries no amount and is safe to ship. Keeping
   * the guard blunt and renaming the exception is the trade this codebase makes
   * elsewhere too — a guard with an allowlist is a guard that erodes.
   */
  closeNote: string | null;
}

export interface ClosedCashSession {
  sessionId: string;
  registerId: string;
  registerName: string;
  businessUnitName: string;
  colorToken: string;
  closedAt: string;
  closedOn: string;
  openedBy: string;
  openingFloat: number;
  countedCash: number;
  expectedCash: number;
  variance: number;
  varianceNote: string | null;
}

export interface CashRegisterSummary {
  registerId: string;
  name: string;
  businessUnitId: string;
  businessUnitName: string;
  colorToken: string;
  accountName: string;
  isActive: boolean;
  hasOpenSession: boolean;
}

export interface CashBoard {
  registers: CashRegisterSummary[];
  open: OpenCashSession[];
  closed: ClosedCashSession[];
  threshold: number;
  /** Per-till counts over the window, so the screen can say something true
   *  about a pattern instead of showing a total that hides it. */
  pattern: {
    registerId: string;
    registerName: string;
    closes: number;
    shorts: number;
    net: number;
    worst: number;
  }[];
}

/**
 * Everything `/finance/cash` renders, in one transaction.
 *
 * Deliberately NOT a `ServiceContext` function: it takes a `tx` like
 * `loadInbox` does, because a page render has no idempotency key, posts
 * nothing, and should not look like a write. Permission is checked by the
 * caller, which is also what decides between the screen and its
 * permission-denied state.
 *
 * The open-session query and the closed-session query are separate statements
 * on purpose. The closed one selects `expected_cash` because by then it is
 * history the cashier already saw; the open one physically cannot, and
 * `assertBlind` re-checks it.
 */
export async function loadCashBoard(
  tx: Tx,
  opts: { windowDays?: number; limit?: number; timezone?: string } = {},
): Promise<CashBoard> {
  const windowDays = opts.windowDays ?? 30;
  const limit = opts.limit ?? 50;
  // The day a close belongs to is the TENANT's day, not the database server's.
  // A salon closing at 22:00 Dubai time must not appear under tomorrow's date
  // because the connection happens to be on a different zone — the same reason
  // `resolveToday` exists in the web layer.
  const timezone = opts.timezone ?? "Asia/Dubai";

  const registers = await tx.execute<{
    register_id: string; name: string; business_unit_id: string; bu_name: string;
    color_token: string; account_name: string; is_active: boolean; open_sessions: number;
  }>(sql`
    SELECT r.id AS register_id, r.name, r.business_unit_id, b.name AS bu_name,
           b.color_token, a.name AS account_name, r.is_active,
           (SELECT COUNT(*)::int FROM cash_register_sessions s
             WHERE s.cash_register_id = r.id AND s.closed_at IS NULL) AS open_sessions
      FROM cash_registers r
      JOIN business_units b ON b.id = r.business_unit_id
      JOIN accounts a ON a.id = r.account_id
     WHERE r.deleted_at IS NULL
     ORDER BY b.sort_order, r.name
  `);

  /**
   * OPEN SESSIONS — the blind query.
   *
   * No `expected_cash`, no `counted_cash`, no `variance`, and no SUM of
   * anything. Two projections need justifying because both look like they
   * might leak and neither does:
   *
   *   · `awaiting_ack` is `counted_cash IS NOT NULL` reduced to a BOOLEAN. The
   *     screen has to be able to say "counted, waiting on a manager"; that a
   *     count exists is the only fact about it an unclosed session discloses.
   *   · `entry_count` is a `COUNT(*)` of the till's cash movements, which is
   *     what WF-05 §4.1 renders as "Float 500 · 12 entries". A count says the
   *     shift was busy and nothing about what the drawer holds. The same query
   *     with `SUM(jl.debit - jl.credit)` in place of `COUNT(*)` IS the expected
   *     figure — that is `expectedCashForSession`, and it is not reachable from
   *     here.
   */
  const openRows = await tx.execute<{
    session_id: string; register_id: string; register_name: string; bu_name: string;
    color_token: string; opened_at: string; opened_by: string | null;
    opened_by_user_id: string | null; opening_float: string; entry_count: number;
    awaiting_ack: boolean; close_note: string | null;
  }>(sql`
    SELECT s.id AS session_id, r.id AS register_id, r.name AS register_name,
           b.name AS bu_name, b.color_token,
           to_json(s.opened_at) #>> '{}' AS opened_at,
           u.full_name AS opened_by, s.opened_by_user_id,
           s.opening_float, (s.counted_cash IS NOT NULL) AS awaiting_ack,
           s.variance_note AS close_note,
           (SELECT COUNT(*)::int
              FROM journal_lines jl
              JOIN journals j ON j.id = jl.journal_id
             WHERE jl.account_id = r.account_id
               AND jl.business_unit_id = r.business_unit_id
               AND j.posted_at IS NOT NULL
               AND j.posted_at >= s.opened_at
               AND j.posted_at <= now()) AS entry_count
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.cash_register_id
      JOIN business_units b ON b.id = r.business_unit_id
      LEFT JOIN users u ON u.id = s.opened_by_user_id
     WHERE s.closed_at IS NULL
     ORDER BY s.opened_at
  `);
  assertBlind(openRows, "loadCashBoard.open");

  const open: OpenCashSession[] = openRows.map((row) => ({
    sessionId: row.session_id,
    registerId: row.register_id,
    registerName: row.register_name,
    businessUnitName: row.bu_name,
    colorToken: row.color_token,
    openedAt: row.opened_at,
    openedBy: row.opened_by ?? "Unknown",
    openedByUserId: row.opened_by_user_id,
    openingFloat: M.toNumber(M.fromDb(row.opening_float)),
    entryCount: row.entry_count,
    awaitingAcknowledgement: row.awaiting_ack,
    closeNote: row.close_note,
  }));

  const closedRows = await tx.execute<{
    session_id: string; register_id: string; register_name: string; bu_name: string;
    color_token: string; closed_at: string; closed_on: string; opened_by: string | null;
    opening_float: string; counted_cash: string | null; expected_cash: string | null;
    variance: string | null; variance_note: string | null;
  }>(sql`
    SELECT s.id AS session_id, r.id AS register_id, r.name AS register_name,
           b.name AS bu_name, b.color_token,
           to_json(s.closed_at) #>> '{}' AS closed_at,
           to_char(s.closed_at AT TIME ZONE ${timezone}, 'DD Mon') AS closed_on,
           u.full_name AS opened_by, s.opening_float, s.counted_cash,
           s.expected_cash, s.variance, s.variance_note
      FROM cash_register_sessions s
      JOIN cash_registers r ON r.id = s.cash_register_id
      JOIN business_units b ON b.id = r.business_unit_id
      LEFT JOIN users u ON u.id = s.opened_by_user_id
     WHERE s.closed_at IS NOT NULL
       AND s.closed_at >= now() - make_interval(days => ${windowDays}::int)
     ORDER BY s.closed_at DESC
     LIMIT ${limit}
  `);

  const closed: ClosedCashSession[] = closedRows.map((row) => ({
    sessionId: row.session_id,
    registerId: row.register_id,
    registerName: row.register_name,
    businessUnitName: row.bu_name,
    colorToken: row.color_token,
    closedAt: row.closed_at,
    closedOn: row.closed_on,
    openedBy: row.opened_by ?? "Unknown",
    openingFloat: M.toNumber(M.fromDb(row.opening_float)),
    countedCash: M.toNumber(M.fromDb(row.counted_cash)),
    expectedCash: M.toNumber(M.fromDb(row.expected_cash)),
    variance: M.toNumber(M.fromDb(row.variance)),
    varianceNote: row.variance_note,
  }));

  /**
   * The pattern, per till.
   *
   * WF-05 §4.1 is emphatic that the chart is a dot plot by till and not a
   * total: "clustering by person and shift is the signal; a total hides it."
   * A group whose tills are +200 and −200 has a net of zero and a serious
   * problem, and a screen that reports zero has actively misled its reader.
   * So this counts closes and shorts per register and keeps the worst single
   * close, and never sums across tills.
   */
  interface Tally {
    registerId: string;
    registerName: string;
    closes: number;
    shorts: number;
    net: M.Money;
    worst: M.Money;
  }
  const byRegister = new Map<string, Tally>();
  for (const row of closedRows) {
    const variance = M.fromDb(row.variance);
    const tally = byRegister.get(row.register_id) ?? {
      registerId: row.register_id,
      registerName: row.register_name,
      closes: 0,
      shorts: 0,
      net: M.ZERO,
      worst: M.ZERO,
    };
    tally.closes += 1;
    if (M.isNegative(variance)) tally.shorts += 1;
    tally.net = M.add(tally.net, variance);
    if (M.gt(M.abs(variance), M.abs(tally.worst))) tally.worst = variance;
    byRegister.set(row.register_id, tally);
  }
  const pattern = [...byRegister.values()]
    .map((t) => ({
      registerId: t.registerId,
      registerName: t.registerName,
      closes: t.closes,
      shorts: t.shorts,
      net: M.toNumber(M.quantize(t.net)),
      worst: M.toNumber(t.worst),
    }))
    .sort((a, b) => b.shorts - a.shorts || a.net - b.net);

  return {
    registers: registers.map((r) => ({
      registerId: r.register_id,
      name: r.name,
      businessUnitId: r.business_unit_id,
      businessUnitName: r.bu_name,
      colorToken: r.color_token,
      accountName: r.account_name,
      isActive: r.is_active,
      hasOpenSession: r.open_sessions > 0,
    })),
    open,
    closed,
    threshold: M.toNumber(await resolveCashVarianceThreshold(tx)),
    pattern,
  };
}

/** Can this principal look at the register screen at all? */
export function canViewCashRegister(permissions: Set<string>): boolean {
  return CASH_VIEW_PERMISSIONS.some((permission) => permissions.has(permission));
}
