import Link from "next/link";
import { ChartFrame, ChartLegend, MARK, vars } from "./chart-frame";
import { HEAT_STEPS, domainOf, pct, project } from "./scale";
import type { ChartBase, MarkTone, ValueFormat } from "./types";

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  /** Only read when `segmentScale="tone"`. */
  tone?: MarkTone;
}

export interface BarDatum {
  label: string;
  /** Ignored when `segments` is present — the total is the sum of the stack. */
  value?: number;
  segments?: BarSegment[];
  /** Draws a target rule on this row. PDD §7.2, "variance to budget". */
  target?: number;
  /** Identity hue. Status tones are for status; see `chart-frame.tsx`. */
  mark?: string;
  /** Small print under the row — a count, a share, a due date. */
  meta?: string;
  /** D2 applied to charts (PDD §7.8): clicking a mark drills to the rows. */
  href?: string;
}

/**
 * HORIZONTAL BAR — the product's part-to-whole and ranking form (PDD §7.2).
 *
 * Covers four rows of §7.2's table in one component: profit by business,
 * revenue mix in a period, receivables ageing, and variance to budget. They
 * differ in scale and stacking, not in form, and splitting them into four
 * components would mean four places to fix the next `Math.abs()` bug.
 *
 * ── WHY NEVER A PIE, EVEN FOR PART-TO-WHOLE ─────────────────────────────────
 * §7.11 is blunt about it and the reason is specific to this product rather
 * than general taste: PROFIT BY BUSINESS CAN BE NEGATIVE, and a pie cannot
 * represent a negative slice at all. The one screen most likely to reach for a
 * pie is the one where a pie is arithmetically incapable of telling the truth.
 *
 * ── NEGATIVES ARE NOT ABSOLUTE VALUES ───────────────────────────────────────
 * `BarRow` in `ui.tsx` shipped `Math.abs()` on its bar length, so a
 * loss-making business rendered as an identical bar to a profitable one and the
 * only way to tell them apart was to read the number — on a screen whose entire
 * purpose is comparison at a glance. Here every bar goes through `project()`
 * against a domain that spans zero, so a negative runs the other way from a
 * visible baseline, in the negative colour, with a ▼ on its value.
 *
 * ── STACK COLOURS ───────────────────────────────────────────────────────────
 * Default `segmentScale="ordinal"`: one hue at four validated opacity steps.
 * That is correct for ageing buckets and any other ORDERED set of classes —
 * §7.2 asks for "sequential across buckets" for exactly this — and it means a
 * stacked chart does not depend on the business-unit palette, whose measured
 * CVD failures are documented in `chart-frame.tsx`. Use `"tone"` only where the
 * segments are genuinely unordered categories.
 *
 * Four bins is also the ceiling the ramp supports; a fifth class folds into
 * "Other" rather than getting a generated shade, per §7.11.
 *
 * Server component.
 */
