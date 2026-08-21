import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import {
  ServiceError,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * MONTH-END CLOSE AND PERIOD LOCK.  FR-C01.
 *
 * `assertPeriodOpen` in `context.ts` has always been called by `postJournal` on
 * every posting in the product. It reads `fiscal_periods` and refuses anything
 * dated inside a row whose status is `closed`. Nothing in the repository ever
 * wrote a row to `fiscal_periods` — so the table was empty, the SELECT matched
 * nothing, and the single control standing between a filed VAT return and a
 * backdated journal had never once fired. `journals.fiscal_period_id` was NULL
 * on all 11,928 rows for the same reason.
 *
 * This file is the writer. It does not reimplement the guard, and must not: the
 * guard is the one that runs on the posting path, and a second copy of its
 * logic here would be a second place for the rule to drift.
 *
 *
 * WHAT A PERIOD IS, DECIDED HERE
 *
 * A CALENDAR MONTH, TENANT-WIDE. `fiscal_periods` carries no `business_unit_id`
 * and the chart of accounts is deliberately one chart across all seven
 * businesses (see `accounts` in the schema), so a period that could be closed
 * for the salon but open for the property company would let an inter-business
 * journal — one balanced entry with legs in two businesses — be half-refused.
 * There is no half of a journal. The lock is therefore group-wide.
 *
 * THE LABEL IS THE IDENTITY, AND IT IS `YYYY-MM`. `fiscal_periods_uq` is
 * `(tenant_id, label)`, so a label derived from the month is what makes two
 * overlapping rows for August impossible. That matters more than it looks:
 * `assertPeriodOpen` does `WHERE date BETWEEN starts_on AND ends_on LIMIT 1`,
 * and if two rows could cover one date the guard would consult whichever one
 * the planner happened to return. Free-text labels ("Aug", "August 2026",
 * "Q3") would permit exactly that. Every row this file writes has its bounds
 * derived from its label and nowhere else.
 *
 * The UAE tax year is the calendar year and VAT is filed quarterly, so calendar
 * months aggregate cleanly into both. A tenant on a non-calendar fiscal year is
 * not supported and would need `tenants` to carry a year-start month first.
 *
 *
 * FAIL-OPEN, AND WHAT THIS FILE DOES ABOUT IT
 *
 * `assertPeriodOpen` fails OPEN for a date with no row: no row, no throw. That
 * is not this file's decision to change — it is the posting path, and changing
 * it would make every posting in a tenant that has never closed anything fail
 * instead. But it means a lock is only as complete as the rows behind it:
 * closing August while July has no row at all leaves July silently writable,
 * and "closed" would be a claim the system does not keep.
 *
 * So closing a period materialises the rows the guard needs to be complete:
 *
 *   1. Every month from the ledger's first posting up to the one being closed
 *      that has no row yet is created AS CLOSED. Freezing August means August
 *      is reported; a backdated entry into July changes the same reported
 *      numbers just as much.
 *   2. Any earlier month that does have a row and is not closed is closed too.
 *   3. A single PRE-HISTORY row spanning 1900-01-01 to the day before the
 *      ledger's first posting is created, once, closed. Without it "closed up
 *      to 31 August" is true for every date except the ones before the ledger
 *      began, which is precisely the range an operator picks when they want a
 *      date nobody looks at.
 *
 * After a close there is no writable date on or before the closed period's end.
 * That is the property the feature is for, and it is why the cascade is not
 * optional. The screen states it before the button is pressed, and the audit
 * record names every month the cascade touched.
 *
 * Reopening does NOT cascade. See `reopenPeriod`.
 *
 *
 * `soft_closed` IS DELIBERATELY NOT WRITTEN
 *
 * `period_status` has three values and `assertPeriodOpen` refuses only
 * `closed`. A `soft_closed` period therefore accepts postings exactly like an
 * open one. Offering a soft close today would put a padlock on the screen that
 * the ledger does not enforce — a control that looks real and is not, which is
 * the same defect this file exists to remove. The state is rendered if a row
 * somehow carries it; nothing here writes it. Making it mean "staff blocked,
 * accountant may still post" needs a role-aware branch inside
 * `assertPeriodOpen`, which is the posting path and out of scope here.
 */

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * Closing is an accountant action; reopening is an owner action.
 *
 * Neither key exists in `PERMISSIONS` (`packages/db/src/seed/reference.ts`)
 * yet — they are named here and requested from the coordinator, because the
 * seed file is shared. Until they are seeded, `owner`'s `["*"]` expands over
 * the catalogue as it stands and therefore does NOT include them either, so
 * both actions refuse for everyone. That is the correct direction to be broken
 * in: a period nobody can close is an inconvenience, a period anybody can
 * reopen is the absence of the feature.
 */
export const PERM_CLOSE = "period:close";
export const PERM_REOPEN = "period:reopen";
/** Reading the checklist is reading the books. Reuses an existing key so the
 *  screen works for the accountant and the GM without a seed change. */
export const PERM_READ = "report:read";

/**
 * The second gate on reopening, on top of `period:reopen`.
 *
 * `roles.level` 90 is `owner`, 100 is `super_admin`; the accountant is 70. A
 * permission key alone is one `permission_overrides.grant` away from being
 * held by a level-30 receptionist — a supported operation that changes no role
 * — and the whole point of a period lock is that undoing it is harder than
 * doing it, not equally easy. Rank cannot be granted this way: it comes from
 * the role, and `users.ts` refuses to hand out rank the actor does not hold.
 */
export const REOPEN_MIN_ROLE_LEVEL = 90;

// ── Month arithmetic ────────────────────────────────────────────────────────

/** `YYYY-MM`, months 01–12 only. Anything else is not a period label. */
export const PERIOD_LABEL_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const periodLabel = z.string().regex(PERIOD_LABEL_RE, "Give a period as YYYY-MM.");

/**
 * The floor of the pre-history row.
 *
 * Far enough back that no genuine posting date precedes it, and a date rather
 * than `-infinity` so the row behaves like every other row in reports, in the
 * `BETWEEN` the guard uses, and in a CSV an accountant opens.
 */
const PRE_HISTORY_START = "1900-01-01";

/** Label of the pre-history row. `varchar(20)`; `pre-2025-04` is eleven. */
const preHistoryLabel = (firstMonth: string) => `pre-${firstMonth}`;

/** The month a posting date falls in. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function parseLabel(label: string): { year: number; month: number } {
  // money-guard-ignore: a calendar month number, not an amount.
  const year = Number.parseInt(label.slice(0, 4), 10);
  // money-guard-ignore: a calendar month number, not an amount.
  const month = Number.parseInt(label.slice(5, 7), 10);
  return { year, month };
}

/** First and last day of the month a label names. Bounds are derived from the
 *  label and never supplied by a caller — see the header. */
export function periodBounds(label: string): { startsOn: string; endsOn: string } {
  const { year, month } = parseLabel(label);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}

/** Shift a label by whole months. `shiftMonth("2026-01", -1) === "2025-12"`. */
export function shiftMonth(label: string, delta: number): string {
  const { year, month } = parseLabel(label);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** "2026-08" → "August 2026". Formatted here so the screen, the audit diff and
 *  the refusal message all say the same thing. */
export function displayPeriod(label: string): string {
  if (label.startsWith("pre-")) return `everything before ${displayPeriod(label.slice(4))}`;
  const { year, month } = parseLabel(label);
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  return `${name} ${year}`;
}

// ── Read model ──────────────────────────────────────────────────────────────

export type ChecklistSeverity = "blocking" | "warning" | "info";

export interface ChecklistItem {
  key: string;
  label: string;
  /** Why it matters once the month is frozen, in the accountant's language. */
  detail: string;
  severity: ChecklistSeverity;
  /** Zero means the item is satisfied. Never a bare boolean: "2 payments
   *  unallocated" is actionable, "unallocated payments: true" is not. */
  count: number;
  /** Storage-precision string, or null where the item has no amount. */
  amount: string | null;
  /** Where the accountant goes to fix it. */
  href: string | null;
}

export interface PeriodOverview {
  label: string;
  displayLabel: string;
  startsOn: string;
  endsOn: string;
  /** `unopened` is a period with no row: not closed, and not yet a period the
   *  system has an opinion about. See the header on fail-open. */
  status: "unopened" | "open" | "soft_closed" | "closed";
  closedAt: string | null;
  closedBy: string | null;
  /** False until the month has ended — a month still running cannot be closed. */
  hasEnded: boolean;
  journalCount: number;
  trialBalance: { debits: string; credits: string; balanced: boolean };
  checklist: ChecklistItem[];
  blocking: number;
  warnings: number;
  /** Labels offered in the period picker, newest first. */
  selectable: string[];
  /** Earlier months this close would freeze along with the target. */
  cascade: { months: number; earliest: string | null };
}

/** Shape every checklist query returns: how many, and how much. `execute`
 *  constrains its row type to `Record<string, unknown>`, hence the index. */
type CountRow = { n: number; amount: string | null } & Record<string, unknown>;

/**
 * The pre-close checklist.
 *
 * Everything the accountant would otherwise have to remember, with a count and
 * a link rather than a tick. Severity is the honest part:
 *
 *   `blocking` — the ledger is WRONG and freezing it preserves the error.
 *   `warning`  — the ledger is INCOMPLETE. Legitimate at a month end, but the
 *                accountant has to have seen it: close refuses unless the
 *                warnings are acknowledged in the same call.
 *   `info`     — context, never a gate.
 *
 * Splitting these three ways is not softness. A checklist where everything
 * blocks is a checklist that can never be satisfied on real data — this
 * tenant's seeded ledger has unreconciled bank lines going back to April 2025 —
 * and a control that cannot be satisfied is one that gets bypassed instead of
 * used.
 */
export async function preCloseChecklist(
  ctx: ServiceContext,
  bounds: { startsOn: string; endsOn: string },
): Promise<ChecklistItem[]> {
  const { startsOn, endsOn } = bounds;

  /**
   * Unbalanced journals. Expected to be zero, always: `journal_balance_check`
   * is a DEFERRED CONSTRAINT TRIGGER on `journal_lines` that raises at COMMIT
   * if SUM(base_debit) <> SUM(base_credit) for the journal, so an unbalanced
   * one cannot be committed through any path that goes through Postgres with
   * triggers on. It is checked anyway because the states that produce a
   * non-zero here — a restore, a `session_replication_role = replica` import,
   * a direct psql session — are exactly the states where nobody would think to
   * look, and freezing the month makes the imbalance permanent.
   */
  const [unbalanced] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, NULL::text AS amount
      FROM (
        SELECT jl.journal_id
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
         WHERE j.posting_date BETWEEN ${startsOn}::date AND ${endsOn}::date
         GROUP BY jl.journal_id
        HAVING SUM(jl.base_debit) <> SUM(jl.base_credit)
      ) unbalanced_journals
  `);

  /**
   * Cash drawers still open. Blocking, and the one item on this list that is
   * about physical money rather than bookkeeping: an unclosed session is cash
   * that has never been counted, so the month's cash figure is a guess. The
   * bound is "opened at any time before the month ended and still not closed",
   * not "opened during the month" — a drawer opened in June and never closed
   * is worse, not out of scope.
   */
  const [openSessions] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(opening_float), 0)::text AS amount
      FROM cash_register_sessions
     WHERE closed_at IS NULL
       AND opened_at < (${endsOn}::date + 1)
  `);

  /**
   * Inter-business balances that do not net. Blocking.
   *
   * Every inter-business transfer posts both legs, so `INTERCO_DUE_FROM` across
   * the group must equal `INTERCO_DUE_TO` across the group at any cut-off. A
   * residual means one side of a transfer posted and the other did not, and the
   * consolidated P&L eliminates the wrong amount. Measured cumulatively to the
   * period end rather than within the month, because a transfer raised in July
   * and settled in August nets only when both are in view.
   *
   * Q-12 (inter-business at cost vs arm's length) does not bear on this: the
   * two sides have to agree whatever the price is.
   */
  const [interco] = await ctx.tx.execute<{ due_from: string; due_to: string }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN a.system_key = 'INTERCO_DUE_FROM'
                        THEN jl.base_debit - jl.base_credit ELSE 0 END), 0)::text AS due_from,
      COALESCE(SUM(CASE WHEN a.system_key = 'INTERCO_DUE_TO'
                        THEN jl.base_credit - jl.base_debit ELSE 0 END), 0)::text AS due_to
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE a.system_key IN ('INTERCO_DUE_FROM', 'INTERCO_DUE_TO')
       AND j.posting_date <= ${endsOn}::date
  `);
  const intercoResidual = M.sub(M.fromDb(interco?.due_from), M.fromDb(interco?.due_to));

  /** Payments sitting as credit on account. A real state, not an error — but
   *  one that overstates AR for the month if it is a matching failure. */
  const [unallocated] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(unallocated_amount), 0)::text AS amount
      FROM payments
     WHERE voided_at IS NULL
       AND unallocated_amount > 0
       AND received_on <= ${endsOn}::date
  `);

  /** Drafts issued inside the month. Nothing is posted from a draft, so every
   *  one of these is revenue or cost the frozen month will not contain. */
  const [drafts] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::text AS amount
      FROM documents
     WHERE status = 'draft'
       AND issue_date BETWEEN ${startsOn}::date AND ${endsOn}::date
  `);

  /** Bank lines with no match. The month's bank balance is unproven until this
   *  is nil; carried forward from earlier months on purpose, because an
   *  unmatched March line is still unmatched in August. */
  const [bank] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(amount)), 0)::text AS amount
      FROM bank_transactions
     WHERE is_reconciled = false
       AND value_date <= ${endsOn}::date
  `);

  /**
   * Tills that were counted, came out wrong, and nobody wrote down why. The
   * variance itself is normal — a drawer almost never counts exactly. The
   * missing explanation is the finding, and it is a warning rather than a block
   * because no threshold has been agreed (open question Q-11); this asks only
   * that a non-zero variance carries a note, which needs no threshold at all.
   */
  const [variance] = await ctx.tx.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(variance)), 0)::text AS amount
      FROM cash_register_sessions
     WHERE closed_at >= ${startsOn}::date
       AND closed_at < (${endsOn}::date + 1)
       AND variance IS NOT NULL AND variance <> 0
       AND (variance_note IS NULL OR btrim(variance_note) = '')
  `);

  /**
   * Post-dated cheques still in the safe or with the bank at the cut-off.
   * Informational: a PDC portfolio in flight is the normal state of a Dubai
   * rental business and blocking on it would block every month forever. The
   * count is shown because a cheque whose date has passed and which is still
   * `held` — never even deposited — is an operational problem the close is a
   * good moment to notice.
   */
  const [cheques] = await ctx.tx.execute<{ n: number; amount: string; stale: number }>(sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(amount), 0)::text AS amount,
           COUNT(*) FILTER (WHERE status = 'held')::int AS stale
      FROM cheques
     WHERE status IN ('held', 'deposited')
       AND cheque_date <= ${endsOn}::date
  `);

  const items: ChecklistItem[] = [
    {
      key: "unbalanced_journals",
      label: "All journals balance",
      detail:
        "Enforced by the deferred constraint trigger on journal_lines, so this is a " +
        "restatement of a guarantee rather than a check that can normally fail.",
      severity: "blocking",
      count: unbalanced?.n ?? 0,
      amount: null,
      href: "/accounting/profit-loss",
    },
    {
      key: "open_cash_sessions",
      label: "All cash sessions closed",
      detail: "An uncounted drawer means the month's cash figure is an estimate.",
      severity: "blocking",
      count: openSessions?.n ?? 0,
      amount: openSessions?.amount ?? null,
      href: "/businesses",
    },
    {
      key: "interco_nets",
      label: "Inter-business balances net to nil",
      detail:
        "Due from group must equal due to group across the seven businesses. A residual " +
        "means one leg of a transfer posted and the other did not.",
      severity: "blocking",
      count: M.isZero(intercoResidual) ? 0 : 1,
      amount: M.isZero(intercoResidual) ? null : M.toDb(M.abs(intercoResidual)),
      href: "/businesses",
    },
    {
      key: "unallocated_payments",
      label: "Payments allocated to invoices",
      detail: "Money received and not matched to a document sits as credit on account.",
      severity: "warning",
      count: unallocated?.n ?? 0,
      amount: unallocated?.amount ?? null,
      href: "/receivables",
    },
    {
      key: "draft_documents",
      label: "No documents left in draft",
      detail: "A draft posts nothing, so this is revenue or cost the frozen month omits.",
      severity: "warning",
      count: drafts?.n ?? 0,
      amount: drafts?.amount ?? null,
      href: "/receivables",
    },
    {
      key: "bank_unreconciled",
      label: "Bank reconciled to the period end",
      detail: "Unmatched statement lines up to this date, including earlier months.",
      severity: "warning",
      count: bank?.n ?? 0,
      amount: bank?.amount ?? null,
      href: "/accounting/profit-loss",
    },
    {
      key: "cash_variance_unexplained",
      label: "Till variances explained",
      detail: "A drawer that did not count out, closed without a note saying why.",
      severity: "warning",
      count: variance?.n ?? 0,
      amount: variance?.amount ?? null,
      href: "/businesses",
    },
    {
      key: "cheques_in_flight",
      label: "Cheques in flight",
      detail:
        (cheques?.stale ?? 0) > 0
          ? `${cheques!.stale} past their date and still in the safe, never deposited.`
          : "Held or deposited and not yet cleared at the cut-off. Normal.",
      severity: "info",
      count: cheques?.n ?? 0,
      amount: cheques?.amount ?? null,
      href: "/rentals",
    },
  ];

  return items;
}

