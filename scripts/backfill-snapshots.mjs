/**
 * KPI SNAPSHOT BACKFILL — FR-V03, third acceptance criterion.
 *
 *   npx tsx scripts/backfill-snapshots.mjs [--days 90] [--to 2026-08-20] [--dry]
 *
 * The nightly sweep writes one row per metric per day going forward. That is
 * correct and useless on day one: a trend needs history, and history that
 * starts tonight is history nobody can see until next month. This walks the
 * ledger backwards and files the rows the sweep would have written had it
 * been running.
 *
 * ── WHY THIS IS NOT "RUN EVERY METRIC FOR EVERY PAST DAY" ────────────────
 *
 * The obvious script — sweep the whole registry at each past date — produces a
 * chart that is worse than no chart. Most metrics answer a question about the
 * CURRENT state of a row, not about history: `cash_balance` sums every journal
 * line on the cash accounts with no date bound, `occupancy_rate` counts
 * `units.status = 'occupied'` as it stands right now, `accounts_receivable`
 * reads `amount_due`, which the last payment overwrote. Ask any of them for
 * "1 March" and they answer with today's number, cheerfully and fast. Eighty
 * of those in a row is a dead-flat line that says the business did not move,
 * filed under dates it never described.
 *
 * A metric is backfillable only if its query is bounded by `ctx.today` against
 * an append-only column — `documents.issue_date`, `journals.posting_date`. The
 * allow-list below names each one and why, and nothing outside it is written
 * without `--all`, which prints a warning first. Fabricating history is worse
 * than having none: nobody audits a chart, and a flat line is a claim.
 *
 * The right long-term home for this is a `reconstructible` flag on
 * `MetricDefinition`, declared by each metric next to its query rather than
 * inferred by a script that has to be kept in step by hand. That means editing
 * `metrics/registry.ts`, which this wave has other work in.
 *
 * ── IDEMPOTENCE ──────────────────────────────────────────────────────────
 *
 * DELETE-then-INSERT per (date, key), exactly as the cron writer does, and for
 * the same schema reason: `kpi_snapshots_uq` is UNIQUE over a NULLABLE
 * `business_unit_id`, Postgres treats NULLs there as distinct, so `ON CONFLICT
 * DO NOTHING` never fires and a second run would silently double every row.
 * Re-running this script over the same window is safe.
 *
 * It writes only `business_unit_id IS NULL` rows, matching the sweep. The
 * seed's per-business `revenue` and `gross_profit` rows use keys that are not
 * metric ids, so the two sets never collide.
 */

import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { METRICS_BY_ID, Money, runMetric } from "@nexus/core";

// Root .env, the same one the seed, the worker and next.config.ts read. Run
// from the repository root; production injects real variables and these are
// no-ops there.
config({ path: ".env", quiet: true });
config({ path: ".env.example", quiet: true });

/**
 * Metrics whose value at a past date is reconstructible from the ledger.
 *
 * Each entry states the append-only column the metric's window is bounded by.
 * If you add one, read its `run()` first and check that EVERY table it touches
 * is filtered by a date — one unfiltered join is enough to make the whole
 * series today's number wearing eighty different dates.
 */
const BACKFILLABLE = {
  revenue_today: "documents.issue_date = today",
  revenue_mtd: "documents.issue_date between month start and today",
  revenue_trend: "documents.issue_date over a trailing window",
  net_profit_mtd: "journals.posting_date between month start and today",
  business_performance: "documents.issue_date between month start and today",
  staff_performance: "documents.issue_date between month start and today",
  channel_performance: "documents.issue_date between month start and today",
};

/**
 * Metrics deliberately excluded, and why. Kept as data rather than as a
 * comment so `--explain` can print it and the next person does not have to
 * re-derive the reasoning from the SQL.
 */
