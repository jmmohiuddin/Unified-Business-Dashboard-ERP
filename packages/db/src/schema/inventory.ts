import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { stockMoveReason } from "./_enums.ts";
import { metadata, money, pk, qty, timestamps } from "./_shared.ts";
import { businessUnits, locations, tenants } from "./tenancy.ts";
import { items, itemVariants } from "./catalog.ts";
import { parties } from "./parties.ts";

export const warehouses = pgTable(
  "warehouses",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    /** A technician's van is a warehouse. Modelling it as one is what makes
     *  "which parts are actually on Karim's van right now" answerable. */
    isMobileVan: boolean("is_mobile_van").notNull().default(false),
    custodianEmployeeId: uuid("custodian_employee_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("warehouses_bu_code_uq").on(t.businessUnitId, t.code)],
);

/**
 * Immutable movement ledger. Stock levels are DERIVED from this, never edited
 * directly — the same discipline as the general ledger, for the same reason:
 * you must be able to explain how you got to today's quantity.
 *
 * Sign convention: quantity is positive into `warehouseId`, negative out.
 */
export const stockMoves = pgTable(
  "stock_moves",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "restrict" }),
    serialUnitId: uuid("serial_unit_id"),
    batchNo: varchar("batch_no", { length: 60 }),
    expiryDate: date("expiry_date"),

    quantity: qty("quantity").notNull(),
    unitCost: money("unit_cost").notNull().default("0"),
    reason: stockMoveReason("reason").notNull(),

    /** Polymorphic backlink to whatever caused the move. */
    sourceTable: varchar("source_table", { length: 63 }),
    sourceId: uuid("source_id"),
    /** Pairs the two halves of a transfer. */
    transferGroupId: uuid("transfer_group_id"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("stock_moves_item_wh_idx").on(t.itemId, t.warehouseId, t.occurredAt),
    index("stock_moves_tenant_at_idx").on(t.tenantId, t.occurredAt),
    index("stock_moves_source_idx").on(t.sourceTable, t.sourceId),
  ],
);

/**
 * Materialised on-hand cache. Updated in the same transaction as the move.
 * Exists purely so a POS scan does not sum a million-row ledger.
 */
export const stockLevels = pgTable(
  "stock_levels",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "cascade" }),
    onHand: qty("on_hand").notNull().default("0"),
    /** Committed to unfulfilled orders / booked jobs. available = onHand − reserved */
    reserved: qty("reserved").notNull().default("0"),
    incoming: qty("incoming").notNull().default("0"),
    avgCost: money("avg_cost").notNull().default("0"),
    lastCountedAt: timestamp("last_counted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("stock_levels_uq").on(t.warehouseId, t.itemId, t.variantId)],
);

/**
 * One row per physical serialised unit — the IMEI table for the mobile shop.
 * This is also the warranty spine: a customer walks in with a handset, you scan
 * the IMEI, and you instantly have the sale, the price, the warranty end date
 * and every prior repair.
 */
export const serialUnits = pgTable(
  "serial_units",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "restrict" }),
    serialNo: varchar("serial_no", { length: 80 }).notNull(),
    secondarySerialNo: varchar("secondary_serial_no", { length: 80 }),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).notNull().default("in_stock"),
    purchaseCost: money("purchase_cost"),
    soldPrice: money("sold_price"),
    soldToPartyId: uuid("sold_to_party_id").references(() => parties.id, {
      onDelete: "set null",
    }),
    soldOn: date("sold_on"),
    warrantyEndsOn: date("warranty_ends_on"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("serial_units_serial_uq").on(t.tenantId, t.serialNo),
    index("serial_units_item_status_idx").on(t.itemId, t.status),
  ],
);

/** Physical count sessions — variance is posted as an `adjustment` move. */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 40 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    countedByUserId: uuid("counted_by_user_id"),
    varianceValue: money("variance_value"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("stock_counts_wh_idx").on(t.warehouseId)],
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "restrict" }),
    expectedQty: qty("expected_qty").notNull().default("0"),
    countedQty: qty("counted_qty").notNull().default("0"),
    unitCost: money("unit_cost").notNull().default("0"),
  },
  (t) => [index("stock_count_lines_count_idx").on(t.stockCountId)],
);

/** Supplier terms — separate from `parties` because they are inherently
 *  per-business (the salon and the shop buy from the same distributor on
 *  different terms). */
export const supplierProfiles = pgTable(
  "supplier_profiles",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    paymentTermDays: money("payment_term_days").notNull().default("0"),
    leadTimeDays: money("lead_time_days").notNull().default("7"),
    minOrderValue: money("min_order_value"),
    /** Rolling on-time delivery %, used by the reorder planner. */
    reliabilityScore: money("reliability_score"),
    preferredForCategories: metadata("preferred_for_categories"),
    ...timestamps,
  },
  (t) => [uniqueIndex("supplier_profiles_uq").on(t.partyId, t.businessUnitId)],
);

export const stockMovesRelations = relations(stockMoves, ({ one }) => ({
  item: one(items, { fields: [stockMoves.itemId], references: [items.id] }),
  warehouse: one(warehouses, {
    fields: [stockMoves.warehouseId],
    references: [warehouses.id],
  }),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  item: one(items, { fields: [stockLevels.itemId], references: [items.id] }),
  warehouse: one(warehouses, {
    fields: [stockLevels.warehouseId],
    references: [warehouses.id],
  }),
}));
