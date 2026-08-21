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

/**
 * Housekeeping — called nightly by `/api/cron/maintenance`.
 *
 * Not optional. `rateLimit` above inserts a row for every rate-limited request
 * and then does a `COUNT(*)` over the same table on the way past, so without
 * this the guard on every write gets slower for as long as the product is used.
 * For most of this file's life the function existed, was exported, and had no
 * caller at all.
 */
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

/**
 * A lockout is a BRAKE, not a ban.
 *
 * The original implementation gated on `users.failed_login_count`, a counter
 * that only ever went up and was only ever reset by a successful login. Past
 * the threshold, every further failure re-armed `locked_until` — so anybody who
 * knew a valid email address could hold that account shut permanently by
 * sending one wrong password every fifteen minutes, about ninety-six requests a
 * day, from anywhere. There is no unlock screen and no expiry, so the owner's
 * only route back into their own ERP was a human with database access. A
 * defence against credential stuffing that hands an attacker a permanent
 * denial-of-service against a known address has made the account less
 * available, not more secure.
 *
 * Two changes make it bounded without making it weaker:
 *
 *  1. THE COUNTER DECAYS. The threshold now counts failures inside a sliding
 *     FAILURE_WINDOW, recorded in `rate_limit_hits` — the same sliding-window
 *     mechanism `rateLimit` above already uses, rather than a second one. Eight
 *     failures a day apart are eight ordinary typos; eight in a quarter of an
 *     hour are an attack. Only the second shape locks anything, so the
 *     slow-drip attack above no longer reaches the threshold at all — and an
 *     attacker who slows down far enough to stay under it is no longer guessing
 *     passwords at a rate that threatens one.
 *
 *  2. REPEATED LOCKOUTS ESCALATE. Decay alone would let an attacker cycle
 *     8 failures / 15 minutes / 8 failures indefinitely. Each lockout within
 *     ESCALATION_WINDOW_HOURS doubles the next one — 15, 30, then 60 minutes,
 *     capped — so sustained stuffing collapses to roughly 150 attempts a day
 *     against an argon2id hash, while a legitimate user is never shut out for
 *     more than an hour and a day of quiet resets the escalation to zero.
 *
 * `users.failed_login_count` is still maintained, and it is now EVIDENCE, not a
 * gate: "failures since this account last logged in successfully", for a human
 * reading a security review. Nothing branches on it. Re-attaching a lock to a
 * monotonic counter is precisely how this bug is reintroduced.
 *
 * Coupled to `pruneRateLimits` above: the escalation memory lives in
 * `rate_limit_hits`, so it lasts for the shorter of ESCALATION_WINDOW_HOURS and
 * the nightly prune horizon. They are both 24 hours, deliberately. Shortening
 * the prune horizon shortens the escalation memory with it.
 */
const MAX_FAILED = 8;
const FAILURE_WINDOW_MINUTES = 15;
const BASE_LOCKOUT_MINUTES = 15;
const MAX_LOCKOUT_MINUTES = 60;
const ESCALATION_WINDOW_HOURS = 24;

/** Sliding-window failure ledger, keyed per account. Matches the `login:` key
 *  convention the login action already uses for its own two throttles. */
const failKey = (email: string) => `login:fail:${email.toLowerCase()}`;
/** One row per lockout imposed. Counting these is the escalation. */
const lockKey = (email: string) => `login:lock:${email.toLowerCase()}`;

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
 * Record a failed attempt and, past the windowed threshold, impose a lockout.
 *
 * The caller must NOT surface "this account is locked" — that confirms the
 * account exists. The login form returns the same generic failure either way;
 * the lockout is silent from the attacker's side.
 *
 * Runs as one transaction, opened with `SELECT ... FOR UPDATE` on the user row,
 * for two reasons that both matter here:
 *
 *   • Counting must see the failure just recorded. Postgres gives every CTE in
 *     a single statement the same snapshot, so the `WITH inserted AS (INSERT
 *     …)` shape `rateLimit` uses above counts everything EXCEPT the current
 *     hit. Separate statements inside a transaction do not have that problem.
 *   • The row lock serialises concurrent failures for the same account, so two
 *     simultaneous wrong passwords cannot each observe seven prior failures,
 *     both decline to lock, and let the threshold be walked straight past.
 */