const NOT_BACKFILLABLE = {
  cash_balance: "sums all journal lines on cash accounts with no date bound",
  accounts_receivable: "reads documents.amount_due, which payments overwrite",
  accounts_payable: "reads documents.amount_due, which payments overwrite",
  overdue_debt: "reads documents.amount_due, which payments overwrite",
  upcoming_installments: "reads installments.status as it stands now",
  cash_flow_forecast: "forecast from current balances — has no past value",
  occupancy_rate: "counts units.status now; historical occupancy needs the lease table",
  inventory_value: "current stock valuation",
  low_stock_items: "current stock levels",
  customers_total: "counts every party that exists now",
  churn_risk_customers: "derived from current RFM columns",
  open_service_requests: "current job status",
  appointments_today: "appointment status is mutated in place",
  cheque_pipeline: "cheque status is mutated in place",
  business_health_score: "part ledger, part current receivables — mixed",
  compliance_watchlist: "expiry dates as recorded now",
  gratuity_liability: "accrued to today from current employment records",
  corporate_tax_estimate: "assessed for the current period",
  vat_return_position: "assessed for the current period",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const DAYS = Number(arg("days", "90"));
const DRY = has("dry");
const ALL = has("all");

/** Tenant-local calendar date, matching `tenantToday` in apps/web/src/lib/data.ts. */
function todayIn(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Serialise for `numeric(18,4)` through the money serialiser, as the cron
 *  writer does — interpolating a raw JS number can emit `1e-7` and fail the
 *  whole insert on a parse error. */
function storable(value) {
  return Money.toDb(Money.money(Number.isFinite(value) ? value : 0));
}

async function main() {
  if (has("explain")) {
    console.log("Backfillable:");
    for (const [k, why] of Object.entries(BACKFILLABLE)) console.log(`  ✓ ${k} — ${why}`);
    console.log("\nExcluded (would fabricate a flat line):");
    for (const [k, why] of Object.entries(NOT_BACKFILLABLE)) console.log(`  ✗ ${k} — ${why}`);
    return;
  }

  const keys = ALL ? Object.keys(METRICS_BY_ID) : Object.keys(BACKFILLABLE);
  if (ALL) {
    console.warn(
      "! --all writes every metric at every past date. Metrics that read current\n" +
        "  state will store today's number under every date. Use --explain to see\n" +
        "  which ones, and do not do this to a database anybody reads.\n",
    );
  }
  const unknown = keys.filter((k) => !METRICS_BY_ID[k]);
  if (unknown.length) {
    console.error(`✗ Not metric ids: ${unknown.join(", ")}`);
    process.exit(1);
  }

  const tenants = await adminDb().execute(sql`
    SELECT id, base_currency, timezone FROM tenants WHERE deleted_at IS NULL
  `);

  let written = 0;
  let skipped = 0;

  for (const t of tenants) {
    // Default upper bound is the last COMPLETED day, matching the sweep: a row
    // filed under a date must describe the state at the END of that date, or
    // two rows from two days are not comparable.
    const to = arg("to", shiftDays(todayIn(t.timezone), -1));
    const from = shiftDays(to, -(DAYS - 1));
    console.log(
      `\n${t.id} · ${from} → ${to} · ${keys.length} metric${keys.length === 1 ? "" : "s"}` +
        (DRY ? " · DRY RUN" : ""),
    );

    for (let d = from; d <= to; d = shiftDays(d, 1)) {
      /**
       * One transaction per DAY, not per metric.
       *
       * Every metric filed under one date then sees the same MVCC snapshot, so
       * the figures for that day are mutually consistent — the same reason the
       * nightly sweep wraps a whole tenant in one transaction. A backfill that
       * committed per metric could file a revenue figure from before a
       * concurrent posting and a profit figure from after it.
       */
      const results = [];
      await withTenant({ tenantId: t.id }, async (tx) => {
        const ctx = {
          tx,
          tenantId: t.id,
          today: d,
          baseCurrency: t.base_currency,
          allowedBusinessUnitIds: null,
        };
        for (const key of keys) {
          try {
            // "all" permissions: this is a system process with no principal,
            // and RLS still confines it to the one tenant. Every READER must
            // re-check the metric's permission — see `visibleKeys` in
            // packages/core/src/metrics/snapshots.ts.
            results.push({ key, result: await runMetric(ctx, key, {}, "all") });
          } catch (err) {
            skipped++;
            console.warn(`  ! ${d} ${key}: ${err instanceof Error ? err.message : err}`);
          }
        }

        if (DRY || results.length === 0) return;

        const keyList = sql.join(
          results.map((r) => sql`${r.key}`),
          sql`, `,
        );
        await tx.execute(sql`
          DELETE FROM kpi_snapshots
           WHERE on_date = ${d}::date
             AND business_unit_id IS NULL
             AND metric_key IN (${keyList})
        `);
        const values = sql.join(
          results.map(
            (r) => sql`(
              gen_random_uuid(), ${t.id}::uuid, NULL, ${d}::date, ${r.key},
              ${storable(r.result.value)}::numeric,
              ${r.result.priorValue == null ? null : storable(r.result.priorValue)}::numeric,
              ${JSON.stringify(r.result.breakdown ?? [])}::jsonb,
              now()
            )`,
          ),
          sql`, `,
        );
        const rows = await tx.execute(sql`
          INSERT INTO kpi_snapshots
            (id, tenant_id, business_unit_id, on_date, metric_key, value, prior_value,
             breakdown, computed_at)
          VALUES ${values}
          RETURNING 1 AS one
        `);
        written += rows.length;
      });

      if (DRY) written += results.length;
    }
  }

  console.log(
    `\n${DRY ? "Would write" : "Wrote"} ${written} rows` +
      (skipped ? `, skipped ${skipped} metric-days that errored` : ""),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
