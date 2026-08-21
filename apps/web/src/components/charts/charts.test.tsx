import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BarChart } from "./bar-chart";
import { BulletChart } from "./bullet";
import { CalendarHeatmap } from "./calendar-heatmap";
import { LineChart } from "./line-chart";
import { SmallMultiples } from "./small-multiples";
import { StatTile } from "./stat-tile";
import { Waterfall } from "./waterfall";
import { ChartFrame } from "./chart-frame";
import {
  concludeBars,
  concludeBullet,
  concludeCalendar,
  concludeStat,
  concludeTrend,
  concludeWaterfall,
} from "./conclude";
import {
  areaPath,
  barGeometry,
  bridgeResidual,
  calendarGrid,
  domainOf,
  eachDay,
  heatBin,
  heatCeiling,
  lineDomain,
  linePath,
  niceTicks,
  project,
  rollUpSteps,
  waterfallBars,
  type WaterfallStep,
} from "./scale";

/**
 * Tests for the explanatory visualisation system (FR-V02).
 *
 * Three things are worth testing here and they are tested separately:
 *
 *  1. THE ARITHMETIC in `scale.ts`, which decides whether a bar points the
 *     wrong way or a heat bin lies about a value. Pure functions, no rendering.
 *
 *  2. THE RENDERED OUTPUT, through `renderToStaticMarkup` — the same server
 *     render Next performs. This catches the defect classes that type-check
 *     fine: an SVG id that collides across a loop, a chart with no table twin,
 *     a hardcoded colour that will not follow the dark theme.
 *
 *  3. THE `conclusion` CONTRACT ITSELF, with `@ts-expect-error`. Those
 *     directives are a RATCHET, not decoration: if anybody relaxes
 *     `conclusion` to optional on any chart, the corresponding directive
 *     becomes *unused* and `tsc --noEmit -p apps/web` fails. The requirement is
 *     therefore checked in both directions — a caller cannot omit the prop, and
 *     a maintainer cannot make it omissible.
 */

const money = (v: number) => `AED ${Math.round(v).toLocaleString("en-AE")}`;

const BRIDGE: WaterfallStep[] = [
  { label: "Opening profit", value: 48_000, kind: "total" },
  { label: "Rent", value: 2_000 },
  { label: "Salon bookings", value: 6_400 },
  { label: "AC recharge", value: -12_400 },
  { label: "Staff costs", value: -3_400 },
  { label: "Closing profit", value: 40_600, kind: "total" },
];

const SERIES = [
  { x: "2026-08-01", y: 210_000 },
  { x: "2026-08-02", y: 198_000 },
  { x: "2026-08-03", y: 121_000 },
  { x: "2026-08-04", y: 164_000 },
  { x: "2026-08-05", y: 214_000 },
];

// ── 1. Arithmetic ───────────────────────────────────────────────────────────

describe("scale — domains", () => {
  it("always spans zero for bars, so a bar length is a true encoding", () => {
    expect(domainOf([10, 20, 30])).toEqual({ min: 0, max: 30, span: 30 });
    expect(domainOf([-40, 10])).toEqual({ min: -40, max: 10, span: 50 });
  });

  it("gives an all-zero series a usable span instead of dividing by zero", () => {
    expect(domainOf([0, 0]).span).toBe(1);
  });

  it("lets a LINE leave out zero — position carries the value, not length", () => {
    const d = lineDomain([180_000, 220_000]);
    expect(d.min).toBe(180_000);
    expect(d.max).toBe(220_000);
  });

  it("pads a flat line so it sits mid-band, not on the floor reading as zero", () => {
    const d = lineDomain([500, 500]);
    expect(d.min).toBeLessThan(500);
    expect(d.max).toBeGreaterThan(500);
    expect(project(500, d)).toBeCloseTo(0.5, 5);
  });

  it("forces a reference value into the domain — an off-chart reference is none", () => {
    const d = lineDomain([200, 300], [50]);
    expect(d.min).toBe(50);
  });
});

