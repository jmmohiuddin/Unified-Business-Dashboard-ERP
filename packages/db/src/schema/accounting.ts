import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  accountType,
  journalSource,
  normalBalance,
  periodStatus,
  taxTreatment,
} from "./_enums.ts";
import { currencyCode, metadata, money, pk, rate, timestamps } from "./_shared.ts";
import { businessUnits, tenants } from "./tenancy.ts";
import { parties } from "./parties.ts";
import { users } from "./identity.ts";

/**
 * Chart of accounts.
 *
 * Deliberately ONE chart across all businesses, with `business_unit_id` as a
 * *dimension* on the journal line rather than a separate chart per business.
 * That is what makes a consolidated P&L a GROUP BY instead of a merge exercise,
 * while still letting each business have its own P&L.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: accountType("type").notNull(),
    normalBalance: normalBalance("normal_balance").notNull(),
    parentId: uuid("parent_id"),
    /** Leaf accounts take postings; parents exist for report grouping only. */
    isPostable: boolean("is_postable").notNull().default(true),
    /** Protects "Accounts Receivable" etc. from being renamed or deleted. */
    isSystem: boolean("is_system").notNull().default(false),
    systemKey: varchar("system_key", { length: 40 }),
    currency: currencyCode("currency"),
    /** Where it appears on the cash-flow statement: operating/investing/financing. */
    cashFlowSection: varchar("cash_flow_section", { length: 20 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("accounts_tenant_code_uq").on(t.tenantId, t.code),
    uniqueIndex("accounts_system_key_uq").on(t.tenantId, t.systemKey),
    index("accounts_type_idx").on(t.tenantId, t.type),
  ],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 20 }).notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: periodStatus("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [uniqueIndex("fiscal_periods_uq").on(t.tenantId, t.label)],
);

/**
 * Journal header. Every financial event lands here exactly once, via a posting
 * rule — nothing in the UI writes journal lines by hand except the "manual
 * journal" screen, which is permission-gated.
 */
export const journals = pgTable(
  "journals",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    journalNumber: varchar("journal_number", { length: 40 }).notNull(),
    source: journalSource("source").notNull(),
    sourceTable: varchar("source_table", { length: 63 }),
    sourceId: uuid("source_id"),
    postingDate: date("posting_date").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").references(() => fiscalPeriods.id, {
      onDelete: "set null",
    }),
    narration: text("narration"),
    /** Reversal pointers make corrections auditable instead of destructive. */
    reversesJournalId: uuid("reverses_journal_id"),
    isReversed: boolean("is_reversed").notNull().default(false),
    postedByUserId: uuid("posted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("journals_number_uq").on(t.tenantId, t.journalNumber),
    index("journals_source_idx").on(t.sourceTable, t.sourceId),
    index("journals_date_idx").on(t.tenantId, t.postingDate),
  ],
);

/**
 * Double-entry lines. Invariant enforced in the posting service and asserted by
 * a deferred constraint trigger: SUM(debit) = SUM(credit) per journal, always.
 *
 * `businessUnitId` on the LINE (not the header) is what allows a single journal
 * to record an inter-company transaction — the construction business invoicing
 * the rental business for a repair — with both sides in one balanced entry.
 */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),

    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    currency: currencyCode("currency").notNull().default("AED"),
    fxRate: rate("fx_rate").notNull().default("1"),
    baseDebit: money("base_debit").notNull().default("0"),
    baseCredit: money("base_credit").notNull().default("0"),

    /** Sub-ledger link: which customer/supplier this AR/AP line belongs to. */
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    /** Free analytical dimensions — job, project, lease, employee. */
    dimensionTable: varchar("dimension_table", { length: 63 }),
    dimensionId: uuid("dimension_id"),
    memo: text("memo"),
    ...timestamps,
  },
  (t) => [
    index("journal_lines_journal_idx").on(t.journalId, t.lineNo),
    index("journal_lines_account_idx").on(t.accountId),
    index("journal_lines_bu_idx").on(t.businessUnitId),
    index("journal_lines_party_idx").on(t.partyId),
    index("journal_lines_dimension_idx").on(t.dimensionTable, t.dimensionId),
  ],
);

