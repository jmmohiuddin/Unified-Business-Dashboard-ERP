import { ChartFrame, ChartLegend, MARK, vars } from "./chart-frame";
import { areaPath, lineDomain, linePath, niceTicks, pct, project } from "./scale";
import type { ChartBase, Point, ValueFormat } from "./types";

/**
 * LINE — change over time (PDD §7.2).
 *
 * ── THE RENDERING TRADE, STATED ─────────────────────────────────────────────
 * A line is the one form here that genuinely needs a path, so it is the one
 * form that uses SVG. Everything else in this directory is HTML and CSS, and
 * the split is deliberate:
 *
 *   NO TEXT IS EVER PLACED INSIDE AN SVG IN THIS DIRECTORY.
 *
 * The reason is responsiveness. A chart card is 640px wide on a laptop and
 * ~330px on the phone this product targets, and an SVG that scales to fit
 * scales its text with it — an 11px axis label becomes 6px on the device where
 * legibility matters most. So the plot is a unit-box path stretched with
 * `preserveAspectRatio="none"`, and every label, dot, gridline and reference
 * rule is an absolutely-positioned HTML element at a percentage offset. Text
 * therefore stays at its real size at every width, inherits the type tokens,
 * and is selectable and translatable. `vector-effect="non-scaling-stroke"` is
 * what makes the stretch safe: the 2px stroke stays 2px instead of being
 * squashed into a wedge by the non-uniform transform.
 *
 * Circles would be squashed by that same transform, so markers are HTML too —
 * which is also how they get a 24px hit area around an 8px dot without a
 * second invisible SVG element per point.
 *
 * ── A LINE MAY LEAVE OUT ZERO; A BAR MAY NOT ────────────────────────────────
 * `lineDomain` does not force zero into the scale. Position carries the value
 * on a line, so a cash balance oscillating between 180k and 220k is legible
 * from 175k; forced to a zero baseline it is a flat line that hides the whole
 * story. On a BAR the length carries the value and truncating the axis is a
 * lie, which is why `domainOf` behaves differently. Two functions, because
 * these are two different rules and one function with a flag is how they get
 * confused.
 *
 * ── SELECTIVE LABELS ────────────────────────────────────────────────────────
 * §7.6 allows a direct label on the last point, the extremes, and anything the
 * conclusion refers to — never a number on every point. This labels the last
 * point always, and the minimum when it is not the last point, because on a
 * cash line the trough is the fact that decides whether salaries clear.
 *
 * Server component. Values are reachable without hover through the direct
 * labels, the axis ticks and the table view; per-point `title` adds a readout
 * on hover and on tap.
 */
