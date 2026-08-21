import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import { createInvoice } from "./sales.ts";
import { createCreditNote } from "./credit-notes.ts";
import { transitionCheque } from "./payments.ts";
import {
  ServiceError,
  nextDocumentNumber,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * RENTALS — the lease lifecycle and the rent run.
 *
 * The pilot business, and until now the only module in the product that was
 * pure read: `rentals/page.tsx` rendered 41 leases and 56 units and offered no
 * way to create, renew or terminate any of them, and the 34 monthly rent
 * invoices were raised by hand. PRD §6 Epic B calls the rent run the highest
 * return per unit of work in the backlog for exactly that reason.
 *
 * Four rules govern everything below, and each exists because getting it wrong
 * has a specific, expensive consequence:
 *
 *  1. VAT TREATMENT IS READ, NEVER ASSUMED. Residential rent is exempt;
 *     standalone parking and commercial rent are standard-rated. The treatment
 *     comes from the tax code on the item named by the lease's own charge row,
 *     so a tax adviser's answer to open question Q-1 is a data change and not a
 *     code change. Nothing here hard-codes "parking is 5%". What it does do is
 *     WARN when a unit's kind and its lease's tax treatment disagree, because
 *     that mismatch is the one an accountant must see before 34 invoices exist
 *     rather than after (WF-05 §9.2).
 *
 *  2. THE PREVIEW PREDICTS THE POSTER EXACTLY. The per-line net and VAT are
 *     computed here with the same arithmetic `createInvoice` uses — inclusive
 *     prices backed out and the tax taken as the remainder, exclusive prices
 *     taxed on top. A preview computed by a different route is a preview of a
 *     different invoice, and the whole risk control is that the number on
 *     screen is the number that will post. `commitRentRun` re-reads the
 *     documents it created and refuses the whole transaction if the total it
 *     promised is not the total it produced.
 *
 *  3. A PERIOD IS BILLED ONCE. Two independent guards, because one is not
 *     enough. `withIdempotency` deduplicates a resubmitted payload; it does
 *     nothing about two different operators, two browser tabs, or a cron job
 *     racing a human, all of which produce different keys. So the domain
 *     itself refuses: a transaction-scoped advisory lock serialises runs for a
 *     tenant and period, and inside it every lease is re-checked against the
 *     rent lines that already exist for that period. Running August twice
 *     creates nothing the second time and says so.
 *
 *  4. MONEY IS EXACT AND EVERY JOURNAL BALANCES. Proration divides; division
 *     is where fils go missing. Every derived amount is quantized at storage
 *     precision before it is compared or written, and deposit settlement
 *     refuses an over-allocation exactly rather than clamping it.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT WRITE: `installment_plans` /
 * `installments`. A lease's instalment schedule is fully determined by
 * `annual_rent`, `cheque_count` and `billing_day`, and is materialised where it
 * physically exists — as the post-dated cheque bundle in `cheques`, which the
 * register and the clearing path already understand. Writing the same debt into
 * `installments` as well would double-count it: `loadActionItems` raises an
 * "overdue instalments" exception from that table, and monthly rent invoicing
 * already raises an overdue-invoice exception for the same money. One debt must
 * not produce two alerts.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Calendar arithmetic
// ════════════════════════════════════════════════════════════════════════════
//
// All in UTC. Tenant-local "today" is injected on the context; a lease term is
// a run of calendar dates, not an instant, so shifting it through a local
// timezone can only introduce an off-by-one at the boundary (EC-09).

const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const parseDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

function addDays(iso: string, n: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Whole days in the half-open interval `[a, b)`. Negative when b precedes a. */
function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

const daysInMonth = (year: number, month1: number): number =>
  new Date(Date.UTC(year, month1, 0)).getUTCDate();

/**
 * Add calendar months, clamping the day to the target month's length.
 *
 * A lease billed on the 31st has no 31 September. Clamping to the 30th keeps
 * the anniversary series monotonic and non-overlapping, which is what the
 * period ranges on the invoice lines and the cheque register both depend on.
 */
function addMonths(iso: string, n: number): string {
  const d = parseDate(iso);
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  return isoDate(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m + 1)))));
}

const minDate = (a: string, b: string): string => (a < b ? a : b);
const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** `YYYY-MM` → the human label the operator asked for. */
function periodLabel(period: string): string {
  const [y, m] = period.split("-");
  return `${MONTH_NAMES[parseInt(m!, 10) - 1] ?? m} ${y}`;
}

/**
 * The date in `period` on which this lease's rent falls due.
 *
 * A UAE tenancy is billed on its own anniversary day, not on the first of the
 * month — LSE-PROP-0001 falls due on the 2nd, LSE-PARK-0022 on the 3rd — and
 * the existing rent lines, the cheque `period_start`/`period_end` ranges and
 * `transitionCheque`'s allocation query all already assume that. Billing on
 * the 1st instead would orphan every cheque in the safe from the invoice it
 * was written to cover.
 */
