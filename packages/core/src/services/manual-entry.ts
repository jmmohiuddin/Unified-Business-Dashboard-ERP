import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import { can } from "../rbac.ts";
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
import { recordPayment } from "./payments.ts";
import { payBill } from "./purchasing.ts";

/**
 * MANUAL AND CASH ENTRY — the adoption gate.
 *
 * Before this file the product had fifteen write actions and not one of them
 * could record cash. Rent collected in a lobby, a plumber paid from a pocket,
 * the owner taking money out of the till on a Thursday — none of it was
 * recordable, so all of it lived in a spreadsheet, and the MVP gate ("zero
 * money movements outside the system") was unreachable by construction. A
 * ledger that cannot accept the transactions its users actually make is not
 * adopted; it is worked around.
 *
 * THE DESIGN PRINCIPLE, from PRD §7.1: *the user describes what happened; the
 * system decides what to debit.* No function here takes an account from a
 * non-accountant. Each entry object maps to one fixed journal shape (ADR-005),
 * so the caller chooses between "received cash" and "paid cash", not between
 * 1100 and 5600. `postManualJournal` is the single exception and it is gated on
 * a permission only the accountant and the owner hold.
 *
 * The shapes, stated once (ADR-005 §"The journal shapes"):
 *
 *   Cash receipt, allocated     DR cash-in-hand        CR accounts receivable
 *   Cash receipt, unallocated   DR cash-in-hand        CR revenue + output VAT
 *   Cash payment, expense       DR expense (+input VAT) CR cash-in-hand
 *   Cash payment, exempt BU     DR expense incl. VAT   CR cash-in-hand
 *   Cash payment, against a bill DR accounts payable   CR cash-in-hand
 *   Owner contribution          DR cash or bank        CR owner capital
 *   Owner drawing               DR owner drawings      CR cash or bank
 *
 * Everything posts through `postJournal`, so period locks, the exact balance
 * gate, atomic journal numbering and the deferred balance trigger all apply
 * unchanged. Everything that a user could double-tap is wrapped in
 * `withIdempotency` — a cashier on a basement connection pressing "Record"
 * twice is the expected case here, not the edge case.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It never edits and never deletes.
 * A wrong entry is corrected by `reverseEntry`, which posts the mirror image
 * and links the two, following the credit-note precedent. Both remain visible.
 * That is FR-M09, and it is the reason `journals.reverses_journal_id` and
 * `journals.is_reversed` exist in the schema.
 */

// ── Tenant-configurable thresholds ──────────────────────────────────────────

/**
 * Defaults for the settings this module reads out of `tenants.settings`.
 *
 * Two of these sit on open questions the PRD refuses to let anyone guess —
 * Q-10 (owner-ledger staleness and materiality) and Q-11 (cash variance) — so
 * they are configuration with a stated default rather than a constant somebody
 * has to go and find. When the owner answers, the answer is a settings write,
 * not a code change and a deploy.
 *
 *  • `cashFloorAed` — the balance a cash point may not be taken below. Zero,
 *    because a physical till holding minus AED 200 is not a policy choice, it
 *    is a transaction that did not happen the way it was described. Raising it
 *    turns it into an imprest floor ("never go below the AED 500 float").
 *  • `ownerLedgerStaleDays` — 90. A director's-loan balance that has not moved
 *    in a quarter is the pattern the research describes: it sits unexamined
 *    for years, and no running total makes that visible without a clock.
 *  • `ownerLedgerMaterialityAed` — 50,000. Below this a net drawn balance is
 *    the owner's normal float; above it, it is a balance the accountant needs
 *    to see before the year end. Both figures are Q-10 and both are a placeholder
 *    for an answer, which is precisely why they are configurable.
 */
export const MANUAL_ENTRY_DEFAULTS = {
  cashFloorAed: "0",
  ownerLedgerStaleDays: 90,
  ownerLedgerMaterialityAed: "50000",
} as const;

interface ManualEntrySettings {
  cashFloor: M.Money;
  ownerLedgerStaleDays: number;
  ownerLedgerMateriality: M.Money;
}

/**
 * Read the tenant's thresholds.
 *
 * Anything missing, malformed or of the wrong type falls back to the default
 * above rather than throwing: a typo in a settings blob must not make cash
 * unrecordable, which would reintroduce the exact failure this module exists
 * to remove.
 */
async function readSettings(ctx: ServiceContext): Promise<ManualEntrySettings> {
  const [row] = await ctx.tx.execute<{ settings: Record<string, unknown> | null }>(sql`
    SELECT settings FROM tenants WHERE id = ${ctx.tenantId}::uuid
  `);
  const block = (row?.settings?.manualEntry ?? {}) as Record<string, unknown>;

  const asMoney = (value: unknown, fallback: string): M.Money => {
    if (typeof value !== "string" && typeof value !== "number") return M.money(fallback);
    try {
      const parsed = M.money(value);
      return parsed.isFinite() && !M.isNegative(parsed) ? parsed : M.money(fallback);
    } catch {
      return M.money(fallback);
    }
  };
  const days = Number(block.ownerLedgerStaleDays); // money-guard-ignore: a day count is an interval, not an amount.

  return {
    cashFloor: asMoney(block.cashFloorAed, MANUAL_ENTRY_DEFAULTS.cashFloorAed),
    ownerLedgerStaleDays:
      Number.isInteger(days) && days > 0 ? days : MANUAL_ENTRY_DEFAULTS.ownerLedgerStaleDays,
    ownerLedgerMateriality: asMoney(
      block.ownerLedgerMaterialityAed,
      MANUAL_ENTRY_DEFAULTS.ownerLedgerMaterialityAed,
    ),
  };
}

// ── Plain-language categories ───────────────────────────────────────────────

/**
 * What money came in FOR, in the words the person holding it would use.
 *
 * Each reason fixes both the revenue account and the VAT treatment, which is
 * what lets the screen ask one question instead of two and still produce a
 * correct VAT201. The tax code is the treatment's source of truth — `tax_codes`
 * carries both the rate and `input_recoverable`, and the whole UAE localisation
 * turns on treatment rather than rate: exempt and zero-rated are both 0% and
 * behave oppositely.
 *
 * `rent_home` is the one that matters most. Residential rent is EXEMPT under
 * UAE VAT law, so a cash rent receipt must not carry output VAT and must land
 * in 4300 where the return's exempt-supplies box and the input-recovery ratio
 * can both find it. Booking it as service revenue at 5% overstates output VAT
 * on every flat, every month.
 *
 * `other` defaults to standard-rated on purpose. Where the treatment is not
 * known the safe direction is to CHARGE output VAT: under-declaring it is an
 * assessment with penalties, over-declaring it is a correction.
 */
const RECEIPT_REASONS = {
  rent_home: { label: "Rent — a flat or villa", accountKey: "REV_RENT", taxCode: "EXEMPT" },
  rent_shop: {
    label: "Rent — a shop or office",
    accountKey: "REV_RENT_COMMERCIAL",
    taxCode: "VAT5",
  },
  parking: { label: "Parking", accountKey: "REV_PARKING", taxCode: "PARKING" },
  service: { label: "A job or service", accountKey: "REV_SERVICE", taxCode: "VAT5" },
  sale: { label: "Something sold", accountKey: "REV_PRODUCT", taxCode: "VAT5" },
  contract: { label: "A contract", accountKey: "REV_CONTRACT", taxCode: "VAT5" },
  other: { label: "Something else", accountKey: "REV_OTHER", taxCode: "VAT5" },
} as const;

export type ReceiptReason = keyof typeof RECEIPT_REASONS;

/**
 * What money went OUT for. Expense accounts only — a payment that settles a
 * supplier bill takes the `supplierId` path instead and debits payables, which
 * is a different journal shape and a different question on screen.
 */
const PAYMENT_CATEGORIES = {
  repairs: { label: "Repairs and maintenance", accountKey: "REPAIRS" },
  materials: { label: "Materials and parts", accountKey: "MATERIALS" },
  subcontractor: { label: "Someone we hired for a job", accountKey: "SUBCONTRACTOR" },
  utilities: { label: "DEWA, water, internet", accountKey: "UTILITIES" },
  transport: { label: "Fuel, Salik, taxi", accountKey: "TRANSPORT" },
  premises: { label: "Rent for our own premises", accountKey: "RENT_EXPENSE" },
  marketing: { label: "Advertising", accountKey: "MARKETING" },
  professional: { label: "Lawyer, accountant, typing centre", accountKey: "PROFESSIONAL" },
  licence: { label: "Trade licence and government fees", accountKey: "LICENSE_FEES" },
  visa: { label: "Visa, labour card, medical", accountKey: "VISA_COSTS" },
  wages: { label: "Wages paid in cash", accountKey: "SALARY" },
  bank: { label: "Bank charges", accountKey: "BANK_CHARGES" },
  other: { label: "Something else", accountKey: "OTHER_EXPENSE" },
} as const;

export type PaymentCategory = keyof typeof PAYMENT_CATEGORIES;

/** The chooser lists, so a screen never hard-codes a copy of them. */
export const receiptReasons = (): { key: ReceiptReason; label: string }[] =>
  (Object.keys(RECEIPT_REASONS) as ReceiptReason[]).map((key) => ({
    key,
    label: RECEIPT_REASONS[key].label,
  }));

