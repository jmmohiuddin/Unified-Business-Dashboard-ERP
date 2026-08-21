/**
 * The explanatory visualisation system (FR-V02, PDD §7).
 *
 * Import charts from here rather than from the individual files. The barrel is
 * the enforcement point for one rule: every export below renders through
 * `ChartFrame`, so there is no way to put a plot on a screen in this product
 * without also putting the sentence that explains it there. The internal plot
 * renderers are deliberately not re-exported.
 *
 * ── LIBRARY DECISION: HAND-ROLLED, NOT RECHARTS ─────────────────────────────
 * PDD-04 was written assuming `recharts`. It is not installed and — contrary to
 * the design audit, which was written against an earlier tree — it is no longer
 * declared in any `package.json` either (nor is `lucide-react`); both were
 * removed in wave 1. So "use recharts, it is already declared" was not actually
 * on the table: adopting it means ADDING a dependency, and the brief asks for a
 * strong argument before doing that. There are four reasons not to, and they
 * are specific to this product rather than general preference:
 *
 *  1. IT WOULD MAKE EVERY CHART A CLIENT COMPONENT. Recharts measures the DOM
 *     to lay out, so every chart needs `"use client"` and hydration. The whole
 *     dashboard is server-rendered today and `ui.tsx` states the reason in its
 *     header — payload and first paint on the low-end Android hardware most
 *     staff in this market carry. Recharts plus its d3 dependencies is ~100 kB
 *     gzipped before any chart renders, on screens whose current JS cost is
 *     approximately zero.
 *
 *  2. THE PRODUCT'S THREE LOAD-BEARING FORMS ARE NOT IN IT. §7.2 names the
 *     waterfall, the bullet graph and the calendar heatmap as carrying the
 *     explanatory weight. Recharts ships none of them; all three would be
 *     composed by hand out of its primitives anyway, so the dependency would
 *     buy the three forms this product needs least.
 *
 *  3. TEXT INSIDE SVG DOES NOT SCALE DOWN WELL. Recharts renders axis labels as
 *     SVG `<text>`. On the 330px phone card this product targets, that text
 *     shrinks with the viewport. The approach here puts every label in HTML at
 *     a percentage offset, so type stays at token size at every width — see the
 *     docblock in `line-chart.tsx`.
 *
 *  4. THEMING. These components paint from `var(--…)` tokens, so both themes,
 *     `prefers-reduced-motion` and any future token change follow for free.
 *     Recharts wants literal colour values in props, which is how a chart ends
 *     up with a hardcoded hex that does not follow the dark palette.
 *
 * The cost is honest and worth stating: no crosshair tooltip, no brush, no
 * animated transitions, and roughly 900 lines to maintain. Hover readouts are
 * native `title` tooltips on the marks, and the table view on every chart is
 * the complete, keyboard-reachable value channel — which the accessibility
 * requirement demanded independently.
 *
 * ── EVERY COMPONENT HERE IS A SERVER COMPONENT ──────────────────────────────
 * Not one file in this directory carries `"use client"`. There is no state, no
 * effect, no measurement and no event handler anywhere in it; interaction is
 * `:hover` (CSS), `title` (the browser) and `<details>` (the browser). They can
 * be rendered directly inside an async server page with no boundary and no
 * hydration cost.
 */

export { ChartEmpty, ChartLegend, ChartSkeleton, MARK, BU_MARK } from "./chart-frame";
export { BarChart, type BarDatum, type BarSegment } from "./bar-chart";
export { BulletChart, type BulletRow } from "./bullet";
export { CalendarHeatmap } from "./calendar-heatmap";
export { LineChart } from "./line-chart";
export { SmallMultiples, type Panel } from "./small-multiples";
export { StatTile } from "./stat-tile";
export { Waterfall } from "./waterfall";

export {
  concludeBars,
  concludeBullet,
  concludeCalendar,
  concludeSmallMultiples,
  concludeStat,
  concludeTrend,
  concludeWaterfall,
} from "./conclude";

export type { BuColor, ChartBase, ChartTable, MarkTone, Point, ValueFormat } from "./types";
export type { WaterfallStep } from "./scale";
