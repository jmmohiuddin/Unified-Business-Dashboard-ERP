import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { adminDb, withTenant, withoutTenant, type Tx } from "@nexus/db";
import {
  METRICS,
  Money,
  reportError,
  runMetric,
  type MetricContext,
  type MetricResult,
} from "@nexus/core";

export const dynamic = "force-dynamic";
// Snapshots sweep the whole metric registry for every tenant; give them room.
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
 * SILENCE IS NOT SUCCESS — ADR-003's own phrasing, and the rule every branch
 * below is written to obey. A run that swept nothing, delivered nothing or
 * could not even claim its lock must record a FAILURE, because the only thing
 * watching these jobs is `/health`, and `/health` can see a `job_runs` row but
 * not what is inside it. A cheerful row is indistinguishable from a working
 * scheduler for as long as anybody cares to look.
 *
 * SCHEDULE CONSTRAINT. Vercel's Hobby plan permits daily crons only — an
 * hourly outbox schedule made the whole DEPLOY fail, not just the cron. All
 * five therefore run once a day, staggered. That is survivable today because
 * no delivery provider is connected and the outbox is consequently a dry run
 * (see the `outbox` branch); the moment one is, daily is too slow for a "your
 * cheque bounced" message and this needs either the Pro plan or an external
 * trigger hitting the same endpoint. The endpoints are plain authenticated
 * HTTP, so any scheduler can drive them — nothing here is coupled to Vercel
 * Cron, and no branch below depends on running at a particular hour.
 */

const JOBS = ["automation", "outbox", "briefing", "snapshots", "maintenance"] as const;
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

/**
 * Is this the overlap the run lock exists to produce, or something else?
 *
 * `job_runs_inflight_uq` is a partial UNIQUE index on (job) WHERE finished_at
 * IS NULL, so a genuine overlapping invocation raises SQLSTATE 23505 and
 * nothing else on this table does — the only other unique index is the primary
 * key on a `gen_random_uuid()`.
 *
 * Everything that is NOT 23505 is an outage: Neon unreachable, `nexus_app`
 * missing its grant on `job_runs`, the table absent after a half-applied
 * migration. Those used to return the same contented 409 as an overlap, which
 * writes no row and logs nothing, so a total scheduler failure was detectable
 * only as an ABSENCE — `/health` calling the jobs stale a day and a half later.
 *
 * The chain walk is not defensive padding. Drizzle re-throws driver failures
 * wrapped in its own `Failed query: …` error and hangs the `PostgresError` —
 * the only thing carrying the SQLSTATE — off `cause`, so reading `err.code`
 * alone finds nothing and classifies every ordinary overlap as an outage.
 */
function isRunLockConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The half of a database error a human can act on.
 *
 * Drizzle wraps a driver failure as `Failed query: <the entire statement>` and
 * hangs the Postgres error — the part naming the column, the constraint or the
 * missing grant — off `cause`. Recording only the wrapper fills
 * `job_runs.error` with SQL and omits the diagnosis, which is how a job comes
 * to be "recorded as failed" and still tell nobody why.
 */
