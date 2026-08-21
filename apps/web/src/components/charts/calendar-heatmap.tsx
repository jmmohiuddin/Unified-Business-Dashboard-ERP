import { ChartFrame, MARK, vars } from "./chart-frame";
import { HEAT_STEPS, calendarGrid, heatBin, heatCeiling, monthTicks } from "./scale";
import type { ChartBase, ValueFormat } from "./types";

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * CALENDAR HEATMAP (PDD §7.2).
 *
 * Two jobs, one component:
 *
 *   daily cash movement  → `mode="diverging"`, two arms around zero
 *   booking/job density  → `mode="sequential"`, one hue
 *
 * The form exists because the alternative for a quarter of daily data is "a
 * 365-point line" or "a bar per day", both of which §7.2 names as the wrong
 * answer. Neither shows the thing the owner needs: that the bad days are all
 * Fridays. Weekday is a ROW here, so a weekly pattern is a horizontal stripe
 * and reads at a glance.
 *
 * ── MONDAY-FIRST ROWS ───────────────────────────────────────────────────────
 * The UAE working week has run Monday–Friday since January 2022. A Monday-first
 * grid puts Sat/Sun in the last two rows, where the eye expects the quiet band;
 * the US convention of Sunday-first splits the weekend across both ends of the
 * column and destroys exactly the pattern this chart is for.
 *
 * ── THE RAMP IS MEASURED, NOT CHOSEN ────────────────────────────────────────
 * A cell is the series hue painted over the card surface at one of four
 * opacities (`HEAT_STEPS`). Four bins, floor 0.48 — every alternative was
 * rejected by measurement rather than taste, and `scale.ts` records the numbers
 * and the validator runs behind them. The short version: at the obvious 0.16
 * floor the lightest bin measured 1.26:1 against the surface and was
 * indistinguishable from an empty day.
 *
 * A day with no activity is bin 0 and renders as a flat `--surface-2` tint. It
 * is a CATEGORY, not a small value: "the till took nothing" and "the till took
 * AED 40" are different facts and must not share a shade.
 *
 * ── SIGN WITHOUT COLOUR ─────────────────────────────────────────────────────
 * FR-V02: "no chart conveys meaning through colour alone. Sign is always
 * carried redundantly by a symbol or a label." At 13px there is no room for a
 * glyph inside a cell, so outflow days carry a 45° hairline slash in the
 * surface colour — one stroke, unmistakable at cell scale, and legible in
 * greyscale, in print, and to a reader who sees no red/green distinction at
 * all. The legend shows the slashed swatch beside the plain one, and the table
 * view carries every signed value.
 *
 * This matters more than it looks: `--positive` against `--negative` separates
 * by only ΔE 5.9 under simulated deuteranopia in the light theme, below the 6.0
 * floor. The slash is the channel that makes the chart correct, not a garnish.
 *
 * Server component. Per-cell `title` gives a hover readout; the table view is
 * the keyboard and screen-reader path, because 90 tab stops across a grid is a
 * worse experience than one table, not a better one.
 */
