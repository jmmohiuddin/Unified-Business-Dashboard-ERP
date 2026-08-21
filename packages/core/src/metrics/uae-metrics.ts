import { sql } from "drizzle-orm";
import { changeRatio, defineMetric, num, type MetricDefinition } from "./types.ts";
import {
  APPORTIONMENT_BASIS_IN_USE,
  calculateCorporateTax,
  calculateVatReturn,
  resolveApportionmentMethod,
} from "../uae/tax.ts";

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

/**
 * Last day of the VAT quarter containing `iso`.
 *
 * The return used to run from the quarter start to *today* unconditionally,
 * which meant a filed quarter could never be re-opened: asking for Q1 in
 * August returned Q1-start-to-August, a window that is not any tax period at
 * all. A period selector needs both ends, so both ends exist.
 */
function quarterEnd(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const endMonth = Math.floor((m - 1) / 3) * 3 + 3;
  const d = new Date(Date.UTC(y, endMonth, 1)); // first of the NEXT month
  d.setUTCDate(0); // …rolled back to the last day of `endMonth`
  return d.toISOString().slice(0, 10);
}

function yearStart(iso: string): string {
  return `${iso.slice(0, 4)}-01-01`;
}

// ── VAT ─────────────────────────────────────────────────────────────────────

const vatReturnPosition = defineMetric({
  id: "vat_return_position",
  title: "VAT Position This Quarter",
  description:
    "Net VAT payable to (or refundable from) the FTA for a VAT quarter, built the way the " +
    "VAT201 return is: standard-rated supplies and output VAT, zero-rated supplies, exempt " +
    "supplies, imported services under the reverse charge, and recoverable input VAT AFTER " +
    "apportionment. Because residential rent is exempt, only the taxable share of overhead input " +
    "VAT can be reclaimed — over-claiming it is one of the most common assessment findings for " +
    "UAE property owners. Defaults to the quarter containing today, capped at today; pass from/to " +
    "to report a closed quarter in full. The recovery ratio is computed on the " +
    `${APPORTIONMENT_BASIS_IN_USE.replace("_", " ")} basis, which is NOT confirmed against the ` +
    "Executive Regulation and is an open question for the tax adviser. A positive value is owed " +
    "to the FTA; a negative value is a refund. This is a management position, not a filing.",
  unit: "currency",
  polarity: "neutral",
  permission: "report:read",
  aiExposed: true,
  async run(ctx, params) {
    // The window defaults to the quarter containing `today`, capped at today so
    // an in-flight quarter reports what has actually happened. `from`/`to` are
    // honoured so the VAT screen's period selector can open a CLOSED quarter,
    // which reports the whole of it — the previous behaviour ran every period
    // to `today` and could therefore never reproduce a filed return.
    const from = params.from ?? quarterStart(ctx.today);
    const periodEnd = params.to ?? quarterEnd(from);
    const to = periodEnd < ctx.today ? periodEnd : ctx.today;

    // Tenant-level VAT configuration: the apportionment method (FR-C02) and the
    // emirate box 1 is reported under. Read here rather than passed in because
    // a metric must produce the same number for the AI, the dashboard and the
    // screen, and a caller-supplied method would let those three disagree.
    const [tenantCfg] = await ctx.tx.execute<{ emirate: string; vat: unknown }>(sql`
      SELECT emirate, settings -> 'vat' AS vat FROM tenants WHERE id = ${ctx.tenantId}::uuid
    `);
    const { method, notes: methodNotes } = resolveApportionmentMethod(tenantCfg?.vat);

    // Credit notes belong in the return, signed negative.
    //
    // `createCreditNote` stores its lines with POSITIVE quantities and totals
    // and expresses the reversal in the ledger instead — it debits VAT_OUTPUT
    // (services/credit-notes.ts). So a return filtered to `doc_type = 'invoice'`
    // reports supplies and output VAT that the GL has already reversed: the
    // VAT201 and the VAT_OUTPUT balance disagree by exactly the credited VAT,
    // and the owner over-pays the FTA on a return that then fails
    // reconciliation on inspection. The sign has to be applied here because it
    // is not in the stored rows.
    //
    // Caveat the accountant should know about: `createCreditNote` does not copy
    // `tax_code_id` onto its lines (every one of the 5,657 line rows carrying a
    // tax code today is an invoice line), so the COALESCE below files a credit
    // note under 'standard' whatever it reverses. Output VAT is still right —
    // an exempt line carries no tax — but a credit note against residential
    // rent would come off box 1 instead of box 5. Fixing that belongs in the
    // credit-note service, not in this query.
    const rows = await ctx.tx.execute<{
      treatment: string; net: string; vat: string;
    }>(sql`
      SELECT COALESCE(tc.treatment::text, 'standard') AS treatment,
             SUM((dl.line_total - dl.tax_amount)
                 * CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END) AS net,
             SUM(dl.tax_amount
                 * CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END) AS vat
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
        LEFT JOIN tax_codes tc ON tc.id = dl.tax_code_id
       WHERE d.doc_type IN ('invoice','credit_note') AND d.direction = 'in'
         AND d.status NOT IN ('cancelled','void','draft')
         AND d.issue_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY 1
    `);

    // Input VAT actually incurred, split three ways by what each cost SERVES.
    //
    // The ledger is the carrier of that split, not an inference made here:
    // `receiveBill` debits 1600 / 1610 / 5720 per line according to the supply
    // the line serves, so summing the three system accounts for the period
    // reproduces exactly the attribution the bill was posted under. 1610
    // (VAT_INPUT_RESIDUAL) is the shared-overhead pool that wave 1 created and
    // did not wire; it is the number the apportionment engine below multiplies
    // by the recovery ratio, and it used to be hard-coded to zero — which meant
    // 100% of every non-rental business unit's input VAT was reclaimed and the
    // "recovery ratio" shown to the accountant multiplied nothing.
    const inputs = await ctx.tx.execute<{
      recoverable: string; residual: string; irrecoverable: string;
    }>(sql`
      SELECT
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'VAT_INPUT'), 0) AS recoverable,
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'VAT_INPUT_RESIDUAL'), 0) AS residual,
        COALESCE(SUM(jl.base_debit - jl.base_credit)
          FILTER (WHERE a.system_key = 'VAT_IRRECOVERABLE'), 0) AS irrecoverable
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE a.system_key IN ('VAT_INPUT','VAT_INPUT_RESIDUAL','VAT_IRRECOVERABLE')
        AND j.posting_date BETWEEN ${from}::date AND ${to}::date
    `);

    // Reverse charge on imported services (FR-C03), box 3.
    //
    // Sourced from BILLS, not from sales. Box 3 on the VAT201 is the recipient's
    // own imports — the supply on which the buyer self-accounts — so a sales
    // document tagged `reverse_charge` does not belong in it, and the previous
    // implementation's habit of adding sales-side RCM tax to output VAT was
    // adding a number that is nil by construction (a supplier under RCM charges
    // no VAT).
    //
    // KNOWN GAP, and the reason this returns 0 against today's data:
    // `receiveBill` does not write `tax_code_id` onto bill lines at all, so no
    // bill in the database can be identified as an imported service. The query
    // is the correct one and starts producing figures the moment purchasing
    // stores the tax code; until then FR-C03 is implemented and tested in
    // `calculateVatReturn` but unreachable from production data, and the box
    // will honestly read nil rather than looking complete.
    const [rcRow] = await ctx.tx.execute<{ net: string }>(sql`
      SELECT COALESCE(SUM((dl.line_total - dl.tax_amount)
               * CASE WHEN d.doc_type = 'debit_note' THEN -1 ELSE 1 END), 0) AS net
        FROM document_lines dl
        JOIN documents d ON d.id = dl.document_id
        JOIN tax_codes tc ON tc.id = dl.tax_code_id
       WHERE d.doc_type IN ('bill','debit_note') AND d.direction = 'out'
         AND d.status NOT IN ('cancelled','void','draft')
         AND tc.treatment = 'reverse_charge'
         AND d.issue_date BETWEEN ${from}::date AND ${to}::date
    `);

    const byTreatment = (t: string) => {
      const r = rows.find((x) => x.treatment === t);
      return { net: num(r?.net), vat: num(r?.vat) };
    };
    const standard = byTreatment("standard");
    const zero = byTreatment("zero_rated");
    const exempt = byTreatment("exempt");

    const result = calculateVatReturn({
      standardRatedSupplies: standard.net,
      outputVat: standard.vat,
      zeroRatedSupplies: zero.net,
      exemptSupplies: exempt.net,
      reverseChargeSupplies: num(rcRow?.net),
      // No attribution split is passed, so the whole of box 3 is treated as a
      // shared overhead and recovered at the period's ratio. That is the
      // conservative reading for a partly exempt group, and it is the only one
      // available: a bill line records no attribution today. A line that serves
      // only the exempt flats therefore over-recovers here by the ratio; the
      // fix belongs in `receiveBill`, which is where the attribution is known.
      directlyAttributableInput: num(inputs[0]?.recoverable),
      residualInput: num(inputs[0]?.residual),
      exemptAttributableInput: num(inputs[0]?.irrecoverable),
      method,
      emirate: tenantCfg?.emirate ?? undefined,
    });

    return {
      value: result.netVatDue,
      unit: "currency" as const,
      breakdown: [
        { key: "box1", label: "Standard-rated supplies", value: standard.net,
          meta: { outputVat: standard.vat, emirate: tenantCfg?.emirate ?? null } },
        { key: "box3", label: "Reverse-charge imported services", value: num(rcRow?.net),
          meta: { outputVat: result.reverseChargeOutputVat,
                  recovered: result.reverseChargeRecoverableInput } },
        { key: "box4", label: "Zero-rated supplies", value: zero.net },
        { key: "box5", label: "Exempt supplies (residential rent)", value: exempt.net },
        { key: "output", label: "Output VAT collected", value: result.totalOutputVat },
        { key: "input", label: "Recoverable input VAT", value: -result.totalRecoverableInput },
        { key: "irrecoverable", label: "Irrecoverable input VAT (a cost)", value: result.irrecoverableInput },
        { key: "ratio", label: "Input recovery ratio %",
          value: Math.round(result.recoveryRatio * 1000) / 10 },
        // The three parts of the reclaim, so the screen and the AI can both
        // explain WHY the reclaim is what it is rather than only stating it.
        { key: "direct_input", label: "Input VAT directly attributable to taxable supplies",
          value: num(inputs[0]?.recoverable) },
        { key: "residual_input", label: "Shared-overhead input VAT awaiting apportionment",
          value: num(inputs[0]?.residual) },
        { key: "residual_recovered", label: "Of that, recoverable at this quarter's ratio",
          value: result.recoverableResidual },
        {
          key: "method",
          label: result.apportionment.method === "floorspace"
            ? "Apportionment: floorspace (FTA-approved special method)"
            : "Apportionment: standard, output-based",
          // A ratio, not an amount — carried as a value so the AI can quote it.
          value: Math.round(result.recoveryRatio * 1000) / 10,
          meta: {
            method: result.apportionment.method,
            // The exact ratio, unrounded. `value` above is the display
            // percentage; anything that multiplies money or gets exported must
            // use this one, or a 81.6929% recovery is filed as 81.7%.
            recoveryRatio: result.recoveryRatio,
            basis: result.apportionment.basis,
            basisConfirmed: false,
            ftaApprovalReference: result.apportionment.ftaApprovalReference,
            periodStart: from,
            periodEnd: to,
            notes: [...methodNotes, ...result.notes],
          },
        },
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

    // `priorPeriodRevenues` is deliberately not passed, and that is a known gap
    // rather than a claim: FR-C04 tests relief against the current AND all
    // prior periods, so omitting the history asserts this is a first tax
    // period. Supplying it needs the same rework as assessing relief per
    // taxable person instead of group-wide, which this single ungrouped query
    // does not do either. Both belong in one change, not this one.
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
      drilldownHref: "/compliance",
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
