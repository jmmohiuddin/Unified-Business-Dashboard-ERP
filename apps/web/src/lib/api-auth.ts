import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { resolvePermissions, security, type Principal } from "@nexus/core";

/**
 * API TOKEN AUTHENTICATION.
 *
 * The mobile app, and any future integration, authenticate here rather than
 * with a session cookie. The design rule that makes this safe: a token is bound
 * to a membership and inherits that user's exact permissions and business
 * scope. There is no parallel "API can do X" surface that could drift out of
 * sync with what the same person can do in the browser — the service layer's
 * `requirePermission` gates the token exactly as it gates a click.
 *
 * Tokens are stored hashed. A dump of `api_tokens` grants nothing, the same as
 * the sessions table.
 */

export interface ApiPrincipal {
  tenantId: string;
  userId: string;
  baseCurrency: string;
  timezone: string;
  principal: Principal;
  scopes: string[];
  tokenId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a token. Returns the plaintext ONCE — it is never recoverable after. */
export async function createApiToken(
  tenantId: string,
  membershipId: string,
  name: string,
  opts: { scopes?: string[]; expiresInDays?: number; createdByUserId?: string } = {},
): Promise<{ token: string; prefix: string }> {
  const token = `nxk_${randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, 12);
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
    : null;

  await withTenant({ tenantId }, (tx) =>
    tx.execute(sql`
      INSERT INTO api_tokens
        (id, tenant_id, membership_id, name, prefix, token_hash, scopes,
         expires_at, created_by_user_id)
      VALUES
        (gen_random_uuid(), ${tenantId}::uuid, ${membershipId}::uuid, ${name}, ${prefix},
         ${hashToken(token)}, ${JSON.stringify(opts.scopes ?? [])}::jsonb,
         ${expiresAt?.toISOString() ?? null}::timestamptz, ${opts.createdByUserId ?? null}::uuid)
    `),
  );
  return { token, prefix };
}

/**
 * Resolve a bearer token to a principal.
 *
 * Mirrors the session resolver's two-phase shape: a global-table lookup to find
 * the token and its tenant, then a tenant-scoped read for the role, scope and
 * permissions — so a token is bound by RLS exactly as a session is.
 */
export async function authenticateApiToken(
  authHeader: string | null,
  meta: { ip?: string } = {},
): Promise<ApiPrincipal | null> {
  const token = authHeader?.match(/^Bearer\s+(nxk_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return null;

  // Bootstrap lookup on the owner connection.
  //
  // `api_tokens`, `memberships`, `roles` and `tenants` are all RLS-protected,
  // and — the chicken-and-egg — we cannot set `app.tenant_id` until we know
  // which tenant the token belongs to. This is the same two-phase pattern the
  // session resolver uses; the difference is that sessions bootstrap off the
  // un-RLS'd `sessions`/`users` tables, whereas the token tables are all
  // isolated, so the bootstrap must run as the owner. The scope query below
  // then runs under tenant context, exactly like a browser session.
  const rows = await adminDb().execute<{
    id: string; tenant_id: string; membership_id: string; scopes: string[];
    user_id: string; role_key: string; scope: string; is_active: boolean;
    base_currency: string; timezone: string;
    permission_overrides: { grant?: string[]; deny?: string[] } | null;
  }>(sql`
    SELECT t.id, t.tenant_id, t.membership_id, t.scopes,
           m.user_id, m.scope::text, m.permission_overrides,
           r.key AS role_key,
           (t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
            AND m.status = 'active') AS is_active,
           ten.base_currency, ten.timezone
      FROM api_tokens t
      JOIN memberships m ON m.id = t.membership_id
      JOIN roles r ON r.id = m.role_id
      JOIN tenants ten ON ten.id = t.tenant_id
     WHERE t.token_hash = ${hashToken(token)}
     LIMIT 1
  `);

  const row = rows[0];
  if (!row || !row.is_active) {
    security.denied({ ip: meta.ip, detail: { reason: "invalid or expired api token" } });
    return null;
  }

  // Role grants and membership scope. Both touch RLS-protected catalogue
  // tables, so they run under the token's tenant context (scopes) or on the
  // owner connection (the global permission catalogue), mirroring the session
  // resolver exactly.
  const [perms, scopes] = await Promise.all([
    adminDb().execute<{ key: string }>(sql`
      SELECT p.key FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      JOIN roles r ON r.id = rp.role_id
      WHERE r.key = ${row.role_key}
    `),
    withTenant({ tenantId: row.tenant_id }, (tx) =>
      tx.execute<{ business_unit_id: string | null }>(sql`
        SELECT business_unit_id FROM membership_scopes
         WHERE membership_id = ${row.membership_id}::uuid
      `),
    ),
  ]);

  // Fire-and-forget last-used stamp; never block the request on it.
  void adminDb()
    .execute(sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${row.id}::uuid`)
    .catch(() => {});

  let permissions = resolvePermissions(perms.map((p) => p.key), row.permission_overrides);

  // Token scopes NARROW the user's permissions, never widen them. A scoped
  // token intersects with what the user could already do.
  if (row.scopes.length > 0) {
    const allowed = new Set(row.scopes);
    permissions = new Set([...permissions].filter((p) => allowed.has(p)));
  }

  const scopeLevel = row.scope as Principal["scope"];
  const buIds = scopes.map((s) => s.business_unit_id).filter(Boolean) as string[];

  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    baseCurrency: row.base_currency,
    timezone: row.timezone,
    scopes: row.scopes,
    tokenId: row.id,
    principal: {
      userId: row.user_id,
      tenantId: row.tenant_id,
      membershipId: row.membership_id,
      roleKey: row.role_key,
      roleLevel: 0,
      scope: scopeLevel,
      businessUnitIds: scopeLevel === "tenant" ? null : buIds,
      locationIds: null,
      permissions,
      isPlatformAdmin: false,
    },
  };
}
