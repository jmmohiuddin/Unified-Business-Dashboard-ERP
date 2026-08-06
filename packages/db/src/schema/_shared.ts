import { sql } from "drizzle-orm";
import { numeric, timestamp, uuid, varchar, jsonb } from "drizzle-orm/pg-core";

/**
 * Column kits shared by every table. Consistency here is what makes RLS,
 * auditing and generic list/filter UI possible without per-table special cases.
 */

/** Primary key. UUIDv7 is generated in app code for index locality; the DB
 *  default is a safety net for hand-written SQL. */
export const pk = () =>
  uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/**
 * Money.
 *
 * numeric(18,4) — never float, never integer-cents. 4 dp because unit prices,
 * FX rates and percentage-based commission all round badly at 2 dp; documents
 * round to currency precision only at presentation and posting time.
 */
export const money = (name: string) => numeric(name, { precision: 18, scale: 4 });

/** Quantities: 4 dp handles 0.5 hours of labour and 2.25 kg of cable. */
export const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

/** Rates/percentages stored as a fraction: 0.15 = 15%. */
export const rate = (name: string) => numeric(name, { precision: 9, scale: 6 });

export const currencyCode = (name = "currency") => varchar(name, { length: 3 });

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. Nothing financial is ever hard-deleted — auditors and tax
   *  authorities both require the row to survive. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

export const actorColumns = {
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
};

/** Escape hatch for per-tenant fields we refuse to model as columns. */
export const metadata = (name = "metadata") => jsonb(name).notNull().default(sql`'{}'::jsonb`);
