import { z } from "zod";
import type { Tx } from "@nexus/db";

/**
 * THE SEMANTIC LAYER.
 *
 * Anthropic's own analytics team reported going from 21% to ~95% answer
 * accuracy not by improving SQL generation but by putting a curated semantic
 * layer in front of the warehouse. Their conclusion — accuracy is a *context
 * and verification* problem, not a code-generation problem — is the reason this
 * file exists and the reason the AI assistant in this product has NO ability to
 * write SQL.
 *
 * Every number the product can state about a business — on a dashboard widget,
 * in a drill-down, in a scheduled report, or in an answer from the AI — comes
 * from a metric registered here. That gives us, in one stroke:
 *
 *   • One definition of "revenue". The dashboard and the AI cannot disagree.
 *   • Verifiability. Every AI claim carries the metric id + params that
 *     produced it, so the owner can click through to the underlying rows.
 *   • Safety. The AI selects from a closed set of parameterised queries; it
 *     cannot invent a join, leak another tenant, or run a table scan.
 *   • Testability. A metric is a pure function of (tenant, params) → number,
 *     so it can be snapshot-tested against the deterministic seed.
 *   • Cacheability. Keyed on (tenant, metric, params).
 *
 * The cost of this approach is that a question nobody anticipated cannot be
 * answered. That is the correct trade: a confidently wrong revenue figure is
 * far more damaging to a business owner than "I don't have a metric for that".
 */

export type MetricUnit = "currency" | "count" | "percent" | "days" | "ratio" | "score";

/** How to read a change: for churn or overdue debt, down is good. */
export type MetricPolarity = "higher_is_better" | "lower_is_better" | "neutral";

export const metricParamsSchema = z.object({
  /** Restrict to specific businesses. Empty/omitted = the whole portfolio. */
  businessUnitIds: z.array(z.uuid()).optional(),
  /** Inclusive ISO dates. Metrics document their own default window. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type MetricParams = z.infer<typeof metricParamsSchema>;

export interface MetricContext {
  tx: Tx;
  tenantId: string;
  /** Today, in the tenant's timezone, as an ISO date. Injected rather than
   *  read from the clock so tests and the AI evaluation suite are stable. */
  today: string;
  baseCurrency: string;
  /** Businesses this user is allowed to see. Applied on top of RLS as the
   *  authorisation (not isolation) layer. */
  allowedBusinessUnitIds: string[] | null;
}

export interface MetricBreakdownRow {
  key: string;
  label: string;
  value: number;
  meta?: Record<string, unknown>;
}

export interface MetricResult {
  metricId: string;
  value: number;
  unit: MetricUnit;
  /** Comparable prior-period figure, when the metric defines one. */
  priorValue?: number | null;
  /** Signed fractional change vs prior. 0.12 = +12%. */
  changeRatio?: number | null;
  breakdown?: MetricBreakdownRow[];
  /** Series for sparklines/charts: [{ x: ISO date, y: number }] */
  series?: { x: string; y: number }[];
  /** Where the owner goes to see the rows behind this number. */
  drilldownHref?: string;
  computedAt: string;
}

export interface MetricDefinition<P extends MetricParams = MetricParams> {
  id: string;
  title: string;
  /** Written for the AI as much as for a tooltip. Must state the exact
   *  business definition, because ambiguity here is where wrong answers start. */
  description: string;
  unit: MetricUnit;
  polarity: MetricPolarity;
  /** Permission required to read it. Payroll numbers must not leak into a
   *  dashboard shown to a receptionist. */
  permission: string;
  /** Modules that must be enabled for this metric to be meaningful. */
  requiresModules?: string[];
  /** Exposed to the AI assistant as a callable tool. A few metrics are
   *  dashboard-only because they are expensive or hard to phrase. */
  aiExposed: boolean;
  params?: z.ZodType<P>;
  run: (ctx: MetricContext, params: P) => Promise<Omit<MetricResult, "metricId" | "computedAt">>;
}

export function defineMetric<P extends MetricParams = MetricParams>(
  def: MetricDefinition<P>,
): MetricDefinition<P> {
  return def;
}

/** Numerics arrive from postgres-js as strings; never let one become NaN
 *  silently, because a NaN on a revenue tile is worse than an error. */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function changeRatio(current: number, prior: number | null | undefined): number | null {
  if (prior === null || prior === undefined) return null;
  if (prior === 0) return current === 0 ? 0 : null; // undefined growth from zero
  return (current - prior) / Math.abs(prior);
}
