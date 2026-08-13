import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { adminDb, withTenant, withoutTenant } from "@nexus/db";

export const dynamic = "force-dynamic";
// Snapshots sweep every metric for every business unit; give them room.
export const maxDuration = 300;

/**
 * SCHEDULED JOBS.
 *
 * The automation runner, the notification outbox, the daily briefing and the
 * KPI snapshot job were built and inert — each needed a human to type a CLI
 * command. Three subsystems that did nothing in production, and no KPI history
 * at all, which is why no screen can show a trend.
 *
 * Runtime choice, and it is a deliberate departure from TRD-03 ADR-003:
 * that ADR specifies a separate always-on process host plus Redis. For nine
 * users, one tenant and four jobs whose finest granularity is daily, that buys
 * a second deployment target, a second set of secrets and a second thing that
 * can be down. This uses the ADR's own documented fallback — a job table with
 * database-enforced locking, driven by Vercel Cron. The graduation trigger to a
 * real worker is stated in MASTER_PROJECT_STATE: sub-minute scheduling, or
 * outbox volume beyond a few hundred a day.
 *
 * The lock is the run row itself. Claiming a job is an INSERT guarded by a
 * partial unique index on (job) WHERE finished_at IS NULL, so a second
 * invocation that overlaps the first simply fails to insert and exits. No
 * Redis, no lease renewal, no split brain.
 *
 * SCHEDULE CONSTRAINT. Vercel's Hobby plan permits daily crons only — an
 * hourly outbox schedule made the whole DEPLOY fail, not just the cron. All
 * four therefore run once a day, staggered. That is fine today because no
 * delivery provider is connected and the outbox has nothing to send; the moment
 * one is, daily is too slow for a "your cheque bounced" message and this needs
 * either the Pro plan or an external trigger hitting the same endpoint. The
 * endpoints are plain authenticated HTTP, so any scheduler can drive them —
 * nothing here is coupled to Vercel Cron.
 */

const JOBS = ["automation", "outbox", "briefing", "snapshots"] as const;
type Job = (typeof JOBS)[number];

/** Constant-time compare so the secret cannot be recovered by timing. */
function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // Fail CLOSED. With no secret configured the endpoint is disabled rather than
  // open — an unauthenticated trigger for every scheduled job is not a default.
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ job: string }> },
) {
  if (!authorised(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { job } = await params;
  if (!JOBS.includes(job as Job)) {
    return Response.json({ error: "unknown_job" }, { status: 404 });
  }

  // Claim. The unique index does the mutual exclusion.
  let runId: string;
  try {
    const rows = await withoutTenant((db) =>
      db.execute<{ id: string }>(sql`
        INSERT INTO job_runs (id, job) VALUES (gen_random_uuid(), ${job})
        RETURNING id
      `),
    );
    runId = rows[0]!.id;
  } catch {
    // Another invocation holds it. Not an error — cron overlapping a long run
    // is normal, and the right response is to do nothing.
    return Response.json({ status: "already_running", job }, { status: 409 });
  }

  const started = Date.now();
  try {
    const counts = await run(job as Job);
    await withoutTenant((db) =>
      db.execute(sql`
        UPDATE job_runs
           SET finished_at = now(), ok = true, counts = ${JSON.stringify(counts)}::jsonb
         WHERE id = ${runId}::uuid
      `),
    );
    return Response.json({ status: "ok", job, ms: Date.now() - started, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await withoutTenant((db) =>
      db.execute(sql`
        UPDATE job_runs SET finished_at = now(), ok = false, error = ${message}
         WHERE id = ${runId}::uuid
      `),
    );
    console.error(`[cron/${job}]`, err);
    // The run is recorded as failed either way; /health reports staleness.
    return Response.json({ status: "failed", job }, { status: 500 });
  }
}

/**
 * Every tenant, not just the first.
 *
 * The automation CLI selected `LIMIT 1` tenant, so it was not multi-tenant even
 * when run by hand — scheduling it unchanged would have silently served one
 * arbitrary tenant forever.
 */
async function tenants(): Promise<{ id: string; base_currency: string; timezone: string }[]> {
  /**
   * Owner connection, and it has to be.
   *
   * `tenants` is RLS-protected and the app role is NOBYPASSRLS, so reading it
   * without `app.tenant_id` set returns ZERO rows — which is not an error, just
   * silence. Testing this caught exactly that: every job reported success
   * having swept "0 tenants", the precise failure mode a scheduler is supposed
   * to eliminate. This is the same chicken-and-egg the session and API-token
   * resolvers have, and it is solved the same way: a bootstrap read as the
   * owner, then per-tenant work under `withTenant`.
   */
  return adminDb().execute<{ id: string; base_currency: string; timezone: string }>(sql`
    SELECT id, base_currency, timezone FROM tenants WHERE deleted_at IS NULL
  `);
}

/** The job's own idea of "today", in the tenant's timezone rather than UTC. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function run(job: Job): Promise<Record<string, number>> {
  const all = await tenants();
  const counts: Record<string, number> = { tenants: all.length };

  if (job === "snapshots") {
    // KPI history. kpi_snapshots was written by the seed and read by nothing,
    // and no job maintained it — which is why no screen can show a trend.
    let written = 0;
    for (const t of all) {
      const rows = await withTenant({ tenantId: t.id }, (tx) =>
        tx.execute<{ one: number }>(sql`
          INSERT INTO kpi_snapshots
            (id, tenant_id, business_unit_id, on_date, metric_key, value, computed_at)
          SELECT gen_random_uuid(), d.tenant_id, d.business_unit_id,
                 ${todayIn(t.timezone)}::date, 'revenue', COALESCE(SUM(d.subtotal), 0), now()
            FROM documents d
           WHERE d.doc_type = 'invoice' AND d.status <> 'cancelled'
             AND d.issue_date = ${todayIn(t.timezone)}::date
           GROUP BY d.tenant_id, d.business_unit_id
          ON CONFLICT DO NOTHING
          RETURNING 1 AS one
        `),
      );
      written += rows.length;
    }
    counts.snapshots = written;
    return counts;
  }

  if (job === "automation") {
    const { runAutomations } = await import("@nexus/core/automation");
    let matched = 0;
    for (const t of all) {
      const outcomes = await withTenant({ tenantId: t.id }, (tx) =>
        // The CLI defaults to dry-run; the scheduler is the one caller meant
        // to commit. Caps, dedupe keys and approval gates still apply.
        runAutomations(tx, t.id, { commit: true, today: todayIn(t.timezone) }),
      );
      matched += outcomes.length;
    }
    counts.rulesFired = matched;
    return counts;
  }

  if (job === "outbox") {
    const { consoleProvider, dispatchOutbox } = await import("@nexus/core");
    let sent = 0;
    for (const t of all) {
      const summary = await withTenant({ tenantId: t.id }, (tx) =>
        dispatchOutbox(tx, { commit: true, provider: consoleProvider, now: new Date() }),
      );
      sent += summary?.sent ?? 0;
    }
    counts.delivered = sent;
    return counts;
  }

  // briefing
  const { composeBriefing, persistBriefing } = await import("@nexus/core");
  let written = 0;
  for (const t of all) {
    const today = todayIn(t.timezone);
    await withTenant({ tenantId: t.id }, async (tx) => {
      const b = await composeBriefing({
        tx, tenantId: t.id, today,
        baseCurrency: t.base_currency, allowedBusinessUnitIds: null,
      });
      await persistBriefing(tx, t.id, today, b);
    });
    written++;
  }
  counts.briefings = written;
  return counts;
}
