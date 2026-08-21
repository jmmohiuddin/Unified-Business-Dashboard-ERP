/**
 * Chart geometry and binning — pure functions, no React, no DOM.
 *
 * Everything here is a total function of its arguments, which is the reason it
 * is a separate file: the arithmetic that decides whether a bar points the
 * wrong way, or a heat bin lies about a value, is the part worth testing, and
 * it should be testable without rendering anything.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. NEGATIVE VALUES ARE NOT ABSOLUTE VALUES. `BarRow` in `ui.tsx` shipped with
 *    `Math.abs()` on the bar length, so a loss-making business rendered
 *    identically to a profitable one on a screen whose entire job is
 *    comparison. Every domain computed here spans zero when the data does, and
 *    every projection is signed.
 *
 * 2. A DOMAIN THAT EXCLUDES ZERO LIES ABOUT MAGNITUDE. Bar and column baselines
 *    are anchored to zero, always — a truncated bar axis exaggerates a
 *    difference, which on a profit chart is not a cosmetic problem.
 *
 * These are display numbers, so plain float arithmetic is correct here. The
 * money itself was computed exactly upstream by `packages/core/src/money` and
 * arrives already rounded for presentation; nothing in this file is ever
 * written back to a ledger. `scripts/check-money.mjs` scopes its `Number(` ban
 * to `services/` and `uae/` for exactly this reason.
 */

/** A closed numeric interval. `span` is never zero, so callers can divide. */
export interface Domain {
  min: number;
  max: number;
  span: number;
}

/**
 * Domain over a set of values, always including zero.
 *
 * Including zero is not a stylistic preference: a bar's length encodes its
 * value, and that encoding is only true if the bar starts at zero. An
 * all-positive series therefore gets `[0, max]` and a mixed series gets
 * `[min, max]` straddling it.
 */
export function domainOf(values: number[]): Domain {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  // A flat all-zero series would divide by zero. One unit of span renders every
  // bar at nothing, which is the honest picture of a series that is all zero.
  const span = max - min || 1;
  return { min, max, span };
}

/**
 * Domain over a LINE series, which — unlike a bar — may legitimately exclude
 * zero. A cash balance oscillating between 180k and 220k plotted from zero is a
 * flat line that hides the thing the reader came for. Position, not length,
 * carries the value on a line, so the zero rule does not apply.
 *
 * `include` forces extra values into the domain — a reference line has to be on
 * the chart or it is not a reference.
 */
export function lineDomain(values: number[], include: number[] = []): Domain {
  const all = [...values, ...include];
  if (all.length === 0) return { min: 0, max: 1, span: 1 };
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    // A perfectly flat series still needs a band to draw in, and it must sit in
    // the middle of it rather than on the floor — a flat line hugging the
    // baseline reads as "zero", which is a different fact.
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  return { min, max, span: max - min };
}

/** Fraction of the domain, 0 at `min` and 1 at `max`. Never clamped: a caller
 *  passing a value outside its own domain has a bug and should see it. */
export function project(value: number, d: Domain): number {
  return (value - d.min) / d.span;
}

/** Percentage string for a CSS length. Rounded to 0.01% — beyond that the
 *  precision is invisible and the markup is noisy in a diff. */
export function pct(fraction: number): string {
  return `${(Math.round(fraction * 10000) / 100).toFixed(2)}%`;
}

/**
 * Where a bar starts and how long it is, as fractions of the domain.
 *
 * Both signs go through this one function so a negative bar cannot accidentally
 * be drawn as a positive one of the same length — it starts at the value and
 * runs back to the baseline, on the other side of zero.
 */
export function barGeometry(value: number, d: Domain): { start: number; length: number } {
  const zero = project(0, d);
  const here = project(value, d);
  return { start: Math.min(zero, here), length: Math.abs(here - zero) };
}

/**
 * Axis ticks on round numbers.
 *
 * Ticks carry every value that is not directly labelled (see PDD §7.6, which
 * allows direct labels only on the endpoint, the extremes, and whatever the
 * conclusion names), so they have to be numbers a reader recognises — 0, 5,000,
 * 10,000 — not 3,847.5.
 */
