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
      amount_due: string; subtotal: string; tax_total: string; cost_total: string;
      doc_number: string; currency: string;
    }>(sql`
      SELECT id, business_unit_id, party_id, party_name_snapshot, total, amount_paid,
             amount_due, subtotal, tax_total, cost_total, doc_number, currency
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

    /**
     * The invoice's own lines, read even for a partial credit.
     *
     * Whether a price carries the VAT inside it is a property of the invoice,
     * not of the credit request — the caller never says which. A reversal that
     * guesses returns the wrong money, so the guess is replaced by what the
     * invoice stored.
     */
    const invoiceLines = await ctx.tx.execute<{
      item_id: string | null; description: string; quantity: string;
      unit_price: string; tax_rate: string; tax_amount: string;
      line_total: string; unit_cost: string;
    }>(sql`
      SELECT item_id, description, quantity, unit_price, tax_rate, tax_amount,
             line_total, unit_cost
        FROM document_lines
       WHERE document_id = ${input.invoiceId}::uuid
       ORDER BY line_no
    `);

    /**
     * Was this invoice line priced VAT-inclusive?
     *
     * Recovered from the stored figures rather than from the item's tax code,
     * because a tax code can be edited after the sale and the reversal must
     * mirror the sale as it was posted. `sales.ts` writes `line_total` =
     * quantity × unit_price for an inclusive line — the price already contains
     * the VAT — and quantity × unit_price + tax for an exclusive one. The two
     * disagree exactly when the mode does.
     *
     * A zero-rated or exempt line is both at once and the answer is not used.
     */
    const isInclusive = (l: { quantity: string; unit_price: string; line_total: string }) =>
      M.eq(
        M.fromDb(l.line_total),
        M.quantize(M.mul(M.fromDb(l.quantity), M.fromDb(l.unit_price))),
      );

    const taxedLines = invoiceLines.filter((l) => M.gt(M.fromDb(l.tax_rate), M.ZERO));
    const inclusiveByItem = new Map<string, boolean>();
    for (const l of invoiceLines) if (l.item_id) inclusiveByItem.set(l.item_id, isInclusive(l));
    /**
     * A hand-entered credit line for something the invoice did not carry has no
     * stored line to mirror, so it follows the invoice — but only when the
     * whole invoice was inclusive. On a mixed invoice there is no safe guess,
     * and taking the caller's price as the net credits the amount they asked
     * for in full rather than quietly reinterpreting part of it as tax.
     */
    const defaultInclusive = taxedLines.length === 0 || taxedLines.every(isInclusive);

    /**
     * Every line is priced exactly once, here, and both the stored document
     * line and the ledger legs read the result. Values that come out of
     * Postgres go through `M.fromDb` so they keep their exact decimal text:
     * `Number()` is lossless for numeric(18,4) in realistic ranges, but it is
     * an avoidable float hop in the one file whose whole job is reversing
     * money.
     */
    type CreditLine = {
      itemId: string | null;
      description: string;
      quantity: M.Money;
      unitPrice: M.Money;
      taxRate: M.Money;
      unitCost: M.Money;
      restockWarehouseId: string | null;
      net: M.Money;
      tax: M.Money;
      lineTotal: M.Money;
    };

    let creditLines: CreditLine[];
    if (input.full) {
      /**
       * A full credit returns the figures the invoice actually posted —
       * `line_total` and `tax_amount` — instead of re-deriving them from
       * `unit_price × quantity`. Re-deriving assumed VAT-inclusive pricing and
       * so under-credited every tax-exclusive invoice by its entire VAT: an
       * AED 1,000 + 50 invoice was credited 1,000 (952.38 net + 47.62 tax),
       * which left 50 open on the invoice forever and under-reversed output
       * VAT by 2.38, against a header that promises a full reversal.
       */
      creditLines = invoiceLines.map((l) => {
        const lineTotal = M.fromDb(l.line_total);
        const tax = M.fromDb(l.tax_amount);
        return {
          itemId: l.item_id,
          description: l.description,
          quantity: M.fromDb(l.quantity),
          unitPrice: M.fromDb(l.unit_price),
          taxRate: M.fromDb(l.tax_rate),
          unitCost: M.fromDb(l.unit_cost),
          restockWarehouseId: null,
          net: M.sub(lineTotal, tax),
          tax,
          lineTotal,
        };
      });
    } else {
      if (!input.lines?.length) throw new ServiceError("Give lines to credit, or set full.", "invalid");
      creditLines = input.lines.map((l) => {
        const quantity = M.money(l.quantity);
        const unitPrice = M.money(l.unitPrice);
        const rate = M.money(l.taxRate);
        const extended = M.quantize(M.mul(quantity, unitPrice));
        const inclusive = l.itemId != null && inclusiveByItem.has(l.itemId)
          ? inclusiveByItem.get(l.itemId)!
          : defaultInclusive;

        // Inclusive: the price already contains the VAT, so tax is the
        // REMAINDER — gross / (1 + rate) never terminates in binary at 5%, and
        // net + tax has to equal the gross exactly on the printed document.
        // Exclusive: the price IS the net and the VAT is added on top.
        let net: M.Money, tax: M.Money, lineTotal: M.Money;
        if (M.isZero(rate)) {
          net = extended; tax = M.ZERO; lineTotal = extended;
        } else if (inclusive) {
          net = M.quantize(M.div(extended, M.add(M.money(1), rate)));
          tax = M.sub(extended, net);
          lineTotal = extended;
        } else {
          net = extended;
          tax = M.quantize(M.mul(extended, rate));
          lineTotal = M.add(extended, tax);
        }

        return {
          itemId: l.itemId ?? null,
          description: l.description,
          quantity,
          unitPrice,
          taxRate: rate,
          unitCost: M.money(l.unitCost ?? 0),
          restockWarehouseId: l.restockWarehouseId ?? null,
          net, tax, lineTotal,
        };
      });
    }

    let subtotal = M.ZERO, taxTotal = M.ZERO, costTotal = M.ZERO;
    for (const l of creditLines) {
      subtotal = M.add(subtotal, l.net);
      taxTotal = M.add(taxTotal, l.tax);
      costTotal = M.add(costTotal, M.quantize(M.mul(l.quantity, l.unitCost)));
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
           ${l.itemId}::uuid, ${l.description}, ${M.toDb(l.quantity)},
           ${M.toDb(l.unitPrice)}, ${l.taxRate.toFixed(6)},
           ${M.toDb(l.tax)}, ${M.toDb(l.lineTotal)}, ${M.toDb(l.unitCost)})
      `);

      // Returned goods go back into stock.
      if (l.restockWarehouseId && l.itemId) {
        await ctx.tx.execute(sql`
          INSERT INTO stock_moves
            (id, tenant_id, business_unit_id, warehouse_id, item_id, quantity,
             unit_cost, reason, source_table, source_id, occurred_at)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${inv.business_unit_id}::uuid,
             ${l.restockWarehouseId}::uuid, ${l.itemId}::uuid, ${M.toDb(l.quantity)},
             ${M.toDb(l.unitCost)}, 'return_in', 'documents', ${cn.id}::uuid, now())
        `);

        const qty = sql`${M.toDb(l.quantity)}::numeric`;
        const cost = sql`${M.toDb(l.unitCost)}::numeric`;
        // Update the existing variant-less level, or create it — as
        // `purchasing.ts` and `inventory.ts` do. A bare UPDATE was a no-op when
        // the item had never been stocked in that warehouse: the `stock_moves`
        // row above was written and the cached level was not, so the stock
        // ledger and its cache diverged with nothing to show for it. The
        // `variant_id IS NULL` predicate is part of the fix, not decoration —
        // without it the UPDATE would also rewrite every variant's level.
        //
        // ON CONFLICT is avoided deliberately: the unique index includes
        // variant_id and NULLs are distinct in a standard unique index, so an
        // upsert on a NULL variant would insert a duplicate rather than update.
        const updated = await ctx.tx.execute<{ id: string }>(sql`
          UPDATE stock_levels SET
            -- Goods return at the cost they left at, so the moving average only
            -- moves when that cost is actually known. A credit line with no
            -- unit cost (the input default) must not drag avg_cost towards zero
            -- and silently understate every later margin.
            avg_cost = CASE
              WHEN ${cost} > 0 AND on_hand + ${qty} > 0
                THEN (on_hand * avg_cost + ${qty} * ${cost}) / (on_hand + ${qty})
              ELSE avg_cost
            END,
            on_hand = on_hand + ${qty}, updated_at = now()
           WHERE warehouse_id = ${l.restockWarehouseId}::uuid AND item_id = ${l.itemId}::uuid
             AND variant_id IS NULL
          RETURNING id
        `);
        if (updated.length === 0) {
          await ctx.tx.execute(sql`
            INSERT INTO stock_levels (id, tenant_id, warehouse_id, item_id, on_hand, avg_cost)
            VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${l.restockWarehouseId}::uuid,
                    ${l.itemId}::uuid, ${qty}, ${cost})
          `);
        }
      }
    }

    // ── Ledger: reverse the sale ────────────────────────────────────────────
    /**
     * Which revenue accounts did this invoice actually credit?
     *
     * Hardcoding `REV_PRODUCT` here was not a cosmetic slip. Crediting an
     * AED 60,000 rent invoice left REV_RENT overstated by 60,000 and
     * REV_PRODUCT negative by 60,000 — permanently, in two places — and because
     * residential rent is the exempt-supply line in the UAE chart, it also
     * corrupted the exempt-versus-standard split the VAT return is built from.
     *
     * The invoice's own posted journal is read instead of re-deriving the
     * account from the items, which keeps the reversal correct however
     * `sales.ts` chooses its revenue accounts — one per invoice today, one per
     * line later. Summing credit − debit nets off any earlier reversal against
     * the same document rather than double-counting it.
     */
    const revenueLegs = await ctx.tx.execute<{ system_key: string; amount: string }>(sql`
      SELECT a.system_key, SUM(jl.base_credit - jl.base_debit) AS amount
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE j.source_table = 'documents' AND j.source_id = ${input.invoiceId}::uuid
         AND j.deleted_at IS NULL AND jl.deleted_at IS NULL
         AND a.type = 'income' AND a.system_key IS NOT NULL
       GROUP BY a.system_key
      HAVING SUM(jl.base_credit - jl.base_debit) > 0
       ORDER BY 2 DESC, 1
    `);

    /**
     * Split the credited net across those accounts in the proportion the
     * invoice credited them. With one revenue account this is an exact mirror;
     * with several it is a weighted one whose shares still sum to `subtotal`
     * exactly — `M.allocate` hands the last fils to a share rather than
     * dropping it and leaving the journal unbalanced at COMMIT.
     *
     * A document with no posted revenue leg is not something this codebase
     * creates. The fallback keeps such a document creditable instead of
     * failing at the till, and is the only path on which the old hardcoded
     * account survives.
     */
    const revenueShares = revenueLegs.length > 0
      ? M.allocate(subtotal, revenueLegs.map((r) => M.fromDb(r.amount))).map((amount, i) => ({
          accountKey: revenueLegs[i]!.system_key,
          amount,
        }))
      : [{ accountKey: "REV_PRODUCT", amount: subtotal }];

    await postJournal(ctx, {
      postingDate: ctx.today,
      source: "invoice",
      sourceTable: "documents",
      sourceId: cn.id,
      narration: `Credit note ${docNumber} against ${inv.doc_number}`,
      legs: [
        ...revenueShares
          .filter((r) => M.gt(r.amount, M.ZERO))
          .map((r) => ({
            accountKey: r.accountKey,
            businessUnitId: inv.business_unit_id,
            debit: r.amount,
          })),
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
    /**
     * What is still owed is the invoice's live `amount_due` — the figure every
     * payment and every earlier credit note has already reduced. It was
     * computed as `total − amount_paid`, which no credit note ever moves, so a
     * second credit note on a part-paid invoice claimed to settle a balance
     * that the first had already settled: invoice 1,000, paid 700, CN1 300
     * (due → 0), then CN2 300 recomputed 300 as still outstanding, applied it,
     * and the `GREATEST(0, …)` below swallowed the excess. The customer got
     * neither a refund nor a balance reduction while the journal credited AR by
     * 300 — the general ledger and the AR subledger diverged with no error and
     * no evidence. Reading `amount_due` makes that same second credit note
     * fully refundable, which is what the customer is actually owed.
     *
     * The row is held under FOR UPDATE from the top of this function, so two
     * concurrent credit notes cannot both read the same balance.
     */
    const outstanding = M.fromDb(inv.amount_due);
    const appliedToInvoice = M.min(total, M.max(M.ZERO, outstanding));
    const refundable = M.sub(total, appliedToInvoice);

    if (M.gt(appliedToInvoice, M.ZERO)) {
      await ctx.tx.execute(sql`
        UPDATE documents
           -- GREATEST(0, ...) removed, as in payments.ts and purchasing.ts: it
           -- clamped a negative balance to zero, which silently ABSORBED an
           -- over-credit and destroyed the evidence that it happened.
           -- appliedToInvoice is capped at the live amount_due above and the
           -- cumulative credit is refused exactly further up, so a negative
           -- here means a real bug and must be visible rather than swallowed.
           SET amount_due = amount_due - ${M.toDb(appliedToInvoice)},
               -- Exact: settled means settled, not "within a fils of settled".
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
