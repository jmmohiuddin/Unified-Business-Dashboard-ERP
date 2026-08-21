import "server-only";
import { cache } from "react";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@nexus/db";
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
    // A scoped user with no granted businesses correctly sees none — see
    // `businessUnitScope`, which is the one place that decision is made.
    const scopeFilter = businessUnitScope(session.principal.businessUnitIds, "id");

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

// ── The exception feed (FR-V01) ─────────────────────────────────────────────

export type ExceptionKey = "overdue" | "installments" | "sla" | "vacancy" | "lease";

export const EXCEPTION_KEYS: readonly ExceptionKey[] = [
  "overdue",
  "installments",
  "sla",
  "vacancy",
  "lease",
];

export function isExceptionKey(v: unknown): v is ExceptionKey {
  return typeof v === "string" && (EXCEPTION_KEYS as readonly string[]).includes(v);
}

export interface ActionItem {
  id: ExceptionKey;
  kind: "overdue" | "sla" | "stock" | "vacancy" | "installment" | "lease";
  title: string;
  detail: string;
  amount: number | null;
  href: string;
  severity: "critical" | "warning" | "opportunity";
}

/**
 * The measured state of one exception, on the three axes a dismissal is judged
 * against. See `exception_dismissals` in packages/db/src/schema/platform.ts for
 * why all three exist rather than a single "is it firing" boolean.
 */
export interface ExceptionSignal {
  /** Rows behind the exception. Zero means it is not firing at all. */
  count: number;
  /** Money at stake, or null for detectors where money is not the point. */
  amount: number | null;
  /**
   * How far gone the WORST one is, in days, on whatever axis makes that
   * exception worse: days overdue, days past SLA, days into the 60-day lease
   * window. Monotone — bigger is always worse — because the dismissal
   * watermark compares against it with `>`.
   */
  depthDays: number;
}

interface ExceptionDetector {
  key: ExceptionKey;
  kind: ActionItem["kind"];
  severity: ActionItem["severity"];
  href: string;
  /** Short noun phrase for the "set aside" list, where the live numbers are
   *  deliberately not recomputed. */
  label: string;
  /**
   * The permission that governs the ROWS this detector reads — not a generic
   * `dashboard:read`.
   *
   * This is the whole fix. The five queries below read invoices, installment
   * plans, jobs, rental units and leases; each of those has a screen elsewhere
   * in the product that is gated on exactly this permission, and the exception
   * feed must not be a second, ungated route to the same facts. A barber holds
   * none of them, so a barber's feed is empty — which is AC-5 and FR-V01's
   * "the list is role-filtered" in the same clause.
   */
  permission: string;
  probe: (tx: Tx, today: string, scope: SQL) => Promise<ExceptionSignal>;
  describe: (s: ExceptionSignal) => { title: string; detail: string };
}

/**
 * Business-unit scope as a SQL predicate.
 *
 * Three cases and the middle one is the one that bites: `null` means the user
 * is tenant-scoped and sees every business; a populated list means exactly
 * those businesses; and an EMPTY list means the user is scoped to no business
 * at all, which must return nothing rather than everything. Two metrics shipped
 * with that direction inverted — the difference between a locked-down account
 * and a full data leak — so it is spelled out here rather than left to a
 * truthiness check.
 *
 * The array is composed one bound parameter at a time rather than interpolated:
 * drizzle expands a JS array into a `($1, $2)` record, which Postgres will not
 * accept as a uuid[]. `column` is never user input — every call site passes a
 * literal from the detector table below — which is what makes `sql.raw` safe
 * here and nowhere else.
 */
function businessUnitScope(allowed: string[] | null, column: string): SQL {
  if (allowed === null) return sql`TRUE`;
  if (allowed.length === 0) return sql`FALSE`;
  return sql`${sql.raw(column)} = ANY(ARRAY[${sql.join(
    allowed.map((i) => sql`${i}::uuid`),
    sql`, `,
  )}])`;
}

