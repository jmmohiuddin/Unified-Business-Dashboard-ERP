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
 * Receiving money.
 *
 * The most safety-critical write in the product: it is the one where a bug
 * either loses a customer's payment or takes it twice. Hence idempotency keys,
 * a single transaction covering the receipt, its allocations, the ledger entry
 * and the audit record, and a hard refusal to over-allocate.
 */

export const recordPaymentInput = z.object({
  businessUnitId: z.uuid(),
  partyId: z.uuid().nullable().optional(),
  amount: z.number().positive().max(100_000_000),
  method: z.enum([
    "cash", "card", "bank_transfer", "cheque", "digital_wallet", "bnpl", "gateway",
  ]),
  receivedOn: z.iso.date(),
  reference: z.string().max(100).optional(),
  /** Invoices to settle, oldest-first if omitted. */
  allocations: z
    .array(z.object({ documentId: z.uuid(), amount: z.number().positive() }))
    .optional(),
  /** Apply whatever is left to the oldest outstanding invoices for this party. */
  autoAllocate: z.boolean().default(true),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentInput>;

export interface RecordPaymentResult {
  paymentId: string;
  paymentNumber: string;
  allocated: number;
  unallocated: number;
  settledInvoices: { documentId: string; docNumber: string; amount: number; nowPaid: boolean }[];
}

/** Which ledger account the money landed in. */
const CASH_ACCOUNT: Record<string, string> = {
  cash: "CASH",
  card: "CARD_CLEARING",
  digital_wallet: "CARD_CLEARING",
  gateway: "CARD_CLEARING",
  bank_transfer: "BANK",
  cheque: "BANK",
  bnpl: "CARD_CLEARING",
};

export async function recordPayment(
  ctx: ServiceContext,
  raw: unknown,
): Promise<RecordPaymentResult> {
  const input = recordPaymentInput.parse(raw);
  requirePermission(ctx, "payment:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "recordPayment", async () => {
    const bu = await ctx.tx.execute<{ code: string; name: string }>(sql`
      SELECT code, name FROM business_units WHERE id = ${input.businessUnitId}::uuid
    `);
    if (bu.length === 0) throw new ServiceError("Business not found.", "not_found");

    // ── Decide what this payment settles ────────────────────────────────────
    const amount = M.money(input.amount);
    let targets: { documentId: string; amount: M.Money }[] = (input.allocations ?? []).map(
      (a) => ({ documentId: a.documentId, amount: M.money(a.amount) }),
    );

    if (targets.length === 0 && input.autoAllocate && input.partyId) {
      // Oldest first. It is what customers assume, and it is what keeps the
      // ageing report honest — allocating to the newest invoice would leave a
      // permanently "90 days overdue" balance that is actually being paid.
      const open = await ctx.tx.execute<{ id: string; amount_due: string }>(sql`
        SELECT id, amount_due FROM documents
         WHERE party_id = ${input.partyId}::uuid
           AND business_unit_id = ${input.businessUnitId}::uuid
           AND direction = 'in' AND amount_due > 0
           AND status NOT IN ('cancelled','void','draft')
         ORDER BY due_date ASC NULLS LAST, issue_date ASC
      `);
      let remaining = amount;
      for (const inv of open) {
        if (!M.gt(remaining, M.ZERO)) break;
        const take = M.min(remaining, M.fromDb(inv.amount_due));
        targets.push({ documentId: inv.id, amount: take });
        remaining = M.sub(remaining, take);
      }
    }

    // Fold duplicate targets before anything reads a balance. The validation
    // below re-reads `amount_due` per target from a row no earlier target has
    // updated yet, so two lines naming the same invoice would each be checked
    // against the same untouched balance and both would pass — splitting an
    // over-allocation across lines and producing exactly the negative balance
    // the guard below exists to make impossible. Folding first means one lock,
    // one check and one allocation row per invoice, whatever the caller sent.
    const folded = new Map<string, M.Money>();
    for (const t of targets) {
      const prior = folded.get(t.documentId);
      folded.set(t.documentId, prior ? M.add(prior, t.amount) : t.amount);
    }
    targets = [...folded].map(([documentId, amount]) => ({ documentId, amount }));

    // ── Validate every allocation before writing anything ───────────────────
    const settled: RecordPaymentResult["settledInvoices"] = [];
    let allocatedTotal = M.ZERO;

    for (const t of targets) {
      const rows = await ctx.tx.execute<{
        id: string; doc_number: string; amount_due: string; total: string; amount_paid: string;
      }>(sql`
        SELECT id, doc_number, amount_due, total, amount_paid
          FROM documents WHERE id = ${t.documentId}::uuid FOR UPDATE
      `);
      const doc = rows[0];
      if (!doc) throw new ServiceError(`Invoice ${t.documentId} not found.`, "not_found");

      // Over-allocation is a data-integrity bug, not a rounding nicety: it
      // produces a negative balance that silently understates receivables.
      // Exact. The `+ 0.005` was float slack, and it let a half-fils
      // over-allocation through on every invoice.
      const due = M.fromDb(doc.amount_due);
      if (M.gt(t.amount, due)) {
        throw new ServiceError(
          `Cannot allocate ${M.toDisplay(t.amount)} to ${doc.doc_number} — only ${M.toDisplay(due)} is outstanding.`,
          "invalid",
        );
      }
      allocatedTotal = M.add(allocatedTotal, t.amount);
    }

    if (M.gt(allocatedTotal, amount)) {
      throw new ServiceError(
        `Allocations total ${M.toDisplay(allocatedTotal)} but the payment is ${M.toDisplay(amount)}.`,
        "invalid",
      );
    }

    const unallocated = M.max(M.ZERO, M.sub(amount, allocatedTotal));
    const paymentNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "payment", `PAY-${bu[0]!.code}`,
    );

    // ── Write ───────────────────────────────────────────────────────────────
    const pay = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payments
        (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
         amount, currency, base_amount, unallocated_amount, received_on, reference,
         received_by_user_id, posted_at, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${paymentNumber}, 'in', ${input.partyId ?? null}::uuid, ${input.method}::payment_method,
         ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)},
         ${M.toDb(unallocated)}, ${input.receivedOn}::date, ${input.reference ?? null},
         ${ctx.principal.userId}::uuid, now(), ${input.note ?? null})
      RETURNING id
    `);
    const paymentId = pay[0]!.id;

    for (const t of targets) {
      await ctx.tx.execute(sql`
        INSERT INTO payment_allocations (id, tenant_id, payment_id, document_id, amount)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${paymentId}::uuid,
                ${t.documentId}::uuid, ${M.toDb(t.amount)})
      `);
      const upd = await ctx.tx.execute<{ doc_number: string; amount_due: string }>(sql`
        UPDATE documents
           SET amount_paid = amount_paid + ${M.toDb(t.amount)},
               -- GREATEST(0, ...) removed: it clamped a negative balance to zero,
               -- silently absorbing an over-allocation and destroying the evidence.
               -- Over-allocation is refused above, so a negative means a real bug.
               amount_due  = total - (amount_paid + ${M.toDb(t.amount)}),
               status = CASE
                 WHEN total - (amount_paid + ${M.toDb(t.amount)}) <= 0 THEN 'paid'::doc_status
                 ELSE 'partially_paid'::doc_status END,
               days_overdue = CASE
                 WHEN total - (amount_paid + ${M.toDb(t.amount)}) <= 0 THEN 0
                 ELSE days_overdue END,
               updated_at = now()
         WHERE id = ${t.documentId}::uuid
        RETURNING doc_number, amount_due
      `);
      settled.push({
        documentId: t.documentId,
        docNumber: upd[0]!.doc_number,
        amount: M.toNumber(t.amount),
        nowPaid: !M.gt(M.fromDb(upd[0]!.amount_due), M.ZERO),
      });
    }

    // ── Post to the ledger ──────────────────────────────────────────────────
    // Unallocated money is a LIABILITY (customer advance), not revenue and not
    // a reduction of receivables — the customer is owed goods or a refund.
    const legs = [
      {
        accountKey: CASH_ACCOUNT[input.method] ?? "BANK",
        businessUnitId: input.businessUnitId,
        debit: amount,
      },
      ...(M.gt(allocatedTotal, M.ZERO)
        ? [{ accountKey: "AR", businessUnitId: input.businessUnitId,
             credit: allocatedTotal, partyId: input.partyId ?? null }]
        : []),
      ...(M.gt(unallocated, M.ZERO)
        ? [{ accountKey: "CUSTOMER_ADVANCE", businessUnitId: input.businessUnitId,
             credit: unallocated, partyId: input.partyId ?? null }]
        : []),
    ];

    await postJournal(ctx, {
      postingDate: input.receivedOn,
      source: "payment",
      sourceTable: "payments",
      sourceId: paymentId,
      narration: `Payment ${paymentNumber}`,
      legs,
    });

    // Keep the customer rollup honest immediately, not on the nightly job —
    // the person taking the payment will look at the balance a second later.
    if (input.partyId) {
      await ctx.tx.execute(sql`
        UPDATE parties
           SET open_balance = GREATEST(0, open_balance - ${M.toDb(allocatedTotal)}),
               last_transaction_at = now()
         WHERE id = ${input.partyId}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: "payment.record",
      entityTable: "payments",
      entityId: paymentId,
      businessUnitId: input.businessUnitId,
      diff: {
        paymentNumber,
        amount: input.amount,
        method: input.method,
        allocated: M.toDb(allocatedTotal),
        unallocated: M.toDb(unallocated),
        invoices: settled.map((s) => s.docNumber),
      },
    });

    return {
      paymentId,
      paymentNumber,
      allocated: M.toNumber(allocatedTotal),
      unallocated: M.toNumber(unallocated),
      settledInvoices: settled,
    };
  });
}