export const taxCodes = pgTable(
  "tax_codes",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    rate: rate("rate").notNull(),
    /**
     * Treatment, not just rate. Zero-rated and exempt are both 0% output VAT but
     * behave oppositely on input recovery — see the enum. Storing only the rate
     * would silently overstate the recoverable position on every VAT return.
     */
    treatment: taxTreatment("treatment").notNull().default("standard"),
    /** Whether input VAT on costs attributable to this supply can be reclaimed. */
    inputRecoverable: boolean("input_recoverable").notNull().default(true),
    /** true = the displayed price already contains the tax (retail norm here). */
    isInclusive: boolean("is_inclusive").notNull().default(false),
    isCompound: boolean("is_compound").notNull().default(false),
    outputAccountId: uuid("output_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    inputAccountId: uuid("input_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** Which box of the statutory return this feeds. Country-specific. */
    reportingCode: varchar("reporting_code", { length: 30 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("tax_codes_uq").on(t.tenantId, t.code)],
);

/**
 * A VAT201 return, as filed.
 *
 * The VAT screen used to recompute the position from live data on every
 * request, which has three consequences that only look small until an
 * inspection:
 *
 *  1. **A filed quarter cannot be reproduced.** A credit note raised in
 *     September against a July invoice changes what July's query returns, so
 *     re-opening Q3 shows a different return from the one submitted. The FTA's
 *     question at an audit is "why does your system not agree with your
 *     filing", and "because it recomputes" is not an answer.
 *  2. **The apportionment in force is lost.** The recovery ratio, the method
 *     and — critically — the *basis* the ratio was computed on (see
 *     `APPORTIONMENT_BASIS_IN_USE`, which is an open question for the tax
 *     adviser) are properties of the moment of filing. If that question is
 *     answered differently later, every return filed before the answer must
 *     still be readable on the basis that produced it.
 *  3. **There is nothing to retain.** UAE VAT records must be kept for 5 years,
 *     and 15 for real estate (PRD-02 §966). A query is not a record.
 *
 * So a return is a row: computed once, frozen at filing, and never recomputed.
 * Box figures are stored individually rather than as a JSON blob because they
 * are money and the money columns are `numeric(18,4)` — a blob would make them
 * doubles on the way in and out.
 *
 * Rows are never hard-deleted; `deletedAt` in `timestamps` is the only removal.
 */
export const vatReturns = pgTable(
  "vat_returns",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Tax period as the FTA labels it, e.g. "2026-Q3". One row per period. */
    periodLabel: varchar("period_label", { length: 20 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** Statutory filing deadline: 28 days after the period end. */
    dueOn: date("due_on"),
    /**
     * `draft` while the quarter is open and the figures still move; `filed`
     * once submitted on the FTA portal, after which the row is the record of
     * what was submitted and must not be recomputed. A varchar rather than an
     * enum so this table does not have to reach into the shared enum module.
     */
    status: varchar("status", { length: 16 }).notNull().default("draft"),

    /** Emirate box 1 is reported under. The FTA splits box 1 1a–1g. */
    emirate: varchar("emirate", { length: 40 }),

    // ── Apportionment in force at the moment of filing ──────────────────────
    /** "standard" | "floorspace" — `ApportionmentMethod["kind"]`. */
    apportionmentMethod: varchar("apportionment_method", { length: 20 })
      .notNull()
      .default("standard"),
    /**
     * Which number the ratio was computed FROM: "supplies_value",
     * "input_tax_value" or "floorspace". Stored per return because the correct
     * answer for the standard method is an open question, and returns filed
     * either side of the answer must remain individually interpretable.
     */
    apportionmentBasis: varchar("apportionment_basis", { length: 20 })
      .notNull()
      .default("supplies_value"),
    /** The FTA's written approval, where a special method was used. */
    ftaApprovalReference: varchar("fta_approval_reference", { length: 60 }),
    /** Recoverable share of residual input VAT, as a fraction. */
    recoveryRatio: rate("recovery_ratio").notNull().default("1"),

    // ── Boxes ──────────────────────────────────────────────────────────────
    standardRatedSupplies: money("standard_rated_supplies").notNull().default("0"),
    outputVat: money("output_vat").notNull().default("0"),
    zeroRatedSupplies: money("zero_rated_supplies").notNull().default("0"),
    exemptSupplies: money("exempt_supplies").notNull().default("0"),
    reverseChargeSupplies: money("reverse_charge_supplies").notNull().default("0"),
    reverseChargeOutputVat: money("reverse_charge_output_vat").notNull().default("0"),
    /** Input VAT wholly attributable to taxable supplies (account 1600). */
    directlyAttributableInput: money("directly_attributable_input").notNull().default("0"),
    /** The shared-overhead pool this return apportioned (account 1610). */
    residualInput: money("residual_input").notNull().default("0"),
    /** Of that pool, what this return actually reclaimed. */
    recoverableResidual: money("recoverable_residual").notNull().default("0"),
    /** Input VAT wholly attributable to exempt supplies (account 5720). */
    exemptAttributableInput: money("exempt_attributable_input").notNull().default("0"),
    totalRecoverableInput: money("total_recoverable_input").notNull().default("0"),
    irrecoverableInput: money("irrecoverable_input").notNull().default("0"),
    netVatDue: money("net_vat_due").notNull().default("0"),

    /**
     * The annual actual-use adjustment applied to this period, where the
     * wash-up landed on it. Null on every period that is not the one carrying
     * the year's adjustment.
     */
    washupAdjustment: money("washup_adjustment"),
    washupJournalId: uuid("washup_journal_id").references(() => journals.id, {
      onDelete: "set null",
    }),

    /** The engine's own notes, frozen with the figures they explain. */
    notes: metadata("notes"),

    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedByUserId: uuid("filed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The FTA portal's acknowledgement reference for the submission. */
    ftaSubmissionReference: varchar("fta_submission_reference", { length: 60 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vat_returns_period_uq").on(t.tenantId, t.periodLabel),
    index("vat_returns_status_idx").on(t.tenantId, t.status, t.periodStart),
  ],
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 150 }).notNull(),
    bankName: varchar("bank_name", { length: 150 }),
    accountNumberMasked: varchar("account_number_masked", { length: 40 }),
    kind: varchar("kind", { length: 20 }).notNull().default("bank"),
    currency: currencyCode("currency").notNull().default("AED"),
    currentBalance: money("current_balance").notNull().default("0"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("bank_accounts_tenant_idx").on(t.tenantId)],
);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    valueDate: date("value_date").notNull(),
    description: text("description"),
    reference: varchar("reference", { length: 120 }),
    amount: money("amount").notNull(),
    balanceAfter: money("balance_after"),
    /** Set once matched to a payment or journal. */
    matchedPaymentId: uuid("matched_payment_id"),
    matchedJournalId: uuid("matched_journal_id"),
    matchConfidence: rate("match_confidence"),
    isReconciled: boolean("is_reconciled").notNull().default(false),
    importBatchId: uuid("import_batch_id"),
    ...timestamps,
  },
  (t) => [
    index("bank_txn_account_date_idx").on(t.bankAccountId, t.valueDate),
    index("bank_txn_unreconciled_idx").on(t.tenantId, t.isReconciled),
  ],
);

/**
 * Cash drawer sessions. The salon and the parking business are cash-first; if
 * you cannot answer "what should be in the till right now and what actually
 * is", theft and error are invisible. This is the highest-ROI control in the
 * whole accounting module for this owner.
 */
export const cashRegisters = pgTable(
  "cash_registers",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id"),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 100 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("cash_registers_bu_idx").on(t.businessUnitId)],
);

export const cashRegisterSessions = pgTable(
  "cash_register_sessions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    cashRegisterId: uuid("cash_register_id")
      .notNull()
      .references(() => cashRegisters.id, { onDelete: "cascade" }),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openingFloat: money("opening_float").notNull().default("0"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** System-computed vs physically counted. The delta is the whole point. */
    expectedCash: money("expected_cash"),
    countedCash: money("counted_cash"),
    variance: money("variance"),
    varianceNote: text("variance_note"),
    ...timestamps,
  },
  (t) => [index("crs_register_idx").on(t.cashRegisterId, t.openedAt)],
);

/** Budgets by account × business × period, for variance reporting. */
export const budgetLines = pgTable(
  "budget_lines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    periodLabel: varchar("period_label", { length: 20 }).notNull(),
    amount: money("amount").notNull().default("0"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("budget_lines_uq").on(t.businessUnitId, t.accountId, t.periodLabel)],
);

/**
 * Declarative document → journal mapping. Keeping posting rules as DATA rather
 * than a switch statement means a new business type (or a country with a
 * different VAT treatment) is a configuration change, and the owner's
 * accountant can inspect exactly why a journal looks the way it does.
 */
export const postingRules = pgTable(
  "posting_rules",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    eventKey: varchar("event_key", { length: 60 }).notNull(),
    /** [{ leg:"debit", accountKey:"AR", amount:"total" }, ...] */
    legs: metadata("legs"),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("posting_rules_event_idx").on(t.tenantId, t.eventKey)],
);

export const journalsRelations = relations(journals, ({ many }) => ({
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  journal: one(journals, { fields: [journalLines.journalId], references: [journals.id] }),
  account: one(accounts, { fields: [journalLines.accountId], references: [accounts.id] }),
  businessUnit: one(businessUnits, {
    fields: [journalLines.businessUnitId],
    references: [businessUnits.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ many }) => ({
  lines: many(journalLines),
}));
