import { describe, expect, it } from "vitest";
import { MIN_TREND_POINTS, buildTrend, visibleKeys, withTrend } from "./snapshots.ts";
import type { MetricResult } from "./types.ts";

/**
 * SNAPSHOT READER — FR-V03.
 *
 * The interesting cases here are all refusals, because the table has almost no
 * history in it and will not have much for weeks. A reader that draws
 * something for every key would put a two-point line on every tile on day one,
 * and a two-point line reads as a flat trend — a claim about the business that
 * the data does not support. So the assertions below are mostly about when
 * NOT to return a trend.
 */

const series = (values: number[], startDay = 1) =>
  values.map((v, i) => ({ onDate: `2026-08-${String(startDay + i).padStart(2, "0")}`, value: v }));

describe("buildTrend refuses what it cannot support", () => {
  it("returns nothing for a single stored day", () => {
    expect(buildTrend("revenue_mtd", series([1000]))).toBeNull();
  });

  it("returns nothing below the minimum point count", () => {
    expect(buildTrend("revenue_mtd", series([1000, 1200]))).toBeNull();
    expect(MIN_TREND_POINTS).toBe(3);
  });

  it("returns nothing for a series that never moves", () => {
    // Three identical points is technically enough data and tells the reader
    // nothing. Drawn as a line it invites them to see movement in rendering
    // noise.
    expect(buildTrend("cash_balance", series([500, 500, 500]))).toBeNull();
  });
});

describe("buildTrend", () => {
  it("compares the window's ends and reports the span it actually covered", () => {
    const t = buildTrend("revenue_mtd", series([1000, 1100, 1400, 1500]))!;
    expect(t.priorValue).toBe(1000);
    expect(t.priorOn).toBe("2026-08-01");
    expect(t.latest).toBe(1500);
    expect(t.latestOn).toBe("2026-08-04");
    expect(t.changeRatio).toBe(0.5);
    // Three days, not the four points and not the 30 that were requested.
    expect(t.spanDays).toBe(3);
  });

  it("hands the series out in Sparkline's shape", () => {
    const t = buildTrend("revenue_mtd", series([1, 2, 3]))!;
    expect(t.series).toEqual([
      { x: "2026-08-01", y: 1 },
      { x: "2026-08-02", y: 2 },
      { x: "2026-08-03", y: 3 },
    ]);
  });

  it("reports no percentage for growth from zero", () => {
    // Growth from nothing has no percentage, and inventing one (or rendering
    // Infinity) is worse than saying "no comparison".
    expect(buildTrend("revenue_mtd", series([0, 100, 200]))!.changeRatio).toBeNull();
  });

  it("carries a fall as a negative ratio", () => {
    expect(buildTrend("overdue_debt", series([2000, 1500, 1000]))!.changeRatio).toBe(-0.5);
  });
});

describe("visibleKeys re-checks the permission on every stored key", () => {
  it("hides a metric the caller cannot read", () => {
    // The nightly sweep runs as a system process and stores everything,
    // including payroll figures. Trusting the table would leak them onto a
    // receptionist's dashboard as a trend arrow.
    const receptionist = new Set(["dashboard:read"]);
    expect(visibleKeys(["revenue_mtd", "staff_performance"], receptionist)).toEqual([
      "revenue_mtd",
    ]);
  });

  it("refuses a key with no registry entry", () => {
    // The seed writes `revenue` and `gross_profit` rows under names that are
    // not metric ids, so no permission governs them. Fail closed.
    expect(visibleKeys(["revenue", "gross_profit"], new Set(["dashboard:read"]))).toEqual([]);
  });

  it("lets a full-trust caller through, which is what the backfill is", () => {
    expect(visibleKeys(["revenue", "staff_performance"], "all")).toEqual([
      "revenue",
      "staff_performance",
    ]);
  });
});

describe("withTrend", () => {
  const live: MetricResult = {
    metricId: "revenue_mtd",
    value: 99_000,
    unit: "currency",
    changeRatio: 0.08,
    computedAt: "2026-08-21T00:00:00.000Z",
  };

  it("never lets stored history overwrite the live number", () => {
    // A stale headline after a failed sweep is the failure the owner is least
    // able to detect, so the value computed now always wins.
    const merged = withTrend(live, buildTrend("revenue_mtd", series([1, 2, 3]))!);
    expect(merged.value).toBe(99_000);
  });

  it("keeps the metric's own comparison when it defines one", () => {
    // revenue_mtd compares against last month, which is meaningful for it. A
    // 30-day rolling window is not the same question.
    const merged = withTrend(live, buildTrend("revenue_mtd", series([100, 200, 400]))!);
    expect(merged.changeRatio).toBe(0.08);
    expect(merged.series).toHaveLength(3);
  });

  it("borrows the stored comparison only where the metric has none", () => {
    const noPrior: MetricResult = { ...live, changeRatio: null, priorValue: null };
    const merged = withTrend(noPrior, buildTrend("revenue_mtd", series([100, 200, 400]))!);
    expect(merged.changeRatio).toBe(3);
    expect(merged.priorValue).toBe(100);
  });

  it("is a no-op when there is no history, which is the normal case today", () => {
    expect(withTrend(live, undefined)).toBe(live);
  });
});
