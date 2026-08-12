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
 * THE PAYABLES AND PURCHASING SIDE.
 *
 * The receivables side was built first because it is where cash comes in. But a
 * money model with only receivables is half a ledger: the owner cannot see what
 * they owe, cannot value creditor days, and cannot reclaim input VAT on
 * purchases — which in the UAE is real money.
 *
 * This is where the polymorphic `documents` table earns its keep. A supplier
 * bill is an invoice with `direction = 'out'`; a purchase order is a bill that
 * has not been received yet. The same table, the same lines, the same payment
 * machinery — mirrored, with the signs flipped. Building it as a second set of
 * tables would have doubled the surface for no gain.
 */

// ── Purchase orders ─────────────────────────────────────────────────────────

export const createPurchaseOrderInput = z.object({
  businessUnitId: z.uuid(),
  supplierId: z.uuid(),
  issueDate: z.iso.date(),
  expectedDate: z.iso.date().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: z.number().positive().max(1_000_000),
        unitCost: z.number().min(0),
        description: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
  notes: z.string().max(1000).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Raise a purchase order.
 *
 * A PO is a commitment, not a transaction: no stock moves and no ledger entry
 * yet, because nothing has been received and nothing is owed. It exists so the
 * owner can send it to the supplier and so goods receipt has something to match
 * against. Input VAT is recorded per line but only *recovered* when the bill is
 * posted — matching the FTA's tax-point rules.
 */
export async function createPurchaseOrder(ctx: ServiceContext, raw: unknown) {
  const input = createPurchaseOrderInput.parse(raw);
  requirePermission(ctx, "document:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "createPurchaseOrder", async () => {
    const [bu] = await ctx.tx.execute<{ code: string }>(sql`
      SELECT code FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    if (!bu) throw new ServiceError("Business not found.", "not_found");

    const [supplier] = await ctx.tx.execute<{ display_name: string; is_supplier: boolean }>(sql`
      SELECT display_name, is_supplier FROM parties WHERE id = ${input.supplierId}::uuid
    `);
    if (!supplier) throw new ServiceError("Supplier not found.", "not_found");

    const subtotal = M.quantize(
      M.sum(input.lines.map((l) => M.quantize(M.mul(M.money(l.quantity), M.money(l.unitCost))))),
    );
    const docNumber = await nextDocumentNumber(ctx, input.businessUnitId, "purchase_order", `PO-${bu.code}`);

    const [doc] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_id, party_name_snapshot, issue_date, due_date, currency,
         subtotal, tax_total, total, amount_due, base_total, cost_total, notes)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         'purchase_order', ${docNumber}, 'draft', 'out',
         ${input.supplierId}::uuid, ${supplier.display_name}, ${input.issueDate}::date,
         ${input.expectedDate ?? null}::date, ${ctx.baseCurrency},
         ${M.toDb(subtotal)}, '0', ${M.toDb(subtotal)}, '0',
         ${M.toDb(subtotal)}, ${M.toDb(subtotal)}, ${input.notes ?? null})
      RETURNING id
    `);

    let lineNo = 0;
    for (const line of input.lines) {
      lineNo++;
      await ctx.tx.execute(sql`
        INSERT INTO document_lines
          (id, tenant_id, document_id, line_no, item_id, description,
           quantity, unit_price, line_total, unit_cost)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${doc.id}::uuid, ${lineNo},
           ${line.itemId}::uuid, ${line.description ?? ""}, ${M.toDb(M.money(line.quantity))},
           ${M.toDb(M.money(line.unitCost))}, ${M.toDb(M.quantize(M.mul(M.money(line.quantity), M.money(line.unitCost))))},
           ${M.toDb(M.money(line.unitCost))})
      `);
    }

    await writeAudit(ctx, {
      action: "purchase_order.create",
      entityTable: "documents",
      entityId: doc.id,
      businessUnitId: input.businessUnitId,
      diff: { docNumber, supplier: supplier.display_name, total: M.toDb(subtotal) },
    });

    return { documentId: doc.id, docNumber, total: M.toNumber(subtotal) };
  });
}

// ── Goods receipt + bill ────────────────────────────────────────────────────

export const receiveBillInput = z.object({
  businessUnitId: z.uuid(),
  supplierId: z.uuid(),
  /** Optional PO this bill fulfils, for three-way matching. */
  purchaseOrderId: z.uuid().nullable().optional(),
  billDate: z.iso.date(),
  supplierReference: z.string().max(100).optional(),
  /** The supplier's own credit terms; drives when this becomes overdue. */
  paymentTermDays: z.number().int().min(0).max(180).default(30),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: z.number().positive().max(1_000_000),
        unitCost: z.number().min(0),
        /** Standard 5% unless the item is exempt/zero-rated. */
        vatRate: z.number().min(0).max(1).default(0.05),
        description: z.string().max(500).optional(),
        /** Receive into this warehouse. Defaults to the business's main store. */
        warehouseId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  /** Whether the goods physically arrived (stock in) or this is a service bill. */
  receiveStock: z.boolean().default(true),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Record a supplier bill and receive the goods.
 *
 * This is the mirror of createInvoice, and the symmetry is deliberate:
 *
 *   invoice  → DR Accounts Receivable / CR Revenue + Output VAT
 *   bill     → DR Inventory + Recoverable Input VAT / CR Accounts Payable
 *
 * Input VAT is recovered HERE, at the tax point, and the moving-average cost of
 * every received item is recomputed — because the cost of goods sold on the next
 * invoice depends on what this purchase actually cost, not on a stale figure.
 */
export async function receiveBill(ctx: ServiceContext, raw: unknown) {
  const input = receiveBillInput.parse(raw);
  requirePermission(ctx, "document:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "receiveBill", async () => {
    const [bu] = await ctx.tx.execute<{ code: string }>(sql`
      SELECT code FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    if (!bu) throw new ServiceError("Business not found.", "not_found");

    const [supplier] = await ctx.tx.execute<{ display_name: string }>(sql`
      SELECT display_name FROM parties WHERE id = ${input.supplierId}::uuid
    `);
    if (!supplier) throw new ServiceError("Supplier not found.", "not_found");

    // Default warehouse: the first non-van store for this business.
    let defaultWarehouseId: string | null = null;
    if (input.receiveStock) {
      const [wh] = await ctx.tx.execute<{ id: string }>(sql`
        SELECT id FROM warehouses
         WHERE business_unit_id = ${input.businessUnitId}::uuid AND is_mobile_van = false
         ORDER BY created_at LIMIT 1
      `);
      defaultWarehouseId = wh?.id ?? null;
    }

    let subtotal = M.ZERO, taxTotal = M.ZERO;
    let inputVatRecoverable = M.ZERO, inputVatIrrecoverable = M.ZERO;
    const priced: {
      line: (typeof input.lines)[number];
      net: M.Money;
      vat: M.Money;
      recoverable: boolean;
    }[] = [];

    // Whether input VAT is recoverable depends on what the business SUPPLIES.
    // A purchase serving exempt residential rent cannot reclaim its input VAT.
    const [buKind] = await ctx.tx.execute<{ kind: string }>(sql`
      SELECT kind::text FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    const servesExemptSupplies = buKind?.kind === "rental";

    for (const line of input.lines) {
      // Rounded per line, because that is the granularity the line is stored
      // at. Summing unrounded lines and rounding once at the end yields a total
      // the printed line items visibly do not add up to.
      const net = M.quantize(M.mul(M.money(line.quantity), M.money(line.unitCost)));
      const vat = M.quantize(M.mul(net, M.money(line.vatRate)));
      subtotal = M.add(subtotal, net);
      taxTotal = M.add(taxTotal, vat);
      const recoverable = !servesExemptSupplies;
      if (recoverable) inputVatRecoverable = M.add(inputVatRecoverable, vat);
      else inputVatIrrecoverable = M.add(inputVatIrrecoverable, vat);
      priced.push({ line, net, vat, recoverable });
    }

    const total = M.add(subtotal, taxTotal);
    const dueDate = new Date(`${input.billDate}T00:00:00Z`);
    dueDate.setUTCDate(dueDate.getUTCDate() + input.paymentTermDays);

    const docNumber = await nextDocumentNumber(ctx, input.businessUnitId, "bill", `BILL-${bu.code}`);

    const [doc] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_id, party_name_snapshot, issue_date, due_date, currency,
         subtotal, tax_total, total, amount_paid, amount_due, base_total, cost_total,
         source_document_id, posted_at, notes)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         'bill', ${docNumber}, 'confirmed', 'out',
         ${input.supplierId}::uuid, ${supplier.display_name}, ${input.billDate}::date,
         ${dueDate.toISOString().slice(0, 10)}::date, ${ctx.baseCurrency},
         ${M.toDb(subtotal)}, ${M.toDb(taxTotal)}, ${M.toDb(total)},
         '0', ${M.toDb(total)}, ${M.toDb(total)}, ${M.toDb(subtotal)},
         ${input.purchaseOrderId ?? null}::uuid, now(),
         ${input.supplierReference ? `Supplier ref: ${input.supplierReference}` : null})
      RETURNING id
    `);

    let lineNo = 0;
    for (const { line, net, vat } of priced) {
      lineNo++;
      await ctx.tx.execute(sql`
        INSERT INTO document_lines
          (id, tenant_id, document_id, line_no, item_id, description,
           quantity, unit_price, tax_rate, tax_amount, line_total, unit_cost)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${doc.id}::uuid, ${lineNo},
           ${line.itemId}::uuid, ${line.description ?? ""}, ${M.toDb(M.money(line.quantity))},
           ${M.toDb(M.money(line.unitCost))}, ${line.vatRate.toFixed(6)}, ${M.toDb(vat)},
           ${M.toDb(M.add(net, vat))}, ${M.toDb(M.money(line.unitCost))})
      `);

      // ── Receive stock and recompute moving-average cost ─────────────────
      if (input.receiveStock) {
        const warehouseId = line.warehouseId ?? defaultWarehouseId;
        if (warehouseId) {
          await ctx.tx.execute(sql`
            INSERT INTO stock_moves
              (id, tenant_id, business_unit_id, warehouse_id, item_id, quantity,
               unit_cost, reason, source_table, source_id, occurred_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
               ${warehouseId}::uuid, ${line.itemId}::uuid, ${M.toDb(M.money(line.quantity))},
               ${M.toDb(M.money(line.unitCost))}, 'purchase', 'documents', ${doc.id}::uuid, now())
          `);

          // Moving average: (old value + new value) ÷ (old qty + new qty). A
          // naive overwrite of cost would misstate COGS on every subsequent
          // sale. Parameters are cast to numeric so untyped-literal arithmetic
          // does not confuse the planner.
          const qty = sql`${M.toDb(M.money(line.quantity))}::numeric`;
          const cost = sql`${M.toDb(M.money(line.unitCost))}::numeric`;
          // Update the existing variant-less level, or create it. ON CONFLICT is
          // avoided: NULL variant_id is distinct in a standard unique index, so
          // an upsert would insert a duplicate rather than update.
          const updated = await ctx.tx.execute<{ id: string }>(sql`
            UPDATE stock_levels SET
              avg_cost = CASE
                WHEN on_hand + ${qty} = 0 THEN ${cost}
                ELSE (on_hand * avg_cost + ${qty} * ${cost}) / (on_hand + ${qty})
              END,
              on_hand = on_hand + ${qty}, updated_at = now()
             WHERE warehouse_id = ${warehouseId}::uuid AND item_id = ${line.itemId}::uuid
               AND variant_id IS NULL
            RETURNING id
          `);
          if (updated.length === 0) {
            await ctx.tx.execute(sql`
              INSERT INTO stock_levels (id, tenant_id, warehouse_id, item_id, on_hand, avg_cost)
              VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${warehouseId}::uuid,
                      ${line.itemId}::uuid, ${qty}, ${cost})
            `);
          }

          // Keep the item's headline cost in step, so catalogue and margin
          // reports reflect the latest purchase.
          await ctx.tx.execute(sql`
            UPDATE items i SET cost_price = sl.avg_cost, updated_at = now()
              FROM stock_levels sl
             WHERE i.id = ${line.itemId}::uuid AND sl.warehouse_id = ${warehouseId}::uuid
               AND sl.item_id = i.id
          `);
        }
      }
    }

    // ── Ledger ──────────────────────────────────────────────────────────────
    // DR whatever was bought (inventory for goods, an expense for services)
    // DR recoverable input VAT (or expense the irrecoverable portion)
    // CR accounts payable
    const debitTarget = input.receiveStock ? "INVENTORY" : "MATERIALS";
    const legs: Parameters<typeof postJournal>[1]["legs"] = [
      { accountKey: debitTarget, businessUnitId: input.businessUnitId, debit: subtotal },
    ];
    if (M.gt(inputVatRecoverable, M.ZERO)) {
      legs.push({ accountKey: "VAT_INPUT", businessUnitId: input.businessUnitId, debit: inputVatRecoverable });
    }
    if (M.gt(inputVatIrrecoverable, M.ZERO)) {
      legs.push({ accountKey: "VAT_IRRECOVERABLE", businessUnitId: input.businessUnitId, debit: inputVatIrrecoverable });
    }
    legs.push({ accountKey: "AP", businessUnitId: input.businessUnitId, credit: total, partyId: input.supplierId });

    await postJournal(ctx, {
      postingDate: input.billDate,
      source: "bill",
      sourceTable: "documents",
      sourceId: doc.id,
      narration: `Bill ${docNumber} — ${supplier.display_name}`,
      legs,
    });

    // Close the PO if this fulfils one.
    if (input.purchaseOrderId) {
      await ctx.tx.execute(sql`
        UPDATE documents SET status = 'paid', updated_at = now()
         WHERE id = ${input.purchaseOrderId}::uuid AND doc_type = 'purchase_order'
      `);
    }

    await writeAudit(ctx, {
      action: "bill.receive",
      entityTable: "documents",
      entityId: doc.id,
      businessUnitId: input.businessUnitId,
      diff: {
        docNumber, supplier: supplier.display_name, total,
        inputVatRecoverable, inputVatIrrecoverable, stockReceived: input.receiveStock,
      },
    });

    return {
      documentId: doc.id,
      docNumber,
      total: M.toNumber(total),
      inputVatRecoverable: M.toNumber(inputVatRecoverable),
      inputVatIrrecoverable: M.toNumber(inputVatIrrecoverable),
    };
  });
}

// ── Bill payment (money out) ────────────────────────────────────────────────

export const payBillInput = z.object({
  businessUnitId: z.uuid(),
  supplierId: z.uuid(),
  amount: z.number().positive().max(100_000_000),
  method: z.enum(["cash", "bank_transfer", "cheque", "card"]),
  paidOn: z.iso.date(),
  reference: z.string().max(100).optional(),
  /** Bills to settle. Oldest first when omitted. */
  billId: z.uuid().nullable().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Pay a supplier.
 *
 * The mirror of recordPayment, and it reuses the same over-allocation guard: a
 * payment cannot exceed what is owed on the bill. Money out debits payables and
 * credits the bank — the opposite of a receipt.
 */
export async function payBill(ctx: ServiceContext, raw: unknown) {
  const input = payBillInput.parse(raw);
  requirePermission(ctx, "payment:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "payBill", async () => {
    const [bu] = await ctx.tx.execute<{ code: string }>(sql`
      SELECT code FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    if (!bu) throw new ServiceError("Business not found.", "not_found");

    // Which bills to settle.
    const amount = M.money(input.amount);
    let targets: { documentId: string; amount: M.Money }[] = [];
    if (input.billId) {
      const [bill] = await ctx.tx.execute<{ amount_due: string }>(sql`
        SELECT amount_due FROM documents WHERE id = ${input.billId}::uuid FOR UPDATE
      `);
      if (!bill) throw new ServiceError("Bill not found.", "not_found");
      // Exact. The `+ 0.005` slack existed to absorb float drift and had the
      // side effect of permitting a half-fils over-payment.
      const due = M.fromDb(bill.amount_due);
      if (M.gt(amount, due)) {
        throw new ServiceError(
          `Cannot pay ${M.toDisplay(amount)} against a bill with only ${M.toDisplay(due)} outstanding.`,
          "invalid",
        );
      }
      targets = [{ documentId: input.billId, amount }];
    } else {
      const open = await ctx.tx.execute<{ id: string; amount_due: string }>(sql`
        SELECT id, amount_due FROM documents
         WHERE party_id = ${input.supplierId}::uuid AND business_unit_id = ${input.businessUnitId}::uuid
           AND direction = 'out' AND doc_type = 'bill' AND amount_due > 0
           AND status NOT IN ('cancelled','void')
         ORDER BY due_date ASC NULLS LAST, issue_date ASC
         FOR UPDATE
      `);
      let remaining = amount;
      for (const b of open) {
        if (!M.gt(remaining, M.ZERO)) break;
        const take = M.min(remaining, M.fromDb(b.amount_due));
        targets.push({ documentId: b.id, amount: take });
        remaining = M.sub(remaining, take);
      }
    }

    const allocated = M.sum(targets.map((t) => t.amount));
    const paymentNumber = await nextDocumentNumber(ctx, input.businessUnitId, "payment", `PAYOUT-${bu.code}`);

    const [pay] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payments
        (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
         amount, currency, base_amount, unallocated_amount, received_on, reference,
         received_by_user_id, posted_at)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${paymentNumber}, 'out', ${input.supplierId}::uuid, ${input.method}::payment_method,
         ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)},
         ${M.toDb(M.sub(amount, allocated))}, ${input.paidOn}::date, ${input.reference ?? null},
         ${ctx.principal.userId}::uuid, now())
      RETURNING id
    `);

    for (const t of targets) {
      await ctx.tx.execute(sql`
        INSERT INTO payment_allocations (id, tenant_id, payment_id, document_id, amount)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${pay.id}::uuid, ${t.documentId}::uuid, ${M.toDb(t.amount)})
      `);
      await ctx.tx.execute(sql`
        UPDATE documents
           SET amount_paid = amount_paid + ${M.toDb(t.amount)},
               -- GREATEST(0, ...) is gone. It clamped a negative balance to zero,
               -- which silently ABSORBED an over-payment instead of surfacing it
               -- and destroyed the evidence that it happened. Over-allocation is
               -- refused above, so a negative here means a real bug and should be
               -- visible rather than swallowed.
               amount_due  = total - (amount_paid + ${M.toDb(t.amount)}),
               -- Exact: paid means paid, not "within a fils of paid".
               status = CASE WHEN total - (amount_paid + ${M.toDb(t.amount)}) <= 0
                             THEN 'paid'::doc_status ELSE 'partially_paid'::doc_status END,
               updated_at = now()
         WHERE id = ${t.documentId}::uuid
      `);
    }

    const cashKey = input.method === "cash" ? "CASH" : "BANK";
    await postJournal(ctx, {
      postingDate: input.paidOn,
      source: "payment",
      sourceTable: "payments",
      sourceId: pay.id,
      narration: `Supplier payment ${paymentNumber}`,
      legs: [
        { accountKey: "AP", businessUnitId: input.businessUnitId, debit: allocated, partyId: input.supplierId },
        { accountKey: cashKey, businessUnitId: input.businessUnitId, credit: input.amount },
      ],
    });

    await writeAudit(ctx, {
      action: "bill.pay",
      entityTable: "payments",
      entityId: pay.id,
      businessUnitId: input.businessUnitId,
      diff: { paymentNumber, amount: input.amount, method: input.method, bills: targets.length },
    });

    return { paymentId: pay.id, paymentNumber, allocated: M.toNumber(allocated) };
  });
}