export function niceTicks(d: Domain, target = 4): number[] {
  const rough = d.span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  // Thresholds at the GEOMETRIC midpoints between 1, 2, 5 and 10 — √2, √10 and
  // √50 — so each candidate step wins over the range it is genuinely closest
  // to. Naive `>= 2 → 5` thresholds round 2.35 up to a step of 5 and return two
  // ticks where four were asked for, which leaves a chart with a top gridline,
  // a baseline and nothing in between.
  const step = (norm >= Math.SQRT2 * 5 ? 10 : norm >= Math.sqrt(10) ? 5 : norm >= Math.SQRT2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let t = Math.ceil(d.min / step) * step; t <= d.max + step * 1e-9; t += step) {
    // -0 prints as "-0" through toLocaleString and looks like a defect.
    out.push(Object.is(t, -0) ? 0 : t);
  }
  return out;
}

// ── Waterfall ───────────────────────────────────────────────────────────────

export interface WaterfallStep {
  label: string;
  value: number;
  /** `total` anchors to zero and paints neutral; `delta` floats. Opening and
   *  closing balances are totals; everything between them is a driver. */
  kind?: "total" | "delta";
}

export interface WaterfallBar extends Required<WaterfallStep> {
  /** Cumulative position *before* this step — where the connector comes from. */
  from: number;
  /** Cumulative position *after* it. Equals `value` for a total. */
  to: number;
}

/**
 * Roll minor drivers into a single "Other" bar.
 *
 * PDD §7.3: "Five to eight steps maximum. Minor items roll into a single
 * 'other' bar. Beyond eight it stops being readable, and showing every
 * general-ledger line defeats the purpose."
 *
 * That rule is implemented here rather than written in a comment on the
 * component, because a rule a caller has to remember is a rule that gets
 * broken the first time somebody maps a P&L straight into the props. The
 * component calls this unconditionally, so a 40-line general ledger renders as
 * a readable bridge instead of a barcode.
 *
 * Totals are never rolled up — they are the anchors the bridge spans between —
 * and the smallest drivers by absolute size go first, so the roll-up removes
 * the bars carrying the least of the story.
 */
export function rollUpSteps(steps: WaterfallStep[], maxSteps = 8): WaterfallStep[] {
  const totals = steps.filter((s) => s.kind === "total");
  const deltas = steps.filter((s) => s.kind !== "total");
  const budget = Math.max(1, maxSteps - totals.length);
  if (deltas.length <= budget) return steps;

  // Keep the largest movers; the tail folds into one signed "Other".
  const ranked = [...deltas].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const keep = new Set(ranked.slice(0, budget - 1));
  const folded = ranked.slice(budget - 1);
  const other: WaterfallStep = {
    label: `Other (${folded.length})`,
    value: folded.reduce((t, s) => t + s.value, 0),
    kind: "delta",
  };

  const out: WaterfallStep[] = [];
  let placed = false;
  for (const s of steps) {
    if (s.kind === "total" || keep.has(s)) {
      out.push(s);
    } else if (!placed) {
      // "Other" takes the position of the first item it absorbs, which keeps it
      // inside the bridge rather than orphaned after the closing total.
      out.push(other);
      placed = true;
    }
  }
  // A bridge whose "Other" would land after the closing balance instead sits
  // immediately before it, so the cascade still ends on the anchor.
  if (!placed) out.splice(Math.max(0, out.length - 1), 0, other);
  return out;
}

/**
 * Turn steps into positioned bars.
 *
 * The closing total is NOT recomputed from the deltas. It is whatever the
 * caller says it is, because the caller got it from the ledger and this
 * function got it from arithmetic on rounded display values. Where the two
 * disagree the ledger wins and `bridgeResidual` reports the gap so a page can
 * show it rather than silently paint a bridge that does not reach its anchor.
 */
export function waterfallBars(steps: WaterfallStep[]): WaterfallBar[] {
  let cum = 0;
  return steps.map((s) => {
    const kind = s.kind ?? "delta";
    if (kind === "total") {
      cum = s.value;
      return { label: s.label, value: s.value, kind, from: 0, to: s.value };
    }
    const from = cum;
    cum += s.value;
    return { label: s.label, value: s.value, kind, from, to: cum };
  });
}

/** Gap between where the drivers land and where the closing total actually is.
 *  Non-zero means the bridge is incomplete — a driver is missing, not rounded. */
export function bridgeResidual(steps: WaterfallStep[]): number {
  const bars = waterfallBars(steps);
  const last = bars.at(-1);
  if (!last || last.kind !== "total") return 0;
  const arrivedAt = bars.at(-2)?.to ?? bars[0]?.to ?? 0;
  return last.value - arrivedAt;
}

// ── Heat binning ────────────────────────────────────────────────────────────

