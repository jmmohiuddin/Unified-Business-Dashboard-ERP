import { sql } from "drizzle-orm";
import * as M from "../../money/index.ts";
import { Index, itemIndex, normaliseToken, warehouseIndex } from "./lookups.ts";
import { CellError, byRowNumber, readMoney, readQuantity, readText, toIssue } from "./source.ts";
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
 * OPENING STOCK — what is on the shelf on day one, and what it cost.
 *
 * The same split as everywhere else in this feature: the QUANTITY comes from
 * the physical count, the VALUE comes from the trial balance's inventory line
 * (1300 / INVENTORY). This importer therefore sets stock levels and posts
 * nothing. Running it through `adjustStock`, which does post, would add the
 * inventory value to the ledger a second time on top of the opening balance —
 * and it would do so while balancing, which is what makes that class of error
 * so expensive to find.
 *
 * The count is written as a `stock_counts` record with lines, not as a bare
 * level update, because that is the artefact an auditor asks for: a dated,
 * referenced count with a name against it. A stock level that appeared from
 * nowhere is not evidence of anything.
 *
 * THE NULL-VARIANT TRAP. `stock_levels_uq` is UNIQUE on
 * (warehouse_id, item_id, variant_id) and Postgres treats NULLs as DISTINCT by
 * default, so `ON CONFLICT` does NOT dedupe an item with no variant — two
 * inserts both succeed and the item then has two level rows that disagree.
 * Every read after that returns whichever one it happened to join. This
 * importer therefore reads the level, then inserts or updates explicitly. It is
 * the same trap PRD EC-06 records as still open elsewhere; it is closed here.
 */

const COLUMNS = ["sku", "item_name", "counted_qty", "unit_cost", "note"] as const;

export interface StockPlanRow {
  itemId: string;
  itemLabel: string;
  countedQty: M.Money;
  unitCost: M.Money;
  value: M.Money;
}

