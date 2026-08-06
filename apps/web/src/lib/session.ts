import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { appDb, withTenant, withoutTenant, uuidv7, schema } from "@nexus/db";
import { resolvePermissions, type Principal } from "@nexus/core";

const COOKIE = "nexus_session";
const SESSION_DAYS = 30;

/**
 * Session tokens are stored HASHED.
 *
 * The cookie holds a 256-bit random token; the database holds only its SHA-256.
 * A dump of the sessions table therefore grants an attacker nothing — the same
 * reasoning as password hashing, applied to the credential that is actually
 * presented on every request.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, tenantId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await withoutTenant(async (db) => {
    await db.insert(schema.sessions).values({
      id: uuidv7(),
      userId,
      tokenHash: hashToken(token),
      activeTenantId: tenantId,
      expiresAt,
    });
  });

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  // Cap concurrent sessions AFTER issuing the new one, so the session just
  // created is the one that survives.
  await enforceSessionCap(userId);
  return token;
}

/**
 * Concurrent-session cap.
 *
 * Not primarily a convenience feature. An account quietly accumulating twenty
 * live sessions across six months is what a compromised credential looks like,
 * and an unbounded session table means a stolen token from March still works in
 * September. Oldest sessions are revoked past the cap.
 */
const MAX_CONCURRENT_SESSIONS = 5;

async function enforceSessionCap(userId: string): Promise<void> {
  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE sessions SET revoked_at = now()
       WHERE user_id = ${userId}::uuid
         AND revoked_at IS NULL
         AND id NOT IN (
           SELECT id FROM sessions
            WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT ${MAX_CONCURRENT_SESSIONS}
         )
    `),
  );
}

/**
 * Sign out everywhere.
 *
 * The action a user needs the moment they suspect a compromise, and the one
 * most small systems never build — leaving "change your password" as the only
 * remedy, which does nothing to an already-issued session token.
 */
export async function revokeAllSessions(
  userId: string,
  opts: { keepCurrent?: boolean } = {},
): Promise<number> {
  const jar = await cookies();
  const current = jar.get(COOKIE)?.value;
  const keepHash = opts.keepCurrent && current ? hashToken(current) : null;

  const rows = await withoutTenant((db) =>
    db.execute<{ n: number }>(sql`
      WITH revoked AS (
        UPDATE sessions SET revoked_at = now()
         WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
           ${keepHash ? sql`AND token_hash <> ${keepHash}` : sql``}
        RETURNING 1
      ) SELECT COUNT(*)::int n FROM revoked
    `),
  );
  if (!opts.keepCurrent) jar.delete(COOKIE);
  return rows[0]?.n ?? 0;
}

/** Housekeeping for the nightly job — expired rows are not evidence. */
export async function pruneExpiredSessions(olderThanDays = 30): Promise<number> {
  const rows = await withoutTenant((db) =>
    db.execute<{ n: number }>(sql`
      WITH d AS (
        DELETE FROM sessions
         WHERE expires_at < now() - (${olderThanDays}::int * interval '1 day')
        RETURNING 1
      ) SELECT COUNT(*)::int n FROM d
    `),
  );
  return rows[0]?.n ?? 0;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await withoutTenant(async (db) => {
      await db
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.sessions.tokenHash, hashToken(token)));
    });
  }
  jar.delete(COOKIE);
}

/** Password verification — argon2id. See lib/crypto.ts for the parameters. */
export { hashPassword, verifyPassword, validatePasswordStrength } from "./crypto";

/**
 * A session that has authenticated with a password but has not yet cleared the
 * MFA challenge. It can do exactly one thing: complete the challenge.
 *
 * Modelled as a distinct short-lived cookie rather than a flag on the real
 * session, so there is no code path where a half-authenticated session can be
 * mistaken for a full one.
 */
const MFA_COOKIE = "nexus_mfa_pending";
const MFA_WINDOW_MINUTES = 10;

export async function createMfaChallenge(userId: string, tenantId: string): Promise<void> {
  const jar = await cookies();
  const payload = `${userId}.${tenantId}.${Date.now()}`;
  const mac = createHash("sha256")
    .update(`${payload}.${process.env.AUTH_SECRET ?? ""}`)
    .digest("base64url");
  jar.set(MFA_COOKIE, `${payload}.${mac}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MFA_WINDOW_MINUTES * 60,
  });
}