/**
 * Opacity steps for a one-hue heat ramp, measured rather than chosen.
 *
 * A heat cell is the series hue painted over the card surface at these
 * opacities. The alternative — a set of literal hex steps — cannot follow the
 * theme, and `color-mix()` in an SVG presentation attribute is not something
 * this product's browser floor is verified against. Compositing against the
 * surface is what a sequential ramp *is*, so doing it with alpha costs nothing
 * and inherits both themes for free.
 *
 * The floor is 0.48, not something rounder, because it is the smallest value at
 * which the lightest bin still clears the 2:1 contrast floor against the card
 * surface in BOTH themes. Measured with the data-viz palette validator against
 * `--surface` (#ffffff light, #15181f dark) for the accent, positive and
 * negative hues:
 *
 *   accent   light  #a2b0e7 2.12:1   dark #465989 2.58:1
 *   positive light  #85c1a5 2.07:1   dark #336e50 2.95:1
 *   negative light  #e19899 2.29:1   dark #7e4344 2.35:1
 *
 * and all six ramps also clear the ≥0.06 OKLCH lightness gap between adjacent
 * steps. At the more obvious 0.16 floor the lightest bin measured 1.26:1 and
 * was indistinguishable from an empty day. Four bins, not five: five cannot
 * hold both the contrast floor and the step gap inside the range 0.48–1.0.
 *
 * ── WHY 2:1 AND NOT THE 3:1 FR-V02 QUOTES ───────────────────────────────────
 * FR-V02's last acceptance criterion asks for WCAG 2.2 non-text contrast of
 * 3:1 on chart ELEMENTS. Every solid mark this directory paints clears it
 * comfortably in both themes — measured 5.10:1 to 9.40:1 for accent, positive,
 * negative, caution and the neutral totals colour. A step of a sequential ramp
 * is the one thing that cannot, and the reason is arithmetic rather than
 * effort. Solving for the lowest alpha that reaches 3:1 and then spacing the
 * remaining steps evenly up to full strength:
 *
 *   hue / theme          3:1 floor   4 steps       3 steps       2 steps
 *   accent light         α 0.68      ΔL 0.048 ✗    ΔL 0.074 ✓    ✓
 *   positive light       α 0.70      ΔL 0.043 ✗    ΔL 0.064 ✓    ✓
 *   negative light       α 0.62      ΔL 0.043 ✗    ΔL 0.051 ✗    ΔL 0.051 ✗
 *
 * `--negative` fails at every step count: above its 3:1 threshold the token has
 * less than 0.06 of OKLCH lightness left to spend, so NO ramp on it — not even
 * two shades — can be both 3:1-per-step and separable. A criterion that cannot
 * be met at two steps is not a criterion about ramps.
 *
 * That matches WCAG 1.4.11's actual scope: the requirement is on graphical
 * objects "required to understand the content", and for a continuous scale the
 * object is the SCALE, not each cell — which is why the data-viz method sets a
 * 2:1 floor on the lightest ordinal step and a 3:1 floor on solid marks. So the
 * relief is built rather than asserted: a scale legend mapping shade to value
 * on every heatmap, a table view carrying every exact figure, and — on the
 * diverging scale, where the ramp carries a SIGN — a 45° slash on outflow days
 * so the sign never depends on the ramp at all.
 *
 * The token-level remedy, for whoever owns `globals.css`: a dedicated
 * chart ramp per semantic hue (four declared steps rather than four alphas over
 * one token) could hold both floors, because the steps would not be constrained
 * to lie between one token and the surface. That is a design-system addition,
 * not a change to this file.
 */
export const HEAT_STEPS = [0.48, 0.65, 0.82, 1] as const;

/**
 * Bin a value onto the heat ramp.
 *
 * Returns 0 for "no activity", which is a category rather than a low value — an
 * empty till day and a quiet one are different facts and must not share a
 * shade. Bins 1..4 index `HEAT_STEPS`.
 *
 * Binning is on the ABSOLUTE value against the largest absolute value, so a
 * diverging scale's two arms are symmetric: a day of −5,000 is as loud as a day
 * of +5,000, which is the whole point of diverging around zero.
 */
export function heatBin(value: number, maxAbs: number): number {
  if (value === 0 || maxAbs === 0) return 0;
  const t = Math.abs(value) / maxAbs;
  return Math.min(HEAT_STEPS.length, Math.max(1, Math.ceil(t * HEAT_STEPS.length)));
}