/** Row counts and day counts, not money. */
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const amount = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const DETECTORS: Record<ExceptionKey, ExceptionDetector> = {
  overdue: {
    key: "overdue",
    kind: "overdue",
    severity: "critical",
    href: "/receivables",
    label: "Overdue invoices",
    permission: "document:read",
    async probe(tx, today, scope) {
      const rows = await tx.execute<{ n: string; total: string; depth: string }>(sql`
        SELECT COUNT(*)::text n, COALESCE(SUM(amount_due),0)::text total,
               COALESCE(MAX(${today}::date - due_date),0)::text depth
          FROM documents
         WHERE direction='in' AND amount_due>0 AND due_date < ${today}::date
           AND status NOT IN ('cancelled','void','draft')
           AND ${scope}
      `);
      return { count: int(rows[0]?.n), amount: amount(rows[0]?.total), depthDays: int(rows[0]?.depth) };
    },
    describe: (s) => ({
      title: `${s.count} overdue invoices`,
      detail: `Oldest is ${s.depthDays} days late. Chasing these is the fastest cash you can raise.`,
    }),
  },

  installments: {
    key: "installments",
    kind: "installment",
    severity: "warning",
    href: "/receivables?filter=installments",
    label: "Missed installments",
    permission: "document:read",
    async probe(tx, today, scope) {
      // `installments` carries no business unit of its own — the attribution is
      // on the plan, which is where the sale happened. Joining rather than
      // filtering the child table is what keeps this consistent with the
      // `upcoming_installments` metric.
      const rows = await tx.execute<{ n: string; total: string; depth: string }>(sql`
        SELECT COUNT(*)::text n,
               COALESCE(SUM(i.amount_due - i.amount_paid),0)::text total,
               COALESCE(MAX(${today}::date - i.due_on),0)::text depth
          FROM installments i
          JOIN installment_plans p ON p.id = i.plan_id
         WHERE i.status <> 'paid' AND i.due_on < ${today}::date
           AND ${scope}
      `);
      return { count: int(rows[0]?.n), amount: amount(rows[0]?.total), depthDays: int(rows[0]?.depth) };
    },
    describe: (s) => ({
      title: `${s.count} installments missed`,
      detail: "Handsets sold on credit with payments past due. Collateral IMEIs are on file.",
    }),
  },

  sla: {
    key: "sla",
    kind: "sla",
    severity: "critical",
    href: "/services",
    label: "Jobs past SLA",
    permission: "job:read",
    async probe(tx, _today, scope) {
      const rows = await tx.execute<{ n: string; depth: string }>(sql`
        SELECT COUNT(*)::text n,
               COALESCE(FLOOR(MAX(EXTRACT(EPOCH FROM (now() - complete_by)) / 86400)), 0)::text depth
          FROM jobs
         WHERE status IN ('request','scheduled','dispatched','in_progress','on_hold')
           AND complete_by < now()
           AND ${scope}
      `);
      return { count: int(rows[0]?.n), amount: null, depthDays: int(rows[0]?.depth) };
    },
    describe: (s) => ({
      title: `${s.count} jobs past their SLA`,
      detail: "Late service jobs are the leading cause of bad reviews and lost repeat work.",
    }),
  },

  vacancy: {
    key: "vacancy",
    kind: "vacancy",
    severity: "opportunity",
    href: "/rentals",
    label: "Empty units",
    permission: "unit:read",
    async probe(tx, _today, scope) {
      // No depth axis: `units` records the current status, not when it changed,
      // so "how long has this been empty" is not answerable from this table.
      // Reporting a fabricated 0 is honest here — count and lost rent are the
      // two axes that can worsen, and both are watched.
      const rows = await tx.execute<{ n: string; rent: string }>(sql`
        SELECT COUNT(*)::text n, COALESCE(SUM(list_rent),0)::text rent
          FROM units WHERE status <> 'occupied' AND ${scope}
      `);
      return { count: int(rows[0]?.n), amount: amount(rows[0]?.rent), depthDays: 0 };
    },
    describe: (s) => ({
      title: `${s.count} units sitting empty`,
      detail:
        "Every month a unit stays vacant costs its full list rent — that money is unrecoverable.",
    }),
  },

  lease: {
    key: "lease",
    kind: "lease",
    severity: "warning",
    href: "/rentals?filter=expiring",
    label: "Leases expiring",
    permission: "lease:read",
    async probe(tx, today, scope) {
      // Depth is inverted so it stays monotone: a lease 5 days from expiry is
      // WORSE than one 55 days out, so depth counts days elapsed into the
      // 60-day window rather than days remaining. Without the inversion a
      // dismissal made at 60 days would suppress the same lease at 3 days.
      const rows = await tx.execute<{ n: string; depth: string }>(sql`
        SELECT COUNT(*)::text n,
               COALESCE(MAX(60 - (ends_on - ${today}::date)), 0)::text depth
          FROM leases
         WHERE status='active' AND auto_renew = false
           AND ends_on BETWEEN ${today}::date AND ${today}::date + 60
           AND ${scope}
      `);
      return { count: int(rows[0]?.n), amount: null, depthDays: int(rows[0]?.depth) };
    },
    describe: (s) => ({
      title: `${s.count} leases expire within 60 days`,
      detail: "Renewal conversations started early are far cheaper than re-letting.",
    }),
  },
};