/**
 * Everything the close screen renders, for one period.
 *
 * Read-only. Gated on `report:read` rather than `period:close` so a GM can see
 * why the month is not closed yet without being able to close it.
 */
export async function getPeriodOverview(
  ctx: ServiceContext,
  raw?: { label?: string | null },
): Promise<PeriodOverview> {
  requirePermission(ctx, PERM_READ);

  const thisMonth = monthOf(ctx.today);
  /**
   * Default to the month that has just ended, not the one in progress. An
   * accountant arriving on this screen on 21 August is there to close July;
   * August cannot be closed until August is over.
   */
  const requested = raw?.label ?? undefined;
  const label =
    requested && PERIOD_LABEL_RE.test(requested) ? requested : shiftMonth(thisMonth, -1);
  const { startsOn, endsOn } = periodBounds(label);

  const [row] = await ctx.tx.execute<{
    status: string;
    closed_at: string | null;
    closed_by: string | null;
  }>(sql`
    SELECT p.status::text,
           to_char(p.closed_at, 'DD Mon YYYY') AS closed_at,
           u.full_name AS closed_by
      FROM fiscal_periods p
      LEFT JOIN users u ON u.id = p.closed_by_user_id
     WHERE p.label = ${label}
  `);

  const [tb] = await ctx.tx.execute<{ debits: string; credits: string; journals: number }>(sql`
    SELECT COALESCE(SUM(jl.base_debit), 0)::text AS debits,
           COALESCE(SUM(jl.base_credit), 0)::text AS credits,
           COUNT(DISTINCT j.id)::int AS journals
      FROM journals j
      LEFT JOIN journal_lines jl ON jl.journal_id = j.id
     WHERE j.posting_date BETWEEN ${startsOn}::date AND ${endsOn}::date
  `);

  const checklist = await preCloseChecklist(ctx, { startsOn, endsOn });
  const cascade = await cascadeScope(ctx, startsOn);

  const selectable: string[] = [];
  for (let i = 1; i <= 12; i++) selectable.push(shiftMonth(thisMonth, -i));
  if (!selectable.includes(label)) selectable.unshift(label);

  const debits = M.fromDb(tb?.debits);
  const credits = M.fromDb(tb?.credits);

  return {
    label,
    displayLabel: displayPeriod(label),
    startsOn,
    endsOn,
    status: (row?.status as PeriodOverview["status"]) ?? "unopened",
    closedAt: row?.closed_at ?? null,
    closedBy: row?.closed_by ?? null,
    hasEnded: endsOn < ctx.today,
    journalCount: tb?.journals ?? 0,
    trialBalance: {
      debits: M.toDb(debits),
      credits: M.toDb(credits),
      balanced: M.eq(M.quantize(debits), M.quantize(credits)),
    },
    checklist,
    blocking: checklist.filter((c) => c.severity === "blocking" && c.count > 0).length,
    warnings: checklist.filter((c) => c.severity === "warning" && c.count > 0).length,
    selectable,
    cascade,
  };
}