export const paymentCategories = (): { key: PaymentCategory; label: string }[] =>
  (Object.keys(PAYMENT_CATEGORIES) as PaymentCategory[]).map((key) => ({
    key,
    label: PAYMENT_CATEGORIES[key].label,
  }));

// ── Shared guards ───────────────────────────────────────────────────────────

/**
 * Refuse a closed period, and say who closed it.
 *
 * `postJournal` already calls `assertPeriodOpen`, and that check stays as the
 * backstop for every posting path in the product. This one runs FIRST and
 * exists purely for the message: FR-M08 requires the refusal to name the period
 * and the person, and WF-05 §3.7 specifies the wording the cash screens show
 * before the form even renders — "July is closed. Choose a date in August, or
 * ask Priya to reopen July." A cashier told only "period closed" has no idea
 * whether to change the date or find a human.
 */
export async function assertPeriodOpenNamed(
  ctx: ServiceContext,
  postingDate: string,
): Promise<void> {
  const [period] = await ctx.tx.execute<{
    label: string;
    status: string;
    closed_by: string | null;
    closed_on: string | null;
  }>(sql`
    SELECT fp.label, fp.status::text, u.full_name AS closed_by,
           to_char(fp.closed_at, 'DD Mon YYYY') AS closed_on
      FROM fiscal_periods fp
      LEFT JOIN users u ON u.id = fp.closed_by_user_id
     WHERE ${postingDate}::date BETWEEN fp.starts_on AND fp.ends_on
     LIMIT 1
  `);
  if (!period || period.status !== "closed") return;

  const who = period.closed_by
    ? `${period.closed_by} closed it${period.closed_on ? ` on ${period.closed_on}` : ""}`
    : "It was closed";
  throw new ServiceError(
    `${period.label} is closed. ${who}. Choose a date in an open period, or ask for ${period.label} to be reopened.`,
    "period_closed",
  );
}

/**
 * Which ledger account a cash point's money lives in.
 *
 * A "cash point" is a `cash_registers` row — the salon till, the parking kiosk,
 * the owner's pocket float — and the row already carries the account its cash
 * belongs to. Resolving through `system_key` rather than posting to
 * `account_id` directly is what keeps `postJournal` the only posting path:
 * every leg in the product is named by system key, and a second addressing
 * scheme would be a second place for a posting to go wrong.
 *
 * The consequence, stated because it will surprise someone: a cash point whose
 * account has no `system_key` cannot be posted to. Today every cash point that
 * exists points at 1100 CASH, so per-cash-point balances are per business unit
 * rather than per till. Giving each till its own account (ADR-005's
 * `cash_in_hand.{cash_point}`) is a chart-of-accounts change that belongs with
 * the cash-session work, not here; this resolves whatever the register names.
 */
async function resolveCashAccount(
  ctx: ServiceContext,
  businessUnitId: string,
  cashPointId: string | null | undefined,
): Promise<{ accountKey: string; label: string; cashPointId: string | null }> {
  if (!cashPointId) return { accountKey: "CASH", label: "Cash in hand", cashPointId: null };

  const [reg] = await ctx.tx.execute<{
    id: string; name: string; business_unit_id: string; system_key: string | null;
  }>(sql`
    SELECT cr.id, cr.name, cr.business_unit_id, a.system_key
      FROM cash_registers cr
      JOIN accounts a ON a.id = cr.account_id
     WHERE cr.id = ${cashPointId}::uuid AND cr.is_active = true AND cr.deleted_at IS NULL
  `);
  if (!reg) throw new ServiceError("That cash point does not exist.", "not_found");
  if (reg.business_unit_id !== businessUnitId) {
    throw new ServiceError(
      `"${reg.name}" belongs to a different business. Cash cannot move between businesses by choosing a different till — record it as a transfer between businesses.`,
      "invalid",
    );
  }
  if (!reg.system_key) {
    throw new ServiceError(
      `"${reg.name}" is not linked to a postable cash account. Ask the accountant to set one.`,
      "invalid",
    );
  }
  return { accountKey: reg.system_key, label: reg.name, cashPointId: reg.id };
}

/**
 * The balance of a cash account for one business, as at a date.
 *
 * As at the POSTING date, not today, because that is the balance the entry
 * being recorded actually acts on. A payment backdated into last week that
 * takes the till below zero on that day is not made acceptable by receipts
 * banked since — the till physically could not have paid out money it did not
 * hold, so the entry is describing something that did not happen.
 */
async function cashBalanceOn(
  ctx: ServiceContext,
  accountKey: string,
  businessUnitId: string,
  onDate: string,
): Promise<M.Money> {
  const [row] = await ctx.tx.execute<{ balance: string }>(sql`
    SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) AS balance
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE a.system_key = ${accountKey}
       AND jl.business_unit_id = ${businessUnitId}::uuid
       AND j.posting_date <= ${onDate}::date
  `);
  return M.fromDb(row?.balance);
}

/**
 * EC-13: a cash point may not be taken below its floor.
 *
 * ENFORCED, not warned about. A warning on a screen is a control the user
 * clicks through in a hurry, and the whole reason a physical cash balance is
 * worth tracking is that it is checkable against the notes in the drawer — a
 * negative till balance means an entry is missing or wrong, and letting it
 * through destroys the only signal that says so.
 *
 * The override exists because refusing outright would also be wrong: a real
 * float genuinely does go untracked for a morning, and an operator who cannot
 * record what happened records it somewhere else. So the escape hatch is
 * deliberately expensive — a written reason AND a permission an ordinary
 * cashier does not hold (`payment:void`, which every role able to undo a money
 * movement already has). Both land in the audit log with the balances either
 * side, so "who authorised the till going negative, and by how much" is a
 * query rather than an interview.
 */
async function assertCashFloor(
  ctx: ServiceContext,
  args: {
    accountKey: string;
    label: string;
    businessUnitId: string;
    onDate: string;
    amount: M.Money;
    overrideReason?: string;
  },
): Promise<{ before: M.Money; after: M.Money; overridden: boolean }> {
  const settings = await readSettings(ctx);
  const before = await cashBalanceOn(ctx, args.accountKey, args.businessUnitId, args.onDate);
  const after = M.sub(before, args.amount);
  if (M.gte(after, settings.cashFloor)) return { before, after, overridden: false };

  const shortfall = M.sub(settings.cashFloor, after);
  const floorNote = M.isZero(settings.cashFloor)
    ? "below zero"
    : `below its floor of ${M.toDisplay(settings.cashFloor)}`;

  if (!args.overrideReason) {
    throw new ServiceError(
      `${args.label} holds ${M.toDisplay(before)} on ${args.onDate}. Paying ${M.toDisplay(args.amount)} would take it ${floorNote}, short by ${M.toDisplay(shortfall)}. Record it anyway only with a reason.`,
      "invalid",
    );
  }
  if (args.overrideReason.trim().length < 10) {
    throw new ServiceError(
      "Say what happened, in a sentence — an override with no explanation is worse than a refusal.",
      "invalid",
    );
  }
  if (!can(ctx.principal, "payment:void")) {
    throw new ServiceError(
      `${args.label} would go ${floorNote}. Only a manager can record that. Ask them, or check whether a receipt is missing.`,
      "forbidden",
    );
  }
  return { before, after, overridden: true };
}

/**
 * Split physical cash into its net and its VAT.
 *
 * Money that changed hands is ALWAYS gross — it cannot be "plus VAT" — so both
 * the receipt and the payment path treat the amount as inclusive whatever
 * `tax_codes.is_inclusive` happens to say about how the price was quoted.
 *
 * The net is quantized and the tax is taken as the REMAINDER rather than
 * computed independently. `gross / 1.05` does not terminate in binary or in
 * decimal, so a separately-rounded `gross × 0.05 / 1.05` produces a pair whose
 * sum is a fils away from the cash in the drawer on a meaningful share of
 * amounts — and that fils would go into the journal, where it has to balance
 * against a cash leg that is exact. `sales.ts` makes the same choice for the
 * same reason; the property is `net + vat === gross`, for every input.
 */
export function splitVatInclusive(
  gross: M.Money,
  rate: M.Money,
): { net: M.Money; vat: M.Money } {
  if (M.isZero(rate)) return { net: gross, vat: M.ZERO };
  const net = M.quantize(M.div(gross, M.add(M.money(1), rate)));
  return { net, vat: M.sub(gross, net) };
}

/** Business unit code + name, used for numbering and for readable narrations. */
async function loadBusinessUnit(
  ctx: ServiceContext,
  businessUnitId: string,
): Promise<{ code: string; name: string }> {
  const [bu] = await ctx.tx.execute<{ code: string; name: string }>(sql`
    SELECT code, name FROM business_units WHERE id = ${businessUnitId}::uuid
  `);
  if (!bu) throw new ServiceError("Business not found.", "not_found");
  return bu;
}

// ── FR-M01 · Cash receipt ───────────────────────────────────────────────────