describe("scale — bar geometry", () => {
  it("renders a negative on the far side of the baseline, not as a positive", () => {
    const d = domainOf([-40, 100]);
    const pos = barGeometry(100, d);
    const neg = barGeometry(-40, d);
    // The regression this exists for: `BarRow` used Math.abs(), so -40 and +40
    // drew identical bars and a loss looked like a profit.
    expect(neg.start).toBeLessThan(pos.start);
    expect(neg.start + neg.length).toBeCloseTo(project(0, d), 10);
    expect(pos.start).toBeCloseTo(project(0, d), 10);
  });

  it("gives equal magnitudes equal lengths regardless of sign", () => {
    const d = domainOf([-40, 40]);
    expect(barGeometry(40, d).length).toBeCloseTo(barGeometry(-40, d).length, 10);
  });
});

describe("scale — ticks", () => {
  it("lands on numbers a reader recognises", () => {
    expect(niceTicks({ min: 0, max: 9_400, span: 9_400 }, 4)).toEqual([
      0, 2000, 4000, 6000, 8000,
    ]);
  });

  it("never emits -0, which prints as '-0' and reads as a defect", () => {
    const ticks = niceTicks({ min: -1000, max: 1000, span: 2000 }, 4);
    expect(ticks.every((t) => !Object.is(t, -0))).toBe(true);
    expect(ticks).toContain(0);
  });
});

describe("scale — waterfall", () => {
  it("floats interior bars between running totals and anchors totals to zero", () => {
    const bars = waterfallBars(BRIDGE);
    expect(bars[0]).toMatchObject({ kind: "total", from: 0, to: 48_000 });
    expect(bars[1]).toMatchObject({ from: 48_000, to: 50_000 });
    expect(bars[3]).toMatchObject({ label: "AC recharge", from: 56_400, to: 44_000 });
    expect(bars.at(-1)).toMatchObject({ kind: "total", from: 0, to: 40_600 });
  });

  it("reports a bridge that does not reach its anchor instead of hiding it", () => {
    expect(bridgeResidual(BRIDGE)).toBe(0);
    const broken: WaterfallStep[] = [
      { label: "Open", value: 100, kind: "total" },
      { label: "Driver", value: 10 },
      { label: "Close", value: 200, kind: "total" },
    ];
    expect(bridgeResidual(broken)).toBe(90);
  });

  it("enforces PDD §7.3's eight-step cap by folding the smallest drivers", () => {
    const many: WaterfallStep[] = [
      { label: "Open", value: 1000, kind: "total" },
      ...Array.from({ length: 20 }, (_, i) => ({ label: `Line ${i}`, value: (i + 1) * 10 })),
      { label: "Close", value: 3100, kind: "total" },
    ];
    const rolled = rollUpSteps(many, 8);
    expect(rolled).toHaveLength(8);
    const other = rolled.find((s) => s.label.startsWith("Other"));
    expect(other).toBeDefined();
    // Folding must not change what the bridge says: the drivers still sum to
    // the same movement, so the cascade still lands on the closing anchor.
    const sum = (xs: WaterfallStep[]) =>
      xs.filter((s) => s.kind !== "total").reduce((t, s) => t + s.value, 0);
    expect(sum(rolled)).toBe(sum(many));
    expect(bridgeResidual(rolled)).toBe(bridgeResidual(many));
  });

  it("never rolls up a total — the anchors are what the bridge spans between", () => {
    const rolled = rollUpSteps(BRIDGE, 4);
    expect(rolled[0]).toMatchObject({ kind: "total", label: "Opening profit" });
    expect(rolled.at(-1)).toMatchObject({ kind: "total", label: "Closing profit" });
  });

  it("leaves a bridge already inside the cap untouched", () => {
    expect(rollUpSteps(BRIDGE, 8)).toEqual(BRIDGE);
  });
});

