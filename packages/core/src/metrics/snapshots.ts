/**
 * THE READ SIDE OF `kpi_snapshots`.
 *
 * The table has been written since the seed and read by nothing. Audit DB-3
 * called it "write-only"; the consequence on screen is that the owner sees
 * today's number and not its direction, which is PROD-008, and that the
 * occupancy trend FR-R04 asks for cannot be built at all. Wave 1 fixed the
 * writer — the timezone bug, and the divergent parallel query that stored a
 * different definition of revenue from the one the dashboard shows. This is
 * the reader that finally makes the table answer something.
 *
 * THREE RULES, EACH OF WHICH THE WRITER'S OWN DOCBLOCK ASKED FOR.
 *
 *  1. **Re-check the permission on every key.** The nightly sweep runs as a
 *     system process with no principal and stores every metric in the
 *     registry, including `staff_performance` (needs `employee:read`) and the
 *     UAE tax figures. So `kpi_snapshots` is a table containing numbers some
 *     users must not read, and a reader that trusted the table would leak
 *     payroll onto a receptionist's dashboard by way of a trend arrow. The
 *     `api/cron/[job]/route.ts` docblock states this explicitly and ends "this
 *     is the note for whoever writes the first trend chart". This is that
 *     reader; the note is honoured in `visibleKeys`.
 *
 *  2. **An unknown key is not readable.** The seed writes `revenue` and
 *     `gross_profit` rows keyed by names that are NOT metric ids, so no
 *     registry entry governs them and no permission can be looked up. Those
 *     keys are refused to anyone but a full-trust caller rather than being
 *     waved through, because "we could not find a rule for this number" must
 *     fail closed.
 *
 *  3. **No history is a first-class answer, not an empty chart.** Today is the
 *     normal case: one sweep has run. A two-point series drawn across a tile
 *     looks like a flat trend, which is a claim about the business that the
 *     data does not support. `readSnapshotTrends` returns nothing for a key it
 *     cannot support, and the tile renders as it did before.
 */

import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { METRICS_BY_ID } from "./registry.ts";
import { changeRatio, num, type MetricResult } from "./types.ts";

/** Fewer points than this is not a trend. See rule 3 above. */
export const MIN_TREND_POINTS = 3;

export interface SnapshotPoint {
  /** ISO date. Named `x`/`y` to drop straight into `Sparkline`. */
  x: string;
  y: number;
}

export interface SnapshotTrend {
  metricKey: string;
  series: SnapshotPoint[];
  /** Most recent stored value, and the day it describes the end of. */
  latest: number;
  latestOn: string;
  /** The comparison point: the oldest value inside the requested window. */
  priorValue: number;
  priorOn: string;
  /** Signed fractional change across the window. Null where the base is zero,
   *  because growth from nothing has no percentage. */
  changeRatio: number | null;
  /** Calendar days the window actually spans, which is not `days` when the
   *  history is shorter than the request. A tile that says "vs last month"
   *  over eleven days of data is lying quietly. */
  spanDays: number;
}

export interface SnapshotQuery {
  /** Metric ids to read. Keys with no registry entry are refused — rule 2. */
  metricKeys: string[];
  /** Inclusive upper bound, normally the tenant's today. */
  today: string;
  /** How far back to look. */
  days?: number;
  /**
   * Which slice of the table.
   *
   * `null` — the default — means the portfolio-wide rows the nightly sweep
   * writes, where `business_unit_id IS NULL`. A uuid means that business's
   * rows, which today only the seed writes. The two sets never collide because
   * they use different keys.
   */
  businessUnitId?: string | null;
}

/**
 * Filter the requested keys down to the ones this caller may read.
 *
 * Exported because the backfill script and any future exception queue need the
 * same rule, and a permission rule that exists in two places has already
 * started to drift.
 */
export function visibleKeys(
  metricKeys: string[],
  permissions: Set<string> | "all",
): string[] {
  if (permissions === "all") return metricKeys;
  return metricKeys.filter((key) => {
    const def = METRICS_BY_ID[key];
    return def !== undefined && permissions.has(def.permission);
  });
}

