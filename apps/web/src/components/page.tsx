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

/**
 * Filter chips rendered as links — no client state, shareable URLs.
 *
 * `params` carries any OTHER search parameter the screen reads through to the
 * tab links. Receivables needs it: a tab clicked while `?range=mtd` is applied
 * must stay inside the month, or the drill-down the owner arrived on silently
 * widens to the whole ledger. It deliberately does NOT carry the pager
 * position — changing the filter changes the row set, so page 4 of the old
 * filter means nothing in the new one and page 1 is the only honest landing.
 *
 * `defaultKey` is the tab the target page falls back to when the parameter is
 * absent, and getting it wrong breaks a tab outright. This used to be hardcoded
 * to `"all"`, so the bare `basePath` was emitted for the "All" tab everywhere —
 * but `/purchases` defaults to `unpaid` and `/services` defaults to `open`, so
 * on both screens clicking "All" navigated to a URL that re-selected the tab the
 * user was trying to leave. It looked like a dead chip and there was nothing to
 * see in the markup.
 */
export function FilterTabs({
  options,
  active,
  basePath,
  param = "filter",
  params,
  defaultKey = "all",
}: {
  options: { key: string; label: string; count?: number }[];
  active: string;
  basePath: string;
  param?: string;
  params?: Record<string, string | number | undefined>;
  defaultKey?: string;
}) {
  const extra = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => {
        const isActive = o.key === active;
        const query = [...(o.key === defaultKey ? [] : [`${param}=${o.key}`]), ...extra];
        const href = query.length === 0 ? basePath : `${basePath}?${query.join("&")}`;
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

/* ── Pagination ──────────────────────────────────────────────────────────── */

/**
 * PAGINATION.
 *
 * Every list screen in this product used to end at a hard `LIMIT` — 60 open
 * invoices, 80 bills, 100 customers — with no total, no next page and nothing
 * on screen saying rows had been dropped. That is not a performance shortcut,
 * it is a correctness failure: at seed volume the receivables list holds 243
 * open invoices and the accountant could reach 60 of them, while the chip above
 * the table said "60 shown" as though 60 were all there were. A number that is
 * quietly a subset is worse than no number, because it is believed.
 *
 * Three rules this component exists to enforce:
 *
 *  1. THE TOTAL IS REAL AND EXACT. `total` must come from a `COUNT(*)` over the
 *     *same* predicate as the row query, not from `rows.length`. Postgres can
 *     estimate a table's size from `pg_class.reltuples`, and that is genuinely
 *     cheaper — but an estimate cannot respect a `WHERE` clause, and "showing
 *     1–50 of about 4,100" in a book of account is the exact species of
 *     almost-right figure this product is built to eliminate. The counts are
 *     indexed and in the thousands, they run inside the transaction the page
 *     already opens, and they cost one round trip that the user is already
 *     waiting on. Exact wins.
 *
 *  2. THE SLICE IS TAKEN IN SQL. These are `force-dynamic` server components;
 *     slicing an already-truncated array in JavaScript would move the lie
 *     rather than fix it, and page 4 would simply be blank.
 *
 *  3. PAGING PRESERVES THE FILTER. Every link this renders carries the rest of
 *     the current query string, so paging an overdue list does not land the
 *     user back in the unfiltered one.
 *
 * Numbered rather than cursor-based, which is a deliberate departure from
 * TRD-03 API-3. WF-05 §7 specifies `◄ 1 2 3 … 12 ► 50 per page`, and a cursor
 * cannot answer "take me to page 7" or "how many are there" — the two questions
 * the audit says the accountant actually has. Offset paging is the wrong choice
 * at millions of rows; at this volume it is the honest one. Revisit if a list
 * ever passes ~100k rows.
 *
 * There is no `loading` variant even though PDD §11 lists one. The pager is
 * rendered by the same server component as its table, so it and the rows arrive
 * together; a skeleton pager over real rows would be theatre.
 */

/** Rows-per-page choices. 50 is the WF-05 default. */
export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * The URL parameters one pager owns.
 *
 * Two pagers on one route — inventory renders both the stock table and the
 * IMEI register — must not share them, or paging one silently pages the other.
 */
export interface PageKeys {
  /** 1-based page number. */
  page: string;
  /** Rows per page. */
  per: string;
}

export const DEFAULT_PAGE_KEYS: PageKeys = { page: "page", per: "per" };

export interface PageSlice {
  /** 1-based, already clamped into range. */
  page: number;
  perPage: number;
  /** SQL `OFFSET`. */
  offset: number;
  pages: number;
  total: number;
  /** 1-based inclusive row numbers of this slice — the "1–50" in "1–50 of 284". */
  from: number;
  to: number;
  keys: PageKeys;
}

/**
 * Resolve raw search params into a slice, given the real total.
 *
 * `total` is required rather than optional on purpose: it is the whole point of
 * the feature, and an optional argument would let a call site quietly re-ship
 * the unbounded list. Call it AFTER the count query and BEFORE the row query —
 * the returned `offset` is what the row query needs.
 *
 * An out-of-range `?page=` is clamped to the last page rather than served as an
 * empty table. A user who deletes rows and reloads a deep link should land on
 * the end of the list, not on a blank screen that looks like data loss.
 */
export function pageSlice(
  raw: Record<string, string | undefined>,
  total: number,
  { keys = DEFAULT_PAGE_KEYS, perPage: fallback = 50 }: { keys?: PageKeys; perPage?: number } = {},
): PageSlice {
  const asked = Number(raw[keys.per]);
  const perPage = (PAGE_SIZES as readonly number[]).includes(asked) ? asked : fallback;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const wanted = Math.trunc(Number(raw[keys.page]));
  const page = Number.isFinite(wanted) && wanted >= 1 ? Math.min(wanted, pages) : 1;
  const offset = (page - 1) * perPage;
  return {
    page,
    perPage,
    offset,
    pages,
    total,
    keys,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + perPage, total),
  };
}

/**
 * Which page numbers to render, and where the gaps go.
 *
 * Always the first, the last and the current ± 1. A gap is only drawn when it
 * hides more than one page — an "…" standing in for a single number is strictly
 * worse than the number, both to read and to click.
 */
function pageWindow(page: number, pages: number): (number | "gap")[] {
  const wanted = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const [i, n] of wanted.entries()) {
    const prev = wanted[i - 1];
    if (prev !== undefined) {
      if (n - prev === 2) out.push(prev + 1);
      else if (n - prev > 2) out.push("gap");
    }
    out.push(n);
  }
  return out;
}