/**
 * How far back a close of this period would reach.
 *
 * Shown before the button is pressed, because "close August" quietly freezing
 * sixteen months of 2025 would be a surprise, and a confirmation the user
 * cannot predict the effect of is a click-through.
 */
async function cascadeScope(
  ctx: ServiceContext,
  targetStart: string,
): Promise<{ months: number; earliest: string | null }> {
  const [row] = await ctx.tx.execute<{ earliest: string | null; months: number }>(sql`
    WITH floor AS (
      SELECT LEAST(
               COALESCE((SELECT MIN(posting_date) FROM journals), ${targetStart}::date),
               COALESCE((SELECT MIN(starts_on) FROM fiscal_periods
                          WHERE starts_on > ${PRE_HISTORY_START}::date), ${targetStart}::date),
               ${targetStart}::date
             ) AS from_date
    )
    SELECT to_char(date_trunc('month', floor.from_date), 'YYYY-MM') AS earliest,
           GREATEST(
             (SELECT COUNT(*)::int FROM generate_series(
                date_trunc('month', floor.from_date),
                ${targetStart}::date - interval '1 month',
                interval '1 month') g
               WHERE NOT EXISTS (
                 SELECT 1 FROM fiscal_periods p
                  WHERE p.label = to_char(g, 'YYYY-MM') AND p.status = 'closed')),
             0
           ) AS months
      FROM floor
  `);
  return { earliest: row?.earliest ?? null, months: row?.months ?? 0 };
}