/** Which column carries the business unit, per detector. Kept beside the
 *  detector table rather than inside `probe` so the scope predicate is built in
 *  one place and cannot be forgotten by a new detector that hand-rolls its own. */
const SCOPE_COLUMN: Record<ExceptionKey, string> = {
  overdue: "business_unit_id",
  installments: "p.business_unit_id",
  sla: "business_unit_id",
  vacancy: "business_unit_id",
  lease: "business_unit_id",
};

export function exceptionDetector(key: ExceptionKey): {
  key: ExceptionKey;
  label: string;
  permission: string;
} {
  const d = DETECTORS[key];
  return { key: d.key, label: d.label, permission: d.permission };
}

/**
 * Measure one exception inside a caller-supplied transaction.
 *
 * Exported so the dismiss action can re-measure the watermark itself rather
 * than trusting numbers posted from the browser. A client-supplied count is a
 * client-supplied permission to stay silent: post `dismissed_count=999999` and
 * the exception never comes back however bad it gets.
 */
export async function probeException(
  tx: Tx,
  key: ExceptionKey,
  today: string,
  allowedBusinessUnitIds: string[] | null,
): Promise<ExceptionSignal> {
  const d = DETECTORS[key];
  return d.probe(tx, today, businessUnitScope(allowedBusinessUnitIds, SCOPE_COLUMN[key]));
}

/**
 * A digest of the businesses in view when a judgement was made.
 *
 * Short (an inline sha256 prefix) because it is only ever compared for
 * equality; it identifies a population, it does not have to be reversible.
 */
export function exceptionScopeFingerprint(allowedBusinessUnitIds: string[] | null): string {
  if (allowedBusinessUnitIds === null) return "all";
  return createHash("sha256")
    .update([...allowedBusinessUnitIds].sort().join(","))
    .digest("hex")
    .slice(0, 32);
}

/**
 * How much an amount may grow before a dismissal stops covering it.
 *
 * A dismissal that unravels over a few dirhams of rounding drift is not a
 * dismissal — the owner would set the same item aside every morning and learn
 * to ignore the list, which is the failure this whole feature exists to fix.
 * 10% is the smallest change that plausibly changes the decision. Note that a
 * new overdue invoice raises `count` as well, so this tolerance only ever
 * covers the same rows growing slightly, never a new one appearing.
 */
const MATERIAL_AMOUNT_GROWTH = 0.1;

interface DismissalRow {
  exceptionKey: ExceptionKey;
  reason: string;
  count: number;
  amount: number;
  depthDays: number;
  scopeFingerprint: string;
  dismissedAt: string;
  expiresAt: string | null;
}

/**
 * Is `signal` still covered by the judgement recorded in `d`?
 *
 * Every axis must be no worse than the watermark. The moment one of them is
 * worse the exception is a *different fact about the business* and has never
 * been judged, so it comes back as new.
 */
function coveredByDismissal(signal: ExceptionSignal, d: DismissalRow, fingerprint: string): boolean {
  if (d.scopeFingerprint !== fingerprint) return false;
  if (signal.count > d.count) return false;
  if (signal.depthDays > d.depthDays) return false;
  if (signal.amount !== null && signal.amount > d.amount * (1 + MATERIAL_AMOUNT_GROWTH)) {
    return false;
  }
  return true;
}

export interface DismissedException {
  key: ExceptionKey;
  label: string;
  reason: string;
  dismissedAt: string;
  expiresAt: string | null;
}

export interface ExceptionFeed {
  items: ActionItem[];
  /** Firing, but set aside by this user and not yet worse than they judged it. */
  dismissed: DismissedException[];
  /**
   * How many of the five detectors this caller may see at all.
   *
   * Zero and empty are different states and WF-05 §2.3 renders them
   * differently: a caller who may see detectors and has no exceptions gets the
   * positive empty state, and a caller who may see none gets no region at all
   * — "the section is absent, not greyed".
   */
  visibleDetectors: number;
}