export const cashReceiptInput = z.object({
  businessUnitId: z.uuid(),
  amount: z.number().positive().max(100_000_000),
  receivedOn: z.iso.date(),
  /** Which till the notes went into. Null = the business's general cash account. */
  cashPointId: z.uuid().nullable().optional(),
  /** Who handed it over. Optional — most counter cash has no named payer. */
  partyId: z.uuid().nullable().optional(),
  /**
   * Settling an existing invoice. When present the receipt is a PAYMENT and the
   * reason below is irrelevant: the supply was already invoiced, VAT was
   * already declared, and crediting revenue again would double-count it.
   */
  invoiceId: z.uuid().nullable().optional(),
  /** Why the money came in, when it is not settling an invoice. */
  reason: z.enum(Object.keys(RECEIPT_REASONS) as [ReceiptReason, ...ReceiptReason[]]).optional(),
  note: z.string().max(500).optional(),
  /** Reference to a stored photo of the receipt or the counterfoil. */
  attachmentUrl: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface CashReceiptResult {
  paymentId: string;
  paymentNumber: string;
  /** Present only for the unallocated path — the cash-sale document raised. */
  documentId?: string;
  docNumber?: string;
  journalId?: string;
  amount: number;
  vat: number;
  cashPointBalance: number;
  settledInvoices?: { documentId: string; docNumber: string; amount: number; nowPaid: boolean }[];
}

/**
 * FR-M01 — money physically received.
 *
 * Two shapes behind one door, decided by whether an invoice is named.
 *
 * ALLOCATED — this is a payment, so it delegates to `recordPayment` outright.
 * That function is the most safety-critical write in the product: it folds
 * duplicate allocations, refuses over-allocation exactly, updates the document
 * and the customer rollup, and posts DR cash CR receivables. Reimplementing any
 * of that here would be a second set of rounding bugs, which is the exact
 * argument the service layer's own header makes.
 *
 * UNALLOCATED — this is a SUPPLY, not just cash. Raising the receipt document
 * is not bureaucracy: the VAT201's output boxes are built from
 * `document_lines` joined to `tax_codes` (metrics/uae-metrics.ts), so a cash
 * sale posted only to the ledger is a taxable supply the return cannot see, and
 * output VAT would be understated by exactly the cash takings. UAE law requires
 * a tax invoice for a taxable supply in any case. So the entry writes a
 * `RCT-…` document with one line carrying the tax code, a payment settling it
 * in full, and ONE journal for both halves: DR cash, CR revenue, CR output VAT.
 * There is no receivable in between because the supply and the settlement are
 * the same instant.
 *
 * The amount is always treated as VAT-INCLUSIVE, whatever `is_inclusive` says
 * on the tax code. Physical cash is what the customer handed over; it cannot be
 * "plus VAT". Backing the net out and taking the tax as the remainder makes
 * net + tax equal the cash exactly, which is what the receipt has to show.
 */
export async function recordCashReceipt(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CashReceiptResult> {
  const input = cashReceiptInput.parse(raw);
  requirePermission(ctx, "payment:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "recordCashReceipt", async () => {
    await assertPeriodOpenNamed(ctx, input.receivedOn);
    const bu = await loadBusinessUnit(ctx, input.businessUnitId);
    const cash = await resolveCashAccount(ctx, input.businessUnitId, input.cashPointId);
    const amount = M.money(input.amount);
    const balanceBefore = await cashBalanceOn(
      ctx, cash.accountKey, input.businessUnitId, input.receivedOn,
    );

    // ── Settling an invoice: it is a payment, and `recordPayment` owns that ──
    if (input.invoiceId) {
      const paid = await recordPayment(ctx, {
        businessUnitId: input.businessUnitId,
        partyId: input.partyId ?? null,
        amount: input.amount,
        method: "cash",
        receivedOn: input.receivedOn,
        reference: input.note?.slice(0, 100),
        allocations: [{ documentId: input.invoiceId, amount: input.amount }],
        autoAllocate: false,
        note: input.note,
      });
      await writeAudit(ctx, {
        action: "cash_receipt.record",
        entityTable: "payments",
        entityId: paid.paymentId,
        businessUnitId: input.businessUnitId,
        diff: {
          before: { cashPoint: cash.label, balance: M.toDb(balanceBefore) },
          after: { balance: M.toDb(M.add(balanceBefore, amount)) },
          amount: M.toDb(amount),
          settles: paid.settledInvoices.map((s) => s.docNumber),
          attachmentUrl: input.attachmentUrl ?? null,
        },
      });
      return {
        paymentId: paid.paymentId,
        paymentNumber: paid.paymentNumber,
        amount: M.toNumber(amount),
        vat: 0,
        cashPointBalance: M.toNumber(M.add(balanceBefore, amount)),
        settledInvoices: paid.settledInvoices,
      };
    }

    // ── A cash sale: raise the receipt document, then post it ───────────────
    const reason = RECEIPT_REASONS[input.reason ?? "other"];
    const [taxCode] = await ctx.tx.execute<{ id: string; rate: string; treatment: string }>(sql`
      SELECT id, rate, treatment::text FROM tax_codes
       WHERE code = ${reason.taxCode} AND is_active = true
    `);
    if (!taxCode) {
      throw new ServiceError(`Tax code "${reason.taxCode}" is not configured.`, "invalid");
    }

    const { net, vat } = splitVatInclusive(amount, M.fromDb(taxCode.rate));

    let partyName: string | null = null;
    if (input.partyId) {
      const [p] = await ctx.tx.execute<{ display_name: string }>(sql`
        SELECT display_name FROM parties WHERE id = ${input.partyId}::uuid
      `);
      if (!p) throw new ServiceError("That person is not in the address book.", "not_found");
      partyName = p.display_name;
    }

    const docNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "cash_receipt", `RCT-${bu.code}`,
    );
    const [doc] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO documents
        (id, tenant_id, business_unit_id, doc_type, doc_number, status, direction,
         party_id, party_name_snapshot, issue_date, due_date, days_overdue, currency,
         subtotal, tax_total, total, amount_paid, amount_due, base_total, cost_total,
         posted_at, notes)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         'invoice', ${docNumber}, 'paid', 'in',
         ${input.partyId ?? null}::uuid, ${partyName}, ${input.receivedOn}::date,
         ${input.receivedOn}::date, 0, ${ctx.baseCurrency},
         ${M.toDb(net)}, ${M.toDb(vat)}, ${M.toDb(amount)},
         ${M.toDb(amount)}, '0', ${M.toDb(amount)}, '0',
         now(), ${input.note ?? null})
      RETURNING id
    `);

    await ctx.tx.execute(sql`
      INSERT INTO document_lines
        (id, tenant_id, document_id, line_no, description,
         quantity, unit_price, tax_code_id, tax_rate, tax_amount, line_total)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${doc.id}::uuid, 1,
         ${reason.label}, '1', ${M.toDb(net)}, ${taxCode.id}::uuid,
         ${taxCode.rate}, ${M.toDb(vat)}, ${M.toDb(amount)})
    `);

    const paymentNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "payment", `PAY-${bu.code}`,
    );
    const [pay] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payments
        (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
         amount, currency, base_amount, unallocated_amount, received_on, reference,
         received_by_user_id, posted_at, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${paymentNumber}, 'in', ${input.partyId ?? null}::uuid, 'cash',
         ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)},
         '0', ${input.receivedOn}::date, ${docNumber},
         ${ctx.principal.userId}::uuid, now(), ${input.note ?? null})
      RETURNING id
    `);
    await ctx.tx.execute(sql`
      INSERT INTO payment_allocations (id, tenant_id, payment_id, document_id, amount)
      VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${pay.id}::uuid,
              ${doc.id}::uuid, ${M.toDb(amount)})
    `);

    const journalId = await postJournal(ctx, {
      postingDate: input.receivedOn,
      // `manual`, not `invoice`, even though this credits revenue. The source
      // names the subsystem that posted the journal, and `source_table` already
      // says `payments`; calling it an invoice would both contradict that and
      // route `reverseEntry` into the credit-note advice, which is no help at
      // all for a receipt no credit note can be raised against.
      source: "manual",
      sourceTable: "payments",
      sourceId: pay.id,
      narration: `Cash received ${docNumber} — ${reason.label}`,
      legs: [
        { accountKey: cash.accountKey, businessUnitId: input.businessUnitId, debit: amount },
        {
          accountKey: reason.accountKey,
          businessUnitId: input.businessUnitId,
          credit: net,
          partyId: input.partyId ?? null,
        },
        ...(M.gt(vat, M.ZERO)
          ? [{ accountKey: "VAT_OUTPUT", businessUnitId: input.businessUnitId, credit: vat }]
          : []),
      ],
    });

    await writeAudit(ctx, {
      action: "cash_receipt.record",
      entityTable: "payments",
      entityId: pay.id,
      businessUnitId: input.businessUnitId,
      diff: {
        before: { cashPoint: cash.label, balance: M.toDb(balanceBefore) },
        after: { balance: M.toDb(M.add(balanceBefore, amount)) },
        docNumber,
        paymentNumber,
        reason: input.reason ?? "other",
        net: M.toDb(net),
        vat: M.toDb(vat),
        vatTreatment: taxCode.treatment,
        attachmentUrl: input.attachmentUrl ?? null,
      },
    });

    return {
      paymentId: pay.id,
      paymentNumber,
      documentId: doc.id,
      docNumber,
      journalId,
      amount: M.toNumber(amount),
      vat: M.toNumber(vat),
      cashPointBalance: M.toNumber(M.add(balanceBefore, amount)),
    };
  });
}

