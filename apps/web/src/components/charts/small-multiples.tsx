import Link from "next/link";
import { BU_MARK, ChartFrame, MARK, vars } from "./chart-frame";
import { lineDomain, linePath, pct, project } from "./scale";
import type { ChartBase, BuColor, Point, ValueFormat } from "./types";

export interface Panel {
  label: string;
  points: Point[];
  /** Business identity hue. Decoration only — the panel HEADING carries
   *  identity here, which is what makes this form safe given the measured CVD
   *  failures in the `--color-bu-*` palette (see `chart-frame.tsx`). */
  bu?: BuColor;
  href?: string;
}

/**
 * SMALL MULTIPLES (PDD §7.4).
 *
 * "Six overlapping lines on one chart is unreadable, and it also breaks the
 * palette rule — all-pairs forms cap at three series. Six panels, identical
 * axes, shared scale, one line each."
 *
 * ── THE SHARED SCALE IS THE ENTIRE POINT ────────────────────────────────────
 * Every panel is projected against ONE domain computed across all panels. Panel
 * -local scaling is the standard way this chart is got wrong: each line fills
 * its own box, the salon at AED 4k looks exactly like properties at AED 400k,
 * and the reader draws the opposite conclusion to the one in the data. So the
 * domain is computed once, here, and passed down — there is no per-panel path.
 *
 * The cost is real and is stated on the chart rather than hidden: a business an
 * order of magnitude smaller than the largest renders as a nearly flat line. It
 * is flat *relative to the portfolio*, which is true and is the comparison this
 * form exists to make. A reader who wants that business's own shape opens its
 * panel — hence `href` — where a single-series line chart rescales to it.
 *
 * ── WHY THIS AND NOT SIX LINES ON ONE AXIS ──────────────────────────────────
 * Beyond the readability argument, six overlaid series would have to be told
 * apart by the eight `--color-bu-*` hues, and those measure ΔE 1.3 between
 * `blue` and `violet` under deuteranopia — two of the portfolio's businesses
 * would be literally the same colour for a percent of readers. Faceting removes
 * the dependency on hue entirely.
 *
 * Server component.
 */
export function SmallMultiples({
  panels,
  format,
  height = 40,
  columns = 3,
  ...frame
}: ChartBase & {
  panels: Panel[];
  format: ValueFormat;
  height?: number;
  /** Desktop column count. Mobile is always two — §7.9 asks for a two-by-three
   *  grid on a phone rather than six stacked full-width charts. */
  columns?: 2 | 3;
}) {
  const domain = lineDomain(panels.flatMap((p) => p.points.map((pt) => pt.y)));
  const dates = panels.find((p) => p.points.length > 0)?.points ?? [];

  return (
    <ChartFrame
      {...frame}
      note={
        frame.note ??
        (dates.length > 1 ? `${dates[0].x} to ${dates.at(-1)!.x}, shared scale` : undefined)
      }
      table={{
        caption: `${frame.title ?? "By business"} — each business over the same period`,
        headers: ["Business", "Start", "Latest", "Change"],
        rows: panels.map((p) => {
          if (p.points.length === 0) return [p.label, "—", "—", "—"];
          const first = p.points[0].y;
          const last = p.points.at(-1)!.y;
          return [
            p.label,
            format(first),
            format(last),
            `${last - first >= 0 ? "+" : "−"}${format(Math.abs(last - first))}`,
          ];
        }),
      }}
      footnote={
        frame.footnote ?? (
          <>
            All panels share one vertical scale ({format(domain.min)} to {format(domain.max)}), so
            panel heights compare directly.
          </>
        )
      }
    >
      <div className={`grid gap-x-3 gap-y-4 grid-cols-2 ${columns === 3 ? "md:grid-cols-3" : ""}`}>
        {panels.map((p) => {
          const mark = p.bu ? BU_MARK[p.bu] : MARK.accent;
          const last = p.points.at(-1);
          const first = p.points[0];
          const move = last && first ? last.y - first.y : 0;
          const panel = (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-2xs font-medium truncate" title={p.label}>
                  {p.label}
                </span>
                {last && (
                  <span className="text-2xs tnum font-semibold shrink-0">{format(last.y)}</span>
                )}
              </div>

              <div className="relative mt-1" style={vars({ height: `${height}px` })}>
                {/* Zero rule, drawn only when the shared domain crosses it —
                    without it a panel sitting below zero is indistinguishable
                    from a quiet one. */}
                {domain.min < 0 && domain.max > 0 && (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 border-t"
                    style={vars({ top: pct(1 - project(0, domain)) })}
                  />
                )}
                {p.points.length > 0 ? (
                  <svg
                    className="absolute inset-0 w-full h-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`${p.label}: ${last ? format(last.y) : "no data"}`}
                  >
                    <path
                      d={linePath(p.points.map((pt) => pt.y), domain)}
                      fill="none"
                      stroke={mark}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                ) : (
                  <div className="absolute inset-0 grid place-items-center">
                    <span className="text-2xs text-subtle">No data</span>
                  </div>
                )}
                {last && p.points.length > 1 && (
                  <span
                    aria-hidden
                    className="absolute w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface bg-[var(--mark)]"
                    style={vars({
                      "--mark": mark,
                      left: "100%",
                      top: pct(1 - project(last.y, domain)),
                    })}
                  />
                )}
              </div>

              {p.points.length > 1 && (
                <p className="text-2xs text-subtle mt-1 tnum">
                  <span aria-hidden className="me-0.5">
                    {move >= 0 ? "▲" : "▼"}
                  </span>
                  {move >= 0 ? "+" : "−"}
                  {format(Math.abs(move))}
                </p>
              )}
            </>
          );

          return (
            <div key={p.label}>
              {p.href ? (
                <Link
                  href={p.href}
                  className="block -mx-1.5 px-1.5 py-1 rounded-md hover:bg-surface-2 transition-colors"
                >
                  {panel}
                </Link>
              ) : (
                panel
              )}
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}
