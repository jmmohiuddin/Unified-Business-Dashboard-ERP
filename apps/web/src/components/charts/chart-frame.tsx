import type { CSSProperties, ReactNode } from "react";
import { DataTable, type Column } from "@/components/page";
import type { ChartBase, ChartTable, MarkTone } from "./types";

/**
 * The shell every chart in this directory renders through.
 *
 * It exists so that three things cannot be forgotten one chart at a time:
 * the conclusion line (PDD §7.7), the table view (§7.8) and the figure
 * semantics that make both reachable. No chart file exports a bare plot — each
 * exports only its frame-wrapped component — so there is no way to render a
 * plot in this product without also rendering the sentence that explains it.
 *
 * ── WHY THE CONCLUSION SITS ABOVE THE PLOT ──────────────────────────────────
 * It is the finding, and a finding printed under the evidence gets read second
 * or not at all. The reader this product is built for glances at a phone
 * between meetings (PDD §1); the sentence is what they came for and the bars
 * are the audit trail. `<figcaption>` is legal as the first child of a
 * `<figure>` precisely so a caption can lead.
 *
 * ── WHY THE TABLE IS A `<details>` AND NOT A TOGGLE ─────────────────────────
 * Native disclosure means the table is in the DOM at all times, so a screen
 * reader reaches every number whether or not the control was ever operated —
 * a JavaScript toggle would hide the accessible copy behind an interaction the
 * assistive-technology user cannot see the point of. It also keeps the whole
 * chart system a server component with no hydration cost, which is the same
 * bargain `Disclosure` in `action-form.tsx` already makes.
 *
 * ── WHY NO CHART HERE EMITS AN SVG `id` ─────────────────────────────────────
 * `Sparkline` had to grow an `id` prop because it derived a gradient id from
 * its data, and /businesses renders one per business unit in a loop — so two
 * units with the same series length silently shared a gradient and the second
 * won for both. Nothing threw and nothing type-checked wrong. The fix that
 * generalises is not "pass a better id", it is to define no referenced SVG
 * resources at all: no gradients (washes are `fill-opacity` on a token), no
 * filters, no clip paths, and figure/caption association by DOM nesting rather
 * than `aria-labelledby`. That class of defect is then structurally absent, and
 * `charts.test.tsx` asserts it by rendering every chart twice and failing on
 * any `id=` in the output.
 */

export const MARK: Record<MarkTone, string> = {
  accent: "var(--accent)",
  positive: "var(--positive)",
  negative: "var(--negative)",
  caution: "var(--caution)",
  /**
   * Totals and subtotals in a waterfall, and any bar that means "no polarity".
   * `--text-muted` rather than `--border`: it is a mark carrying data, so it
   * owes WCAG 1.4.11's 3:1 against the surface, which a border colour chosen
   * to be recessive deliberately does not clear.
   */
  neutral: "var(--text-muted)",
};

/**
 * Business-unit identity hues.
 *
 * MEASURED CAVEAT, recorded because it changes what you may build with these:
 * run as a categorical chart palette through the data-viz validator, the eight
 * `--color-bu-*` tokens FAIL three of the five computable checks —
 *
 *   chroma floor        `slate` at C 0.031 reads as grey, not as an identity
 *   CVD separation      `blue`↔`violet` ΔE 1.3 under deuteranopia (floor 6.0)
 *   normal-vision floor `rose`↔`orange` ΔE 10.4 unsimulated (floor 15.0)
 *
 * and two of them also miss FR-V02's own 3:1 non-text contrast criterion when
 * used as a bar mark: `amber` and `lime` both measure 2.95:1 against
 * `--surface` in the LIGHT theme. (Dark is fine — all eight clear 3:1 there,
 * which is a coincidence of these being light-theme values reused rather than a
 * dark step having been chosen.) A bar painted in either is a graphical object
 * that a low-vision reader cannot locate against the card.
 *
 * and they are declared inside `@theme`, so they are static and have no dark
 * step — PDD §7.10 requires each colour to have one. That is audit item 10,
 * which is not this agent's file to fix.
 *
 * The consequence for this directory is a design constraint, not a blocker:
 * NO CHART HERE IDENTIFIES A SERIES BY BUSINESS-UNIT HUE ALONE. Six businesses
 * are compared with small multiples, one titled panel each (PDD §7.4), so
 * identity is carried by the panel heading and the hue is decoration that
 * happens to be consistent with the rest of the product. Overlaying six
 * business series on one set of axes would depend on these hues and is exactly
 * what §7.4 forbids anyway.
 */
export const BU_MARK: Record<string, string> = {
  violet: "var(--color-bu-violet)",
  blue: "var(--color-bu-blue)",
  cyan: "var(--color-bu-cyan)",
  amber: "var(--color-bu-amber)",
  lime: "var(--color-bu-lime)",
  orange: "var(--color-bu-orange)",
  rose: "var(--color-bu-rose)",
  slate: "var(--color-bu-slate)",
};

/**
 * Inline styles in this directory carry ONLY data-derived geometry and custom
 * properties, never a colour literal and never a static declaration that a
 * utility class could express.
 *
 * A bar's width is a number computed from the data; Tailwind's scanner is
 * static and cannot emit a class for a value that does not exist until the
 * query runs, so `width: 43.2%` has to be an inline style — `BarRow` already
 * does this and it is correct. What must NOT leak inline is the colour: the
 * token goes into a custom property here and is consumed through
 * `bg-[var(--mark)]`, so it stays a real Tailwind utility and hover/focus
 * variants can still compose onto it. That is the same defect the `@theme
 * inline` bridge in `globals.css` was added to fix, and writing
 * `style={{ background: … }}` would reintroduce it one component at a time.
 */
