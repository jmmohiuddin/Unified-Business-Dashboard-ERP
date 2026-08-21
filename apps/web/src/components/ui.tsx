import Link from "next/link";
import type { ReactNode } from "react";
import { formatMetricValue, formatMoneyCompact, formatPercent } from "@nexus/core";
import type { MetricResult } from "@nexus/core";

/**
 * Presentational primitives.
 *
 * All server components. The dashboard ships essentially zero client-side
 * JavaScript: sparklines and bars are inline SVG rendered on the server, which
 * beats a charting library on payload, on first paint, and on the low-end
 * Android hardware that most staff in this market actually carry.
 */

export function Card({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function CardHeader({
  title,
  subtitle,
  action,
  href,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  href?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-2xs text-subtle mt-0.5">{subtitle}</p>}
      </div>
      {action ??
        (href && (
          <Link
            href={href}
            className="text-2xs font-semibold shrink-0 hover:underline"
            style={{ color: "var(--accent)" }}
          >
            View →
          </Link>
        ))}
    </div>
  );
}

/**
 * Delta badge.
 *
 * `polarity` matters: a 20% rise in overdue debt is bad news and must never be
 * painted green just because the arrow points up. Getting this wrong is how a
 * dashboard actively misleads.
 */
export function Delta({
  ratio,
  polarity = "higher_is_better",
  suffix,
}: {
  ratio: number | null | undefined;
  polarity?: "higher_is_better" | "lower_is_better" | "neutral";
  suffix?: string;
}) {
  if (ratio === null || ratio === undefined) {
    return <span className="text-2xs text-subtle">no comparison</span>;
  }
  const good =
    polarity === "neutral" ? null : polarity === "higher_is_better" ? ratio >= 0 : ratio <= 0;
  const color =
    good === null ? "var(--text-muted)" : good ? "var(--positive)" : "var(--negative)";
  const arrow = ratio > 0.0005 ? "▲" : ratio < -0.0005 ? "▼" : "–";
  return (
    <span className="text-2xs font-semibold tnum inline-flex items-center gap-1" style={{ color }}>
      <span aria-hidden>{arrow}</span>
      {formatPercent(Math.abs(ratio), 1).replace("+", "")}
      {suffix && <span className="text-subtle font-normal">{suffix}</span>}
    </span>
  );
}

/**
 * The stored history a tile can draw, structurally typed.
 *
 * Matches `SnapshotTrend` from `packages/core/src/metrics/snapshots.ts` without
 * importing it, so this presentational layer keeps no dependency on where the
 * points came from — a live metric's own `series` satisfies it just as well.
 */
export interface TileTrend {
  series: { x: string; y: number }[];
  changeRatio?: number | null;
  /** Days the series actually spans, which is rarely the days requested. */
  spanDays?: number;
}

/**
 * Enough history to draw an honest line?
 *
 * Mirrors `MIN_TREND_POINTS` and the flat-series refusal in the snapshot
 * reader, and repeats them here because a tile can also be handed a live
 * metric's own `series`, which no reader has vetted. Two points render as a
 * straight diagonal and three identical points as a flat line; both read as
 * statements about the business — "steady", "climbing" — that the data does
 * not support. On a table that has one night of history for most keys, that is
 * the normal case, not an edge case, which is why the check is here and not
 * left to the caller.
 */
function drawable(trend: TileTrend | null | undefined): boolean {
  if (!trend || trend.series.length < 3) return false;
  const first = trend.series[0]!.y;
  return trend.series.some((p) => p.y !== first);
}

export function KpiTile({
  label,
  result,
  currency,
  polarity = "higher_is_better",
  compareLabel = "vs last month",
  hint,
  accent,
  trend,
  trendId,
}: {
  label: string;
  result: MetricResult | null;
  currency: string;
  polarity?: "higher_is_better" | "lower_is_better" | "neutral";
  compareLabel?: string;
  hint?: string;
  accent?: boolean;
  /**
   * Stored history for this metric, from `readSnapshotTrends`.
   *
   * Optional and expected to be absent — `kpi_snapshots` was written by the
   * nightly sweep and read by nothing until FR-V03, so most keys have a single
   * day on file. A tile with no trend renders exactly as it did before.
   * Falls back to the metric's own `series` when one is supplied, which is how
   * `withTrend` merges the two.
   */
  trend?: TileTrend | null;
  /**
   * Unique per rendered tile, forwarded to `Sparkline`.
   *
   * Tiles are rendered in grids of four or more; `Sparkline` derives its SVG
   * gradient id from this, and two colliding ids make the second gradient win
   * for both. Defaults to the metric id, which is unique within a dashboard.
   */
  trendId?: string;
}) {
  if (!result) {
    return (
      <Card className="p-4">
        <p className="label">{label}</p>
        <p className="kpi-value mt-2 text-subtle">—</p>
        <p className="text-2xs text-subtle mt-1.5">Not available for your role</p>
      </Card>
    );
  }

  const history: TileTrend | null =
    trend ?? (result.series ? { series: result.series } : null);
  const showTrend = drawable(history);
  /** The metric's own comparison wins: it knows which prior period means
   *  something for it. The window ratio is context, not a replacement. */
  const ratio = result.changeRatio ?? history?.changeRatio ?? null;
  const ratioLabel =
    result.changeRatio !== null && result.changeRatio !== undefined
      ? compareLabel
      : history?.spanDays
        ? `over ${history.spanDays} days`
        : compareLabel;
  const sparkColor =
    polarity === "neutral" || ratio === null
      ? "var(--accent)"
      : (polarity === "higher_is_better" ? ratio >= 0 : ratio <= 0)
        ? "var(--positive)"
        : "var(--negative)";

  const body = (
    <>
      <p className="label">{label}</p>
      <p className="kpi-value mt-1.5" style={accent ? { color: "var(--accent)" } : undefined}>
        {formatMetricValue(result.value, result.unit, currency)}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Delta ratio={ratio} polarity={polarity} />
        {ratio !== null && <span className="text-2xs text-subtle">{ratioLabel}</span>}
      </div>
      {showTrend && (
        /* Colour is never the only carrier of sign here — the Delta above
           states the direction with an arrow and a signed percentage, so the
           line's tint is redundant reinforcement rather than information a
           colour-blind reader would lose (FR-V02). */
        <div className="mt-2 -mx-0.5" aria-hidden>
          <Sparkline
            points={history!.series}
            height={26}
            stroke={sparkColor}
            id={trendId ?? result.metricId}
          />
        </div>
      )}
      {hint && <p className="text-2xs text-subtle mt-1.5 leading-snug">{hint}</p>}
    </>
  );

  return result.drilldownHref ? (
    <Link
      href={result.drilldownHref}
      className="card p-4 block transition-colors hover:bg-surface-2"
    >
      {body}
    </Link>
  ) : (
    <Card className="p-4">{body}</Card>
  );
}

/** Server-rendered sparkline. No client JS, no layout shift. */
export function Sparkline({
  points,
  width = 260,
  height = 44,
  stroke = "var(--accent)",
  id,
}: {
  points: { x: string; y: number }[];
  width?: number;
  height?: number;
  stroke?: string;
  /**
   * Unique per rendered instance. The gradient id used to be derived from
   * `points.length` and the rounded max, and /businesses renders one Sparkline
   * PER BUSINESS UNIT in a loop — so any two units with the same series length
   * and rounded max produced colliding SVG gradient ids, and the second
   * silently won for both. `useId()` is unavailable in a server component, so
   * the caller supplies the distinguishing value.
   */
  id?: string;
}) {
  if (points.length < 2) return null;
  const ys = points.map((p) => p.y);
  const max = Math.max(...ys, 1);
  const min = Math.min(...ys, 0);
  const range = max - min || 1;
  const step = width / (points.length - 1);

  const coords = points.map((p, i) => {
    const x = i * step;
    const y = height - ((p.y - min) / range) * (height - 6) - 3;
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = `sp-${id ?? `${points.length}-${Math.round(max)}-${Math.round(min)}`}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Trend over ${points.length} days, ending at ${Math.round(points.at(-1)!.y)}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Horizontal comparison bar used in every breakdown list. */
export function BarRow({
  label,
  value,
  max,
  display,
  meta,
  color = "var(--accent)",
  href,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  meta?: ReactNode;
  color?: string;
  href?: string;
}) {
  // A negative value used to render as a positive-length bar via Math.abs(),
  // indistinguishable from a positive one except by reading the label — so a
  // loss-making business looked identical to a profitable one at a glance, on
  // a screen whose entire job is comparison. Negatives now render on the
  // opposite side of a baseline, in the negative colour.
  const negative = value < 0;
  const pct = max > 0 ? Math.min(100, Math.max(1.5, (Math.abs(value) / max) * 100)) : 0;
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-medium truncate">{label}</span>
        <span className="text-xs font-semibold tnum shrink-0">{display}</span>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden flex"
        style={{ background: "var(--surface-3)" }}
      >
        {negative && <div className="h-full" style={{ width: `${100 - pct}%` }} />}
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: negative ? "var(--negative)" : color }}
        />
      </div>
      {meta && <div className="text-2xs text-subtle mt-1">{meta}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="block py-1.5 -mx-1 px-1 rounded hover:bg-surface-2">
      {inner}
    </Link>
  ) : (
    <div className="py-1.5">{inner}</div>
  );
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "caution" | "negative" | "accent";
}) {
  const styles: Record<string, { background: string; color: string }> = {
    neutral: { background: "var(--surface-3)", color: "var(--text-muted)" },
    positive: { background: "var(--positive-soft)", color: "var(--positive)" },
    caution: { background: "var(--caution-soft)", color: "var(--caution)" },
    negative: { background: "var(--negative-soft)", color: "var(--negative)" },
    accent: { background: "var(--accent-soft)", color: "var(--accent)" },
  };
  return (
    <span className="chip" style={styles[tone]}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  icon = "✓",
}: {
  title: string;
  detail: string;
  icon?: string;
}) {
  return (
    <div className="px-4 py-8 text-center">
      <div
        className="mx-auto w-9 h-9 rounded-full grid place-items-center text-sm mb-2"
        style={{ background: "var(--positive-soft)", color: "var(--positive)" }}
        aria-hidden
      >
        {icon}
      </div>
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-2xs text-subtle mt-1 max-w-[32ch] mx-auto leading-relaxed">{detail}</p>
    </div>
  );
}

export function TileSkeleton() {
  return (
    <div className="card p-4">
      <div className="skeleton h-2.5 w-20" />
      <div className="skeleton h-7 w-28 mt-3" />
      <div className="skeleton h-2 w-16 mt-3" />
    </div>
  );
}

export function GridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <TileSkeleton key={i} />
      ))}
    </div>
  );
}

export const BU_COLOR: Record<string, string> = {
  violet: "var(--color-bu-violet)",
  blue: "var(--color-bu-blue)",
  cyan: "var(--color-bu-cyan)",
  amber: "var(--color-bu-amber)",
  lime: "var(--color-bu-lime)",
  orange: "var(--color-bu-orange)",
  rose: "var(--color-bu-rose)",
  slate: "var(--color-bu-slate)",
};

export { formatMoneyCompact };
