/**
 * Conclusion generators.
 *
 * FR-V02's acceptance criterion is not "every chart has a caption" — it is
 * "every chart carries a plain-language conclusion line, GENERATED FROM THE
 * DATA, not a title". A hand-typed caption satisfies the type checker and then
 * drifts: the bars move next month and the sentence above them does not, which
 * is worse than no sentence because the reader believes it.
 *
 * So the required prop is fed by a function of the same data the chart plots.
 * Each generator here is pure, total, and returns a real sentence — number
 * first, then the concentration, then the implied action where the data
 * supports one. PDD §7.7's target shape is:
 *
 *   "AED 61,000 of the AED 96,000 owed is from two tenants, both past 90 days"
 *
 * WHAT THESE DELIBERATELY DO NOT DO
 *
 * They do not explain WHY. "Profit fell AED 7,400" is arithmetic and is always
 * true; "profit fell because the AC recharge landed" is a causal claim, and a
 * template that asserts causation from a single large bar will eventually
 * assert a false one to a business owner making a decision. Where the biggest
 * driver is named it is named as the biggest MOVER — a fact — and the causal
 * reading is left to the reader, who knows their own business. A page with real
 * domain knowledge is free to write a better sentence by hand; the required
 * prop takes any string. These are the honest floor, not a ceiling.
 *
 * Nothing here is money arithmetic in the ledger sense: the values arrive
 * already computed and rounded for display by `packages/core/src/money`.
 */

import type { Point, ValueFormat } from "./types";
import { bridgeResidual, type WaterfallStep } from "./scale";

/** "1 day" / "2 days" without a call site remembering to pluralise. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function niceDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AE", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Why a total moved.
 *
 * States the movement between the opening and closing anchors, then names the
 * single largest driver in each direction — which is what a reader scanning a
 * bridge is actually looking for. If the drivers do not add up to the closing
 * anchor the gap is stated rather than hidden: an incomplete bridge that looks
 * complete is the failure mode that makes this chart untrustworthy.
 */
export function concludeWaterfall(
  steps: WaterfallStep[],
  format: ValueFormat,
  opts: { subject: string; period?: string } = { subject: "Profit" },
): string {
  const totals = steps.filter((s) => s.kind === "total");
  const deltas = steps.filter((s) => s.kind !== "total");
  const open = totals[0]?.value ?? 0;
  const close = totals.at(-1)?.value ?? open + deltas.reduce((t, s) => t + s.value, 0);
  const move = close - open;
  const where = opts.period ? ` in ${opts.period}` : "";

  if (deltas.length === 0) {
    return `${opts.subject} is ${format(close)}${where}, with no movement recorded against it.`;
  }

  const up = [...deltas].filter((s) => s.value > 0).sort((a, b) => b.value - a.value)[0];
  const down = [...deltas].filter((s) => s.value < 0).sort((a, b) => a.value - b.value)[0];

  const direction =
    move > 0 ? `rose ${format(Math.abs(move))}` : move < 0 ? `fell ${format(Math.abs(move))}` : "was flat";
  let out = `${opts.subject} ${direction}${where}, from ${format(open)} to ${format(close)}.`;

  // Name the biggest mover on the side that explains the direction of travel;
  // when the movement is flat both sides are interesting because they cancelled.
  const lead = move >= 0 ? up : down;
  const other = move >= 0 ? down : up;
  if (lead) {
    out += ` The largest single mover was ${lead.label} at ${lead.value > 0 ? "+" : "−"}${format(Math.abs(lead.value))}`;
    out += other ? `, against ${other.label} at ${other.value > 0 ? "+" : "−"}${format(Math.abs(other.value))}.` : ".";
  }

  const residual = bridgeResidual(steps);
  if (Math.abs(residual) > 0.5) {
    out += ` The named drivers leave ${format(Math.abs(residual))} of the change unexplained.`;
  }
  return out;
}

/**
 * Attainment against a target.
 *
 * Always states the gap in the unit the reader acts in, not only as a
 * percentage: "6 units short" tells a landlord what to do and "93% of target"
 * does not.
 */
export function concludeBullet(opts: {
  subject: string;
  actual: number;
  target: number;
  format: ValueFormat;
  /** e.g. `{ of: 41, unit: "unit" }` renders "34 of 41 units". */
  count?: { done: number; of: number; unit: string };
}): string {
  const { subject, actual, target, format } = opts;
  const gap = actual - target;
  const head = opts.count
    ? `${subject} is ${opts.count.done} of ${plural(opts.count.of, opts.count.unit)} — ${format(actual)}`
    : `${subject} is ${format(actual)}`;
  if (target === 0) return `${head}, with no target set.`;
  if (Math.abs(gap) < Number.EPSILON) return `${head}, exactly on the ${format(target)} target.`;
  return gap > 0
    ? `${head}, ${format(Math.abs(gap))} ahead of the ${format(target)} target.`
    : `${head}, ${format(Math.abs(gap))} short of the ${format(target)} target.`;
}

