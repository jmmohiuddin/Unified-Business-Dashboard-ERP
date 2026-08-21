import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import * as M from "../money/index.ts";
import { MANUAL_ENTRY_DEFAULTS } from "./manual-entry.ts";

/**
 * THE OWNER LEDGER — FR-M05, WF-05 §5, JTBD J2.
 *
 * What the owner has put into each business and what he has taken back out,
 * with a clock on it.
 *
 * WHY THIS SCREEN EXISTS AT ALL. Wave 2 built both halves of the entry —
 * `recordOwnerContribution` posts to 3100 Owner Capital, `recordOwnerDrawing`
 * to 3200 Owner Drawings — and `ownerPosition` in `manual-entry.ts` returns the
 * running figure for ONE business or for the group. Nothing read it back as a
 * ledger. So the data existed and the question the owner actually asks — "which
 * of these am I funding out of the others?" — had no answer anywhere in the
 * product. The audit marked J2 partially served for precisely this reason.
 *
 * THE CLOCK IS THE POINT. A running total says AED 286,673 is drawn. It cannot
 * say that AED 56,027 of that has been sitting there since February, and it is
 * the age, not the amount, that makes a director's-loan balance a problem: the
 * research's documented failure is a balance nobody re-examines for years, at
 * which point it is a corporate-tax and a related-party disclosure question
 * rather than a bookkeeping one. Hence FIFO ageing (below) and the two flags.
 *
 * IT POSTS NOTHING. Read-only, and deliberately shaped like `loadCashBoard`
 * rather than like a service entry point: it takes a `Tx`, not a
 * `ServiceContext`, because a page render has no idempotency key, writes no
 * journal and should not look like something that could. Permission is checked
 * by the caller, which is also what chooses between the screen and its
 * permission-denied state — `canViewOwnerLedger` is the predicate for both.
 *
 * NO STORED BALANCE. Every figure here is re-derived from `journal_lines` on
 * each read, following `interBusinessBalances`. A materialised owner balance is
 * a balance that can drift from the journals it claims to summarise, and this
 * is the one account in the chart where a drift would be indistinguishable from
 * a theft — 3200 never reaches the P&L, which is exactly why the header of
 * `manual-entry.ts` names it as the place someone would hide one.
 */

/* ── Who may read it ──────────────────────────────────────────────────────── */

/**
 * `report:read`, the same permission `ownerPosition` requires.
 *
 * Deliberately NOT a new permission key. The figures on this screen are the
 * ones `ownerPosition` already returns to `/cash`, so inventing a second key
 * would mean a role could hold one and not the other while seeing the same
 * numbers on two screens — a distinction with no meaning that would eventually
 * be enforced inconsistently.
 */
export const OWNER_LEDGER_PERMISSION = "report:read";

/** Can this principal look at the owner ledger at all? */
export function canViewOwnerLedger(permissions: Set<string>): boolean {
  return permissions.has(OWNER_LEDGER_PERMISSION);
}

/* ── Q-10 · the two thresholds nobody has answered yet ────────────────────── */

export interface OwnerLedgerThresholds {
  /** A balance untouched for longer than this is flagged as stale. */
  staleAfterDays: number;
  /** A net DRAWN balance above this is flagged as material. */
  materiality: number;
  /**
   * False when the tenant has set neither and both figures are the placeholder.
   *
   * The screen renders this. A threshold presented without it reads as policy
   * the owner agreed to, and Q-10 is explicitly the case where nobody has: the
   * PRD lists "materiality and staleness thresholds for the owner ledger" as
   * open with the owner and the accountant, and BRIEF2 says not to guess. So
   * the default is used, is stated as a default on screen, and is one settings
   * write away from being the real answer — no code change, no deploy.
   */
  configured: boolean;
  /** Which of the two the tenant has actually chosen, for a precise caption. */
  staleConfigured: boolean;
  materialityConfigured: boolean;
}