/**
 * The value the darkest bin represents — a high quantile, not the maximum.
 *
 * Binning against the maximum is the obvious choice and it is wrong on real
 * ledger data, which is heavy-tailed. Measured on this product's own seeded
 * cash movement: one AED 634k day against a median under AED 20k pushed 88 of
 * 90 cells into bin 1, and the chart rendered as a flat green field that said
 * nothing. A single outlier should not be allowed to erase the pattern in the
 * other eighty-nine days — showing the pattern is the entire reason this form
 * was chosen over a line.
 *
 * So the ceiling is the 95th percentile of the absolute values and days above
 * it clamp to the darkest bin. That is a real trade and the caller must not be
 * able to hide it: `CalendarHeatmap` says "or more" in its scale legend when
 * clamping actually occurred, and the table view carries every exact figure, so
 * nothing is lost — only compressed at the top, where the ramp had run out of
 * steps anyway.
 */
export function heatCeiling(values: number[], quantile = 0.95): number {
  const sorted = values.map(Math.abs).filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)));
  // Never return a ceiling of zero from a non-empty series: it would send every
  // day to bin 0 and report real movement as "no activity".
  return sorted[i] || sorted.at(-1)!;
}

// ── Calendar layout ─────────────────────────────────────────────────────────

/** One cell of a calendar heatmap grid. `week` is the column, `weekday` the row. */
export interface CalendarCell {
  date: string;
  week: number;
  /** 0 = Monday. The UAE working week runs Monday–Friday since 2022, so a
   *  Monday-first grid puts the weekend in the last two rows where the eye
   *  expects the quiet band. A Sunday-first grid splits it across both ends. */
  weekday: number;
  value: number | null;
}

/** Days between two ISO dates, exclusive of neither. UTC throughout: these are
 *  calendar dates, not instants, and a timezone offset here would shift a
 *  cell into the wrong day. */
export function eachDay(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toIso}T00:00:00Z`);
  for (let t = Date.parse(`${fromIso}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Lay a date range onto a Monday-first week grid, filling gaps with `null`
 *  (a day with no row is not a day worth zero). */
export function calendarGrid(
  fromIso: string,
  toIso: string,
  values: Map<string, number>,
): { cells: CalendarCell[]; weeks: number } {
  const days = eachDay(fromIso, toIso);
  if (days.length === 0) return { cells: [], weeks: 0 };
  const weekdayOf = (iso: string) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  const lead = weekdayOf(days[0]);
  const cells = days.map((date, i) => ({
    date,
    week: Math.floor((i + lead) / 7),
    weekday: weekdayOf(date),
    value: values.get(date) ?? null,
  }));
  return { cells, weeks: (cells.at(-1)?.week ?? 0) + 1 };
}

/** Month boundaries for the column ruler above a calendar heatmap. */
export function monthTicks(cells: CalendarCell[]): { week: number; label: string }[] {
  const out: { week: number; label: string }[] = [];
  for (const c of cells) {
    if (!c.date.endsWith("-01") && out.length > 0) continue;
    const label = new Date(`${c.date}T00:00:00Z`).toLocaleDateString("en-AE", {
      month: "short",
      timeZone: "UTC",
    });
    if (out.at(-1)?.label === label) continue;
    out.push({ week: c.week, label });
  }
  return out;
}

// ── Line paths ──────────────────────────────────────────────────────────────

/**
 * SVG path through a series, in a 0–100 × 0–100 unit box.
 *
 * A unit box rather than pixels because the plot is drawn with
 * `preserveAspectRatio="none"` and stretched to whatever width the card gets —
 * see `line-chart.tsx` for why that is the right trade and how the stroke
 * stays 2px through it.
 *
 * y is inverted here (SVG's origin is top-left) so callers never have to
 * remember to do it, which is a mistake that renders a chart upside down and
 * still looks plausible.
 */
export function linePath(values: number[], d: Domain): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = (100 - project(values[0], d) * 100).toFixed(2);
    return `M0.00,${y} L100.00,${y}`;
  }
  const step = 100 / (values.length - 1);
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(100 - project(v, d) * 100).toFixed(2)}`)
    .join(" ");
}

/** The same path closed to the baseline, for an area wash. Closes to the
 *  domain floor rather than to y=100 so it never fills below a truncated axis. */
export function areaPath(values: number[], d: Domain): string {
  const line = linePath(values, d);
  if (!line) return "";
  const floor = (100 - project(Math.max(d.min, 0), d) * 100).toFixed(2);
  return `${line} L100.00,${floor} L0.00,${floor} Z`;
}
