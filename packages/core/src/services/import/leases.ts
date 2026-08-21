import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { Index, leaseIndex, partyIndex, unitIndex } from "./lookups.ts";
import {
  CellError,
  byRowNumber,
  readDate,
  readEnum,
  readInteger,
  readMoney,
  readText,
  toIssue,
} from "./source.ts";
import type {
  ApplyOutcome,
  BatchRecorder,
  ImportContext,
  ImportPlan,
  Importer,
  PlannedRow,
  RowIssue,
  SourceRow,
} from "./types.ts";

/**
 * ACTIVE LEASES.
 *
 * The record that makes the rent run possible, and the one with the most ways
 * to be quietly wrong. Three constraints shape this importer, and all three are
 * enforced in the dry run rather than left to the database:
 *
 *  1. ONE ACTIVE LEASE PER UNIT. `leases_one_active_per_unit` is a partial
 *     unique index, so the database will refuse the second one — at COMMIT,
 *     after the user has pressed Import, with a constraint name. Detecting it
 *     here names the two rows and the flat instead, and it catches the more
 *     common case the index cannot see: the unit is already let under a lease
 *     that is not in this file.
 *
 *  2. THE UNIT AND THE TENANT MUST EXIST. This importer creates neither. A
 *     lease that invents a party would create a second Ahmed beside the one in
 *     the CRM, and every payment after that lands against the wrong record.
 *
 *  3. RENT IS NOT DERIVED. `annual_rent` and `rent_amount` are both read from
 *     the file, and a `rent_amount` that does not divide into `annual_rent` at
 *     the stated frequency is reported as a WARNING on the row, not corrected.
 *     UAE leases genuinely do carry uneven instalments — four cheques for an
 *     annual rent that does not divide by four is normal — so this cannot be an
 *     error, and it must not be silently "fixed" either.
 *
 * NO LEDGER POSTING. A lease is a contract, not a transaction. The rent
 * receivable that already exists on the day of migration is an opening balance
 * and comes from the trial balance; the invoices behind it come from the
 * `debts` importer. Posting rent here would double it.
 */

const COLUMNS = [
  "lease_number",
  "unit",
  "tenant",
  "starts_on",
  "ends_on",
  "status",
  "annual_rent",
  "rent_amount",
  "frequency",
  "billing_day",
  "collection_method",
  "cheque_count",
  "deposit_amount",
  "deposit_held",
  "ejari_number",
  "notice_period_days",
  "grace_days",
] as const;

const LEASE_STATUSES = ["draft", "active", "expiring", "ended", "terminated", "defaulted"] as const;
const FREQUENCIES = ["one_off", "daily", "weekly", "monthly", "quarterly", "yearly"] as const;
const COLLECTION = [
  "post_dated_cheques",
  "bank_transfer",
  "direct_debit",
  "cash",
  "mixed",
] as const;

const PERIODS_PER_YEAR: Record<(typeof FREQUENCIES)[number], number> = {
  one_off: 1,
  daily: 365,
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};

export interface LeasePlanRow {
  leaseNumber: string;
  unitId: string;
  partyId: string;
  startsOn: string;
  endsOn: string | null;
  status: (typeof LEASE_STATUSES)[number];
  annualRent: M.Money;
  rentAmount: M.Money;
  frequency: (typeof FREQUENCIES)[number];
  billingDay: number;
  collectionMethod: (typeof COLLECTION)[number];
  chequeCount: number | null;
  depositAmount: M.Money;
  depositHeld: M.Money;
  ejariNumber: string | null;
  noticePeriodDays: number;
  graceDays: number;
  /** Marks the unit occupied on apply. Recorded so the reversal can undo it. */
  occupiesUnit: boolean;
}

