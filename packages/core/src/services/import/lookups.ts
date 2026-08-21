import { sql } from "drizzle-orm";
import type { ImportContext } from "./types.ts";

/**
 * RESOLVING WHAT THE FILE POINTS AT.
 *
 * Every importer past the trial balance has to turn a human token — "Flat 402",
 * "Ahmed Al Mansoori", "SKU-1180" — into a primary key. Three rules apply to
 * all of them, and they are here rather than repeated per importer because the
 * one that gets forgotten is the one that loses data:
 *
 *  1. AMBIGUITY IS AN ERROR, NOT A CHOICE. Two parties called "Ahmed" is a row
 *     the accountant must disambiguate. Picking the first is how a lease is
 *     attached to the wrong tenant, and nothing downstream will ever notice.
 *
 *  2. LOOKUPS ARE LOADED ONCE. A 400-row file resolving a party per row is 400
 *     round trips inside one transaction, holding it open long enough to matter.
 *     The whole index is read up front; these tables are small in this
 *     portfolio, and the dry run has to be fast enough that people actually run
 *     it twice.
 *
 *  3. MATCHING IS NORMALISED, NEVER FUZZY. Case and surrounding whitespace are
 *     noise; spelling is not. "Ahmad" and "Ahmed" are different people, and an
 *     importer that decides otherwise is inventing a merge nobody approved.
 */

export interface Indexed {
  id: string;
  /** Every token this record answers to, already normalised. */
  keys: string[];
  label: string;
}

export type Resolution = { found: Indexed } | "ambiguous" | null;

export function normaliseToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Phone numbers match on digits only: +971 50 123 4567 is 0501234567. */
export function normalisePhone(value: string): string {
  const digits = value.replace(/\D+/g, "");
  if (digits === "") return "";
  // UAE numbers arrive as 050…, 9715 0…, +9715 0… — the last nine digits are
  // the part that identifies the subscriber under all three.
  return digits.length > 9 ? digits.slice(-9) : digits;
}

export class Index {
  private readonly byKey = new Map<string, Indexed[]>();

  constructor(records: Indexed[]) {
    for (const record of records) {
      for (const key of record.keys) {
        if (key === "") continue;
        const bucket = this.byKey.get(key);
        if (bucket) bucket.push(record);
        else this.byKey.set(key, [record]);
      }
    }
  }

  resolve(token: string): Resolution {
    const key = normaliseToken(token);
    if (key === "") return null;
    const bucket = this.byKey.get(key);
    if (!bucket || bucket.length === 0) return null;
    if (bucket.length > 1) {
      // Same record reached by two of its own keys is not ambiguity.
      const unique = new Set(bucket.map((b) => b.id));
      if (unique.size > 1) return "ambiguous";
    }
    return { found: bucket[0]! };
  }

  get size(): number {
    return new Set([...this.byKey.values()].flat().map((r) => r.id)).size;
  }
}

export async function partyIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{
    id: string;
    code: string | null;
    display_name: string;
    primary_phone: string | null;
    email: string | null;
  }>(sql`
    SELECT id, code, display_name, primary_phone, email
      FROM parties WHERE deleted_at IS NULL
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.display_name,
      keys: [
        normaliseToken(r.code ?? ""),
        normaliseToken(r.display_name),
        normalisePhone(r.primary_phone ?? ""),
        normaliseToken(r.email ?? ""),
      ],
    })),
  );
}

export async function unitIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{ id: string; code: string; name: string | null; site: string }>(
    sql`
      SELECT u.id, u.code, u.name, s.name AS site
        FROM units u JOIN sites s ON s.id = u.site_id
       WHERE u.deleted_at IS NULL
    `,
  );
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.name ? `${r.code} · ${r.name}` : `${r.code} · ${r.site}`,
      // A unit code is only unique per site in practice ("402" exists in every
      // tower), so the site-qualified form is offered as well and the bare code
      // resolves to ambiguous when two sites both have it — which is correct.
      keys: [normaliseToken(r.code), normaliseToken(`${r.site} ${r.code}`)],
    })),
  );
}

export async function siteIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{ id: string; code: string | null; name: string }>(sql`
    SELECT id, code, name FROM sites WHERE deleted_at IS NULL
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.name,
      keys: [normaliseToken(r.code ?? ""), normaliseToken(r.name)],
    })),
  );
}

export async function itemIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{
    id: string;
    sku: string | null;
    barcode: string | null;
    name: string;
  }>(sql`
    SELECT id, sku, barcode, name FROM items WHERE deleted_at IS NULL AND is_active = true
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.sku ? `${r.sku} · ${r.name}` : r.name,
      keys: [
        normaliseToken(r.sku ?? ""),
        normaliseToken(r.barcode ?? ""),
        normaliseToken(r.name),
      ],
    })),
  );
}

export async function warehouseIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{ id: string; code: string; name: string }>(sql`
    SELECT id, code, name FROM warehouses WHERE deleted_at IS NULL AND is_active = true
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: `${r.code} · ${r.name}`,
      keys: [normaliseToken(r.code), normaliseToken(r.name)],
    })),
  );
}

export async function businessUnitIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{ id: string; code: string; name: string }>(sql`
    SELECT id, code, name FROM business_units WHERE deleted_at IS NULL
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.name,
      keys: [normaliseToken(r.code), normaliseToken(r.name)],
    })),
  );
}

export async function leaseIndex(ctx: ImportContext): Promise<Index> {
  const rows = await ctx.tx.execute<{ id: string; lease_number: string }>(sql`
    SELECT id, lease_number FROM leases WHERE deleted_at IS NULL
  `);
  return new Index(
    rows.map((r) => ({
      id: r.id,
      label: r.lease_number,
      keys: [normaliseToken(r.lease_number)],
    })),
  );
}