// ── FR-M02 · Cash payment ───────────────────────────────────────────────────

export const cashPaymentInput = z.object({
  businessUnitId: z.uuid(),
  amount: z.number().positive().max(100_000_000),
  paidOn: z.iso.date(),
  cashPointId: z.uuid().nullable().optional(),
  /** What it was for. Ignored when the payment settles a supplier bill. */
  category: z
    .enum(Object.keys(PAYMENT_CATEGORIES) as [PaymentCategory, ...PaymentCategory[]])
    .optional(),
  /** Paying a supplier down rather than booking a fresh expense. */
  supplierId: z.uuid().nullable().optional(),
  billId: z.uuid().nullable().optional(),
  /**
   * The supply this cost SERVES, as a `tax_codes` code — the same input
   * `receiveBill` takes, and the same meaning: not the code the supplier
   * charged under, but what the money was spent on. Omitted means no tax
   * invoice was obtained, so nothing is reclaimed. See the docblock below.
   */
  servesTaxCode: z.string().min(1).max(30).optional(),
  note: z.string().max(500).optional(),
  attachmentUrl: z.string().max(500).optional(),
  /** EC-13 escape hatch. Requires `payment:void` and a real sentence. */
  overrideReason: z.string().max(300).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface CashPaymentResult {
  paymentId: string;
  paymentNumber: string;
  journalId?: string;
  amount: number;
  /** Input VAT reclaimed. Zero whenever the cost serves an exempt supply. */
  recoverableVat: number;
  cashPointBalance: number;
  belowFloor: boolean;
}

/**
 * FR-M02 — money physically paid out.
 *
 * INPUT VAT, and why the default is to reclaim nothing.
 *
 * The rule that governs this is the most important one in the UAE
 * localisation: input VAT on a cost serving EXEMPT supplies — residential rent
 * — is an expense, not a reclaim. `receiveBill` implements it by attribution
 * (`recoverable` / `residual` / `irrecoverable`), and ADR-005 says that rule
 * must be shared code rather than reimplemented here. It is: the decision is
 * read from `tax_codes.input_recoverable`, the same column and the same flag
 * `resolveDeclaredAttributions` reads, addressed by the same `servesTaxCode`
 * input under the same name.
 *
 * What is NOT shared is the fallback when the caller declares nothing.
 * `receiveBill` measures the business unit's trailing-year supply mix, and that
 * function is module-private to purchasing.ts, which this wave may not edit.
 * Rather than copy fifteen lines of SQL and let the two drift — the drift being
 * a wrong VAT return — an undeclared cash payment reclaims NOTHING and expenses
 * the full amount. That is the safe direction: it never over-claims, which is
 * the position the FTA assesses. It does forgo recovery a taxable business is
 * entitled to, which is why the screens ask, and why the report asks the
 * coordinator to export `deriveAttributionFromSupplyMix` so this default can
 * become the measured one.
 *
 * The two shapes, from ADR-005:
 *   recoverable      DR expense (net) + DR 1600 input VAT   CR cash
 *   anything else    DR expense (gross, VAT inside it)      CR cash
 *
 * The second row is the ADR's own wording — "expense account inclusive of
 * irrecoverable VAT" — and it is deliberately simpler than `receiveBill`, which
 * splits 5720 out on a bill because a bill has a supplier, a tax invoice and a
 * VAT amount printed on it. A cash payment from a pocket has none of those.
 */
export async function recordCashPayment(
  ctx: ServiceContext,
  raw: unknown,
): Promise<CashPaymentResult> {
  const input = cashPaymentInput.parse(raw);
  requirePermission(ctx, "payment:create");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "recordCashPayment", async () => {
    await assertPeriodOpenNamed(ctx, input.paidOn);
    const bu = await loadBusinessUnit(ctx, input.businessUnitId);
    const cash = await resolveCashAccount(ctx, input.businessUnitId, input.cashPointId);
    const amount = M.money(input.amount);

    // EC-13, before anything is written and before either branch below. A
    // payment that would empty a till it cannot empty is refused whether it is
    // an expense or a supplier settlement.
    const floor = await assertCashFloor(ctx, {
      accountKey: cash.accountKey,
      label: cash.label,
      businessUnitId: input.businessUnitId,
      onDate: input.paidOn,
      amount,
      overrideReason: input.overrideReason,
    });

    // ── Settling a supplier bill: `payBill` owns payables ───────────────────
    if (input.supplierId) {
      const paid = await payBill(ctx, {
        businessUnitId: input.businessUnitId,
        supplierId: input.supplierId,
        amount: input.amount,
        method: "cash",
        paidOn: input.paidOn,
        reference: input.note?.slice(0, 100),
        billId: input.billId ?? null,
      });
      await writeAudit(ctx, {
        action: "cash_payment.record",
        entityTable: "payments",
        entityId: paid.paymentId,
        businessUnitId: input.businessUnitId,
        diff: {
          before: { cashPoint: cash.label, balance: M.toDb(floor.before) },
          after: { balance: M.toDb(floor.after) },
          amount: M.toDb(amount),
          settlesSupplier: input.supplierId,
          overrideReason: floor.overridden ? input.overrideReason : null,
          attachmentUrl: input.attachmentUrl ?? null,
        },
      });
      return {
        paymentId: paid.paymentId,
        paymentNumber: paid.paymentNumber,
        amount: M.toNumber(amount),
        recoverableVat: 0,
        cashPointBalance: M.toNumber(floor.after),
        belowFloor: floor.overridden,
      };
    }

    // ── A fresh expense ─────────────────────────────────────────────────────
    const category = PAYMENT_CATEGORIES[input.category ?? "other"];

    let recoverable = false;
    if (input.servesTaxCode) {
      const [code] = await ctx.tx.execute<{ input_recoverable: boolean; rate: string }>(sql`
        SELECT input_recoverable, rate FROM tax_codes
         WHERE code = ${input.servesTaxCode} AND is_active = true
      `);
      if (!code) {
        throw new ServiceError(`Tax code "${input.servesTaxCode}" is not configured.`, "invalid");
      }
      recoverable = code.input_recoverable && M.gt(M.fromDb(code.rate), M.ZERO);
    }

    // The cash paid is the gross. Where the VAT is recoverable it is backed out
    // of that gross exactly, so expense + VAT equals the notes handed over.
    const [vatCode] = recoverable
      ? await ctx.tx.execute<{ rate: string }>(sql`
          SELECT rate FROM tax_codes WHERE code = ${input.servesTaxCode!} AND is_active = true
        `)
      : [undefined];
    const { net, vat } = splitVatInclusive(amount, vatCode ? M.fromDb(vatCode.rate) : M.ZERO);

    const paymentNumber = await nextDocumentNumber(
      ctx, input.businessUnitId, "payment", `PAYOUT-${bu.code}`,
    );
    const [pay] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payments
        (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
         amount, currency, base_amount, unallocated_amount, received_on, reference,
         received_by_user_id, posted_at, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${paymentNumber}, 'out', NULL, 'cash',
         ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)},
         '0', ${input.paidOn}::date, ${category.label},
         ${ctx.principal.userId}::uuid, now(), ${input.note ?? null})
      RETURNING id
    `);

    const journalId = await postJournal(ctx, {
      postingDate: input.paidOn,
      // See the note on the receipt above: every journal this module posts
      // itself is `manual`, so the whole class is reversible and findable.
      source: "manual",
      sourceTable: "payments",
      sourceId: pay.id,
      narration: `Cash paid ${paymentNumber} — ${category.label}`,
      legs: [
        { accountKey: category.accountKey, businessUnitId: input.businessUnitId, debit: net },
        ...(M.gt(vat, M.ZERO)
          ? [{ accountKey: "VAT_INPUT", businessUnitId: input.businessUnitId, debit: vat }]
          : []),
        { accountKey: cash.accountKey, businessUnitId: input.businessUnitId, credit: amount },
      ],
    });

    await writeAudit(ctx, {
      action: "cash_payment.record",
      entityTable: "payments",
      entityId: pay.id,
      businessUnitId: input.businessUnitId,
      diff: {
        before: { cashPoint: cash.label, balance: M.toDb(floor.before) },
        after: { balance: M.toDb(floor.after) },
        paymentNumber,
        category: input.category ?? "other",
        expense: M.toDb(net),
        recoverableVat: M.toDb(vat),
        servesTaxCode: input.servesTaxCode ?? null,
        overrideReason: floor.overridden ? input.overrideReason : null,
        attachmentUrl: input.attachmentUrl ?? null,
      },
    });

    return {
      paymentId: pay.id,
      paymentNumber,
      journalId,
      amount: M.toNumber(amount),
      recoverableVat: M.toNumber(vat),
      cashPointBalance: M.toNumber(floor.after),
      belowFloor: floor.overridden,
    };
  });
}

// ── FR-M03 / FR-M04 · Owner contribution and drawing ────────────────────────

/**
 * Who may record the owner's own money.
 *
 * `payment:create`, the same permission as any other cash entry, and the choice
 * is deliberate. The tempting alternative is `journal:post` — these are equity
 * entries, only the accountant and the owner hold it — but that would stop the
 * salon manager recording the owner taking AED 5,000 out of the till on a
 * Thursday evening, and an entry a person cannot make is an entry that becomes
 * a WhatsApp message. The shadow spreadsheet is the failure this whole module
 * exists to prevent, and it is a worse one than a mis-posted drawing.
 *
 * The countervailing risk is real: 3200 Owner Drawings is exactly where someone
 * would hide a theft, because it never reaches the P&L. It is mitigated rather
 * than ignored — every entry is audited with actor and before/after balances,
 * and the owner ledger surfaces the running position (`ownerPosition` below).
 * Tightening this is one constant.
 */
const OWNER_ENTRY_PERMISSION = "payment:create";

export const ownerMovementInput = z.object({
  businessUnitId: z.uuid(),
  amount: z.number().positive().max(100_000_000),
  onDate: z.iso.date(),
  /** Where the money moved: a till, or the bank. */
  via: z.enum(["cash", "bank"]).default("cash"),
  cashPointId: z.uuid().nullable().optional(),
  note: z.string().max(500).optional(),
  /** Drawings only: EC-13 applies when the money leaves a till. */
  overrideReason: z.string().max(300).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface OwnerMovementResult {
  paymentId: string;
  paymentNumber: string;
  journalId: string;
  amount: number;
  /** The position AFTER this entry, so the screen can show it without a re-read. */
  position: OwnerPosition;
}

/**
 * FR-M03 — the owner putting money in.
 *
 * DR cash or bank, CR 3100 Owner Capital. It is not revenue and it never
 * appears on a P&L: the profit-and-loss view reads accounts of type
 * `income`/`expense` only, and capital is equity, so the exclusion is
 * structural rather than a filter someone has to remember.
 */
export async function recordOwnerContribution(
  ctx: ServiceContext,
  raw: unknown,
): Promise<OwnerMovementResult> {
  return ownerMovement(ctx, raw, "in");
}

/**
 * FR-M04 — the owner taking money out.
 *
 * DR 3200 Owner Drawings, CR cash or bank.
 *
 * "This is not an expense. It is your own money." WF-05 §3.3 calls that the
 * single most important sentence in the module, and it is a statement about the
 * LEDGER before it is a statement on a screen: booking personal spending as
 * business expense is the most common reason an owner-operated group's profit
 * figure is wrong, and it always understates profitability. Drawings are equity,
 * so they never touch the P&L — which is why the accountant's answer to "why
 * did my profit not go down when I took 47,000 out" is a real answer instead of
 * an apology.
 */
export async function recordOwnerDrawing(
  ctx: ServiceContext,
  raw: unknown,
): Promise<OwnerMovementResult> {
  return ownerMovement(ctx, raw, "out");
}

async function ownerMovement(
  ctx: ServiceContext,
  raw: unknown,
  direction: "in" | "out",
): Promise<OwnerMovementResult> {
  const input = ownerMovementInput.parse(raw);
  requirePermission(ctx, OWNER_ENTRY_PERMISSION);
  requireBusinessUnit(ctx, input.businessUnitId);

  const operation = direction === "in" ? "recordOwnerContribution" : "recordOwnerDrawing";
  return withIdempotency(ctx, input.idempotencyKey, operation, async () => {
    await assertPeriodOpenNamed(ctx, input.onDate);
    const bu = await loadBusinessUnit(ctx, input.businessUnitId);
    const amount = M.money(input.amount);

    const cash =
      input.via === "cash"
        ? await resolveCashAccount(ctx, input.businessUnitId, input.cashPointId)
        : { accountKey: "BANK", label: "the bank", cashPointId: null };

    // Money leaving a till is subject to EC-13 exactly as an expense payment is
    // — the owner's pocket does not create notes that were not in the drawer.
    let floor: { before: M.Money; after: M.Money; overridden: boolean } | null = null;
    if (direction === "out" && input.via === "cash") {
      floor = await assertCashFloor(ctx, {
        accountKey: cash.accountKey,
        label: cash.label,
        businessUnitId: input.businessUnitId,
        onDate: input.onDate,
        amount,
        overrideReason: input.overrideReason,
      });
    }

    const prefix = direction === "in" ? `CAPIN-${bu.code}` : `DRAW-${bu.code}`;
    const paymentNumber = await nextDocumentNumber(ctx, input.businessUnitId, "payment", prefix);
    const [pay] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payments
        (id, tenant_id, business_unit_id, payment_number, direction, party_id, method,
         amount, currency, base_amount, unallocated_amount, received_on, reference,
         received_by_user_id, posted_at, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${paymentNumber}, ${direction}::payment_direction, NULL,
         ${input.via === "cash" ? "cash" : "bank_transfer"}::payment_method,
         ${M.toDb(amount)}, ${ctx.baseCurrency}, ${M.toDb(amount)},
         '0', ${input.onDate}::date,
         ${direction === "in" ? "Owner contribution" : "Owner drawing"},
         ${ctx.principal.userId}::uuid, now(), ${input.note ?? null})
      RETURNING id
    `);

    const journalId = await postJournal(ctx, {
      postingDate: input.onDate,
      source: "manual",
      sourceTable: "payments",
      sourceId: pay.id,
      narration:
        direction === "in"
          ? `Owner contribution ${paymentNumber} — ${bu.name}`
          : `Owner drawing ${paymentNumber} — ${bu.name}`,
      legs:
        direction === "in"
          ? [
              { accountKey: cash.accountKey, businessUnitId: input.businessUnitId, debit: amount },
              { accountKey: "CAPITAL", businessUnitId: input.businessUnitId, credit: amount },
            ]
          : [
              { accountKey: "DRAWINGS", businessUnitId: input.businessUnitId, debit: amount },
              { accountKey: cash.accountKey, businessUnitId: input.businessUnitId, credit: amount },
            ],
    });

    await writeAudit(ctx, {
      action: direction === "in" ? "owner_contribution.record" : "owner_drawing.record",
      entityTable: "payments",
      entityId: pay.id,
      businessUnitId: input.businessUnitId,
      diff: {
        before: floor ? { cashPoint: cash.label, balance: M.toDb(floor.before) } : null,
        after: floor ? { balance: M.toDb(floor.after) } : null,
        paymentNumber,
        amount: M.toDb(amount),
        via: input.via,
        overrideReason: floor?.overridden ? input.overrideReason : null,
      },
    });

    return {
      paymentId: pay.id,
      paymentNumber,
      journalId,
      amount: M.toNumber(amount),
      position: await ownerPosition(ctx, {
        businessUnitId: input.businessUnitId,
        asOf: input.onDate,
      }),
    };
  });
}