/**
 * Read the tenant's thresholds off `tenants.settings.manualEntry`.
 *
 * The same block `readSettings` in `manual-entry.ts` reads, and the same
 * defaults — imported rather than restated, so the two cannot drift into
 * disagreeing about what "stale" means on two screens. It is a separate
 * function only because `readSettings` is module-private and takes a
 * `ServiceContext`; this is the `Tx`-shaped twin, exactly as
 * `resolveCashVarianceThreshold` is for the cash register.
 *
 * Anything missing, malformed or of the wrong type falls back to the default
 * rather than throwing, for the reason `readSettings` gives: a typo in a
 * settings blob must not take a read-only screen down.
 */
export async function resolveOwnerLedgerThresholds(tx: Tx): Promise<OwnerLedgerThresholds> {
  const [row] = await tx.execute<{ settings: Record<string, unknown> | null }>(sql`
    SELECT settings FROM tenants LIMIT 1
  `);
  const block = (row?.settings?.manualEntry ?? {}) as Record<string, unknown>;

  // Read exactly as `readSettings` reads it, coercion included. The two must
  // agree on what "stale" means or the flag on this screen and the flag on the
  // owner's position elsewhere would disagree for the same tenant.
  const days = Number(block.ownerLedgerStaleDays); // money-guard-ignore: a day count is an interval, not an amount.
  const staleConfigured = Number.isInteger(days) && days > 0;

  let materiality = M.money(MANUAL_ENTRY_DEFAULTS.ownerLedgerMaterialityAed);
  let materialityConfigured = false;
  const rawMateriality = block.ownerLedgerMaterialityAed;
  if (typeof rawMateriality === "string" || typeof rawMateriality === "number") {
    try {
      const parsed = M.money(rawMateriality);
      if (parsed.isFinite() && !M.isNegative(parsed)) {
        materiality = parsed;
        materialityConfigured = true;
      }
    } catch {
      // Malformed. Keep the default and report it as unconfigured, which is the
      // truth: nobody chose this number.
    }
  }

  return {
    staleAfterDays: staleConfigured ? days : MANUAL_ENTRY_DEFAULTS.ownerLedgerStaleDays,
    materiality: M.toNumber(materiality),
    configured: staleConfigured && materialityConfigured,
    staleConfigured,
    materialityConfigured,
  };
}

/* ── Shapes ───────────────────────────────────────────────────────────────── */

export interface OwnerLedgerPosition {
  /** Null is the UNALLOCATED bucket — see `UNALLOCATED_NAME` below. */
  businessUnitId: string | null;
  code: string | null;
  name: string;
  colorToken: string;
  /** Money put in THROUGH the product. Excludes opening capital, as
   *  `ownerPosition` does and for the same reason. */
  contributed: number;
  /** Money taken out. */
  drawn: number;
  /** `contributed − drawn`. Positive: the owner is funding this business.
   *  Negative: he is living off it. */
  net: number;
  /** Capital brought forward at go-live. Kept apart from `contributed` so the
   *  first day of the ledger does not read as a multi-million contribution. */
  openingCapital: number;
  lastMovementOn: string | null;
  daysSinceLastMovement: number | null;
  /** FIFO age of the oldest drawing not yet covered by a contribution. Null
   *  when nothing is outstanding. */
  ageDays: number | null;
  oldestUnsettledOn: string | null;
  /** Q-10 flags. */
  isStale: boolean;
  isMaterial: boolean;
  /** Journals, not lines — "7 movements" must not become 14. */
  movements: number;
}

export interface OwnerLedgerMovement {
  journalId: string;
  journalNumber: string;
  on: string;
  /** `in` = contribution, `out` = drawing. */
  direction: "in" | "out";
  amount: number;
  businessUnitId: string | null;
  businessUnitName: string;
  colorToken: string;
  /** The `CAPIN-…` / `DRAW-…` payment number, when the entry came through the
   *  cash screen rather than a manual journal. */
  reference: string | null;
  narration: string | null;
}

export interface OwnerLedgerAgeingBucket {
  key: string;
  label: string;
  /** Net drawn still outstanding in this age band. Never negative. */
  amount: number;
  /** Inclusive lower bound in days; `null` upper bound means open-ended. */
  fromDays: number;
  toDays: number | null;
}

