import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { Index, normaliseToken, partyIndex } from "./lookups.ts";
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
 * OUTSTANDING DEBTS — who owes what on day one, and to whom.
 *
 * THE DOUBLE-COUNT THIS FILE EXISTS TO AVOID, stated first because everything
 * else follows from it.
 *
 * The receivables control account on the trial balance and the list of open
 * invoices behind it are TWO VIEWS OF ONE NUMBER, not two numbers. The opening
 * balance import posts the control account. This importer loads the invoices
 * that make it up. If this importer also posted, every customer balance in the
 * system would be exactly double, the ledger would still balance perfectly, and
 * the error would surface months later as a receivable nobody can collect.
 *
 * So: THIS IMPORTER POSTS NOTHING TO THE LEDGER. It writes documents with an
 * amount outstanding and nothing else. What makes that safe rather than sloppy
 * is the reconciliation: the sum of open invoices must equal the trial
 * balance's AR line (1200 / AR), and the sum of open bills must equal the AP
 * line (2100 / AP). A difference is reported to the fils, itemised, and is the
 * thing the accountant is actually signing off.
 *
 * `posted_at` is set even though no journal was written for the individual
 * document. The document IS in the books — through the opening journal, as part
 * of the control balance — and a NULL there reads on every screen as "this
 * invoice was never posted", which is a different and false statement.
 */

const COLUMNS = [
  "doc_number",
  "party",
  "kind",
  "issue_date",
  "due_date",
  "total",
  "amount_paid",
  "notes",
] as const;

const KINDS = ["invoice", "bill"] as const;

export interface DebtPlanRow {
  docNumber: string;
  docType: "invoice" | "bill";
  direction: "in" | "out";
  partyId: string;
  partyName: string;
  issueDate: string;
  dueDate: string;
  total: M.Money;
  amountPaid: M.Money;
  amountDue: M.Money;
  status: "sent" | "partially_paid" | "overdue" | "paid";
  notes: string | null;
}