export function BarChart({
  rows,
  format,
  sort = true,
  normalize = false,
  segmentScale = "ordinal",
  max,
  ...frame
}: ChartBase & {
  rows: BarDatum[];
  format: ValueFormat;
  /** Ranked by value, descending. Off for an ordered dimension — ageing
   *  buckets and months mean nothing re-sorted by size. */
  sort?: boolean;
  /** 100% stacked: every row fills the track and the segments are shares.
   *  §7.2's "revenue mix over time". Only meaningful with `segments`. */
  normalize?: boolean;
  segmentScale?: "ordinal" | "tone";
  /** Shared ceiling. Defaults to the widest row, including any target. */
  max?: number;
}) {
  const totalOf = (r: BarDatum) =>
    r.segments ? r.segments.reduce((t, s) => t + s.value, 0) : (r.value ?? 0);

  const ordered = sort ? [...rows].sort((a, b) => totalOf(b) - totalOf(a)) : rows;
  const domain = max !== undefined
    ? { min: Math.min(0, ...ordered.map(totalOf)), max, span: max - Math.min(0, ...ordered.map(totalOf)) || 1 }
    : domainOf(ordered.flatMap((r) => [totalOf(r), ...(r.target !== undefined ? [r.target] : [])]));
  const zeroX = project(0, domain);
  const grandTotal = ordered.reduce((t, r) => t + totalOf(r), 0);

  // Segment identity comes from the FIRST row that has segments, so a legend
  // slot keeps its shade when a later row happens to be missing a bucket. A
  // scale keyed off each row's own segments would repaint on filter, which is
  // the recolour-on-filter anti-pattern §7.11 bans.
  const segmentKeys: BarSegment[] = ordered.find((r) => r.segments?.length)?.segments ?? [];
  const shadeOf = (key: string): { mark: string; opacity: number } => {
    const i = segmentKeys.findIndex((s) => s.key === key);
    if (segmentScale === "tone") {
      const seg = segmentKeys[i];
      return { mark: MARK[seg?.tone ?? "accent"], opacity: 1 };
    }
    // Light → dark in reading order, so the LAST segment is the heaviest. On
    // the ageing chart this component exists for, the last bucket is "90+ days"
    // and it is the one the reader must weigh — a ramp running the other way
    // paints the harmless current balance darkest and buries the bad debt.
    // Ordinal scales conventionally run light-to-dark in reading order for the
    // same reason.
    const step = HEAT_STEPS[Math.min(HEAT_STEPS.length - 1, i)];
    return { mark: MARK.accent, opacity: step ?? HEAT_STEPS.at(-1)! };
  };

  const stacked = segmentKeys.length > 0;

  return (
    <ChartFrame
      {...frame}
      table={{
        caption: `${frame.title ?? "Comparison"} — every row with its value`,
        headers: stacked
          ? ["Row", ...segmentKeys.map((s) => s.label), "Total"]
          : ["Row", "Value", ...(ordered.some((r) => r.target !== undefined) ? ["Target"] : [])],
        rows: ordered.map((r) =>
          stacked
            ? [
                r.label,
                ...segmentKeys.map((k) =>
                  format(r.segments?.find((s) => s.key === k.key)?.value ?? 0),
                ),
                format(totalOf(r)),
              ]
            : [
                r.label,
                format(totalOf(r)),
                ...(ordered.some((x) => x.target !== undefined)
                  ? [r.target === undefined ? "—" : format(r.target)]
                  : []),
              ],
        ),
      }}
      footnote={
        stacked && normalize && grandTotal !== 0 ? (
          <>Shares of each row&rsquo;s own total. Row totals: {format(grandTotal)} overall.</>
        ) : (
          frame.footnote
        )
      }
    >
      {stacked && (
        <ChartLegend
          // The ordinal scale is one hue at four opacities, so a legend that
          // carried only the hue would show four identical swatches and tell
          // the reader nothing — the step IS the identity here.
          items={segmentKeys.map((s) => ({ label: s.label, ...shadeOf(s.key) }))}
        />
      )}

      <ul className="space-y-2.5">
        {ordered.map((r) => {
          const total = totalOf(r);
          const negative = total < 0;
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-2xs font-medium truncate" title={r.label}>
                  {r.label}
                </span>
                <span className="text-2xs tnum font-semibold shrink-0">
                  {negative && (
                    <span aria-hidden className="me-0.5">
                      ▼
                    </span>
                  )}
                  {format(total)}
                  {r.target !== undefined && (
                    <span className="text-subtle font-normal">
                      {" "}
                      / {format(r.target)}
                    </span>
                  )}
                </span>
              </div>

              <div className="relative h-2.5">
                {domain.min < 0 && (
                  <div
                    aria-hidden
                    className="absolute inset-y-[-2px] w-px bg-border"
                    style={vars({ left: pct(zeroX) })}
                  />
                )}

                {stacked && r.segments ? (
                  (() => {
                    const rowTotal = r.segments.reduce((t, s) => t + s.value, 0) || 1;
                    const rowWidth = normalize ? 1 : Math.abs(project(total, domain) - zeroX);
                    let cursor = 0;
                    return r.segments.map((s) => {
                      const share = s.value / rowTotal;
                      const left = zeroX + cursor * rowWidth;
                      cursor += share;
                      const { mark, opacity } = shadeOf(s.key);
                      return (
                        <div
                          key={s.key}
                          // The 2px taken off each width IS the surface gap —
                          // the separator between touching fills is the card
                          // showing through, never a stroke drawn round a mark.
                          className="absolute inset-y-0 bg-[var(--mark)] first:rounded-l-[3px] last:rounded-r-[3px]"
                          style={vars({
                            "--mark": mark,
                            opacity,
                            left: pct(left),
                            width: `max(0px, calc(${pct(share * rowWidth)} - 2px))`,
                          })}
                          title={`${r.label} · ${s.label}: ${format(s.value)}`}
                        />
                      );
                    });
                  })()
                ) : (
                  <div
                    className={`absolute inset-y-0 bg-[var(--mark)] ${negative ? "rounded-l-[4px]" : "rounded-r-[4px]"}`}
                    style={vars({
                      "--mark": r.mark ?? (negative ? MARK.negative : MARK.accent),
                      left: pct(Math.min(zeroX, project(total, domain))),
                      width: `max(2px, ${pct(Math.abs(project(total, domain) - zeroX))})`,
                    })}
                    title={`${r.label}: ${format(total)}`}
                  />
                )}

                {r.target !== undefined && !normalize && (
                  <div
                    aria-hidden
                    className="absolute inset-y-[-3px] w-0.5 rounded-full bg-text"
                    style={vars({ left: pct(project(r.target, domain)) })}
                    title={`Target ${format(r.target)}`}
                  />
                )}
              </div>

              {r.meta && <p className="text-2xs text-subtle mt-1">{r.meta}</p>}
            </>
          );

          return (
            <li key={r.label}>
              {r.href ? (
                <Link
                  href={r.href}
                  className="block -mx-1.5 px-1.5 py-1 rounded-md hover:bg-surface-2 transition-colors"
                >
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}
