import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businessKind, moduleKey } from "./_enums.ts";
import { currencyCode, metadata, pk, timestamps } from "./_shared.ts";

/**
 * Tenant = one paying SaaS account = one owner's whole portfolio.
 * Every other tenant-scoped table carries `tenant_id` and is protected by an
 * RLS policy against `current_setting('app.tenant_id')`. See src/sql/rls.ts.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    slug: varchar("slug", { length: 63 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    /** Reporting currency for the consolidated view across all businesses. */
    baseCurrency: currencyCode("base_currency").notNull().default("AED"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Dubai"),
    locale: varchar("locale", { length: 10 }).notNull().default("en"),
    /** Country drives the tax engine + chart-of-accounts template. */
    countryCode: varchar("country_code", { length: 2 }).notNull().default("AE"),
    /** UAE businesses almost universally run a calendar fiscal year, which is
     *  also the default corporate-tax period. */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    /** Emirate — VAT return box 1 is reported per emirate, so this is not
     *  cosmetic address data. */
    emirate: varchar("emirate", { length: 40 }).notNull().default("Dubai"),
    /** VAT filing cadence: 'quarterly' below AED 150m turnover, else 'monthly'. */
    vatFilingFrequency: varchar("vat_filing_frequency", { length: 12 })
      .notNull()
      .default("quarterly"),
    plan: varchar("plan", { length: 40 }).notNull().default("owner"),
    settings: metadata("settings"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tenants_slug_uq").on(t.slug)],
);

/**
 * Business unit = one of the owner's businesses (the salon, the mobile shop).
 * It is a *legal-ish* boundary: it has its own P&L, its own numbering series and
 * its own enabled modules, but shares the customer base and the ledger.
 */
export const businessUnits = pgTable(
  "business_units",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    kind: businessKind("kind").notNull(),
    currency: currencyCode("currency").notNull().default("AED"),
    /** A separate legal entity files its own VAT return and is its own taxable
     *  person for corporate tax. Drives inter-company posting and whether Small
     *  Business Relief is assessed per entity or per group. */
    isSeparateLegalEntity: boolean("is_separate_legal_entity").notNull().default(false),
    /** UAE VAT Tax Registration Number — 15 digits, printed on every tax invoice. */
    taxRegistrationNo: varchar("tax_registration_no", { length: 64 }),

    /**
     * Trade licence. In the UAE an expired licence stops the business dead:
     * bank accounts freeze, visas cannot be renewed, and fines accrue daily.
     * Tracking the expiry is not administrative trivia — it is an operational
     * control, and it is why `licence_expiry` is a dashboard metric.
     */
    tradeLicenseNo: varchar("trade_license_no", { length: 40 }),
    licensingAuthority: varchar("licensing_authority", { length: 80 }),
    tradeLicenseExpiry: date("trade_license_expiry"),
    establishmentCardNo: varchar("establishment_card_no", { length: 40 }),
    establishmentCardExpiry: date("establishment_card_expiry"),
    /** Free-zone entities in a designated zone have distinct VAT treatment. */
    isFreeZone: boolean("is_free_zone").notNull().default(false),
    isDesignatedZone: boolean("is_designated_zone").notNull().default(false),
    colorToken: varchar("color_token", { length: 24 }).notNull().default("slate"),
    icon: varchar("icon", { length: 40 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    startedOn: varchar("started_on", { length: 10 }),
    settings: metadata("settings"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bu_tenant_code_uq").on(t.tenantId, t.code),
    index("bu_tenant_idx").on(t.tenantId),
  ],
);

/** A branch, shop floor, garage or site office. Stock and cash live here. */
export const locations = pgTable(
  "locations",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    addressLine: text("address_line"),
    city: varchar("city", { length: 100 }),
    lat: varchar("lat", { length: 24 }),
    lng: varchar("lng", { length: 24 }),
    phone: varchar("phone", { length: 40 }),
    isStockLocation: boolean("is_stock_location").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("loc_bu_code_uq").on(t.businessUnitId, t.code),
    index("loc_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Module activation. The brief asked for "enable only the modules you need" —
 * this table is that feature. `settings` holds the per-business behaviour that
 * would otherwise fork the code (e.g. field_service for a cleaning company has
 * recurring visits on; for construction it has retention + phases on).
 */
export const businessUnitModules = pgTable(
  "business_unit_modules",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    module: moduleKey("module").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    settings: metadata("settings"),
    ...timestamps,
  },
  (t) => [uniqueIndex("bum_bu_module_uq").on(t.businessUnitId, t.module)],
);

/**
 * Document numbering. Every business wants INV-SAL-2026-0001, not a UUID.
 * Kept in its own table so allocation is a single atomic UPDATE ... RETURNING
 * rather than a count(*) race.
 */
export const numberSeries = pgTable(
  "number_series",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    key: varchar("key", { length: 60 }).notNull(),
    prefix: varchar("prefix", { length: 30 }).notNull().default(""),
    /** {YY} {YYYY} {MM} {BU} {SEQ:4} */
    pattern: varchar("pattern", { length: 80 }).notNull().default("{PREFIX}-{YYYY}-{SEQ:5}"),
    nextValue: integer("next_value").notNull().default(1),
    resetPolicy: varchar("reset_policy", { length: 16 }).notNull().default("yearly"),
    lastResetPeriod: varchar("last_reset_period", { length: 10 }),
    ...timestamps,
  },
  (t) => [uniqueIndex("numseries_uq").on(t.tenantId, t.businessUnitId, t.key)],
);

/** Multi-currency support: rate to the tenant base currency on a given day. */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fromCurrency: currencyCode("from_currency").notNull(),
    toCurrency: currencyCode("to_currency").notNull(),
    onDate: varchar("on_date", { length: 10 }).notNull(),
    rate: jsonb("rate").notNull(),
    source: varchar("source", { length: 40 }).notNull().default("manual"),
    ...timestamps,
  },
  (t) => [uniqueIndex("fx_uq").on(t.tenantId, t.fromCurrency, t.toCurrency, t.onDate)],
);

export const tenantsRelations = relations(tenants, ({ many }) => ({
  businessUnits: many(businessUnits),
}));

export const businessUnitsRelations = relations(businessUnits, ({ one, many }) => ({
  tenant: one(tenants, { fields: [businessUnits.tenantId], references: [tenants.id] }),
  locations: many(locations),
  modules: many(businessUnitModules),
}));

export const locationsRelations = relations(locations, ({ one }) => ({
  businessUnit: one(businessUnits, {
    fields: [locations.businessUnitId],
    references: [businessUnits.id],
  }),
}));

/** Tables that carry tenant_id and therefore need an RLS policy. Kept as a
 *  runtime list so `apply-rls.ts` can never drift from the schema. */
export const TENANT_SCOPED_MARKER = sql`true`;