export async function recordFailedLogin(email: string): Promise<void> {
  const address = email.toLowerCase();

  await withoutTenant((db) =>
    db.transaction(async (tx) => {
      const held = await tx.execute<{ id: string }>(sql`
        SELECT id FROM users WHERE lower(email) = ${address} FOR UPDATE
      `);
      // No such account. The caller already burns comparable time on a missing
      // address so latency does not leak existence; there is simply nothing to
      // count against.
      if (held.length === 0) return;

      await tx.execute(sql`
        INSERT INTO rate_limit_hits (key, at) VALUES (${failKey(address)}, now())
      `);

      const [counts] = await tx.execute<{ failures: number; lockouts: number }>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM rate_limit_hits
            WHERE key = ${failKey(address)}
              AND at > now() - (${FAILURE_WINDOW_MINUTES}::int * interval '1 minute')
          ) AS failures,
          (SELECT COUNT(*)::int FROM rate_limit_hits
            WHERE key = ${lockKey(address)}
              AND at > now() - (${ESCALATION_WINDOW_HOURS}::int * interval '1 hour')
          ) AS lockouts
      `);

      const failures = counts?.failures ?? 1;
      if (failures < MAX_FAILED) {
        // Under the threshold: record the evidence and let it age out.
        await tx.execute(sql`
          UPDATE users
             SET failed_login_count = to_jsonb(COALESCE((failed_login_count)::int, 0) + 1)
           WHERE lower(email) = ${address}
        `);
        return;
      }

      // Doubling, capped. `lockouts` excludes the one being imposed now, so the
      // first lockout in the window is the base duration.
      const minutes = Math.min(
        BASE_LOCKOUT_MINUTES * 2 ** (counts?.lockouts ?? 0),
        MAX_LOCKOUT_MINUTES,
      );

      await tx.execute(sql`
        INSERT INTO rate_limit_hits (key, at) VALUES (${lockKey(address)}, now())
      `);
      // Locking CONSUMES the failures that caused it. Without this the window
      // and the lockout expire together and the very next wrong password
      // re-locks the account off the same eight rows — the permanent lockout
      // rebuilt from parts.
      await tx.execute(sql`
        DELETE FROM rate_limit_hits WHERE key = ${failKey(address)}
      `);
      await tx.execute(sql`
        UPDATE users
           SET failed_login_count = to_jsonb(COALESCE((failed_login_count)::int, 0) + 1),
               locked_until = now() + (${minutes}::int * interval '1 minute')
         WHERE lower(email) = ${address}
      `);
    }),
  );
}

/**
 * A successful login releases the brake completely.
 *
 * Including the windowed failure rows, which is why this reads the address back
 * from the id: a user who mistyped their password five times and then got it
 * right must not be five failures into a window they cannot see. The lockout
 * *escalation* rows are deliberately left alone — they are the record of how
 * often this account has been attacked today, and one correct password does not
 * retire that.
 */
export async function clearFailedLogins(userId: string): Promise<void> {
  await withoutTenant((db) =>
    db.transaction(async (tx) => {
      const rows = await tx.execute<{ email: string | null }>(sql`
        UPDATE users
           SET failed_login_count = '0'::jsonb, locked_until = NULL, last_login_at = now()
         WHERE id = ${userId}::uuid
        RETURNING lower(email) AS email
      `);
      const address = rows[0]?.email;
      if (!address) return;
      await tx.execute(sql`
        DELETE FROM rate_limit_hits WHERE key = ${failKey(address)}
      `);
    }),
  );
}