// ── Cheque lifecycle ────────────────────────────────────────────────────────

export const chequeTransitionInput = z.object({
  chequeId: z.uuid(),
  action: z.enum(["deposit", "clear", "bounce", "replace", "return", "cancel"]),
  onDate: z.iso.date(),
  bounceReason: z.string().max(200).optional(),
  bankCharge: z.number().min(0).max(10_000).default(0),
  /** Why the instrument was handed back or voided — for `return` and `cancel`. */
  reason: z.string().max(200).optional(),
  /** For `replace`: the new cheque handed over by the tenant. */
  replacement: z
    .object({
      chequeNumber: z.string().min(1).max(40),
      bankName: z.string().max(120).optional(),
      chequeDate: z.iso.date(),
      amount: z.number().positive().max(100_000_000),
    })
    .optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Move a post-dated cheque through its lifecycle.
 *
 * `clear` is the one that touches money: it creates a real payment allocated
 * across the invoices for the period the cheque covers, so the accrual ledger
 * and the physical instrument stay reconciled.
 *
 * `return` and `cancel` exist because `cheque_status` declares `returned` and
 * `cancelled` and nothing used to reach them. They are implemented rather than
 * dropped from the enum: both are real events in a UAE PDC portfolio — a
 * tenant who settles early or ends a lease takes the unbanked cheques back,
 * and a cheque captured with the wrong number or amount has to be voided
 * without pretending it bounced. Dropping them would need a migration *and*
 * would leave the operator with no honest way to record either, forcing the
 * lie. Neither touches money: an unbanked instrument was never a receipt, and
 * the invoices it was written against stay exactly as open as they were.
 */
export async function transitionCheque(ctx: ServiceContext, raw: unknown) {
  const input = chequeTransitionInput.parse(raw);
  requirePermission(ctx, "payment:create");

  return withIdempotency(ctx, input.idempotencyKey, "transitionCheque", async () => {
    const rows = await ctx.tx.execute<{
      id: string; status: string; amount: string; business_unit_id: string;
      party_id: string | null; lease_id: string | null; cheque_number: string;
      period_start: string | null; period_end: string | null; bank_name: string | null;
    }>(sql`
      SELECT id, status::text, amount, business_unit_id, party_id, lease_id,
             cheque_number, period_start::text, period_end::text, bank_name
        FROM cheques WHERE id = ${input.chequeId}::uuid FOR UPDATE
    `);
    const cheque = rows[0];
    if (!cheque) throw new ServiceError("Cheque not found.", "not_found");
    requireBusinessUnit(ctx, cheque.business_unit_id);

    // Guard the state machine explicitly. Clearing an already-cleared cheque
    // would double-count the receipt.
    //
    // `cleared` appears in no source list, so a cleared cheque is terminal.
    // That is deliberate and it is *parked*, not settled: whether a cleared UAE
    // cheque can later be returned by the bank is open question Q-5 with the
    // group's bank, and PRD B7 records the state as unreachable until it is
    // answered. Do not add `cleared` to `bounce` (or to any list) to "tidy up"
    // the gap — reversing a cleared cheque has to unwind the payment, its
    // allocations and its journal, and none of that can be designed before the
    // bank says whether the case exists.
    const allowed: Record<string, string[]> = {
      deposit: ["held"],
      clear: ["held", "deposited"],
      bounce: ["deposited", "held"],
      // From `bounced` this is the replacement chain. From `held` it is a
      // renegotiation, which the `replaced` enum comment has always described
      // but the guard refused — leaving a re-signed tenancy with no way to swap
      // the old cheques out except by falsely bouncing them first.
      replace: ["bounced", "held"],
      // Only from `held`: once an instrument is with the bank the drawer cannot
      // be handed it back, and a bounced cheque is kept as evidence of the debt.
      return: ["held"],
      cancel: ["held"],
    };
    if (!allowed[input.action]!.includes(cheque.status)) {
      throw new ServiceError(
        `Cannot ${input.action} a cheque that is "${cheque.status}".`,
        "conflict",
      );
    }

    const chequeAmount = M.fromDb(cheque.amount);

    if (input.action === "deposit") {
      await ctx.tx.execute(sql`
        UPDATE cheques SET status = 'deposited', deposited_on = ${input.onDate}::date,
                           custody_location = ${cheque.bank_name}, updated_at = now()
         WHERE id = ${cheque.id}::uuid
      `);
    }

    if (input.action === "clear") {
      // Settle the invoices this cheque was written to cover.
      const covered = cheque.lease_id
        ? await ctx.tx.execute<{ id: string; amount_due: string }>(sql`
            SELECT d.id, d.amount_due
              FROM documents d
              JOIN document_lines dl ON dl.document_id = d.id
             WHERE dl.lease_id = ${cheque.lease_id}::uuid
               AND d.amount_due > 0
               AND (${cheque.period_start}::date IS NULL
                    OR dl.period_start >= ${cheque.period_start}::date)
               AND (${cheque.period_end}::date IS NULL
                    OR dl.period_start < ${cheque.period_end}::date)
             GROUP BY d.id, d.amount_due
             ORDER BY d.issue_date
          `)
        : [];

      let remaining = chequeAmount;
      const allocations: { documentId: string; amount: number }[] = [];
      for (const doc of covered) {
        if (!M.gt(remaining, M.ZERO)) break;
        const take = M.min(remaining, M.fromDb(doc.amount_due));
        // recordPayment's input schema is numbers at the API boundary; it
        // re-enters Money immediately on the other side.
        allocations.push({ documentId: doc.id, amount: M.toNumber(take) });
        remaining = M.sub(remaining, take);
      }

      const result = await recordPayment(ctx, {
        businessUnitId: cheque.business_unit_id,
        partyId: cheque.party_id,
        amount: M.toNumber(chequeAmount),
        method: "cheque",
        receivedOn: input.onDate,
        reference: `Cheque ${cheque.cheque_number} cleared`,
        allocations,
        autoAllocate: allocations.length === 0,
      });

      await ctx.tx.execute(sql`
        UPDATE cheques
           SET status = 'cleared', cleared_on = ${input.onDate}::date,
               payment_id = ${result.paymentId}::uuid, updated_at = now()
         WHERE id = ${cheque.id}::uuid
      `);
    }

    if (input.action === "bounce") {
      await ctx.tx.execute(sql`
        UPDATE cheques
           SET status = 'bounced', bounced_on = ${input.onDate}::date,
               bounce_reason = ${input.bounceReason ?? "Returned unpaid"},
               bank_charge_amount = ${M.toDb(M.money(input.bankCharge))}, updated_at = now()
         WHERE id = ${cheque.id}::uuid
      `);
      if (input.bankCharge > 0) {
        await postJournal(ctx, {
          postingDate: input.onDate,
          source: "manual",
          sourceTable: "cheques",
          sourceId: cheque.id,
          narration: `Returned cheque charge — ${cheque.cheque_number}`,
          legs: [
            { accountKey: "CHEQUE_CHARGES", businessUnitId: cheque.business_unit_id,
              debit: input.bankCharge },
            { accountKey: "BANK", businessUnitId: cheque.business_unit_id,
              credit: input.bankCharge },
          ],
        });
      }
    }

    if (input.action === "replace") {
      if (!input.replacement) {
        throw new ServiceError("A replacement cheque is required.", "invalid");
      }
      // Swapping the instrument does not shrink the obligation behind it, so a
      // replacement may not be worth less than the cheque it replaces. Without
      // this a bounced AED 30,000 cheque could be replaced by an AED 300 one
      // and the cheque register would show the period as covered. Larger is
      // allowed and safe: the tenant rolling the bank charge or an arrears
      // catch-up into the new cheque is normal, and on `clear` the excess is
      // routed to CUSTOMER_ADVANCE rather than over-allocated. A genuinely
      // *reduced* obligation is a lease amendment, not an instrument swap —
      // cancel the old schedule and issue a new one.
      const replacementAmount = M.money(input.replacement.amount);
      if (M.lt(replacementAmount, chequeAmount)) {
        throw new ServiceError(
          `A replacement cheque must cover at least ${M.toDisplay(chequeAmount)} — ` +
            `${M.toDisplay(replacementAmount)} would leave the period short.`,
          "invalid",
        );
      }
      await ctx.tx.execute(sql`
        INSERT INTO cheques
          (id, tenant_id, business_unit_id, direction, party_id, lease_id, cheque_number,
           bank_name, cheque_date, amount, currency, status, period_start, period_end,
           received_on, replaces_cheque_id, custody_location)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${cheque.business_unit_id}::uuid, 'in',
           ${cheque.party_id}::uuid, ${cheque.lease_id}::uuid, ${input.replacement.chequeNumber},
           ${input.replacement.bankName ?? cheque.bank_name},
           ${input.replacement.chequeDate}::date, ${M.toDb(replacementAmount)},
           ${ctx.baseCurrency}, 'held', ${cheque.period_start}::date, ${cheque.period_end}::date,
           ${input.onDate}::date, ${cheque.id}::uuid, 'Head office safe')
      `);
      await ctx.tx.execute(sql`
        UPDATE cheques SET status = 'replaced', updated_at = now()
         WHERE id = ${cheque.id}::uuid
      `);
    }

    if (input.action === "return" || input.action === "cancel") {
      // Both are terminal and neither posts: the cheque never reached the bank,
      // so there is nothing to reverse. What must survive is *why* and *when*,
      // and the table has no `returned_on`/`cancelled_on` column — adding one
      // would be a migration for a field only ever read as prose. So the date
      // and reason go into `notes` (appended, never overwriting an existing
      // note) and the structured record lives in the audit row below.
      const status = input.action === "return" ? "returned" : "cancelled";
      const note = input.action === "return"
        ? `Returned to the drawer on ${input.onDate}`
        : `Cancelled on ${input.onDate}`;
      await ctx.tx.execute(sql`
        UPDATE cheques
           SET status = ${status}::cheque_status,
               notes = concat_ws(E'\n', nullif(notes, ''),
                                 ${input.reason ? `${note} — ${input.reason}` : `${note}.`}::text),
               -- The instrument leaves our custody on a return; on a cancel it
               -- is void wherever it physically is.
               custody_location = CASE WHEN ${input.action}::text = 'return'
                 THEN 'Returned to drawer' ELSE custody_location END,
               updated_at = now()
         WHERE id = ${cheque.id}::uuid
      `);
    }

    await writeAudit(ctx, {
      action: `cheque.${input.action}`,
      entityTable: "cheques",
      entityId: cheque.id,
      businessUnitId: cheque.business_unit_id,
      diff: { from: cheque.status, chequeNumber: cheque.cheque_number,
              amount: M.toDb(chequeAmount), ...input },
    });

    return { chequeId: cheque.id, action: input.action };
  });
}