export function planDebts(
  rows: SourceRow[],
  parties: Index,
  existingNumbers: Set<string>,
  today: string,
): ImportPlan {
  const planned: PlannedRow<DebtPlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const seen = new Map<string, number>();

  let receivable = M.ZERO;
  let payable = M.ZERO;
  let creates = 0;

  for (const row of rows) {
    try {
      const docType = readEnum(row, "kind", KINDS, "invoice");
      const docNumber = readText(row, "doc_number", { max: 40, required: true });
      const key = `${docType}:${normaliseToken(docNumber)}`;

      const duplicate = seen.get(key);
      if (duplicate !== undefined) {
        throw new CellError("doc_number", `${docNumber} is already on row ${duplicate}.`);
      }
      seen.set(key, row.rowNumber);

      const partyToken = readText(row, "party", { max: 200, required: true });
      const party = parties.resolve(partyToken);
      if (party === null) {
        throw new CellError(
          "party",
          `No customer or supplier matches "${partyToken}". Import parties first.`,
        );
      }
      if (party === "ambiguous") {
        throw new CellError("party", `"${partyToken}" matches more than one party. Use their code.`);
      }

      const total = readMoney(row, "total");
      if (M.isNegative(total)) {
        throw new CellError(
          "total",
          "A negative total is a credit note, not a debt. Import it as a separate " +
            "adjustment rather than as a negative invoice.",
        );
      }
      if (M.isZero(total)) {
        throw new CellError("total", "This document is for nothing at all.");
      }

      const amountPaid = readMoney(row, "amount_paid", M.ZERO);
      if (M.isNegative(amountPaid)) {
        throw new CellError("amount_paid", "An amount already paid cannot be negative.");
      }

      /**
       * Over-payment is refused exactly, never clamped.
       *
       * `GREATEST(0, total - paid)` was deliberately removed from payments and
       * purchasing, because clamping turns a data error into a silently wrong
       * balance that reconciles against nothing. The same rule applies at the
       * door: a row claiming 5,000 paid against a 4,000 invoice is either a
       * credit balance the accountant has to model properly or a typo, and
       * either way it is theirs to resolve, not this importer's.
       */
      if (M.gt(amountPaid, total)) {
        throw new CellError(
          "amount_paid",
          `Already paid (${M.toDisplay(amountPaid)}) is more than the total ` +
            `(${M.toDisplay(total)}). A customer in credit is an advance, not an invoice.`,
        );
      }

      const issueDate = readDate(row, "issue_date");
      const dueDate = row.has("due_date") ? readDate(row, "due_date") : issueDate;
      if (dueDate < issueDate) {
        throw new CellError("due_date", `Due (${dueDate}) is before issued (${issueDate}).`);
      }

      if (existingNumbers.has(key)) {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${docNumber} · ${party.found.label}`,
          detail: "Already on file.",
          payload: null as unknown as DebtPlanRow,
        });
        continue;
      }

      const amountDue = M.quantize(M.sub(total, amountPaid));
      const status: DebtPlanRow["status"] = M.isZero(amountDue)
        ? "paid"
        : dueDate < today
          ? "overdue"
          : M.gt(amountPaid, M.ZERO)
            ? "partially_paid"
            : "sent";

      if (docType === "invoice") receivable = M.add(receivable, amountDue);
      else payable = M.add(payable, amountDue);
      creates++;

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${docNumber} · ${party.found.label}`,
        detail: `${M.toDisplay(amountDue)} outstanding of ${M.toDisplay(total)} · due ${dueDate}`,
        amount: amountDue,
        payload: {
          docNumber,
          docType,
          direction: docType === "invoice" ? "in" : "out",
          partyId: party.found.id,
          partyName: party.found.label,
          issueDate,
          dueDate,
          total,
          amountPaid,
          amountDue,
          status,
          notes: readText(row, "notes", { max: 2000 }) || null,
        },
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
      { label: "Documents to create", amount: M.money(creates) },
      { label: "Owed to you (must equal 1200 AR)", amount: M.quantize(receivable) },
      { label: "Owed by you (must equal 2100 AP)", amount: M.quantize(payable) },
    ],
    notes: [
      "Nothing here posts to the ledger. The receivable and payable balances come from " +
        "the trial balance; these documents are what makes them up.",
      "After importing, the reconciliation compares every open invoice and bill on file " +
        "against those two control accounts, to the fils.",
      "Tax is not split out. Import the gross amount outstanding — the VAT was accounted " +
        "for in the system you are migrating from.",
    ],
    expectedLines: [],
    totalDebit: M.quantize(receivable),
    totalCredit: M.quantize(payable),
  };
}

export const debtsImporter: Importer = {
  kind: "debts",
  label: "Outstanding debts",
  description:
    "Unpaid invoices and unpaid bills as at go-live. One row each, with the amount " +
    "still outstanding.",
  template: [...COLUMNS],
  required: ["doc_number", "party", "issue_date", "total"],
  permission: "document:create",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const parties = await partyIndex(ctx);
    const existing = await ctx.tx.execute<{ doc_type: string; doc_number: string }>(sql`
      SELECT doc_type::text, doc_number FROM documents
       WHERE business_unit_id = ${ctx.businessUnitId}::uuid AND deleted_at IS NULL
    `);
    return planDebts(
      rows,
      parties,
      new Set(existing.map((d) => `${d.doc_type}:${normaliseToken(d.doc_number)}`)),
      ctx.today,
    );
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const d = row.payload as DebtPlanRow;
      const inserted = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO documents
          (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
           party_id, party_name_snapshot, issue_date, due_date, days_overdue, currency,
           subtotal, tax_total, total, amount_paid, amount_due, base_total, posted_at, notes)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.businessUnitId}::uuid,
           ${d.docType}::doc_type, ${d.docNumber}, ${d.status}::doc_status,
           ${d.direction}::payment_direction, ${d.partyId}::uuid, ${d.partyName},
           ${d.issueDate}::date, ${d.dueDate}::date,
           -- A day count, floored at zero because "minus four days overdue" is not a
           -- thing. This is not the clamped-money pattern that was removed from
           -- payments and purchasing: no amount is being quietly reduced here.
           GREATEST(0, (${ctx.today}::date - ${d.dueDate}::date)), ${ctx.baseCurrency},
           ${M.toDb(d.total)}, '0', ${M.toDb(d.total)}, ${M.toDb(d.amountPaid)},
           ${M.toDb(d.amountDue)}, ${M.toDb(d.total)}, now(), ${d.notes})
        RETURNING id
      `);
      await into.record({
        rowNumber: row.rowNumber,
        action: "create",
        entityTable: "documents",
        entityId: inserted[0]!.id,
      });
    }
    return {};
  },
};
