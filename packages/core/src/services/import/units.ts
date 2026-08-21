import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { Index, normaliseToken, siteIndex, unitIndex } from "./lookups.ts";
import {
  CellError,
  byRowNumber,
  readEnum,
  readInteger,
  readMoney,
  readQuantity,
  readText,
  toIssue,
} from "./source.ts";
import type {
  ApplyOutcome,
  BatchRecorder,
  ImportContext,
  ImportPlan,
  Importer,
  PlannedRow,
  RowIssue,
  SourceRow,
} from "./types.ts";

/**
 * RENTAL UNITS — the flats, shops and parking bays themselves.
 *
 * Imported before leases, because a lease without a unit is a rejected row and
 * the wireframe's review step shows exactly that: "3 rejected — no unit match".
 *
 * CREATE ONLY. A unit that already exists at that site is SKIPPED, never
 * updated. The reason is the one field that matters: `status`. A unit's status
 * is live operational state — occupied, on notice, under maintenance — and a
 * migration file is a snapshot of what the owner's spreadsheet believed at
 * export time. Letting the file overwrite status would mark an occupied flat
 * available and put it back on the vacancy board while somebody is living in
 * it. Skipping is the conservative reading and the diff says so per row.
 */

const COLUMNS = [
  "site",
  "code",
  "name",
  "kind",
  "status",
  "floor",
  "area_sqft",
  "bedrooms",
  "bathrooms",
  "list_rent",
  "list_frequency",
  "deposit_months",
  "notes",
] as const;

const UNIT_KINDS = [
  "apartment",
  "room",
  "shop",
  "office",
  "warehouse",
  "parking_bay",
  "storage",
  "land",
] as const;

const UNIT_STATUSES = [
  "available",
  "reserved",
  "occupied",
  "notice",
  "maintenance",
  "off_market",
] as const;

const FREQUENCIES = ["one_off", "daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export interface UnitPlanRow {
  siteId: string;
  code: string;
  name: string | null;
  kind: (typeof UNIT_KINDS)[number];
  status: (typeof UNIT_STATUSES)[number];
  floor: string | null;
  areaSqft: M.Money | null;
  bedrooms: number | null;
  bathrooms: number | null;
  listRent: M.Money;
  listFrequency: (typeof FREQUENCIES)[number];
  depositMonths: M.Money;
  notes: string | null;
}

