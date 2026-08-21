import Link from "next/link";
import { MARK, vars } from "./chart-frame";
import { areaPath, lineDomain, linePath, pct, project } from "./scale";
import type { ChartBase, Point, ValueFormat } from "./types";

/**
 * STAT TILE — the answer to "is this even a chart?" (PDD §7.1 step 1).
 *
 * "A single current value with a trend is a stat tile, not a one-bar bar
 * chart." This is the form for cash right now, the VAT position, the gratuity
 * liability: one number, one comparison, one small trend, and the sentence that
 * says what it means.
 *
 * ── RELATIONSHIP TO `KpiTile` IN `ui.tsx` ───────────────────────────────────
 * They are not duplicates and neither replaces the other. `KpiTile` is fed a
 * `MetricResult` straight from the semantic layer and is designed to tile four
 * or eight across a dashboard grid — at that size there is no room for a
 * sentence, and eight sentences in a row would not be read anyway. `StatTile`
 * is the single figure that LEADS a view, and it carries the required
 * conclusion because at that size the sentence is the reason to look. The skill
 * rule is one hero figure per view; a page with eight of these has picked the
 * wrong component.
 *
 * ── NO GRADIENT, THEREFORE NO ID ────────────────────────────────────────────
 * The trend here is a flat area wash at 10% opacity rather than the vertical
 * gradient `Sparkline` uses. That is not a cosmetic preference: the gradient is
 * the only reason `Sparkline` needs an `id` prop at all, and the id collision
 * it was added to fix (two business units sharing one gradient on /businesses,
 * the second silently winning for both) cannot exist for a fill that references
 * nothing. The wash reads the same at 26px tall.
 *
 * `.kpi-value` carries `font-variant-numeric: tabular-nums` from `globals.css`,
 * which is a deliberate divergence from the data-viz convention of proportional
 * figures on a display-size number. Consistency with the eight `KpiTile`s that
 * may sit on the same screen wins: two tiles setting `121` at different widths
 * side by side is a more visible defect than slightly loose digits.
 *
 * Server component.
 */
export function StatTile({
  label,
  value,
  format,
  prior,
  priorLabel = "prior period",
  polarity = "higher_is_better",
  series,
  href,
  conclusion,
  note,
  className = "",
}: Omit<ChartBase, "title" | "footnote"> & {
  label: string;
  value: number;
  format: ValueFormat;
  /** The comparable figure. `null` means there is no comparison — say so,
   *  rather than implying zero growth. */
  prior?: number | null;
  priorLabel?: string;
  /** A 20% rise in overdue debt is bad news and must never be painted green
   *  just because the arrow points up. Same contract as `Delta` in `ui.tsx`. */
  polarity?: "higher_is_better" | "lower_is_better" | "neutral";
  series?: Point[];
  href?: string;
}) {
  if (process.env.NODE_ENV !== "production" && !conclusion.trim()) {
    throw new Error("StatTile `conclusion` is empty. PDD §7.7 — see `conclude.ts`.");
  }

  const move = prior === null || prior === undefined ? null : value - prior;
  const good = move === null || polarity === "neutral" ? null : polarity === "higher_is_better" ? move >= 0 : move <= 0;
  const deltaTone = good === null ? "text-muted" : good ? "text-positive" : "text-negative";
  const trendMark = good === null ? MARK.accent : good ? MARK.positive : MARK.negative;

  const drawable = series && series.length >= 2 ? series : null;
  const domain = drawable ? lineDomain(drawable.map((p) => p.y)) : null;

  const body = (
    <>
      <p className="label">{label}</p>
      <p className="kpi-value mt-1.5">{format(value)}</p>

      <p className="text-2xs mt-1.5 flex items-center gap-1.5 flex-wrap">
        {move === null ? (
          <span className="text-subtle">no comparison</span>
        ) : (
          <>
            <span className={`font-semibold ${deltaTone}`}>
              {/* The glyph is the redundant channel FR-V02 requires: sign is
                  never carried by the colour of the text alone. */}
              <span aria-hidden className="me-0.5">
                {move > 0 ? "▲" : move < 0 ? "▼" : "="}
              </span>
              {move > 0 ? "+" : move < 0 ? "−" : ""}
              {format(Math.abs(move))}
            </span>
            <span className="text-subtle">vs {priorLabel}</span>
          </>
        )}
      </p>

      {drawable && domain && (
        <div className="relative mt-2.5 h-7">
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Trend across ${drawable.length} points, ending at ${format(drawable.at(-1)!.y)}`}
          >
            <path d={areaPath(drawable.map((p) => p.y), domain)} fill={trendMark} fillOpacity={0.1} />
            <path
              d={linePath(drawable.map((p) => p.y), domain)}
              fill="none"
              stroke={trendMark}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            aria-hidden
            className="absolute w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface bg-[var(--mark)]"
            style={vars({
              "--mark": trendMark,
              left: "100%",
              top: pct(1 - project(drawable.at(-1)!.y, domain)),
            })}
          />
        </div>
      )}

      <p className="text-2xs mt-2 leading-snug">{conclusion}</p>
      {note && <p className="text-2xs text-subtle mt-1 leading-snug">{note}</p>}
    </>
  );

  // `<figure>` + `<figcaption>` would be wrong here: the conclusion is not a
  // caption on a plot, it is the tile's body text. The tile is a section.
  return href ? (
    <Link
      href={href}
      className={`card p-4 block hover:bg-surface-2 transition-colors ${className}`}
    >
      {body}
    </Link>
  ) : (
    <section className={`card p-4 ${className}`}>{body}</section>
  );
}