export function planLeases(
  rows: SourceRow[],
  units: Index,
  parties: Index,
  leases: Index,
  unitsAlreadyLet: Map<string, string>,
): ImportPlan {
  const planned: PlannedRow<LeasePlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const numbersSeen = new Map<string, number>();
  const activeUnitsInFile = new Map<string, number>();

  let annualRentTotal = M.ZERO;
  let depositTotal = M.ZERO;
  let creates = 0;

  for (const row of rows) {
    try {
      const leaseNumber = readText(row, "lease_number", { max: 40, required: true });
      const duplicate = numbersSeen.get(leaseNumber.toLowerCase());
      if (duplicate !== undefined) {
        throw new CellError("lease_number", `Lease ${leaseNumber} is already on row ${duplicate}.`);
      }
      numbersSeen.set(leaseNumber.toLowerCase(), row.rowNumber);

      const unitToken = readText(row, "unit", { max: 200, required: true });
      const unit = units.resolve(unitToken);
      if (unit === null) {
        throw new CellError(
          "unit",
          `No unit matches "${unitToken}". Import the units first, or write it as ` +
            `"Building name 402".`,
        );
      }
      if (unit === "ambiguous") {
        throw new CellError(
          "unit",
          `"${unitToken}" exists in more than one building. Write it as "Building name ${unitToken}".`,
        );
      }

      const tenantToken = readText(row, "tenant", { max: 200, required: true });
      const party = parties.resolve(tenantToken);
      if (party === null) {
        throw new CellError(
          "tenant",
          `No party matches "${tenantToken}". Import customers and tenants first.`,
        );
      }
      if (party === "ambiguous") {
        throw new CellError(
          "tenant",
          `"${tenantToken}" matches more than one party. Use their code instead of their name.`,
        );
      }

      const existing = leases.resolve(leaseNumber);
      if (existing && existing !== "ambiguous") {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${leaseNumber} · ${unit.found.label}`,
          detail: "Already on file. Leases are never overwritten by an import.",
          payload: null as unknown as LeasePlanRow,
        });
        continue;
      }

      const startsOn = readDate(row, "starts_on");
      const endsOn = row.has("ends_on") ? readDate(row, "ends_on") : null;
      if (endsOn !== null && endsOn <= startsOn) {
        throw new CellError("ends_on", `The lease ends (${endsOn}) before it starts (${startsOn}).`);
      }

      const status = readEnum(row, "status", LEASE_STATUSES, "active");

      if (status === "active") {
        const alreadyInFile = activeUnitsInFile.get(unit.found.id);
        if (alreadyInFile !== undefined) {
          throw new CellError(
            "unit",
            `${unit.found.label} already has an active lease on row ${alreadyInFile}. ` +
              `A unit can only be let once at a time.`,
          );
        }
        const alreadyLet = unitsAlreadyLet.get(unit.found.id);
        if (alreadyLet) {
          throw new CellError(
            "unit",
            `${unit.found.label} is already let under lease ${alreadyLet}. End that lease ` +
              `first, or import this one as "ended".`,
          );
        }
        activeUnitsInFile.set(unit.found.id, row.rowNumber);
      }

      const frequency = readEnum(row, "frequency", FREQUENCIES, "yearly");
      const annualRent = readMoney(row, "annual_rent", M.ZERO);
      const rentAmount = row.has("rent_amount")
        ? readMoney(row, "rent_amount")
        : M.quantize(M.div(annualRent, PERIODS_PER_YEAR[frequency]));

      if (M.isNegative(annualRent) || M.isNegative(rentAmount)) {
        throw new CellError("annual_rent", "Rent cannot be negative.");
      }
      if (M.isZero(annualRent) && M.isZero(rentAmount)) {
        throw new CellError("annual_rent", "This lease has no rent on it at all.");
      }

      const depositAmount = readMoney(row, "deposit_amount", M.ZERO);
      const payload: LeasePlanRow = {
        leaseNumber,
        unitId: unit.found.id,
        partyId: party.found.id,
        startsOn,
        endsOn,
        status,
        annualRent: M.isZero(annualRent)
          ? M.quantize(M.mul(rentAmount, PERIODS_PER_YEAR[frequency]))
          : annualRent,
        rentAmount,
        frequency,
        billingDay: readInteger(row, "billing_day", { min: 1, max: 28, fallback: 1 }),
        collectionMethod: readEnum(row, "collection_method", COLLECTION, "post_dated_cheques"),
        chequeCount: row.has("cheque_count")
          ? readInteger(row, "cheque_count", { min: 1, max: 24 })
          : null,
        depositAmount,
        depositHeld: readMoney(row, "deposit_held", depositAmount),
        ejariNumber: readText(row, "ejari_number", { max: 40 }) || null,
        noticePeriodDays: readInteger(row, "notice_period_days", { min: 0, max: 365, fallback: 30 }),
        graceDays: readInteger(row, "grace_days", { min: 0, max: 90, fallback: 5 }),
        occupiesUnit: status === "active",
      };

      /**
       * A rent that does not divide evenly is a warning, never a correction.
       *
       * Four cheques against an annual rent that does not divide by four is
       * ordinary in Dubai. Rounding it here would change what the tenant owes;
       * rejecting it would refuse a file that is right. Saying so on the row
       * and letting the accountant look is the only honest option.
       */
      const implied = M.quantize(M.mul(rentAmount, PERIODS_PER_YEAR[frequency]));
      const mismatch = !M.eq(implied, M.quantize(payload.annualRent));
      const detail = mismatch
        ? `${M.toDisplay(rentAmount)} × ${PERIODS_PER_YEAR[frequency]} = ` +
          `${M.toDisplay(implied)}, but annual rent says ${M.toDisplay(payload.annualRent)}`
        : `${M.toDisplay(rentAmount)} ${frequency} · ${startsOn}${endsOn ? ` to ${endsOn}` : ""}`;

      creates++;
      annualRentTotal = M.add(annualRentTotal, payload.annualRent);
      depositTotal = M.add(depositTotal, payload.depositHeld);

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${leaseNumber} · ${unit.found.label} · ${party.found.label}`,
        detail,
        amount: payload.annualRent,
        payload,
      });
    } catch (err) {
      rejected.push(toIssue(row.rowNumber, err));
    }
  }

  return {
    rows: planned,
    rejected: rejected.sort(byRowNumber),
    blockers: [],
    totals: [
      { label: "Leases to create", amount: M.money(creates) },
      { label: "Annual rent contracted", amount: M.quantize(annualRentTotal) },
      { label: "Deposits held", amount: M.quantize(depositTotal) },
    ],
    notes: [
      "Deposits held must equal the tenant deposit liability (2400) on your trial " +
        "balance. The reconciliation checks it.",
      "Dates without a year-month-day order are read day first — 03/04/2026 is 3 April.",
      "This creates no invoices and posts nothing. Rent already owed comes in through " +
        "the outstanding debts import.",
    ],
    expectedLines: [],
    totalDebit: M.ZERO,
    totalCredit: M.ZERO,
  };
}

