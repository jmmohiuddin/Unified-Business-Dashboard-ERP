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
 * Legal entity = the registered company that files returns and issues invoices.
 *
 * A business unit is an *operating* boundary — its own P&L, its own numbering
 * series, its own modules. A legal entity is a *statutory* one: it holds the
 * trade licence, it is the taxable person for corporate tax, and it is the
 * party whose Tax Identification Number appears on a tax invoice. The two are
 * not the same thing and the schema conflated them: TRN, trade licence,
 * establishment card and the free-zone flags all hung off `business_units`, so
 * two businesses trading under one licence were forced to duplicate the licence
 * on both rows with nothing to say they were the same registration.
 *
 * Introducing this table now, before any of it is needed, is the cheap move.
 * Two things become configuration rather than a rebuild:
 *
 *   · **E-invoicing (FR-C07).** PINT AE identifies the supplier by the entity
 *     TIN. Without an entity there is nowhere correct to put it, and the
 *     mandate has a hard date: an accredited service provider appointed by
 *     31 Mar 2027, live 1 Jul 2027. See `packages/core/src/einvoice/`.
 *   · **Corporate tax (FR-C04).** The AED 375,000 nil band and Small Business
 *     Relief are assessed per taxable person, not per business. Assessing them
 *     across a portfolio of seven businesses that are three companies gives the
 *     wrong number in both directions.
 *
 * ADDITIVE ON PURPOSE. The equivalent columns on `business_units` are left in
 * place and still populated — see the deprecation note there. Moving live
 * licence and TRN data in the same wave that introduces the table would put a
 * data migration and a schema migration in one step, and the columns are read
 * today by the compliance register and the VAT engine.
 */
