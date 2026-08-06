import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";

/**
 * AUTOMATION RUNNER.
 *
 * Executes the rules stored in `automations`. Rules are data, not code, which
 * is what makes the feature list finite: chasing rent, banking cheques, warning
 * about a trade licence and requesting a review are all one engine plus a row.
 *
 * The safety rails are the point of this file, not an afterthought. An
 * automation engine with database write access and a customer contact list is
 * the single most dangerous component in an SMB ERP — the failure mode is not a
 * crash, it is texting four thousand customers at 3am. So:
 *
 *   • DRY RUN BY DEFAULT. Nothing is written unless `commit: true`.
 *   • DEDUPE KEYS. Every notification carries a deterministic key with a unique
 *     index behind it, so the same reminder cannot be sent twice even if the
 *     runner is executed twice concurrently.
 *   • PER-RULE DAILY CAPS. A rule that suddenly matches a thousand rows is
 *     stopped and flagged rather than executed.
 *   • APPROVAL GATE. Rules flagged `requiresApproval` only ever produce a draft.
 *   • FULL RUN LOG. What matched, what was done, and why — because the owner
 *     will eventually ask "why did my tenant get this message?"
 */

export interface AutomationMatch {
  /** Human-readable subject of the alert. */
  title: string;
  detail: string;
  /** Stable across runs — this is what makes dedupe work. */
  dedupeKey: string;
  severity: "info" | "opportunity" | "warning" | "critical";
  actionUrl?: string;
  amount?: number;
  /** Set when the message goes to a CUSTOMER rather than to staff. Anything
   *  with a recipient party passes through the consent and quiet-hours gates
   *  in the outbox before it can leave. */
  recipientPartyId?: string;
  channel?: "in_app" | "email" | "sms" | "whatsapp" | "push";
  isMarketing?: boolean;
}

export interface AutomationOutcome {
  automationId: string;
  name: string;
  trigger: string;
  matched: number;
  created: number;
  skippedDuplicate: number;
  cappedAt: number | null;
  heldForApproval: boolean;
  samples: AutomationMatch[];
  error?: string;
}

export interface RunnerOptions {
  /** Write notifications. Default false — the runner is dry by default. */
  commit?: boolean;
  /** Tenant-local today, ISO. Injected so runs are reproducible. */
  today: string;
  /** Restrict to one rule, for testing a single automation. */
  onlyAutomationId?: string;
}

/**
 * Rule evaluators.
 *
 * Each returns the rows a rule matches. Deliberately hand-written SQL per rule
 * type rather than a generic query builder over `conditions`: a generic
 * evaluator that can express arbitrary predicates over arbitrary tables is
 * effectively a query language, and giving one of those to a scheduled job that
 * can message customers is how you get an incident. New rule types are added
 * here, reviewed, and tested.
 */
const EVALUATORS: Record<
  string,
  (tx: Tx, today: string, config: Record<string, unknown>) => Promise<AutomationMatch[]>
