import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { Index, leaseIndex, normaliseToken, partyIndex } from "./lookups.ts";
import { CellError, byRowNumber, readDate, readEnum, readMoney, readText, toIssue } from "./source.ts";
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
 * POST-DATED CHEQUES — the register of physical instruments in the safe.
 *
 * In the UAE a tenancy is normally paid by handing over one to four post-dated
 * cheques at signing, and the landlord's real asset on day one is a drawer full
 * of paper. If that drawer is not in the system on the first day, the product
 * cannot answer the question the owner opens it to ask — what is due to be
 * banked this week — and the whole rentals module is decorative.
 *
 * TWO THINGS THIS IMPORTER REFUSES TO DECIDE.
 *
 *  1. IT POSTS NOTHING. A cheque on hand is an asset already sitting in the
 *     opening trial balance as 1140 PDC_ON_HAND. Posting again would double it,
 *     exactly as with outstanding debts. The register total is reconciled
 *     against that account instead.
 *
 *  2. IT ONLY ACCEPTS CHEQUES THAT ARE STILL LIVE. `held`, `deposited` and
 *     `bounced` are states a migration can meaningfully carry across.
 *     `cleared` is refused: a cleared cheque is a completed payment, its money
 *     is already inside the opening bank balance, and importing it as a cheque
 *     record would either strand a payment with no allocation or invite someone
 *     to clear it a second time. Whether a cleared UAE cheque can be returned
 *     at all is open question Q-5, and this importer does not answer it.
 */

const COLUMNS = [
  "cheque_number",
  "bank_name",
  "party",
  "lease",
  "drawer_name",
  "cheque_date",
  "amount",
  "direction",
  "status",
  "period_start",
  "period_end",
  "custody_location",
  "notes",
] as const;

const DIRECTIONS = ["in", "out"] as const;

/** See the header: a migration carries live instruments, not settled ones. */
const IMPORTABLE_STATUSES = ["held", "deposited", "bounced"] as const;

export interface ChequePlanRow {
  chequeNumber: string;
  bankName: string;
  partyId: string | null;
  leaseId: string | null;
  drawerName: string | null;
  chequeDate: string;
  amount: M.Money;
  direction: (typeof DIRECTIONS)[number];
  status: (typeof IMPORTABLE_STATUSES)[number];
  periodStart: string | null;
  periodEnd: string | null;
  custodyLocation: string | null;
  notes: string | null;
}