function describe(err: unknown): string {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (err instanceof Error) return err.message;
  return String(err);
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
  } catch (err) {
    if (isRunLockConflict(err)) {
      // Another invocation holds it. Not an error — cron overlapping a long run
      // is normal, and the right response is to do nothing.
      return Response.json({ status: "already_running", job }, { status: 409 });
    }
    // The claim itself failed, so there is no run row to mark failed and no
    // second chance to notice. Reporting it is the only record that exists.
    reportError(err, `cron/${job}/claim`);
    return Response.json({ status: "claim_failed", job }, { status: 500 });
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
    const message = describe(err);
    await withoutTenant((db) =>
      db.execute(sql`
        UPDATE job_runs SET finished_at = now(), ok = false, error = ${message}
         WHERE id = ${runId}::uuid
      `),
    );
    reportError(err, `cron/${job}`);
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

/**
 * The job's own idea of "today", in the tenant's timezone rather than UTC.
 *
 * This is the day currently IN PROGRESS. Anything that summarises a completed
 * period wants `lastCompletedDayIn` instead — see the note there.
 */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * The most recent day that has actually FINISHED, in the tenant's timezone.
 *
 * The snapshot job used to stamp `on_date = todayIn(tz)` and sum the same day's
 * invoices. Vercel Cron fires in UTC and this deployment is UTC+4, so the 20:50
 * UTC schedule lands at 00:50 the NEXT day in Dubai: the job summed the fifty
 * minutes of a brand-new day — normally nothing at all — filed it under that
 * new day, and the day that had just completed was never snapshotted by anyone.
 *
 * Deriving the date by subtracting a day from the tenant's own calendar date,
 * rather than by picking a clever UTC hour, makes that class of bug impossible
 * to reintroduce: today is by definition not over yet, whatever hour the job
 * runs and whichever side of midnight the scheduler's timezone puts it on.
 */
function lastCompletedDayIn(timezone: string): string {
  const d = new Date(`${todayIn(timezone)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Serialise a metric value for `numeric(18,4)`.
 *
 * `MetricResult.value` is a plain `number` by design — the semantic layer hands
 * numbers to charts and JSON. Interpolating one straight into SQL is how you
 * write `1e-7` into a numeric column and fail the whole sweep on a parse error,
 * so it goes through the money serialiser, which is where the storage scale and
 * the rounding mode are decided for everything else in the product.
 */
function storable(value: number): string {
  return Money.toDb(Money.money(Number.isFinite(value) ? value : 0));
}

/**
 * Write one tenant's daily KPI row set.
 *
 * Idempotent by DELETE-then-INSERT rather than by `ON CONFLICT`, and that is
 * forced by the schema: `kpi_snapshots_uq` is UNIQUE (tenant_id,
 * business_unit_id, on_date, metric_key), these rows are portfolio-wide so
 * `business_unit_id` is NULL, and Postgres treats NULLs in a unique index as
 * distinct. `ON CONFLICT DO NOTHING` would therefore never fire and a re-run —
 * a retried cron, a manual catch-up — would silently double every row.
 *
 * `breakdown` is NOT NULL, so a metric with no breakdown stores `[]` rather
 * than the column default `{}` — the shape is `MetricBreakdownRow[]` either way
 * and a reader should not have to handle two of them.
 */
async function writeSnapshots(
  tx: Tx,
  tenantId: string,
  onDate: string,
  results: { key: string; result: MetricResult }[],
): Promise<number> {
  if (results.length === 0) return 0;
  const keys = sql.join(results.map((r) => sql`${r.key}`), sql`, `);

  await tx.execute(sql`
    DELETE FROM kpi_snapshots
     WHERE on_date = ${onDate}::date
       AND business_unit_id IS NULL
       AND metric_key IN (${keys})
  `);

  const values = sql.join(
    results.map(
      (r) => sql`(
        gen_random_uuid(), ${tenantId}::uuid, NULL, ${onDate}::date, ${r.key},
        ${storable(r.result.value)}::numeric,
        ${r.result.priorValue == null ? null : storable(r.result.priorValue)}::numeric,
        ${JSON.stringify(r.result.breakdown ?? [])}::jsonb,
        now()
      )`,
    ),
    sql`, `,
  );

  const rows = await tx.execute<{ one: number }>(sql`
    INSERT INTO kpi_snapshots
      (id, tenant_id, business_unit_id, on_date, metric_key, value, prior_value,
       breakdown, computed_at)
    VALUES ${values}
    RETURNING 1 AS one
  `);
  return rows.length;
}

async function run(job: Job): Promise<Record<string, number>> {
  if (job === "maintenance") return maintenance();

  const all = await tenants();
  const counts: Record<string, number> = { tenants: all.length };

  if (job === "snapshots") {
    /**
     * KPI history, written BY the metric registry.
     *
     * ADR-004 states the rule this branch used to break verbatim: "the snapshot
     * is written by the same metric function, never by a parallel SQL query."
     * The old code re-implemented revenue as `SUM(subtotal) WHERE status <>
     * 'cancelled'`, while `revenue_mtd` excludes `('cancelled','void','draft')`
     * — so a stored figure labelled `revenue` counted draft and void invoices
     * the dashboard on the next screen does not. Two definitions of revenue is
     * the one outcome the semantic layer exists to prevent, and it had already
     * happened in the only place a number was persisted.
     *
     * Sweeping the whole registry rather than one hard-coded key is what makes
     * the table able to answer a trend question at all: one row per metric per
     * completed day is the series every "vs last month" arrow needs.
     *
     * `ctx.today` is the completed day, not the clock, so each row is the state
     * of the business as at the END of `on_date` — which is what makes two rows
     * from two different days comparable.
     *
     * One row per metric, portfolio-wide (`business_unit_id` NULL), rather than
     * a full metric x business-unit cross product. The per-business split is
     * already in `breakdown` for the metrics where it means anything —
     * `business_performance` returns it by construction — so the cross product
     * would multiply the sweep by the number of businesses to store numbers the
     * registry has a first-class answer for. The seed's own `revenue` and
     * `gross_profit` rows ARE per-business and use keys that are not metric
     * ids, so the two sets never collide.
     *
     * Permissions: swept as "all", because this is a system process with no
     * principal and RLS still confines it to the one tenant. That makes
     * `kpi_snapshots` a table containing figures some users may not read —
     * `staff_performance` needs `employee:read`, the UAE metrics need more —
     * so any reader MUST re-check `METRICS_BY_ID[metric_key].permission`
     * before rendering a row. Nothing reads the table today; this is the note
     * for whoever writes the first trend chart.
     */
    let written = 0;
    const failures: string[] = [];

    for (const t of all) {
      const onDate = lastCompletedDayIn(t.timezone);
      try {
        // One transaction per tenant: every metric then sees the same MVCC
        // snapshot, so the twenty-odd figures filed under one date are
        // mutually consistent rather than smeared across the sweep's duration.
        written += await withTenant({ tenantId: t.id }, async (tx) => {
          const ctx: MetricContext = {
            tx,
            tenantId: t.id,
            today: onDate,
            baseCurrency: t.base_currency,
            allowedBusinessUnitIds: null,
          };
          const results: { key: string; result: MetricResult }[] = [];
          for (const def of METRICS) {
            // Deliberately NOT caught per metric. A failing metric is a failed
            // statement inside this transaction, which poisons it — every
            // subsequent read would return "current transaction is aborted".
            // Losing one tenant's day loudly beats writing a partial day that
            // looks complete.
            results.push({ key: def.id, result: await runMetric(ctx, def.id, {}, "all") });
          }
          return writeSnapshots(tx, t.id, onDate, results);
        });
      } catch (err) {
        failures.push(`${t.id}: ${describe(err)}`);
      }
    }

    counts.metrics = METRICS.length;
    counts.snapshots = written;
    counts.tenantsFailed = failures.length;

    if (failures.length > 0) {
      throw new Error(
        `snapshots: ${failures.length}/${all.length} tenant(s) failed ` +
          `(${written} rows written) — ${failures.join("; ")}`,
      );
    }
    // A sweep that wrote nothing while tenants exist is not a quiet day, it is
    // a broken job: every metric returns a row even when the number is zero.
    // The old code reported exactly this as `{"status":"ok","snapshots":0}`.
    if (all.length > 0 && written === 0) {
      throw new Error(
        `snapshots: swept ${all.length} tenant(s) x ${METRICS.length} metrics and wrote 0 rows`,
      );
    }
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
    /**
     * DRY RUN, and it must stay one until a real provider exists.
     *
     * `consoleProvider` is the only `DeliveryProvider` in the codebase and it
     * `console.log`s — its own docblock says so, and says being the default is
     * the point, because "it accidentally sent" is worse than "it accidentally
     * didn't". This job nevertheless ran it with `commit: true`, and
     * `dispatchOutbox` then stamps `status = 'success', sent_at = now(),
     * provider = 'console'` on anything the provider returns `sent` for. A
     * `cheque_bounced` alert was written to a serverless stdout stream, marked
     * delivered, and never retried: the delivery log asserted a delivery that
     * did not happen, which is worse than no delivery log.
     *
     * So the scheduler no longer commits with a provider that cannot deliver.
     * The consent, quiet-hours and contactability gates still run, and their
     * verdicts are reported below — but nothing is stamped, so no notification
     * acquires a false `sent_at`. `delivered` is 0 by construction and says so.
     *
     * The in-app inbox is unaffected: `loadInbox` reads `notifications`
     * regardless of `status`, so an in-app alert reaches the owner whether or
     * not this job ever touches it.
     *
     * Flipping `commit` back on is a two-part change and both parts are
     * required: a provider that actually sends, AND the fix owed by
     * `packages/core/src/services/outbox.ts` so that a no-op provider can never
     * record a success even if it is passed in by mistake.
     */
    const { consoleProvider, dispatchOutbox } = await import("@nexus/core");
    let considered = 0;
    let deliverable = 0;
    let suppressed = 0;
    let deferred = 0;
    for (const t of all) {
      const summary = await withTenant({ tenantId: t.id }, (tx) =>
        dispatchOutbox(tx, { commit: false, provider: consoleProvider, now: new Date() }),
      );
      considered += summary.considered;
      // In dry run `sent` counts messages that PASSED every gate, i.e. what a
      // real provider would have been handed. Named for what it is.
      deliverable += summary.sent;
      suppressed += summary.suppressed;
      deferred += summary.deferred;
    }
    counts.considered = considered;
    counts.deliverable = deliverable;
    counts.suppressed = suppressed;
    counts.deferred = deferred;
    counts.delivered = 0;
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

/**
 * Housekeeping for the tables nothing else sheds rows from.
 *
 * `pruneRateLimits` and `pruneExpiredSessions` were written, exported, and each
 * documented as "call from the nightly job" — and no nightly job called them,
 * because none existed. `rate_limit_hits` gains a row for every rate-limited
 * request (every API call, every WPS download, all fourteen mutating server
 * actions) and the limiter's own hot-path check is a `COUNT(*)` over that same
 * table, so the cost of the guard on every write grew without bound. `sessions`
 * likewise never shed an expired row, and an expired session is not evidence.
 *
 * Tenant-agnostic: both tables are global, so unlike every other job here this
 * one does not sweep tenants and does not need the owner bootstrap read.
 *
 * Zero deleted rows IS a success here, unlike the snapshot sweep — a database
 * with nothing old enough to prune is the steady state once this runs daily.
 */
async function maintenance(): Promise<Record<string, number>> {
  const { pruneRateLimits } = await import("@/lib/rate-limit");
  const { pruneExpiredSessions } = await import("@/lib/session");
  return {
    rateLimitHitsPruned: await pruneRateLimits(),
    expiredSessionsPruned: await pruneExpiredSessions(),
  };
}
