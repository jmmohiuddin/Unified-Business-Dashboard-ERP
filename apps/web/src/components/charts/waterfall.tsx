import { ChartFrame, MARK, vars } from "./chart-frame";
import { domainOf, pct, project, rollUpSteps, waterfallBars, type WaterfallStep } from "./scale";
import type { ChartBase, ValueFormat } from "./types";

/**
 * WATERFALL — the most important chart in the product (PDD §7.3).
 *
 * "The owner's question is almost never 'what is my profit.' It is 'why is it
 * different from last month.' That is a bridge, and the bridge is the chart
 * that answers it."
 *
 * ── WHY IT RUNS TOP-TO-BOTTOM RATHER THAN LEFT-TO-RIGHT ─────────────────────
 * A conventional waterfall is a column chart and needs one column-width per
 * driver plus a rotated label under each. On the 360px phone this product is
 * designed for (PDD §9), eight rotated labels is either unreadable or a
 * horizontal scroll, and §9.2 explicitly rules out horizontal scrolling and
 * asks for "wide-short or square aspect ratios that fit portrait". Turned on
 * its side the cascade reads down the page, every driver name gets a full text
 * line at its real size, and the value sits at the row end where the eye
 * already is. The bridge semantics are identical — bars still float between
 * the previous cumulative total and the new one, anchored by two totals.
 *
 * ── EVERY §7.3 CONSTRUCTION RULE, AND WHERE IT LIVES ────────────────────────
 *   opening/closing anchored to zero      `barGeometry` against a zero-spanning
 *                                          domain; `kind: "total"`
 *   interior bars float                    `waterfallBars` carries from → to
 *   exactly two semantic colours + neutral MARK.positive / .negative / .neutral,
 *                                          never a per-category rainbow
 *   thin grey connectors                   the 1px rules between tracks
 *   every bar signed and labelled          glyph + signed value on every row
 *   five to eight steps maximum            `rollUpSteps`, applied here rather
 *                                          than trusted to the caller
 *
 * ── SIGN IS NEVER CARRIED BY COLOUR ALONE ───────────────────────────────────
 * FR-V02 requires redundant encoding, and the measurement says it is not
 * optional here. Run through the data-viz validator, `--positive` against
 * `--negative` separates by only ΔE 5.9 under the worst of simulated
 * protanopia/deuteranopia in the LIGHT theme — under the 6.0 floor. (Dark
 * measures 12.8 and passes.) So sign rides three channels that are not hue:
 * the ▲/▼ glyph in the row label, the explicit +/− on the value, and the
 * direction the bar travels from the zero rule. A reader who sees no colour at
 * all still reads the bridge correctly.
 *
 * The remedy at token level, for whoever owns `globals.css`: dropping
 * `--positive` from `oklch(52% 0.14 155)` to `oklch(51% 0.10 154)` takes the
 * pair to ΔE 9.3 and clears the floor. That is one token value, not a redesign.
 *
 * Server component. No client JavaScript: no state, no measurement, and hover
 * readouts are native `title` tooltips on the marks, with the table view as the
 * keyboard and screen-reader path.
 */
export function Waterfall({
  steps,
  format,
  maxSteps = 8,
  ...frame
}: ChartBase & {
  steps: WaterfallStep[];
  format: ValueFormat;
  /** PDD §7.3 caps this at eight and the default is the cap. Lower it for a
   *  narrow card; raising it is how a bridge becomes a barcode. */
  maxSteps?: number;
}) {
  const rolled = rollUpSteps(steps, maxSteps);
  const bars = waterfallBars(rolled);

  // The domain spans every cumulative position the cascade passes through, not
  // just the step values: an interior bar sits at its running total, so a
  // domain built from the values alone would let a bar run off the plot.
  const domain = domainOf(bars.flatMap((b) => [b.from, b.to]));
  const zeroX = project(0, domain);

  return (
    <ChartFrame
      {...frame}
      table={{
        caption: `${frame.title ?? "Bridge"} — each driver with its value and the running total after it`,
        headers: ["Step", "Change", "Running total"],
        rows: bars.map((b) => [
          b.label,
          b.kind === "total" ? "—" : `${b.value >= 0 ? "+" : "−"}${format(Math.abs(b.value))}`,
          format(b.to),
        ]),
      }}
    >
      <ol className="mt-1">
        {bars.map((b, i) => {
          // Interior bars span from → to; totals span zero → value, which
          // `waterfallBars` already encodes as `from: 0`. One projection serves
          // both, so a negative can never be drawn as a positive of equal
          // length — the defect `BarRow`'s `Math.abs()` shipped with.
          const fromX = project(b.from, domain);
          const toX = project(b.to, domain);
          const left = Math.min(fromX, toX);
          const width = Math.abs(toX - fromX);

          const up = b.value >= 0;
          const mark = b.kind === "total" ? MARK.neutral : up ? MARK.positive : MARK.negative;
          const glyph = b.kind === "total" ? "=" : up ? "▲" : "▼";
          const signed =
            b.kind === "total" ? format(b.value) : `${up ? "+" : "−"}${format(Math.abs(b.value))}`;

          return (
            <li
              key={`${b.label}-${i}`}
              className="grid grid-cols-[minmax(0,5.5rem)_1fr_auto] sm:grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-x-2"
            >
              <span
                className={`text-2xs truncate ${b.kind === "total" ? "font-semibold" : "text-muted"}`}
                title={b.label}
              >
                <span aria-hidden className="me-1 text-[0.85em]">
                  {glyph}
                </span>
                {b.label}
              </span>

              {/* 28px track, 14px bar centred in it. The 7px of air above and
                  below is the surface gap that separates adjacent marks — a
                  gap, never a border drawn around the bar. */}
              <div className="relative h-7">
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-border"
                  style={vars({ left: pct(zeroX) })}
                />
                <div
                  className={`absolute top-[7px] h-3.5 bg-[var(--mark)] ${
                    b.kind === "total"
                      ? up
                        ? "rounded-r-[4px]"
                        : "rounded-l-[4px]"
                      : "rounded-[3px]"
                  }`}
                  style={vars({
                    "--mark": mark,
                    left: pct(left),
                    // A driver worth a rounding error still has to be visible,
                    // or the reader concludes it was not in the data at all.
                    width: `max(2px, ${pct(width)})`,
                  })}
                  title={`${b.label}: ${signed} (running total ${format(b.to)})`}
                />
                {/* Connector into the next row, at the cumulative position this
                    step leaves off — 21px is the bar's underside, 14px carries
                    it through the gap to the next bar's top edge. */}
                {i < bars.length - 1 && (
                  <div
                    aria-hidden
                    className="absolute top-[21px] h-3.5 w-px bg-border-strong opacity-40"
                    style={vars({ left: pct(toX) })}
                  />
                )}
              </div>

              <span
                className={`text-2xs tnum text-right ${b.kind === "total" ? "font-semibold" : "text-muted"}`}
              >
                {signed}
              </span>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
