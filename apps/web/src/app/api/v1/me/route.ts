import { headers } from "next/headers";
import { metricsAsAiTools } from "@nexus/core";
import { authenticateApiToken } from "@/lib/api-auth";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/v1/me
 *
 * Identity and capability discovery for a client. Returns who the token acts
 * as, its effective permissions, and — usefully for a mobile app — the exact
 * list of metrics this token may read, so the client can build its home screen
 * without hard-coding what it is allowed to see.
 */
export async function GET() {
  const h = await headers();
  const ip = h.get("x-client-ip") ?? "api";

  // Identical policy to /api/v1/metrics/:id — 120/60, same `api:` key, so the
  // two share one budget per client. OPS-07 §1.4 requires it verbatim, and this
  // route needs it more than its sibling does, not less: every unauthenticated
  // attempt runs a four-way join on the adminDb() pool (api-auth.ts), which has
  // only max: 5, so an unthrottled endpoint here starves the session resolver
  // for the whole app. And on a valid token the 200 hands back the full
  // permission list, the tenant id and the business-unit ids — the complete
  // reconnaissance payload, previously available an unlimited number of times.
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

  const readableMetrics = metricsAsAiTools(auth.principal.permissions).map((t) => ({
    id: t.name.replace(/^get_/, ""),
    description: t.description.split(".")[0], // one-line summary
  }));

  return Response.json({
    tenant: auth.tenantId,
    role: auth.principal.roleKey,
    scope: auth.principal.scope,
    businessUnitIds: auth.principal.businessUnitIds,
    baseCurrency: auth.baseCurrency,
    permissions: [...auth.principal.permissions].sort(),
    readableMetrics,
  });
}
