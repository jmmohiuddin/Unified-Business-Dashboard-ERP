import { METRICS_BY_ID } from "./registry.ts";
import {
  metricParamsSchema,
  type MetricContext,
  type MetricParams,
  type MetricResult,
} from "./types.ts";

export * from "./types.ts";
export { METRICS, METRICS_BY_ID } from "./registry.ts";

export class MetricError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_metric" | "forbidden" | "bad_params" | "failed",
  ) {
    super(message);
  }
}

/**
 * Single entry point for reading any number in the product.
 *
 * Enforces, in order: the metric exists → the caller holds the permission →
 * the params validate → the query runs. Nothing bypasses this, including the
 * AI assistant, which is why an AI answer can never expose payroll to a
 * receptionist or a business the user is not scoped to.
 */
export async function runMetric(
  ctx: MetricContext,
  metricId: string,
  rawParams: unknown = {},
  permissions: Set<string> | "all" = "all",
): Promise<MetricResult> {
  const def = METRICS_BY_ID[metricId];
  if (!def) throw new MetricError(`Unknown metric: ${metricId}`, "unknown_metric");

  if (permissions !== "all" && !permissions.has(def.permission)) {
    throw new MetricError(
      `Metric "${metricId}" requires permission "${def.permission}"`,
      "forbidden",
    );
  }

  const parsed = (def.params ?? metricParamsSchema).safeParse(rawParams ?? {});
  if (!parsed.success) {
    throw new MetricError(`Invalid params for ${metricId}: ${parsed.error.message}`, "bad_params");
  }

  const out = await def.run(ctx, parsed.data as MetricParams);
  return { ...out, metricId, computedAt: new Date().toISOString() };
}

/**
 * Run several metrics against one transaction.
 *
 * The dashboard needs ~12 numbers. Issuing 12 separate transactions would mean
 * 12 round trips and 12 `SET LOCAL` calls; sharing one transaction keeps the
 * whole dashboard inside a single tenant context and a single connection.
 * Failures are isolated — one broken widget must not blank the page.
 */
export async function runMetrics(
  ctx: MetricContext,
  requests: { metricId: string; params?: unknown }[],
  permissions: Set<string> | "all" = "all",
): Promise<Record<string, MetricResult | { error: string; code: string }>> {
  const out: Record<string, MetricResult | { error: string; code: string }> = {};
  for (const req of requests) {
    try {
      out[req.metricId] = await runMetric(ctx, req.metricId, req.params ?? {}, permissions);
    } catch (err) {
      const e = err instanceof MetricError ? err : new MetricError(String(err), "failed");
      out[req.metricId] = { error: e.message, code: e.code };
    }
  }
  return out;
}

/**
 * The metric registry rendered as Claude tool definitions.
 *
 * The AI assistant gets exactly these tools and nothing else — no SQL, no
 * table access, no filesystem. Its job is to choose metrics and interpret the
 * results, which is what language models are reliably good at, rather than to
 * author joins, which they are not.
 */
export function metricsAsAiTools(permissions: Set<string> | "all" = "all") {
  return Object.values(METRICS_BY_ID)
    .filter((m) => m.aiExposed)
    .filter((m) => permissions === "all" || permissions.has(m.permission))
    .map((m) => ({
      name: `get_${m.id}`,
      description: m.description,
      input_schema: {
        type: "object" as const,
        properties: {
          businessUnitIds: {
            type: "array" as const,
            items: { type: "string" as const },
            description:
              "Optional. Restrict to specific business unit ids. Omit for the whole portfolio.",
          },
          from: { type: "string" as const, description: "Optional ISO start date (YYYY-MM-DD)." },
          to: { type: "string" as const, description: "Optional ISO end date (YYYY-MM-DD)." },
          limit: { type: "integer" as const, description: "Optional row limit for ranked lists." },
        },
        required: [] as string[],
      },
    }));
}
