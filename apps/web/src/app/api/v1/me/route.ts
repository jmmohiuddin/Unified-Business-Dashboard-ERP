import { headers } from "next/headers";
import { metricsAsAiTools } from "@nexus/core";
import { authenticateApiToken } from "@/lib/api-auth";

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
  const auth = await authenticateApiToken(h.get("authorization"), {
    ip: h.get("x-client-ip") ?? "api",
  });
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
