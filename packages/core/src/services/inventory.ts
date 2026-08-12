import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import {
  ServiceError,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * STOCK CORRECTIONS.
 *
 * Stock levels are a cache derived from the immutable `stock_moves` ledger, so
 * you never edit a level directly — you post a move that explains the change.
 * The same discipline as the general ledger, for the same reason: at any point
 * you must be able to answer "how did we get to this quantity", and a silent
 * UPDATE destroys that answer.
 *
 * A physical count almost always finds a variance (theft, breakage, miscount at
 * receipt). The variance is posted as an `adjustment` move AND to the ledger —
 * shrinkage is a real expense, and a stock count that does not hit the P&L is
 * cosmetic.
 */

export const stockAdjustmentInput = z.object({
  businessUnitId: z.uuid(),
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  /** The quantity actually counted on the shelf. */
  countedQuantity: z.number().min(0).max(10_000_000),
  reason: z.enum(["count", "damage", "theft", "correction"]).default("count"),
  note: z.string().max(500).optional(),
  onDate: z.iso.date(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function adjustStock(ctx: ServiceContext, raw: unknown) {
  const input = stockAdjustmentInput.parse(raw);
  requirePermission(ctx, "stock:adjust");
  requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "adjustStock", async () => {
    const [level] = await ctx.tx.execute<{ on_hand: string; avg_cost: string }>(sql`
      SELECT on_hand, avg_cost FROM stock_levels
       WHERE warehouse_id = ${input.warehouseId}::uuid AND item_id = ${input.itemId}::uuid
       FOR UPDATE
    `);
    const onHand = M.fromDb(level?.on_hand);
    const avgCost = M.fromDb(level?.avg_cost);
    const counted = M.money(input.countedQuantity);
    const delta = M.quantize(M.sub(counted, onHand));

    // No variance, no work. Recording a zero-quantity move would just add noise
    // to the ledger the owner has to read.
    //
    // This was `Math.abs(delta) < 0.0001`. That is not a tolerance being
    // removed — 0.0001 IS one unit at numeric(18,4), so "smaller than a storage
    // unit" and "zero once quantized" are the same statement. It is said
    // exactly now rather than approximately.
    if (M.isZero(delta)) {
      return { itemId: input.itemId, delta: 0, varianceValue: 0, adjusted: false };
    }

    const varianceValue = M.quantize(M.mul(delta, avgCost));

    await ctx.tx.execute(sql`
      INSERT INTO stock_moves
        (id, tenant_id, business_unit_id, warehouse_id, item_id, quantity,
         unit_cost, reason, occurred_at, note)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId}::uuid,
         ${input.warehouseId}::uuid, ${input.itemId}::uuid, ${M.toDb(delta)},
         ${M.toDb(avgCost)}, ${input.reason === "count" ? "adjustment" : input.reason === "theft" || input.reason === "damage" ? "damage" : "adjustment"}::stock_move_reason,
         ${input.onDate}::timestamptz, ${input.note ?? `Stock ${input.reason}`})
    `);

    // Update the existing (variant-less) level, or create it. ON CONFLICT is
    // avoided deliberately: the unique index includes variant_id, and NULLs are
    // distinct in a standard unique index, so an upsert on a NULL variant would
    // silently insert a duplicate rather than update.
    const updated = await ctx.tx.execute<{ id: string }>(sql`
      UPDATE stock_levels
         SET on_hand = ${M.toDb(counted)}, last_counted_at = now(), updated_at = now()
       WHERE warehouse_id = ${input.warehouseId}::uuid AND item_id = ${input.itemId}::uuid
         AND variant_id IS NULL
      RETURNING id
    `);
    if (updated.length === 0) {
      await ctx.tx.execute(sql`
        INSERT INTO stock_levels (id, tenant_id, warehouse_id, item_id, on_hand, avg_cost, last_counted_at)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.warehouseId}::uuid,
                ${input.itemId}::uuid, ${M.toDb(counted)}, ${M.toDb(avgCost)}, now())
      `);
    }

    // Ledger. A shortfall is an expense; a surplus reverses one. Either way the
    // inventory asset moves to match the count.
    // Post whenever the variance is non-zero at storage precision. The old
    // `>= 0.01` skipped sub-fils variances, which quietly let the inventory
    // asset drift out of agreement with the stock ledger it is supposed to
    // mirror. If a move is worth recording, its value is worth posting.
    if (!M.isZero(varianceValue)) {
      await postJournal(ctx, {
        postingDate: input.onDate,
        source: "stock",
        sourceTable: "stock_moves",
        sourceId: input.itemId,
        narration: `Stock ${input.reason} adjustment`,
        legs:
          M.isNegative(delta)
            ? [
                { accountKey: "OTHER_EXPENSE", businessUnitId: input.businessUnitId, debit: M.neg(varianceValue) },
                { accountKey: "INVENTORY", businessUnitId: input.businessUnitId, credit: M.neg(varianceValue) },
              ]
            : [
                { accountKey: "INVENTORY", businessUnitId: input.businessUnitId, debit: varianceValue },
                { accountKey: "OTHER_EXPENSE", businessUnitId: input.businessUnitId, credit: varianceValue },
              ],
      });
    }

    await writeAudit(ctx, {
      action: "stock.adjust",
      entityTable: "stock_levels",
      entityId: input.itemId,
      businessUnitId: input.businessUnitId,
      diff: { was: M.toDb(onHand), now: M.toDb(counted), delta: M.toDb(delta),
              varianceValue: M.toDb(varianceValue), reason: input.reason },
    });

    return {
      itemId: input.itemId,
      delta: M.toNumber(delta),
      varianceValue: M.toNumber(varianceValue),
      adjusted: true,
    };
  });
}