export function LineChart({
  series,
  format,
  height = 140,
  reference,
  ...frame
}: ChartBase & {
  /** One or more series over a SHARED x axis. Two is the ceiling worth using —
   *  §7.4 sends six businesses to small multiples instead, and the categorical
   *  palette this product ships cannot safely distinguish more than that. */
  series: { label: string; points: Point[]; mark?: string }[];
  format: ValueFormat;
  height?: number;
  /**
   * A floor with a danger band below it — §7.2's "minimum-safe-balance
   * reference line and a shaded danger band" for the cash line. The band is a
   * wash at 8%, not a fill: it is context the eye should register and then stop
   * looking at.
   */
  reference?: { value: number; label: string };
}) {
  const drawable = series.filter((s) => s.points.length > 0);
  const allY = drawable.flatMap((s) => s.points.map((p) => p.y));
  const domain = lineDomain(allY, reference ? [reference.value] : []);
  const xs = drawable[0]?.points ?? [];
  const ticks = niceTicks(domain, 3);

  const markOf = (i: number, s: { mark?: string }) =>
    s.mark ?? (i === 0 ? MARK.accent : MARK.caution);

  return (
    <ChartFrame
      {...frame}
      table={{
        caption: `${frame.title ?? "Trend"} — every point in the series`,
        headers: ["Date", ...drawable.map((s) => s.label)],
        rows: xs.map((p, i) => [
          p.x,
          ...drawable.map((s) => (s.points[i] ? format(s.points[i].y) : "—")),
        ]),
      }}
    >
      {drawable.length > 1 && (
        <ChartLegend
          shape="line"
          items={drawable.map((s, i) => ({ label: s.label, mark: markOf(i, s) }))}
        />
      )}

      {/* GUTTERS, and why they exist rather than labels floating over the plot.
          Without them the y-axis ticks sit on top of the line where it runs
          near the left edge, and the end-of-series value is half-clipped by the
          card because a centred label at x=100% hangs outside. Both were
          visible in the first render against real data. The plot is inset from
          both edges and every label hangs into the gutter beside it, so nothing
          overlaps the marks and nothing is clipped. */}
      <div className="relative" style={vars({ height: `${height}px` })}>
        <div className="absolute inset-y-0 left-12 right-16">
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className="absolute inset-x-0 border-t"
              style={vars({ top: pct(1 - project(t, domain)) })}
            >
              <span className="absolute right-full -translate-y-1/2 me-1.5 text-2xs text-subtle tnum whitespace-nowrap">
                {format(t)}
              </span>
            </div>
          ))}

          {reference && (
            <>
              <div
                aria-hidden
                className="absolute inset-x-0 bottom-0 bg-[var(--mark)] opacity-[0.08]"
                style={vars({
                  "--mark": MARK.negative,
                  height: pct(Math.max(0, project(reference.value, domain))),
                })}
              />
              <div
                className="absolute inset-x-0 h-px bg-[var(--mark)]"
                style={vars({
                  "--mark": MARK.negative,
                  top: pct(1 - project(reference.value, domain)),
                })}
                title={`${reference.label}: ${format(reference.value)}`}
              >
                <span className="absolute left-full -translate-y-1/2 ms-1.5 text-2xs text-negative font-medium whitespace-nowrap">
                  {reference.label}
                </span>
              </div>
            </>
          )}

          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={frame.conclusion}
          >
            {drawable.map((s, i) => {
              const values = s.points.map((p) => p.y);
              return (
                <g key={s.label}>
                  {drawable.length === 1 && (
                    <path d={areaPath(values, domain)} fill={markOf(i, s)} fillOpacity={0.1} />
                  )}
                  <path
                    d={linePath(values, domain)}
                    fill="none"
                    stroke={markOf(i, s)}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>

          {/* Markers and direct labels, in HTML so they stay round and legible
              through the non-uniform stretch above. */}
          {drawable.map((s, i) => {
            const n = s.points.length;
            const last = s.points.at(-1);
            const low = s.points.reduce((m, p) => (p.y < m.y ? p : m), s.points[0]);
            const lowIdx = s.points.indexOf(low);
            // Suppress the trough label when it would collide with the end
            // label. Nudging two labels apart detaches them from their marks and
            // reads as noise; the value stays in the tooltip and the table.
            const lowCollides = n < 2 || (n - 1 - lowIdx) / (n - 1) < 0.12;
            const marks = [
              last ? { p: last, idx: n - 1, end: true } : null,
              low !== last && !lowCollides ? { p: low, idx: lowIdx, end: false } : null,
            ].filter(Boolean) as { p: Point; idx: number; end: boolean }[];

            return marks.map((m) => (
              <div
                key={`${s.label}-${m.p.x}`}
                className="absolute -translate-x-1/2 -translate-y-1/2 grid place-items-center w-6 h-6"
                style={vars({
                  left: pct(n > 1 ? m.idx / (n - 1) : 0.5),
                  top: pct(1 - project(m.p.y, domain)),
                })}
                title={`${s.label} · ${m.p.x}: ${format(m.p.y)}`}
              >
                {/* 8px dot with a 2px surface ring, so it stays legible where
                    it crosses the line or another series. */}
                <span
                  className="block w-2 h-2 rounded-full ring-2 ring-surface bg-[var(--mark)]"
                  style={vars({ "--mark": markOf(i, s) })}
                />
                <span
                  className={
                    m.end
                      ? "absolute left-full ms-1 whitespace-nowrap text-2xs tnum font-semibold"
                      : "absolute left-1/2 -translate-x-1/2 -top-3 whitespace-nowrap text-2xs tnum text-subtle"
                  }
                >
                  {format(m.p.y)}
                </span>
              </div>
            ));
          })}
        </div>
      </div>

      {xs.length > 1 && (
        <div className="flex justify-between text-2xs text-subtle mt-1.5 ps-12 pe-16">
          <span>{xs[0].x}</span>
          <span>{xs.at(-1)!.x}</span>
        </div>
      )}
    </ChartFrame>
  );
}
