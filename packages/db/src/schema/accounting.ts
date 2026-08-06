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