describe("scale — heat binning", () => {
  it("keeps 'no activity' as its own category, not the lowest value", () => {
    expect(heatBin(0, 500)).toBe(0);
    expect(heatBin(1, 500)).toBe(1);
  });

  it("bins symmetrically around zero so a diverging scale's arms match", () => {
    expect(heatBin(-400, 500)).toBe(heatBin(400, 500));
    expect(heatBin(500, 500)).toBe(4);
  });

  it("bins against a high quantile, so one outlier cannot flatten the chart", () => {
    // The real defect this fixes: on this product's own seeded cash data one
    // AED 634k day against a median under AED 20k put 88 of 90 cells in bin 1
    // and the heatmap rendered as a flat field.
    const days = [...Array.from({ length: 89 }, () => 20_000), 634_000];
    expect(heatCeiling(days)).toBe(20_000);
    expect(heatBin(20_000, heatCeiling(days))).toBe(4);
    // Days above the ceiling clamp rather than being dropped.
    expect(heatBin(634_000, heatCeiling(days))).toBe(4);
  });

  it("never returns a ceiling of zero from a series that has movement", () => {
    // A zero ceiling would report every real day as "no activity".
    expect(heatCeiling([0, 0, 0, 5])).toBeGreaterThan(0);
    expect(heatCeiling([])).toBe(0);
  });

  it("never exceeds the four validated ramp steps", () => {
    for (let v = 1; v <= 500; v++) {
      const bin = heatBin(v, 500);
      expect(bin).toBeGreaterThanOrEqual(1);
      expect(bin).toBeLessThanOrEqual(4);
    }
  });
});

describe("scale — calendar layout", () => {
  it("is Monday-first, so the UAE weekend lands in the last two rows", () => {
    // 2026-08-03 is a Monday.
    const { cells } = calendarGrid("2026-08-03", "2026-08-09", new Map());
    expect(cells[0].weekday).toBe(0);
    expect(cells.at(-1)!.weekday).toBe(6);
  });

  it("offsets a range that starts mid-week instead of shifting every day", () => {
    // 2026-08-05 is a Wednesday.
    const { cells, weeks } = calendarGrid("2026-08-05", "2026-08-11", new Map());
    expect(cells[0].weekday).toBe(2);
    expect(cells[0].week).toBe(0);
    expect(weeks).toBe(2);
  });

  it("distinguishes a day with no row from a day worth zero", () => {
    const { cells } = calendarGrid("2026-08-03", "2026-08-05", new Map([["2026-08-04", 0]]));
    expect(cells[0].value).toBeNull();
    expect(cells[1].value).toBe(0);
  });

  it("counts days inclusively at both ends", () => {
    expect(eachDay("2026-08-01", "2026-08-31")).toHaveLength(31);
  });
});

describe("scale — paths", () => {
  it("inverts y, so a rising series rises on screen", () => {
    const d = lineDomain([0, 100]);
    const path = linePath([0, 100], d);
    expect(path).toBe("M0.00,100.00 L100.00,0.00");
  });

  it("draws a single point as a flat line rather than nothing", () => {
    expect(linePath([5], lineDomain([5]))).toContain("M0.00");
  });

  it("closes an area to the domain floor, never below a truncated axis", () => {
    const d = lineDomain([180, 220]);
    expect(areaPath([180, 220], d)).toContain("L100.00,100.00 L0.00,100.00 Z");
  });
});

// ── 2. Rendered output ──────────────────────────────────────────────────────

/** Every chart, rendered twice with the same props — which is exactly the
 *  condition that exposed the `Sparkline` gradient-id collision on /businesses. */