export function vars(v: Record<string, string | number>): CSSProperties {
  return v as CSSProperties;
}

export function ChartFrame({
  conclusion,
  title,
  note,
  footnote,
  className = "",
  table,
  children,
}: ChartBase & { table: ChartTable; children: ReactNode }) {
  // The one hole a required `string` prop cannot close. A chart that renders an
  // empty conclusion has silently opted out of the rule the whole directory
  // exists to enforce, so it fails loudly where a developer will see it and
  // degrades to "no caption" in production rather than blanking a dashboard.
  if (process.env.NODE_ENV !== "production") {
    if (!conclusion.trim()) {
      throw new Error(
        "Chart `conclusion` is empty. PDD §7.7: every chart states what it means. " +
          "Generate the sentence from the data — see `conclude.ts`.",
      );
    }
    if (title && conclusion.trim() === title.trim()) {
      throw new Error(
        `Chart \`conclusion\` repeats the title ("${title}"). A conclusion is a ` +
          "sentence about the data, not a heading: \"Profit fell AED 7,400 in " +
          "August, mainly from the AC recharge\", not \"Profit by month\".",
      );
    }
  }

  const columns: Column<string[]>[] = table.headers.map((header, i) => ({
    key: String(i),
    header,
    // Column 0 is the row label; every other column of a chart's table is the
    // number it plotted, and numbers align right so digits line up.
    numeric: i > 0,
    render: (row) => row[i] ?? "",
  }));

  return (
    <figure className={`card overflow-hidden ${className}`}>
      <figcaption className="px-4 pt-3.5 pb-2.5">
        {title && <p className="label">{title}</p>}
        <p className={`text-sm font-medium leading-snug ${title ? "mt-1" : ""}`}>{conclusion}</p>
        {note && <p className="text-2xs text-subtle mt-1 leading-snug">{note}</p>}
      </figcaption>

      <div className="px-4 pb-3">{children}</div>

      {footnote && <div className="px-4 pb-3 text-2xs text-subtle leading-snug">{footnote}</div>}

      <details className="group border-t">
        <summary className="cursor-pointer list-none px-4 py-2.5 text-2xs font-semibold select-none flex items-center gap-1.5 text-accent hover:bg-surface-2 transition-colors">
          <span className="group-open:rotate-90 transition-transform" aria-hidden>
            ›
          </span>
          Table view
        </summary>
        <div className="border-t">
          <DataTable
            columns={columns}
            rows={table.rows}
            rowKey={(row) => row[0]}
            caption={table.caption}
            empty={<p className="px-4 py-6 text-2xs text-subtle text-center">No rows.</p>}
          />
        </div>
      </details>
    </figure>
  );
}

/**
 * The empty state, which is a chart's job to have an opinion about.
 *
 * WF-05 §0 requires five states on every screen and "empty" is the one charts
 * get wrong: a plot with no marks looks like a plot that failed to load. The
 * conclusion stays required here too — "No cash moved in this period" is a
 * finding, and it is the one the reader needs.
 */
export function ChartEmpty({
  conclusion,
  title,
  note,
  className = "",
}: Omit<ChartBase, "footnote">) {
  return (
    <figure className={`card ${className}`}>
      <figcaption className="px-4 pt-3.5 pb-2.5">
        {title && <p className="label">{title}</p>}
        <p className={`text-sm font-medium leading-snug ${title ? "mt-1" : ""}`}>{conclusion}</p>
        {note && <p className="text-2xs text-subtle mt-1 leading-snug">{note}</p>}
      </figcaption>
      <div className="px-4 pb-6">
        <div className="h-16 rounded-md border border-dashed grid place-items-center">
          <span className="text-2xs text-subtle">Nothing to plot for this period</span>
        </div>
      </div>
    </figure>
  );
}

/** Loading state. Same footprint as a rendered chart so nothing jumps when the
 *  data arrives — `.skeleton` already collapses under `prefers-reduced-motion`
 *  because `globals.css` zeroes `--motion-shimmer` for that query. */
export function ChartSkeleton({ height = 120 }: { height?: number }) {
  return (
    <div className="card p-4">
      <div className="skeleton h-2.5 w-24" />
      <div className="skeleton h-3.5 w-3/4 mt-2.5" />
      <div className="skeleton mt-4 w-full" style={vars({ height: `${height}px` })} />
    </div>
  );
}

/**
 * Legend. Present whenever two or more series are drawn, without exception —
 * it is the identity channel that does not depend on the reader distinguishing
 * two hues, which the measured caveat on `BU_MARK` shows is not safe to assume.
 *
 * `symbol` is not decoration. FR-V02 requires that "no chart conveys meaning
 * through colour alone", so a legend entry that means a SIGN carries the sign
 * as a glyph and the swatch merely repeats it.
 */
export function ChartLegend({
  items,
  shape = "rect",
}: {
  items: { label: string; mark: string; symbol?: string; opacity?: number }[];
  shape?: "rect" | "line";
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-2xs text-muted">
          <span
            aria-hidden
            className={
              shape === "line"
                ? "block w-3.5 h-0.5 rounded-full bg-[var(--mark)]"
                : "block w-2.5 h-2.5 rounded-[3px] bg-[var(--mark)]"
            }
            style={vars({ "--mark": it.mark, opacity: it.opacity ?? 1 })}
          />
          {it.symbol && (
            <span aria-hidden className="text-[0.9em] leading-none">
              {it.symbol}
            </span>
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}
