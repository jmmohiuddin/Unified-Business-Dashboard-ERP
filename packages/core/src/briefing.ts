import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { runMetric, type MetricContext } from "./metrics/index.ts";
import { formatMoneyCompact } from "./format.ts";

/**
 * THE DAILY EXECUTIVE BRIEFING.
 *
 * Ranked #2 in the strategy doc for value-per-effort: it costs the owner zero
 * clicks, arrives before the day starts, and creates the habit that makes every
 * other feature worth having. Crucially it is composed from the SAME metric
 * layer the dashboard uses, so the briefing and the screen can never disagree.
 *
 * It is deliberately deterministic prose assembled from real numbers, not an
 * LLM freewrite. When an API key is present the assistant can rephrase it, but
 * the FACTS come from here — a briefing that invents a figure is worse than no
 * briefing, and this way every sentence traces to a metric id.
 */

export interface Briefing {
  headline: string;
  lines: string[];
  metrics: { id: string; value: number; label: string }[];
  severity: "info" | "warning" | "critical";
}

export async function composeBriefing(ctx: MetricContext): Promise<Briefing> {
  const safe = async (id: string, params: Record<string, unknown> = {}) => {
    try {
      return await runMetric(ctx, id, params, "all");
    } catch {
      return null;
    }
  };

  const [revenue, profit, cash, overdue, cheques, jobs, health, forecast] = await Promise.all([
    safe("revenue_mtd"),
    safe("net_profit_mtd"),
    safe("cash_balance"),
    safe("overdue_debt"),
    safe("cheque_pipeline"),
    safe("open_service_requests"),
    safe("business_health_score"),
    safe("cash_flow_forecast"),
  ]);

  const ccy = ctx.baseCurrency;
  const lines: string[] = [];
  const metrics: Briefing["metrics"] = [];
  let severity: Briefing["severity"] = "info";

  if (revenue) {
    const dir = (revenue.changeRatio ?? 0) >= 0 ? "up" : "down";
    lines.push(
      `Revenue this month is ${formatMoneyCompact(revenue.value, ccy)}, ${dir} ` +
        `${Math.abs((revenue.changeRatio ?? 0) * 100).toFixed(0)}% on the same days last month.`,
    );
    metrics.push({ id: "revenue_mtd", value: revenue.value, label: "Revenue MTD" });
  }

  if (cash) {
    lines.push(`Cash and bank stand at ${formatMoneyCompact(cash.value, ccy)}.`);
    metrics.push({ id: "cash_balance", value: cash.value, label: "Cash" });
    if (forecast && forecast.value < cash.value * 0.5) {
      severity = "warning";
      lines.push(
        `Projected cash in 30 days is ${formatMoneyCompact(forecast.value, ccy)} — worth watching.`,
      );
    }
  }

  if (overdue && overdue.value > 0) {
    severity = overdue.value > (cash?.value ?? 0) * 0.2 ? "critical" : "warning";
    lines.push(
      `${formatMoneyCompact(overdue.value, ccy)} is overdue from customers — the fastest cash to chase today.`,
    );
    metrics.push({ id: "overdue_debt", value: overdue.value, label: "Overdue" });
  }

  const dueChq = cheques?.breakdown?.find((b) => b.key === "due_now");
  if (dueChq && Number(dueChq.meta?.count ?? 0) > 0) {
    lines.push(
      `${dueChq.meta?.count} cheques worth ${formatMoneyCompact(dueChq.value, ccy)} are ready to bank.`,
    );
  }
  const bounced = cheques?.breakdown?.find((b) => b.key === "bounced");
  if (bounced && Number(bounced.meta?.count ?? 0) > 0) {
    severity = "warning";
    lines.push(`${bounced.meta?.count} bounced cheques need a replacement chased.`);
  }

  if (jobs) {
    const breached = jobs.breakdown?.find((b) => b.key === "sla_breached")?.value ?? 0;
    if (breached > 0) {
      severity = severity === "critical" ? "critical" : "warning";
      lines.push(`${breached} service jobs have breached their SLA — the leading cause of bad reviews.`);
    }
  }

  if (profit) {
    metrics.push({ id: "net_profit_mtd", value: profit.value, label: "Net profit MTD" });
  }

  const score = health ? Math.round(health.value) : null;
  const headline =
    score === null
      ? "Your daily briefing"
      : score >= 70
        ? `Healthy day — business health ${score}/100`
        : score >= 45
          ? `Steady, with things to watch — health ${score}/100`
          : `Needs attention — business health ${score}/100`;

  if (lines.length === 0) lines.push("A quiet start — nothing urgent flagged this morning.");

  return { headline, lines, metrics, severity };
}

/**
 * Persist the briefing as an AI insight so it appears in the feed and is
 * dismissible. Idempotent per day via the deterministic id embedded in
 * `evidence`, so re-running the job does not stack duplicates.
 */
export async function persistBriefing(
  tx: Tx,
  tenantId: string,
  today: string,
  briefing: Briefing,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ai_insights
      (id, tenant_id, kind, severity, status, title, body, recommended_action,
       action_url, evidence, valid_until, model_id)
    SELECT gen_random_uuid(), ${tenantId}::uuid, 'daily_briefing',
           ${briefing.severity}::insight_severity, 'new',
           ${briefing.headline}, ${briefing.lines.join("\n")},
           'Open the dashboard for the full picture.', '/',
           ${JSON.stringify({ date: today, metrics: briefing.metrics })}::jsonb,
           ${today}::date, 'composed'
     WHERE NOT EXISTS (
       SELECT 1 FROM ai_insights
        WHERE tenant_id = ${tenantId}::uuid AND kind = 'daily_briefing'
          AND evidence->>'date' = ${today}
     )
  `);
}
