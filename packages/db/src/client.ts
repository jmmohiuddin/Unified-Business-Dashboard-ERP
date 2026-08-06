import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let _adminDb: Db | null = null;
let _appDb: Db | null = null;

function connect(url: string, max: number): Db {
  const client = postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    // Numerics come back as strings. Deliberate: silently coercing money to a
    // JS float is how ERPs end up 0.01 out on a million-row ledger.
    types: {},
    onnotice: () => {},
  });
  return drizzle(client, { schema, casing: "snake_case" });
}

/**
 * Owner connection. Migrations, RLS setup, seeding, and platform-admin jobs
 * only. This role bypasses RLS — never serve a user request from it.
 */
export function adminDb(): Db {
  if (!_adminDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _adminDb = connect(url, 5);
  }
  return _adminDb;
}

/**
 * Application connection. Runs as `nexus_app`, which is NOT the table owner and
 * does NOT have BYPASSRLS, so the policies in sql/rls.ts are actually enforced.
 */
export function appDb(): Db {
  if (!_appDb) {
    const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("APP_DATABASE_URL is not set");
    _appDb = connect(url, 20);
  }
  return _appDb;
}

export interface TenantContext {
  tenantId: string;
  userId?: string;
  /** Empty array = every business the membership can see. */
  businessUnitIds?: string[];
}

/**
 * THE ONLY sanctioned way to read tenant data.
 *
 * Two things matter here and both are easy to get wrong:
 *
 *  1. `SET LOCAL` inside an explicit transaction — not `SET` on the pooled
 *     connection. A pooled connection outlives the request; a plain `SET` leaks
 *     one tenant's context into the next tenant's query. This is the single
 *     most common way multi-tenant RLS is silently broken in production.
 *
 *  2. `set_config(..., true)` with the `true` (is_local) argument, parameterised
 *     rather than interpolated, so a crafted tenant id cannot inject SQL.
 *
 * Every query inside the callback is automatically filtered to this tenant by
 * the database itself, independent of whether the application code remembered
 * its WHERE clause.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return appDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`,
    );
    if (ctx.userId) {
      await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
    }
    return fn(tx);
  });
}

/** Escape hatch for the auth path, which must read users/sessions before any
 *  tenant is known. Keep the surface of this function tiny and audited. */
export async function withoutTenant<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(appDb());
}

export { schema };
