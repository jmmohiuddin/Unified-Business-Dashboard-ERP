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
 * Creating an invoice.
 *
 * One function covers the counter sale, the service call and the rent charge,
 * because they are the same document with different lines — which is the whole
 * argument for the polymorphic `documents` table.
 *
 * Three things happen atomically that are easy to get wrong separately:
 *   • VAT is computed per line from the item's own tax code, so an exempt
 *     residential rent line and a standard-rated parking line can coexist on
 *     one invoice and still produce a correct VAT return.
 *   • Stock moves are written for physical goods, and serialised units are
 *     marked sold with a warranty end date.
 *   • The ledger entry posts revenue, output VAT and cost of sales together.
 */

export const createInvoiceInput = z.object({
  businessUnitId: z.uuid(),
  partyId: z.uuid().nullable().optional(),
  issueDate: z.iso.date(),
  dueDays: z.number().int().min(0).max(365).default(0),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: z.number().positive().max(100_000),
        /** Overrides the catalogue price when the counter negotiates. */
        unitPrice: z.number().min(0).optional(),
        description: z.string().max(500).optional(),
        employeeId: z.uuid().nullable().optional(),
        jobId: z.uuid().nullable().optional(),
        serialUnitId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  /** Take the money at the same time — the POS case. */
  payment: z
    .object({
      method: z.enum(["cash", "card", "bank_transfer", "digital_wallet", "gateway", "bnpl"]),
    })
    .optional(),
  notes: z.string().max(1000).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface CreateInvoiceResult {
  documentId: string;
  docNumber: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  paid: boolean;
}

export async function createInvoice(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CreateInvoiceResult> {
  const input = createInvoiceInput.parse(raw);
  requirePermission(ctx, "document:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "createInvoice", async () => {
    const buRows = await ctx.tx.execute<{ code: string }>(sql`
      SELECT code FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    if (buRows.length === 0) throw new ServiceError("Business not found.", "not_found");

    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await ctx.tx.execute<{
      id: string; name: string; type: string; sale_price: string; cost_price: string;
      tracking_mode: string; tax_rate: string | null; tax_inclusive: boolean | null;
      treatment: string | null; tax_code_id: string | null;
    }>(sql`
      SELECT i.id, i.name, i.type::text, i.sale_price, i.cost_price,
             i.tracking_mode::text, tc.rate AS tax_rate, tc.is_inclusive AS tax_inclusive,
             tc.treatment::text AS treatment, i.tax_code_id
        FROM items i
        LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
       WHERE i.id = ANY(ARRAY[${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)}])
    `);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of itemIds) {
      if (!byId.has(id)) throw new ServiceError(`Item ${id} not found.`, "not_found");
    }

    // ── Price and tax every line ────────────────────────────────────────────
    let subtotal = M.ZERO, taxTotal = M.ZERO, costTotal = M.ZERO;
    const priced = input.lines.map((line, i) => {
      const item = byId.get(line.itemId)!;
      const qty = M.money(line.quantity);
      const unitPrice = line.unitPrice !== undefined && line.unitPrice !== null
        ? M.money(line.unitPrice)
        : M.fromDb(item.sale_price);
      const gross = M.quantize(M.mul(unitPrice, qty));
      const rate = M.fromDb(item.tax_rate);
      const inclusive = Boolean(item.tax_inclusive);

      // Exempt and zero-rated both charge nothing; the difference is on the
      // input side and is handled by the tax code's treatment, not here.
      let net: M.Money, tax: M.Money, lineTotal: M.Money;
      if (M.isZero(rate)) {
        net = gross; tax = M.ZERO; lineTotal = gross;
      } else if (inclusive) {
        // gross / (1 + rate) never terminates in binary at 5%. Backing the net
        // out and taking tax as the REMAINDER guarantees net + tax === gross
        // exactly, which is what the printed invoice has to show.
        net = M.quantize(M.div(gross, M.add(M.money(1), rate)));
        tax = M.sub(gross, net);
        lineTotal = gross;
      } else {
        net = gross; tax = M.quantize(M.mul(gross, rate)); lineTotal = M.add(gross, tax);
      }

      const unitCost = M.fromDb(item.cost_price);
      subtotal = M.add(subtotal, net);
      taxTotal = M.add(taxTotal, tax);
      costTotal = M.add(costTotal, M.quantize(M.mul(unitCost, qty)));

      return { line, item, lineNo: i + 1, unitPrice, net, tax, lineTotal, unitCost };
    });

    const total = M.add(subtotal, taxTotal);
    const dueDate = new Date(`${input.issueDate}T00:00:00Z`);
    dueDate.setUTCDate(dueDate.getUTCDate() + input.dueDays);

    const docNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "invoice", `INV-${buRows[0]!.code}`,
    );

    let partyName: string | null = null;
    if (input.partyId) {
      const p = await ctx.tx.execute<{ display_name: string }>(sql`
        SELECT display_name FROM parties WHERE id = ${input.partyId}::uuid
      `);
      partyName = p[0]?.display_name ?? null;
    }

    const paidNow = Boolean(input.payment);

    const doc = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_id, party_name_snapshot, issue_date, due_date, days_overdue, currency,
         subtotal, tax_total, total, amount_paid, amount_due, base_total, cost_total,
         posted_at, notes)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         'invoice', ${docNumber}, ${paidNow ? "paid" : "sent"}::doc_status, 'in',
         ${input.partyId ?? null}::uuid, ${partyName}, ${input.issueDate}::date,
         ${dueDate.toISOString().slice(0, 10)}::date, 0, ${ctx.baseCurrency},
         ${M.toDb(subtotal)}, ${M.toDb(taxTotal)}, ${M.toDb(total)},
         ${M.toDb(paidNow ? total : M.ZERO)}, ${M.toDb(paidNow ? M.ZERO : total)},
         ${M.toDb(total)}, ${M.toDb(costTotal)}, now(), ${input.notes ?? null})
      RETURNING id
    `);
    const documentId = doc[0]!.id;

    for (const p of priced) {
      await ctx.tx.execute(sql`
        INSERT INTO document_lines
          (id, tenant_id, document_id, line_no, item_id, serial_unit_id, description,
           quantity, unit_price, tax_code_id, tax_rate, tax_amount, line_total, unit_cost,
           employee_id, job_id)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${documentId}::uuid, ${p.lineNo},
           ${p.line.itemId}::uuid, ${p.line.serialUnitId ?? null}::uuid,
           ${p.line.description ?? p.item.name}, ${M.toDb(M.money(p.line.quantity))},
           ${M.toDb(p.unitPrice)}, ${p.item.tax_code_id ?? null}::uuid,
           ${M.fromDb(p.item.tax_rate).toFixed(6)}, ${M.toDb(p.tax)},
           ${M.toDb(p.lineTotal)}, ${M.toDb(p.unitCost)},
           ${p.line.employeeId ?? null}::uuid, ${p.line.jobId ?? null}::uuid)
      `);

      // ── Stock ─────────────────────────────────────────────────────────────
      if (p.item.type === "product" && p.item.tracking_mode !== "none") {
        const wh = await ctx.tx.execute<{ id: string }>(sql`
          SELECT id FROM warehouses
           WHERE business_unit_id = ${input.businessUnitId}::uuid AND is_mobile_van = false
           ORDER BY created_at LIMIT 1
        `);
        if (wh.length > 0) {
          await ctx.tx.execute(sql`
            INSERT INTO stock_moves
              (id, tenant_id, business_unit_id, warehouse_id, item_id, serial_unit_id,
               quantity, unit_cost, reason, source_table, source_id, occurred_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
               ${wh[0]!.id}::uuid, ${p.line.itemId}::uuid, ${p.line.serialUnitId ?? null}::uuid,
               ${M.toDb(M.neg(M.money(p.line.quantity)))}, ${M.toDb(p.unitCost)}, 'sale',
               'documents', ${documentId}::uuid, now())
          `);
          await ctx.tx.execute(sql`
            UPDATE stock_levels
               SET on_hand = on_hand - ${M.toDb(M.money(p.line.quantity))}, updated_at = now()
             WHERE warehouse_id = ${wh[0]!.id}::uuid AND item_id = ${p.line.itemId}::uuid
          `);
        }
      }

      // Serialised goods: mark sold and start the warranty clock.
      if (p.line.serialUnitId) {
        const warranty = new Date(`${input.issueDate}T00:00:00Z`);
        warranty.setUTCFullYear(warranty.getUTCFullYear() + 1);
        await ctx.tx.execute(sql`
          UPDATE serial_units
             SET status = 'sold', sold_to_party_id = ${input.partyId ?? null}::uuid,
                 sold_on = ${input.issueDate}::date, sold_price = ${M.toDb(p.unitPrice)},
                 warranty_ends_on = ${warranty.toISOString().slice(0, 10)}::date,
                 warehouse_id = NULL, updated_at = now()
           WHERE id = ${p.line.serialUnitId}::uuid
        `);
      }
    }

    // ── Ledger ──────────────────────────────────────────────────────────────
    // Revenue account follows the dominant line type. Mixed baskets are rare on
    // one invoice and the split lives in document_lines either way.
    const anyService = priced.some((p) => p.item.type === "service");
    const anyRent = priced.some((p) => p.item.type === "rent");
    const revenueKey = anyRent ? "REV_RENT" : anyService ? "REV_SERVICE" : "REV_PRODUCT";

    await postJournal(ctx, {
      postingDate: input.issueDate,
      source: "invoice",
      sourceTable: "documents",
      sourceId: documentId,
      narration: `Invoice ${docNumber}${partyName ? ` — ${partyName}` : ""}`,
      legs: [
        { accountKey: "AR", businessUnitId: input.businessUnitId, debit: total,
          partyId: input.partyId ?? null },
        { accountKey: revenueKey, businessUnitId: input.businessUnitId, credit: subtotal },
        ...(M.gt(taxTotal, M.ZERO)
          ? [{ accountKey: "VAT_OUTPUT", businessUnitId: input.businessUnitId, credit: taxTotal }]
          : []),
      ],
    });

    if (M.gt(costTotal, M.ZERO)) {
      await postJournal(ctx, {
        postingDate: input.issueDate,
        source: "invoice",
        sourceTable: "documents",
        sourceId: documentId,
        narration: `Cost of sales — ${docNumber}`,
        legs: [
          { accountKey: "COGS", businessUnitId: input.businessUnitId, debit: costTotal },
          { accountKey: "INVENTORY", businessUnitId: input.businessUnitId, credit: costTotal },
        ],
      });
    }

    if (paidNow) {
      const cashKey =
        input.payment!.method === "cash" ? "CASH"
        : input.payment!.method === "bank_transfer" ? "BANK" : "CARD_CLEARING";
      const payNumber = await nextDocumentNumber(
        ctx, input.businessUnitId, "payment", `PAY-${buRows[0]!.code}`,
      );
      const pay = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO payments
          (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
           amount, currency, base_amount, unallocated_amount, received_on,
           received_by_user_id, posted_at)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
           ${payNumber}, 'in', ${input.partyId ?? null}::uuid,
           ${input.payment!.method}::payment_method, ${M.toDb(total)}, ${ctx.baseCurrency},
           ${M.toDb(total)}, '0', ${input.issueDate}::date,
           ${ctx.principal.userId}::uuid, now())
        RETURNING id
      `);
      await ctx.tx.execute(sql`
        INSERT INTO payment_allocations (id, tenant_id, payment_id, document_id, amount)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${pay[0]!.id}::uuid,
                ${documentId}::uuid, ${M.toDb(total)})
      `);
      await postJournal(ctx, {
        postingDate: input.issueDate,
        source: "payment",
        sourceTable: "payments",
        sourceId: pay[0]!.id,
        narration: `Payment ${payNumber}`,
        legs: [
          { accountKey: cashKey, businessUnitId: input.businessUnitId, debit: total },
          { accountKey: "AR", businessUnitId: input.businessUnitId, credit: total,
            partyId: input.partyId ?? null },
        ],
      });
    }

    if (input.partyId) {
      await ctx.tx.execute(sql`
        UPDATE parties
           SET lifetime_value = lifetime_value + ${M.toDb(total)},
               open_balance = open_balance + ${M.toDb(paidNow ? M.ZERO : total)},
               visit_count = visit_count + 1,
               last_transaction_at = now(), rfm_recency = 0, churn_risk = 'low'
         WHERE id = ${input.partyId}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: "invoice.create",
      entityTable: "documents",
      entityId: documentId,
      businessUnitId: input.businessUnitId,
      diff: { docNumber, total, taxTotal, lines: priced.length, paidNow },
    });

    return {
      documentId,
      docNumber,
      subtotal: M.toNumber(subtotal),
      taxTotal: M.toNumber(taxTotal),
      total: M.toNumber(total),
      paid: paidNow,
    };
  });
}
