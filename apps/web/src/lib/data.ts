import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { loadInbox, runMetrics, type MetricContext, type MetricResult } from "@nexus/core";
import type { SessionUser } from "./session.ts";

/**
 * "Today" is the tenant's today, not the server's.
 *
 * A shop in Dubai closing at 22:00 must not have its takings roll into
 * tomorrow because the server is on UTC. Every metric receives this value
 * rather than reading the clock itself, which also makes the whole layer
 * testable and keeps the demo dataset reproducible.
 */
export function tenantToday(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The demo dataset is anchored to a fixed date so screenshots, docs and the
 * metric snapshot tests all agree on what "this month" means.
 */
const DEMO_TODAY_DEFAULT = "2026-08-06";

/**
 * A pinned date is honoured only if it is a real calendar date.
 *
 * The regex alone is not enough: "2026-13-45" matches the shape and would go
 * on to Postgres as `'2026-13-45'::date`, which errors at query time in a
 * request handler rather than at the point the value was configured. Round-
 * tripping through Date catches that, and catches the empty string that an
 * unset variable can arrive as — `''::date` is the same failure one step
 * further along.
 */
function isCalendarDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * Demo mode has to be asked for. It is never the default.
 *
 * This check used to read `NEXUS_DEMO_MODE === "off"`, so the *absence* of an
 * environment variable selected the frozen demo date. On a deployment where
 * nobody thought to set the flag — the normal case — every invoice, payment,
 * bill and stock count was written with a posting date of 2026-08-06, and
 * every ageing bucket, VAT period and cheque due-date computed from it was
 * fiction with nothing on screen to say so. A fail-safe that requires an
 * environment variable to be present in order to behave safely is inverted:
 * the unconfigured state must be the safe one, so the real clock wins unless
 * demo mode is explicitly requested.
 *
 * Two opt-ins, both explicit, matching how the rest of the codebase reads
 * these variables:
 *
 *   NEXUS_DEMO_MODE=true   the sign-in page's demo affordances use the same
 *                          value (apps/web/src/app/login/page.tsx), and the
 *                          boot gate treats it as fatal in production
 *                          (packages/core/src/security/config.ts).
 *   NEXUS_DEMO_TODAY=<ISO> pins the clock without the credential affordances.
 *                          CI sets only this one, which is what keeps the e2e
 *                          run deterministic against the anchored seed.
 *
 * Anything else — unset, empty, misspelt, malformed — is real time.
 */
export function demoModeActive(): boolean {
  return (
    process.env.NEXUS_DEMO_MODE === "true" || isCalendarDate(process.env.NEXUS_DEMO_TODAY ?? "")
  );
}

export function resolveToday(timezone: string): string {
  if (!demoModeActive()) return tenantToday(timezone);
  const pinned = process.env.NEXUS_DEMO_TODAY ?? "";
  return isCalendarDate(pinned) ? pinned : DEMO_TODAY_DEFAULT;
}

export interface BusinessUnitSummary {
  id: string;
  code: string;
  name: string;
  kind: string;
  colorToken: string;
  icon: string | null;
}

export const loadBusinessUnits = cache(
  async (session: SessionUser): Promise<BusinessUnitSummary[]> => {
    const allowed = session.principal.businessUnitIds;
    // An empty array interpolates to `()` and is a syntax error, so the scope
    // filter is composed rather than parameterised through a possibly-empty
    // array. A scoped user with no granted businesses correctly sees none.
    const scopeFilter =
      allowed === null
        ? sql`TRUE`
        : allowed.length === 0
          ? sql`FALSE`
          : sql`id = ANY(ARRAY[${sql.join(
              allowed.map((i) => sql`${i}::uuid`),
              sql`, `,
            )}])`;

    return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
      const rows = await tx.execute<{
        id: string; code: string; name: string; kind: string;
        color_token: string; icon: string | null;
      }>(sql`
        SELECT id, code, name, kind::text, color_token, icon
          FROM business_units
         WHERE is_active = true AND ${scopeFilter}
         ORDER BY sort_order
      `);
      return rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, kind: r.kind,
        colorToken: r.color_token, icon: r.icon,
      }));
    });
  },
);

/**
 * Load a whole dashboard in ONE transaction.
 *
 * One `SET LOCAL` + one connection + N sequential aggregates, rather than N
 * transactions. Measured at ~110 ms for the full 21-metric sweep against the
 * seeded dataset; the tiles the owner sees first are a subset of that.
 */
export async function loadMetrics(
  session: SessionUser,
  requests: { metricId: string; params?: unknown }[],
  businessUnitIds?: string[],
): Promise<Record<string, MetricResult | { error: string; code: string }>> {
  return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
    const ctx: MetricContext = {
      tx,
      tenantId: session.tenantId,
      today: resolveToday(session.timezone),
      baseCurrency: session.baseCurrency,
      allowedBusinessUnitIds: session.principal.businessUnitIds,
    };
    const scoped = businessUnitIds?.length
      ? requests.map((r) => ({
          ...r,
          params: { ...(r.params as object | undefined), businessUnitIds },
        }))
      : requests;
    return runMetrics(ctx, scoped, session.principal.permissions);
  });
}