function billingDateFor(period: string, billingDay: number): string {
  const [y, m] = period.split("-").map((p) => parseInt(p, 10));
  const dim = daysInMonth(y!, m!);
  const day = Math.min(Math.max(billingDay, 1), dim);
  return `${period}-${String(day).padStart(2, "0")}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Proration and VAT
// ════════════════════════════════════════════════════════════════════════════

/**
 * THE PRORATION RULE, stated once so every caller shares it.
 *
 *   chargeable = contractual rent × days occupied ÷ days in the billing period
 *
 * "Days in the billing period" is the actual length of THIS period — 28 to 31
 * days, from one anniversary date to the next — not a notional 30. A 30-day
 * convention would bill February at 30/30 and October at 31/30, so a tenant who
 * moved in on 1 February and out on 31 October would pay for a different number
 * of days than they occupied, and the difference is precisely the kind of
 * discrepancy the Rental Dispute Centre resolves against the landlord.
 *
 * `ends_on` is INCLUSIVE — the last day of occupation, which is how a tenancy
 * contract and an Ejari certificate both read. The half-open interval used
 * internally is therefore `[starts_on, ends_on + 1 day)`.
 *
 * The rule applies unchanged to all three cases that need one:
 *   • a lease starting mid-period — occupied from `starts_on`;
 *   • a termination mid-period — occupied to `terminated_on` inclusive;
 *   • a renewal that changes the rent mid-period — the old term is charged to
 *     the day before the new one starts and the new term from its own start, so
 *     the two segments abut exactly and neither restates the other's days.
 *
 * A full period is never routed through the division: `daysCharged ===
 * daysInPeriod` returns the contractual rent untouched, so 41 unremarkable
 * leases produce 41 amounts identical to their lease rows and the reconciliation
 * at the end of the run has nothing to absorb.
 */
export function prorate(
  rent: M.Money,
  daysCharged: number,
  daysInPeriod: number,
): M.Money {
  if (daysInPeriod <= 0 || daysCharged <= 0) return M.ZERO;
  if (daysCharged >= daysInPeriod) return M.quantize(rent);
  return M.quantize(M.div(M.mul(rent, daysCharged), daysInPeriod));
}

export interface TaxSplit {
  /** The price handed to `createInvoice`, in the item's own pricing convention. */
  linePrice: M.Money;
  net: M.Money;
  vat: M.Money;
  gross: M.Money;
}

/**
 * Turn a contractual rent into the invoice line, and predict the tax exactly.
 *
 * Two separate things are happening, and conflating them is how a landlord
 * quietly loses 1/21 of every parking invoice.
 *
 * FIRST, the pricing convention. The `VAT5` tax code is flagged
 * `is_inclusive` because that is the retail truth in this market: the price on
 * the shelf and on the salon board already contains the VAT. A tenancy contract
 * is the opposite — it states the rent, and VAT where it applies is added on
 * top. Feeding the contractual rent to an inclusive tax code would treat AED
 * 639 as VAT-inclusive and recognise AED 608.57 of revenue against a contract
 * that says 639. So the rent is grossed up first, and the inclusive back-out
 * then returns exactly the contractual figure.
 *
 * SECOND, the prediction. The arithmetic below mirrors `createInvoice`
 * line-for-line — inclusive prices divided out with the tax taken as the
 * REMAINDER so `net + vat === gross` exactly, exclusive prices taxed on top —
 * because the preview's only job is to be the invoice before it exists.
 *
 * Rate and inclusiveness both come from the tax code on the lease's charge
 * item. Nothing here decides whether parking is standard-rated (Q-1); it
 * decides what to do once someone has recorded the answer.
 */
export function taxSplitForRent(
  contractRent: M.Money,
  rate: M.Money,
  inclusive: boolean,
): TaxSplit {
  if (M.isZero(rate)) {
    const net = M.quantize(contractRent);
    return { linePrice: net, net, vat: M.ZERO, gross: net };
  }
  if (inclusive) {
    const linePrice = M.quantize(M.mul(contractRent, M.add(M.money(1), rate)));
    const net = M.quantize(M.div(linePrice, M.add(M.money(1), rate)));
    const vat = M.sub(linePrice, net);
    return { linePrice, net, vat, gross: linePrice };
  }
  const net = M.quantize(contractRent);
  const vat = M.quantize(M.mul(net, rate));
  return { linePrice: net, net, vat, gross: M.add(net, vat) };
}

/**
 * Does a unit of this kind normally carry this VAT treatment?
 *
 * Advisory only, and deliberately so. Article 46 of the VAT Decree-Law exempts
 * the lease of residential property and standard-rates commercial property;
 * whether a standalone parking bay follows the commercial rule, and whether the
 * group should apply for floorspace apportionment, is open question Q-1 with
 * the tax adviser. So this never overrides anything — it produces a warning the
 * accountant reads on the preview, which is the control WF-05 §9.2 asks for:
 * "an accountant reads that line and catches a misconfigured lease before 34
 * wrong invoices exist."
 */
function treatmentLooksWrong(unitKind: string, treatment: string): string | null {
  const residential = unitKind === "apartment" || unitKind === "room";
  if (residential && treatment !== "exempt") {
    return `${unitKind} let residentially is normally VAT exempt, but this lease is "${treatment}".`;
  }
  if (!residential && treatment === "exempt") {
    return `${unitKind} is normally standard-rated, but this lease is exempt. Confirm against Q-1 before committing.`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  Shared lookups
// ════════════════════════════════════════════════════════════════════════════

/** Business-unit scope as a SQL predicate, mirroring `canAccessBusinessUnit`. */
function businessUnitScope(ctx: ServiceContext, column: SQL): SQL {
  if (ctx.principal.scope === "tenant") return sql`TRUE`;
  const allowed = ctx.principal.businessUnitIds;
  if (allowed === null) return sql`TRUE`;
  if (allowed.length === 0) return sql`FALSE`;
  return sql`${column} = ANY(ARRAY[${sql.join(
    allowed.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}])`;
}

type LeaseRow = {
  id: string;
  lease_number: string;
  business_unit_id: string;
  bu_code: string;
  bu_name: string;
  unit_id: string;
  unit_code: string;
  unit_kind: string;
  party_id: string;
  party_name: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  notice_period_days: number;
  rent_amount: string;
  annual_rent: string;
  billing_day: number;
  grace_days: number;
  frequency: string;
  collection_method: string;
  cheque_count: number | null;
  ejari_number: string | null;
  escalation_rate: string;
  deposit_amount: string;
  deposit_held: string;
  charge_id: string | null;
  charge_amount: string | null;
  charge_label: string | null;
  item_id: string | null;
  item_name: string | null;
  tax_code_id: string | null;
  tax_code: string | null;
  tax_rate: string | null;
  tax_treatment: string | null;
  tax_inclusive: boolean | null;
};

const LEASE_SELECT = sql`
  SELECT l.id, l.lease_number, l.business_unit_id, b.code AS bu_code, b.name AS bu_name,
         l.unit_id, u.code AS unit_code, u.kind::text AS unit_kind,
         l.party_id, p.display_name AS party_name, l.status::text,
         l.starts_on::text, l.ends_on::text, l.notice_period_days,
         l.rent_amount, l.annual_rent,
         l.billing_day, l.grace_days, l.frequency::text,
         l.collection_method::text, l.cheque_count, l.ejari_number,
         l.escalation_rate, l.deposit_amount, l.deposit_held,
         lc.id AS charge_id, lc.amount AS charge_amount, lc.label AS charge_label,
         i.id AS item_id, i.name AS item_name,
         tc.id AS tax_code_id, tc.code AS tax_code, tc.rate AS tax_rate,
         tc.treatment::text AS tax_treatment, tc.is_inclusive AS tax_inclusive
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN parties p ON p.id = l.party_id
    JOIN business_units b ON b.id = l.business_unit_id
    LEFT JOIN LATERAL (
      SELECT c.id, c.amount, c.label, c.item_id
        FROM lease_charges c
       WHERE c.lease_id = l.id AND c.is_active = true
       ORDER BY c.created_at
       LIMIT 1
    ) lc ON TRUE
    LEFT JOIN items i ON i.id = lc.item_id
    LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
`;

/**
 * The catalogue item a lease bills through, when the lease has no charge row.
 *
 * A lease with no `lease_charges` row has no tax code, and a rent line with no
 * tax code is an invoice with an unstated VAT position. Falling back to the
 * business unit's own rent item — "Residential Rent" for PROP, "Monthly Parking
 * Bay" for PARK, each already carrying its tax code — is the difference between
 * a warned-about default and a silent 0%.
 */
async function defaultRentItem(
  ctx: ServiceContext,
  businessUnitId: string,
): Promise<{ id: string; name: string; tax_code_id: string | null; tax_code: string | null;
             tax_rate: string | null; tax_treatment: string | null;
             tax_inclusive: boolean | null } | null> {
  const rows = await ctx.tx.execute<{
    id: string; name: string; tax_code_id: string | null; tax_code: string | null;
    tax_rate: string | null; tax_treatment: string | null; tax_inclusive: boolean | null;
  }>(sql`
    SELECT i.id, i.name, i.tax_code_id, tc.code AS tax_code, tc.rate AS tax_rate,
           tc.treatment::text AS tax_treatment, tc.is_inclusive AS tax_inclusive
      FROM items i
      LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
     WHERE i.type = 'rent' AND i.is_active = true
       AND i.business_unit_id = ${businessUnitId}::uuid
     ORDER BY i.created_at
     LIMIT 1
  `);
  return rows[0] ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
//  FR-R02 · Rent run
// ════════════════════════════════════════════════════════════════════════════

export const rentRunInput = z.object({
  /** The calendar month whose rent falls due, `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be YYYY-MM."),
  /** Limit the run to one business — the parking bays without the flats. */
  businessUnitId: z.uuid().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export type RentRunWarningCode =
  | "already_billed"
  | "missing_cheque"
  | "prorated"
  | "treatment_mismatch"
  | "no_charge_row"
  | "no_tax_code"
  | "missing_ejari"
  | "not_billed";

export interface RentRunWarning {
  code: RentRunWarningCode;
  severity: "info" | "warning" | "critical";
  leaseId: string;
  leaseNumber: string;
  unitCode: string;
  message: string;
}

export interface RentRunLine {
  leaseId: string;
  leaseNumber: string;
  businessUnitId: string;
  businessUnitCode: string;
  unitCode: string;
  unitKind: string;
  partyId: string;
  partyName: string;
  itemId: string;
  description: string;
  taxCode: string;
  taxTreatment: string;
  taxRatePercent: number;
  issueDate: string;
  dueDate: string;
  /** Inclusive service period, as printed on the invoice. */
  periodStart: string;
  periodEnd: string;
  daysCharged: number;
  daysInPeriod: number;
  prorated: boolean;
  /**
   * Presentation only — every figure here was computed as exact decimal.
   *
   * `linePrice` is what goes on the invoice line in the item's own pricing
   * convention: the VAT-inclusive figure for an inclusive tax code, the net for
   * an exclusive or exempt one. `net` and `vat` are what that price resolves
   * to, and `gross` is what the tenant owes.
   */
  linePrice: number;
  net: number;
  vat: number;
  gross: number;
}

export interface RentRunTreatmentGroup {
  treatment: string;
  label: string;
  taxCodes: string[];
  invoices: number;
  net: number;
  vat: number;
  gross: number;
}

export interface RentRunPreview {
  period: string;
  label: string;
  /** Every eligible lease is already invoiced for this period. */
  alreadyRun: boolean;
  lines: RentRunLine[];
  /** Eligible but already billed — shown so "nothing happened" is explicable. */
  alreadyBilled: { leaseNumber: string; unitCode: string; docNumbers: string[] }[];
  byTreatment: RentRunTreatmentGroup[];
  totals: { invoices: number; net: number; vat: number; gross: number };
  warnings: RentRunWarning[];
}

const TREATMENT_LABEL: Record<string, string> = {
  exempt: "Exempt — no VAT charged, input VAT on these costs is not recoverable",
  standard: "Standard rated at 5%",
  zero_rated: "Zero rated — 0% charged, input VAT still recoverable",
  out_of_scope: "Out of scope",
  reverse_charge: "Reverse charge",
  none: "No tax code on the item — treated as 0% and NOT declared",
};

/**
 * What a rent run would do, without doing any of it.
 *
 * Step one of the two-step in WF-05 §9.2, and the entire risk control. Nothing
 * here writes. It is also the query behind the commit — `commitRentRun` calls
 * this function under a lock rather than reimplementing the selection, so the
 * two can never drift into disagreeing about which leases are due.
 */
export async function previewRentRun(
  ctx: ServiceContext,
  raw: unknown,
): Promise<RentRunPreview> {
  const input = rentRunInput.parse(raw);
  // The accountant persona in WF-05 §9.2 is the intended reader of this
  // screen and holds `document:*` but no `lease:*` grant, so the preview gates
  // on the permission for the thing it is actually previewing: invoices.
  requirePermission(ctx, "document:read");
  if (input.businessUnitId) requireBusinessUnit(ctx, input.businessUnitId);

  const period = input.period;
  const monthStart = `${period}-01`;
  const monthEnd = addDays(addMonths(monthStart, 1), -1);

  const buFilter = input.businessUnitId
    ? sql`AND l.business_unit_id = ${input.businessUnitId}::uuid`
    : sql``;

  const leases = await ctx.tx.execute<LeaseRow>(sql`
    ${LEASE_SELECT}
    -- "ended" is in the list on purpose. A renewal closes the outgoing term on
    -- the day before the new one starts and moves it to "ended", and the days
    -- between the last invoice and that date are rent the tenant genuinely
    -- owes. Excluding the state would silently lose them: the verification run
    -- renewed a lease from 16 October and 15 October was never billed by
    -- anything. A zero day-count still excludes every long-expired term, so
    -- this widens the selection by exactly the tail of a rolled-over tenancy.
    WHERE l.status IN ('active', 'expiring', 'defaulted', 'ended')
      AND l.deleted_at IS NULL
      AND l.starts_on <= ${monthEnd}::date
      AND (l.ends_on IS NULL OR l.ends_on >= ${monthStart}::date)
      AND ${businessUnitScope(ctx, sql`l.business_unit_id`)}
      ${buFilter}
    ORDER BY b.sort_order, u.code
  `);

  const lines: RentRunLine[] = [];
  const warnings: RentRunWarning[] = [];
  const alreadyBilled: RentRunPreview["alreadyBilled"] = [];
  const itemCache = new Map<string, Awaited<ReturnType<typeof defaultRentItem>>>();

  for (const lease of leases) {
    const warn = (
      code: RentRunWarningCode,
      severity: RentRunWarning["severity"],
      message: string,
    ) => warnings.push({
      code, severity, leaseId: lease.id, leaseNumber: lease.lease_number,
      unitCode: lease.unit_code, message,
    });

    // Anything other than monthly needs its own period arithmetic and its own
    // cheque mapping; the pilot portfolio is entirely monthly. Skipping loudly
    // beats billing a quarterly lease as if it were monthly.
    if (lease.frequency !== "monthly") {
      warn("not_billed", "warning",
        `Billed ${lease.frequency}, which the rent run does not generate. Invoice it manually.`);
      continue;
    }

    // A defaulted lease is still occupied and still accruing, but whether to
    // keep invoicing a tenant who is being evicted is a decision with legal
    // consequences and it is not this job's to make silently.
    if (lease.status === "defaulted") {
      warn("not_billed", "critical",
        "Lease is in default — not billed automatically. Raise the invoice by hand if the tenant is still in occupation.");
      continue;
    }

    const anniversary = billingDateFor(period, lease.billing_day);
    const periodStartExclusiveEnd = addMonths(anniversary, 1);
    const daysInPeriod = daysBetween(anniversary, periodStartExclusiveEnd);

    // Occupancy inside this billing period. `ends_on` is the last day of the
    // term, so the half-open window closes the day after it.
    const termEndExclusive = lease.ends_on ? addDays(lease.ends_on, 1) : "9999-12-31";
    const chargeFrom = maxDate(anniversary, lease.starts_on);
    const chargeTo = minDate(periodStartExclusiveEnd, termEndExclusive);
    const chargeToInclusive = addDays(chargeTo, -1);
    const daysCharged = Math.max(0, daysBetween(chargeFrom, chargeTo));
    const prorated = daysCharged < daysInPeriod;

    if (daysCharged === 0) {
      // Silence here is how an operator ends up staring at "30 invoices" with
      // 41 leases on screen and no way to tell which eleven fell out or why.
      // The seeded portfolio alone has ten leases whose term ended months ago
      // and whose status is still `active` — every one of them is a lease
      // somebody has to renew or terminate, and the rent run is where that
      // becomes visible.
      if (lease.ends_on && lease.ends_on < anniversary) {
        warn("not_billed", "warning",
          `Term ended ${lease.ends_on} but the lease is still marked "${lease.status}". ` +
          `Not billed. Renew it or terminate it.`);
      } else if (lease.starts_on >= periodStartExclusiveEnd) {
        warn("not_billed", "info",
          `Term starts ${lease.starts_on}, after this billing period. Not billed yet.`);
      }
      continue;
    }

    // ── Already billed? ───────────────────────────────────────────────────
    // Checked before anything else is computed, and keyed on the rent line's
    // own period rather than on the invoice's issue date: an invoice raised
    // late still covers the period it names, and it is the PERIOD that must not
    // be billed twice. The window is the whole anniversary month, so a line
    // stamped with a prorated sub-range still matches.
    const existing = await ctx.tx.execute<{ doc_number: string }>(sql`
      SELECT DISTINCT d.doc_number
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
       WHERE dl.lease_id = ${lease.id}::uuid
         AND dl.period_start >= ${anniversary}::date
         AND dl.period_start < ${periodStartExclusiveEnd}::date
         AND d.doc_type = 'invoice'
         AND d.status NOT IN ('cancelled', 'void')
       ORDER BY d.doc_number
    `);
    if (existing.length > 0) {
      alreadyBilled.push({
        leaseNumber: lease.lease_number,
        unitCode: lease.unit_code,
        docNumbers: existing.map((e) => e.doc_number),
      });
      warn("already_billed", "info",
        `Already invoiced for ${chargeFrom} → ${chargeToInclusive} on ${existing.map((e) => e.doc_number).join(", ")}.`);
      continue;
    }

    // ── Which item, and therefore which tax treatment ─────────────────────
    let itemId = lease.item_id;
    let itemName = lease.item_name;
    let taxCode = lease.tax_code;
    let taxRate = lease.tax_rate;
    let taxTreatment = lease.tax_treatment;
    let taxInclusive = lease.tax_inclusive;

    if (!itemId) {
      if (!itemCache.has(lease.business_unit_id)) {
        itemCache.set(lease.business_unit_id, await defaultRentItem(ctx, lease.business_unit_id));
      }
      const fallback = itemCache.get(lease.business_unit_id) ?? null;
      if (!fallback) {
        warn("no_charge_row", "critical",
          `No charge row and no rent item configured for ${lease.bu_name}. This lease cannot be invoiced.`);
        continue;
      }
      itemId = fallback.id;
      itemName = fallback.name;
      taxCode = fallback.tax_code;
      taxRate = fallback.tax_rate;
      taxTreatment = fallback.tax_treatment;
      taxInclusive = fallback.tax_inclusive;
      warn("no_charge_row", "warning",
        `No lease charge row — billing through "${itemName}" (${taxCode ?? "no tax code"}). Add a charge row to make the treatment explicit.`);
    }

    if (!taxCode) {
      warn("no_tax_code", "critical",
        `"${itemName}" has no tax code. The line will be raised at 0% and will not appear correctly on the VAT return.`);
    }

    const treatment = taxTreatment ?? "none";
    const mismatch = treatmentLooksWrong(lease.unit_kind, treatment);
    if (mismatch) warn("treatment_mismatch", "critical", mismatch);

    // ── The money ─────────────────────────────────────────────────────────
    const contractRent = M.fromDb(lease.charge_amount ?? lease.rent_amount);
    const chargeable = prorate(contractRent, daysCharged, daysInPeriod);
    if (M.isZero(chargeable)) {
      warn("not_billed", "warning", "Rent for this period computes to zero — nothing raised.");
      continue;
    }

    const split = taxSplitForRent(chargeable, M.fromDb(taxRate), Boolean(taxInclusive));

    if (prorated) {
      warn("prorated", "warning",
        `${daysCharged} of ${daysInPeriod} days — ${chargeFrom} to ${chargeToInclusive}. ` +
        `${M.toDisplay(contractRent)} apportioned to ${M.toDisplay(chargeable)}.`);
    }

    // ── Collection ────────────────────────────────────────────────────────
    if (lease.collection_method === "post_dated_cheques") {
      const cheque = await ctx.tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM cheques
         WHERE lease_id = ${lease.id}::uuid
           AND status IN ('held', 'deposited')
           AND period_start <= ${chargeFrom}::date
           AND (period_end IS NULL OR period_end > ${chargeFrom}::date)
      `);
      if ((cheque[0]?.n ?? 0) === 0) {
        warn("missing_cheque", "critical",
          `Settled by post-dated cheque but no cheque on file covers ${chargeFrom}. The invoice will have nothing to clear against.`);
      }
    }

    if (!lease.ejari_number) {
      warn("missing_ejari", "warning",
        "No Ejari registration on this lease. An unregistered tenancy cannot be enforced at the Rental Dispute Centre.");
    }

    lines.push({
      leaseId: lease.id,
      leaseNumber: lease.lease_number,
      businessUnitId: lease.business_unit_id,
      businessUnitCode: lease.bu_code,
      unitCode: lease.unit_code,
      unitKind: lease.unit_kind,
      partyId: lease.party_id,
      partyName: lease.party_name,
      itemId,
      description: prorated
        ? `${itemName} — ${chargeFrom} to ${chargeToInclusive} (${daysCharged}/${daysInPeriod} days)`
        : `${itemName} — ${chargeFrom} to ${chargeToInclusive}`,
      taxCode: taxCode ?? "—",
      taxTreatment: treatment,
      taxRatePercent: M.toNumber(M.mul(M.fromDb(taxRate), 100)),
      // The invoice is dated the day the rent falls due, which for a tenancy
      // that starts mid-period is the day it starts — dating it to an
      // anniversary that precedes the tenancy would put the supply in a VAT
      // period before the lease existed.
      issueDate: chargeFrom,
      dueDate: addDays(chargeFrom, lease.grace_days),
      // The service period is the days ACTUALLY charged, not the nominal month.
      // These two columns are what the cheque-to-invoice allocation in
      // `transitionCheque` matches on and what attributes output VAT to a
      // return period; stamping the full month on a seven-day charge would
      // claim days the tenant did not have.
      periodStart: chargeFrom,
      periodEnd: chargeToInclusive,
      daysCharged,
      daysInPeriod,
      prorated,
      linePrice: M.toNumber(split.linePrice),
      net: M.toNumber(split.net),
      vat: M.toNumber(split.vat),
      gross: M.toNumber(split.gross),
    });
  }

  // ── The split the operator has to see before committing ─────────────────
  const groups = new Map<string, { taxCodes: Set<string>; invoices: number;
                                   net: M.Money; vat: M.Money; gross: M.Money }>();
  let net = M.ZERO, vat = M.ZERO, gross = M.ZERO;
  for (const line of lines) {
    const g = groups.get(line.taxTreatment) ?? {
      taxCodes: new Set<string>(), invoices: 0, net: M.ZERO, vat: M.ZERO, gross: M.ZERO,
    };
    g.taxCodes.add(line.taxCode);
    g.invoices += 1;
    // Re-entering Money from the line's presentation number would be the one
    // float round-trip in the file. These are re-derived from the same inputs
    // instead, which costs nothing and cannot drift.
    g.net = M.add(g.net, M.money(line.net));
    g.vat = M.add(g.vat, M.money(line.vat));
    g.gross = M.add(g.gross, M.money(line.gross));
    groups.set(line.taxTreatment, g);
    net = M.add(net, M.money(line.net));
    vat = M.add(vat, M.money(line.vat));
    gross = M.add(gross, M.money(line.gross));
  }

  const byTreatment: RentRunTreatmentGroup[] = [...groups]
    .sort((a, b) => b[1].gross.comparedTo(a[1].gross))
    .map(([treatment, g]) => ({
      treatment,
      label: TREATMENT_LABEL[treatment] ?? treatment,
      taxCodes: [...g.taxCodes].sort(),
      invoices: g.invoices,
      net: M.toNumber(g.net),
      vat: M.toNumber(g.vat),
      gross: M.toNumber(g.gross),
    }));

  return {
    period,
    label: periodLabel(period),
    alreadyRun: lines.length === 0 && alreadyBilled.length > 0,
    lines,
    alreadyBilled,
    byTreatment,
    totals: {
      invoices: lines.length,
      net: M.toNumber(net),
      vat: M.toNumber(vat),
      gross: M.toNumber(gross),
    },
    warnings,
  };
}

export interface RentRunResult {
  period: string;
  label: string;
  created: {
    leaseId: string;
    leaseNumber: string;
    unitCode: string;
    documentId: string;
    docNumber: string;
    total: number;
  }[];
  skipped: number;
  totals: { invoices: number; net: number; vat: number; gross: number };
}

/**
 * Raise a month of rent invoices. Step two of WF-05 §9.2.
 *
 * The idempotency story in full, because "run August twice" is the acceptance
 * criterion and there are three distinct ways to run it twice:
 *
 *   • THE SAME SUBMIT, TWICE. A double-tapped button or a retry after a dropped
 *     connection sends a byte-identical payload; `withIdempotency` replays the
 *     first result and nothing runs again.
 *   • TWO DIFFERENT SUBMITS. Two operators, two tabs, or a human racing a cron
 *     job produce different keys and defeat that entirely. The advisory lock
 *     below serialises them for the tenant and period; the loser then re-runs
 *     the preview against the winner's committed rows, finds every lease
 *     billed, and refuses.
 *   • A PARTIAL RE-RUN. A run that failed halfway, or a lease added after the
 *     fact, leaves some periods billed and some not. The per-lease check inside
 *     the preview skips exactly the ones that exist, so the second run fills
 *     the gap instead of duplicating the rest. This is why the guard is
 *     per-lease-period and not a single "has this month run" flag.
 *
 * `pg_advisory_xact_lock` is released at COMMIT, and this transaction is READ
 * COMMITTED, so the statement that runs immediately after the lock is granted
 * takes a fresh snapshot and sees whatever the previous holder committed. A
 * lock that outlived its transaction, or a snapshot taken before it, would make
 * the whole thing decorative.
 */
export async function commitRentRun(ctx: ServiceContext, raw: unknown): Promise<RentRunResult> {
  const input = rentRunInput.parse(raw);
  requirePermission(ctx, "document:create");
  if (input.businessUnitId) requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "commitRentRun", async () => {
    await ctx.tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId}::text),
                                   hashtext(${`rent-run:${input.period}`}::text))
    `);

    const preview = await previewRentRun(ctx, input);

    if (preview.lines.length === 0) {
      if (preview.alreadyBilled.length > 0) {
        throw new ServiceError(
          `Rent for ${preview.label} has already been raised — ${preview.alreadyBilled.length} ` +
            `lease${preview.alreadyBilled.length === 1 ? "" : "s"} already invoiced. Nothing to do.`,
          "duplicate",
        );
      }
      throw new ServiceError(`No lease falls due in ${preview.label}.`, "invalid");
    }

    const created: RentRunResult["created"] = [];
    for (const line of preview.lines) {
      const invoice = await createInvoice(ctx, {
        businessUnitId: line.businessUnitId,
        partyId: line.partyId,
        issueDate: line.issueDate,
        // Rent falls due on the billing date; the lease's own grace period is
        // its definition of "late", so using it as the due date makes the AR
        // ageing agree with the lease rather than with a generic 30 days.
        dueDays: daysBetween(line.issueDate, line.dueDate),
        lines: [
          {
            itemId: line.itemId,
            quantity: 1,
            unitPrice: line.linePrice,
            description: line.description,
          },
        ],
        notes: `Rent run ${preview.label} · ${line.leaseNumber} · unit ${line.unitCode}`,
      });

      /**
       * Stamp the rental dimension.
       *
       * `createInvoice` does not carry `leaseId`, `periodStart` or `periodEnd`
       * on its line input, and those three columns are what the duplicate guard
       * above, `transitionCheque`'s cheque-to-invoice allocation, and the
       * occupancy reports all read. Setting them in a second statement inside
       * the same transaction is correct — the invoice and its dimension either
       * both exist or neither does — but the right home for them is
       * `createInvoiceInput`. That change belongs to whoever owns sales.ts.
       */
      await ctx.tx.execute(sql`
        UPDATE document_lines
           SET lease_id = ${line.leaseId}::uuid,
               period_start = ${line.periodStart}::date,
               period_end = ${line.periodEnd}::date
         WHERE document_id = ${invoice.documentId}::uuid
      `);
      await ctx.tx.execute(sql`
        UPDATE documents
           SET source_table = 'leases', source_id = ${line.leaseId}::uuid, updated_at = now()
         WHERE id = ${invoice.documentId}::uuid
      `);
      await ctx.tx.execute(sql`
        UPDATE leases
           SET balance_due = balance_due + ${M.toDb(M.money(line.gross))}, updated_at = now()
         WHERE id = ${line.leaseId}::uuid
      `);
      await ctx.tx.execute(sql`
        UPDATE lease_charges
           SET last_billed_on = ${line.periodStart}::date, updated_at = now()
         WHERE lease_id = ${line.leaseId}::uuid AND is_active = true
      `);

      created.push({
        leaseId: line.leaseId,
        leaseNumber: line.leaseNumber,
        unitCode: line.unitCode,
        documentId: invoice.documentId,
        docNumber: invoice.docNumber,
        total: invoice.total,
      });
    }

    /**
     * RECONCILE TO THE LEASE SCHEDULE — FR-R02's fourth acceptance criterion.
     *
     * The totals are read back out of `documents` rather than accumulated from
     * what this function believed it was sending, so a disagreement between the
     * preview's arithmetic and `createInvoice`'s is caught here, before commit,
     * and takes the whole run down instead of leaving 34 invoices whose sum the
     * operator was told would be something else. Exact: at storage precision
     * there is no honest tolerance.
     */
    const posted = await ctx.tx.execute<{ subtotal: string; tax: string; total: string }>(sql`
      SELECT COALESCE(SUM(subtotal), 0) AS subtotal,
             COALESCE(SUM(tax_total), 0) AS tax,
             COALESCE(SUM(total), 0) AS total
        FROM documents
       WHERE id = ANY(ARRAY[${sql.join(
         created.map((c) => sql`${c.documentId}::uuid`),
         sql`, `,
       )}])
    `);
    const postedTotal = M.fromDb(posted[0]?.total);
    const promisedTotal = M.quantize(M.money(preview.totals.gross));
    if (!M.eq(M.quantize(postedTotal), promisedTotal)) {
      throw new ServiceError(
        `Rent run does not reconcile: the preview promised ${M.toDisplay(promisedTotal)} ` +
          `but the invoices total ${M.toDisplay(postedTotal)}. Nothing has been saved.`,
        "invalid",
      );
    }

    await writeAudit(ctx, {
      action: "rentRun.commit",
      entityTable: "leases",
      businessUnitId: input.businessUnitId,
      diff: {
        period: input.period,
        invoices: created.length,
        net: M.toDb(M.fromDb(posted[0]?.subtotal)),
        vat: M.toDb(M.fromDb(posted[0]?.tax)),
        gross: M.toDb(postedTotal),
        treatments: preview.byTreatment.map((t) => `${t.treatment}:${t.invoices}`),
        skipped: preview.alreadyBilled.length,
        docNumbers: created.map((c) => c.docNumber),
      },
    });

    return {
      period: preview.period,
      label: preview.label,
      created,
      skipped: preview.alreadyBilled.length,
      totals: {
        invoices: created.length,
        net: M.toNumber(M.fromDb(posted[0]?.subtotal)),
        vat: M.toNumber(M.fromDb(posted[0]?.tax)),
        gross: M.toNumber(postedTotal),
      },
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FR-R01 · Lease lifecycle — create
// ════════════════════════════════════════════════════════════════════════════

const chequeBundleInput = z.array(
  z.object({
    chequeNumber: z.string().min(1).max(40),
    bankName: z.string().max(120).optional(),
  }),
).max(12);

export const createLeaseInput = z.object({
  businessUnitId: z.uuid(),
  unitId: z.uuid(),
  partyId: z.uuid(),
  startsOn: z.iso.date(),
  /** Omitted = open-ended. A UAE tenancy is annual; the UI defaults to +1 year. */
  endsOn: z.iso.date().optional(),
  /** Either figure may be given; the other is derived. */
  annualRent: z.number().min(0).max(100_000_000).optional(),
  rentAmount: z.number().min(0).max(10_000_000).optional(),
  billingDay: z.number().int().min(1).max(31).default(1),
  graceDays: z.number().int().min(0).max(60).default(5),
  noticePeriodDays: z.number().int().min(0).max(365).default(90),
  autoRenew: z.boolean().default(false),
  escalationRate: z.number().min(0).max(1).default(0),
  collectionMethod: z
    .enum(["post_dated_cheques", "bank_transfer", "direct_debit", "cash", "mixed"])
    .default("post_dated_cheques"),
  chequeCount: z.number().int().min(1).max(12).optional(),
  depositAmount: z.number().min(0).max(10_000_000).default(0),
  /** Set when the deposit is handed over at signing. Omitted = promised, not held. */
  depositReceivedVia: z.enum(["cash", "bank_transfer", "cheque"]).optional(),
  ejariNumber: z.string().max(40).optional(),
  ejariRegisteredOn: z.iso.date().optional(),
  dewaPremiseNumber: z.string().max(40).optional(),
  /** Overrides the business unit's default rent item, and with it the VAT code. */
  itemId: z.uuid().optional(),
  /** The physical cheques handed over at signing, in date order. */
  cheques: chequeBundleInput.optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface LeaseScheduleEntry {
  seq: number;
  dueOn: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  chequeNumber: string | null;
}

export interface CreateLeaseResult {
  leaseId: string;
  leaseNumber: string;
  unitCode: string;
  annualRent: number;
  rentAmount: number;
  taxCode: string;
  taxTreatment: string;
  schedule: LeaseScheduleEntry[];
  chequesCreated: number;
  depositHeld: number;
}

/**
 * Sign a lease.
 *
 * One transaction covers the lease, its charge row, the unit's status, the
 * deposit's ledger entry and the cheque bundle, because a lease that exists
 * with its unit still marked available, or with the deposit taken and no
 * liability recorded, is worse than a lease that failed to save.
 *
 * The deposit is a LIABILITY, never income. It is the tenant's money held
 * against damage and unpaid rent, refundable at the end of the term, and
 * booking it to revenue overstates profit by a month's rent per lease and
 * understates what the landlord owes back. It posts to TENANT_DEPOSIT (2400)
 * and only leaves there through `terminateLease`.
 */
export async function createLease(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CreateLeaseResult> {
  const input = createLeaseInput.parse(raw);
  requirePermission(ctx, "lease:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "createLease", async () => {
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new ServiceError("A lease cannot end before it starts.", "invalid");
    }

    const units = await ctx.tx.execute<{
      id: string; code: string; kind: string; business_unit_id: string;
      list_rent: string; bu_code: string; bu_name: string;
    }>(sql`
      SELECT u.id, u.code, u.kind::text, u.business_unit_id, u.list_rent,
             b.code AS bu_code, b.name AS bu_name
        FROM units u
        JOIN business_units b ON b.id = u.business_unit_id
       WHERE u.id = ${input.unitId}::uuid
       FOR UPDATE OF u
    `);
    const unit = units[0];
    if (!unit) throw new ServiceError("Unit not found.", "not_found");
    if (unit.business_unit_id !== input.businessUnitId) {
      throw new ServiceError(
        `Unit ${unit.code} belongs to a different business.`,
        "invalid",
      );
    }

    /**
     * A unit cannot be let twice over the same days.
     *
     * Checked in SQL with a range overlap rather than in application code,
     * because the comparison has four open-ended cases (either term may run to
     * infinity) and `daterange` gets all four right by construction. `FOR
     * UPDATE` on the unit above is what makes the check hold under concurrency:
     * two simultaneous lettings of unit 1205 serialise on that row lock, so the
     * second sees the first's lease.
     */
    const clash = await ctx.tx.execute<{ lease_number: string; starts_on: string; ends_on: string | null }>(sql`
      SELECT lease_number, starts_on::text, ends_on::text
        FROM leases
       WHERE unit_id = ${input.unitId}::uuid
         AND status IN ('draft', 'active', 'expiring', 'defaulted')
         AND deleted_at IS NULL
         AND daterange(starts_on, COALESCE(ends_on, 'infinity'::date), '[]')
             && daterange(${input.startsOn}::date,
                          COALESCE(${input.endsOn ?? null}::date, 'infinity'::date), '[]')
       LIMIT 1
    `);
    if (clash.length > 0) {
      throw new ServiceError(
        `Unit ${unit.code} is already let on ${clash[0]!.lease_number} ` +
          `(${clash[0]!.starts_on} → ${clash[0]!.ends_on ?? "open"}).`,
        "conflict",
      );
    }

    // ── Rent item and VAT treatment ───────────────────────────────────────
    let item: { id: string; name: string; tax_code_id: string | null; tax_code: string | null;
                tax_rate: string | null; tax_treatment: string | null;
                tax_inclusive: boolean | null } | null;
    if (input.itemId) {
      const rows = await ctx.tx.execute<NonNullable<typeof item>>(sql`
        SELECT i.id, i.name, i.tax_code_id, tc.code AS tax_code, tc.rate AS tax_rate,
               tc.treatment::text AS tax_treatment, tc.is_inclusive AS tax_inclusive
          FROM items i
          LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
         WHERE i.id = ${input.itemId}::uuid
      `);
      item = rows[0] ?? null;
      if (!item) throw new ServiceError("Rent item not found.", "not_found");
    } else {
      item = await defaultRentItem(ctx, input.businessUnitId);
      if (!item) {
        throw new ServiceError(
          `No rent item is configured for ${unit.bu_name}. Add one to the catalogue, ` +
            `with the tax code this business's rent carries, before creating leases.`,
          "invalid",
        );
      }
    }

    // ── Rent figures ──────────────────────────────────────────────────────
    // The annual figure is the contractual truth in the UAE — it is what the
    // Ejari certificate states — and the monthly accrual is derived from it.
    let annual: M.Money;
    let monthly: M.Money;
    if (input.annualRent !== undefined) {
      annual = M.money(input.annualRent);
      monthly = M.quantize(M.div(annual, 12));
    } else if (input.rentAmount !== undefined) {
      monthly = M.money(input.rentAmount);
      annual = M.quantize(M.mul(monthly, 12));
    } else {
      monthly = M.fromDb(unit.list_rent);
      annual = M.quantize(M.mul(monthly, 12));
    }
    if (M.isZero(annual)) {
      throw new ServiceError("A lease needs a rent. Enter the annual or monthly figure.", "invalid");
    }

    const leaseNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "lease", `LEA-${unit.bu_code}`,
    );

    const deposit = M.money(input.depositAmount);
    const depositHeld = input.depositReceivedVia ? deposit : M.ZERO;

    const inserted = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO leases
        (id, tenant_id, business_unit_id, unit_id, party_id, lease_number, status,
         starts_on, ends_on, auto_renew, notice_period_days, annual_rent, rent_amount,
         frequency, billing_day, collection_method, cheque_count, ejari_number,
         ejari_registered_on, dewa_premise_number, deposit_amount, deposit_held,
         escalation_rate, grace_days)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${input.unitId}::uuid, ${input.partyId}::uuid, ${leaseNumber}, 'active',
         ${input.startsOn}::date, ${input.endsOn ?? null}::date, ${input.autoRenew},
         ${input.noticePeriodDays}, ${M.toDb(annual)}, ${M.toDb(monthly)}, 'monthly',
         ${input.billingDay}, ${input.collectionMethod}::collection_method,
         ${input.chequeCount ?? null}, ${input.ejariNumber ?? null},
         ${input.ejariRegisteredOn ?? null}::date, ${input.dewaPremiseNumber ?? null},
         ${M.toDb(deposit)}, ${M.toDb(depositHeld)},
         ${M.money(input.escalationRate).toFixed(6)}, ${input.graceDays})
      RETURNING id
    `);
    const leaseId = inserted[0]!.id;

    await ctx.tx.execute(sql`
      INSERT INTO lease_charges
        (id, tenant_id, lease_id, item_id, label, amount, frequency, starts_on, ends_on, is_active)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${leaseId}::uuid, ${item.id}::uuid,
         ${item.name}, ${M.toDb(monthly)}, 'monthly', ${input.startsOn}::date,
         ${input.endsOn ?? null}::date, true)
    `);

    // A lease that starts in the future reserves the unit; it does not occupy
    // it yet, and showing it as occupied would understate today's vacancy.
    await ctx.tx.execute(sql`
      UPDATE units
         SET status = ${input.startsOn <= ctx.today ? "occupied" : "reserved"}::unit_status,
             updated_at = now()
       WHERE id = ${input.unitId}::uuid
    `);

    // ── Deposit ───────────────────────────────────────────────────────────
    if (M.gt(depositHeld, M.ZERO)) {
      const cashKey =
        input.depositReceivedVia === "cash" ? "CASH"
        : input.depositReceivedVia === "cheque" ? "PDC_ON_HAND" : "BANK";
      await postJournal(ctx, {
        postingDate: input.startsOn > ctx.today ? ctx.today : input.startsOn,
        source: "manual",
        sourceTable: "leases",
        sourceId: leaseId,
        narration: `Security deposit — ${leaseNumber}, unit ${unit.code}`,
        legs: [
          { accountKey: cashKey, businessUnitId: input.businessUnitId, debit: depositHeld },
          { accountKey: "TENANT_DEPOSIT", businessUnitId: input.businessUnitId,
            credit: depositHeld, partyId: input.partyId },
        ],
      });
    }

    // ── Instalment schedule and the cheque bundle ─────────────────────────
    const schedule = buildSchedule({
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      billingDay: input.billingDay,
      instalments: input.chequeCount ?? 1,
      monthlyRent: monthly,
      rate: M.fromDb(item.tax_rate),
      inclusive: Boolean(item.tax_inclusive),
      chequeNumbers: (input.cheques ?? []).map((c) => c.chequeNumber),
    });

    let chequesCreated = 0;
    for (const [i, entry] of schedule.entries()) {
      const supplied = input.cheques?.[i];
      if (!supplied) continue;
      await ctx.tx.execute(sql`
        INSERT INTO cheques
          (id, tenant_id, business_unit_id, direction, party_id, lease_id, cheque_number,
           bank_name, cheque_date, amount, currency, status, period_start, period_end,
           received_on, custody_location)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid, 'in',
           ${input.partyId}::uuid, ${leaseId}::uuid, ${supplied.chequeNumber},
           ${supplied.bankName ?? null}, ${entry.dueOn}::date,
           ${M.toDb(M.money(entry.amount))}, ${ctx.baseCurrency}, 'held',
           ${entry.periodStart}::date, ${addDays(entry.periodEnd, 1)}::date,
           ${ctx.today}::date, 'Head office safe')
      `);
      chequesCreated++;
    }

    await writeAudit(ctx, {
      action: "lease.create",
      entityTable: "leases",
      entityId: leaseId,
      businessUnitId: input.businessUnitId,
      diff: {
        leaseNumber, unit: unit.code, partyId: input.partyId,
        startsOn: input.startsOn, endsOn: input.endsOn ?? null,
        annualRent: M.toDb(annual), rentAmount: M.toDb(monthly),
        taxCode: item.tax_code, treatment: item.tax_treatment,
        depositHeld: M.toDb(depositHeld), cheques: chequesCreated,
      },
    });

    return {
      leaseId,
      leaseNumber,
      unitCode: unit.code,
      annualRent: M.toNumber(annual),
      rentAmount: M.toNumber(monthly),
      taxCode: item.tax_code ?? "—",
      taxTreatment: item.tax_treatment ?? "none",
      schedule,
      chequesCreated,
      depositHeld: M.toNumber(depositHeld),
    };
  });
}

/**
 * The instalment schedule WF-05 §9.3 renders under the lease form.
 *
 * Derived, never stored. The schedule is a pure function of the term, the
 * billing day, the rent and the number of cheques, so persisting it would
 * create a second copy that can disagree with the lease — and the copy that
 * actually matters, the physical cheque, is persisted in `cheques`.
 *
 * `M.allocate` splits the term's gross rent across the instalments so the parts
 * sum EXACTLY to the whole. Rounding each instalment independently is how a
 * four-cheque annual lease ends up one fils short of its own annual rent, which
 * the tenant then notices on the last cheque.
 */
function buildSchedule(args: {
  startsOn: string;
  endsOn?: string;
  billingDay: number;
  instalments: number;
  monthlyRent: M.Money;
  rate: M.Money;
  inclusive: boolean;
  chequeNumbers: string[];
}): LeaseScheduleEntry[] {
  const termMonths = args.endsOn
    ? Math.max(1, Math.round(daysBetween(args.startsOn, addDays(args.endsOn, 1)) / 30.436875))
    : 12;
  const count = Math.max(1, Math.min(args.instalments, termMonths));
  const monthsPer = Math.max(1, Math.round(termMonths / count));

  const monthlyGross = taxSplitForRent(args.monthlyRent, args.rate, args.inclusive).gross;
  const termGross = M.quantize(M.mul(monthlyGross, termMonths));
  const shares = M.allocate(termGross, Array.from({ length: count }, () => 1));

  const entries: LeaseScheduleEntry[] = [];
  for (let i = 0; i < count; i++) {
    const periodStart = i === 0 ? args.startsOn : addMonths(args.startsOn, i * monthsPer);
    const nextStart = i === count - 1
      ? (args.endsOn ? addDays(args.endsOn, 1) : addMonths(args.startsOn, termMonths))
      : addMonths(args.startsOn, (i + 1) * monthsPer);
    entries.push({
      seq: i + 1,
      // The first instalment falls due on the day the tenancy starts; the rest
      // on the billing anniversary, which is what the cheque is dated.
      dueOn: i === 0 ? args.startsOn : billingDateFor(periodStart.slice(0, 7), args.billingDay),
      periodStart,
      periodEnd: addDays(nextStart, -1),
      amount: M.toNumber(shares[i]!),
      chequeNumber: args.chequeNumbers[i] ?? null,
    });
  }
  return entries;
}


export interface ResidualInvoice {
  documentId: string;
  docNumber: string;
  total: number;
  periodStart: string;
  periodEnd: string;
  days: number;
}

/**
 * Invoice every day of a term that has been occupied but never billed, up to
 * and including `lastDay`.
 *
 * Shared by termination and renewal because both close a term early and both
 * leave the same hole if nobody bills the tail.
 *
 *   • TERMINATION: the tenant leaves on the 31st and the rent run last billed
 *     to the 15th. Sixteen days are owed and the settlement has to know about
 *     them before it decides what to do with the deposit.
 *   • RENEWAL: a renewal effective the 16th ends the outgoing term on the
 *     15th, and the outgoing lease then moves to `ended` — which the rent run
 *     deliberately does not bill. Without this the residual days of the old
 *     rate would simply never be invoiced, and a landlord would lose a day or
 *     two of rent every time a tenancy rolled over. The verification run caught
 *     exactly that: a renewal on 16 October left 15 October unbilled.
 *
 * It walks the lease's own anniversary series from the first unbilled period,
 * so it can never double-bill one the rent run already raised, and it prorates
 * the last one to `lastDay`. The walk is bounded: a lease with two years of
 * unbilled periods is a data problem that deserves a message, not a loop that
 * silently issues twenty-four invoices.
 */
async function billResidualPeriods(
  ctx: ServiceContext,
  lease: LeaseRow,
  itemId: string,
  lastDay: string,
  label: string,
): Promise<ResidualInvoice[]> {
  const rent = M.fromDb(lease.charge_amount ?? lease.rent_amount);
  const rate = M.fromDb(lease.tax_rate);
  const inclusive = Boolean(lease.tax_inclusive);
  const out: ResidualInvoice[] = [];

  const lastBilled = await ctx.tx.execute<{ period_end: string | null }>(sql`
    SELECT MAX(dl.period_end)::text AS period_end
      FROM document_lines dl
      JOIN documents d ON d.id = dl.document_id
     WHERE dl.lease_id = ${lease.id}::uuid
       AND d.doc_type = 'invoice' AND d.status NOT IN ('cancelled', 'void')
  `);

  // Resume from the day after the last day already invoiced, then fall back to
  // the lease's own anniversary grid. Keying on `period_end` rather than
  // `period_start` is what makes a prorated first month resume correctly:
  // a line covering the 15th to the 30th must be followed by the 1st, not by
  // the 15th of the next month.
  const resumeFrom = lastBilled[0]?.period_end
    ? addDays(lastBilled[0].period_end, 1)
    : lease.starts_on;
  let cursor = maxDate(resumeFrom, lease.starts_on);

  for (let guard = 0; cursor <= lastDay; guard++) {
    if (guard > 24) {
      throw new ServiceError(
        `${lease.lease_number} has more than 24 unbilled periods. Run the rent run first.`,
        "invalid",
      );
    }
    // The period this day belongs to on the lease's anniversary grid, so a
    // resumed part-month is charged against the right denominator.
    const anniversary = billingDateFor(cursor.slice(0, 7), lease.billing_day);
    const gridStart = anniversary <= cursor ? anniversary : addMonths(anniversary, -1);
    const gridEnd = addMonths(gridStart, 1);
    const daysInPeriod = daysBetween(gridStart, gridEnd);
    const chargeTo = minDate(gridEnd, addDays(lastDay, 1));
    const days = Math.max(0, daysBetween(cursor, chargeTo));
    if (days > 0) {
      const chargeable = prorate(rent, days, daysInPeriod);
      const split = taxSplitForRent(chargeable, rate, inclusive);
      if (M.gt(split.gross, M.ZERO)) {
        const periodEnd = addDays(chargeTo, -1);
        const invoice = await createInvoice(ctx, {
          businessUnitId: lease.business_unit_id,
          partyId: lease.party_id,
          issueDate: cursor > ctx.today ? ctx.today : cursor,
          dueDays: lease.grace_days,
          lines: [{
            itemId,
            quantity: 1,
            unitPrice: M.toNumber(split.linePrice),
            description:
              `${lease.item_name ?? "Rent"} — ${label} ${cursor} to ${periodEnd} ` +
              `(${days}/${daysInPeriod} days)`,
          }],
          notes: `${label} — ${lease.lease_number}, unit ${lease.unit_code}`,
        });
        await ctx.tx.execute(sql`
          UPDATE document_lines
             SET lease_id = ${lease.id}::uuid,
                 period_start = ${cursor}::date,
                 period_end = ${periodEnd}::date
           WHERE document_id = ${invoice.documentId}::uuid
        `);
        await ctx.tx.execute(sql`
          UPDATE documents
             SET source_table = 'leases', source_id = ${lease.id}::uuid, updated_at = now()
           WHERE id = ${invoice.documentId}::uuid
        `);
        out.push({
          documentId: invoice.documentId,
          docNumber: invoice.docNumber,
          total: invoice.total,
          periodStart: cursor,
          periodEnd,
          days,
        });
      }
    }
    cursor = gridEnd;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  FR-R01 · Lease lifecycle — renew
// ════════════════════════════════════════════════════════════════════════════

export const renewLeaseInput = z.object({
  leaseId: z.uuid(),
  /** Defaults to the day after the current term ends. */
  startsOn: z.iso.date().optional(),
  /** Defaults to a further twelve months, less one day. */
  endsOn: z.iso.date().optional(),
  /** Defaults to the current rent uplifted by the lease's escalation rate. */
  annualRent: z.number().min(0).max(100_000_000).optional(),
  rentAmount: z.number().min(0).max(10_000_000).optional(),
  billingDay: z.number().int().min(1).max(31).optional(),
  chequeCount: z.number().int().min(1).max(12).optional(),
  /** A renewal needs its own Ejari registration; the old one expires with the term. */
  ejariNumber: z.string().max(40).optional(),
  ejariRegisteredOn: z.iso.date().optional(),
  /** Top-up collected because the rent — and so the required deposit — went up. */
  additionalDeposit: z.number().min(0).max(10_000_000).default(0),
  additionalDepositVia: z.enum(["cash", "bank_transfer", "cheque"]).optional(),
  cheques: chequeBundleInput.optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface RenewLeaseResult {
  previousLeaseId: string;
  previousLeaseNumber: string;
  previousEndsOn: string;
  leaseId: string;
  leaseNumber: string;
  startsOn: string;
  endsOn: string | null;
  previousRent: number;
  rentAmount: number;
  annualRent: number;
  depositCarried: number;
  /** Rent for the outgoing term's last days, raised now because nothing else will. */
  residualInvoices: ResidualInvoice[];
  schedule: LeaseScheduleEntry[];
  chequesCreated: number;
  /** Old-bundle cheques handed back because a new bundle replaced them. */
  chequesReturned: number;
}

/**
 * Renew a tenancy onto a new term.
 *
 * MODELLED AS A SECOND LEASE ROW, not as an edit of the first. PRD FR-R01
 * requires that "renewal preserves history and does not orphan the previous
 * term", and overwriting `rent_amount` and `ends_on` in place destroys exactly
 * the record that explains every invoice already raised: an auditor looking at
 * INV-PROP-00061 for AED 5,000 would find a lease that says 5,500 and no
 * evidence the earlier figure ever existed. So the old term is closed on the
 * day before the new one starts, and the new term is a new row on the same unit
 * to the same party.
 *
 * EC-04 — A RENEWAL LANDING MID-VAT-PERIOD.
 *
 * A UAE VAT return covers a quarter. If a renewal on 15 September raises the
 * rent, the return for that quarter has to contain the old rent for 1–14
 * September and the new rent from the 15th, and an already-filed period must
 * not be restated at all. Two mechanics make that fall out rather than needing
 * a special case:
 *
 *   • The new term starts the day after the old one ends, so the two terms
 *     partition the calendar with no gap and no overlap. The rent run's
 *     proration then charges the old lease for its days and the new lease for
 *     its days, each on its own invoice line with its own `period_start` and
 *     `period_end`, and each landing in the VAT period its days belong to.
 *   • Because the terms are separate rows, they may carry DIFFERENT tax
 *     treatments — a flat re-let as a company staff apartment, a bay moved onto
 *     a commercial code once Q-1 is answered — and the split is expressed as
 *     two invoices rather than as one invoice whose treatment silently changed
 *     halfway through.
 *
 * What cannot be allowed to fall out is a renewal backdated over rent that has
 * already been invoiced: that WOULD restate a declared period, and it is
 * refused below rather than reconciled afterwards.
 *
 * The deposit is CARRIED, not re-taken. It is already sitting in TENANT_DEPOSIT
 * as this tenant's money; moving it between two lease rows is a change of
 * reference, not of liability, so no journal is posted. Only a genuine top-up
 * — new cash for a higher rent — posts anything.
 */
export async function renewLease(
  ctx: ServiceContext,
  raw: unknown,
): Promise<RenewLeaseResult> {
  const input = renewLeaseInput.parse(raw);
  requirePermission(ctx, "lease:update");

  return withIdempotency(ctx, input.idempotencyKey, "renewLease", async () => {
    const rows = await ctx.tx.execute<LeaseRow>(sql`
      ${LEASE_SELECT}
      WHERE l.id = ${input.leaseId}::uuid AND l.deleted_at IS NULL
      FOR NO KEY UPDATE OF l
    `);
    const lease = rows[0];
    if (!lease) throw new ServiceError("Lease not found.", "not_found");
    requireBusinessUnit(ctx, lease.business_unit_id);

    if (!["active", "expiring"].includes(lease.status)) {
      throw new ServiceError(
        `Only a live tenancy can be renewed — this one is "${lease.status}".`,
        "conflict",
      );
    }

    const startsOn = input.startsOn
      ?? (lease.ends_on ? addDays(lease.ends_on, 1) : addDays(ctx.today, 1));
    if (startsOn <= lease.starts_on) {
      throw new ServiceError(
        `A renewal must start after the current term began (${lease.starts_on}).`,
        "invalid",
      );
    }
    const endsOn = input.endsOn ?? addDays(addMonths(startsOn, 12), -1);
    if (endsOn < startsOn) {
      throw new ServiceError("The renewed term cannot end before it starts.", "invalid");
    }

    /**
     * The EC-04 guard.
     *
     * If the current term has already been invoiced for a period that begins on
     * or after the renewal date, that invoice — and the VAT on it — describes
     * days the new term now claims. Silently ending the old lease underneath it
     * would leave a filed VAT return describing a lease that says those days
     * were let at a different rate, and possibly under a different treatment.
     * Refuse, and name the document, so the operator credits it or renews from
     * the following period instead.
     */
    const overlapping = await ctx.tx.execute<{
      doc_number: string; period_start: string; period_end: string;
    }>(sql`
      SELECT d.doc_number, dl.period_start::text, dl.period_end::text
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
       WHERE dl.lease_id = ${lease.id}::uuid
         -- period_end, not period_start. An invoice raised on 15 September for
         -- the month to 14 October STARTS before a renewal dated the 20th and
         -- would slip past a start-date test, while still charging the tenant
         -- for twenty-five days the new term is about to claim at a different
         -- rate. It is the END of the invoiced period that says whether an
         -- already-declared supply reaches into the new term.
         AND dl.period_end >= ${startsOn}::date
         AND d.doc_type = 'invoice'
         AND d.status NOT IN ('cancelled', 'void')
       ORDER BY dl.period_start
       LIMIT 1
    `);
    if (overlapping.length > 0) {
      throw new ServiceError(
        `${overlapping[0]!.doc_number} already invoices the current term to ` +
          `${overlapping[0]!.period_end}, which the renewal from ${startsOn} would take over. ` +
          `Renew from ${addDays(overlapping[0]!.period_end, 1)}, or credit that invoice first.`,
        "conflict",
      );
    }

    // ── The new rent ──────────────────────────────────────────────────────
    const previousMonthly = M.fromDb(lease.rent_amount);
    let monthly: M.Money;
    let annual: M.Money;
    if (input.rentAmount !== undefined) {
      monthly = M.money(input.rentAmount);
      annual = M.quantize(M.mul(monthly, 12));
    } else if (input.annualRent !== undefined) {
      annual = M.money(input.annualRent);
      monthly = M.quantize(M.div(annual, 12));
    } else {
      // The lease's own escalation rate is the default, which is what the
      // contract says will happen if nobody renegotiates. Dubai's RERA rental
      // index caps what a landlord may actually impose; the cap is a legal
      // question about a specific property and is not decided here.
      monthly = M.quantize(M.mul(previousMonthly, M.add(M.money(1), M.fromDb(lease.escalation_rate))));
      annual = M.quantize(M.mul(monthly, 12));
    }
    if (M.isZero(annual)) {
      throw new ServiceError("A renewed lease needs a rent.", "invalid");
    }

    const previousEndsOn = addDays(startsOn, -1);
    const depositCarried = M.fromDb(lease.deposit_held);
    const topUp = M.money(input.additionalDeposit);
    const newDepositHeld = M.add(depositCarried, input.additionalDepositVia ? topUp : M.ZERO);

    // Close the old term. `termination_reason` carries the forward pointer
    // because `leases` has no `renewed_from_lease_id` column — the structured
    // link lives in the audit row below, and the schema change is noted for
    // whoever owns the migration chain.
    const newNumberPreview = await nextDocumentNumber(
      ctx, lease.business_unit_id, "lease", `LEA-${lease.bu_code}`,
    );

    await ctx.tx.execute(sql`
      UPDATE leases
         SET status = 'ended', ends_on = ${previousEndsOn}::date, deposit_held = '0',
             termination_reason = concat_ws(E'\n', nullif(termination_reason, ''),
               ${`Renewed — superseded by ${newNumberPreview} from ${startsOn}.`}::text),
             updated_at = now()
       WHERE id = ${lease.id}::uuid
    `);

    const inserted = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO leases
        (id, tenant_id, business_unit_id, unit_id, party_id, lease_number, status,
         starts_on, ends_on, auto_renew, notice_period_days, annual_rent, rent_amount,
         frequency, billing_day, collection_method, cheque_count, ejari_number,
         ejari_registered_on, dewa_premise_number, deposit_amount, deposit_held,
         escalation_rate, grace_days)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${lease.business_unit_id}::uuid,
         ${lease.unit_id}::uuid, ${lease.party_id}::uuid, ${newNumberPreview}, 'active',
         ${startsOn}::date, ${endsOn}::date, false, ${lease.notice_period_days},
         ${M.toDb(annual)}, ${M.toDb(monthly)}, 'monthly',
         ${input.billingDay ?? lease.billing_day}, ${lease.collection_method}::collection_method,
         ${input.chequeCount ?? lease.cheque_count}, ${input.ejariNumber ?? null},
         ${input.ejariRegisteredOn ?? null}::date, null,
         ${M.toDb(M.max(M.fromDb(lease.deposit_amount), newDepositHeld))},
         ${M.toDb(newDepositHeld)},
         ${M.fromDb(lease.escalation_rate).toFixed(6)}, ${lease.grace_days})
      RETURNING id
    `);
    const leaseId = inserted[0]!.id;

    // The charge row's item — and therefore the VAT treatment — carries over
    // unchanged. Changing it is a re-letting decision, made through the lease
    // editor on the new term, not a side effect of renewing.
    const itemId = lease.item_id ?? (await defaultRentItem(ctx, lease.business_unit_id))?.id;
    if (!itemId) {
      throw new ServiceError(
        `No rent item is configured for ${lease.bu_name}; the renewed lease has nothing to bill through.`,
        "invalid",
      );
    }
    await ctx.tx.execute(sql`
      INSERT INTO lease_charges
        (id, tenant_id, lease_id, item_id, label, amount, frequency, starts_on, ends_on, is_active)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${leaseId}::uuid, ${itemId}::uuid,
         ${lease.charge_label ?? lease.item_name ?? "Rent"}, ${M.toDb(monthly)}, 'monthly',
         ${startsOn}::date, ${endsOn}::date, true)
    `);
    await ctx.tx.execute(sql`
      UPDATE lease_charges SET is_active = false, ends_on = ${previousEndsOn}::date,
                               updated_at = now()
       WHERE lease_id = ${lease.id}::uuid AND is_active = true
    `);

    if (input.additionalDepositVia && M.gt(topUp, M.ZERO)) {
      const cashKey =
        input.additionalDepositVia === "cash" ? "CASH"
        : input.additionalDepositVia === "cheque" ? "PDC_ON_HAND" : "BANK";
      await postJournal(ctx, {
        postingDate: ctx.today,
        source: "manual",
        sourceTable: "leases",
        sourceId: leaseId,
        narration: `Deposit top-up on renewal — ${newNumberPreview}, unit ${lease.unit_code}`,
        legs: [
          { accountKey: cashKey, businessUnitId: lease.business_unit_id, debit: topUp },
          { accountKey: "TENANT_DEPOSIT", businessUnitId: lease.business_unit_id,
            credit: topUp, partyId: lease.party_id },
        ],
      });
    }

    /**
     * The tail of the outgoing term.
     *
     * Two cases, and only one of them belongs here.
     *
     *  • A renewal effective TODAY OR EARLIER closes a term whose last days are
     *    already in the past. Nothing will ever bill them — the rent run reaches
     *    an `ended` lease only for periods whose anniversary has arrived — so
     *    they are invoiced now, at the OLD rate, which is what the tenant
     *    contracted for on those days.
     *  • A renewal agreed IN ADVANCE closes a term that still has months to run.
     *    Those months must be billed on their own anniversaries, not pulled
     *    forward into an invoice dated today, so they are left to the rent run.
     *
     * Either way the already-billed guard makes a double charge impossible.
     */
    const residualInvoices = previousEndsOn <= ctx.today && itemId
      ? await billResidualPeriods(ctx, lease, itemId, previousEndsOn, "term closed on renewal")
      : [];

    const schedule = buildSchedule({
      startsOn,
      endsOn,
      billingDay: input.billingDay ?? lease.billing_day,
      instalments: input.chequeCount ?? lease.cheque_count ?? 1,
      monthlyRent: monthly,
      rate: M.fromDb(lease.tax_rate),
      inclusive: Boolean(lease.tax_inclusive),
      chequeNumbers: (input.cheques ?? []).map((c) => c.chequeNumber),
    });

    let chequesCreated = 0;
    for (const [i, entry] of schedule.entries()) {
      const supplied = input.cheques?.[i];
      if (!supplied) continue;
      await ctx.tx.execute(sql`
        INSERT INTO cheques
          (id, tenant_id, business_unit_id, direction, party_id, lease_id, cheque_number,
           bank_name, cheque_date, amount, currency, status, period_start, period_end,
           received_on, custody_location)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${lease.business_unit_id}::uuid, 'in',
           ${lease.party_id}::uuid, ${leaseId}::uuid, ${supplied.chequeNumber},
           ${supplied.bankName ?? null}, ${entry.dueOn}::date,
           ${M.toDb(M.money(entry.amount))}, ${ctx.baseCurrency}, 'held',
           ${entry.periodStart}::date, ${addDays(entry.periodEnd, 1)}::date,
           ${ctx.today}::date, 'Head office safe')
      `);
      chequesCreated++;
    }

    /**
     * Hand back the outgoing term's unbanked cheques for periods it no longer
     * covers — but only once a replacement bundle is in hand.
     *
     * At a UAE renewal the tenant signs the new contract and swaps the cheque
     * bundle in the same visit, so a cheque dated for a period the old term no
     * longer covers is an instrument written against a contract that has ended.
     * Returning it is the honest state, and `transitionCheque` owns that
     * transition and its guard.
     *
     * Conditional on a new bundle because the alternative is worse: returning
     * the old cheques when nothing replaces them leaves a renewed tenancy with
     * no means of collection at all, and the tenant's cheques already in the
     * landlord's safe are the only thing standing behind the rent. When no new
     * bundle is supplied the old cheques stay where they are and the rent run
     * raises its "no cheque on file" warning against the new term, which is a
     * visible problem rather than a silent one.
     */
    let chequesReturned = 0;
    if (chequesCreated > 0) {
      const stale = await ctx.tx.execute<{ id: string }>(sql`
        SELECT id FROM cheques
         WHERE lease_id = ${lease.id}::uuid AND status = 'held'
           AND period_start > ${previousEndsOn}::date
         ORDER BY cheque_date
      `);
      for (const cheque of stale) {
        await transitionCheque(ctx, {
          chequeId: cheque.id,
          action: "return",
          onDate: ctx.today,
          reason: `Replaced by the ${newNumberPreview} bundle on renewal`,
        });
        chequesReturned++;
      }
    }

    await writeAudit(ctx, {
      action: "lease.renew",
      entityTable: "leases",
      entityId: leaseId,
      businessUnitId: lease.business_unit_id,
      diff: {
        renewedFromLeaseId: lease.id,
        renewedFromLeaseNumber: lease.lease_number,
        leaseNumber: newNumberPreview,
        unit: lease.unit_code,
        previousEndsOn, startsOn, endsOn,
        previousRent: M.toDb(previousMonthly),
        rentAmount: M.toDb(monthly),
        depositCarried: M.toDb(depositCarried),
        depositTopUp: M.toDb(input.additionalDepositVia ? topUp : M.ZERO),
        residualInvoices: residualInvoices.map((r) => r.docNumber),
        cheques: chequesCreated, chequesReturned,
      },
    });

    return {
      previousLeaseId: lease.id,
      previousLeaseNumber: lease.lease_number,
      previousEndsOn,
      leaseId,
      leaseNumber: newNumberPreview,
      startsOn,
      endsOn,
      previousRent: M.toNumber(previousMonthly),
      rentAmount: M.toNumber(monthly),
      annualRent: M.toNumber(annual),
      depositCarried: M.toNumber(depositCarried),
      residualInvoices,
      schedule,
      chequesCreated,
      chequesReturned,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FR-R01 · Lease lifecycle — terminate
// ════════════════════════════════════════════════════════════════════════════

export const terminateLeaseInput = z.object({
  leaseId: z.uuid(),
  /** The last day of occupation, inclusive. */
  terminatedOn: z.iso.date(),
  reason: z.string().min(1).max(500),
  /**
   * Raise the prorated rent for the days occupied but not yet invoiced.
   * Off only when the operator has already billed them by hand.
   */
  billFinalRent: z.boolean().default(true),
  /**
   * Credit rent already invoiced for days after the termination date. Requires
   * `payment:refund`; when the operator cannot, the amount is reported instead
   * of being quietly kept.
   */
  creditUnusedRent: z.boolean().default(true),
  /** Withheld from the deposit — damage, cleaning, unpaid utilities. */
  deductions: z
    .array(z.object({ label: z.string().min(1).max(120), amount: z.number().positive() }))
    .max(20)
    .default([]),
  /** Deposit set against outstanding rent. Omitted = as much as will fit. */
  applyToArrears: z.number().min(0).max(10_000_000).optional(),
  /** Omitted = whatever remains of the deposit is returned. */
  refundAmount: z.number().min(0).max(10_000_000).optional(),
  refundVia: z.enum(["cash", "bank_transfer", "none"]).default("bank_transfer"),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface TerminateLeaseResult {
  leaseId: string;
  leaseNumber: string;
  unitCode: string;
  terminatedOn: string;
  finalInvoices: ResidualInvoice[];
  creditNote: { documentId: string; docNumber: string; total: number } | null;
  /** Billed beyond the termination date and NOT credited — the operator must act. */
  uncreditedUnusedRent: number;
  settlement: {
    depositHeld: number;
    deductions: number;
    appliedToArrears: number;
    refunded: number;
    remainingArrears: number;
  };
  chequesReturned: number;
}

/**
 * End a tenancy, settle the deposit, refund the balance.
 *
 * The order matters and is the whole design: bill what is owed, credit what was
 * over-billed, THEN settle the deposit against a receivable that is finally
 * correct. Settling first and invoicing afterwards produces a refund computed
 * against a number that was still moving.
 *
 * THE DEPOSIT NEVER SHRINKS BY ROUNDING. Deductions, the amount set against
 * arrears and the refund must together be no more than the deposit held, and an
 * excess is refused exactly rather than clamped — a `GREATEST(0, …)` here would
 * absorb an operator's typo into thin air and leave the TENANT_DEPOSIT control
 * account permanently out of step with the sum of the leases behind it.
 *
 * WHAT IS DELIBERATELY NOT AUTOMATED: whether a deduction is a VATable supply.
 * Retaining a deposit for damage is compensation rather than consideration for
 * a supply and is normally outside the scope of VAT, but a charge for cleaning
 * the tenant asked for is a supply that is not. The deduction posts to other
 * income with no VAT, and the settlement statement says so, so an accountant
 * can reclassify a case that needs it instead of discovering it on a return.
 */
export async function terminateLease(
  ctx: ServiceContext,
  raw: unknown,
): Promise<TerminateLeaseResult> {
  const input = terminateLeaseInput.parse(raw);
  requirePermission(ctx, "lease:terminate");

  return withIdempotency(ctx, input.idempotencyKey, "terminateLease", async () => {
    const rows = await ctx.tx.execute<LeaseRow>(sql`
      ${LEASE_SELECT}
      WHERE l.id = ${input.leaseId}::uuid AND l.deleted_at IS NULL
      FOR NO KEY UPDATE OF l
    `);
    const lease = rows[0];
    if (!lease) throw new ServiceError("Lease not found.", "not_found");
    requireBusinessUnit(ctx, lease.business_unit_id);

    if (!["active", "expiring", "defaulted"].includes(lease.status)) {
      throw new ServiceError(
        `This tenancy is already "${lease.status}".`,
        "conflict",
      );
    }
    if (input.terminatedOn < lease.starts_on) {
      throw new ServiceError(
        `A tenancy cannot end (${input.terminatedOn}) before it began (${lease.starts_on}).`,
        "invalid",
      );
    }

    const itemId = lease.item_id ?? (await defaultRentItem(ctx, lease.business_unit_id))?.id ?? null;

    /**
     * ── 1 · Everything that can be refused is refused BEFORE anything is
     * written ──────────────────────────────────────────────────────────────
     *
     * This function raises invoices, issues a credit note and posts three
     * journals; a validation failure discovered halfway leaves the earlier
     * writes standing. In the web app each action is one transaction, so a
     * throw unwinds them — but relying on the caller's transaction boundary to
     * make a guard work is exactly the pattern this codebase treats as a
     * defect: "a guard that throws after the UPDATE has landed is not a guard."
     * Found by the verification run, where a deliberately impossible deduction
     * was refused only after four final-rent invoices had already been raised,
     * and the retry then found nothing left to bill.
     *
     * Only the arrears comparison genuinely cannot be made yet — the final rent
     * is part of the arrears — so it stays below, after the invoicing, and it
     * is the one check that operates on a number the operator did not type.
     */
    const held = M.fromDb(lease.deposit_held);
    const deductionTotal = M.quantize(
      M.sum(input.deductions.map((d) => M.money(d.amount))),
    );
    if (M.gt(deductionTotal, held)) {
      throw new ServiceError(
        `Deductions of ${M.toDisplay(deductionTotal)} exceed the ${M.toDisplay(held)} deposit held. ` +
          `Bill the excess as a charge rather than withholding money that is not there.`,
        "invalid",
      );
    }
    const afterDeductions = M.sub(held, deductionTotal);
    if (input.applyToArrears !== undefined
        && M.gt(M.money(input.applyToArrears), afterDeductions)) {
      throw new ServiceError(
        `Cannot set ${M.toDisplay(M.money(input.applyToArrears))} against arrears — only ` +
          `${M.toDisplay(afterDeductions)} of the deposit remains after deductions.`,
        "invalid",
      );
    }
    if (input.refundAmount !== undefined
        && M.gt(M.money(input.refundAmount), afterDeductions)) {
      throw new ServiceError(
        `Cannot refund ${M.toDisplay(M.money(input.refundAmount))} — the deposit holds ` +
          `${M.toDisplay(afterDeductions)} after deductions.`,
        "invalid",
      );
    }

    // ── 2 · Final rent for days occupied but not yet billed ───────────────
    const finalInvoices = input.billFinalRent && itemId
      ? await billResidualPeriods(ctx, lease, itemId, input.terminatedOn, "final settlement")
      : [];

    // ── 3 · Credit rent billed beyond the last day ────────────────────────
    // An annual lease broken in month four has eight months of nothing already
    // invoiced when the tenant paid by a single cheque, or one part-month when
    // they pay monthly. Either way it is the landlord holding money for days
    // they will not let, and it has to come back off the receivable before the
    // deposit is settled against it.
    let creditNote: TerminateLeaseResult["creditNote"] = null;
    let creditedTotal = 0;
    let uncredited = M.ZERO;
    const overBilled = await ctx.tx.execute<{
      document_id: string; doc_number: string; period_start: string; period_end: string;
      unit_price: string; line_total: string; tax_rate: string; status: string;
    }>(sql`
      SELECT d.id AS document_id, d.doc_number, dl.period_start::text, dl.period_end::text,
             dl.unit_price, dl.line_total, dl.tax_rate, d.status::text
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
       WHERE dl.lease_id = ${lease.id}::uuid
         AND dl.period_end > ${input.terminatedOn}::date
         AND d.doc_type = 'invoice' AND d.status NOT IN ('cancelled', 'void')
       ORDER BY dl.period_start
    `);
    for (const line of overBilled) {
      const periodEndExclusive = addDays(line.period_end, 1);
      const totalDays = daysBetween(line.period_start, periodEndExclusive);
      const unusedFrom = maxDate(line.period_start, addDays(input.terminatedOn, 1));
      const unusedDays = Math.max(0, daysBetween(unusedFrom, periodEndExclusive));
      if (unusedDays === 0 || totalDays === 0) continue;

      const linePrice = M.fromDb(line.unit_price);
      const refundPrice = M.quantize(M.div(M.mul(linePrice, unusedDays), totalDays));
      if (M.isZero(refundPrice)) continue;

      if (!input.creditUnusedRent || !ctx.principal.permissions.has("payment:refund")) {
        // The whole point is that this number does not disappear. It comes back
        // in the result so the settlement statement can say "AED X of rent is
        // invoiced beyond the termination date and has not been credited".
        // The gross, not the net: what the tenant was actually charged for days
        // they will not occupy is the number the operator has to act on.
        uncredited = M.add(uncredited, M.quantize(
          M.div(M.mul(M.fromDb(line.line_total), unusedDays), totalDays),
        ));
        continue;
      }
      const note = await createCreditNote(ctx, {
        invoiceId: line.document_id,
        reason: `Lease ${lease.lease_number} terminated ${input.terminatedOn} — ` +
          `${unusedDays} of ${totalDays} days not let`,
        lines: [{
          description: `Unused rent ${unusedFrom} to ${line.period_end} (${unusedDays}/${totalDays} days)`,
          quantity: 1,
          unitPrice: M.toNumber(refundPrice),
          taxRate: M.toNumber(M.fromDb(line.tax_rate)),
        }],
        refundMethod: "credit_on_account",
      });
      creditedTotal += note.total;
      creditNote = {
        documentId: note.creditNoteId,
        docNumber: note.docNumber,
        total: creditedTotal,
      };
    }

    // ── 4 · Settle the deposit ────────────────────────────────────────────
    const arrearsRows = await ctx.tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(d.amount_due), 0) AS total
        FROM documents d
       WHERE d.id IN (
         SELECT DISTINCT dl.document_id FROM document_lines dl
          WHERE dl.lease_id = ${lease.id}::uuid
       )
         AND d.direction = 'in' AND d.amount_due > 0
         AND d.status NOT IN ('cancelled', 'void', 'draft')
    `);
    const arrears = M.fromDb(arrearsRows[0]?.total);
    const applied = input.applyToArrears !== undefined
      ? M.money(input.applyToArrears)
      : M.min(afterDeductions, arrears);
    if (M.gt(applied, arrears)) {
      throw new ServiceError(
        `Cannot set ${M.toDisplay(applied)} against arrears of ${M.toDisplay(arrears)}. ` +
          `Over-applying would leave a negative balance on the tenant's account.`,
        "invalid",
      );
    }

    const available = M.sub(afterDeductions, applied);
    const refund = input.refundVia === "none"
      ? M.ZERO
      : input.refundAmount !== undefined ? M.money(input.refundAmount) : available;
    if (M.gt(refund, available)) {
      throw new ServiceError(
        `Cannot refund ${M.toDisplay(refund)} — only ${M.toDisplay(available)} of the ` +
          `deposit remains after deductions and arrears.`,
        "invalid",
      );
    }

    // Whatever is left after deductions, arrears and the refund stays in
    // TENANT_DEPOSIT against this tenant. That is deliberate: an unreturned
    // balance is still the tenant's money until somebody decides otherwise,
    // and quietly writing it to income here would be that decision.
    const retained = M.sub(available, refund);

    if (M.gt(deductionTotal, M.ZERO)) {
      await postJournal(ctx, {
        postingDate: input.terminatedOn > ctx.today ? ctx.today : input.terminatedOn,
        source: "manual",
        sourceTable: "leases",
        sourceId: lease.id,
        narration: `Deposit deductions — ${lease.lease_number}, unit ${lease.unit_code}`,
        legs: [
          { accountKey: "TENANT_DEPOSIT", businessUnitId: lease.business_unit_id,
            debit: deductionTotal, partyId: lease.party_id },
          { accountKey: "REV_OTHER", businessUnitId: lease.business_unit_id,
            credit: deductionTotal,
            memo: input.deductions.map((d) => `${d.label} ${M.toDisplay(M.money(d.amount))}`).join("; ") },
        ],
      });
    }

    if (M.gt(applied, M.ZERO)) {
      await settleArrearsFromDeposit(ctx, lease, applied);
    }

    if (M.gt(refund, M.ZERO)) {
      await postJournal(ctx, {
        postingDate: input.terminatedOn > ctx.today ? ctx.today : input.terminatedOn,
        source: "manual",
        sourceTable: "leases",
        sourceId: lease.id,
        narration: `Deposit refund — ${lease.lease_number}, unit ${lease.unit_code}`,
        legs: [
          { accountKey: "TENANT_DEPOSIT", businessUnitId: lease.business_unit_id,
            debit: refund, partyId: lease.party_id },
          { accountKey: input.refundVia === "cash" ? "CASH" : "BANK",
            businessUnitId: lease.business_unit_id, credit: refund },
        ],
      });
    }

    // ── 5 · Close the records ─────────────────────────────────────────────
    await ctx.tx.execute(sql`
      UPDATE leases
         SET status = 'terminated', terminated_on = ${input.terminatedOn}::date,
             ends_on = ${input.terminatedOn}::date,
             termination_reason = ${input.reason},
             deposit_held = ${M.toDb(retained)},
             balance_due = GREATEST(0, balance_due - ${M.toDb(applied)}),
             updated_at = now()
       WHERE id = ${lease.id}::uuid
    `);
    await ctx.tx.execute(sql`
      UPDATE lease_charges SET is_active = false, ends_on = ${input.terminatedOn}::date,
                               updated_at = now()
       WHERE lease_id = ${lease.id}::uuid AND is_active = true
    `);
    await ctx.tx.execute(sql`
      UPDATE units
         SET status = ${input.terminatedOn <= ctx.today ? "available" : "notice"}::unit_status,
             updated_at = now()
       WHERE id = ${lease.unit_id}::uuid
    `);

    // Unbanked cheques for periods the tenant will not occupy go back to them.
    // `transitionCheque` owns that state machine and its guard — reproducing
    // the transition here would be a second implementation of it.
    const toReturn = await ctx.tx.execute<{ id: string }>(sql`
      SELECT id FROM cheques
       WHERE lease_id = ${lease.id}::uuid AND status = 'held'
         AND period_start > ${input.terminatedOn}::date
       ORDER BY cheque_date
    `);
    for (const cheque of toReturn) {
      await transitionCheque(ctx, {
        chequeId: cheque.id,
        action: "return",
        onDate: input.terminatedOn > ctx.today ? ctx.today : input.terminatedOn,
        reason: `Lease ${lease.lease_number} terminated`,
      });
    }

    const remainingRows = await ctx.tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(d.amount_due), 0) AS total
        FROM documents d
       WHERE d.id IN (
         SELECT DISTINCT dl.document_id FROM document_lines dl
          WHERE dl.lease_id = ${lease.id}::uuid
       )
         AND d.direction = 'in' AND d.amount_due > 0
         AND d.status NOT IN ('cancelled', 'void', 'draft')
    `);

    await writeAudit(ctx, {
      action: "lease.terminate",
      entityTable: "leases",
      entityId: lease.id,
      businessUnitId: lease.business_unit_id,
      diff: {
        leaseNumber: lease.lease_number, unit: lease.unit_code,
        terminatedOn: input.terminatedOn, reason: input.reason,
        finalInvoices: finalInvoices.map((f) => f.docNumber),
        creditNote: creditNote?.docNumber ?? null,
        uncreditedUnusedRent: M.toDb(uncredited),
        depositHeld: M.toDb(held), deductions: M.toDb(deductionTotal),
        appliedToArrears: M.toDb(applied), refunded: M.toDb(refund),
        retained: M.toDb(retained), chequesReturned: toReturn.length,
      },
    });

    return {
      leaseId: lease.id,
      leaseNumber: lease.lease_number,
      unitCode: lease.unit_code,
      terminatedOn: input.terminatedOn,
      finalInvoices,
      creditNote,
      uncreditedUnusedRent: M.toNumber(uncredited),
      settlement: {
        depositHeld: M.toNumber(held),
        deductions: M.toNumber(deductionTotal),
        appliedToArrears: M.toNumber(applied),
        refunded: M.toNumber(refund),
        remainingArrears: M.toNumber(M.fromDb(remainingRows[0]?.total)),
      },
      chequesReturned: toReturn.length,
    };
  });
}

/**
 * Set part of the deposit against the tenant's outstanding rent.
 *
 * Written here rather than through `recordPayment` because no money moves. The
 * ledger entry is DR TENANT_DEPOSIT / CR AR — a liability discharged against a
 * receivable — while `recordPayment` would debit cash or bank for funds that
 * arrived a year ago and are already on the balance sheet. What IS reused is
 * its discipline: a `payments` row with method `adjustment` and matching
 * allocations, so the AR sub-ledger and the control account move together and
 * the tenant's statement shows why the balance fell.
 *
 * Oldest invoice first, and never more than each invoice's outstanding balance,
 * so the same over-allocation that is refused for cash is impossible here.
 */
async function settleArrearsFromDeposit(
  ctx: ServiceContext,
  lease: LeaseRow,
  amount: M.Money,
): Promise<void> {
  const open = await ctx.tx.execute<{ id: string; amount_due: string; total: string; amount_paid: string }>(sql`
    SELECT d.id, d.amount_due, d.total, d.amount_paid
      FROM documents d
     WHERE d.id IN (
       SELECT DISTINCT dl.document_id FROM document_lines dl
        WHERE dl.lease_id = ${lease.id}::uuid
     )
       AND d.direction = 'in' AND d.amount_due > 0
       AND d.status NOT IN ('cancelled', 'void', 'draft')
     ORDER BY d.due_date ASC NULLS LAST, d.issue_date ASC
     FOR UPDATE
  `);

  const paymentNumber = await nextDocumentNumber(
    ctx, lease.business_unit_id, "payment", `PAY-${lease.bu_code}`,
  );
  const pay = await ctx.tx.execute<{ id: string }>(sql`
    INSERT INTO payments
      (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
       amount, currency, base_amount, unallocated_amount, received_on, reference,
       received_by_user_id, posted_at, note)
    VALUES
      (gen_random_uuid(), ${ctx.tenantId}::uuid, ${lease.business_unit_id}::uuid,
       ${paymentNumber}, 'in', ${lease.party_id}::uuid, 'adjustment',
       ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)}, '0',
       ${ctx.today}::date, ${`Security deposit applied — ${lease.lease_number}`},
       ${ctx.principal.userId}::uuid, now(),
       'Deposit set against arrears on termination. No cash movement.')
    RETURNING id
  `);
  const paymentId = pay[0]!.id;

  let remaining = amount;
  for (const doc of open) {
    if (!M.gt(remaining, M.ZERO)) break;
    const take = M.min(remaining, M.fromDb(doc.amount_due));
    await ctx.tx.execute(sql`
      INSERT INTO payment_allocations (id, tenant_id, payment_id, document_id, amount)
      VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${paymentId}::uuid,
              ${doc.id}::uuid, ${M.toDb(take)})
    `);
    await ctx.tx.execute(sql`
      UPDATE documents
         SET amount_paid = amount_paid + ${M.toDb(take)},
             amount_due  = total - (amount_paid + ${M.toDb(take)}),
             status = CASE
               WHEN total - (amount_paid + ${M.toDb(take)}) <= 0 THEN 'paid'::doc_status
               ELSE 'partially_paid'::doc_status END,
             days_overdue = CASE
               WHEN total - (amount_paid + ${M.toDb(take)}) <= 0 THEN 0
               ELSE days_overdue END,
             updated_at = now()
       WHERE id = ${doc.id}::uuid
    `);
    remaining = M.sub(remaining, take);
  }

  if (M.gt(remaining, M.ZERO)) {
    // The caller already refused an amount larger than the arrears, so reaching
    // this means the two reads disagreed. Fail rather than leave an unallocated
    // "payment" that no invoice explains.
    throw new ServiceError(
      `Could not allocate ${M.toDisplay(remaining)} of the deposit — the outstanding ` +
        `invoices moved while the settlement was being prepared. Try again.`,
      "conflict",
    );
  }

  await postJournal(ctx, {
    postingDate: ctx.today,
    source: "payment",
    sourceTable: "payments",
    sourceId: paymentId,
    narration: `Deposit applied to arrears — ${lease.lease_number}, unit ${lease.unit_code}`,
    legs: [
      { accountKey: "TENANT_DEPOSIT", businessUnitId: lease.business_unit_id,
        debit: amount, partyId: lease.party_id },
      { accountKey: "AR", businessUnitId: lease.business_unit_id,
        credit: amount, partyId: lease.party_id },
    ],
  });

  await ctx.tx.execute(sql`
    UPDATE parties
       SET open_balance = GREATEST(0, open_balance - ${M.toDb(amount)}),
           last_transaction_at = now()
     WHERE id = ${lease.party_id}::uuid
  `);
}
