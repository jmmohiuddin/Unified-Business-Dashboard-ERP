import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoneyCompact } from "@nexus/core";
import { Card } from "./ui";

/**
 * Layout primitives for module screens.
 *
 * Every list screen in the product is built from these four pieces, for one
 * reason: an ERP is dozens of near-identical screens, and the moment each one
 * is hand-rolled they drift — different empty states, different column
 * alignment, different loading behaviour. Consistency here is not aesthetics,
 * it is how the owner learns the product once instead of eleven times.
 *
 * All server components. No client JavaScript.
 */

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="text-2xs text-subtle hover:underline">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </header>
  );
}

export interface Stat {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "positive" | "caution" | "negative" | "accent";
}

/** Compact figure strip under a page header. Not KPI tiles — those belong on
 *  the dashboard; this is context for the list below. */
export function StatStrip({ stats }: { stats: Stat[] }) {
  const color = (t?: Stat["tone"]) =>
    t === "positive" ? "var(--positive)"
    : t === "caution" ? "var(--caution)"
    : t === "negative" ? "var(--negative)"
    : t === "accent" ? "var(--accent)"
    : "var(--text)";
  return (
    <Card className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x" as="div">
      {stats.map((s) => (
        <div key={s.label} className="px-4 py-3 min-w-0" style={{ borderColor: "var(--border)" }}>
          <p className="label truncate">{s.label}</p>
          <p
            className="text-lg font-semibold tnum tracking-tight mt-0.5 truncate"
            style={{ color: color(s.tone) }}
          >
            {s.value}
          </p>
          {s.hint && <p className="text-2xs text-subtle mt-0.5 truncate">{s.hint}</p>}
        </div>
      ))}
    </Card>
  );
}

/** Filter chips rendered as links — no client state, shareable URLs. */
export function FilterTabs({
  options,
  active,
  basePath,
  param = "filter",
}: {
  options: { key: string; label: string; count?: number }[];
  active: string;
  basePath: string;
  param?: string;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => {
        const isActive = o.key === active;
        const href = o.key === "all" ? basePath : `${basePath}?${param}=${o.key}`;
        return (
          <Link
            key={o.key}
            href={href}
            className="px-2.5 py-1 rounded-[var(--radius-md)] text-2xs font-semibold transition-colors"
            style={
              isActive
                ? { background: "var(--accent)", color: "var(--text-inverse)" }
                : { background: "var(--surface-2)", color: "var(--text-muted)" }
            }
          >
            {o.label}
            {o.count !== undefined && (
              <span className="ml-1 opacity-70 tnum">{o.count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  /** Right-align numerics so digits line up down the column. */
  numeric?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  empty,
  rowKey,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  empty: ReactNode;
  rowKey: (row: T) => string;
  caption?: string;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-x-auto">
      {caption && <p className="sr-only">{caption}</p>}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-2 label font-medium whitespace-nowrap ${c.numeric ? "text-right" : ""}`}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b last:border-0 hover:bg-surface-2 transition-colors"
              style={{ borderColor: "var(--border)" }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-2 align-middle ${c.numeric ? "text-right tnum" : ""}`}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Status pill with a fixed vocabulary.
 *
 * Status colour is mapped centrally so "overdue" is the same red everywhere in
 * the product. Per-screen colour choices are how a system ends up with three
 * different shades meaning "late".
 */
const STATUS_TONE: Record<string, "positive" | "caution" | "negative" | "accent" | "neutral"> = {
  paid: "positive", cleared: "positive", completed: "positive", active: "positive",
  delivered: "positive", occupied: "positive", done: "positive", invoiced: "positive",
  sent: "accent", booked: "accent", scheduled: "accent", deposited: "accent",
  confirmed: "accent", shipped: "accent", in_progress: "accent", dispatched: "accent",
  partially_paid: "caution", held: "caution", on_hold: "caution", pending: "caution",
  request: "caution", quoted: "caution", notice: "caution", available: "caution",
  overdue: "negative", bounced: "negative", cancelled: "negative", no_show: "negative",
  void: "negative", failed: "negative", defaulted: "negative", returned: "negative",
};

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const styles = {
    neutral: { background: "var(--surface-3)", color: "var(--text-muted)" },
    positive: { background: "var(--positive-soft)", color: "var(--positive)" },
    caution: { background: "var(--caution-soft)", color: "var(--caution)" },
    negative: { background: "var(--negative-soft)", color: "var(--negative)" },
    accent: { background: "var(--accent-soft)", color: "var(--accent)" },
  }[tone];
  return (
    <span className="chip" style={styles}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** Coloured dot + name, the standard way a business unit is identified. */
export function BuTag({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: `var(--color-bu-${color})` }}
        aria-hidden
      />
      <span className="text-muted">{name}</span>
    </span>
  );
}

/** Days-remaining pill that goes red as a deadline approaches. Used for every
 *  UAE expiry: trade licence, visa, labour card, Ejari, lease. */
export function DaysPill({ days, suffix = "d" }: { days: number; suffix?: string }) {
  const tone =
    days < 0 ? "negative" : days <= 30 ? "negative" : days <= 60 ? "caution" : "neutral";
  const styles = {
    neutral: { background: "var(--surface-3)", color: "var(--text-muted)" },
    caution: { background: "var(--caution-soft)", color: "var(--caution)" },
    negative: { background: "var(--negative-soft)", color: "var(--negative)" },
  }[tone];
  return (
    <span className="chip tnum" style={styles}>
      {days < 0 ? `${Math.abs(days)}${suffix} overdue` : `${days}${suffix}`}
    </span>
  );
}

export function Money({
  amount,
  currency = "AED",
  tone,
}: {
  amount: number;
  currency?: string;
  tone?: "default" | "positive" | "negative" | "muted";
}) {
  const color =
    tone === "positive" ? "var(--positive)"
    : tone === "negative" ? "var(--negative)"
    : tone === "muted" ? "var(--text-muted)"
    : undefined;
  return (
    <span className="tnum" style={color ? { color } : undefined}>
      {formatMoneyCompact(amount, currency)}
    </span>
  );
}

export function TableEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-2xs text-subtle mt-1 max-w-[38ch] mx-auto leading-relaxed">{detail}</p>
    </div>
  );
}