/** Build a URL, dropping params that are empty or at their default. */
function pageHref(
  basePath: string,
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${basePath}?${q}` : basePath;
}

/**
 * `◄ 1 2 3 … 12 ►    50 per page`, per WF-05 §7.
 *
 * `params` must carry every OTHER search parameter the screen reads — the
 * filter, the search term, the sibling pager's position. Anything left out of
 * it is dropped the moment the user clicks a page number.
 */
export function Pagination({
  slice,
  basePath,
  params = {},
  noun = "rows",
  nounOne,
}: {
  slice: PageSlice;
  basePath: string;
  params?: Record<string, string | number | undefined>;
  /** Plural noun for the count line: "1–50 of 284 invoices". */
  noun?: string;
  /** Singular form. Defaults to `noun` minus a trailing "s"; pass it when the
   *  plural is irregular, so a one-row list never reads "All 1 items". */
  nounOne?: string;
}) {
  const { page, pages, total, from, to, perPage, keys } = slice;
  // Page 1 and the default size are the absence of a parameter, so a shared
  // link is the short, obvious URL rather than one carrying redundant state.
  const to_ = (n: number, size = perPage) =>
    pageHref(basePath, {
      ...params,
      [keys.page]: n === 1 ? undefined : n,
      [keys.per]: size === 50 ? undefined : size,
    });

  const one = nounOne ?? noun.replace(/s$/, "");
  const summary =
    total === 0 ? `No ${noun}`
    : total === 1 ? `1 ${one}`
    : pages === 1 ? `All ${total} ${noun}`
    : `Showing ${from}–${to} of ${total} ${noun}`;

  const step = "px-2 py-1 rounded-[var(--radius-sm)] text-2xs font-semibold tnum transition-colors";

  return (
    <nav
      aria-label={`${noun} pagination`}
      className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 border-t border-border"
    >
      <p className="text-2xs text-subtle tnum">{summary}</p>

      {pages > 1 && (
        <div className="flex items-center gap-0.5">
          {page > 1 ? (
            <Link href={to_(page - 1)} rel="prev" aria-label="Previous page"
              className={`${step} text-muted hover:bg-surface-2`}>
              ◄
            </Link>
          ) : (
            <span className={`${step} text-subtle opacity-40`} aria-hidden>◄</span>
          )}

          {pageWindow(page, pages).map((n, i) =>
            n === "gap" ? (
              <span key={`gap${i}`} className="px-1 text-2xs text-subtle" aria-hidden>…</span>
            ) : n === page ? (
              <span key={n} aria-current="page" className={`${step} bg-accent text-text-inverse`}>
                {n}
              </span>
            ) : (
              <Link key={n} href={to_(n)} aria-label={`Page ${n}`}
                className={`${step} text-muted hover:bg-surface-2`}>
                {n}
              </Link>
            ),
          )}

          {page < pages ? (
            <Link href={to_(page + 1)} rel="next" aria-label="Next page"
              className={`${step} text-muted hover:bg-surface-2`}>
              ►
            </Link>
          ) : (
            <span className={`${step} text-subtle opacity-40`} aria-hidden>►</span>
          )}
        </div>
      )}

      {/* Changing the page size returns to page 1. Keeping the page number
          would land the reader at an offset that meant nothing to them — page 4
          of 25-row pages is not page 4 of 100-row pages. */}
      {total > PAGE_SIZES[0] && (
        <div className="flex items-center gap-1">
          {PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={to_(1, size)}
              // The visible label is a bare number, which reads as "25, link"
              // to a screen reader and says nothing about what it does.
              aria-label={`Show ${size} per page`}
              aria-current={size === perPage ? "true" : undefined}
              className={`${step} ${
                size === perPage ? "bg-surface-2 text-text" : "text-subtle hover:bg-surface-2"
              }`}
            >
              {size}
            </Link>
          ))}
          <span className="text-2xs text-subtle ml-0.5" aria-hidden>per page</span>
        </div>
      )}
    </nav>
  );
}