export const leasesImporter: Importer = {
  kind: "leases",
  label: "Active leases",
  description: "One row per tenancy contract. Units and tenants must already be on file.",
  template: [...COLUMNS],
  required: ["lease_number", "unit", "tenant", "starts_on"],
  permission: "lease:create",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const [units, parties, leases] = await Promise.all([
      unitIndex(ctx),
      partyIndex(ctx),
      leaseIndex(ctx),
    ]);
    const let_ = await ctx.tx.execute<{ unit_id: string; lease_number: string }>(sql`
      SELECT unit_id, lease_number FROM leases
       WHERE status = 'active' AND deleted_at IS NULL
    `);
    return planLeases(
      rows,
      units,
      parties,
      leases,
      new Map(let_.map((r) => [r.unit_id, r.lease_number])),
    );
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const l = row.payload as LeasePlanRow;

      const inserted = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO leases
          (id, tenant_id, business_unit_id, unit_id, party_id, lease_number, status,
           starts_on, ends_on, annual_rent, rent_amount, frequency, billing_day,
           collection_method, cheque_count, ejari_number, deposit_amount, deposit_held,
           notice_period_days, grace_days)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.businessUnitId}::uuid,
           ${l.unitId}::uuid, ${l.partyId}::uuid, ${l.leaseNumber}, ${l.status}::lease_status,
           ${l.startsOn}::date, ${l.endsOn}::date, ${M.toDb(l.annualRent)},
           ${M.toDb(l.rentAmount)}, ${l.frequency}::charge_frequency, ${l.billingDay},
           ${l.collectionMethod}::collection_method, ${l.chequeCount}, ${l.ejariNumber},
           ${M.toDb(l.depositAmount)}, ${M.toDb(l.depositHeld)},
           ${l.noticePeriodDays}, ${l.graceDays})
        RETURNING id
      `);
      await into.record({
        rowNumber: row.rowNumber,
        action: "create",
        entityTable: "leases",
        entityId: inserted[0]!.id,
      });

      if (l.occupiesUnit) {
        // The unit's previous status is captured so reversing the batch puts
        // the flat back on the board exactly as it was, rather than guessing
        // "available" for a unit that was under maintenance.
        const before = await ctx.tx.execute<{ status: string }>(sql`
          SELECT status::text FROM units WHERE id = ${l.unitId}::uuid
        `);
        await ctx.tx.execute(sql`
          UPDATE units SET status = 'occupied', updated_at = now()
           WHERE id = ${l.unitId}::uuid
        `);
        await into.record({
          rowNumber: row.rowNumber,
          action: "update",
          entityTable: "units",
          entityId: l.unitId,
          previous: { status: before[0]?.status ?? "available" },
        });
      }
    }
    return {};
  },
};