export interface OwnerLedger {
  asOf: string;
  thresholds: OwnerLedgerThresholds;
  /** The whole portfolio, including anything posted without a business. */
  group: OwnerLedgerPosition;
  /** One row per business that has ever had an owner movement, biggest
   *  absolute position first. */
  businesses: OwnerLedgerPosition[];
  ageing: OwnerLedgerAgeingBucket[];
  movements: OwnerLedgerMovement[];
  /** Businesses tripping either flag, worst first. */
  flagged: OwnerLedgerPosition[];
  /**
   * The one sentence WF-05 §5 asks for, or null when the data does not support
   * one. See `conclude`.
   */
  conclusion: string | null;
}

/**
 * What a row with no business unit is called on screen.
 *
 * It is NOT cosmetic and it is not a defensive `?? "Unknown"`. `journal_lines.
 * business_unit_id` is nullable and the seeded owner drawings are posted with
 * it null — group-level entries against 3200 with no business named. If those
 * rows were dropped, the by-business list would total AED 0 while the headline
 * net position said AED 286,673 drawn, and there would be nothing on the screen
 * explaining the gap. A visible bucket that makes the two agree is the honest
 * rendering, and it doubles as the prompt to go and allocate them.
 */
export const UNALLOCATED_NAME = "Not allocated to a business";

/* ── The read ─────────────────────────────────────────────────────────────── */

/** A business id, the unallocated bucket, or every movement there is. */
export type OwnerMovementScope = string | "unallocated" | undefined;

/**
 * The movement-list filter, shared by the count and the page.
 *
 * One function rather than the clause written twice, because the two MUST
 * agree: a count taken over a wider set than the rows it labels produces a
 * pager promising pages that render empty, which reads as data loss on a screen
 * about the owner's own money.
 */
function movementFilter(scope: OwnerMovementScope) {
  if (scope === undefined) return sql``;
  if (scope === "unallocated") return sql` AND jl.business_unit_id IS NULL`;
  return sql` AND jl.business_unit_id = ${scope}::uuid`;
}

/**
 * How many owner movements match, for the pager.
 *
 * Separate from `loadOwnerLedger` and called BEFORE it, because `pageSlice`
 * needs the real total to clamp an out-of-range `?page=` and to compute the
 * offset the row query then uses. Same convention as every other paged screen
 * in the app: count, slice, rows.
 */
