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
  chequeStatus,
  docStatus,
  docType,
  installmentStatus,
  paymentDirection,
  paymentMethod,
} from "./_enums.ts";
import { currencyCode, metadata, money, pk, qty, rate, timestamps } from "./_shared.ts";
import { businessUnits, locations, tenants } from "./tenancy.ts";
import { parties } from "./parties.ts";
import { items, itemVariants } from "./catalog.ts";
import { serialUnits } from "./inventory.ts";
import { users } from "./identity.ts";

/**
 * The commercial document spine.
 *
 * Quotation, sales order, invoice, credit note, PO and bill share ~90% of their
 * columns and 100% of their line shape. One table + `docType` means:
 *   - "convert quote → invoice" is an INSERT ... SELECT, not an ETL;
 *   - AR and AP ageing are the same query with a different sign;
 *   - a new document type is a new enum value and a posting rule, not 12 files.
 *
 * `direction` is derived from docType: sales docs are receivable, purchase docs
 * payable. It is stored anyway so ageing reports can index on it.
 */
export const documents = pgTable(
  "documents",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),

    docType: docType("doc_type").notNull(),
    docNumber: varchar("doc_number", { length: 40 }).notNull(),
    status: docStatus("status").notNull().default("draft"),
    direction: paymentDirection("direction").notNull(),

    partyId: uuid("party_id").references(() => parties.id, { onDelete: "restrict" }),
    partyNameSnapshot: varchar("party_name_snapshot", { length: 200 }),

    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date"),
    /** Denormalised so the AR ageing bucket is a plain integer comparison. */
    daysOverdue: integer("days_overdue").notNull().default(0),

    currency: currencyCode("currency").notNull().default("AED"),
    fxRate: rate("fx_rate").notNull().default("1"),

    subtotal: money("subtotal").notNull().default("0"),
    discountTotal: money("discount_total").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    /** Denormalised running balance — the single most-read number in the app. */
    amountPaid: money("amount_paid").notNull().default("0"),
    amountDue: money("amount_due").notNull().default("0"),
    /** Total in tenant base currency, for the consolidated dashboard. */
    baseTotal: money("base_total").notNull().default("0"),

    /** COGS captured at posting time so margin survives later cost changes. */
    costTotal: money("cost_total").notNull().default("0"),

    /** Where the document came from and what it turned into. */
    sourceDocumentId: uuid("source_document_id"),
    sourceTable: varchar("source_table", { length: 63 }),
    sourceId: uuid("source_id"),
    channelId: uuid("channel_id"),

    /** Inter-company: the mirror document in the counterparty business. */
    interCompanyDocumentId: uuid("inter_company_document_id"),
    counterpartyBusinessUnitId: uuid("counterparty_business_unit_id").references(
      () => businessUnits.id,
      { onDelete: "set null" },
    ),

    salespersonEmployeeId: uuid("salesperson_employee_id"),
    priceListId: uuid("price_list_id"),
    notes: text("notes"),
    termsText: text("terms_text"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("documents_number_uq").on(t.tenantId, t.businessUnitId, t.docType, t.docNumber),
    index("documents_tenant_type_date_idx").on(t.tenantId, t.docType, t.issueDate),
    index("documents_party_idx").on(t.partyId, t.issueDate),
    index("documents_ar_idx").on(t.tenantId, t.direction, t.status, t.dueDate),
    index("documents_bu_date_idx").on(t.businessUnitId, t.issueDate),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),

    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "restrict" }),
    serialUnitId: uuid("serial_unit_id").references(() => serialUnits.id, {
      onDelete: "set null",
    }),
    /** Snapshot: an invoice must not change when someone renames a product. */
    description: text("description").notNull(),

    quantity: qty("quantity").notNull().default("1"),
    uom: varchar("uom", { length: 20 }).notNull().default("unit"),
    unitPrice: money("unit_price").notNull().default("0"),
    discountRate: rate("discount_rate").notNull().default("0"),
    discountAmount: money("discount_amount").notNull().default("0"),
    taxCodeId: uuid("tax_code_id"),
    taxRate: rate("tax_rate").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    lineTotal: money("line_total").notNull().default("0"),
    unitCost: money("unit_cost").notNull().default("0"),

    /** Dimension tags so a line can be attributed to a job, lease or project
     *  without a join table per module. */
    jobId: uuid("job_id"),
    leaseId: uuid("lease_id"),
    projectId: uuid("project_id"),
    appointmentId: uuid("appointment_id"),
    employeeId: uuid("employee_id"),

    /** Rent lines cover a period; used for accrual and occupancy reports. */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    ...timestamps,
  },
  (t) => [
    index("document_lines_doc_idx").on(t.documentId, t.lineNo),
    index("document_lines_item_idx").on(t.itemId),
    index("document_lines_job_idx").on(t.jobId),
    index("document_lines_lease_idx").on(t.leaseId),
  ],
);

