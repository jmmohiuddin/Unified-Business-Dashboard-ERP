import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
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
 * CREDIT NOTES AND REFUNDS.
 *
 * The returns path the retail and ecommerce businesses cannot do without — and
 * the one place where getting the accounting wrong is most tempting. The wrong
 * way is to delete or edit the original invoice; the right way is a credit note
 * that reverses it, because:
 *
 *   • the original invoice was in a VAT return that may already be filed;
 *   • an auditor must see both the sale and its reversal, not a gap;
 *   • the credit note is itself a document the customer is entitled to.
 *
 * A credit note reverses revenue, output VAT and — if goods come back — cost of
 * sales and stock. It reduces the customer's balance; if they had already paid,
 * the remainder becomes a refund or a credit on account.
 */

export const createCreditNoteInput = z.object({
  /** The invoice being credited. */
  invoiceId: z.uuid(),
  reason: z.string().min(1).max(200),
  /** Full reversal, or specific lines/amounts. */
  lines: z
    .array(
      z.object({
        itemId: z.uuid().nullable().optional(),
        description: z.string().max(500),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
        taxRate: z.number().min(0).max(1).default(0.05),
        unitCost: z.number().min(0).default(0),
        /** Put returned goods back into this warehouse. */
        restockWarehouseId: z.uuid().nullable().optional(),
      }),
    )
    .optional(),
  /** true = credit the whole invoice. Ignores `lines`. */
  full: z.boolean().default(false),
  /** Refund the money now vs. leave it as credit on account. */
  refundMethod: z.enum(["cash", "bank_transfer", "card", "credit_on_account"]).default("credit_on_account"),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function createCreditNote(ctx: ServiceContext, raw: unknown) {
  const input = createCreditNoteInput.parse(raw);
  requirePermission(ctx, "payment:refund");

  return withIdempotency(ctx, input.idempotencyKey, "createCreditNote", async () => {
    const [inv] = await ctx.tx.execute<{
      id: string; business_unit_id: string; party_id: string | null;
      party_name_snapshot: string | null; total: string; amount_paid: string;
      subtotal: string; tax_total: string; cost_total: string; doc_number: string;
      currency: string;
    }>(sql`
      SELECT id, business_unit_id, party_id, party_name_snapshot, total, amount_paid,
             subtotal, tax_total, cost_total, doc_number, currency
        FROM documents
       WHERE id = ${input.invoiceId}::uuid AND doc_type = 'invoice' AND direction = 'in'
       FOR UPDATE
    `);
    if (!inv) throw new ServiceError("Invoice not found.", "not_found");
    requireBusinessUnit(ctx, inv.business_unit_id);

    // Prior credit notes against this invoice, so we never credit more than the
    // invoice was worth.
    const [prior] = await ctx.tx.execute<{ credited: string }>(sql`
      SELECT COALESCE(SUM(total), 0) AS credited FROM documents
       WHERE source_document_id = ${input.invoiceId}::uuid AND doc_type = 'credit_note'
    `);
    const alreadyCredited = M.fromDb(prior?.credited);

    // Build the credit lines.
    /**
     * Numeric fields accept a string so values read straight out of Postgres
     * keep their exact decimal text. Passing them through Number() first is
     * lossless for numeric(18,4) in realistic ranges, but it is an avoidable
     * float hop in the one file whose whole job is reversing money.
     */
    type CreditLine = Omit<
      NonNullable<z.infer<typeof createCreditNoteInput>["lines"]>[number],
      "quantity" | "unitPrice" | "taxRate" | "unitCost"
    > & {
      quantity: string | number;
      unitPrice: string | number;
      taxRate: string | number;
      unitCost?: string | number | null;
    };
    let creditLines: CreditLine[];
    if (input.full) {
      const original = await ctx.tx.execute<{
        item_id: string | null; description: string; quantity: string;
        unit_price: string; tax_rate: string; unit_cost: string;
      }>(sql`
        SELECT item_id, description, quantity, unit_price, tax_rate, unit_cost
          FROM document_lines WHERE document_id = ${input.invoiceId}::uuid ORDER BY line_no
      `);
      creditLines = original.map((l) => ({
        itemId: l.item_id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        taxRate: l.tax_rate,
        unitCost: l.unit_cost,
        restockWarehouseId: null,
      }));
    } else {
      if (!input.lines?.length) throw new ServiceError("Give lines to credit, or set full.", "invalid");
      creditLines = input.lines;
    }

    let subtotal = M.ZERO, taxTotal = M.ZERO, costTotal = M.ZERO;
    for (const l of creditLines) {
      // Invoice prices are VAT-inclusive at retail; the credit mirrors that.
      // gross / (1 + rate) never terminates in binary at 5%, so tax is taken as
      // the REMAINDER — net + tax === gross exactly, per line.
      const gross = M.quantize(M.mul(M.money(l.quantity), M.money(l.unitPrice)));
      const rate = M.money(l.taxRate);
      const net = M.gt(rate, M.ZERO)
        ? M.quantize(M.div(gross, M.add(M.money(1), rate)))
        : gross;
      subtotal = M.add(subtotal, net);
      taxTotal = M.add(taxTotal, M.sub(gross, net));
      costTotal = M.add(costTotal, M.quantize(M.mul(M.money(l.quantity), M.money(l.unitCost ?? 0))));
    }
    const total = M.add(subtotal, taxTotal);

    // Exact. The `+ 0.01` here was the clearest tell in the codebase: a
    // hand-rolled fils of slack on an over-credit guard, which let N successive
    // credit notes over-credit an invoice by up to N fils — and `alreadyCredited`
    // was itself a float sum of prior float totals.
    if (M.gt(M.add(alreadyCredited, total), M.fromDb(inv.total))) {
      throw new ServiceError(
        `Crediting ${M.toDisplay(total)} would exceed the invoice (already credited ${M.toDisplay(alreadyCredited)} of ${M.toDisplay(M.fromDb(inv.total))}).`,
        "invalid",
      );
    }

    const [bu] = await ctx.tx.execute<{ code: string; kind: string }>(sql`
      SELECT code, kind::text AS kind FROM business_units WHERE id = ${inv.business_unit_id}::uuid
    `);
    const docNumber = await nextDocumentNumber(ctx, inv.business_unit_id, "credit_note", `CN-${bu!.code}`);

    const [cn] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_id, party_name_snapshot, issue_date, currency,
         subtotal, tax_total, total, amount_due, base_total, cost_total,
         source_document_id, notes, posted_at)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
         'credit_note', ${docNumber}, 'confirmed', 'in',
         ${inv.party_id}::uuid, ${inv.party_name_snapshot}, ${ctx.today}::date, ${ctx.baseCurrency},
         ${M.toDb(subtotal)}, ${M.toDb(taxTotal)}, ${M.toDb(total)}, '0',
         ${M.toDb(total)}, ${M.toDb(costTotal)}, ${input.invoiceId}::uuid,
         ${`Credit for ${inv.doc_number}: ${input.reason}`}, now())
      RETURNING id
    `);

    let lineNo = 0;
    for (const l of creditLines) {
      lineNo++;
      await ctx.tx.execute(sql`
        INSERT INTO document_lines
          (id, tenant_id, document_id, line_no, item_id, description,
           quantity, unit_price, tax_rate, tax_amount, line_total, unit_cost)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${cn.id}::uuid, ${lineNo},
           ${l.itemId ?? null}::uuid, ${l.description}, ${M.toDb(M.money(l.quantity))},
           ${M.toDb(M.money(l.unitPrice))}, ${M.money(l.taxRate).toFixed(6)},
           ${M.toDb(M.sub(M.quantize(M.mul(M.money(l.quantity), M.money(l.unitPrice))), M.gt(M.money(l.taxRate), M.ZERO) ? M.quantize(M.div(M.quantize(M.mul(M.money(l.quantity), M.money(l.unitPrice))), M.add(M.money(1), M.money(l.taxRate)))) : M.quantize(M.mul(M.money(l.quantity), M.money(l.unitPrice)))))},
           ${M.toDb(M.quantize(M.mul(M.money(l.quantity), M.money(l.unitPrice))))}, ${M.toDb(M.money(l.unitCost ?? 0))})
      `);

      // Returned goods go back into stock.
      if (l.restockWarehouseId && l.itemId) {
        await ctx.tx.execute(sql`
          INSERT INTO stock_moves
            (id, tenant_id, business_unit_id, warehouse_id, item_id, quantity,
             unit_cost, reason, source_table, source_id, occurred_at)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
             ${l.restockWarehouseId}::uuid, ${l.itemId}::uuid, ${M.toDb(M.money(l.quantity))},
             ${M.toDb(M.money(l.unitCost ?? 0))}, 'return_in', 'documents', ${cn.id}::uuid, now())
        `);
        await ctx.tx.execute(sql`
          UPDATE stock_levels SET on_hand = on_hand + ${M.toDb(M.money(l.quantity))}, updated_at = now()
           WHERE warehouse_id = ${l.restockWarehouseId}::uuid AND item_id = ${l.itemId}::uuid
        `);
      }
    }

    // ── Ledger: reverse the sale ────────────────────────────────────────────
    await postJournal(ctx, {
      postingDate: ctx.today,
      source: "invoice",
      sourceTable: "documents",
      sourceId: cn.id,
      narration: `Credit note ${docNumber} against ${inv.doc_number}`,
      legs: [
        { accountKey: "REV_PRODUCT", businessUnitId: inv.business_unit_id, debit: subtotal },
        ...(M.gt(taxTotal, M.ZERO)
          ? [{ accountKey: "VAT_OUTPUT", businessUnitId: inv.business_unit_id, debit: taxTotal }]
          : []),
        { accountKey: "AR", businessUnitId: inv.business_unit_id, credit: total, partyId: inv.party_id },
      ],
    });
    if (M.gt(costTotal, M.ZERO)) {
      // Goods came back: reverse the cost of sale.
      await postJournal(ctx, {
        postingDate: ctx.today,
        source: "invoice",
        sourceTable: "documents",
        sourceId: cn.id,
        narration: `Restock cost — ${docNumber}`,
        legs: [
          { accountKey: "INVENTORY", businessUnitId: inv.business_unit_id, debit: costTotal },
          { accountKey: "COGS", businessUnitId: inv.business_unit_id, credit: costTotal },
        ],
      });
    }

    // ── Settle the credit against the invoice ───────────────────────────────
    const outstanding = M.sub(M.fromDb(inv.total), M.fromDb(inv.amount_paid));
    const appliedToInvoice = M.min(total, M.max(M.ZERO, outstanding));
    const refundable = M.sub(total, appliedToInvoice);

    if (M.gt(appliedToInvoice, M.ZERO)) {
      await ctx.tx.execute(sql`
        UPDATE documents
           SET amount_due = GREATEST(0, amount_due - ${M.toDb(appliedToInvoice)}),
               status = CASE WHEN amount_due - ${M.toDb(appliedToInvoice)} <= 0
                             THEN 'paid'::doc_status ELSE status END,
               updated_at = now()
         WHERE id = ${input.invoiceId}::uuid
      `);
    }

    // Money already paid, now owed back.
    let refundPaymentId: string | null = null;
    if (M.gt(refundable, M.ZERO) && input.refundMethod !== "credit_on_account") {
      const payNumber = await nextDocumentNumber(ctx, inv.business_unit_id, "payment", `REFUND-${bu!.code}`);
      const [refund] = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO payments
          (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
           amount, currency, base_amount, unallocated_amount, received_on, reference,
           received_by_user_id, posted_at, note)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
           ${payNumber}, 'out', ${inv.party_id}::uuid, ${input.refundMethod}::payment_method,
           ${M.toDb(refundable)}, ${ctx.baseCurrency}, ${M.toDb(refundable)}, '0',
           ${ctx.today}::date, ${`Refund for ${docNumber}`}, ${ctx.principal.userId}::uuid, now(),
           ${input.reason})
        RETURNING id
      `);
      refundPaymentId = refund.id;
      const cashKey = input.refundMethod === "cash" ? "CASH" : input.refundMethod === "card" ? "CARD_CLEARING" : "BANK";
      await postJournal(ctx, {
        postingDate: ctx.today,
        source: "payment",
        sourceTable: "payments",
        sourceId: refund.id,
        narration: `Refund ${payNumber}`,
        legs: [
          { accountKey: "AR", businessUnitId: inv.business_unit_id, debit: refundable, partyId: inv.party_id },
          { accountKey: cashKey, businessUnitId: inv.business_unit_id, credit: refundable },
        ],
      });
    }

    if (inv.party_id) {
      await ctx.tx.execute(sql`
        UPDATE parties
           SET open_balance = GREATEST(0, open_balance - ${M.toDb(appliedToInvoice)}),
               lifetime_value = GREATEST(0, lifetime_value - ${M.toDb(total)})
         WHERE id = ${inv.party_id}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: "credit_note.create",
      entityTable: "documents",
      entityId: cn.id,
      businessUnitId: inv.business_unit_id,
      diff: {
        docNumber, against: inv.doc_number, total: M.toDb(total), reason: input.reason,
        appliedToInvoice: M.toDb(appliedToInvoice),
        refunded: M.toDb(refundPaymentId ? refundable : M.ZERO),
        refundMethod: input.refundMethod,
      },
    });

    return {
      creditNoteId: cn.id,
      docNumber,
      total: M.toNumber(total),
      appliedToInvoice: M.toNumber(appliedToInvoice),
      refunded: M.toNumber(refundPaymentId ? refundable : M.ZERO),
      creditOnAccount: M.toNumber(
        input.refundMethod === "credit_on_account" ? refundable : M.ZERO,
      ),
    };
  });
}