/**
 * Turn stored rows into a trend, or into nothing.
 *
 * Pure, so the "is this enough history to draw?" judgement is unit-testable
 * without a database — which matters because that judgement is the difference
 * between an honest tile and a flat line that implies stability.
 */
export function buildTrend(
  metricKey: string,
  rows: { onDate: string; value: number }[],
): SnapshotTrend | null {
  if (rows.length < MIN_TREND_POINTS) return null;

  const series = rows.map((r) => ({ x: r.onDate, y: r.value }));
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;

  // A series where every point is identical is not a trend either — it is a
  // constant, and drawing it as a line invites the reader to see movement in
  // rendering noise. Distinguishing them costs one pass.
  const allEqual = rows.every((r) => r.value === first.value);
  if (allEqual) return null;

  return {
    metricKey,
    series,
    latest: last.value,
    latestOn: last.onDate,
    priorValue: first.value,
    priorOn: first.onDate,
    changeRatio: changeRatio(last.value, first.value),
    spanDays: Math.round(
      (Date.parse(`${last.onDate}T00:00:00Z`) - Date.parse(`${first.onDate}T00:00:00Z`)) /
        86_400_000,
    ),
  };
}

/**
 * Read trends for a set of metrics in one query.
 *
 * One round trip for the whole dashboard, matching how `loadMetrics` already
 * loads the live figures: the tiles are rendered together, so they should be
 * fetched together. Keys with insufficient history are simply absent from the
 * result — callers use `?.` and get the old tile.
 */
export async function readSnapshotTrends(
  tx: Tx,
  query: SnapshotQuery,
  permissions: Set<string> | "all" = "all",
): Promise<Record<string, SnapshotTrend>> {
  const { today, days = 30, businessUnitId = null } = query;
  const keys = visibleKeys(query.metricKeys, permissions);
  if (keys.length === 0) return {};

  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const scope =
    businessUnitId === null
      ? sql`business_unit_id IS NULL`
      : sql`business_unit_id = ${businessUnitId}::uuid`;

  const rows = await tx.execute<{ metric_key: string; on_date: string; value: string }>(sql`
    SELECT metric_key, on_date::text, value::text
      FROM kpi_snapshots
     WHERE ${scope}
       AND metric_key IN (${sql.join(
         keys.map((k) => sql`${k}`),
         sql`, `,
       )})
       AND on_date >= ${from}::date
       AND on_date <= ${today}::date
     ORDER BY metric_key, on_date
  `);

  const byKey = new Map<string, { onDate: string; value: number }[]>();
  for (const r of rows) {
    const list = byKey.get(r.metric_key) ?? [];
    list.push({ onDate: r.on_date, value: num(r.value) });
    byKey.set(r.metric_key, list);
  }

  const out: Record<string, SnapshotTrend> = {};
  for (const [key, list] of byKey) {
    const trend = buildTrend(key, list);
    if (trend) out[key] = trend;
  }
  return out;
}

/**
 * Attach a stored trend to a live metric result.
 *
 * LIVE WINS ON THE VALUE, ALWAYS. FR-V03 asks for dashboards to read from
 * snapshots "with a live fallback", and the safe reading of that is: the
 * headline number is the one computed now, and history only ever supplies the
 * context around it. The other way round — showing last night's stored figure
 * as today's number — would make the dashboard silently stale after a failed
 * sweep, which is the failure the owner is least able to detect.
 *
 * `changeRatio` is only borrowed when the metric does not define its own. A
 * metric that computes its own comparison — `revenue_mtd` against last month —
 * knows which prior period is meaningful for it; a 30-day window does not.
 */
export function withTrend(
  result: MetricResult,
  trend: SnapshotTrend | undefined,
): MetricResult {
  if (!trend) return result;
  return {
    ...result,
    series: result.series ?? trend.series,
    changeRatio: result.changeRatio ?? trend.changeRatio,
    priorValue: result.priorValue ?? trend.priorValue,
  };
}