/**
 * The "what needs me today" list.
 *
 * Deliberately computed from hard operational facts rather than generated by a
 * language model. The AI is good at explaining and prioritising; it should not
 * be the thing that decides whether an invoice is overdue.
 *
 * Two filters run, and they are not the same filter:
 *
 *   PERMISSION decides whether a detector runs at all. RLS keeps tenant A out
 *   of tenant B, but every one of these five queries is inside one tenant, so
 *   RLS has nothing to say about a barber reading the landlord's rent roll.
 *   That is authorisation, it belongs to the application, and it was missing.
 *
 *   BUSINESS-UNIT SCOPE decides which rows a permitted detector sees. A branch
 *   manager holding `document:read` still only chases their own branch's debt.
 *
 * The five aggregates still run in ONE transaction and in parallel, so the
 * added filtering costs nothing — a caller who may see three detectors issues
 * three queries instead of five.
 */
export async function loadExceptionFeed(session: SessionUser): Promise<ExceptionFeed> {
  const today = resolveToday(session.timezone);
  const allowed = session.principal.businessUnitIds;
  const fingerprint = exceptionScopeFingerprint(allowed);
  const visible = EXCEPTION_KEYS.map((k) => DETECTORS[k]).filter((d) =>
    session.principal.permissions.has(d.permission),
  );

  if (visible.length === 0) return { items: [], dismissed: [], visibleDetectors: 0 };

  return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) => {
    const [signals, dismissals] = await Promise.all([
      Promise.all(
        visible.map(async (d) => ({
          detector: d,
          signal: await probeException(tx, d.key, today, allowed),
        })),
      ),
      loadDismissals(tx, session.userId),
    ]);

    const items: ActionItem[] = [];
    const dismissed: DismissedException[] = [];

    for (const { detector, signal } of signals) {
      if (signal.count <= 0) continue;
      const d = dismissals.get(detector.key);
      if (d && coveredByDismissal(signal, d, fingerprint)) {
        dismissed.push({
          key: detector.key,
          label: detector.label,
          reason: d.reason,
          dismissedAt: d.dismissedAt,
          expiresAt: d.expiresAt,
        });
        continue;
      }
      const { title, detail } = detector.describe(signal);
      items.push({
        id: detector.key,
        kind: detector.kind,
        severity: detector.severity,
        title,
        detail,
        amount: signal.amount,
        href: detector.href,
      });
    }

    const rank = { critical: 0, warning: 1, opportunity: 2 };
    items.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));
    return { items, dismissed, visibleDetectors: visible.length };
  });
}

/**
 * The request-cached entry point the dashboard calls.
 *
 * Split from `loadExceptionFeed` rather than wrapping it inline so the feed can
 * be exercised outside a React request — a `cache()`d function has no memo
 * store outside a render, and a permission filter that can only be tested
 * through a running Next server is a permission filter nobody tests.
 */
export const loadActionItems = cache(loadExceptionFeed);

/**
 * This user's live dismissals.
 *
 * Expired snoozes are filtered in SQL rather than in TypeScript so that an
 * expired row is invisible to the feed AND to the "set aside" list in one
 * place — a snooze that has run out must not linger in a panel that implies it
 * is still suppressing something.
 */
async function loadDismissals(tx: Tx, userId: string): Promise<Map<ExceptionKey, DismissalRow>> {
  const rows = await tx.execute<{
    exception_key: string;
    reason: string;
    dismissed_count: string;
    dismissed_amount: string;
    dismissed_depth_days: string;
    scope_fingerprint: string;
    created_at: string;
    expires_at: string | null;
  }>(sql`
    SELECT exception_key, reason, dismissed_count::text, dismissed_amount::text,
           dismissed_depth_days::text, scope_fingerprint,
           created_at::text, expires_at::text
      FROM exception_dismissals
     WHERE user_id = ${userId}::uuid
       AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
  `);

  const out = new Map<ExceptionKey, DismissalRow>();
  for (const r of rows) {
    if (!isExceptionKey(r.exception_key)) continue;
    out.set(r.exception_key, {
      exceptionKey: r.exception_key,
      reason: r.reason,
      count: int(r.dismissed_count),
      amount: amount(r.dismissed_amount),
      depthDays: int(r.dismissed_depth_days),
      scopeFingerprint: r.scope_fingerprint,
      dismissedAt: r.created_at,
      expiresAt: r.expires_at,
    });
  }
  return out;
}