export async function readMfaChallenge(): Promise<{ userId: string; tenantId: string } | null> {
  const jar = await cookies();
  const raw = jar.get(MFA_COOKIE)?.value;
  if (!raw) return null;
  const [userId, tenantId, issuedAt, mac] = raw.split(".");
  if (!userId || !tenantId || !issuedAt || !mac) return null;

  const expected = createHash("sha256")
    .update(`${userId}.${tenantId}.${issuedAt}.${process.env.AUTH_SECRET ?? ""}`)
    .digest("base64url");
  // Tamper check — without this, a user could edit the cookie to another id.
  if (expected.length !== mac.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  if (Date.now() - Number(issuedAt) > MFA_WINDOW_MINUTES * 60_000) return null;

  return { userId, tenantId };
}

export async function clearMfaChallenge(): Promise<void> {
  const jar = await cookies();
  jar.delete(MFA_COOKIE);
}

export interface SessionUser {
  userId: string;
  fullName: string;
  email: string | null;
  tenantId: string;
  tenantName: string;
  baseCurrency: string;
  timezone: string;
  principal: Principal;
}

/**
 * Resolve the current principal.
 *
 * Wrapped in React `cache()` so that a page, its layout and half a dozen
 * components can each ask "who is this?" while only one database round trip
 * happens per request — the standard Server Components de-duplication pattern.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  /**
   * Deliberately TWO phases, because tenant context is a chicken-and-egg
   * problem: `memberships` and `tenants` are RLS-protected, but you cannot set
   * `app.tenant_id` until you know which tenant the session belongs to.
   *
   * Phase 1 touches only global tables (sessions, users) to learn the tenant.
   * Phase 2 opens a tenant-scoped transaction and reads everything else through
   * the policies. The alternative — running the whole auth query as the owner
   * role — would work, and is exactly the shortcut that turns "one bug in the
   * auth query" into "cross-tenant data exposure".
   */
  const identity = await withoutTenant((db) =>
    db.execute<{
      user_id: string; full_name: string; email: string | null;
      is_platform_admin: boolean; active_tenant_id: string | null;
    }>(sql`
      SELECT u.id AS user_id, u.full_name, u.email, u.is_platform_admin,
             s.active_tenant_id
        FROM sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ${hashToken(token)}
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
       LIMIT 1
    `),
  );

  const me = identity[0];
  if (!me?.active_tenant_id) return null;
  const tenantId = me.active_tenant_id;

  const context = await withTenant({ tenantId, userId: me.user_id }, async (tx) => {
    const rows = await tx.execute<{
      tenant_name: string; base_currency: string; timezone: string;
      membership_id: string; scope: string; role_key: string; role_level: string;
      permission_overrides: { grant?: string[]; deny?: string[] } | null;
    }>(sql`
      SELECT t.name AS tenant_name, t.base_currency, t.timezone,
             m.id AS membership_id, m.scope::text, m.permission_overrides,
             r.key AS role_key, r.level::text AS role_level
        FROM memberships m
        JOIN tenants t ON t.id = m.tenant_id
        JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = ${me.user_id}::uuid AND m.status = 'active'
       LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;

    const scopes = await tx.execute<{
      business_unit_id: string | null; location_id: string | null;
    }>(sql`
      SELECT business_unit_id, location_id FROM membership_scopes
       WHERE membership_id = ${row.membership_id}::uuid
    `);

    // Role grants live in global catalogue tables, readable in any context.
    const perms = await tx.execute<{ key: string }>(sql`
      SELECT p.key FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      JOIN roles r ON r.id = rp.role_id
      WHERE r.key = ${row.role_key}
    `);

    return { row, scopes, perms };
  });

  if (!context) return null;
  const { row, scopes, perms } = context;
  const scopeLevel = row.scope as Principal["scope"];
  const buIds = scopes.map((s) => s.business_unit_id).filter(Boolean) as string[];

  return {
    userId: me.user_id,
    fullName: me.full_name,
    email: me.email,
    tenantId,
    tenantName: row.tenant_name,
    baseCurrency: row.base_currency,
    timezone: row.timezone,
    principal: {
      userId: me.user_id,
      tenantId,
      membershipId: row.membership_id,
      roleKey: row.role_key,
      roleLevel: Number(row.role_level),
      scope: scopeLevel,
      // `tenant` scope sees everything; anything narrower is limited to the
      // explicitly granted businesses — and an empty list means empty, not all.
      businessUnitIds: scopeLevel === "tenant" ? null : buIds,
      locationIds: scopes.map((s) => s.location_id).filter(Boolean) as string[],
      permissions: resolvePermissions(
        perms.map((p) => p.key),
        row.permission_overrides,
      ),
      isPlatformAdmin: me.is_platform_admin,
    },
  };
});

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  // `redirect` throws, so this function never returns for an anonymous caller —
  // but it must be imported statically for TypeScript to see the `never`.
  if (!session) redirect("/login");
  return session;
}

/**
 * Demo accounts shown on the sign-in screen so every role can be inspected.
 *
 * DEVELOPMENT ONLY, for two independent reasons:
 *
 *  1. Enumerating accounts on a public login page is an information-disclosure
 *     bug in its own right, regardless of this being demo data.
 *  2. It reads `memberships`, which is RLS-protected, before any tenant context
 *     exists — so it has to run on the owner connection. That is acceptable for
 *     a dev affordance and unacceptable in a request path.
 *
 * Returns [] in production, so the screen degrades to a plain password form.
 */
export const listDemoUsers = cache(
  async (): Promise<
    { email: string | null; full_name: string; role_name: string; role_key: string }[]
  > => {
    if (process.env.NODE_ENV === "production") return [];
    const { adminDb } = await import("@nexus/db");
    return adminDb().execute(sql`
      SELECT u.email, u.full_name, r.name AS role_name, r.key AS role_key
        FROM users u
        JOIN memberships m ON m.user_id = u.id
        JOIN roles r ON r.id = m.role_id
       ORDER BY r.level DESC, u.full_name
    `);
  },
);

export { appDb, and, eq, gt, isNull };