export function planCheques(
  rows: SourceRow[],
  parties: Index,
  leases: Index,
  existing: Set<string>,
): ImportPlan {
  const planned: PlannedRow<ChequePlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const seen = new Map<string, number>();

  let incoming = M.ZERO;
  let outgoing = M.ZERO;
  let creates = 0;

  for (const row of rows) {
    try {
      const chequeNumber = readText(row, "cheque_number", { max: 40, required: true });
      /**
       * The bank is part of the cheque's identity, not decoration.
       *
       * `cheques_number_uq` is (tenant, bank_name, cheque_number): cheque
       * numbers restart per chequebook, so 000123 from Emirates NBD and 000123
       * from ADCB are two different instruments. Making the bank required is
       * what keeps that index meaningful — leaving it blank would collapse
       * every bank's 000123 into one row and silently drop cheques.
       */
      const bankName = readText(row, "bank_name", { max: 100, required: true });
      const key = `${normaliseToken(bankName)}:${normaliseToken(chequeNumber)}`;

      const duplicate = seen.get(key);
      if (duplicate !== undefined) {
        throw new CellError(
          "cheque_number",
          `Cheque ${chequeNumber} drawn on ${bankName} is already on row ${duplicate}.`,
        );
      }
      seen.set(key, row.rowNumber);

      const rawStatus = readText(row, "status", { max: 30 }).toLowerCase();
      if (rawStatus === "cleared" || rawStatus === "replaced" || rawStatus === "returned" || rawStatus === "cancelled") {
        throw new CellError(
          "status",
          `A "${rawStatus}" cheque is finished business — its money is already in your ` +
            `opening bank balance. Import only cheques still in hand: ` +
            `${IMPORTABLE_STATUSES.join(", ")}.`,
        );
      }
      const status = readEnum(row, "status", IMPORTABLE_STATUSES, "held");

      const amount = readMoney(row, "amount");
      if (!M.gt(amount, M.ZERO)) {
        throw new CellError("amount", "A cheque must be for a positive amount.");
      }

      let partyId: string | null = null;
      const partyToken = readText(row, "party", { max: 200 });
      if (partyToken !== "") {
        const party = parties.resolve(partyToken);
        if (party === null) {
          throw new CellError("party", `No party matches "${partyToken}". Import parties first.`);
        }
        if (party === "ambiguous") {
          throw new CellError("party", `"${partyToken}" matches more than one party.`);
        }
        partyId = party.found.id;
      }

      let leaseId: string | null = null;
      const leaseToken = readText(row, "lease", { max: 40 });
      if (leaseToken !== "") {
        const lease = leases.resolve(leaseToken);
        if (lease === null) {
          throw new CellError("lease", `No lease numbered "${leaseToken}". Import leases first.`);
        }
        if (lease === "ambiguous") {
          throw new CellError("lease", `"${leaseToken}" matches more than one lease.`);
        }
        leaseId = lease.found.id;
      }

      const periodStart = row.has("period_start") ? readDate(row, "period_start") : null;
      const periodEnd = row.has("period_end") ? readDate(row, "period_end") : null;
      if (periodStart && periodEnd && periodEnd < periodStart) {
        throw new CellError("period_end", "The rental period ends before it starts.");
      }

      const payload: ChequePlanRow = {
        chequeNumber,
        bankName,
        partyId,
        leaseId,
        drawerName: readText(row, "drawer_name", { max: 200 }) || null,
        chequeDate: readDate(row, "cheque_date"),
        amount,
        direction: readEnum(row, "direction", DIRECTIONS, "in"),
        status,
        periodStart,
        periodEnd,
        custodyLocation: readText(row, "custody_location", { max: 100 }) || null,
        notes: readText(row, "notes", { max: 2000 }) || null,
      };

      if (existing.has(key)) {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${chequeNumber} · ${bankName}`,
          detail: "Already in the register.",
          payload,
        });
        continue;
      }

      creates++;
      if (payload.direction === "in") incoming = M.add(incoming, amount);
      else outgoing = M.add(outgoing, amount);

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${chequeNumber} · ${bankName}`,
        detail: `${M.toDisplay(amount)} dated ${payload.chequeDate} · ${status}`,
        amount,
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
      { label: "Cheques to create", amount: M.money(creates) },
      { label: "Incoming, in hand (must equal 1140 PDC)", amount: M.quantize(incoming) },
      { label: "Outgoing, issued", amount: M.quantize(outgoing) },
    ],
    notes: [
      "Nothing here posts to the ledger. Cheques on hand are already an asset on your " +
        "trial balance; this is the register behind that figure.",
      "Cheque dates are read day first — 03/04/2026 is 3 April.",
      "Cleared cheques are refused: their money is inside your opening bank balance.",
    ],
    expectedLines: [],
    totalDebit: M.quantize(incoming),
    totalCredit: M.quantize(outgoing),
  };
}

export const chequesImporter: Importer = {
  kind: "cheques",
  label: "Post-dated cheques",
  description: "The cheques in your safe. One row per physical instrument.",
  template: [...COLUMNS],
  required: ["cheque_number", "bank_name", "cheque_date", "amount"],
  permission: "payment:create",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const [parties, leases] = await Promise.all([partyIndex(ctx), leaseIndex(ctx)]);
    const existing = await ctx.tx.execute<{ bank_name: string | null; cheque_number: string }>(sql`
      SELECT bank_name, cheque_number FROM cheques WHERE deleted_at IS NULL
    `);
    return planCheques(
      rows,
      parties,
      leases,
      new Set(
        existing.map((c) => `${normaliseToken(c.bank_name ?? "")}:${normaliseToken(c.cheque_number)}`),
      ),
    );
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const c = row.payload as ChequePlanRow;
      const inserted = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO cheques
          (id, tenant_id, business_unit_id, direction, party_id, lease_id, cheque_number,
           bank_name, drawer_name, cheque_date, amount, currency, status,
           period_start, period_end, custody_location, notes)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.businessUnitId}::uuid,
           ${c.direction}::payment_direction, ${c.partyId}::uuid, ${c.leaseId}::uuid,
           ${c.chequeNumber}, ${c.bankName}, ${c.drawerName}, ${c.chequeDate}::date,
           ${M.toDb(c.amount)}, ${ctx.baseCurrency}, ${c.status}::cheque_status,
           ${c.periodStart}::date, ${c.periodEnd}::date, ${c.custodyLocation}, ${c.notes})
        RETURNING id
      `);
      await into.record({
        rowNumber: row.rowNumber,
        action: "create",
        entityTable: "cheques",
        entityId: inserted[0]!.id,
      });
    }
    return {};
  },
};