export const legalEntities = pgTable(
  "legal_entities",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    /** As registered on the trade licence, which is what must appear on an
     *  invoice — not the trading name the customer knows. */
    legalName: varchar("legal_name", { length: 200 }).notNull(),
    tradeName: varchar("trade_name", { length: 200 }),

    /**
     * Tax Identification Number — the identifier the e-invoice carries.
     *
     * In the UAE this is the 15-digit VAT TRN. It is deliberately NOT named
     * `tax_registration_no`: PINT AE calls the supplier identifier a TIN, other
     * jurisdictions issue one under other names, and the field the serialiser
     * reads should be named for the role it plays in the document rather than
     * for the local paperwork that happens to supply it.
     *
     * Nullable, because an entity below the AED 375,000 registration threshold
     * genuinely has none, and a readiness screen that cannot distinguish
     * "not recorded" from "not required" is worthless. WF-05 §10.3 shows this
     * exact count — "TINs recorded 2 of 3".
     */
    taxIdentificationNumber: varchar("tax_identification_number", { length: 20 }),
    taxRegisteredOn: date("tax_registered_on"),
    /** Corporate tax registration is a separate number from the VAT TRN. */
    corporateTaxRegistrationNo: varchar("corporate_tax_registration_no", { length: 30 }),

    tradeLicenseNo: varchar("trade_license_no", { length: 40 }),
    licensingAuthority: varchar("licensing_authority", { length: 80 }),
    tradeLicenseExpiry: date("trade_license_expiry"),
    establishmentCardNo: varchar("establishment_card_no", { length: 40 }),
    establishmentCardExpiry: date("establishment_card_expiry"),
    isFreeZone: boolean("is_free_zone").notNull().default(false),
    isDesignatedZone: boolean("is_designated_zone").notNull().default(false),

    /**
     * Fiscal year end, held per entity rather than per tenant.
     *
     * `tenants.fiscal_year_start_month` assumes the whole portfolio shares one
     * year. Entities acquired or incorporated separately routinely do not, and
     * the corporate tax period follows the entity.
     */
    fiscalYearEndMonth: integer("fiscal_year_end_month").notNull().default(12),
    fiscalYearEndDay: integer("fiscal_year_end_day").notNull().default(31),

    registeredAddress: text("registered_address"),
    emirate: varchar("emirate", { length: 40 }).notNull().default("Dubai"),
    countryCode: varchar("country_code", { length: 2 }).notNull().default("AE"),

    /**
     * The appointed accredited service provider, or NULL for "not appointed".
     *
     * NULL is the honest default and the one the readiness screen counts. The
     * appointment is a commercial act with a statutory deadline, so recording
     * it is a fact about the business, not a piece of application config — an
     * environment variable would be lost on the next deploy and could not be
     * shown to the owner as a checklist row.
     */
    einvoiceProviderKey: varchar("einvoice_provider_key", { length: 40 }),
    einvoiceProviderAppointedOn: date("einvoice_provider_appointed_on"),
    /** First date this entity actually transmits. Before it, documents are
     *  serialised and stored but never sent. */
    einvoiceLiveFrom: date("einvoice_live_from"),

    isActive: boolean("is_active").notNull().default(true),
    settings: metadata("settings"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("legal_entities_tenant_code_uq").on(t.tenantId, t.code),
    index("legal_entities_tenant_idx").on(t.tenantId),
  ],
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

    /**
     * The registered company this business trades under.
     *
     * Nullable during the transition only. Every active business unit must end
     * up pointing at a `legal_entities` row — an invoice issued by a business
     * with no entity has no TIN to carry, and from 1 Jul 2027 that is not a
     * defect, it is an unfilable document. The 0003 migration backfills one
     * entity per business unit from the licence data already on this row, which
     * is the only mapping the data supports; consolidating several businesses
     * under one licence is Q-6 and needs the owner, not a guess in a migration.
     *
     * `ON DELETE SET NULL`, not cascade: deleting a legal entity must never
     * take a business and its ledger with it.
     */
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),

    /** A separate legal entity files its own VAT return and is its own taxable
     *  person for corporate tax. Drives inter-company posting and whether Small
     *  Business Relief is assessed per entity or per group.
     *
     *  DEPRECATED by `legal_entity_id`. A boolean cannot say *which* entity, so
     *  it cannot answer "these two businesses are one taxable person" — the
     *  question corporate tax and e-invoicing both ask. Still read by
     *  `uae-metrics.ts` and the compliance register; remove only once those
     *  read the entity. */
    isSeparateLegalEntity: boolean("is_separate_legal_entity").notNull().default(false),
    /** UAE VAT Tax Registration Number — 15 digits, printed on every tax invoice.
     *
     *  DEPRECATED by `legal_entities.tax_identification_number`. The TRN belongs
     *  to the registration, not to the shop floor: two businesses under one
     *  licence share one TRN and this column forces it to be stored twice with
     *  nothing to keep the copies equal. */
    taxRegistrationNo: varchar("tax_registration_no", { length: 64 }),

    /**
     * Trade licence. In the UAE an expired licence stops the business dead:
     * bank accounts freeze, visas cannot be renewed, and fines accrue daily.
     * Tracking the expiry is not administrative trivia — it is an operational
     * control, and it is why `licence_expiry` is a dashboard metric.
     *
     * DEPRECATED by the matching columns on `legal_entities`, for the same
     * reason as the TRN above: a licence is issued to a company. Left in place
     * and still authoritative this wave — `compliance/page.tsx` and the
     * `compliance_watchlist` metric both read them.
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
  legalEntities: many(legalEntities),
}));

export const legalEntitiesRelations = relations(legalEntities, ({ one, many }) => ({
  tenant: one(tenants, { fields: [legalEntities.tenantId], references: [tenants.id] }),
  businessUnits: many(businessUnits),
}));

export const businessUnitsRelations = relations(businessUnits, ({ one, many }) => ({
  tenant: one(tenants, { fields: [businessUnits.tenantId], references: [tenants.id] }),
  legalEntity: one(legalEntities, {
    fields: [businessUnits.legalEntityId],
    references: [legalEntities.id],
  }),
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