const RENDERS: [string, () => string][] = [
  [
    "Waterfall",
    () =>
      renderToStaticMarkup(
        <Waterfall
          title="Profit bridge"
          conclusion={concludeWaterfall(BRIDGE, money, { subject: "Profit", period: "August" })}
          steps={BRIDGE}
          format={money}
        />,
      ),
  ],
  [
    "BulletChart",
    () =>
      renderToStaticMarkup(
        <BulletChart
          title="Occupancy against target"
          conclusion={concludeBullet({
            subject: "Occupancy",
            actual: 82.9,
            target: 90,
            format: (v) => `${v.toFixed(1)}%`,
            count: { done: 34, of: 41, unit: "unit" },
          })}
          rows={[
            { label: "Apartments", actual: 82.9, target: 90, meta: "34 of 41 let" },
            { label: "Parking bays", actual: 96.0, target: 85 },
          ]}
          format={(v) => `${v.toFixed(1)}%`}
          max={100}
          bandAt={60}
        />,
      ),
  ],
  [
    "CalendarHeatmap",
    () =>
      renderToStaticMarkup(
        <CalendarHeatmap
          title="Daily cash movement"
          conclusion={concludeCalendar(
            [
              { date: "2026-08-03", value: 4200 },
              { date: "2026-08-04", value: -1800 },
            ],
            money,
            { subject: "Cash", mode: "diverging" },
          )}
          from="2026-07-01"
          to="2026-08-21"
          values={[
            { date: "2026-08-03", value: 4200 },
            { date: "2026-08-04", value: -1800 },
            { date: "2026-07-15", value: 900 },
          ]}
          format={money}
          mode="diverging"
        />,
      ),
  ],
  [
    "LineChart",
    () =>
      renderToStaticMarkup(
        <LineChart
          title="Cash over time"
          conclusion={concludeTrend(SERIES, money, {
            subject: "Cash",
            floor: 150_000,
            floorLabel: "the minimum safe balance",
          })}
          series={[{ label: "Cash", points: SERIES }]}
          format={money}
          reference={{ value: 150_000, label: "Min safe" }}
        />,
      ),
  ],
  [
    "SmallMultiples",
    () =>
      renderToStaticMarkup(
        <SmallMultiples
          title="Revenue by business"
          conclusion="Four of six businesses grew revenue this quarter."
          panels={[
            { label: "Properties", points: SERIES, bu: "blue" },
            { label: "Salon", points: SERIES.map((p) => ({ ...p, y: p.y / 20 })), bu: "violet" },
            { label: "AC service", points: [], bu: "cyan" },
          ]}
          format={money}
        />,
      ),
  ],
  [
    "BarChart",
    () =>
      renderToStaticMarkup(
        <BarChart
          title="Profit by business"
          conclusion={concludeBars(
            [
              { label: "Properties", value: 84_000 },
              { label: "Salon", value: -3_200 },
            ],
            money,
            { subject: "Profit" },
          )}
          rows={[
            { label: "Properties", value: 84_000 },
            { label: "Salon", value: -3_200 },
            { label: "Parking", value: 12_400, target: 15_000 },
          ]}
          format={money}
        />,
      ),
  ],
  [
    "BarChart (stacked ageing)",
    () =>
      renderToStaticMarkup(
        <BarChart
          title="Receivables ageing"
          conclusion="AED 61,000 of the AED 96,000 owed is from two tenants, both past 90 days."
          rows={[
            {
              label: "Al Manara FZ",
              segments: [
                { key: "cur", label: "Current", value: 4_000 },
                { key: "30", label: "30 days", value: 9_000 },
                { key: "60", label: "60 days", value: 12_000 },
                { key: "90", label: "90+ days", value: 31_000 },
              ],
            },
            {
              label: "Gulf Tech LLC",
              segments: [
                { key: "cur", label: "Current", value: 2_000 },
                { key: "30", label: "30 days", value: 1_000 },
                { key: "60", label: "60 days", value: 7_000 },
                { key: "90", label: "90+ days", value: 30_000 },
              ],
            },
          ]}
          format={money}
        />,
      ),
  ],
  [
    "StatTile",
    () =>
      renderToStaticMarkup(
        <StatTile
          label="Cash on hand"
          value={214_000}
          prior={196_000}
          format={money}
          series={SERIES}
          conclusion={concludeStat({
            subject: "Cash",
            value: 214_000,
            prior: 196_000,
            format: money,
          })}
        />,
      ),
  ],
];