// ── Owner position (read) ───────────────────────────────────────────────────

export interface OwnerPosition {
  /** Money the owner has put in THROUGH the product. Excludes opening capital. */
  contributed: number;
  /** Total taken out. */
  drawn: number;
  /** Positive = the owner has money in the business; negative = drawn out. */
  net: number;
  /**
   * Capital brought forward at go-live, from the `opening` journal.
   *
   * Reported separately rather than folded into `contributed` because they
   * answer different questions. "What have I put into this business" is about
   * movements the owner remembers making; the opening balance is the position
   * the books started from, and including it makes the first day of the ledger
   * look like a AED 4.5m contribution. A caller that wants the balance-sheet
   * equity figure adds the two.
   */
  openingCapital: number;
  contributedThisYear: number;
  drawnThisYear: number;
  lastMovementOn: string | null;
  daysSinceLastMovement: number | null;
  /** Q-10 flags, against the tenant's configured thresholds. */
  isStale: boolean;
  isMaterial: boolean;
  staleAfterDays: number;
  materialityThreshold: number;
}

/**
 * The owner's position with one business, or with the group.
 *
 * FR-M04 requires "a net owner position per business unit … and at group
 * level", and FR-M05 requires the two flags this returns. It reads the ledger
 * rather than a stored total, so it cannot drift: the accounts are 3100 and
 * 3200 and the sign convention is the account's own normal balance.
 *
 * The clock is the part that is easy to leave out and is the whole point. A
 * director's-loan balance sits unexamined for years and a running total makes
 * that invisible — `daysSinceLastMovement` is what turns it into an exception
 * the dashboard can raise. The clock is driven by MOVEMENTS, so the opening
 * journal does not reset it either: a balance that has not moved since go-live
 * is precisely the case the flag is for.
 */
