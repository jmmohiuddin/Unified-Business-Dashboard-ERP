import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { leadStatus, partyType } from "./_enums.ts";
import { currencyCode, metadata, money, pk, timestamps } from "./_shared.ts";
import { businessUnits, tenants } from "./tenancy.ts";
import { users } from "./identity.ts";

/**
 * ONE party table for customers, suppliers, tenants(renters) and employees.
 *
 * This is the highest-value modelling decision in the CRM. In a portfolio like
 * this the same human is routinely a salon customer, the tenant in flat 4B, and
 * the electrician you subcontract to. Separate `customers`/`suppliers`/`tenants`
 * tables make that person three unrelated records, which means the AI can never
 * answer "what is this relationship actually worth to me" and the owner
 * duplicates phone numbers forever.
 *
 * Role flags (is_customer / is_supplier / …) are non-exclusive by design.
 */
export const parties = pgTable(
  "parties",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: partyType("type").notNull().default("person"),
    code: varchar("code", { length: 30 }),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    legalName: varchar("legal_name", { length: 200 }),

    isCustomer: boolean("is_customer").notNull().default(false),
    isSupplier: boolean("is_supplier").notNull().default(false),
    isTenantRenter: boolean("is_tenant_renter").notNull().default(false),
    isEmployeeParty: boolean("is_employee_party").notNull().default(false),

    primaryPhone: varchar("primary_phone", { length: 40 }),
    whatsapp: varchar("whatsapp", { length: 40 }),
    email: varchar("email", { length: 320 }),

    /**
     * Government identifiers are encrypted at rest. Phone and email are not:
     * they are operational contact data that every screen and every message
     * template needs, and encrypting them would mean decrypting on every list
     * render for no meaningful protection — they are already known to anyone
     * who has ever received a message from this business.
     *
     * An Emirates ID or passport number is different in kind: it enables
     * identity fraud, and it is exactly what a stolen backup is worth stealing
     * for. See packages/core/src/security/pii.ts.
     */
    nationalIdEnc: text("national_id_enc"),
    nationalIdBidx: varchar("national_id_bidx", { length: 32 }),
    nationalIdHint: varchar("national_id_hint", { length: 16 }),
    taxIdEnc: text("tax_id_enc"),
    taxIdHint: varchar("tax_id_hint", { length: 16 }),

    addressLine: text("address_line"),
    city: varchar("city", { length: 100 }),
    countryCode: varchar("country_code", { length: 2 }),

    /** Credit control — the thing that actually stops a small business dying. */
    creditLimit: money("credit_limit"),
    creditTermDays: integer("credit_term_days").notNull().default(0),
    isCreditBlocked: boolean("is_credit_blocked").notNull().default(false),
    currency: currencyCode("currency"),

    /** Denormalised rollups, refreshed by a background job. Reading these on a
     *  list screen must never trigger an aggregate over the whole ledger. */
    lifetimeValue: money("lifetime_value").notNull().default("0"),
    openBalance: money("open_balance").notNull().default("0"),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    visitCount: integer("visit_count").notNull().default(0),

    /** Simple, explainable churn/loyalty signals. Recency-Frequency-Monetary
     *  beats a black-box score for a non-technical owner. */
    rfmRecency: integer("rfm_recency"),
    rfmFrequency: integer("rfm_frequency"),
    rfmMonetary: integer("rfm_monetary"),
    churnRisk: varchar("churn_risk", { length: 12 }),

    birthday: date("birthday"),
    source: varchar("source", { length: 60 }),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("parties_tenant_name_idx").on(t.tenantId, t.displayName),
    index("parties_tenant_phone_idx").on(t.tenantId, t.primaryPhone),
    uniqueIndex("parties_tenant_code_uq").on(t.tenantId, t.code),
    // The blind index is what makes "find the customer by Emirates ID" possible
    // at all once the value itself is ciphertext.
    index("parties_national_id_bidx").on(t.tenantId, t.nationalIdBidx),
  ],
);

/**
 * The party↔business relationship. A customer of the salon is not automatically
 * a customer of the mobile shop; this row is what grants visibility and holds
 * per-business stats. It is also the join the AI uses for cross-sell
 * ("342 salon customers live in buildings you own but rent from someone else").
 */
export const partyBusinessUnits = pgTable(
  "party_business_units",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revenueToDate: money("revenue_to_date").notNull().default("0"),
    transactionCount: integer("transaction_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("pbu_uq").on(t.partyId, t.businessUnitId)],
);

export const partyContacts = pgTable(
  "party_contacts",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    role: varchar("role", { length: 100 }),
    phone: varchar("phone", { length: 40 }),
    email: varchar("email", { length: 320 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("party_contacts_party_idx").on(t.partyId)],
);

/**
 * Unified communication timeline: calls, WhatsApp, visits, complaints, notes.
 * One table so "show me everything about this person" is one indexed query
 * regardless of which business the interaction happened in.
 */
export const interactions = pgTable(
  "interactions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id"),
    channel: varchar("channel", { length: 30 }).notNull(),
    direction: varchar("direction", { length: 10 }).notNull().default("out"),
    subject: varchar("subject", { length: 200 }),
    body: text("body"),
    /** Set when the row was produced by an automation or the AI assistant. */
    generatedBy: varchar("generated_by", { length: 30 }),
    sentiment: varchar("sentiment", { length: 12 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("interactions_party_at_idx").on(t.partyId, t.occurredAt),
    index("interactions_tenant_at_idx").on(t.tenantId, t.occurredAt),
  ],
);

/** Pre-customer pipeline. Converts into a party + quotation. */
export const leads = pgTable(
  "leads",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    name: varchar("name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 40 }),
    email: varchar("email", { length: 320 }),
    status: leadStatus("status").notNull().default("new"),
    source: varchar("source", { length: 60 }),
    requirement: text("requirement"),
    estimatedValue: money("estimated_value"),
    /** 0..100, produced by the scoring job — always paired with `scoreReason`
     *  so the owner is never shown a number they cannot interrogate. */
    score: integer("score"),
    scoreReason: text("score_reason"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    lostReason: varchar("lost_reason", { length: 200 }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    metadata: metadata(),
    ...timestamps,
  },
  (t) => [
    index("leads_tenant_status_idx").on(t.tenantId, t.status),
    index("leads_followup_idx").on(t.tenantId, t.nextFollowUpAt),
  ],
);

export const partiesRelations = relations(parties, ({ many }) => ({
  businessUnits: many(partyBusinessUnits),
  contacts: many(partyContacts),
  interactions: many(interactions),
}));

export const leadsRelations = relations(leads, ({ one }) => ({
  party: one(parties, { fields: [leads.partyId], references: [parties.id] }),
  businessUnit: one(businessUnits, {
    fields: [leads.businessUnitId],
    references: [businessUnits.id],
  }),
}));
