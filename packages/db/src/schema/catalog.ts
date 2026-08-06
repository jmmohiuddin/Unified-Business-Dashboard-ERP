import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { itemType, trackingMode } from "./_enums.ts";
import { metadata, money, pk, rate, timestamps } from "./_shared.ts";
import { businessUnits, tenants } from "./tenancy.ts";

/** Tenant-defined category tree — shared by products and services. */
export const categories = pgTable(
  "categories",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 140 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("categories_slug_uq").on(t.tenantId, t.businessUnitId, t.slug)],
);

/**
 * Products AND services in one table.
 *
 * A haircut, an hour of AC servicing, a Samsung A55 and a monthly parking bay
 * are all "something you put on an invoice line with a price and a revenue
 * account". Splitting them creates two of every downstream feature — two price
 * lists, two POS grids, two tax rules. `type` + `trackingMode` carry the
 * difference.
 */
export const items = pgTable(
  "items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL = shared across every business (a generic "Delivery" fee). */
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    type: itemType("type").notNull().default("product"),
    sku: varchar("sku", { length: 60 }),
    barcode: varchar("barcode", { length: 60 }),
    name: varchar("name", { length: 250 }).notNull(),
    description: text("description"),
    uom: varchar("uom", { length: 20 }).notNull().default("unit"),

    trackingMode: trackingMode("tracking_mode").notNull().default("none"),
    isSellable: boolean("is_sellable").notNull().default(true),
    isPurchasable: boolean("is_purchasable").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),

    salePrice: money("sale_price").notNull().default("0"),
    /** Moving-average cost, recalculated on every inbound stock move. */
    costPrice: money("cost_price").notNull().default("0"),
    taxCodeId: uuid("tax_code_id"),

    /** Services: how long the appointment/visit blocks a resource. */
    durationMinutes: integer("duration_minutes"),
    requiresSkillKey: varchar("requires_skill_key", { length: 60 }),

    /** Inventory planning inputs. Reorder point is *calculated* from lead time
     *  and demand by the planner job, but can be pinned manually. */
    reorderPoint: money("reorder_point"),
    reorderQty: money("reorder_qty"),
    leadTimeDays: integer("lead_time_days"),

    /** Commission override; falls back to the employee's rule when null. */
    commissionRate: rate("commission_rate"),

    imageUrl: text("image_url"),
    attributes: metadata("attributes"),
    ...timestamps,
  },
  (t) => [
    index("items_tenant_name_idx").on(t.tenantId, t.name),
    index("items_bu_type_idx").on(t.businessUnitId, t.type),
    uniqueIndex("items_tenant_sku_uq").on(t.tenantId, t.sku),
    index("items_barcode_idx").on(t.tenantId, t.barcode),
  ],
);

/** Colour/size/capacity variants. A phone shop needs 128GB vs 256GB. */
export const itemVariants = pgTable(
  "item_variants",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 60 }),
    name: varchar("name", { length: 200 }).notNull(),
    options: jsonb("options").notNull().default(sql`'{}'::jsonb`),
    salePrice: money("sale_price"),
    costPrice: money("cost_price"),
    barcode: varchar("barcode", { length: 60 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("item_variants_item_idx").on(t.itemId),
    uniqueIndex("item_variants_sku_uq").on(t.tenantId, t.sku),
  ],
);

/** Bundles / kits — a "AC full service" package of labour + gas + filter. */
export const itemComponents = pgTable(
  "item_components",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parentItemId: uuid("parent_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    quantity: money("quantity").notNull().default("1"),
  },
  (t) => [uniqueIndex("item_components_uq").on(t.parentItemId, t.componentItemId)],
);

/**
 * Price lists: retail, wholesale, "corporate AMC contract", staff rate.
 * Resolution order is line override -> party price list -> business default.
 */
export const priceLists = pgTable(
  "price_lists",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 100 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    currency: varchar("currency", { length: 3 }).notNull().default("AED"),
    validFrom: varchar("valid_from", { length: 10 }),
    validTo: varchar("valid_to", { length: 10 }),
    ...timestamps,
  },
  (t) => [index("price_lists_tenant_idx").on(t.tenantId)],
);

export const priceListEntries = pgTable(
  "price_list_entries",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => itemVariants.id, { onDelete: "cascade" }),
    minQuantity: money("min_quantity").notNull().default("1"),
    price: money("price").notNull(),
  },
  (t) => [uniqueIndex("ple_uq").on(t.priceListId, t.itemId, t.variantId, t.minQuantity)],
);

export const itemsRelations = relations(items, ({ one, many }) => ({
  category: one(categories, { fields: [items.categoryId], references: [categories.id] }),
  businessUnit: one(businessUnits, {
    fields: [items.businessUnitId],
    references: [businessUnits.id],
  }),
  variants: many(itemVariants),
}));