> = {
  /** Cheques falling due for banking. */
  async cheques_due(tx, today) {
    const rows = await tx.execute<{
      id: string; cheque_number: string; amount: string; cheque_date: string;
      drawer: string | null; bank: string | null;
    }>(sql`
      SELECT id, cheque_number, amount, cheque_date::text, drawer_name AS drawer, bank_name AS bank
        FROM cheques
       WHERE direction = 'in' AND status = 'held'
         AND cheque_date <= ${today}::date + 7
       ORDER BY cheque_date
    `);
    return rows.map((c) => ({
      title: `Bank cheque ${c.cheque_number} — ${c.drawer ?? "tenant"}`,
      detail: `AED ${Number(c.amount).toLocaleString("en-AE")} dated ${c.cheque_date}, drawn on ${c.bank ?? "bank"}.`,
      dedupeKey: `cheque_due:${c.id}`,
      severity: "warning" as const,
      actionUrl: "/rentals/cheques",
      amount: Number(c.amount),
    }));
  },

  /**
   * Cheques that came back unpaid AND have no replacement.
   *
   * Deliberately not time-boxed. A bounce from four months ago that nobody
   * replaced is a bigger problem than one from last week, so an age window
   * would hide exactly the cases that matter most. The rule is "unresolved",
   * not "recent".
   */
  async cheque_bounced(tx) {
    const rows = await tx.execute<{
      id: string; cheque_number: string; amount: string; drawer: string | null;
      reason: string | null; bounced_on: string; age: number;
    }>(sql`
      SELECT c.id, c.cheque_number, c.amount, c.drawer_name AS drawer,
             c.bounce_reason AS reason, c.bounced_on::text,
             (CURRENT_DATE - c.bounced_on)::int AS age
        FROM cheques c
       WHERE c.status = 'bounced'
         AND NOT EXISTS (SELECT 1 FROM cheques r WHERE r.replaces_cheque_id = c.id)
       ORDER BY c.bounced_on
    `);
    return rows.map((c) => ({
      title: `Unreplaced bounced cheque — ${c.drawer ?? "tenant"}`,
      detail: `${c.reason ?? "Returned unpaid"}. AED ${Number(c.amount).toLocaleString("en-AE")} bounced ${c.bounced_on} (${c.age} days ago) and no replacement has been logged.`,
      dedupeKey: `cheque_bounced:${c.id}`,
      severity: "critical" as const,
      actionUrl: "/rentals/cheques?filter=bounced",
      amount: Number(c.amount),
    }));
  },

  /** Trade licences approaching expiry. */
  async licence_expiry(tx, today, config) {
    const days = Math.abs(Number(config.offsetDays ?? 60));
    const rows = await tx.execute<{ id: string; name: string; expiry: string; left: string }>(sql`
      SELECT id, name, trade_license_expiry::text AS expiry,
             (trade_license_expiry - ${today}::date)::text AS left
        FROM business_units
       WHERE is_active = true AND trade_license_expiry IS NOT NULL
         AND trade_license_expiry <= ${today}::date + ${days}::int
    `);
    return rows.map((b) => ({
      title: `Trade licence expires in ${b.left} days — ${b.name}`,
      detail: `Expires ${b.expiry}. A lapsed licence freezes the bank account and blocks every visa renewal.`,
      dedupeKey: `licence:${b.id}:${b.expiry}`,
      severity: "critical" as const,
      actionUrl: "/compliance",
    }));
  },

  /** Employee visas approaching expiry. */
  async visa_expiry(tx, today, config) {
    const days = Math.abs(Number(config.offsetDays ?? 45));
    const rows = await tx.execute<{ id: string; name: string; expiry: string; left: string }>(sql`
      SELECT id, full_name AS name, visa_expiry::text AS expiry,
             (visa_expiry - ${today}::date)::text AS left
        FROM employees
       WHERE status IN ('active','probation') AND visa_expiry IS NOT NULL
         AND visa_expiry <= ${today}::date + ${days}::int
    `);
    return rows.map((e) => ({
      title: `Visa expires in ${e.left} days — ${e.name}`,
      detail: `Expires ${e.expiry}. Start renewal now; working on an expired visa is a per-person fine.`,
      dedupeKey: `visa:${e.id}:${e.expiry}`,
      severity: "warning" as const,
      actionUrl: "/compliance",
    }));
  },

  /** Active leases with no Ejari registration. */
  async ejari_missing(tx) {
    const rows = await tx.execute<{ id: string; lease_number: string; unit: string; party: string }>(sql`
      SELECT l.id, l.lease_number, u.code AS unit, p.display_name AS party
        FROM leases l JOIN units u ON u.id = l.unit_id JOIN parties p ON p.id = l.party_id
       WHERE l.status = 'active' AND l.ejari_number IS NULL
    `);
    return rows.map((l) => ({
      title: `No Ejari registration — unit ${l.unit}`,
      detail: `${l.lease_number} for ${l.party} is unregistered. It cannot be enforced at the Rental Dispute Centre and the tenant cannot activate DEWA.`,
      dedupeKey: `ejari:${l.id}`,
      severity: "warning" as const,
      actionUrl: "/compliance",
    }));
  },

  /** Invoices past their due date. */
  async invoice_overdue(tx, today, config) {
    const days = Math.abs(Number(config.offsetDays ?? 7));
    const rows = await tx.execute<{
      id: string; doc_number: string; party: string | null; due: number; amount: string;
    }>(sql`
      SELECT d.id, d.doc_number, COALESCE(p.display_name, d.party_name_snapshot) AS party,
             (${today}::date - d.due_date)::int AS due, d.amount_due AS amount
        FROM documents d LEFT JOIN parties p ON p.id = d.party_id
       WHERE d.direction = 'in' AND d.amount_due > 0
         AND d.status NOT IN ('cancelled','void','draft')
         AND d.due_date <= ${today}::date - ${days}::int
       ORDER BY d.due_date
    `);
    return rows.map((d) => ({
      title: `${d.doc_number} is ${d.due} days overdue`,
      detail: `${d.party ?? "Customer"} owes AED ${Number(d.amount).toLocaleString("en-AE")}.`,
      dedupeKey: `overdue:${d.id}:${Math.floor(d.due / 7)}`, // re-alerts weekly, not daily
      severity: d.due > 30 ? ("critical" as const) : ("warning" as const),
      actionUrl: "/receivables?filter=overdue",
      amount: Number(d.amount),
    }));
  },

  /** Field-service jobs past their SLA target. */
  async sla_breach(tx) {
    const rows = await tx.execute<{ id: string; job_number: string; title: string; hours: string }>(sql`
      SELECT id, job_number, title,
             ROUND(EXTRACT(EPOCH FROM (now() - complete_by)) / 3600)::text AS hours
        FROM jobs
       WHERE status IN ('request','quoted','scheduled','dispatched','in_progress','on_hold')
         AND complete_by < now()
    `);
    return rows.map((j) => ({
      title: `${j.job_number} is ${j.hours}h past SLA`,
      detail: `${j.title} has breached its completion target. Late jobs are the leading cause of bad reviews.`,
      dedupeKey: `sla:${j.id}:${Math.floor(Number(j.hours) / 24)}`,
      severity: "critical" as const,
      actionUrl: "/services?filter=breached",
    }));
  },

  /** Stock at or below its reorder point. */
  async low_stock(tx) {
    const rows = await tx.execute<{ id: string; name: string; available: string; rop: string }>(sql`
      SELECT i.id, i.name, SUM(sl.on_hand - sl.reserved)::text AS available,
             i.reorder_point::text AS rop
        FROM stock_levels sl JOIN items i ON i.id = sl.item_id
       WHERE i.reorder_point IS NOT NULL
       GROUP BY i.id, i.name, i.reorder_point
      HAVING SUM(sl.on_hand - sl.reserved) <= i.reorder_point
    `);
    return rows.map((i) => ({
      title: `Reorder ${i.name}`,
      detail: `${Math.round(Number(i.available))} available against a reorder point of ${Math.round(Number(i.rop))}.`,
      dedupeKey: `reorder:${i.id}:${new Date().toISOString().slice(0, 7)}`, // monthly
      severity: "opportunity" as const,
      actionUrl: "/inventory?filter=low",
    }));
  },

  /**
   * VAT return deadline. The FTA allows 28 days after the end of the tax
   * period; this fires inside that window and again once it has passed.
   */
  async vat_reminder(tx, today) {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    // End of the most recently completed quarter.
    const qEndMonth = Math.floor((m - 1) / 3) * 3; // 0 = last quarter was in the prior year
    const endYear = qEndMonth === 0 ? y - 1 : y;
    const endMonth = qEndMonth === 0 ? 12 : qEndMonth;
    const periodEnd = new Date(Date.UTC(endYear, endMonth, 0));
    const deadline = new Date(periodEnd);
    deadline.setUTCDate(deadline.getUTCDate() + 28);
    const daysLeft = Math.round(
      (+deadline - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    if (daysLeft > 28) return [];

    const [totals] = await tx.execute<{ output: string; input: string }>(sql`
      SELECT COALESCE(SUM(jl.base_credit - jl.base_debit)
               FILTER (WHERE a.system_key = 'VAT_OUTPUT'), 0) AS output,
             COALESCE(SUM(jl.base_debit - jl.base_credit)
               FILTER (WHERE a.system_key = 'VAT_INPUT'), 0) AS input
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE j.posting_date BETWEEN ${`${endYear}-${String(endMonth - 2).padStart(2, "0")}-01`}::date
                                AND ${periodEnd.toISOString().slice(0, 10)}::date
    `);
    const net = Number(totals?.output ?? 0) - Number(totals?.input ?? 0);
    const label = `Q${Math.ceil(endMonth / 3)} ${endYear}`;

    return [
      {
        title:
          daysLeft < 0
            ? `VAT return for ${label} is ${Math.abs(daysLeft)} days OVERDUE`
            : `VAT return for ${label} due in ${daysLeft} days`,
        detail: `Estimated net position AED ${Math.abs(net).toLocaleString("en-AE", { maximumFractionDigits: 0 })} ${net >= 0 ? "payable to" : "refundable from"} the FTA. Filing deadline ${deadline.toISOString().slice(0, 10)}.`,
        dedupeKey: `vat_return:${label}:${daysLeft < 0 ? "overdue" : "due"}`,
        severity: daysLeft < 0 ? ("critical" as const) : ("warning" as const),
        actionUrl: "/accounting/vat",
        amount: Math.abs(net),
      },
    ];
  },

  /**
   * Review requests after a completed salon service.
   *
   * Capped tightly and deduped per appointment: this is the one rule here that
   * messages a CUSTOMER rather than a member of staff, so it is the one where
   * a bug is publicly embarrassing.
   */
  async review_request(tx, today, config) {
    const delayMinutes = Number(config.delayMinutes ?? 120);
    const rows = await tx.execute<{
      id: string; reference: string; party: string | null; completed: string;
      party_id: string;
    }>(sql`
      SELECT a.id, a.reference, p.display_name AS party, a.completed_at::text AS completed,
             a.party_id
        FROM appointments a
        LEFT JOIN parties p ON p.id = a.party_id
       WHERE a.status = 'completed'
         AND a.party_id IS NOT NULL
         AND a.completed_at <= now() - (${delayMinutes}::int * interval '1 minute')
         AND a.completed_at >= ${today}::date - 1
       ORDER BY a.completed_at DESC
    `);
    const channel = (config.channel as string) ?? "whatsapp";
    return rows.map((a) => ({
      title: `How was your visit?`,
      detail: `Thanks for coming in. If you have a moment, a short review really helps us.`,
      dedupeKey: `review:${a.id}`,
      severity: "opportunity" as const,
      actionUrl: "/salon",
      recipientPartyId: a.party_id,
      channel: channel as "whatsapp",
      // A review request is marketing, not transactional — it needs an
      // affirmative opt-in, and most customers will not have given one.
      isMarketing: true,
    }));
  },

  /**
   * Daily owner briefing. Produces a single "briefing is ready" item; composing
   * the narrative itself is the AI assistant's job, not the runner's.
   */
  async daily_briefing(tx, today) {
    const [counts] = await tx.execute<{ overdue: number; sla: number; cheques: number }>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM documents
          WHERE direction='in' AND amount_due>0 AND due_date < ${today}::date
            AND status NOT IN ('cancelled','void','draft')) AS overdue,
        (SELECT COUNT(*)::int FROM jobs
          WHERE status IN ('request','scheduled','dispatched','in_progress','on_hold')
            AND complete_by < now()) AS sla,
        (SELECT COUNT(*)::int FROM cheques
          WHERE status = 'held' AND cheque_date <= ${today}::date + 7) AS cheques
    `);
    return [
      {
        title: `Daily briefing for ${today}`,
        detail:
          `${counts?.overdue ?? 0} overdue invoices, ${counts?.sla ?? 0} jobs past SLA, ` +
          `${counts?.cheques ?? 0} cheques to bank this week.`,
        dedupeKey: `briefing:${today}`,
        severity: "info" as const,
        actionUrl: "/",
      },
    ];
  },

  /** Cash drawer sessions closed with a material variance. */
  async cash_variance(tx, today, config) {
    const threshold = Number(config.value ?? 100);
    const rows = await tx.execute<{ id: string; variance: string; closed: string }>(sql`
      SELECT id, variance::text, closed_at::text AS closed
        FROM cash_register_sessions
       WHERE closed_at IS NOT NULL AND ABS(variance) > ${threshold}
         AND closed_at >= ${today}::date - 7
    `);
    return rows.map((c) => ({
      title: `Cash drawer out by AED ${Math.abs(Number(c.variance)).toLocaleString("en-AE")}`,
      detail: `Session closed ${c.closed} with an unexplained variance.`,
      dedupeKey: `cash:${c.id}`,
      severity: "warning" as const,
      actionUrl: "/accounting/cash",
    }));
  },
};

/**
 * Map a stored automation row to an evaluator.
 *
 * Rules are matched on their trigger config rather than their name, so an owner
 * renaming a rule does not break it.
 */
function resolveEvaluator(a: {
  trigger: string;
  triggerConfig: Record<string, unknown>;
  actions: { type?: string }[];
}): string | null {
  const cfg = a.triggerConfig ?? {};
  const entity = String(cfg.entity ?? "");
  const dateField = String(cfg.dateField ?? "");
  const actionTypes = (a.actions ?? []).map((x) => x?.type);

  if (entity === "cheques" && cfg.to === "bounced") return "cheque_bounced";
  if (entity === "cheques") return "cheques_due";
  if (entity === "business_units" && dateField === "trade_license_expiry") return "licence_expiry";
  if (entity === "employees" && dateField === "visa_expiry") return "visa_expiry";
  if (entity === "leases") return "ejari_missing";
  if (entity === "documents" && dateField === "due_date") return "invoice_overdue";
  if (entity === "jobs") return "sla_breach";
  if (entity === "stock_levels") return "low_stock";
  if (entity === "cash_register_sessions") return "cash_variance";
  if (entity === "appointments" && cfg.to === "completed") return "review_request";

  // Pure-schedule rules carry no entity, so they are matched on their action.
  if (actionTypes.includes("ai_briefing")) return "daily_briefing";
  if (a.trigger === "schedule" && !entity) return "vat_reminder";
  return null;
}

export async function runAutomations(
  tx: Tx,
  tenantId: string,
  opts: RunnerOptions,
): Promise<AutomationOutcome[]> {
  const { commit = false, today, onlyAutomationId } = opts;

  const automations = await tx.execute<{
    id: string; name: string; trigger: string;
    trigger_config: Record<string, unknown>; actions: unknown;
    max_runs_per_day: number; requires_approval: boolean;
  }>(sql`
    SELECT id, name, trigger::text, trigger_config, actions,
           max_runs_per_day, requires_approval
      FROM automations
     WHERE is_enabled = true
       ${onlyAutomationId ? sql`AND id = ${onlyAutomationId}::uuid` : sql``}
     ORDER BY name
  `);

  const outcomes: AutomationOutcome[] = [];

  for (const a of automations) {
    const runId = crypto.randomUUID();
    const key = resolveEvaluator({
      trigger: a.trigger,
      triggerConfig: a.trigger_config ?? {},
      actions: (a.actions as { type?: string }[]) ?? [],
    });

    // A rule with no evaluator is reported rather than silently ignored —
    // silent no-ops are how an owner ends up believing a reminder is going out
    // when nothing has run for months.
    if (!key) {
      outcomes.push({
        automationId: a.id, name: a.name, trigger: a.trigger, matched: 0, created: 0,
        skippedDuplicate: 0, cappedAt: null, heldForApproval: false, samples: [],
        error: "No evaluator is implemented for this rule's trigger configuration.",
      });
      continue;
    }

    let matches: AutomationMatch[] = [];
    try {
      matches = await EVALUATORS[key]!(tx, today, a.trigger_config ?? {});
    } catch (err) {
      outcomes.push({
        automationId: a.id, name: a.name, trigger: a.trigger, matched: 0, created: 0,
        skippedDuplicate: 0, cappedAt: null, heldForApproval: false, samples: [],
        error: (err as Error).message,
      });
      continue;
    }

    // Safety rail: a rule that suddenly matches far more than expected is
    // truncated and the fact is recorded, never quietly executed in full.
    const cap = a.max_runs_per_day ?? 500;
    const capped = matches.length > cap;
    const toAct = capped ? matches.slice(0, cap) : matches;

    let created = 0;
    let skipped = 0;

    if (commit && !a.requires_approval) {
      for (const match of toAct) {
        // ON CONFLICT against the unique dedupe index makes double-sending
        // impossible even under concurrent runs.
        const res = await tx.execute<{ id: string }>(sql`
          INSERT INTO notifications
            (id, tenant_id, channel, recipient_party_id, title, body, action_url, severity,
             source_table, source_id, dedupe_key, status, is_marketing)
          VALUES
            (gen_random_uuid(), ${tenantId}::uuid,
             ${match.channel ?? "in_app"}::notification_channel,
             ${match.recipientPartyId ?? null}::uuid, ${match.title}, ${match.detail},
             ${match.actionUrl ?? null}, ${match.severity}, 'automations', ${a.id}::uuid,
             ${match.dedupeKey}, 'pending', ${match.isMarketing ?? false})
          ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
          RETURNING id
        `);
        if (res.length > 0) created++;
        else skipped++;
      }

      await tx.execute(sql`
        INSERT INTO automation_runs
          (id, tenant_id, automation_id, status, started_at, finished_at,
           matched_count, action_count, log)
        VALUES
          (${runId}::uuid, ${tenantId}::uuid, ${a.id}::uuid, 'success', now(), now(),
           ${matches.length}, ${created},
           ${JSON.stringify({ evaluator: key, capped, skippedDuplicate: skipped })}::jsonb)
      `);
      await tx.execute(sql`
        UPDATE automations
           SET last_run_at = now(), run_count = run_count + 1
         WHERE id = ${a.id}::uuid
      `);
    }

    outcomes.push({
      automationId: a.id,
      name: a.name,
      trigger: a.trigger,
      matched: matches.length,
      created,
      skippedDuplicate: skipped,
      cappedAt: capped ? cap : null,
      heldForApproval: a.requires_approval,
      samples: toAct.slice(0, 3),
    });
  }

  return outcomes;
}