export function planStock(rows: SourceRow[], items: Index, warehouseLabel: string): ImportPlan {
  const planned: PlannedRow<StockPlanRow>[] = [];
  const rejected: RowIssue[] = [];
  const seen = new Map<string, number>();

  let value = M.ZERO;
  let lines = 0;

  for (const row of rows) {
    try {
      const token =
        readText(row, "sku", { max: 100 }) || readText(row, "item_name", { max: 200, required: true });
      const item = items.resolve(token);
      if (item === null) {
        throw new CellError(
          "sku",
          `No catalogue item matches "${token}". Items are not created by this import — ` +
            `add it to the catalogue first.`,
        );
      }
      if (item === "ambiguous") {
        throw new CellError("sku", `"${token}" matches more than one item. Use the SKU.`);
      }

      const duplicate = seen.get(normaliseToken(item.found.id));
      if (duplicate !== undefined) {
        throw new CellError(
          "sku",
          `${item.found.label} is already on row ${duplicate}. A count has one line per item.`,
        );
      }
      seen.set(normaliseToken(item.found.id), row.rowNumber);

      const countedQty = readQuantity(row, "counted_qty");
      if (M.isNegative(countedQty)) {
        throw new CellError(
          "counted_qty",
          "A physical count cannot be negative. If the system says less than zero, that is " +
            "the variance the count is meant to correct.",
        );
      }

      const unitCost = readMoney(row, "unit_cost", M.ZERO);
      if (M.isNegative(unitCost)) throw new CellError("unit_cost", "Unit cost cannot be negative.");
      if (M.gt(countedQty, M.ZERO) && M.isZero(unitCost)) {
        throw new CellError(
          "unit_cost",
          "Stock with no cost values the inventory at nothing, which will not tie to your " +
            "trial balance. Give a cost, even an estimated one.",
        );
      }

      const lineValue = M.quantize(M.mul(countedQty, unitCost));
      value = M.add(value, lineValue);
      lines++;

      planned.push({
        rowNumber: row.rowNumber,
        action: "create",
        label: item.found.label,
        detail: `${M.toDisplay(countedQty)} × ${M.toDisplay(unitCost)} = ${M.toDisplay(lineValue)}`,
        amount: lineValue,
        payload: {
          itemId: item.found.id,
          itemLabel: item.found.label,
          countedQty,
          unitCost,
          value: lineValue,
        },
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
      { label: "Lines counted", amount: M.money(lines) },
      { label: `Stock value at ${warehouseLabel} (must equal 1300)`, amount: M.quantize(value) },
    ],
    notes: [
      "Nothing here posts to the ledger. Inventory value comes from your trial balance; " +
        "this sets the quantities behind it.",
      "Existing stock levels for these items are REPLACED by the counted quantity — that " +
        "is what a count means.",
    ],
    expectedLines: [],
    totalDebit: M.quantize(value),
    totalCredit: M.ZERO,
  };
}

export const stockImporter: Importer = {
  kind: "stock",
  label: "Opening stock count",
  description: "What is physically on the shelf, and what it cost. One row per item.",
  template: [...COLUMNS],
  required: ["counted_qty"],
  permission: "stock:count",
  requiresBusinessUnit: true,

  async plan(ctx, rows) {
    const [items, warehouses] = await Promise.all([itemIndex(ctx), warehouseIndex(ctx)]);
    const target = resolveWarehouse(ctx, warehouses);
    if (typeof target === "string") {
      return {
        rows: [],
        rejected: [],
        blockers: [target],
        totals: [],
        notes: [],
        expectedLines: [],
        totalDebit: M.ZERO,
        totalCredit: M.ZERO,
      };
    }
    return planStock(rows, items, target.label);
  },

  async apply(ctx: ImportContext, plan: ImportPlan, into: BatchRecorder): Promise<ApplyOutcome> {
    const warehouses = await warehouseIndex(ctx);
    const target = resolveWarehouse(ctx, warehouses);
    if (typeof target === "string") return {};

    const reference = `IMP-${into.batchId.slice(0, 8).toUpperCase()}`;
    const count = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO stock_counts
        (id, tenant_id, warehouse_id, reference, status, counted_at, counted_by_user_id,
         variance_value, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${target.id}::uuid, ${reference},
         'counted', now(), ${ctx.principal.userId}::uuid, '0',
         'Opening stock, imported')
      RETURNING id
    `);
    const countId = count[0]!.id;
    // The lines cascade from the count, so recording the parent is enough for
    // the reversal to take the whole thing away.
    await into.record({
      rowNumber: 1,
      action: "create",
      entityTable: "stock_counts",
      entityId: countId,
    });

    for (const row of plan.rows) {
      if (row.action !== "create") continue;
      const s = row.payload as StockPlanRow;

      const existing = await ctx.tx.execute<{ id: string; on_hand: string; avg_cost: string }>(sql`
        SELECT id, on_hand, avg_cost FROM stock_levels
         WHERE warehouse_id = ${target.id}::uuid AND item_id = ${s.itemId}::uuid
           AND variant_id IS NULL
      `);

      await ctx.tx.execute(sql`
        INSERT INTO stock_count_lines
          (id, tenant_id, stock_count_id, item_id, expected_qty, counted_qty, unit_cost)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${countId}::uuid, ${s.itemId}::uuid,
           ${existing[0] ? M.toDb(M.fromDb(existing[0].on_hand)) : "0"},
           ${M.toDb(s.countedQty)}, ${M.toDb(s.unitCost)})
      `);

      if (existing.length > 0) {
        await ctx.tx.execute(sql`
          UPDATE stock_levels
             SET on_hand = ${M.toDb(s.countedQty)}, avg_cost = ${M.toDb(s.unitCost)},
                 last_counted_at = now(), updated_at = now()
           WHERE id = ${existing[0]!.id}::uuid
        `);
        await into.record({
          rowNumber: row.rowNumber,
          action: "update",
          entityTable: "stock_levels",
          entityId: existing[0]!.id,
          previous: { on_hand: existing[0]!.on_hand, avg_cost: existing[0]!.avg_cost },
        });
      } else {
        const level = await ctx.tx.execute<{ id: string }>(sql`
          INSERT INTO stock_levels
            (id, tenant_id, warehouse_id, item_id, on_hand, avg_cost, last_counted_at)
          VALUES
            (gen_random_uuid(), ${ctx.tenantId}::uuid, ${target.id}::uuid, ${s.itemId}::uuid,
             ${M.toDb(s.countedQty)}, ${M.toDb(s.unitCost)}, now())
          RETURNING id
        `);
        await into.record({
          rowNumber: row.rowNumber,
          action: "create",
          entityTable: "stock_levels",
          entityId: level[0]!.id,
        });
      }
    }
    return {};
  },
};

/** The warehouse is a batch setting, not a column — see `ImportOptions`. */
function resolveWarehouse(
  ctx: ImportContext,
  warehouses: Index,
): { id: string; label: string } | string {
  const token = ctx.options.warehouse ?? "";
  if (token.trim() === "") {
    return "Choose which warehouse this count is for before uploading.";
  }
  const hit = warehouses.resolve(token);
  if (hit === null) return `No warehouse matches "${token}".`;
  if (hit === "ambiguous") return `"${token}" matches more than one warehouse. Use its code.`;
  return { id: hit.found.id, label: hit.found.label };
}