/**
 * Ranked comparison.
 *
 * Leads with concentration rather than with the winner, because concentration
 * is the actionable fact: one business earning most of the group's revenue is a
 * risk statement, and the ranking alone does not say it. Negative rows are
 * called out separately — they are the reason PDD §7.11 forbids a pie here.
 */
export function concludeBars(
  rows: { label: string; value: number }[],
  format: ValueFormat,
  opts: { subject: string; topN?: number } = { subject: "Revenue" },
): string {
  if (rows.length === 0) return `No ${opts.subject.toLowerCase()} recorded in this period.`;
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const total = rows.reduce((t, r) => t + r.value, 0);
  const losses = sorted.filter((r) => r.value < 0);
  const n = Math.min(opts.topN ?? 2, sorted.length);

  if (rows.length === 1) {
    return `All ${opts.subject.toLowerCase()} — ${format(sorted[0].value)} — came from ${sorted[0].label}.`;
  }

  const head = sorted.slice(0, n);
  const headSum = head.reduce((t, r) => t + r.value, 0);
  const names = head.map((r) => r.label);
  const joined = names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(", ");

  // A share of a total that spans zero is meaningless — two businesses can
  // "make 400% of group profit" when a third loses money — so the share is
  // stated only where every row points the same way.
  const shareIsMeaningful = total !== 0 && losses.length === 0;
  let out = shareIsMeaningful
    ? `${joined} make ${format(headSum)} of the ${format(total)} total ${opts.subject.toLowerCase()}.`
    : `${joined} lead on ${opts.subject.toLowerCase()}, at ${format(headSum)} between them.`;

  if (losses.length > 0) {
    const worst = losses.at(-1)!;
    out +=
      losses.length === 1
        ? ` ${worst.label} is the only one negative, at ${format(worst.value)}.`
        : ` ${plural(losses.length, "unit is", "units are")} negative, worst ${worst.label} at ${format(worst.value)}.`;
  }
  return out;
}

/**
 * A series over time.
 *
 * Names the current value, the movement across the window, and the extreme —
 * because on a cash line the low point is the thing that decides whether the
 * owner can pay salaries, and it is invisible in the endpoints alone.
 */
export function concludeTrend(
  points: Point[],
  format: ValueFormat,
  opts: { subject: string; floor?: number; floorLabel?: string } = { subject: "Cash" },
): string {
  if (points.length === 0) return `No ${opts.subject.toLowerCase()} data for this period.`;
  const last = points.at(-1)!;
  if (points.length === 1) return `${opts.subject} is ${format(last.y)} at ${niceDate(last.x)}.`;

  const first = points[0];
  const move = last.y - first.y;
  const low = points.reduce((m, p) => (p.y < m.y ? p : m), first);
  const dir = move > 0 ? `up ${format(Math.abs(move))}` : move < 0 ? `down ${format(Math.abs(move))}` : "flat";
  let out = `${opts.subject} is ${format(last.y)}, ${dir} over ${plural(points.length, "day")}.`;

  if (opts.floor !== undefined) {
    const breaches = points.filter((p) => p.y < opts.floor!);
    const label = opts.floorLabel ?? `the ${format(opts.floor)} floor`;
    out +=
      breaches.length > 0
        ? ` It went below ${label} on ${plural(breaches.length, "day")}, lowest ${format(low.y)} on ${niceDate(low.x)}.`
        : ` It stayed above ${label} throughout, closest at ${format(low.y)} on ${niceDate(low.x)}.`;
  } else if (low.x !== last.x && low.y < last.y) {
    out += ` The low was ${format(low.y)} on ${niceDate(low.x)}.`;
  }
  return out;
}

/**
 * Daily density or daily movement.
 *
 * The pattern is the point of a calendar heatmap, so the sentence reports the
 * shape — how many days were negative, and whether they cluster on one weekday.
 * A cluster on a single weekday is the finding PDD §7.7 uses as its worked
 * example ("the salon till has been short four of the last six closes, always
 * on the evening shift") and it is the one thing a 365-point line cannot show.
 */