export async function ownerPosition(
  ctx: ServiceContext,
  args: { businessUnitId?: string | null; asOf?: string } = {},
): Promise<OwnerPosition> {
  requirePermission(ctx, "report:read");
  const asOf = args.asOf ?? ctx.today;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const settings = await readSettings(ctx);

  const [row] = await ctx.tx.execute<{
    contributed: string; drawn: string; opening: string;
    contributed_ytd: string; drawn_ytd: string;
    last_movement: string | null; days_since: string | null;
  }>(sql`
    SELECT
      COALESCE(SUM(jl.base_credit - jl.base_debit)
        FILTER (WHERE a.system_key = 'CAPITAL' AND j.source <> 'opening'), 0) AS contributed,
      COALESCE(SUM(jl.base_debit - jl.base_credit)
        FILTER (WHERE a.system_key = 'DRAWINGS' AND j.source <> 'opening'), 0) AS drawn,
      COALESCE(SUM(jl.base_credit - jl.base_debit)
        FILTER (WHERE j.source = 'opening'), 0) AS opening,
      COALESCE(SUM(jl.base_credit - jl.base_debit)
        FILTER (WHERE a.system_key = 'CAPITAL' AND j.source <> 'opening'
                  AND j.posting_date >= ${yearStart}::date), 0) AS contributed_ytd,
      COALESCE(SUM(jl.base_debit - jl.base_credit)
        FILTER (WHERE a.system_key = 'DRAWINGS' AND j.source <> 'opening'
                  AND j.posting_date >= ${yearStart}::date), 0) AS drawn_ytd,
      to_char(MAX(j.posting_date) FILTER (WHERE j.source <> 'opening'), 'YYYY-MM-DD')
        AS last_movement,
      (${asOf}::date - MAX(j.posting_date) FILTER (WHERE j.source <> 'opening'))::text
        AS days_since
    FROM journal_lines jl
    JOIN journals j ON j.id = jl.journal_id
    JOIN accounts a ON a.id = jl.account_id
   WHERE a.system_key IN ('CAPITAL', 'DRAWINGS')
     AND j.posting_date <= ${asOf}::date
     AND (${args.businessUnitId ?? null}::uuid IS NULL
          OR jl.business_unit_id = ${args.businessUnitId ?? null}::uuid)
  `);

  const contributed = M.fromDb(row?.contributed);
  const drawn = M.fromDb(row?.drawn);
  const net = M.sub(contributed, drawn);
  const daysSince = row?.days_since === null || row?.days_since === undefined
    ? null
    : Number(row.days_since); // money-guard-ignore: a day count is an interval, not an amount.

  return {
    contributed: M.toNumber(contributed),
    drawn: M.toNumber(drawn),
    net: M.toNumber(net),
    openingCapital: M.toNumber(M.fromDb(row?.opening)),
    contributedThisYear: M.toNumber(M.fromDb(row?.contributed_ytd)),
    drawnThisYear: M.toNumber(M.fromDb(row?.drawn_ytd)),
    lastMovementOn: row?.last_movement ?? null,
    daysSinceLastMovement: daysSince,
    isStale:
      daysSince !== null &&
      daysSince > settings.ownerLedgerStaleDays &&
      M.gt(M.abs(net), M.ZERO),
    isMaterial: M.gt(M.abs(net), settings.ownerLedgerMateriality) && M.isNegative(net),
    staleAfterDays: settings.ownerLedgerStaleDays,
    materialityThreshold: M.toNumber(settings.ownerLedgerMateriality),
  };
}

// ── FR-M08 · Manual journal ─────────────────────────────────────────────────

