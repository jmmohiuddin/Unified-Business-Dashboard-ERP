import { sql } from "drizzle-orm";
import { changeRatio, defineMetric, num, type MetricDefinition } from "./types.ts";
import { calculateCorporateTax, calculateVatReturn } from "../uae/tax.ts";

/**
 * UAE compliance metrics.
 *
 * Kept separate from the general registry because they are jurisdiction
 * specific: a second country adds a sibling file rather than editing shared
 * code. Everything here answers a question that can cost the owner real money
 * if nobody asks it — a lapsed trade licence freezes the bank accounts, an
 * over-claimed VAT return invites an FTA assessment, and an unrecorded gratuity
 * liability makes the balance sheet fiction.
 */

function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Start of the VAT quarter containing `iso`. */
function quarterStart(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qm).padStart(2, "0")}-01`;
}

function yearStart(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

// ── VAT ─────────────────────────────────────────────────────────────────────

const vatReturnPosition = defineMetric({
  id: "vat_return_position",
  title: "VAT Position This Quarter",
  description:
    "Net VAT payable to (or refundable from) the FTA for the current quarter, built the way the " +
    "VAT201 return is: standard-rated supplies and output VAT, zero-rated supplies, exempt " +
    "supplies, and recoverable input VAT AFTER apportionment. Because residential rent is exempt, " +
    "only the taxable share of overhead input VAT can be reclaimed — over-claiming it is one of " +
    "the most common assessment findings for UAE property owners. A positive value is owed to the " +
    "FTA; a negative value is a refund.",
  unit: "currency",
  polarity: "neutral",
  permission: "report:read",
  aiExposed: true,
  async run(ctx) {
    const from = quarterStart(ctx.today);
    const rows = await ctx.tx.execute<{
      treatment: string; net: string; vat: string;
    }>(sql`
      SELECT COALESCE(tc.treatment::text, 'standard') AS treatment,
             SUM(dl.line_total - dl.tax_amount) AS net,
             SUM(dl.tax_amount) AS vat
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
        LEFT JOIN tax_codes tc ON tc.id = dl.tax_code_id
       WHERE d.doc_type = 'invoice' AND d.direction = 'in'
         AND d.status NOT IN ('cancelled','void','draft')
         AND d.issue_date BETWEEN ${from}::date AND ${ctx.today}::date
       GROUP BY 1
    `);

    // Input VAT actually incurred, split by whether it is directly attributable.
    const inputs = await ctx.tx.execute<{ recoverable: string; irrecoverable: string }>(sql`
      SELECT
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'VAT_INPUT'), 0) AS recoverable,
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'VAT_IRRECOVERABLE'), 0) AS irrecoverable
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE a.system_key IN ('VAT_INPUT','VAT_IRRECOVERABLE')
        AND j.posting_date BETWEEN ${from}::date AND ${ctx.today}::date
    `);

    const byTreatment = (t: string) => {
      const r = rows.find((x) => x.treatment === t);
      return { net: num(r?.net), vat: num(r?.vat) };
    };
    const standard = byTreatment("standard");
    const zero = byTreatment("zero_rated");
    const exempt = byTreatment("exempt");
    const rc = byTreatment("reverse_charge");

    const result = calculateVatReturn({
      standardRatedSupplies: standard.net,
      outputVat: standard.vat + rc.vat,
      zeroRatedSupplies: zero.net,
      exemptSupplies: exempt.net,
      reverseChargeSupplies: rc.net,
      directlyAttributableInput: num(inputs[0]?.recoverable),
      residualInput: 0,
      exemptAttributableInput: num(inputs[0]?.irrecoverable),
    });

    return {
      value: result.netVatDue,
      unit: "currency" as const,
      breakdown: [
        { key: "box1", label: "Standard-rated supplies", value: standard.net,
          meta: { outputVat: standard.vat } },
        { key: "box4", label: "Zero-rated supplies", value: zero.net },
        { key: "box5", label: "Exempt supplies (residential rent)", value: exempt.net },
        { key: "output", label: "Output VAT collected", value: standard.vat + rc.vat },
        { key: "input", label: "Recoverable input VAT", value: -result.totalRecoverableInput },
        { key: "irrecoverable", label: "Irrecoverable input VAT (a cost)", value: result.irrecoverableInput },
        { key: "ratio", label: "Input recovery ratio %",
          value: Math.round(result.recoveryRatio * 1000) / 10 },
      ],
      drilldownHref: "/accounting/vat",
    };
  },
});

// ── Corporate tax ───────────────────────────────────────────────────────────

const corporateTaxEstimate = defineMetric({
  id: "corporate_tax_estimate",
  title: "Corporate Tax Estimate",
  description:
    "Estimated UAE corporate tax for the current financial year to date: 0% on the first " +
    "AED 375,000 of taxable income and 9% above it. Checks Small Business Relief eligibility " +
    "(revenue at or below AED 3,000,000, available for tax periods ending on or before " +
    "31 December 2026). This is a management estimate for planning, NOT a tax computation — " +
    "the year-end filing position is the accountant's.",
  unit: "currency",
  polarity: "lower_is_better",
  permission: "report:read",
  aiExposed: true,
  async run(ctx) {
    const from = yearStart(ctx.today);
    const rows = await ctx.tx.execute<{ revenue: string; profit: string; drawings: string }>(sql`
      SELECT
        COALESCE(SUM(jl.base_credit - jl.base_debit) FILTER (WHERE a.type = 'income'), 0) AS revenue,
        COALESCE(SUM(
          CASE WHEN a.type = 'income'  THEN jl.base_credit - jl.base_debit
               WHEN a.type = 'expense' THEN -(jl.base_debit - jl.base_credit)
               ELSE 0 END), 0) AS profit,
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'DRAWINGS'), 0) AS drawings
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE j.posting_date BETWEEN ${from}::date AND ${ctx.today}::date
    `);

    const revenue = num(rows[0]?.revenue);
    const profit = num(rows[0]?.profit);

    const result = calculateCorporateTax({
      accountingProfit: profit,
      revenue,
      periodEnd: `${ctx.today.slice(0, 4)}-12-31`,
      electSbr: true,
    });

    return {
      value: result.taxDue,
      unit: "currency" as const,
      breakdown: [
        { key: "revenue", label: "Revenue year to date", value: revenue },
        { key: "profit", label: "Accounting profit", value: profit },
        { key: "exempt", label: "Taxed at 0% (first 375k)", value: result.exemptSlice },
        { key: "taxable", label: "Taxed at 9%", value: result.taxableSlice },
        { key: "sbr", label: result.sbrApplied
            ? "Small Business Relief applied" : "Small Business Relief not available",
          value: result.sbrApplied ? 1 : 0,
          meta: { notes: result.notes } },
      ],
      drilldownHref: "/accounting/tax",
    };
  },
});

// ── Gratuity ────────────────────────────────────────────────────────────────

const gratuityLiability = defineMetric({
  id: "gratuity_liability",
  title: "End-of-Service Liability",
  description:
    "Total accrued end-of-service gratuity across all active employees, under Federal " +
    "Decree-Law 33 of 2021: 21 days' basic wage per year for the first five years of service and " +
    "30 days per year thereafter, capped at two years' wage. This is money the business already " +
    "owes even though nobody has resigned — for a group with long-serving staff it is frequently " +
    "the largest liability that owners have never seen on a balance sheet.",
  unit: "currency",
  polarity: "lower_is_better",
  permission: "payroll:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{
      id: string; full_name: string; designation: string; accrued: string;
      years: string; basic: string;
    }>(sql`
      -- date minus date yields an integer number of days in Postgres, not an
      -- interval, so EXTRACT(EPOCH …) is not applicable here.
      SELECT id, full_name, designation, gratuity_accrued AS accrued,
             ROUND((${ctx.today}::date - joined_on) / 365.25, 1)::text AS years,
             base_salary AS basic
        FROM employees
       WHERE status IN ('active','probation','on_leave')
       ORDER BY gratuity_accrued DESC
       LIMIT ${params.limit ?? 10}
    `);
    const totals = await ctx.tx.execute<{ total: string; funded: string; headcount: number }>(sql`
      SELECT COALESCE(SUM(e.gratuity_accrued), 0) AS total,
             COALESCE((SELECT SUM(jl.base_credit - jl.base_debit)
                         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                        WHERE a.system_key = 'GRATUITY_PROVISION'), 0) AS funded,
             COUNT(*)::int AS headcount
        FROM employees e WHERE e.status IN ('active','probation','on_leave')
    `);

    const total = num(totals[0]?.total);
    const provisioned = num(totals[0]?.funded);

    return {
      value: total,
      unit: "currency" as const,
      priorValue: provisioned,
      changeRatio: changeRatio(total, provisioned),
      breakdown: [
        ...rows.map((r) => ({
          key: r.id, label: r.full_name, value: num(r.accrued),
          meta: { role: r.designation, years: num(r.years), basicSalary: num(r.basic) },
        })),
        { key: "provisioned", label: "Posted to the provision account", value: provisioned },
        { key: "headcount", label: "Employees covered", value: num(totals[0]?.headcount) },
      ],
      drilldownHref: "/hr/gratuity",
    };
  },
});

// ── Post-dated cheques ──────────────────────────────────────────────────────

const chequePipeline = defineMetric({
  id: "cheque_pipeline",
  title: "Cheques to Bank",
  description:
    "Post-dated cheques held against tenancy contracts, split by what happens next: due within " +
    "seven days, held for later, and bounced. Cheques in the safe are NOT cash and NOT " +
    "receivables — they are a promise for a period that has not been invoiced yet. This is the " +
    "operational answer to 'what do I deposit this week', and the bounced count is an early " +
    "warning that a tenant is in trouble.",
  unit: "currency",
  polarity: "neutral",
  permission: "lease:read",
  requiresModules: ["rentals"],
  aiExposed: true,
  async run(ctx) {
    const rows = await ctx.tx.execute<{ bucket: string; total: string; n: number }>(sql`
      SELECT
        CASE
          WHEN status = 'bounced' THEN 'bounced'
          WHEN status = 'deposited' THEN 'clearing'
          WHEN status = 'held' AND cheque_date <= ${shiftDays(ctx.today, 30)}::date THEN 'due_now'
          WHEN status = 'held' THEN 'future'
          ELSE 'settled'
        END AS bucket,
        SUM(amount) AS total, COUNT(*)::int AS n
      FROM cheques
      WHERE direction = 'in'
      GROUP BY 1
    `);
    const labels: Record<string, string> = {
      due_now: "Due to bank within 30 days",
      clearing: "Deposited, awaiting clearance",
      future: "Held for later periods",
      bounced: "Bounced — needs chasing",
      settled: "Cleared",
    };
    const order = ["due_now", "clearing", "bounced", "future", "settled"];
    const pending = rows
      .filter((r) => ["due_now", "clearing", "future"].includes(r.bucket))
      .reduce((t, r) => t + num(r.total), 0);

    return {
      value: pending,
      unit: "currency" as const,
      breakdown: order
        .map((k) => rows.find((r) => r.bucket === k))
        .filter(Boolean)
        .map((r) => ({ key: r!.bucket, label: labels[r!.bucket]!, value: num(r!.total),
          meta: { count: r!.n } })),
      drilldownHref: "/rentals/cheques",
    };
  },
});

// ── Compliance expiries ─────────────────────────────────────────────────────

const complianceWatchlist = defineMetric({
  id: "compliance_watchlist",
  title: "Compliance Deadlines",
  description:
    "Trade licences, employee visas, labour cards and Ejari registrations approaching expiry or " +
    "already lapsed, within the next 90 days. In the UAE these are not paperwork: an expired " +
    "trade licence freezes the company bank account and blocks every visa renewal, and an " +
    "unregistered tenancy cannot be enforced at the Rental Dispute Centre.",
  unit: "count",
  polarity: "lower_is_better",
  permission: "settings:read",
  aiExposed: true,
  async run(ctx) {
    const horizon = shiftDays(ctx.today, 90);
    const [licences, visas, ejari] = await Promise.all([
      ctx.tx.execute<{ name: string; expiry: string; days: string }>(sql`
        SELECT name, trade_license_expiry::text AS expiry,
               (trade_license_expiry - ${ctx.today}::date)::text AS days
          FROM business_units
         WHERE is_active = true AND trade_license_expiry IS NOT NULL
           AND trade_license_expiry <= ${horizon}::date
         ORDER BY trade_license_expiry
      `),
      ctx.tx.execute<{ name: string; expiry: string; days: string }>(sql`
        SELECT full_name AS name, visa_expiry::text AS expiry,
               (visa_expiry - ${ctx.today}::date)::text AS days
          FROM employees
         WHERE status IN ('active','probation') AND visa_expiry IS NOT NULL
           AND visa_expiry <= ${horizon}::date
         ORDER BY visa_expiry
      `),
      ctx.tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int n FROM leases
         WHERE status = 'active' AND ejari_number IS NULL
      `),
    ]);

    const items = [
      ...licences.map((l) => ({
        key: `lic-${l.name}`, label: `Trade licence — ${l.name}`,
        value: num(l.days), meta: { kind: "trade_licence", expiry: l.expiry, severity: "critical" },
      })),
      ...visas.map((v) => ({
        key: `visa-${v.name}`, label: `Visa — ${v.name}`,
        value: num(v.days), meta: { kind: "visa", expiry: v.expiry, severity: "warning" },
      })),
    ].sort((a, b) => a.value - b.value);

    const unregistered = num(ejari[0]?.n);
    if (unregistered > 0) {
      items.push({
        key: "ejari", label: `${unregistered} active leases without Ejari registration`,
        value: 0, meta: { kind: "ejari", expiry: ctx.today, severity: "warning" },
      });
    }

    return {
      value: items.length,
      unit: "count" as const,
      breakdown: items.slice(0, 10),
      drilldownHref: "/compliance",
    };
  },
});

export const UAE_METRICS = [
  vatReturnPosition,
  corporateTaxEstimate,
  gratuityLiability,
  chequePipeline,
  complianceWatchlist,
] as unknown as MetricDefinition[];
