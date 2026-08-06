import { sql } from "drizzle-orm";
import { z } from "zod";
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
    const alreadyCredited = Number(prior?.credited ?? 0);

    // Build the credit lines.
    let creditLines: NonNullable<z.infer<typeof createCreditNoteInput>["lines"]>;
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
        quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price),
        taxRate: Number(l.tax_rate),
        unitCost: Number(l.unit_cost),
        restockWarehouseId: null,
      }));
    } else {
      if (!input.lines?.length) throw new ServiceError("Give lines to credit, or set full.", "invalid");
      creditLines = input.lines;
    }

    let subtotal = 0, taxTotal = 0, costTotal = 0;
    for (const l of creditLines) {
      // Invoice prices are VAT-inclusive at retail; the credit mirrors that.
      const gross = l.quantity * l.unitPrice;
      const net = l.taxRate > 0 ? gross / (1 + l.taxRate) : gross;
      subtotal += net;
      taxTotal += gross - net;
      costTotal += l.quantity * (l.unitCost ?? 0);
    }
    const total = subtotal + taxTotal;

    if (alreadyCredited + total > Number(inv.total) + 0.01) {
      throw new ServiceError(
        `Crediting ${total.toFixed(2)} would exceed the invoice (already credited ${alreadyCredited.toFixed(2)} of ${Number(inv.total).toFixed(2)}).`,
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
         ${subtotal.toFixed(4)}, ${taxTotal.toFixed(4)}, ${total.toFixed(4)}, '0',
         ${total.toFixed(4)}, ${costTotal.toFixed(4)}, ${input.invoiceId}::uuid,
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
           ${l.itemId ?? null}::uuid, ${l.description}, ${l.quantity.toFixed(4)},
           ${l.unitPrice.toFixed(4)}, ${l.taxRate.toFixed(6)},
           ${(l.quantity * l.unitPrice * (l.taxRate / (1 + l.taxRate))).toFixed(4)},
           ${(l.quantity * l.unitPrice).toFixed(4)}, ${(l.unitCost ?? 0).toFixed(4)})
      `);

      // Returned goods go back into stock.
      if (l.restockWarehouseId && l.itemId) {
        await ctx.tx.execute(sql`
          INSERT INTO stock_moves
            (id, tenant_id, business_unit_id, warehouse_id, item_id, quantity,
             unit_cost, reason, source_table, source_id, occurred_at)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
             ${l.restockWarehouseId}::uuid, ${l.itemId}::uuid, ${l.quantity.toFixed(4)},
             ${(l.unitCost ?? 0).toFixed(4)}, 'return_in', 'documents', ${cn.id}::uuid, now())
        `);
        await ctx.tx.execute(sql`
          UPDATE stock_levels SET on_hand = on_hand + ${l.quantity.toFixed(4)}, updated_at = now()
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
        ...(taxTotal > 0
          ? [{ accountKey: "VAT_OUTPUT", businessUnitId: inv.business_unit_id, debit: taxTotal }]
          : []),
        { accountKey: "AR", businessUnitId: inv.business_unit_id, credit: total, partyId: inv.party_id },
      ],
    });
    if (costTotal > 0) {
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
    const outstanding = Number(inv.total) - Number(inv.amount_paid);
    const appliedToInvoice = Math.min(total, Math.max(0, outstanding));
    const refundable = total - appliedToInvoice;

    if (appliedToInvoice > 0) {
      await ctx.tx.execute(sql`
        UPDATE documents
           SET amount_due = GREATEST(0, amount_due - ${appliedToInvoice.toFixed(4)}),
               status = CASE WHEN amount_due - ${appliedToInvoice.toFixed(4)} <= 0.01
                             THEN 'paid'::doc_status ELSE status END,
               updated_at = now()
         WHERE id = ${input.invoiceId}::uuid
      `);
    }

    // Money already paid, now owed back.
    let refundPaymentId: string | null = null;
    if (refundable > 0.01 && input.refundMethod !== "credit_on_account") {
      const payNumber = await nextDocumentNumber(ctx, inv.business_unit_id, "payment", `REFUND-${bu!.code}`);
      const [refund] = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO payments
          (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
           amount, currency, base_amount, unallocated_amount, received_on, reference,
           received_by_user_id, posted_at, note)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
           ${payNumber}, 'out', ${inv.party_id}::uuid, ${input.refundMethod}::payment_method,
           ${refundable.toFixed(4)}, ${ctx.baseCurrency}, ${refundable.toFixed(4)}, '0',
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
           SET open_balance = GREATEST(0, open_balance - ${appliedToInvoice.toFixed(4)}),
               lifetime_value = GREATEST(0, lifetime_value - ${total.toFixed(4)})
         WHERE id = ${inv.party_id}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: "credit_note.create",
      entityTable: "documents",
      entityId: cn.id,
      businessUnitId: inv.business_unit_id,
      diff: {
        docNumber, against: inv.doc_number, total, reason: input.reason,
        appliedToInvoice, refunded: refundPaymentId ? refundable : 0,
        refundMethod: input.refundMethod,
      },
    });

    return {
      creditNoteId: cn.id,
      docNumber,
      total,
      appliedToInvoice,
      refunded: refundPaymentId ? refundable : 0,
      creditOnAccount: input.refundMethod === "credit_on_account" ? refundable : 0,
    };
  });
}