// ── Close ───────────────────────────────────────────────────────────────────

export const closePeriodInput = z.object({
  label: periodLabel,
  /** Free text kept in the audit record, not on the row — see `reopenPeriod`
   *  on why the audit log is the history of record here. */
  note: z.string().max(500).optional(),
  /**
   * The accountant states that they have read the warnings. Enforced in the
   * service, not by disabling a button: the screen hides the button too, but a
   * control that only exists in the UI is not a control.
   */
  acknowledgeWarnings: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface ClosePeriodResult {
  label: string;
  displayLabel: string;
  /** Earlier months frozen by the cascade, oldest first. */
  cascaded: string[];
  /** Journals whose NULL `fiscal_period_id` this close filled in. */
  journalsStamped: number;
}

/**
 * Close a period.
 *
 * The write that makes `assertPeriodOpen` reachable. Everything else in this
 * file exists to make this one UPDATE safe to press.
 */
export async function closePeriod(ctx: ServiceContext, raw: unknown): Promise<ClosePeriodResult> {
  const input = closePeriodInput.parse(raw);
  requirePermission(ctx, PERM_CLOSE);

  return withIdempotency(ctx, input.idempotencyKey, "closePeriod", async () => {
    const { label } = input;
    const { startsOn, endsOn } = periodBounds(label);

    // A month still running has takings in it that have not happened yet.
    if (endsOn >= ctx.today) {
      throw new ServiceError(
        `${displayPeriod(label)} has not ended yet. It can be closed from ${
          periodBounds(shiftMonth(label, 1)).startsOn
        }.`,
        "invalid",
      );
    }

    /**
     * Materialise the row before locking it. A period that has never been
     * touched has no row at all, so there is nothing to `SELECT ... FOR
     * UPDATE`; inserting first and then locking makes the two paths — first
     * close and re-close — identical, and lets the unique index arbitrate two
     * accountants pressing the button at the same moment rather than both
     * proceeding on "no row found".
     */
    await ctx.tx.execute(sql`
      INSERT INTO fiscal_periods (id, tenant_id, label, starts_on, ends_on, status)
      VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${label},
              ${startsOn}::date, ${endsOn}::date, 'open')
      ON CONFLICT (tenant_id, label) DO NOTHING
    `);

    const [period] = await ctx.tx.execute<{
      id: string;
      status: string;
      closed_by: string | null;
      closed_on: string | null;
    }>(sql`
      SELECT p.id, p.status::text,
             u.full_name AS closed_by,
             to_char(p.closed_at, 'DD Mon YYYY') AS closed_on
        FROM fiscal_periods p
        LEFT JOIN users u ON u.id = p.closed_by_user_id
       WHERE p.label = ${label}
       FOR UPDATE OF p
    `);
    if (!period) throw new ServiceError("That period could not be opened.", "not_found");

    if (period.status === "closed") {
      throw new ServiceError(
        `${displayPeriod(label)} was already closed by ${period.closed_by ?? "someone"}${
          period.closed_on ? ` on ${period.closed_on}` : ""
        }.`,
        "conflict",
      );
    }

    const checklist = await preCloseChecklist(ctx, { startsOn, endsOn });
    const blocking = checklist.filter((c) => c.severity === "blocking" && c.count > 0);
    if (blocking.length > 0) {
      throw new ServiceError(
        `${displayPeriod(label)} cannot be closed yet: ${blocking
          .map((b) => `${b.label.toLowerCase()} (${b.count})`)
          .join(", ")}.`,
        "invalid",
      );
    }

    const warnings = checklist.filter((c) => c.severity === "warning" && c.count > 0);
    if (warnings.length > 0 && !input.acknowledgeWarnings) {
      throw new ServiceError(
        `${warnings.length} item${warnings.length === 1 ? "" : "s"} on the checklist need${
          warnings.length === 1 ? "s" : ""
        } your confirmation before ${displayPeriod(label)} can be closed.`,
        "invalid",
      );
    }

    const cascaded = await freezeEarlierMonths(ctx, startsOn);

    await ctx.tx.execute(sql`
      UPDATE fiscal_periods
         SET status = 'closed',
             closed_at = now(),
             closed_by_user_id = ${ctx.principal.userId}::uuid,
             updated_at = now()
       WHERE id = ${period.id}::uuid
    `);

    /**
     * Give every journal in a closed period its `fiscal_period_id`.
     *
     * `postJournal` does not set it — the INSERT in `context.ts` lists eleven
     * columns and that is not one of them — so the FK has been NULL on every
     * journal ever written. Stamping at close time is the only place this file
     * can fill it without editing the posting path, and it is the right moment
     * anyway: membership of a period is decided by posting date, and at close
     * the set of dates in the period is final.
     *
     * ONLY NULLs are touched. A journal already pointing at a period keeps its
     * pointer, so a re-close after a reopen never repoints history, and the
     * amounts, dates and lines are untouched in every case — this UPDATE is on
     * `journals`, and the balance trigger is a constraint trigger on
     * `journal_lines`, so nothing it writes can disturb a posted entry.
     */
    const stamped = await ctx.tx.execute<{ id: string }>(sql`
      UPDATE journals j
         SET fiscal_period_id = p.id,
             updated_at = now()
        FROM fiscal_periods p
       WHERE j.fiscal_period_id IS NULL
         AND p.status = 'closed'
         AND j.posting_date BETWEEN p.starts_on AND p.ends_on
      RETURNING j.id
    `);

    await writeAudit(ctx, {
      action: "period.close",
      entityTable: "fiscal_periods",
      entityId: period.id,
      diff: {
        label,
        startsOn,
        endsOn,
        note: input.note ?? null,
        cascadedMonths: cascaded,
        journalsStamped: stamped.length,
        acknowledgedWarnings: warnings.map((w) => `${w.key}:${w.count}`),
        checklist: checklist.map((c) => `${c.key}:${c.count}`),
      },
    });

    return {
      label,
      displayLabel: displayPeriod(label),
      cascaded,
      journalsStamped: stamped.length,
    };
  });
}

/**
 * Freeze everything before the period being closed, and return what was frozen.
 *
 * Three statements because there are three distinct populations, and rolling
 * them into one would hide which of them did the work from the audit record:
 * months with no row, months with an open row, and the range before the ledger
 * begins.
 */
async function freezeEarlierMonths(ctx: ServiceContext, targetStart: string): Promise<string[]> {
  const closer = sql`now(), ${ctx.principal.userId}::uuid`;

  // 1. Months between the ledger's first posting and the target that have no
  //    row at all. Created closed, not open: an unmaterialised month is
  //    writable, and the whole point of the cascade is that it stops being so.
  const created = await ctx.tx.execute<{ label: string }>(sql`
    WITH floor AS (
      SELECT date_trunc('month', LEAST(
               COALESCE((SELECT MIN(posting_date) FROM journals), ${targetStart}::date),
               COALESCE((SELECT MIN(starts_on) FROM fiscal_periods
                          WHERE starts_on > ${PRE_HISTORY_START}::date), ${targetStart}::date),
               ${targetStart}::date
             )) AS from_date
    )
    INSERT INTO fiscal_periods
      (id, tenant_id, label, starts_on, ends_on, status, closed_at, closed_by_user_id)
    SELECT gen_random_uuid(), ${ctx.tenantId}::uuid,
           to_char(g, 'YYYY-MM'), g::date,
           (g + interval '1 month' - interval '1 day')::date,
           'closed', ${closer}
      FROM floor, generate_series(floor.from_date,
                                  ${targetStart}::date - interval '1 month',
                                  interval '1 month') g
    ON CONFLICT (tenant_id, label) DO NOTHING
    RETURNING label
  `);

  // 2. Earlier months that do have a row and are not closed.
  const reclosed = await ctx.tx.execute<{ label: string }>(sql`
    UPDATE fiscal_periods
       SET status = 'closed', closed_at = now(),
           closed_by_user_id = ${ctx.principal.userId}::uuid, updated_at = now()
     WHERE ends_on < ${targetStart}::date
       AND status <> 'closed'
    RETURNING label
  `);

  /**
   * 3. The pre-history row.
   *
   * Created once, never twice: a second one would overlap the first, and
   * `assertPeriodOpen`'s `LIMIT 1` would then return whichever the planner
   * chose. It is anchored to the ledger's first posting, which cannot move
   * earlier once this row exists — that is the row that prevents it.
   */
  const [floorRow] = await ctx.tx.execute<{ first_month: string }>(sql`
    SELECT to_char(date_trunc('month', LEAST(
             COALESCE((SELECT MIN(posting_date) FROM journals), ${targetStart}::date),
             COALESCE((SELECT MIN(starts_on) FROM fiscal_periods
                        WHERE starts_on > ${PRE_HISTORY_START}::date), ${targetStart}::date),
             ${targetStart}::date
           )), 'YYYY-MM') AS first_month
  `);
  const firstMonth = floorRow?.first_month ?? monthOf(targetStart);
  const prehistory = await ctx.tx.execute<{ label: string }>(sql`
    INSERT INTO fiscal_periods
      (id, tenant_id, label, starts_on, ends_on, status, closed_at, closed_by_user_id)
    SELECT gen_random_uuid(), ${ctx.tenantId}::uuid, ${preHistoryLabel(firstMonth)},
           ${PRE_HISTORY_START}::date,
           (${periodBounds(firstMonth).startsOn}::date - 1),
           'closed', ${closer}
     WHERE NOT EXISTS (
       SELECT 1 FROM fiscal_periods WHERE starts_on = ${PRE_HISTORY_START}::date
     )
    ON CONFLICT (tenant_id, label) DO NOTHING
    RETURNING label
  `);

  return [...created, ...reclosed, ...prehistory].map((r) => r.label).sort();
}

// ── Reopen ──────────────────────────────────────────────────────────────────

export const reopenPeriodInput = z.object({
  label: periodLabel,
  /**
   * The label typed back. Not theatre: it is the difference between "I clicked
   * the reopen button on the row I was looking at" and "I intend to unlock
   * July", and it is checked in the service so the API has the same gate the
   * screen does.
   */
  confirmLabel: z.string(),
  /** Long enough to be a sentence. "fix" is not a reason a future auditor can
   *  use, and this record is the only place the reason survives. */
  reason: z.string().min(20).max(500),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface ReopenPeriodResult {
  label: string;
  displayLabel: string;
  /** Journals that become writable-around again — the size of the hole. */
  journalsAffected: number;
}

/**
 * Reopen a closed period. DELIBERATELY HARDER THAN CLOSING IT.
 *
 * A lock whose key is as easy to turn as the bolt is a latch. Five gates,
 * against closing's one permission plus a checklist:
 *
 *   1. `period:reopen`, a separate key from `period:close`, seeded to the owner
 *      only.
 *   2. Role level 90 or above, so an override that hands out the key does not
 *      hand out the capability. Closing has no rank floor.
 *   3. The label typed back, checked here rather than in the browser.
 *   4. A reason of at least twenty characters, mandatory. Closing's note is
 *      optional.
 *   5. NEWEST FIRST. June cannot be reopened while July and August are closed.
 *      Reopening a month under two closed months would let a backdated entry
 *      change a June the August close has already reported on, which is the
 *      exact failure the lock exists to stop — and it is why the cascade in
 *      `closePeriod` has no counterpart here. Closing sweeps backwards;
 *      reopening moves one month at a time, forwards from the newest.
 *
 * And the pre-history row cannot be reopened at all. It is not a month anyone
 * needs to post into; it is the floor under the whole ledger.
 *
 * The row keeps no reopen columns. `fiscal_periods` has `closed_at` and
 * `closed_by_user_id` and nothing else, and adding a reopen trio would be a
 * migration for data the audit log already holds better: `audit_log` records
 * every reopen with actor, time, IP, request id and the reason, and it records
 * the second and third reopen too, which three columns on the row cannot.
 * Clearing `closed_at` here is therefore not losing history — the history is in
 * `audit_log`, and leaving a `closed_at` on an open period would be a lie the
 * screen would go on to render.
 */
export async function reopenPeriod(ctx: ServiceContext, raw: unknown): Promise<ReopenPeriodResult> {
  const input = reopenPeriodInput.parse(raw);
  requirePermission(ctx, PERM_REOPEN);

  if (!(ctx.principal.roleLevel >= REOPEN_MIN_ROLE_LEVEL)) {
    throw new ServiceError(
      "Reopening a closed period is an owner action. Ask the owner to reopen it.",
      "forbidden",
    );
  }
  if (input.confirmLabel.trim() !== input.label) {
    throw new ServiceError(
      `Type ${input.label} to confirm which period you are reopening.`,
      "invalid",
    );
  }

  return withIdempotency(ctx, input.idempotencyKey, "reopenPeriod", async () => {
    const { label } = input;
    const { startsOn, endsOn } = periodBounds(label);

    const [period] = await ctx.tx.execute<{
      id: string;
      status: string;
      starts_on: string;
    }>(sql`
      SELECT id, status::text, starts_on::text
        FROM fiscal_periods
       WHERE label = ${label}
       FOR UPDATE
    `);
    if (!period) {
      throw new ServiceError(`${displayPeriod(label)} has never been closed.`, "not_found");
    }
    if (period.status !== "closed") {
      throw new ServiceError(`${displayPeriod(label)} is already open.`, "invalid");
    }
    if (period.starts_on === PRE_HISTORY_START) {
      throw new ServiceError(
        "The pre-ledger period is the floor under the ledger and cannot be reopened.",
        "forbidden",
      );
    }

    const [newer] = await ctx.tx.execute<{ label: string }>(sql`
      SELECT label FROM fiscal_periods
       WHERE status = 'closed' AND starts_on > ${startsOn}::date
       ORDER BY starts_on ASC
       LIMIT 1
    `);
    if (newer) {
      throw new ServiceError(
        `${displayPeriod(newer.label)} is closed and comes after ${displayPeriod(label)}. ` +
          "Reopen periods newest first.",
        "conflict",
      );
    }

    const [affected] = await ctx.tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM journals
       WHERE posting_date BETWEEN ${startsOn}::date AND ${endsOn}::date
    `);

    await ctx.tx.execute(sql`
      UPDATE fiscal_periods
         SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, updated_at = now()
       WHERE id = ${period.id}::uuid
    `);

    await writeAudit(ctx, {
      action: "period.reopen",
      entityTable: "fiscal_periods",
      entityId: period.id,
      diff: {
        label,
        startsOn,
        endsOn,
        reason: input.reason,
        journalsAffected: affected?.n ?? 0,
      },
    });

    return {
      label,
      displayLabel: displayPeriod(label),
      journalsAffected: affected?.n ?? 0,
    };
  });
}
