/**
 * Metric smoke test.
 *
 * Runs every registered metric against the deterministic seed and asserts the
 * shape of the result. Because the seed is reproducible, this is also the
 * foundation of the AI evaluation suite: an answer that cites
 * `revenue_mtd = X` can be checked against a known-good X.
 *
 *   npx tsx packages/core/src/metrics/smoke.ts
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { METRICS, runMetric } from "./index.ts";
import { formatMetricValue } from "../format.ts";

config({ path: "../../.env" });
config({ path: ".env" });

async function main() {
  const db = adminDb();
  const [tenant] = await db.execute<{ id: string; base_currency: string }>(
    sql`SELECT id, base_currency FROM tenants LIMIT 1`,
  );
  if (!tenant) throw new Error("No tenant found — run `npm run db:seed` first.");

  const today = "2026-08-06";
  let failed = 0;
  const timings: { id: string; ms: number }[] = [];

  await withTenant({ tenantId: tenant.id }, async (tx) => {
    const ctx = {
      tx,
      tenantId: tenant.id,
      today,
      baseCurrency: tenant.base_currency,
      allowedBusinessUnitIds: null,
    };

    for (const def of METRICS) {
      const t0 = performance.now();
      try {
        const res = await runMetric(ctx, def.id, {});
        const ms = performance.now() - t0;
        timings.push({ id: def.id, ms });

        if (!Number.isFinite(res.value)) throw new Error(`value is not finite: ${res.value}`);

        const shown = formatMetricValue(res.value, res.unit, tenant.base_currency);
        const delta =
          res.changeRatio === null || res.changeRatio === undefined
            ? ""
            : `  (${res.changeRatio > 0 ? "+" : ""}${(res.changeRatio * 100).toFixed(1)}%)`;
        const extra = res.breakdown?.length ? `  [${res.breakdown.length} rows]` : "";
        console.log(
          `  ✓ ${def.id.padEnd(26)} ${shown.padStart(14)}${delta.padEnd(12)}${extra.padEnd(12)} ${ms.toFixed(0)}ms`,
        );
      } catch (err) {
        failed++;
        console.error(`  ✗ ${def.id.padEnd(26)} ${(err as Error).message}`);
      }
    }
  });

  const total = timings.reduce((t, x) => t + x.ms, 0);
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`\n  ${METRICS.length - failed}/${METRICS.length} metrics passed`);
  console.log(`  Full dashboard sweep: ${total.toFixed(0)}ms`);
  console.log(`  Slowest: ${slowest.map((s) => `${s.id} ${s.ms.toFixed(0)}ms`).join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