export const manualJournalInput = z.object({
  postingDate: z.iso.date(),
  /** Why. Blank is refused — a journal nobody can explain is unauditable. */
  narration: z.string().min(1).max(1000),
  lines: z
    .array(
      z.object({
        accountKey: z.string().min(1).max(40),
        businessUnitId: z.uuid().nullable().optional(),
        debit: z.number().min(0).max(100_000_000).optional(),
        credit: z.number().min(0).max(100_000_000).optional(),
        partyId: z.uuid().nullable().optional(),
        memo: z.string().max(500).optional(),
      }),
    )
    .min(2)
    .max(100),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface ManualJournalResult {
  journalId: string;
  journalNumber: string;
  total: number;
  lines: number;
}

/**
 * FR-M08 — the accountant's unrestricted entry.
 *
 * The sharpest tool in the product, and the only one that can post anything to
 * anywhere. It is gated on `journal:post`, which only the accountant, the owner
 * and the platform admin hold, and it is enforced HERE rather than by not
 * rendering the screen: hiding a button is not authorisation.
 *
 * Four refusals before anything is written:
 *
 *  1. NO BLANK NARRATIVE. Zod rejects it, and the trimmed check below rejects
 *     whitespace, which zod's `min(1)` does not. An entry whose only record is
 *     a pair of account codes is unauditable a month later.
 *  2. NO ZERO-VALUE LINE. A line with neither a debit nor a credit is a typo
 *     that would otherwise post silently.
 *  3. NO LINE THAT IS BOTH. Debit and credit on one line is always a mistake in
 *     an entry form and would net invisibly inside the balance check.
 *  4. IT MUST BALANCE. Checked exactly, at storage precision, before the call
 *     — the acceptance criterion asks for it "in addition to the database
 *     trigger", and it is a better message than a constraint violation at
 *     COMMIT.
 *
 * The journal points at itself as its source. A manual journal has no document
 * behind it; that IS the document, and a dangling `source_id` pointing at a row
 * that never existed would be worse than a self-reference an auditor can follow.
 */
export async function postManualJournal(
  ctx: ServiceContext,
  raw: unknown,
): Promise<ManualJournalResult> {
  const input = manualJournalInput.parse(raw);
  requirePermission(ctx, "journal:post");

  if (input.narration.trim().length === 0) {
    throw new ServiceError("Say what this entry is for. A blank narrative is refused.", "invalid");
  }
  for (const [i, line] of input.lines.entries()) {
    const debit = M.money(line.debit ?? 0);
    const credit = M.money(line.credit ?? 0);
    if (M.isZero(debit) && M.isZero(credit)) {
      throw new ServiceError(`Line ${i + 1} has no amount.`, "invalid");
    }
    if (M.gt(debit, M.ZERO) && M.gt(credit, M.ZERO)) {
      throw new ServiceError(
        `Line ${i + 1} has both a debit and a credit. Split it into two lines.`,
        "invalid",
      );
    }
    if (line.businessUnitId) requireBusinessUnit(ctx, line.businessUnitId);
  }

  const debits = M.quantize(M.sum(input.lines.map((l) => M.money(l.debit ?? 0))));
  const credits = M.quantize(M.sum(input.lines.map((l) => M.money(l.credit ?? 0))));
  if (!M.eq(debits, credits)) {
    const diff = M.abs(M.sub(debits, credits));
    throw new ServiceError(
      `This does not balance. Debits ${M.toDisplay(debits)}, credits ${M.toDisplay(credits)} — a difference of ${M.toDisplay(diff)}.`,
      "invalid",
    );
  }

  return withIdempotency(ctx, input.idempotencyKey, "postManualJournal", async () => {
    await assertPeriodOpenNamed(ctx, input.postingDate);

    const journalId = await postJournal(ctx, {
      postingDate: input.postingDate,
      source: "manual",
      sourceTable: "journals",
      // Corrected to the journal's own id immediately below. postJournal
      // generates the id, so it cannot be known before the insert.
      sourceId: crypto.randomUUID(),
      narration: input.narration.trim(),
      legs: input.lines.map((l) => ({
        accountKey: l.accountKey,
        businessUnitId: l.businessUnitId ?? null,
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
        partyId: l.partyId ?? null,
        memo: l.memo,
      })),
    });

    const [journal] = await ctx.tx.execute<{ journal_number: string }>(sql`
      UPDATE journals SET source_id = id WHERE id = ${journalId}::uuid
      RETURNING journal_number
    `);

    await writeAudit(ctx, {
      action: "manual_journal.post",
      entityTable: "journals",
      entityId: journalId,
      businessUnitId: input.lines.find((l) => l.businessUnitId)?.businessUnitId ?? undefined,
      diff: {
        journalNumber: journal!.journal_number,
        narration: input.narration.trim(),
        total: M.toDb(debits),
        lines: input.lines.map((l) => ({
          account: l.accountKey,
          debit: M.toDb(M.money(l.debit ?? 0)),
          credit: M.toDb(M.money(l.credit ?? 0)),
        })),
      },
    });

    return {
      journalId,
      journalNumber: journal!.journal_number,
      total: M.toNumber(debits),
      lines: input.lines.length,
    };
  });
}

// ── FR-M09 · Correction and reversal ────────────────────────────────────────

export const reverseEntryInput = z.object({
  journalId: z.uuid(),
  reason: z.string().min(1).max(300),
  /**
   * When to book the reversal. Defaults to the original's own date so the two
   * net to nothing in the period that carried the error. A reversal dated into
   * an open period is the right answer only when the original's period is
   * closed — and then it is refused, deliberately, rather than silently moved.
   */
  reversalDate: z.iso.date().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface ReverseEntryResult {
  reversalJournalId: string;
  reversalJournalNumber: string;
  reversedJournalId: string;
  reversedJournalNumber: string;
  amount: number;
  /** Documents whose balance was restored, when the entry was a payment. */
  restoredDocuments: { docNumber: string; amount: number }[];
}

/**
 * Which sources this may reverse, and why the others are refused by name.
 *
 * A journal is only half of most events in this system. Reversing an invoice's
 * journal without touching the invoice leaves the document saying "paid" while
 * the ledger says the revenue never happened — two records of the same fact
 * that disagree, which is worse than the error being corrected. Each excluded
 * source therefore names the path that reverses BOTH halves.
 */
const REVERSIBLE_SOURCES = new Set(["manual", "payment"]);
const REVERSAL_ADVICE: Record<string, string> = {
  invoice: "Credit the invoice instead — a credit note reverses the sale and the VAT together.",
  bill: "Raise a debit note against the bill instead.",
  payroll: "Reverse it from the payroll run, so the payslip and the ledger stay in step.",
  stock: "Adjust the stock instead, so quantities and value move together.",
  depreciation: "Depreciation is reversed by the period-close routine that posted it.",
  opening: "Opening balances are corrected by re-importing, not by a journal.",
  fx_revaluation: "Revaluation is recomputed at the next period end.",
  inter_company: "Settle the transfer instead — both sides have to move symmetrically.",
};

/**
 * FR-M09 — correct by reversing. Never edit, never delete.
 *
 * The precedent is `createCreditNote`: the original stays, the reversal points
 * at it, and an auditor sees both rather than a gap. That principle existed for
 * invoices only; this is the generic form, and it is why
 * `journals.reverses_journal_id` and `journals.is_reversed` are in the schema.
 *
 * `postJournal` does not set those columns — it is the shared posting primitive
 * and has no opinion about reversal — so the link is written here, in the same
 * transaction as the posting it describes. `is_reversed` on the original is
 * what lets every screen mark it, which is the third acceptance criterion.
 *
 * WHEN THE ENTRY IS A PAYMENT the ledger is not the only record. The payment's
 * allocations have to be unwound too, or an invoice stays "paid" while the
 * receivable is back on the balance sheet. So allocations are removed, the
 * documents' paid and due amounts restored, the customer rollup corrected, and
 * the payment marked void. A cash-sale receipt raised by `recordCashReceipt`
 * is voided outright: the supply and the settlement were one journal, so
 * reversing it means the sale did not happen and it must leave the VAT return.
 *
 * REVERSAL INTO A CLOSED PERIOD IS REFUSED, both for the original's period and
 * for the reversal's own date. Backdating a correction into a filed quarter
 * changes a return that has already been submitted.
 */
export async function reverseEntry(
  ctx: ServiceContext,
  raw: unknown,
): Promise<ReverseEntryResult> {
  const input = reverseEntryInput.parse(raw);
  requirePermission(ctx, "journal:reverse");

  return withIdempotency(ctx, input.idempotencyKey, "reverseEntry", async () => {
    const [journal] = await ctx.tx.execute<{
      id: string; journal_number: string; source: string; source_table: string | null;
      source_id: string | null; posting_date: string; narration: string | null;
      is_reversed: boolean; reverses_journal_id: string | null;
    }>(sql`
      SELECT id, journal_number, source::text, source_table, source_id,
             to_char(posting_date, 'YYYY-MM-DD') AS posting_date, narration,
             is_reversed, reverses_journal_id
        FROM journals WHERE id = ${input.journalId}::uuid FOR UPDATE
    `);
    if (!journal) throw new ServiceError("That entry does not exist.", "not_found");
    if (journal.is_reversed) {
      throw new ServiceError(
        `${journal.journal_number} has already been reversed.`,
        "conflict",
      );
    }
    if (journal.reverses_journal_id) {
      throw new ServiceError(
        `${journal.journal_number} is itself a reversal. Record the entry again rather than reversing the correction.`,
        "conflict",
      );
    }
    if (!REVERSIBLE_SOURCES.has(journal.source)) {
      throw new ServiceError(
        `${journal.journal_number} came from ${journal.source.replace(/_/g, " ")}. ${REVERSAL_ADVICE[journal.source] ?? "It has to be reversed from where it was created."}`,
        "invalid",
      );
    }

    const reversalDate = input.reversalDate ?? journal.posting_date;
    await assertPeriodOpenNamed(ctx, journal.posting_date);
    if (reversalDate !== journal.posting_date) {
      await assertPeriodOpenNamed(ctx, reversalDate);
    }

    const lines = await ctx.tx.execute<{
      system_key: string; business_unit_id: string | null; debit: string; credit: string;
      party_id: string | null; memo: string | null;
    }>(sql`
      SELECT a.system_key, jl.business_unit_id, jl.debit, jl.credit, jl.party_id, jl.memo
        FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_id = ${journal.id}::uuid
       ORDER BY jl.line_no
    `);
    if (lines.length === 0) {
      throw new ServiceError(`${journal.journal_number} has no lines to reverse.`, "invalid");
    }
    for (const line of lines) {
      if (!line.system_key) {
        throw new ServiceError(
          `${journal.journal_number} touches an account with no system key and cannot be reversed automatically.`,
          "invalid",
        );
      }
    }

    const amount = M.quantize(M.sum(lines.map((l) => M.fromDb(l.debit))));

    // Debits become credits. Nothing else changes — same accounts, same
    // business units, same parties — because a reversal that lands anywhere
    // other than where the original landed is a new error, not a correction.
    const reversalId = await postJournal(ctx, {
      postingDate: reversalDate,
      source: journal.source,
      sourceTable: journal.source_table ?? "journals",
      sourceId: journal.source_id ?? journal.id,
      narration: `Reversal of ${journal.journal_number} — ${input.reason.trim()}`,
      legs: lines.map((l) => ({
        accountKey: l.system_key,
        businessUnitId: l.business_unit_id,
        debit: M.fromDb(l.credit),
        credit: M.fromDb(l.debit),
        partyId: l.party_id,
        memo: l.memo ?? undefined,
      })),
    });

    const [reversal] = await ctx.tx.execute<{ journal_number: string }>(sql`
      UPDATE journals
         SET reverses_journal_id = ${journal.id}::uuid,
             source_id = CASE WHEN source_table = 'journals' THEN id ELSE source_id END
       WHERE id = ${reversalId}::uuid
      RETURNING journal_number
    `);
    await ctx.tx.execute(sql`
      UPDATE journals SET is_reversed = true, updated_at = now()
       WHERE id = ${journal.id}::uuid
    `);

    // ── Unwind the sub-ledger, when there is one ────────────────────────────
    const restoredDocuments: { docNumber: string; amount: number }[] = [];
    let businessUnitId: string | undefined;

    if (journal.source_table === "payments" && journal.source_id) {
      const [pay] = await ctx.tx.execute<{
        id: string; business_unit_id: string; party_id: string | null;
        payment_number: string; voided_at: string | null;
      }>(sql`
        SELECT id, business_unit_id, party_id, payment_number,
               voided_at::text AS voided_at
          FROM payments WHERE id = ${journal.source_id}::uuid FOR UPDATE
      `);
      if (pay) {
        businessUnitId = pay.business_unit_id;
        requireBusinessUnit(ctx, pay.business_unit_id);
        if (pay.voided_at) {
          throw new ServiceError(`${pay.payment_number} is already void.`, "conflict");
        }

        const allocations = await ctx.tx.execute<{
          id: string; document_id: string; amount: string;
          doc_number: string; doc_total: string;
        }>(sql`
          SELECT pa.id, pa.document_id, pa.amount, d.doc_number, d.total AS doc_total
            FROM payment_allocations pa
            JOIN documents d ON d.id = pa.document_id
           WHERE pa.payment_id = ${pay.id}::uuid
           FOR UPDATE OF pa, d
        `);

        let restoredTotal = M.ZERO;
        for (const alloc of allocations) {
          const back = M.fromDb(alloc.amount);
          restoredTotal = M.add(restoredTotal, back);

          // A receipt document exists only because this payment created it, so
          // it is voided rather than reopened — there is no unpaid sale left
          // behind, and it has to leave the VAT return with the reversal.
          const isCashSale = alloc.doc_number.startsWith("RCT-");
          if (isCashSale) {
            await ctx.tx.execute(sql`
              UPDATE documents
                 SET status = 'void', amount_paid = '0', amount_due = '0', updated_at = now()
               WHERE id = ${alloc.document_id}::uuid
            `);
          } else {
            await ctx.tx.execute(sql`
              UPDATE documents
                 SET amount_paid = amount_paid - ${M.toDb(back)},
                     amount_due  = total - (amount_paid - ${M.toDb(back)}),
                     status = CASE
                       WHEN amount_paid - ${M.toDb(back)} <= 0 THEN 'sent'::doc_status
                       ELSE 'partially_paid'::doc_status END,
                     updated_at = now()
               WHERE id = ${alloc.document_id}::uuid
            `);
          }
          await ctx.tx.execute(sql`
            DELETE FROM payment_allocations WHERE id = ${alloc.id}::uuid
          `);
          restoredDocuments.push({ docNumber: alloc.doc_number, amount: M.toNumber(back) });
        }

        if (pay.party_id && M.gt(restoredTotal, M.ZERO)) {
          await ctx.tx.execute(sql`
            UPDATE parties SET open_balance = open_balance + ${M.toDb(restoredTotal)},
                               updated_at = now()
             WHERE id = ${pay.party_id}::uuid
          `);
        }

        await ctx.tx.execute(sql`
          UPDATE payments
             SET voided_at = now(), unallocated_amount = '0',
                 note = concat_ws(E'\n', nullif(note, ''),
                                  ${`Reversed on ${reversalDate}: ${input.reason.trim()}`}::text),
                 updated_at = now()
           WHERE id = ${pay.id}::uuid
        `);
      }
    }

    await writeAudit(ctx, {
      action: "entry.reverse",
      entityTable: "journals",
      entityId: reversalId,
      businessUnitId,
      diff: {
        before: {
          journalNumber: journal.journal_number,
          narration: journal.narration,
          postingDate: journal.posting_date,
          isReversed: false,
        },
        after: {
          journalNumber: reversal!.journal_number,
          postingDate: reversalDate,
          isReversed: true,
        },
        reason: input.reason.trim(),
        amount: M.toDb(amount),
        restoredDocuments: restoredDocuments.map((d) => d.docNumber),
      },
    });

    return {
      reversalJournalId: reversalId,
      reversalJournalNumber: reversal!.journal_number,
      reversedJournalId: journal.id,
      reversedJournalNumber: journal.journal_number,
      amount: M.toNumber(amount),
      restoredDocuments,
    };
  });
}

// ── Reads the cash screens need ─────────────────────────────────────────────

export interface CashPointSummary {
  id: string | null;
  name: string;
  businessUnitId: string;
  businessUnitName: string;
  accountKey: string;
  balance: number;
}

/**
 * Every cash point the caller may post to, with what it should be holding.
 *
 * The balance is the LEDGER's answer, which is the figure the entry screens
 * show as "Marina float 2,340 → 1,940". It is deliberately not the last
 * counted amount: the point of showing it is to be contradicted by a physical
 * count, and a screen that showed the count back to the counter would destroy
 * the only control the cash module has.
 *
 * A business unit with no configured cash point still gets a row, addressed by
 * a null id and posting to 1100 CASH. Refusing to record cash until somebody
 * configures a till is how a cash module goes unused in its first week.
 */
export async function listCashPoints(
  ctx: ServiceContext,
  args: { asOf?: string } = {},
): Promise<CashPointSummary[]> {
  requirePermission(ctx, "payment:read");
  const asOf = args.asOf ?? ctx.today;

  const rows = await ctx.tx.execute<{
    id: string | null; name: string; business_unit_id: string; business_unit_name: string;
    system_key: string; balance: string;
  }>(sql`
    WITH points AS (
      SELECT cr.id, cr.name, cr.business_unit_id, a.system_key
        FROM cash_registers cr
        JOIN accounts a ON a.id = cr.account_id
       WHERE cr.is_active = true AND cr.deleted_at IS NULL AND a.system_key IS NOT NULL
      UNION ALL
      -- A till that was retired must not be postable to, but the business it
      -- belonged to still has to be able to take cash, so the fallback row is
      -- driven by whether any LIVE till exists rather than by whether one ever did.
      SELECT NULL::uuid AS id, 'Cash in hand' AS name, bu.id AS business_unit_id, 'CASH'
        FROM business_units bu
       WHERE bu.is_active = true AND bu.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM cash_registers cr
                          WHERE cr.business_unit_id = bu.id AND cr.is_active = true
                            AND cr.deleted_at IS NULL)
    )
    SELECT p.id, p.name, p.business_unit_id, bu.name AS business_unit_name, p.system_key,
           COALESCE((
             SELECT SUM(jl.base_debit - jl.base_credit)
               FROM journal_lines jl
               JOIN journals j ON j.id = jl.journal_id
               JOIN accounts a ON a.id = jl.account_id
              WHERE a.system_key = p.system_key
                AND jl.business_unit_id = p.business_unit_id
                AND j.posting_date <= ${asOf}::date
           ), 0) AS balance
      FROM points p
      JOIN business_units bu ON bu.id = p.business_unit_id
     ORDER BY bu.sort_order, bu.name, p.name
  `);

  return rows
    .filter((r) => ctx.principal.scope === "tenant"
      || (ctx.principal.businessUnitIds ?? []).includes(r.business_unit_id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      businessUnitId: r.business_unit_id,
      businessUnitName: r.business_unit_name,
      accountKey: r.system_key,
      balance: M.toNumber(M.fromDb(r.balance)),
    }));
}

export interface ManualEntryRow {
  /** The audit row's id — stable, and what a screen keys a list on. */
  auditId: string;
  /** What was recorded, in this module's own vocabulary. */
  kind: ManualEntryKind;
  at: string;
  actor: string | null;
  journalId: string | null;
  journalNumber: string | null;
  postingDate: string | null;
  narration: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  amount: number;
  /** Marked wherever it appears — FR-M09's third acceptance criterion. */
  isReversed: boolean;
  isReversal: boolean;
  reversesJournalNumber: string | null;
}

/**
 * The audit actions this module writes, and the words a person would use for
 * each. Listing entries by audit action rather than by journal source is what
 * makes "what did I record today" answerable at all: `journal_source` says
 * `payment` for a cash payment and for a customer settling an invoice from the
 * receivables screen, and the eleven thousand journals already in the ledger
 * would drown the six the cashier made this morning.
 */
const ENTRY_KINDS = {
  "cash_receipt.record": "Cash received",
  "cash_payment.record": "Cash paid",
  "owner_contribution.record": "Owner put money in",
  "owner_drawing.record": "Owner took money out",
  "manual_journal.post": "Manual journal",
  "entry.reverse": "Reversal",
} as const;

export type ManualEntryKind = (typeof ENTRY_KINDS)[keyof typeof ENTRY_KINDS];

/**
 * Recent entries made through this module, reversed ones included.
 *
 * Reversed entries stay in the list and carry `isReversed`, because FR-M09's
 * third acceptance criterion is that a reversed entry is visually marked
 * wherever it appears. Hiding it would be a quieter kind of deletion, and the
 * whole reversal-not-deletion principle is that the mistake stays visible next
 * to its correction.
 *
 * Gated on `payment:read` rather than `audit:read`. The audit log proper is the
 * accountant's and the auditor's; this is a cashier looking at the six entries
 * they just made, scoped to the businesses they can already post into, showing
 * nothing they did not themselves supply.
 */
export async function listManualEntries(
  ctx: ServiceContext,
  args: { limit?: number; businessUnitId?: string | null } = {},
): Promise<ManualEntryRow[]> {
  requirePermission(ctx, "payment:read");
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
  const actions = Object.keys(ENTRY_KINDS);

  const rows = await ctx.tx.execute<{
    audit_id: string; action: string; at: string; actor: string | null;
    business_unit_id: string | null; business_unit_name: string | null;
    journal_id: string | null; journal_number: string | null; posting_date: string | null;
    narration: string | null; amount: string; is_reversed: boolean | null;
    reverses_number: string | null;
  }>(sql`
    SELECT al.id AS audit_id, al.action, to_char(al.at, 'YYYY-MM-DD HH24:MI') AS at,
           u.full_name AS actor,
           COALESCE(al.business_unit_id, line.business_unit_id) AS business_unit_id,
           bu.name AS business_unit_name,
           j.id AS journal_id, j.journal_number,
           to_char(j.posting_date, 'YYYY-MM-DD') AS posting_date, j.narration,
           COALESCE((SELECT SUM(jl.base_debit) FROM journal_lines jl
                      WHERE jl.journal_id = j.id), 0) AS amount,
           j.is_reversed,
           (SELECT o.journal_number FROM journals o WHERE o.id = j.reverses_journal_id)
             AS reverses_number
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.actor_user_id
      LEFT JOIN LATERAL (
        SELECT jj.* FROM journals jj
         WHERE (al.entity_table = 'journals' AND jj.id = al.entity_id)
            OR (al.entity_table = 'payments' AND jj.source_table = 'payments'
                AND jj.source_id = al.entity_id AND jj.reverses_journal_id IS NULL)
         ORDER BY jj.posted_at
         LIMIT 1
      ) j ON true
      LEFT JOIN LATERAL (
        SELECT jl.business_unit_id FROM journal_lines jl
         WHERE jl.journal_id = j.id AND jl.business_unit_id IS NOT NULL
         LIMIT 1
      ) line ON true
      LEFT JOIN business_units bu
             ON bu.id = COALESCE(al.business_unit_id, line.business_unit_id)
     WHERE al.action = ANY(ARRAY[${sql.join(actions.map((a) => sql`${a}`), sql`, `)}])
       AND (${args.businessUnitId ?? null}::uuid IS NULL
            OR COALESCE(al.business_unit_id, line.business_unit_id)
               = ${args.businessUnitId ?? null}::uuid)
     ORDER BY al.at DESC
     LIMIT ${limit}
  `);

  return rows
    .filter((r) =>
      ctx.principal.scope === "tenant" ||
      r.business_unit_id === null ||
      (ctx.principal.businessUnitIds ?? []).includes(r.business_unit_id))
    .map((r) => ({
      auditId: r.audit_id,
      kind: ENTRY_KINDS[r.action as keyof typeof ENTRY_KINDS],
      at: r.at,
      actor: r.actor,
      journalId: r.journal_id,
      journalNumber: r.journal_number,
      postingDate: r.posting_date,
      narration: r.narration,
      businessUnitId: r.business_unit_id,
      businessUnitName: r.business_unit_name,
      amount: M.toNumber(M.fromDb(r.amount)),
      isReversed: r.is_reversed ?? false,
      isReversal: r.action === "entry.reverse",
      reversesJournalNumber: r.reverses_number,
    }));
}
