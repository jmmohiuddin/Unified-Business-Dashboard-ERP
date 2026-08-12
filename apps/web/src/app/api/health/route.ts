import { sql } from "drizzle-orm";
import { withoutTenant } from "@nexus/db";

export const dynamic = "force-dynamic";

/**
 * HEALTH.
 *
 * There was no health endpoint at all. CI probed readiness by fetching the
 * login page, and a production failure was invisible — the audit's phrasing was
 * that if the deployed app threw a 500, nobody found out.
 *
 * Fetching a page is not a health check: it proves Next is listening, not that
 * the database is reachable, that migrations are applied, or that the scheduled
 * jobs have run. Each of those fails independently and silently.
 *
 * Unauthenticated on purpose — an uptime monitor cannot hold a session — so it
 * returns only booleans, counts and ages. No table contents, no configuration
 * values, no error strings from the database.
 */

interface Check {
  ok: boolean;
  detail?: string;
}

export async function GET() {
  const checks: Record<string, Check> = {};

  // ── Database ──────────────────────────────────────────────────────────────
  let migrationVersion: string | null = null;
  try {
    const rows = await withoutTenant((db) =>
      db.execute<{ one: number }>(sql`SELECT 1 AS one`),
    );
    checks.database = { ok: rows.length === 1 };
  } catch {
    checks.database = { ok: false, detail: "unreachable" };
  }

  // ── Schema version ────────────────────────────────────────────────────────
  // Drizzle records applied migrations in its own table. A container running
  // against a database that has not been migrated is the failure this catches,
  // and it is invisible until a query hits a missing column.
  if (checks.database.ok) {
    try {
      const rows = await withoutTenant((db) =>
        db.execute<{ hash: string; created_at: string }>(sql`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations
           ORDER BY created_at DESC LIMIT 1
        `),
      );
      migrationVersion = rows[0]?.hash?.slice(0, 12) ?? null;
      checks.migrations = {
        ok: rows.length > 0,
        detail: rows.length > 0 ? undefined : "none applied",
      };
    } catch {
      checks.migrations = { ok: false, detail: "migration table unreadable" };
    }
  }

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  // Silence is not success. A job that stopped running looks identical to one
  // that has nothing to do unless the last run is checked explicitly.
  if (checks.database.ok) {
    try {
      const rows = await withoutTenant((db) =>
        db.execute<{ job: string; hours: number }>(sql`
          SELECT job, EXTRACT(EPOCH FROM (now() - MAX(started_at))) / 3600 AS hours
            FROM job_runs GROUP BY job
        `),
      );
      const stale = rows.filter((r) => Number(r.hours) > 36).map((r) => r.job);
      checks.scheduledJobs = {
        // No rows at all is "not started yet", not a failure — the scheduler is
        // deployed separately and may legitimately not have run once.
        ok: stale.length === 0,
        detail: rows.length === 0 ? "no runs recorded" : stale.length ? `stale: ${stale.join(", ")}` : undefined,
      };
    } catch {
      checks.scheduledJobs = { ok: true, detail: "run log not present" };
    }
  }

  const ok = Object.values(checks).every((c) => c.ok);

  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      migrationVersion,
      checks,
      // Not the build time — the moment this instance answered.
      at: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