/**
 * Money actually moving. Deliberately separate from documents: a customer pays
 * 5,000 against three invoices, or on account with nothing allocated yet. That
 * is impossible to model with a `paid_amount` column alone.
 */
export const payments = pgTable(
  "payments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    paymentNumber: varchar("payment_number", { length: 40 }).notNull(),
    direction: paymentDirection("direction").notNull(),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "restrict" }),

    method: paymentMethod("method").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull().default("AED"),
    fxRate: rate("fx_rate").notNull().default("1"),
    baseAmount: money("base_amount").notNull().default("0"),
    /** Amount not yet matched to a document — customer credit on account. */
    unallocatedAmount: money("unallocated_amount").notNull().default("0"),

    receivedOn: date("received_on").notNull(),
    reference: varchar("reference", { length: 100 }),
    bankAccountId: uuid("bank_account_id"),
    cashRegisterSessionId: uuid("cash_register_session_id"),
    gatewayTxnId: varchar("gateway_txn_id", { length: 120 }),

    receivedByUserId: uuid("received_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isReconciled: boolean("is_reconciled").notNull().default(false),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payments_number_uq").on(t.tenantId, t.businessUnitId, t.paymentNumber),
    index("payments_party_idx").on(t.partyId, t.receivedOn),
    index("payments_bu_date_idx").on(t.businessUnitId, t.receivedOn),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    installmentId: uuid("installment_id"),
    amount: money("amount").notNull(),
    ...timestamps,
  },
  (t) => [
    index("payment_alloc_payment_idx").on(t.paymentId),
    index("payment_alloc_doc_idx").on(t.documentId),
  ],
);

/**
 * Installments — called out explicitly in the brief and genuinely central to
 * this market: a phone sold on 6 monthly payments, a lease deposit paid in 3,
 * a construction contract billed against milestones.
 */
export const installmentPlans = pgTable(
  "installment_plans",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    principal: money("principal").notNull(),
    downPayment: money("down_payment").notNull().default("0"),
    /** Flat service charge, not APR — matches how these deals are actually sold
     *  here. Keep both if you later need regulated disclosure. */
    serviceChargeRate: rate("service_charge_rate").notNull().default("0"),
    installmentCount: integer("installment_count").notNull(),
    frequency: varchar("frequency", { length: 16 }).notNull().default("monthly"),
    startsOn: date("starts_on").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    /** Collateral: for a phone sold on credit this is the IMEI. */
    collateralSerialUnitId: uuid("collateral_serial_unit_id").references(() => serialUnits.id, {
      onDelete: "set null",
    }),
    guarantorPartyId: uuid("guarantor_party_id").references(() => parties.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [index("installment_plans_party_idx").on(t.partyId)],
);

export const installments = pgTable(
  "installments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => installmentPlans.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    dueOn: date("due_on").notNull(),
    amountDue: money("amount_due").notNull(),
    amountPaid: money("amount_paid").notNull().default("0"),
    status: installmentStatus("status").notNull().default("scheduled"),
    paidOn: date("paid_on"),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("installments_plan_seq_uq").on(t.planId, t.seq),
    index("installments_due_idx").on(t.tenantId, t.status, t.dueOn),
  ],
);