export function planUnits(rows: SourceRow[], sites: Index, units: Index): ImportPlan {
  const planned: PlannedRow<UnitPlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const seen = new Map<string, number>();
  let annualisedRent = M.ZERO;
  let creates = 0;

  for (const row of rows) {
    try {
      const siteToken = readText(row, "site", { max: 200, required: true });
      const site = sites.resolve(siteToken);
      if (site === null) {
        throw new CellError(
          "site",
          `No building or site called "${siteToken}". Create it first, or correct the spelling.`,
        );
      }
      if (site === "ambiguous") {
        throw new CellError("site", `"${siteToken}" matches more than one site. Use its code.`);
      }

      const code = readText(row, "code", { max: 20, required: true });
      const key = `${site.found.id}:${normaliseToken(code)}`;
      const duplicate = seen.get(key);
      if (duplicate !== undefined) {
        throw new CellError(
          "code",
          `Unit ${code} at ${site.found.label} is already on row ${duplicate}.`,
        );
      }
      seen.set(key, row.rowNumber);

      const listRent = readMoney(row, "list_rent", M.ZERO);
      if (M.isNegative(listRent)) throw new CellError("list_rent", "Rent cannot be negative.");

      const payload: UnitPlanRow = {
        siteId: site.found.id,
        code,
        name: readText(row, "name", { max: 200 }) || null,
        kind: readEnum(row, "kind", UNIT_KINDS, "apartment"),
        status: readEnum(row, "status", UNIT_STATUSES, "available"),
        floor: readText(row, "floor", { max: 20 }) || null,
        areaSqft: row.has("area_sqft") ? readQuantity(row, "area_sqft") : null,
        bedrooms: row.has("bedrooms") ? readInteger(row, "bedrooms", { min: 0, max: 20 }) : null,
        bathrooms: row.has("bathrooms") ? readInteger(row, "bathrooms", { min: 0, max: 20 }) : null,
        listRent,
        listFrequency: readEnum(row, "list_frequency", FREQUENCIES, "yearly"),
        depositMonths: readQuantity(row, "deposit_months", M.money(1)),
        notes: readText(row, "notes", { max: 2000 }) || null,
      };

      // The site-qualified form is what `unitIndex` keys on; a bare code that
      // exists in two towers resolves ambiguous, which is why the qualified
      // token is tried first.
      const existing = units.resolve(`${site.found.label} ${code}`);
      if (existing && existing !== "ambiguous") {
        planned.push({
          rowNumber: row.rowNumber,
          action: "skip",
          label: `${code} · ${site.found.label}`,
          detail: "Already on file. Units are never overwritten by an import.",
          payload,
        });
        continue;
      }

      creates++;
      annualisedRent = M.add(annualisedRent, annualise(listRent, payload.listFrequency));

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: `${code} · ${site.found.label}`,
        detail: `${payload.kind.replace("_", " ")} · ${payload.status}`,
        amount: listRent,
        payload,
      });
    } catch (err) {
      rejected.push(toIssue(row.rowNumber, err));
    }
  }

  return {
    rows: planned,
    rejected: rejected.sort(byRowNumber),
    blockers: [],
    totals: [
      { label: "Units to create", amount: M.money(creates) },
      { label: "Annualised list rent", amount: M.quantize(annualisedRent) },
    ],
    notes: [
      "Units that already exist at that site are skipped, never overwritten — a file " +
        "cannot mark an occupied flat available.",
      "Sites and buildings are not created by this import. A unit whose site is not " +
        "already on file is rejected.",
    ],
    expectedLines: [],
    totalDebit: M.ZERO,
    totalCredit: M.ZERO,
  };
}

/** Twelve months of rent, whatever cadence the file states it in. */
function annualise(amount: M.Money, frequency: (typeof FREQUENCIES)[number]): M.Money {
  switch (frequency) {
    case "monthly":
      return M.mul(amount, 12);
    case "quarterly":
      return M.mul(amount, 4);
    case "weekly":
      return M.mul(amount, 52);
    case "daily":
      return M.mul(amount, 365);
    default:
      return amount;
  }
}

export const unitsImporter: Importer = {
  kind: "units",
  label: "Rental units",
  description: "Flats, shops, offices and parking bays, one row each, grouped by building.",
  template: [...COLUMNS],
  required: ["site", "code"],
  permission: "unit:create",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const [sites, units] = await Promise.all([siteIndex(ctx), unitIndex(ctx)]);
    return planUnits(rows, sites, units);
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const u = row.payload as UnitPlanRow;
      const inserted = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO units
          (id, tenant_id, business_unit_id, site_id, code, name, kind, status, floor,
           area_sqft, bedrooms, bathrooms, list_rent, list_frequency, deposit_months, notes)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.businessUnitId}::uuid,
           ${u.siteId}::uuid, ${u.code}, ${u.name}, ${u.kind}::unit_kind,
           ${u.status}::unit_status, ${u.floor},
           ${u.areaSqft ? M.toDb(u.areaSqft) : null}, ${u.bedrooms}, ${u.bathrooms},
           ${M.toDb(u.listRent)}, ${u.listFrequency}::charge_frequency,
           ${M.toDb(u.depositMonths)}, ${u.notes})
        RETURNING id
      `);
      await into.record({
        rowNumber: row.rowNumber,
        action: "create",
        entityTable: "units",
        entityId: inserted[0]!.id,
      });
    }
    return {};
  },
};