/** Narrowing helper — a failed widget renders an error state, not a crash. */
export function metric(
  bag: Record<string, MetricResult | { error: string; code: string }>,
  id: string,
): MetricResult | null {
  const v = bag[id];
  return v && !("error" in v) ? v : null;
}

/**
 * The notification inbox for the shell bell and the /inbox page.
 *
 * `cache()`d so the bell in the layout and the page body share one query per
 * request — the layout renders the count, the page renders the list, and both
 * come from the same round trip.
 */
export const loadNotifications = cache(
  async (session: SessionUser, opts: { unreadOnly?: boolean } = {}) =>
    withTenant({ tenantId: session.tenantId, userId: session.userId }, (tx) =>
      loadInbox(tx, session.tenantId, session.principal.permissions, opts),
    ),
);

export interface ActionItem {
  id: string;
  kind: "overdue" | "sla" | "stock" | "vacancy" | "installment" | "lease";
  title: string;
  detail: string;
  amount: number | null;
  href: string;
  severity: "critical" | "warning" | "opportunity";
}

/**
 * The "what needs me today" list.
 *
 * Deliberately computed from hard operational facts rather than generated by a
 * language model. The AI is good at explaining and prioritising; it should not
 * be the thing that decides whether an invoice is overdue.
 */
export const loadActionItems = cache(async (session: SessionUser): Promise<ActionItem[]> => {
  const today = resolveToday(session.timezone);
  return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
    const [overdue, sla, vacancy, leaseExpiry, installments] = await Promise.all([
      tx.execute<{ n: string; total: string; worst: string }>(sql`
        SELECT COUNT(*)::text n, COALESCE(SUM(amount_due),0)::text total,
               COALESCE(MAX(${today}::date - due_date),0)::text worst
          FROM documents
         WHERE direction='in' AND amount_due>0 AND due_date < ${today}::date
           AND status NOT IN ('cancelled','void','draft')
      `),
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text n FROM jobs
         WHERE status IN ('request','scheduled','dispatched','in_progress','on_hold')
           AND complete_by < now()
      `),
      tx.execute<{ n: string; rent: string }>(sql`
        SELECT COUNT(*)::text n, COALESCE(SUM(list_rent),0)::text rent
          FROM units WHERE status <> 'occupied'
      `),
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text n FROM leases
         WHERE status='active' AND auto_renew = false
           AND ends_on BETWEEN ${today}::date AND ${today}::date + 60
      `),
      tx.execute<{ n: string; total: string }>(sql`
        SELECT COUNT(*)::text n, COALESCE(SUM(amount_due - amount_paid),0)::text total
          FROM installments WHERE status <> 'paid' AND due_on < ${today}::date
      `),
    ]);

    const items: ActionItem[] = [];
    const push = (
      cond: boolean,
      item: Omit<ActionItem, "id"> & { id: string },
    ) => { if (cond) items.push(item); };

    push(Number(overdue[0]?.n) > 0, {
      id: "overdue", kind: "overdue", severity: "critical",
      title: `${overdue[0]!.n} overdue invoices`,
      detail: `Oldest is ${overdue[0]!.worst} days late. Chasing these is the fastest cash you can raise.`,
      amount: Number(overdue[0]!.total), href: "/receivables",
    });
    push(Number(installments[0]?.n) > 0, {
      id: "installments", kind: "installment", severity: "warning",
      title: `${installments[0]!.n} installments missed`,
      detail: "Handsets sold on credit with payments past due. Collateral IMEIs are on file.",
      amount: Number(installments[0]!.total), href: "/receivables?filter=installments",
    });
    push(Number(sla[0]?.n) > 0, {
      id: "sla", kind: "sla", severity: "critical",
      title: `${sla[0]!.n} jobs past their SLA`,
      detail: "Late service jobs are the leading cause of bad reviews and lost repeat work.",
      amount: null, href: "/services",
    });
    push(Number(vacancy[0]?.n) > 0, {
      id: "vacancy", kind: "vacancy", severity: "opportunity",
      title: `${vacancy[0]!.n} units sitting empty`,
      detail: "Every month a unit stays vacant costs its full list rent — that money is unrecoverable.",
      amount: Number(vacancy[0]!.rent), href: "/rentals",
    });
    push(Number(leaseExpiry[0]?.n) > 0, {
      id: "lease", kind: "lease", severity: "warning",
      title: `${leaseExpiry[0]!.n} leases expire within 60 days`,
      detail: "Renewal conversations started early are far cheaper than re-letting.",
      amount: null, href: "/rentals?filter=expiring",
    });

    const rank = { critical: 0, warning: 1, opportunity: 2 };
    return items.sort(
      (a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0),
    );
  });
});