/**
 * POST-DATED CHEQUE REGISTER.
 *
 * The single most UAE-specific table in this schema, and the one a generic ERP
 * cannot express. A tenancy contract here is typically settled with a bundle of
 * cheques handed over on signing — 1, 2, 4, 6 or 12 of them, each dated for a
 * future rental period and physically held in the landlord's safe until due.
 *
 * Why this must be its own table rather than a flag on `payments`:
 *
 *  • A held cheque is NOT a payment. It is a promise, and treating it as cash
 *    overstates the bank balance by an entire year's rent.
 *  • It is not a receivable either — the invoice for month 9 does not exist yet.
 *    The cheque sits in a control account until its period is invoiced.
 *  • Bounced cheques have a legal and financial tail: a bank charge, a
 *    replacement cheque, sometimes a police complaint. The replacement chain has
 *    to be traceable, so `replacesChequeId` links them.
 *  • The landlord must be able to answer "which physical cheque covered which
 *    rental period" during an Ejari or court dispute.
 *
 * Accrual accounting is kept correct independently: rent is still invoiced
 * monthly, and a cleared cheque produces a `payment` allocated across the
 * invoices for the months it covers.
 */
export const cheques = pgTable(
  "cheques",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    direction: paymentDirection("direction").notNull().default("in"),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "restrict" }),
    /** Set when the cheque settles a lease; null for a supplier or ad-hoc cheque. */
    leaseId: uuid("lease_id"),

    chequeNumber: varchar("cheque_number", { length: 40 }).notNull(),
    bankName: varchar("bank_name", { length: 120 }),
    drawerName: varchar("drawer_name", { length: 200 }),
    /** The date written on the cheque — NOT the date it was received. */
    chequeDate: date("cheque_date").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull().default("AED"),

    status: chequeStatus("status").notNull().default("held"),
    /** The rental period this instrument covers, for dispute resolution. */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),

    receivedOn: date("received_on"),
    depositedOn: date("deposited_on"),
    clearedOn: date("cleared_on"),
    bouncedOn: date("bounced_on"),
    bounceReason: varchar("bounce_reason", { length: 200 }),
    bankChargeAmount: money("bank_charge_amount").notNull().default("0"),

    /** Replacement chain after a bounce or a renegotiated tenancy. */
    replacesChequeId: uuid("replaces_cheque_id"),
    /** Set once cleared and converted into an actual receipt. */
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    /** Physical location of the instrument — safes and bank lodgements both. */
    custodyLocation: varchar("custody_location", { length: 120 }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cheques_number_uq").on(t.tenantId, t.bankName, t.chequeNumber),
    // The core operational query: "what do I bank this week?"
    index("cheques_due_idx").on(t.tenantId, t.status, t.chequeDate),
    index("cheques_lease_idx").on(t.leaseId),
    index("cheques_party_idx").on(t.partyId),
  ],
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  party: one(parties, { fields: [documents.partyId], references: [parties.id] }),
  businessUnit: one(businessUnits, {
    fields: [documents.businessUnitId],
    references: [businessUnits.id],
  }),
  lines: many(documentLines),
  allocations: many(paymentAllocations),
}));

export const documentLinesRelations = relations(documentLines, ({ one }) => ({
  document: one(documents, {
    fields: [documentLines.documentId],
    references: [documents.id],
  }),
  item: one(items, { fields: [documentLines.itemId], references: [items.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  party: one(parties, { fields: [payments.partyId], references: [parties.id] }),
  allocations: many(paymentAllocations),
}));
