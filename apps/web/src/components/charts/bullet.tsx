import { ChartFrame, MARK, vars } from "./chart-frame";
import { pct } from "./scale";
import type { ChartBase, MarkTone, ValueFormat } from "./types";

export interface BulletRow {
  label: string;
  actual: number;
  target: number;
  /** Overrides the group formatter for a row in a different unit. */
  format?: ValueFormat;
  /** Identity, not status — the measure bar is one hue and the polarity is
   *  carried by the delta text. Leave it unset unless a row belongs to a
   *  business unit whose colour the reader already knows. */
  tone?: MarkTone;
  /** Optional context under the label: "34 of 41 units let". */
  meta?: string;
}

/**
 * BULLET GRAPH (PDD §7.2, §7.11).
 *
 * The product's replacement for every gauge, donut ring and speedometer, which
 * §7.11 bans outright and for good reasons it states: they are
 * space-inefficient, trend-blind, and their non-linear scales mislead. A bullet
 * graph says the same thing — where am I against target — in a strip, and the
 * strips stack so several targets compare against each other, which is the
 * thing a row of donuts cannot do at all.
 *
 * ── ANATOMY ─────────────────────────────────────────────────────────────────
 *   track            the full scale, recessive, at `--surface-3`
 *   qualitative band optional, one darker step marking "below this is a
 *                    problem" — greyscale, never a status colour, because the
 *                    status of the row is the measure's position not the band's
 *   measure          one hue, thin (8px inside a 20px track), anchored to zero
 *   target marker    a 2px ink rule across the full track height. Ink, not a
 *                    hue: it is a reference, and a coloured reference competes
 *                    with the measure for the reader's "what is important here"
 *   delta            signed, direct-labelled, with a ▲/▼ glyph
 *
 * ── SHARED SCALE ────────────────────────────────────────────────────────────
 * Every row is projected against ONE domain. Per-row scaling would let a row
 * at 40% of a small target look longer than a row at 90% of a large one, which
 * inverts the comparison the chart exists to make. `max` overrides it where the
 * unit has a natural ceiling — pass 100 for a percentage so the bar reads
 * against the whole scale rather than against the best row.
 *
 * Sign is never colour-only: the ahead/short delta carries a glyph and an
 * explicit +/−, and the measure's position against the target rule says it
 * geometrically (FR-V02).
 *
 * Server component — static geometry, native `title` hover, table view for
 * keyboard and screen-reader access.
 */
export function BulletChart({
  rows,
  format,
  max,
  bandAt,
  ...frame
}: ChartBase & {
  rows: BulletRow[];
  format: ValueFormat;
  /** Ceiling of the shared scale. Defaults to the largest value present. */
  max?: number;
  /** Draws the qualitative band from zero to this value — "below here is a
   *  problem". Greyscale by design; see the anatomy note. */
  bandAt?: number;
}) {
  const ceiling =
    max ?? Math.max(1, ...rows.flatMap((r) => [Math.abs(r.actual), Math.abs(r.target)]));

  return (
    <ChartFrame
      {...frame}
      table={{
        caption: `${frame.title ?? "Attainment"} — actual against target for each row`,
        headers: ["Row", "Actual", "Target", "Difference"],
        rows: rows.map((r) => {
          const f = r.format ?? format;
          const d = r.actual - r.target;
          return [
            r.meta ? `${r.label} (${r.meta})` : r.label,
            f(r.actual),
            f(r.target),
            `${d >= 0 ? "+" : "−"}${f(Math.abs(d))}`,
          ];
        }),
      }}
    >
      <ul className="mt-1 space-y-3">
        {rows.map((r) => {
          const f = r.format ?? format;
          const delta = r.actual - r.target;
          const ahead = delta >= 0;
          return (
            <li key={r.label}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-2xs font-medium truncate" title={r.label}>
                  {r.label}
                  {r.meta && <span className="text-subtle font-normal"> · {r.meta}</span>}
                </span>
                <span className="text-2xs tnum shrink-0">
                  <span className="font-semibold">{f(r.actual)}</span>
                  <span className="text-subtle">
                    {" "}
                    <span aria-hidden>{ahead ? "▲" : "▼"}</span>
                    {ahead ? "+" : "−"}
                    {f(Math.abs(delta))}
                  </span>
                </span>
              </div>

              <div
                className="relative h-5 rounded-[4px] bg-surface-3 overflow-hidden"
                title={`${r.label}: ${f(r.actual)} against a target of ${f(r.target)} (${ahead ? "+" : "−"}${f(Math.abs(delta))})`}
              >
                {bandAt !== undefined && (
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-border"
                    style={vars({ width: pct(Math.min(1, Math.abs(bandAt) / ceiling)) })}
                  />
                )}
                {/* 8px measure inside a 20px track: thin marks, and the air
                    around it is what makes the target rule readable where the
                    two coincide. */}
                <div
                  className="absolute top-1.5 left-0 h-2 rounded-r-[4px] bg-[var(--mark)]"
                  style={vars({
                    "--mark": MARK[r.tone ?? "accent"],
                    width: `max(2px, ${pct(Math.min(1, Math.abs(r.actual) / ceiling))})`,
                  })}
                />
                {r.target !== 0 && (
                  <div
                    aria-hidden
                    className="absolute inset-y-0.5 w-0.5 rounded-full bg-text"
                    style={vars({ left: pct(Math.min(1, Math.abs(r.target) / ceiling)) })}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}