export function concludeCalendar(
  days: { date: string; value: number }[],
  format: ValueFormat,
  opts: { subject: string; mode?: "sequential" | "diverging" } = { subject: "Cash" },
): string {
  const active = days.filter((d) => d.value !== 0);
  if (active.length === 0) return `No ${opts.subject.toLowerCase()} recorded on any day in this period.`;

  const WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dayOf = (iso: string) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

  if (opts.mode === "diverging") {
    const down = active.filter((d) => d.value < 0);
    const worst = down.reduce<{ date: string; value: number } | null>(
      (m, d) => (m === null || d.value < m.value ? d : m),
      null,
    );
    if (down.length === 0) {
      const best = active.reduce((m, d) => (d.value > m.value ? d : m), active[0]);
      return `${opts.subject} was positive on every one of the ${plural(active.length, "active day")}, best ${format(best.value)} on ${niceDate(best.date)}.`;
    }
    let out = `${opts.subject} was negative on ${down.length} of ${plural(days.length, "day")}, worst ${format(worst!.value)} on ${niceDate(worst!.date)}.`;
    const counts = new Map<number, number>();
    for (const d of down) counts.set(dayOf(d.date), (counts.get(dayOf(d.date)) ?? 0) + 1);
    const [wd, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    // Only claim a pattern when one weekday holds a real majority of the bad
    // days. "Mostly Tuesdays" from 2 of 5 is a coincidence dressed as a finding.
    if (down.length >= 4 && n / down.length >= 0.5) out += ` ${n} of them fell on a ${WEEKDAY[wd]}.`;
    return out;
  }

  const total = active.reduce((t, d) => t + d.value, 0);
  const busiest = active.reduce((m, d) => (d.value > m.value ? d : m), active[0]);
  return (
    `${opts.subject} totalled ${format(total)} across ${plural(active.length, "active day")} ` +
    `of ${days.length}, peaking at ${format(busiest.value)} on ${niceDate(busiest.date)}.`
  );
}

/**
 * Six businesses on a shared scale.
 *
 * The comparison a shared scale makes possible is "who moved", so the sentence
 * reports the spread of movement rather than restating the leader, which the
 * panel titles and end labels already say.
 */
export function concludeSmallMultiples(
  panels: { label: string; points: Point[] }[],
  format: ValueFormat,
  opts: { subject: string } = { subject: "Revenue" },
): string {
  const withData = panels.filter((p) => p.points.length >= 2);
  if (withData.length === 0) return `No ${opts.subject.toLowerCase()} history for any business in this period.`;

  const moves = withData.map((p) => ({
    label: p.label,
    move: p.points.at(-1)!.y - p.points[0].y,
    last: p.points.at(-1)!.y,
  }));
  const best = moves.reduce((m, p) => (p.move > m.move ? p : m), moves[0]);
  const worst = moves.reduce((m, p) => (p.move < m.move ? p : m), moves[0]);
  const rising = moves.filter((p) => p.move > 0).length;

  if (best.label === worst.label) {
    return `${withData[0].label} is the only business with ${opts.subject.toLowerCase()} history here: ${format(best.last)}, ${best.move >= 0 ? "up" : "down"} ${format(Math.abs(best.move))}.`;
  }
  return (
    `${rising} of ${withData.length} businesses grew ${opts.subject.toLowerCase()} over this window. ` +
    `${best.label} moved most, ${best.move >= 0 ? "+" : "−"}${format(Math.abs(best.move))}; ` +
    `${worst.label} moved least, ${worst.move >= 0 ? "+" : "−"}${format(Math.abs(worst.move))}.`
  );
}

/**
 * A single headline number.
 *
 * A stat tile's conclusion is the one place a template is genuinely right: the
 * tile has exactly one number and one comparison, so there is nothing to
 * select and nothing to get wrong.
 */
export function concludeStat(opts: {
  subject: string;
  value: number;
  format: ValueFormat;
  prior?: number | null;
  priorLabel?: string;
  /** Whether up is good. Getting this wrong is how a dashboard congratulates
   *  its owner on a 20% rise in overdue debt. */
  polarity?: "higher_is_better" | "lower_is_better" | "neutral";
}): string {
  const { subject, value, format, prior, polarity = "higher_is_better" } = opts;
  if (prior === null || prior === undefined) {
    return `${subject} is ${format(value)}. No comparable prior period.`;
  }
  const move = value - prior;
  const label = opts.priorLabel ?? "the prior period";
  if (move === 0) return `${subject} is ${format(value)}, unchanged from ${label}.`;
  const dir = move > 0 ? "up" : "down";
  const good = polarity === "neutral" ? null : polarity === "higher_is_better" ? move > 0 : move < 0;
  const gloss = good === null ? "" : good ? "" : " — the wrong direction";
  return `${subject} is ${format(value)}, ${dir} ${format(Math.abs(move))} on ${label}${gloss}.`;
}
