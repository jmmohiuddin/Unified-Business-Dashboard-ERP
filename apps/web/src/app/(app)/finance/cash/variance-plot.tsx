import { formatMoney } from "@nexus/core";

/**
 * Variance dot plot, one dot per close, coloured by till.
 *
 * WF-05 §4.1 specifies a dot plot BY TILL and is unusually direct about why:
 * "clustering by person and shift is the signal; a total hides it." A group
 * whose salon till is AED 200 short and whose parking kiosk is AED 200 over
 * nets to zero, and a screen reporting zero has not merely failed to help — it
 * has actively told the owner there is no problem. So nothing on this chart is
 * summed across tills. Every close is its own mark, and the eye does the
 * clustering.
 *
 * Server-rendered inline SVG. No chart library, no client JavaScript: the whole
 * app is server components (`action-form.tsx` is the sole exception) and a
 * scatter of forty dots does not justify shipping a runtime to draw it.
 *
 * The two dashed lines are the acknowledgement threshold. They are the most
 * useful gridlines on the chart because they are the only ones with a
 * consequence attached — a dot outside them cost somebody a conversation.
 */

export interface VariancePoint {
  sessionId: string;
  registerId: string;
  registerName: string;
  colorToken: string;
  closedAt: string;
  closedOn: string;
  variance: number;
  openedBy: string;
}

const WIDTH = 640;
const HEIGHT = 168;
const PAD_LEFT = 46;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

export function VariancePlot({
  points,
  threshold,
  currency,
}: {
  points: VariancePoint[];
  threshold: number;
  currency: string;
}) {
  if (points.length === 0) return null;

  const ordered = [...points].sort((a, b) => a.closedAt.localeCompare(b.closedAt));

  /**
   * The y domain always includes the threshold lines.
   *
   * A month in which every close was within a dirham would otherwise autoscale
   * to ±1 and render four perfectly ordinary days as a dramatic scatter across
   * the full height of the card. Anchoring the scale to the limit keeps "how
   * bad is this" legible without reading the axis.
   */
  const worst = Math.max(
    threshold * 1.4,
    ...ordered.map((p) => Math.abs(p.variance)),
  );
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const y = (value: number) => PAD_TOP + plotH / 2 - (value / worst) * (plotH / 2);
  const x = (index: number) =>
    ordered.length === 1
      ? PAD_LEFT + plotW / 2
      : PAD_LEFT + (index / (ordered.length - 1)) * plotW;

  const tills = [...new Map(ordered.map((p) => [p.registerId, p])).values()];
  const gridValues = [worst, threshold, 0, -threshold, -worst];

  return (
    <div className="px-4 pb-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full min-w-[420px]"
          role="img"
          aria-label={`Variance by till over the last ${ordered.length} closes`}
        >
          <title>Cash variance by till, one dot per close</title>

          {gridValues.map((value) => {
            const isZero = value === 0;
            const isLimit = Math.abs(value) === threshold && threshold > 0;
            return (
              <g key={`grid-${value}`}>
                <line
                  x1={PAD_LEFT}
                  x2={WIDTH - PAD_RIGHT}
                  y1={y(value)}
                  y2={y(value)}
                  stroke={isZero ? "var(--border-strong)" : "var(--border)"}
                  strokeWidth={isZero ? 1 : 1}
                  strokeDasharray={isZero ? undefined : "3 4"}
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y(value) + 3}
                  textAnchor="end"
                  className="tnum"
                  fontSize="9"
                  fill={isLimit ? "var(--caution)" : "var(--text-subtle)"}
                >
                  {value > 0 ? `+${Math.round(value)}` : String(Math.round(value))}
                </text>
              </g>
            );
          })}

          {ordered.map((point, index) => (
            <circle
              key={point.sessionId}
              cx={x(index)}
              cy={y(point.variance)}
              r={Math.abs(point.variance) > threshold ? 5 : 3.5}
              fill={`var(--color-bu-${point.colorToken})`}
              fillOpacity={Math.abs(point.variance) > threshold ? 1 : 0.75}
              stroke="var(--surface)"
              strokeWidth="1"
            >
              <title>
                {`${point.registerName} · ${point.closedOn} · ${point.openedBy} · ` +
                  (point.variance === 0
                    ? "exact"
                    : `${point.variance < 0 ? "short" : "over"} ${formatMoney(Math.abs(point.variance), currency, 2)}`)}
              </title>
            </circle>
          ))}

          <text
            x={PAD_LEFT}
            y={HEIGHT - 5}
            fontSize="9"
            fill="var(--text-subtle)"
          >
            {ordered[0]!.closedOn}
          </text>
          <text
            x={WIDTH - PAD_RIGHT}
            y={HEIGHT - 5}
            textAnchor="end"
            fontSize="9"
            fill="var(--text-subtle)"
          >
            {ordered[ordered.length - 1]!.closedOn}
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {tills.map((till) => (
          <span key={till.registerId} className="inline-flex items-center gap-1.5 text-2xs text-muted">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: `var(--color-bu-${till.colorToken})` }}
              aria-hidden
            />
            {till.registerName}
          </span>
        ))}
        <span className="text-2xs text-subtle">
          dashed line = {formatMoney(threshold, currency, 0)} acknowledgement limit
        </span>
      </div>
    </div>
  );
}

/**
 * One honest sentence about the shape of the data.
 *
 * WF-05 §4.1 puts a written conclusion under the chart — "The salon till has
 * been short four of the last six closes, always on the evening shift" — and
 * that sentence is the reason the chart exists at all. It is computed, never
 * generated: the AI is good at phrasing and must not be the thing that decides
 * whether a member of staff has a pattern.
 *
 * It reports the worst till only when there is genuinely something to report.
 * A sentence manufactured from two closes and one dirham would train the owner
 * to ignore this box, which costs more than saying nothing.
 */
export function variancePattern(
  pattern: { registerName: string; closes: number; shorts: number; net: number; worst: number }[],
  currency: string,
): string | null {
  if (pattern.length === 0) return null;

  const totalCloses = pattern.reduce((n, p) => n + p.closes, 0);
  const worstTill = pattern[0]!;

  if (worstTill.closes >= 3 && worstTill.shorts >= 3 && worstTill.shorts * 2 >= worstTill.closes) {
    return (
      `The ${worstTill.registerName} has been short on ${worstTill.shorts} of its last ` +
      `${worstTill.closes} closes. Repeated shortages on one till are a training problem ` +
      `or a theft problem, and the difference shows in who was on shift — not in the total.`
    );
  }

  const anyVariance = pattern.some((p) => p.worst !== 0);
  if (!anyVariance) {
    return totalCloses === 0
      ? null
      : `All ${totalCloses} closes in the last 30 days matched to the fils.`;
  }

  const biggest = pattern.reduce((a, b) => (Math.abs(b.worst) > Math.abs(a.worst) ? b : a));
  return (
    `${totalCloses} closes across ${pattern.length} till${pattern.length === 1 ? "" : "s"}. ` +
    `The largest single difference was ${formatMoney(Math.abs(biggest.worst), currency, 2)} ` +
    `${biggest.worst < 0 ? "short" : "over"} on the ${biggest.registerName}. ` +
    `No till is showing a repeating pattern yet.`
  );
}
