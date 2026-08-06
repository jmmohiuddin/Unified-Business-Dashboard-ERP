import "server-only";
import { sql } from "drizzle-orm";
import { withoutTenant } from "@nexus/db";

/**
 * Rate limiting and login lockout.
 *
 * Backed by the database rather than an in-memory map, deliberately: an
 * in-memory limiter resets on every deploy and is per-instance, so it stops
 * exactly nobody the moment you run two containers. The counters here are small
 * and the queries are indexed; Redis is the upgrade when volume justifies it,
 * not a prerequisite for having a limit at all.
 *
 * Two separate mechanisms, because they defend different things:
 *
 *   IP throttle    — blunt, stops a script hammering the login form.
 *   Account lockout— per-user, stops a targeted attack on one account, and
 *                    deliberately does NOT tell the attacker it has triggered.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Sliding-window counter keyed by whatever you like: "login:1.2.3.4". */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const rows = await withoutTenant((db) =>
    db.execute<{ hits: number; oldest: string }>(sql`
      WITH inserted AS (
        INSERT INTO rate_limit_hits (key, at) VALUES (${key}, now()) RETURNING at
      )
      SELECT COUNT(*)::int AS hits,
             MIN(at)::text AS oldest
        FROM rate_limit_hits
       WHERE key = ${key}
         AND at > now() - (${windowSeconds}::int * interval '1 second')
    `),
  );

  const hits = rows[0]?.hits ?? 1;
  const oldest = rows[0]?.oldest ? Date.parse(rows[0].oldest) : Date.now();
  const retryAfter = Math.max(
    1,
    Math.ceil((oldest + windowSeconds * 1000 - Date.now()) / 1000),
  );

  return {
    allowed: hits <= limit,
    remaining: Math.max(0, limit - hits),
    retryAfterSeconds: retryAfter,
  };
}

/** Housekeeping — call from the nightly job. */
export async function pruneRateLimits(olderThanSeconds = 86_400): Promise<number> {
  const rows = await withoutTenant((db) =>
    db.execute<{ deleted: number }>(sql`
      WITH d AS (
        DELETE FROM rate_limit_hits
         WHERE at < now() - (${olderThanSeconds}::int * interval '1 second')
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM d
    `),
  );
  return rows[0]?.deleted ?? 0;
}

// ── Account lockout ─────────────────────────────────────────────────────────

const MAX_FAILED = 8;
const LOCKOUT_MINUTES = 15;

export async function isLockedOut(email: string): Promise<boolean> {
  const rows = await withoutTenant((db) =>
    db.execute<{ locked: boolean }>(sql`
      SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked
        FROM users WHERE lower(email) = ${email.toLowerCase()}
    `),
  );
  return Boolean(rows[0]?.locked);
}

/**
 * Record a failed attempt and lock the account past the threshold.
 *
 * The caller must NOT surface "this account is locked" — that confirms the
 * account exists. The login form returns the same generic failure either way;
 * the lockout is silent from the attacker's side.
 */
export async function recordFailedLogin(email: string): Promise<void> {
  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE users
         SET failed_login_count = to_jsonb(COALESCE((failed_login_count)::int, 0) + 1),
             locked_until = CASE
               WHEN COALESCE((failed_login_count)::int, 0) + 1 >= ${MAX_FAILED}
               THEN now() + (${LOCKOUT_MINUTES}::int * interval '1 minute')
               ELSE locked_until END
       WHERE lower(email) = ${email.toLowerCase()}
    `),
  );
}

export async function clearFailedLogins(userId: string): Promise<void> {
  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE users
         SET failed_login_count = '0'::jsonb, locked_until = NULL, last_login_at = now()
       WHERE id = ${userId}::uuid
    `),
  );
}