export function CalendarHeatmap({
  from,
  to,
  values,
  format,
  mode = "sequential",
  cell = 13,
  ...frame
}: ChartBase & {
  /** Inclusive ISO date bounds. Days with no entry render as "no activity". */
  from: string;
  to: string;
  values: { date: string; value: number }[];
  format: ValueFormat;
  mode?: "sequential" | "diverging";
  /** Cell edge in px. 13 fits a 90-day quarter inside a phone card without
   *  scrolling; a full year needs the container's horizontal scroll. */
  cell?: number;
}) {
  const byDate = new Map(values.map((v) => [v.date, v.value]));
  const { cells, weeks } = calendarGrid(from, to, byDate);
  // The darkest bin is the 95th percentile, not the maximum — see
  // `heatCeiling`. On this product's own seeded data the maximum put 88 of 90
  // days into the lightest bin and the chart said nothing at all.
  const trueMax = Math.max(0, ...values.map((v) => Math.abs(v.value)));
  const maxAbs = heatCeiling(values.map((v) => v.value));
  const clamped = trueMax > maxAbs;
  const gap = 2; // the surface gap; one consistent width across the whole grid
  const pitch = cell + gap;

  const markFor = (value: number) =>
    mode === "diverging" ? (value >= 0 ? MARK.positive : MARK.negative) : MARK.accent;

  const legendSwatch = (opacity: number, mark: string, slashed: boolean) => (
    <span
      aria-hidden
      className="relative inline-block rounded-[2px] overflow-hidden align-middle"
      style={vars({ width: `${cell}px`, height: `${cell}px` })}
    >
      <span
        className="absolute inset-0 bg-[var(--mark)]"
        style={vars({ "--mark": mark, opacity })}
      />
      {slashed && (
        <span className="absolute left-1/2 -top-1/4 h-[150%] w-px bg-surface rotate-45" />
      )}
    </span>
  );

  return (
    <ChartFrame
      {...frame}
      table={{
        caption: `${frame.title ?? "Daily figures"} — every day in the period with its value`,
        headers: ["Date", "Weekday", mode === "diverging" ? "Net movement" : "Value"],
        // Only days that carry a value: a table of 60 "no activity" rows buries
        // the 30 rows the reader came for, and the chart already shows which
        // days were quiet.
        rows: cells
          .filter((c) => c.value !== null && c.value !== 0)
          .map((c) => [
            c.date,
            WEEKDAY_SHORT[c.weekday],
            mode === "diverging"
              ? `${c.value! >= 0 ? "+" : "−"}${format(Math.abs(c.value!))}`
              : format(c.value!),
          ]),
      }}
    >
      <div className="overflow-x-auto pb-1">
        <div className="inline-flex gap-1.5">
          {/* Weekday gutter. Mon/Wed/Fri only — labelling all seven turns the
              gutter into a wall of text beside a 100px-tall grid. */}
          <div
            className="grid text-2xs text-subtle"
            style={vars({
              gridTemplateRows: `repeat(7, ${cell}px)`,
              rowGap: `${gap}px`,
              marginTop: "1.1rem",
            })}
          >
            {WEEKDAY_SHORT.map((d, i) => (
              <span key={d} className="leading-none flex items-center">
                {i % 2 === 0 ? d : ""}
              </span>
            ))}
          </div>

          <div>
            {/* Month ruler. Absolute rather than a grid row so a month that
                starts mid-week sits over its first cell, not over the column. */}
            <div
              className="relative text-2xs text-subtle h-[1.1rem]"
              style={vars({ width: `${weeks * pitch}px` })}
              aria-hidden
            >
              {monthTicks(cells).map((t) => (
                <span
                  key={`${t.week}-${t.label}`}
                  className="absolute top-0 leading-none"
                  style={vars({ left: `${t.week * pitch}px` })}
                >
                  {t.label}
                </span>
              ))}
            </div>

            <div
              role="img"
              aria-label={frame.conclusion}
              className="grid"
              style={vars({
                gridTemplateRows: `repeat(7, ${cell}px)`,
                gridTemplateColumns: `repeat(${weeks}, ${cell}px)`,
                gap: `${gap}px`,
              })}
            >
              {cells.map((c) => {
                const v = c.value ?? 0;
                const bin = c.value === null ? 0 : heatBin(v, maxAbs);
                const out = mode === "diverging" && v < 0;
                const label =
                  c.value === null
                    ? `${c.date}: no activity`
                    : `${c.date} (${WEEKDAY_SHORT[c.weekday]}): ${out ? "−" : mode === "diverging" ? "+" : ""}${format(Math.abs(v))}`;
                return (
                  <div
                    key={c.date}
                    title={label}
                    className={`relative rounded-[2px] overflow-hidden ${bin === 0 ? "bg-surface-2" : ""}`}
                    style={vars({ gridRowStart: c.weekday + 1, gridColumnStart: c.week + 1 })}
                  >
                    {bin > 0 && (
                      <span
                        className="absolute inset-0 bg-[var(--mark)]"
                        style={vars({ "--mark": markFor(v), opacity: HEAT_STEPS[bin - 1] })}
                      />
                    )}
                    {out && (
                      <span
                        aria-hidden
                        className="absolute left-1/2 -top-1/4 h-[150%] w-px bg-surface rotate-45"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Scale legend. A continuous scale without one is unreadable, and this
          is also where the slash is explained. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2.5 text-2xs text-subtle">
        {mode === "diverging" ? (
          <>
            <span className="flex items-center gap-1">
              {legendSwatch(HEAT_STEPS[3], MARK.negative, true)}
              <span className="ms-0.5">Money out (slashed)</span>
            </span>
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block rounded-[2px] bg-surface-2 align-middle"
                style={vars({ width: `${cell}px`, height: `${cell}px` })}
              />
              <span className="ms-0.5">No activity</span>
            </span>
            <span className="flex items-center gap-1">
              {legendSwatch(HEAT_STEPS[3], MARK.positive, false)}
              <span className="ms-0.5">Money in</span>
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1">
            <span className="me-0.5">Less</span>
            <span
              aria-hidden
              className="inline-block rounded-[2px] bg-surface-2 align-middle"
              style={vars({ width: `${cell}px`, height: `${cell}px` })}
            />
            {HEAT_STEPS.map((o) => (
              <span key={o}>{legendSwatch(o, MARK.accent, false)}</span>
            ))}
            <span className="ms-0.5">More</span>
          </span>
        )}
        {maxAbs > 0 && (
          <span>
            Darkest = {format(maxAbs)}
            {clamped && ` or more (peak ${format(trueMax)})`}
          </span>
        )}
      </div>
    </ChartFrame>
  );
}
