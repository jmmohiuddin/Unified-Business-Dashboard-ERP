import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { MetricError, runMetric, type MetricContext , reportError } from "@nexus/core";
import { authenticateApiToken } from "@/lib/api-auth";
import { resolveToday } from "@/lib/data";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/v1/metrics/:id
 *
 * The public read API is the SAME semantic layer the dashboard and the AI use.
 * A mobile client asking for "revenue_mtd" gets the identical number the owner
 * sees on the web, computed by the identical code, checked against the identical
 * permission — because there is one implementation, not three. That is the whole
 * reason `packages/core` has no React in it.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const h = await headers();
  const ip = h.get("x-client-ip") ?? "api";

  // Programmatic clients can hammer, so the API is rate-limited independently
  // of the login form.
  const limit = await rateLimit(`api:${ip}`, 120, 60);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", retryAfter: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const auth = await authenticateApiToken(h.get("authorization"), { ip });
  if (!auth) {
    return Response.json({ error: "unauthorized" }, {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  const { id } = await params;
  const url = new URL(req.url);
  const businessUnitIds = url.searchParams.getAll("businessUnitId");
  const rawParams: Record<string, unknown> = {};
  if (businessUnitIds.length) rawParams.businessUnitIds = businessUnitIds;
  if (url.searchParams.get("from")) rawParams.from = url.searchParams.get("from");
  if (url.searchParams.get("to")) rawParams.to = url.searchParams.get("to");
  if (url.searchParams.get("limit")) rawParams.limit = Number(url.searchParams.get("limit"));

  try {
    const result = await withTenant(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const ctx: MetricContext = {
          tx,
          tenantId: auth.tenantId,
          today: resolveToday(auth.timezone),
          baseCurrency: auth.baseCurrency,
          allowedBusinessUnitIds: auth.principal.businessUnitIds,
        };
        return runMetric(ctx, id, rawParams, auth.principal.permissions);
      },
    );
    return Response.json(
      { data: result, currency: auth.baseCurrency },
      { headers: { "Cache-Control": "private, max-age=30" } },
    );
  } catch (err) {
    if (err instanceof MetricError) {
      const status = err.code === "forbidden" ? 403 : err.code === "unknown_metric" ? 404 : 400;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    // Never leak an internal error to an API client.
    reportError(err, "api/v1/metrics");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
