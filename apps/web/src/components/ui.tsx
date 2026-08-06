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

export function KpiTile({
  label,
  result,
  currency,
  polarity = "higher_is_better",
  compareLabel = "vs last month",
  hint,
  accent,
}: {
  label: string;
  result: MetricResult | null;
  currency: string;
  polarity?: "higher_is_better" | "lower_is_better" | "neutral";
  compareLabel?: string;
  hint?: string;
  accent?: boolean;
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
  const body = (
    <>
      <p className="label">{label}</p>
      <p className="kpi-value mt-1.5" style={accent ? { color: "var(--accent)" } : undefined}>
        {formatMetricValue(result.value, result.unit, currency)}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Delta ratio={result.changeRatio} polarity={polarity} />
        {result.changeRatio !== null && result.changeRatio !== undefined && (
          <span className="text-2xs text-subtle">{compareLabel}</span>
        )}
      </div>
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
}: {
  points: { x: string; y: number }[];
  width?: number;
  height?: number;
  stroke?: string;
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
  const gid = `sp-${points.length}-${Math.round(max)}`;

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
  const pct = max > 0 ? Math.max(1.5, (Math.abs(value) / max) * 100) : 0;
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-medium truncate">{label}</span>
        <span className="text-xs font-semibold tnum shrink-0">{display}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-3)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
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
