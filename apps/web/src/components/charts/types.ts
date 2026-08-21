/**
 * THE CHART CONTRACT.
 *
 * PDD §7 opens with the rule that governs this whole directory: *a chart's job
 * is to carry a conclusion, not to display data.* FR-V02 turns that into an
 * acceptance criterion — "every chart carries a plain-language conclusion line,
 * generated from the data, not a title" — and PDD §7.7 says how it is to be
 * enforced: "Every chart component takes a required `conclusion` prop. A chart
 * without one does not compile."
 *
 * `ChartBase` is that mechanism. Every component in this directory spreads it
 * into its props, so `conclusion` is a non-optional field on every chart's
 * public type and omitting it is a type error, not a review comment. The
 * ratchet that keeps it that way lives in `charts.test.tsx`: each chart is
 * instantiated once with `conclusion` omitted under `@ts-expect-error`. If
 * anybody ever relaxes the prop to optional, those directives become *unused*
 * and `tsc` fails the build. The requirement is therefore compile-checked in
 * both directions — you cannot omit the prop, and you cannot make it omissible.
 *
 * The one hole a required `string` cannot close is `conclusion=""`, because an
 * empty string is still a string. `ChartFrame` throws on it in development.
 *
 * A conclusion is a SENTENCE, not a heading. `title` exists separately and is
 * optional precisely so that the conclusion is never mistaken for one:
 *
 *   bad   title="Profit by month"
 *   good  conclusion="Profit fell AED 7,400 in August, mainly from the AC recharge"
 *
 * `conclude.ts` ships a generator per chart type so pages produce that sentence
 * from their data rather than hand-typing a caption that drifts from the bars
 * above it.
 */

import type { ReactNode } from "react";

export interface ChartBase {
  /**
   * The sentence this chart exists to say. Required — see the docblock above.
   * State the number, the concentration, and where possible the implied action:
   * "AED 61,000 of the AED 96,000 owed is from two tenants, both past 90 days."
   */
  conclusion: string;
  /** Optional heading. The conclusion is the headline; this is the filing label. */
  title?: string;
  /** Sub-heading: the period, the scope, the basis of preparation. */
  note?: string;
  /** Extra chrome under the plot — a legend caveat, a data-as-of stamp. */
  footnote?: ReactNode;
  className?: string;
}

/**
 * The table twin.
 *
 * PDD §7.8 requires a table view on every chart, for two different readers:
 * the screen-reader user, for whom an SVG is inert, and the accountant, who
 * wants to check a figure rather than estimate it off an axis. It is not an
 * optional extra, so it is not an optional prop — every chart builds its own
 * from the same data it plots, inside `ChartFrame`.
 *
 * Rows are pre-formatted strings rather than numbers: the chart has already
 * decided how to render a currency in this tenant, and a table that formats
 * independently is a table that can disagree with the bars beside it.
 */
export interface ChartTable {
  headers: string[];
  /** One array per row, aligned to `headers`. Index 0 is the row's label. */
  rows: string[][];
  /** Screen-reader caption. Says what the table is, not that it is a table. */
  caption: string;
}

/** A point on a time series. `x` is an ISO date so it sorts lexicographically. */
export interface Point {
  x: string;
  y: number;
}

/** How a value should be spoken and printed. Charts never guess. */
export type ValueFormat = (value: number) => string;

/**
 * The four colour jobs, named.
 *
 * Passing a raw colour into a chart is how a status colour ends up
 * impersonating a business unit (PDD §7.11). Callers name the JOB and the
 * chart resolves it to a token, so "this bar means bad" and "this bar means
 * salon" can never be spelled the same way.
 */
export type MarkTone = "accent" | "positive" | "negative" | "caution" | "neutral";

/** Business-unit identity hues. Identification only, never status. */
export type BuColor =
  | "violet" | "blue" | "cyan" | "amber"
  | "lime" | "orange" | "rose" | "slate";