describe("rendered charts", () => {
  it.each(RENDERS)("%s emits no SVG id, so nothing can collide in a loop", (_name, render) => {
    // The generalised fix for the `Sparkline` defect: no chart in this
    // directory defines a referenced SVG resource, so two instances rendered
    // in the same document cannot share one and have the second silently win.
    const twice = render() + render();
    expect(twice).not.toMatch(/\sid="/);
    expect(twice).not.toMatch(/url\(#/);
    expect(twice).not.toMatch(/aria-labelledby=/);
  });

  it.each(RENDERS)("%s paints only tokens — no literal colour survives", (_name, render) => {
    const html = render();
    // A hex or rgb() literal in the output cannot follow the dark palette, and
    // is invisible in review because it type-checks perfectly.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgba?\(/);
    expect(html).not.toMatch(/oklch\(/);
  });

  it.each(RENDERS.filter(([n]) => n !== "StatTile"))(
    "%s ships a table view with the numbers in it",
    (_name, render) => {
      const html = render();
      expect(html).toContain("<details");
      expect(html).toContain("Table view");
      expect(html).toContain("<table");
      // The table is in the DOM unconditionally, not behind a JS toggle — that
      // is what makes it the accessibility relief mechanism §7.8 calls it.
      expect(html).not.toContain('hidden=""');
    },
  );

  it.each(RENDERS)("%s renders the conclusion as visible text", (_name, render) => {
    const html = render();
    const text = html.replace(/<[^>]+>/g, " ");
    // Every conclusion in the fixtures names a number; a caption with no figure
    // in it is a title wearing a conclusion's clothes.
    expect(text).toMatch(/\d/);
  });

  it("puts the conclusion in a <figcaption>, so it names the figure", () => {
    const html = RENDERS[0][1]();
    expect(html).toMatch(/<figure[^>]*>\s*<figcaption/);
  });

  it("draws a loss on the opposite side of the baseline from a profit", () => {
    const html = renderToStaticMarkup(
      <BarChart
        conclusion="Salon lost AED 3,200 while properties made AED 84,000."
        rows={[
          { label: "Properties", value: 84_000 },
          { label: "Salon", value: -3_200 },
        ]}
        format={money}
      />,
    );
    // The negative bar must start left of the zero rule; the positive at it.
    const lefts = [...html.matchAll(/left:\s*([0-9.]+)%/g)].map((m) => Number(m[1]));
    expect(Math.min(...lefts)).toBeLessThan(Math.max(...lefts));
    expect(html).toContain("var(--negative)");
    expect(html).toContain("▼");
  });

  it("marks outflow days with a shape as well as a colour", () => {
    const html = renderToStaticMarkup(
      <CalendarHeatmap
        conclusion="Cash was negative on 1 of 3 days."
        from="2026-08-03"
        to="2026-08-05"
        values={[
          { date: "2026-08-03", value: 500 },
          { date: "2026-08-04", value: -500 },
        ]}
        format={money}
        mode="diverging"
      />,
    );
    // FR-V02: sign is never carried by colour alone. One slash per outflow
    // cell, plus one in the legend swatch.
    expect([...html.matchAll(/rotate-45/g)]).toHaveLength(2);
    expect(html).toContain("Money out (slashed)");
  });

  it("scales every small-multiple panel against one shared domain", () => {
    const big = Array.from({ length: 5 }, (_, i) => ({ x: `d${i}`, y: 100_000 + i * 1000 }));
    const small = Array.from({ length: 5 }, (_, i) => ({ x: `d${i}`, y: 100 + i }));
    const html = renderToStaticMarkup(
      <SmallMultiples
        conclusion="Properties dwarfs the salon at portfolio scale."
        panels={[
          { label: "Properties", points: big },
          { label: "Salon", points: small },
        ]}
        format={money}
      />,
    );
    // On a shared scale the small panel is a near-flat line at the bottom of
    // its box. Per-panel scaling — the standard way this chart is got wrong —
    // would put both lines in the same place and invert the comparison.
    const paths = [...html.matchAll(/ d="M([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);
    const yOf = (p: string) => Number(p.split(",")[1].split(" ")[0]);
    expect(yOf(paths[1])).toBeGreaterThan(yOf(paths[0]) + 50);
  });

  it("shades an ordered stack light-to-dark, so the worst bucket is heaviest", () => {
    const html = RENDERS.find(([n]) => n.includes("stacked"))![1]();
    // A ramp running the other way paints the harmless current balance darkest
    // and buries the 90+ day debt, which is the number the reader came for.
    const opacities = [...html.matchAll(/opacity:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    const first = opacities.slice(0, 4);
    expect(first).toEqual([...first].sort((a, b) => a - b));
    expect(Math.max(...first)).toBe(1);
  });

  it("drills to the rows behind a mark when the caller supplies an href", () => {
    // PDD §7.8: "clicking any mark drills to the rows behind it."
    const html = renderToStaticMarkup(
      <BarChart
        conclusion="Properties made AED 84,000 this month."
        rows={[{ label: "Properties", value: 84_000, href: "/businesses?bu=properties" }]}
        format={money}
      />,
    );
    expect(html).toContain('href="/businesses?bu=properties"');
  });

  it("keeps a stacked segment's own surface gap out of its width", () => {
    const html = RENDERS.find(([n]) => n.includes("stacked"))![1]();
    // The 2px separator between touching fills is the card showing through,
    // subtracted from the mark — never a stroke drawn around it.
    expect(html).toContain("- 2px)");
    expect(html).not.toMatch(/border-width|outline:/);
  });

  it("refuses an empty conclusion in development", () => {
    expect(() =>
      renderToStaticMarkup(
        <ChartFrame conclusion="   " table={{ headers: ["a"], rows: [], caption: "c" }}>
          <p />
        </ChartFrame>,
      ),
    ).toThrow(/conclusion` is empty/);
  });

  it("refuses a conclusion that is just the title repeated", () => {
    expect(() =>
      renderToStaticMarkup(
        <ChartFrame
          title="Profit by month"
          conclusion="Profit by month"
          table={{ headers: ["a"], rows: [], caption: "c" }}
        >
          <p />
        </ChartFrame>,
      ),
    ).toThrow(/repeats the title/);
  });
});

// ── 3. Conclusion generators ────────────────────────────────────────────────

describe("conclude", () => {
  it("states the movement, both anchors, and the largest mover on each side", () => {
    const s = concludeWaterfall(BRIDGE, money, { subject: "Profit", period: "August" });
    expect(s).toContain("Profit fell AED 7,400 in August");
    expect(s).toContain("from AED 48,000 to AED 40,600");
    expect(s).toContain("AC recharge");
    expect(s).toContain("Salon bookings");
  });

  it("says so when the named drivers do not add up to the closing anchor", () => {
    const broken: WaterfallStep[] = [
      { label: "Open", value: 100, kind: "total" },
      { label: "Driver", value: 10 },
      { label: "Close", value: 200, kind: "total" },
    ];
    expect(concludeWaterfall(broken, money)).toContain("unexplained");
  });

  it("reports a target gap in the unit the reader acts in", () => {
    const s = concludeBullet({
      subject: "Occupancy",
      actual: 82.9,
      target: 90,
      format: (v) => `${v.toFixed(1)}%`,
      count: { done: 34, of: 41, unit: "unit" },
    });
    expect(s).toBe("Occupancy is 34 of 41 units — 82.9%, 7.1% short of the 90.0% target.");
  });

  it("withholds a share of a total that spans zero, because it is meaningless", () => {
    const mixed = [
      { label: "Properties", value: 84_000 },
      { label: "Parking", value: 12_000 },
      { label: "Salon", value: -3_200 },
    ];
    const s = concludeBars(mixed, money, { subject: "Profit" });
    // Two units "making 105% of group profit" is arithmetically true and
    // useless; the loss is named instead.
    expect(s).not.toContain("of the");
    expect(s).toContain("Salon is the only one negative");
  });

  it("names the trough on a cash line, which the endpoints hide", () => {
    const s = concludeTrend(SERIES, money, {
      subject: "Cash",
      floor: 150_000,
      floorLabel: "the minimum safe balance",
    });
    expect(s).toContain("Cash is AED 214,000");
    expect(s).toContain("below the minimum safe balance on 1 day");
    expect(s).toContain("AED 121,000");
  });

  it("claims a weekday pattern only when one weekday holds the majority", () => {
    // Four Fridays out of four bad days — a real pattern.
    const fridays = ["2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24"].map((date) => ({
      date,
      value: -500,
    }));
    expect(concludeCalendar(fridays, money, { subject: "Cash", mode: "diverging" })).toContain(
      "fell on a Friday",
    );
    // Two of five — a coincidence, and must not be dressed up as a finding.
    const scattered = ["2026-07-03", "2026-07-10", "2026-07-14", "2026-07-15", "2026-07-16"].map(
      (date) => ({ date, value: -500 }),
    );
    expect(concludeCalendar(scattered, money, { subject: "Cash", mode: "diverging" })).not.toContain(
      "fell on a",
    );
  });

  it("does not congratulate the owner on a rise in overdue debt", () => {
    const s = concludeStat({
      subject: "Overdue debt",
      value: 96_000,
      prior: 80_000,
      format: money,
      polarity: "lower_is_better",
    });
    expect(s).toContain("up AED 16,000");
    expect(s).toContain("the wrong direction");
  });

  it("says there is no comparison rather than implying zero growth", () => {
    expect(concludeStat({ subject: "Cash", value: 10, prior: null, format: money })).toContain(
      "No comparable prior period",
    );
  });
});

// ── 4. The `conclusion` ratchet ─────────────────────────────────────────────

/**
 * Each expression below omits `conclusion` and MUST NOT COMPILE. `tsc` verifies
 * the error is really there; if the prop is ever relaxed to optional the
 * directive becomes unused and `tsc --noEmit -p apps/web` fails with TS2578
 * ("Unused '@ts-expect-error' directive"). PDD §7.7's "a chart without one does
 * not compile" is therefore enforced in both directions.
 *
 * The block is never executed — it exists to be type-checked.
 */
export function __conclusionIsRequired() {
  const noop = () => "";
  return [
    // @ts-expect-error — Waterfall requires `conclusion`
    <Waterfall key="a" steps={BRIDGE} format={noop} />,
    // @ts-expect-error — BulletChart requires `conclusion`
    <BulletChart key="b" rows={[]} format={noop} />,
    // @ts-expect-error — CalendarHeatmap requires `conclusion`
    <CalendarHeatmap key="c" from="2026-01-01" to="2026-01-02" values={[]} format={noop} />,
    // @ts-expect-error — LineChart requires `conclusion`
    <LineChart key="d" series={[]} format={noop} />,
    // @ts-expect-error — SmallMultiples requires `conclusion`
    <SmallMultiples key="e" panels={[]} format={noop} />,
    // @ts-expect-error — BarChart requires `conclusion`
    <BarChart key="f" rows={[]} format={noop} />,
    // @ts-expect-error — StatTile requires `conclusion`
    <StatTile key="g" label="Cash" value={1} format={noop} />,
    // @ts-expect-error — ChartFrame itself requires `conclusion`
    <ChartFrame key="h" table={{ headers: [], rows: [], caption: "" }}>
      <p />
    </ChartFrame>,
  ];
}