export async function countOwnerMovements(
  tx: Tx,
  opts: { asOf: string; businessUnitId?: OwnerMovementScope },
): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM (
      SELECT j.id, jl.business_unit_id
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.system_key IN ('CAPITAL', 'DRAWINGS')
         AND j.source <> 'opening'
         AND j.posting_date <= ${opts.asOf}::date
         ${movementFilter(opts.businessUnitId)}
       GROUP BY 1, 2
    ) z
  `);
  return row?.n ?? 0;
}

/** Row of the daily-grain aggregate, per business per posting date.
 *  Indexed because `execute<T>` requires it — hence the snake_case keys. */
interface DayRow extends Record<string, unknown> {
  bu_id: string | null;
  code: string | null;
  name: string | null;
  color_token: string | null;
  on_date: string;
  contributed: string;
  drawn: string;
  opening: string;
  movements: number;
}

/**
 * Everything `/finance/owner` renders, in one transaction.
 *
 * THE GRAIN IS ONE DAY PER BUSINESS, and that is a decision rather than a
 * convenience. It is the coarsest grain the FIFO ageing can run at without
 * lying, and the finest it can run at without lying in the other direction: a
 * contribution and a drawing on the SAME day never left the business overnight,
 * so netting them before ageing sees either is the right answer and stops
 * same-day churn starting an ageing clock. `interBusinessMovement` nets per day
 * for exactly this reason; the convention is deliberately shared.
 *
 * Two queries plus a count, not one per business. Seven businesses × one
 * `ownerPosition` call each would be eight aggregate passes over
 * `journal_lines` to render one screen, and the group figure would be derived
 * separately from the rows underneath it — which is how a total stops agreeing
 * with its own breakdown. Here the group IS the sum of the rows, by
 * construction.
 */
export async function loadOwnerLedger(
  tx: Tx,
  opts: {
    /** Tenant-local today. Everything after it is excluded. */
    asOf: string;
    /** Movement list filter: a business id, `"unallocated"`, or absent for all. */
    businessUnitId?: OwnerMovementScope;
    /** Movement page. */
    limit?: number;
    offset?: number;
  },
): Promise<OwnerLedger> {
  const { asOf } = opts;
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;

  const thresholds = await resolveOwnerLedgerThresholds(tx);

  /*
   * Sign conventions, stated once because getting one backwards inverts the
   * whole screen:
   *
   *   · CAPITAL (3100) is equity, normal balance CREDIT, so money IN is
   *     `credit − debit`.
   *   · DRAWINGS (3200) is a contra-equity account, normal balance DEBIT, so
   *     money OUT is `debit − credit`.
   *   · `source = 'opening'` is the go-live balance and is separated out. It is
   *     not a contribution — it is what the books started from, and folding it
   *     in makes day one look like a AED 4.5m capital injection.
   */
  const rows = await tx.execute<DayRow>(sql`
    SELECT jl.business_unit_id AS bu_id, b.code, b.name, b.color_token,
           j.posting_date::text AS on_date,
           COALESCE(SUM(jl.base_credit - jl.base_debit)
             FILTER (WHERE a.system_key = 'CAPITAL' AND j.source <> 'opening'), 0) AS contributed,
           COALESCE(SUM(jl.base_debit - jl.base_credit)
             FILTER (WHERE a.system_key = 'DRAWINGS' AND j.source <> 'opening'), 0) AS drawn,
           COALESCE(SUM(jl.base_credit - jl.base_debit)
             FILTER (WHERE j.source = 'opening'), 0) AS opening,
           COUNT(DISTINCT j.id) FILTER (WHERE j.source <> 'opening')::int AS movements
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN business_units b ON b.id = jl.business_unit_id
     WHERE a.system_key IN ('CAPITAL', 'DRAWINGS')
       AND j.posting_date <= ${asOf}::date
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 5
  `);

  /* Per business, then the group as the sum of them. */
  const byBusiness = new Map<string, { row: DayRow; days: DayRow[] }>();
  const groupDays = new Map<string, { contributed: M.Money; drawn: M.Money }>();

  for (const r of rows) {
    const key = r.bu_id ?? "";
    let entry = byBusiness.get(key);
    if (!entry) {
      entry = { row: r, days: [] };
      byBusiness.set(key, entry);
    }
    entry.days.push(r);

    const day = groupDays.get(r.on_date) ?? { contributed: M.ZERO, drawn: M.ZERO };
    day.contributed = M.add(day.contributed, M.fromDb(r.contributed));
    day.drawn = M.add(day.drawn, M.fromDb(r.drawn));
    groupDays.set(r.on_date, day);
  }

  const derived = [...byBusiness.values()].map(({ row, days }) =>
    derive(
      {
        businessUnitId: row.bu_id,
        code: row.code,
        name: row.name ?? UNALLOCATED_NAME,
        colorToken: row.color_token ?? "slate",
      },
      days.map((d) => ({
        on: d.on_date,
        contributed: M.fromDb(d.contributed),
        drawn: M.fromDb(d.drawn),
        opening: M.fromDb(d.opening),
        movements: d.movements,
      })),
      asOf,
      thresholds,
    ),
  );

  const businesses = derived
    .map((d) => d.position)
    // Biggest position first regardless of direction: the business the owner
    // has taken most out of and the one he has put most into are both the
    // answer to J2, and sorting by signed value would bury one of them.
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name));

  const group = derive(
    { businessUnitId: null, code: null, name: "Group", colorToken: "slate" },
    [...groupDays.entries()]
      .map(([on, d]) => ({
        on,
        contributed: d.contributed,
        drawn: d.drawn,
        opening: M.ZERO,
        movements: 0,
      }))
      .sort((a, b) => a.on.localeCompare(b.on)),
    asOf,
    thresholds,
  ).position;
  // The group's scalar totals are the sum of the rows underneath it, not a
  // second derivation — a headline that disagrees with its own breakdown is the
  // single most corrosive thing a finance screen can do.
  group.openingCapital = sumOf(businesses, (p) => p.openingCapital);
  group.movements = businesses.reduce((n, p) => n + p.movements, 0);

  // Aged per business and then summed, NOT aged over the group's netted
  // series. Those differ, and only the first is meaningful: a contribution into
  // the salon does not settle a drawing taken out of the property company, and
  // netting across businesses before ageing would let one business's fresh
  // capital hide another's two-year-old balance — the exact thing this screen
  // exists to expose.
  const groupOpen = derived
    .flatMap((d) => d.open)
    .sort((a, b) => a.on.localeCompare(b.on));
  const ageing = ageingBuckets(groupOpen, thresholds.staleAfterDays);

  // The group's ageing facts come from that SAME union, for the same reason.
  // `derive` computed them off the netted series a moment ago, which would put
  // a different oldest date in the headline from the one the table underneath
  // it buckets — the stat strip saying "oldest 20 days" over a table showing
  // AED 47,000 in the over-360 band.
  group.ageDays = groupOpen.length > 0 ? groupOpen[0]!.ageDays : null;
  group.oldestUnsettledOn = groupOpen.length > 0 ? groupOpen[0]!.on : null;

  const buFilter = movementFilter(opts.businessUnitId);

  const movementRows = await tx.execute<{
    id: string; journal_number: string; on_date: string; narration: string | null;
    bu_id: string | null; bu_name: string | null; color_token: string | null;
    in_amount: string; out_amount: string; payment_number: string | null;
  }>(sql`
    SELECT j.id, j.journal_number, j.posting_date::text AS on_date, j.narration,
           jl.business_unit_id AS bu_id, b.name AS bu_name, b.color_token,
           COALESCE(SUM(jl.base_credit - jl.base_debit)
             FILTER (WHERE a.system_key = 'CAPITAL'), 0) AS in_amount,
           COALESCE(SUM(jl.base_debit - jl.base_credit)
             FILTER (WHERE a.system_key = 'DRAWINGS'), 0) AS out_amount,
           p.payment_number
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN business_units b ON b.id = jl.business_unit_id
      LEFT JOIN payments p ON j.source_table = 'payments' AND p.id = j.source_id
     WHERE a.system_key IN ('CAPITAL', 'DRAWINGS')
       AND j.source <> 'opening'
       AND j.posting_date <= ${asOf}::date
       ${buFilter}
     GROUP BY j.id, j.journal_number, j.posting_date, j.narration,
              jl.business_unit_id, b.name, b.color_token, p.payment_number
     -- Trailing journal_number makes the sort total. Owner entries land in
     -- batches on the same posting date, and OFFSET paging over a
     -- non-deterministic order repeats rows on one page and drops them from
     -- another.
     ORDER BY j.posting_date DESC, j.journal_number DESC
     LIMIT ${limit} OFFSET ${offset}
  `);

  const movements: OwnerLedgerMovement[] = movementRows.map((r) => {
    const inAmount = M.fromDb(r.in_amount);
    const outAmount = M.fromDb(r.out_amount);
    const net = M.sub(outAmount, inAmount);
    const out = !M.isNegative(net);
    return {
      journalId: r.id,
      journalNumber: r.journal_number,
      on: r.on_date,
      direction: out ? "out" : "in",
      amount: M.toNumber(M.abs(net)),
      businessUnitId: r.bu_id,
      businessUnitName: r.bu_name ?? UNALLOCATED_NAME,
      colorToken: r.color_token ?? "slate",
      reference: r.payment_number,
      narration: r.narration,
    };
  });

  return {
    asOf,
    thresholds,
    group,
    businesses,
    ageing,
    movements,
    flagged: businesses
      .filter((p) => p.isStale || p.isMaterial)
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
    conclusion: conclude(businesses),
  };
}

/* ── Derivation ───────────────────────────────────────────────────────────── */

interface Day {
  on: string;
  contributed: M.Money;
  drawn: M.Money;
  opening: M.Money;
  movements: number;
}

function sumOf(rows: OwnerLedgerPosition[], pick: (r: OwnerLedgerPosition) => number): number {
  return M.toNumber(M.sum(rows.map((r) => M.money(pick(r)))));
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO dates. Parsed as UTC midnight both ends, so a
 *  daylight-saving boundary cannot make an age 89.96 days and round it down. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/** A drawing still outstanding, with its age. */
interface OpenDrawing {
  on: string;
  amount: M.Money;
  ageDays: number;
}

/**
 * One business's position AND the drawings still open behind it.
 *
 * Returned together because the ageing table needs the second and the
 * by-business list needs the first, and deriving them in two passes would let
 * a row's `ageDays` disagree with the bucket its money landed in.
 */
function derive(
  identity: {
    businessUnitId: string | null;
    code: string | null;
    name: string;
    colorToken: string;
  },
  days: Day[],
  asOf: string,
  thresholds: OwnerLedgerThresholds,
): { position: OwnerLedgerPosition; open: OpenDrawing[] } {
  const ordered = [...days].sort((a, b) => a.on.localeCompare(b.on));

  const contributed = M.sum(ordered.map((d) => d.contributed));
  const drawn = M.sum(ordered.map((d) => d.drawn));
  const net = M.sub(contributed, drawn);

  // The clock is driven by MOVEMENTS, so the opening journal does not reset it:
  // a balance that has not moved since go-live is precisely the case the stale
  // flag exists for. `ownerPosition` makes the same exclusion.
  const moved = ordered.filter(
    (d) => d.movements > 0 || !M.isZero(d.contributed) || !M.isZero(d.drawn),
  );
  const lastMovementOn = moved.length > 0 ? moved[moved.length - 1]!.on : null;
  const daysSince = lastMovementOn === null ? null : daysBetween(lastMovementOn, asOf);

  const open = openDrawings(ordered, asOf);

  return {
    open,
    position: {
      ...identity,
      contributed: M.toNumber(contributed),
      drawn: M.toNumber(drawn),
      net: M.toNumber(net),
      openingCapital: M.toNumber(M.sum(ordered.map((d) => d.opening))),
      lastMovementOn,
      daysSinceLastMovement: daysSince,
      ageDays: open.length > 0 ? open[0]!.ageDays : null,
      oldestUnsettledOn: open.length > 0 ? open[0]!.on : null,
      isStale:
        daysSince !== null && daysSince > thresholds.staleAfterDays && M.gt(M.abs(net), M.ZERO),
      isMaterial: M.gt(M.abs(net), M.money(thresholds.materiality)) && M.isNegative(net),
      movements: ordered.reduce((n, d) => n + d.movements, 0),
    },
  };
}

/**
 * FIFO ageing of the drawn balance.
 *
 * Drawings are the charges; contributions settle the OLDEST of them first. That
 * convention is not arbitrary and it is not a free choice — it is the same one
 * `allocatePayment` uses for customer invoices and `ageOldestUnsettled` uses
 * for inter-business balances, and it is the only one that behaves correctly
 * when a balance is genuinely being repaid: settling the NEWEST drawing first
 * would leave a permanently ancient residue on a loan account the owner is
 * actually paying down, and the screen would keep shouting about it forever.
 *
 * Returns the still-open drawings, oldest first. Empty when the owner is in a
 * net contributed position — he cannot owe the business money it has not lent
 * him.
 */
function openDrawings(days: Day[], asOf: string): OpenDrawing[] {
  const open: { on: string; amount: M.Money }[] = [];

  for (const day of days) {
    // Netted per day before ageing sees it: money out and back in on one day
    // was never outstanding overnight.
    const delta = M.sub(day.drawn, day.contributed);
    if (M.isZero(delta)) continue;

    if (M.gt(delta, M.ZERO)) {
      open.push({ on: day.on, amount: delta });
      continue;
    }

    let credit = M.neg(delta);
    while (M.gt(credit, M.ZERO) && open.length > 0) {
      const head = open[0]!;
      const take = M.min(credit, head.amount);
      head.amount = M.sub(head.amount, take);
      credit = M.sub(credit, take);
      if (M.isZero(head.amount)) open.shift();
    }
    // Any credit left over is a net contribution beyond everything ever drawn.
    // It is NOT carried as a negative age bucket — the owner having money in
    // the business is a balance-sheet fact, not an overdue one.
  }

  return open
    .filter((o) => M.gt(o.amount, M.ZERO))
    .map((o) => ({ ...o, ageDays: daysBetween(o.on, asOf) }));
}

/**
 * Age bands for the group's outstanding drawings.
 *
 * The first boundary IS the staleness threshold, and the rest are multiples of
 * it. That ties the ageing table to the flag above it: everything past the
 * first band is, by the tenant's own definition, a balance that has sat too
 * long. Hardcoding 30/60/90 here would have produced a table whose bands said
 * one thing and whose warning banner said another, and when Q-10 is answered
 * the bands move with the answer instead of needing a second edit.
 */
function ageingBuckets(open: OpenDrawing[], staleAfterDays: number): OwnerLedgerAgeingBucket[] {
  const s = staleAfterDays;
  const bands = [
    { key: "current", label: `Up to ${s} days`, fromDays: 0, toDays: s as number | null },
    { key: "aged1", label: `${s + 1} to ${s * 2} days`, fromDays: s + 1, toDays: s * 2 as number | null },
    { key: "aged2", label: `${s * 2 + 1} to ${s * 4} days`, fromDays: s * 2 + 1, toDays: s * 4 as number | null },
    { key: "aged3", label: `Over ${s * 4} days`, fromDays: s * 4 + 1, toDays: null as number | null },
  ];

  const totals = bands.map(() => M.ZERO);
  for (const drawing of open) {
    // The last band is open-ended, so an age past every upper bound lands
    // there rather than being dropped. `findIndex` returning -1 on a future-
    // dated entry would otherwise silently delete money from the table.
    let index = bands.findIndex((b) => b.toDays === null || drawing.ageDays <= b.toDays);
    if (index < 0) index = bands.length - 1;
    totals[index] = M.add(totals[index]!, drawing.amount);
  }

  return bands.map((b, i) => ({ ...b, amount: M.toNumber(totals[i]!) }));
}

/**
 * The sentence WF-05 §5 asks for — "You fund e-commerce from property income."
 *
 * Written as a DESCRIPTION of the movements rather than as the causal claim the
 * wireframe drafts, and the difference is not pedantry. The ledger can show
 * that money left one business and entered another; it cannot show that the
 * second was funded by the first, because the owner may equally have been
 * paying school fees out of one and putting a bank loan into the other. A
 * finance screen that states a cause it cannot evidence is how a product
 * teaches its user to distrust it.
 *
 * Null when the data does not support a sentence. A conclusion invented to fill
 * a card is worse than an empty card.
 */
function conclude(businesses: OwnerLedgerPosition[]): string | null {
  const real = businesses.filter((b) => b.businessUnitId !== null);
  const funded = real.filter((b) => b.net > 0).sort((a, b) => b.net - a.net);
  const drawnFrom = real.filter((b) => b.net < 0).sort((a, b) => a.net - b.net);

  if (funded.length > 0 && drawnFrom.length > 0) {
    return `You take money out of ${drawnFrom[0]!.name} and put money into ${funded[0]!.name}.`;
  }
  if (drawnFrom.length > 1 && funded.length === 0) {
    return `You have taken money out of ${drawnFrom.length} businesses and put none back into any of them.`;
  }
  return null;
}
