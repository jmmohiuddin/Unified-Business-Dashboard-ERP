import { Suspense } from "react";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import {
  APPORTIONMENT_BASIS_IN_USE,
  calculateAnnualWashup,
  calculateVatReturn,
  formatMoney,
  type QuarterlyProvisional,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { BarRow, Card, CardHeader, EmptyState, GridSkeleton } from "@/components/ui";
import { BuTag, DataTable, PageHeader, StatStrip, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * VAT201 return position.
 *
 * Laid out as the FTA's own form, box by box, because that is how the
 * accountant will check it. The number that matters most is the one nobody
 * expects: the input-tax apportionment. Residential rent is exempt, so VAT on
 * costs serving those flats is NOT recoverable, and only the taxable share of
 * shared overheads can be reclaimed.
 *
 * Three things this screen is careful about, each of which was previously
 * wrong in a way that looked right:
 *
 *  1. **The period is selectable.** The quarter used to be derived from `today`
 *     and every query ran to `today`, so a closed quarter could not be opened at
 *     all — asking for Q1 in August would have produced January-to-August, which
 *     is not a tax period. Both ends of the period now come from the selector.
 *  2. **Every box drills through.** WF-05 §10.2 asks for it, and a box that
 *     cannot be opened is a number the accountant has to take on trust.
 *  3. **Box numbering says what it knows.** Boxes 1, 3, 4 and 5 are evidenced by
 *     the seeded `tax_codes.reporting_code`. The recoverable-input box number is
 *     not evidenced by anything in this repository, and the screen says so
 *     rather than presenting all five with equal confidence.
 *
 * This screen deliberately does not offer to file. It produces the position,
 * shows the working, and exports it; submission is the accountant's, on the
 * FTA portal.
 */

// ── Periods ─────────────────────────────────────────────────────────────────

/** "2026-Q3" for any ISO date. */
function quarterLabelOf(iso: string): string {
  return `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
}

/** Inclusive calendar bounds of a "YYYY-Qn" label, and the FTA's 28-day due date. */
function quarterBounds(label: string): { start: string; end: string; dueOn: string } {
  const year = Number(label.slice(0, 4));
  const q = Number(label.slice(6, 7));
  const startMonth = (q - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, startMonth + 2, 1));
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  const due = new Date(`${end}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 28);
  return { start, end, dueOn: due.toISOString().slice(0, 10) };
}

/** The `count` most recent quarters, newest first, ending with `label`. */
function recentQuarters(label: string, count: number): string[] {
  let year = Number(label.slice(0, 4));
  let q = Number(label.slice(6, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${year}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

const PERIOD_PATTERN = /^\d{4}-Q[1-4]$/;

// ── Drill-through ───────────────────────────────────────────────────────────

/**
 * What each box can be opened onto.
 *
 * Supply boxes are computed from document lines, so that is what opening one
 * shows — with the journal numbers those documents posted, which is the literal
 * request in WF-05 §10.2 ("Every box links to its journals"). The recoverable
 * input box is computed from the ledger itself, so it opens onto journal lines.
 * Showing invoices under a box built from journals, or vice versa, would be a
 * drill-through onto something other than the number above it.
 */
const DRILLABLE: Record<string, { title: string; kind: "supplies" | "input_tax" | "reverse_charge"; treatment?: string }> = {
  "1": { title: "Box 1 — standard-rated supplies", kind: "supplies", treatment: "standard" },
  "3": { title: "Box 3 — imported services under the reverse charge", kind: "reverse_charge" },
  "4": { title: "Box 4 — zero-rated supplies", kind: "supplies", treatment: "zero_rated" },
  "5": { title: "Box 5 — exempt supplies", kind: "supplies", treatment: "exempt" },
  "9": { title: "Box 9 — recoverable input VAT", kind: "input_tax" },
};

type DrillRow = {
  id: string;
  ref: string;
  dt: string;
  party: string;
  bu: string;
  color_token: string;
  journals: string;
  net: string;
  vat: string;
  detail: string;
};

// ── CSV export ──────────────────────────────────────────────────────────────

/**
 * EmaraTax export.
 *
 * A CSV rather than the FTA's own upload format, and the difference is not
 * cosmetic: the portal's bulk-upload templates are versioned artefacts nobody
 * on this project has, and emitting a file that *claims* to be one and is not
 * would fail at submission with the accountant having already believed the
 * return was done. This is the return, box by box, in a form that can be
 * transcribed or pasted — plus the apportionment that produced it, because the
 * ratio is the part an assessment asks about and it is not on the form.
 *
 * Every field is quoted. A business name with a comma in it is otherwise a
 * silently shifted column.
 */
function csv(rows: (string | number)[][]): string {
  return rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

export default async function VatPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; box?: string }>;
}) {
  const session = await requireSession();
  const { period: rawPeriod, box: rawBox } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const currentQuarter = quarterLabelOf(today);
  const periodLabel =
    rawPeriod && PERIOD_PATTERN.test(rawPeriod) ? rawPeriod : currentQuarter;
  const bounds = quarterBounds(periodLabel);
  const from = bounds.start;
  // An in-flight quarter reports what has happened so far; a closed one reports
  // the whole of itself. This is the difference that made a filed quarter
  // impossible to reproduce before.
  const to = bounds.end < today ? bounds.end : today;
  const isClosed = bounds.end < today;
  const openBox = rawBox && rawBox in DRILLABLE ? rawBox : null;
  const href = (params: { period?: string; box?: string | null }) => {
    const p = new URLSearchParams();
    p.set("period", params.period ?? periodLabel);
    if (params.box) p.set("box", params.box);
    return `/accounting/vat?${p.toString()}`;
  };

  const m = await loadMetrics(session, [
    { metricId: "vat_return_position", params: { from, to } },
  ]);
  const vat = metric(m, "vat_return_position");
  const failure = m["vat_return_position"];
  const forbidden = failure && "code" in failure && failure.code === "forbidden";

  // ── Permission denied ─────────────────────────────────────────────────────
  if (forbidden) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1200px] mx-auto space-y-5">
        <PageHeader title="VAT return" back={{ href: "/compliance", label: "Compliance" }} />
        <Card>
          <EmptyState
            icon="🔒"
            title="You do not have access to the VAT return"
            detail="Reporting permission is required to see the group's tax position. Your administrator can grant it."
          />
        </Card>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (!vat) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1200px] mx-auto space-y-5">
        <PageHeader title="VAT return" back={{ href: "/compliance", label: "Compliance" }} />
        <Card>
          <EmptyState
            icon="!"
            title="The VAT position could not be computed"
            detail={
              failure && "error" in failure
                ? failure.error
                : "The return could not be built for this period. Try again, or pick another quarter."
            }
          />
        </Card>
      </div>
    );
  }

  const box = (k: string) => vat.breakdown?.find((b) => b.key === k)?.value ?? 0;
  const meta = vat.breakdown?.find((b) => b.key === "method")?.meta ?? {};
  const apportionmentMethod = String(meta.method ?? "standard");
  const apportionmentBasis = String(meta.basis ?? APPORTIONMENT_BASIS_IN_USE);
  const ftaApprovalReference = meta.ftaApprovalReference as string | null;
  const engineNotes = Array.isArray(meta.notes) ? (meta.notes as string[]) : [];
  const emirate = String(
    vat.breakdown?.find((b) => b.key === "box1")?.meta?.emirate ?? "Dubai",
  );

  const ratio = box("ratio");
  // `ratio` is the display percentage, rounded to one decimal for a tile. The
  // exact fraction is what the export carries and what the apportionment card
  // quotes: an 81.6929% recovery transcribed into the portal as 81.7% is a
  // different reclaim.
  const exactRatio = typeof meta.recoveryRatio === "number" ? meta.recoveryRatio : ratio / 100;
  const irrecoverable = box("irrecoverable");
  const outputVat = box("output");
  const recoverableInput = Math.abs(box("input"));
  const residualPool = box("residual_input");
  const residualRecovered = box("residual_recovered");
  const rcNet = box("box3");
  const rcMeta = vat.breakdown?.find((b) => b.key === "box3")?.meta ?? {};
  const rcOutputVat = Number(rcMeta.outputVat ?? 0);

  const taxableSupplies = box("box1") + box("box4");
  const exemptSupplies = box("box5");

  /**
   * The FTA form, box by box.
   *
   * `confirmed: false` does not mean the amount is doubtful — it means the BOX
   * NUMBER is. See the footnote under the table; the distinction is the whole
   * point of showing it.
   */
  const BOXES = [
    {
      no: "1",
      label: "Standard-rated supplies",
      net: box("box1"),
      vat: outputVat - rcOutputVat,
      note: `Emirate of ${emirate}`,
      confirmed: true,
    },
    {
      no: "3",
      label: "Reverse-charge provisions",
      net: rcNet,
      vat: rcOutputVat,
      note: "Imported services — self-accounted at 5%",
      confirmed: true,
    },
    {
      no: "4",
      label: "Zero-rated supplies",
      net: box("box4"),
      vat: 0,
      note: "Input VAT still recoverable",
      confirmed: true,
    },
    {
      no: "5",
      label: "Exempt supplies",
      net: exemptSupplies,
      vat: 0,
      note: "Residential rent — input VAT NOT recoverable",
      confirmed: true,
    },
    {
      no: "9",
      label: "Recoverable input VAT",
      net: 0,
      vat: -recoverableInput,
      note: "After apportionment",
      confirmed: false,
    },
  ];

  const nothingThisPeriod =
    box("box1") === 0 && box("box4") === 0 && exemptSupplies === 0 && rcNet === 0;

  // ── The year, for the annual wash-up ──────────────────────────────────────
  //
  // Recomputed from the ledger per quarter rather than read from `vat_returns`.
  // The table ships in this change (migration 0004) but nothing writes to it
  // yet — filing a return is a service this feature does not own — so reading
  // it would show an empty card forever. `QuarterlyProvisional` is exactly the
  // shape a persisted row maps onto, so the swap is a change of source and
  // nothing else. Until then this is the year's position on TODAY's data, which
  // is an estimate of the wash-up rather than the wash-up itself, and the card
  // says so.
  const taxYear = periodLabel.slice(0, 4);
  const yearEnd = `${taxYear}-12-31`;
  const yearTo = yearEnd < today ? yearEnd : today;

  const { byBusiness, yearSupplies, yearResidual } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const byBusiness = await tx.execute<{
        name: string; color_token: string; treatment: string;
        net: string; vat: string; invoices: number;
      }>(sql`
        SELECT b.name, b.color_token, COALESCE(tc.treatment::text, 'standard') AS treatment,
               SUM(dl.line_total - dl.tax_amount) AS net,
               SUM(dl.tax_amount) AS vat,
               COUNT(DISTINCT d.id)::int AS invoices
          FROM document_lines dl
          JOIN documents d ON d.id = dl.document_id
          JOIN business_units b ON b.id = d.business_unit_id
          LEFT JOIN tax_codes tc ON tc.id = dl.tax_code_id
         WHERE d.doc_type = 'invoice' AND d.direction = 'in'
           AND d.status NOT IN ('cancelled','void','draft')
           AND d.issue_date BETWEEN ${from}::date AND ${to}::date
         GROUP BY b.name, b.color_token, tc.treatment
         ORDER BY 4 DESC
      `);

      const yearSupplies = await tx.execute<{ q: string; treatment: string; net: string }>(sql`
        SELECT to_char(d.issue_date, 'YYYY-"Q"Q') AS q,
               COALESCE(tc.treatment::text, 'standard') AS treatment,
               SUM((dl.line_total - dl.tax_amount)
                   * CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END) AS net
          FROM document_lines dl
          JOIN documents d ON d.id = dl.document_id
          LEFT JOIN tax_codes tc ON tc.id = dl.tax_code_id
         WHERE d.doc_type IN ('invoice','credit_note') AND d.direction = 'in'
           AND d.status NOT IN ('cancelled','void','draft')
           AND d.issue_date BETWEEN ${`${taxYear}-01-01`}::date AND ${yearTo}::date
         GROUP BY 1, 2
      `);

      const yearResidual = await tx.execute<{ q: string; residual: string }>(sql`
        SELECT to_char(j.posting_date, 'YYYY-"Q"Q') AS q,
               COALESCE(SUM(jl.base_debit - jl.base_credit), 0) AS residual
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          JOIN accounts a ON a.id = jl.account_id
         WHERE a.system_key = 'VAT_INPUT_RESIDUAL'
           AND j.posting_date BETWEEN ${`${taxYear}-01-01`}::date AND ${yearTo}::date
         GROUP BY 1
      `);

      return { byBusiness, yearSupplies, yearResidual };
    },
  );

  // Rebuild each quarter's provisional position with the same engine that built
  // the one on screen, so the wash-up differences a like against a like.
  //
  // The quarter list is the union of both sources, not just the supplies: a
  // quarter that incurred shared overhead VAT and invoiced nothing still has a
  // residual pool to wash up, and dropping it would understate the year's pool.
  const quarterLabels = [
    ...new Set([...yearSupplies.map((r) => r.q), ...yearResidual.map((r) => r.q)]),
  ].sort();
  const provisional: QuarterlyProvisional[] = quarterLabels.map((label) => {
    const netOf = (t: string) =>
      Number(yearSupplies.find((r) => r.q === label && r.treatment === t)?.net ?? 0);
    const residual = Number(yearResidual.find((r) => r.q === label)?.residual ?? 0);
    const q = calculateVatReturn({
      standardRatedSupplies: netOf("standard"),
      outputVat: 0,
      zeroRatedSupplies: netOf("zero_rated"),
      exemptSupplies: netOf("exempt"),
      reverseChargeSupplies: 0,
      directlyAttributableInput: 0,
      residualInput: residual,
      exemptAttributableInput: 0,
    });
    return { label, residualInput: residual, recoverableResidual: q.recoverableResidual };
  });

  // Taxable for apportionment is standard + zero-rated, exactly as
  // `calculateVatReturn` defines it — out-of-scope and reverse-charge supplies
  // are neither numerator nor denominator, so "not exempt" is the wrong test.
  const annualTaxable = yearSupplies
    .filter((r) => r.treatment === "standard" || r.treatment === "zero_rated")
    .reduce((t, r) => t + Number(r.net), 0);
  const annualExempt = yearSupplies
    .filter((r) => r.treatment === "exempt")
    .reduce((t, r) => t + Number(r.net), 0);

  const washup = calculateAnnualWashup({
    taxYear,
    quarters: provisional,
    annualTaxableSupplies: annualTaxable,
    annualExemptSupplies: annualExempt,
  });
  const washupDue = yearEnd < today;

  // ── Export ────────────────────────────────────────────────────────────────
  const exportRows: (string | number)[][] = [
    ["Nexus VAT201 export", periodLabel],
    ["Tenant", session.tenantName ?? ""],
    ["Period start", from],
    ["Period end", to],
    ["Filing due", bounds.dueOn],
    ["Emirate", emirate],
    ["Apportionment method", apportionmentMethod],
    ["Apportionment basis", apportionmentBasis],
    ["Apportionment basis confirmed with tax adviser", "NO — open question"],
    ["FTA approval reference", ftaApprovalReference ?? ""],
    // The ratio to 4 dp, plus the two figures it divides. Publishing only the
    // quotient invites an officer to multiply it back out and land a fil away
    // from the reclaim; publishing the numerator and denominator does not.
    ["Recovery ratio", exactRatio],
    ["Taxable supplies (ratio numerator)", taxableSupplies],
    ["Total supplies (ratio denominator)", taxableSupplies + exemptSupplies],
    [],
    ["Box", "Description", `Amount (${ccy})`, `VAT (${ccy})`, "Box number confirmed"],
    ...BOXES.map((b) => [b.no, b.label, b.net, b.vat, b.confirmed ? "yes" : "NO"]),
    [],
    ["Net VAT due", vat.value],
    ["Input VAT directly attributable", box("direct_input")],
    ["Shared-overhead (residual) input VAT", residualPool],
    ["Of that, recovered", residualRecovered],
    ["Irrecoverable input VAT (a cost)", irrecoverable],
    [],
    ["Not a filing. Prepared for transcription into EmaraTax by the accountant."],
    ...engineNotes.map((n) => [n]),
  ];
  const exportHref = `data:text/csv;charset=utf-8,${encodeURIComponent(csv(exportRows))}`;
  const exportName = `VAT201-${periodLabel}.csv`;

  const barMax = Math.max(outputVat, recoverableInput, 1);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1200px] mx-auto space-y-5">
      <PageHeader
        title={`VAT return — ${periodLabel}`}
        subtitle={
          `${from} to ${to}${isClosed ? "" : " (quarter in progress)"} · due ` +
          `${bounds.dueOn} · filed quarterly with the Federal Tax Authority`
        }
        back={{ href: "/compliance", label: "Compliance" }}
        actions={
          <div className="flex gap-1 flex-wrap items-center">
            {recentQuarters(currentQuarter, 6).map((q) => (
              <Link
                key={q}
                href={href({ period: q, box: null })}
                className="px-2.5 py-1 rounded-[var(--radius-md)] text-2xs font-semibold transition-colors"
                style={
                  q === periodLabel
                    ? { background: "var(--accent)", color: "var(--text-inverse)" }
                    : { background: "var(--surface-2)", color: "var(--text-muted)" }
                }
                aria-current={q === periodLabel ? "page" : undefined}
              >
                {q}
              </Link>
            ))}
          </div>
        }
      />

      <StatStrip
        stats={[
          {
            // A nil position is neither owed nor owing, and labelling it
            // "refundable" invites somebody to go looking for a refund.
            label: vat.value === 0 ? "Net VAT" : vat.value > 0 ? "Payable to FTA" : "Refundable",
            value: formatMoney(Math.abs(vat.value), ccy, 0),
            tone: vat.value === 0 ? "default" : vat.value > 0 ? "caution" : "positive",
          },
          { label: "Output VAT collected", value: formatMoney(outputVat, ccy, 0) },
          { label: "Input VAT reclaimed", value: formatMoney(recoverableInput, ccy, 0) },
          {
            label: "Irrecoverable input VAT",
            value: formatMoney(irrecoverable, ccy, 0),
            tone: irrecoverable > 0 ? "negative" : "default",
            hint: "A cost, not a reclaim",
          },
          {
            label: "Recovery ratio",
            value: `${ratio}%`,
            hint: apportionmentMethod === "floorspace" ? "Floorspace method" : "Taxable ÷ total supplies",
          },
        ]}
      />

      {nothingThisPeriod ? (
        <Card>
          <EmptyState
            icon="—"
            title={`No supplies in ${periodLabel}`}
            detail={
              `Nothing was invoiced between ${from} and ${to}, so there is no return to file for ` +
              `this quarter. A nil return may still be due — check with your accountant.`
            }
          />
        </Card>
      ) : (
        <Card className="p-4" as="div">
          <p className="label mb-2">Output against recoverable</p>
          <BarRow
            label="Output VAT"
            value={outputVat}
            max={barMax}
            display={formatMoney(outputVat, ccy, 0)}
            color="var(--caution)"
          />
          <BarRow
            label="Recoverable input VAT"
            value={recoverableInput}
            max={barMax}
            display={formatMoney(recoverableInput, ccy, 0)}
            color="var(--positive)"
            meta={
              residualPool > 0
                ? `Includes ${formatMoney(residualRecovered, ccy, 0)} of ${formatMoney(residualPool, ccy, 0)} shared overhead VAT`
                : undefined
            }
          />
          {irrecoverable > 0 && (
            <p className="text-2xs text-subtle mt-2 leading-relaxed">
              You cannot reclaim{" "}
              <strong style={{ color: "var(--negative)" }}>
                {formatMoney(irrecoverable, ccy, 0)}
              </strong>{" "}
              because residential rent is exempt.
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title="Apportionment"
          subtitle="How much of the shared overhead VAT comes back"
        />
        <div className="px-4 pb-3 space-y-1.5 text-xs">
          <Row
            label="Method"
            value={
              apportionmentMethod === "floorspace"
                ? `Floorspace (special method, FTA ${ftaApprovalReference ?? "—"})`
                : "Output-based (standard)"
            }
          />
          <Row label="Basis" value={`${apportionmentBasis.replace(/_/g, " ")} — unconfirmed`} />
          <Row label="Taxable supplies" value={formatMoney(taxableSupplies, ccy, 0)} />
          <Row label="Exempt supplies" value={formatMoney(exemptSupplies, ccy, 0)} />
          <Row label="Shared overhead VAT" value={formatMoney(residualPool, ccy, 2)} />
          <Row label="Recoverable share" value={`${(exactRatio * 100).toFixed(2)}%`} strong />
          <Row label="Of the shared pool, recovered" value={formatMoney(residualRecovered, ccy, 2)} strong />
        </div>
        <div className="px-4 py-3 border-t space-y-2" style={{ borderColor: "var(--border)" }}>
          <p className="text-2xs text-subtle leading-relaxed">
            <strong>The basis is an open question, not a settled one.</strong> The recovery share
            above divides <em>taxable supplies by total supplies</em> — turnover. There is a
            reading of the Executive Regulation (Cabinet Decision 52/2017, Article 55) under which
            the standard method instead divides <em>input tax amounts</em>. On this portfolio the
            two readings have been shown to differ by around AED 6,667 in a single quarter, which
            is past the AED 10,000 voluntary-disclosure threshold within two. Nobody on this
            project has read the regulation text. <strong>Ask the tax adviser</strong>, alongside
            Q-1, before relying on the ratio for a filing.
          </p>
          <p className="text-2xs text-subtle leading-relaxed">
            A floorspace method may suit a property portfolio better. It needs the FTA&apos;s
            written approval before it may be used, and the system will not apply one without an
            approval reference recorded against it.
          </p>
          {engineNotes.map((n) => (
            <p key={n} className="text-2xs text-muted leading-relaxed">
              {n}
            </p>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="VAT201 boxes"
          subtitle="As they appear on the FTA return — open a box to see what is underneath it"
        />
        <DataTable
          rows={BOXES}
          rowKey={(b) => b.no}
          empty={<TableEmpty title="No supplies this quarter" detail="Nothing to report." />}
          columns={[
            {
              key: "no",
              header: "Box",
              width: "4rem",
              render: (b) => (
                <span className="tnum text-subtle">
                  {b.no}
                  {!b.confirmed && (
                    <>
                      <span
                        className="ml-1"
                        style={{ color: "var(--caution)" }}
                        title="Box number unconfirmed"
                        aria-hidden
                      >
                        ?
                      </span>
                      <span className="sr-only"> — box number unconfirmed</span>
                    </>
                  )}
                </span>
              ),
            },
            {
              key: "label",
              header: "Description",
              render: (b) => (
                <Link href={href({ box: b.no })} className="block group">
                  <p className="font-medium group-hover:underline">{b.label}</p>
                  <p className="text-2xs text-subtle">{b.note}</p>
                </Link>
              ),
            },
            {
              key: "net",
              header: `Amount (${ccy})`,
              numeric: true,
              render: (b) => (b.net ? formatMoney(b.net, ccy, 2) : <span className="text-subtle">—</span>),
            },
            {
              key: "vat",
              header: `VAT (${ccy})`,
              numeric: true,
              render: (b) =>
                b.vat ? (
                  <span style={{ color: b.vat < 0 ? "var(--positive)" : undefined }}>
                    {formatMoney(b.vat, ccy, 2)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "open",
              header: "",
              width: "3rem",
              numeric: true,
              render: (b) => (
                <Link
                  href={href({ box: b.no })}
                  className="text-subtle hover:text-[var(--accent)]"
                  aria-label={`Open the journals behind box ${b.no}`}
                >
                  →
                </Link>
              ),
            },
          ]}
        />
        <div
          className="flex items-baseline justify-between gap-4 px-4 py-3 border-t"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <span className="text-xs font-semibold">
            {vat.value === 0
              ? "Net VAT for the period"
              : `Net VAT ${vat.value > 0 ? "payable to" : "refundable from"} the FTA`}
          </span>
          <span
            className="text-lg font-semibold tnum"
            style={{
              color:
                vat.value === 0
                  ? undefined
                  : vat.value > 0
                    ? "var(--caution)"
                    : "var(--positive)",
            }}
          >
            {formatMoney(Math.abs(vat.value), ccy, 2)}
          </span>
        </div>
        <p className="text-2xs text-subtle px-4 pb-3 leading-relaxed">
          Boxes 1, 3, 4 and 5 map to the FTA form through the reporting code on each tax code, so
          those numbers are right.{" "}
          <strong style={{ color: "var(--caution)" }}>Box 9 is marked ?</strong> because nothing in
          this system evidences it: the FTA form is understood to use box 9 for standard-rated
          expenses and box 13 for total recoverable tax. The amount is correct — the box number is
          not confirmed, so check it against the form before transcribing. Boxes 2, 6–8, 10–12 and
          14, and the 1a–1g split of box 1 by emirate, are not produced at all; every supply here
          is attributed to {emirate}, because no supply in this system carries an emirate of its
          own.
        </p>
      </Card>

      {openBox && (
        <Suspense fallback={<GridSkeleton count={2} />}>
          <BoxDrilldown
            box={openBox}
            from={from}
            to={to}
            ccy={ccy}
            closeHref={href({ box: null })}
            session={session}
          />
        </Suspense>
      )}

      <Card>
        <CardHeader
          title={`Annual wash-up — ${taxYear}`}
          subtitle="Reconciles the quarterly provisional apportionment to actual use"
        />
        <div className="px-4 pb-3 space-y-1.5 text-xs">
          <Row
            label="Quarters included"
            value={washup.quartersIncluded.length ? washup.quartersIncluded.join(", ") : "none"}
          />
          <Row label="Shared overhead VAT for the year" value={formatMoney(washup.totalResidualInput, ccy, 2)} />
          <Row label="Recovered quarter by quarter" value={formatMoney(washup.provisionallyRecovered, ccy, 2)} />
          <Row
            label="Recoverable on the year's actual mix"
            value={`${formatMoney(washup.annualRecoverable, ccy, 2)} (${(washup.annualRecoveryRatio * 100).toFixed(1)}%)`}
          />
          <Row
            label={
              washup.direction === "repayment"
                ? "Repayable to the FTA"
                : washup.direction === "additional_recovery"
                  ? "Additionally reclaimable"
                  : "Adjustment"
            }
            value={formatMoney(Math.abs(washup.adjustment), ccy, 2)}
            strong
          />
        </div>
        <div className="px-4 py-3 border-t space-y-2" style={{ borderColor: "var(--border)" }}>
          <p className="text-2xs font-semibold" style={{ color: washupDue ? "var(--caution)" : "var(--text-muted)" }}>
            {washupDue
              ? `Due — the ${taxYear} tax year has ended.`
              : `Not yet due — after 31 December ${taxYear}.`}
          </p>
          {washup.posting ? (
            <p className="text-2xs text-subtle leading-relaxed">
              The adjustment posts as{" "}
              {washup.posting.legs
                .map((l) => `${l.side === "debit" ? "DR" : "CR"} ${l.accountKey} ${formatMoney(l.amount, ccy, 2)}`)
                .join(" / ")}
              . <strong>Nothing has been posted.</strong> This system computes the adjustment; the
              journal has to be raised through the normal posting path, which this screen does not
              do.
            </p>
          ) : washup.quartersIncluded.length > 0 ? (
            <p className="text-2xs text-subtle leading-relaxed">
              Nothing to adjust: the quarters recovered exactly what the year&apos;s actual use
              entitles.
            </p>
          ) : null}
          {washup.notes.map((n) => (
            <p key={n} className="text-2xs text-muted leading-relaxed">
              {n}
            </p>
          ))}
          <p className="text-2xs text-subtle leading-relaxed">
            Computed from the ledger as it stands today rather than from the returns as filed —
            filed returns are not yet recorded, so a credit note raised after a quarter closed
            moves this figure. It is an estimate of the adjustment until then.
          </p>
        </div>
      </Card>

      {irrecoverable > 0 && (
        <Card className="p-4" as="div">
          <p className="label mb-1.5">Why some input VAT cannot be reclaimed</p>
          <p className="text-xs leading-relaxed text-muted">
            Residential rent is an <strong>exempt</strong> supply under UAE VAT law — not
            zero-rated. Both charge 0% output VAT, but they behave oppositely on the input side:
            a business making exempt supplies cannot recover the VAT it pays on costs serving
            them. {formatMoney(exemptSupplies, ccy, 0)} of this quarter&apos;s turnover is exempt
            residential rent, so only <strong>{ratio}%</strong> of shared overhead VAT is
            recoverable and{" "}
            <strong style={{ color: "var(--negative)" }}>
              {formatMoney(irrecoverable, ccy, 2)}
            </strong>{" "}
            is expensed to account 5720 rather than reclaimed.
          </p>
          <p className="text-2xs text-subtle mt-2 leading-relaxed">
            Reclaiming input VAT in full while letting residential property is one of the more
            common FTA assessment findings.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader title="By business and treatment" subtitle="Where the supplies came from" />
        <DataTable
          rows={byBusiness}
          rowKey={(r) => `${r.name}-${r.treatment}`}
          empty={<TableEmpty title="No invoices this quarter" detail="Nothing to report yet." />}
          columns={[
            { key: "bu", header: "Business", render: (r) => <BuTag name={r.name} color={r.color_token} /> },
            {
              key: "treatment",
              header: "Treatment",
              render: (r) => (
                <span
                  className="chip"
                  style={
                    r.treatment === "exempt"
                      ? { background: "var(--caution-soft)", color: "var(--caution)" }
                      : { background: "var(--accent-soft)", color: "var(--accent)" }
                  }
                >
                  {r.treatment === "standard" ? "5% standard" : r.treatment.replace(/_/g, " ")}
                </span>
              ),
            },
            { key: "inv", header: "Invoices", numeric: true, render: (r) => r.invoices },
            { key: "net", header: "Net", numeric: true, render: (r) => formatMoney(Number(r.net), ccy, 0) },
            {
              key: "vat",
              header: "Output VAT",
              numeric: true,
              render: (r) =>
                Number(r.vat) > 0 ? (
                  formatMoney(Number(r.vat), ccy, 2)
                ) : (
                  <span className="text-subtle">nil</span>
                ),
            },
          ]}
        />
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <a href={exportHref} download={exportName} className="btn btn-primary">
          Export for EmaraTax
        </a>
        <p className="text-2xs text-subtle max-w-[52ch] leading-relaxed">
          Downloads {exportName} — the boxes above plus the apportionment that produced them, for
          transcription into the portal. It is not an FTA upload file and it is not a filing.
        </p>
      </div>
    </div>
  );
}

/** Label/value line used by the apportionment and wash-up cards. */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className={`tnum ${strong ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * What a box is made of.
 *
 * Its own async component so the box table renders immediately and the
 * drill-through streams in behind a skeleton — opening a box should not delay
 * the return itself.
 */
async function BoxDrilldown({
  box,
  from,
  to,
  ccy,
  closeHref,
  session,
}: {
  box: string;
  from: string;
  to: string;
  ccy: string;
  closeHref: string;
  session: Awaited<ReturnType<typeof requireSession>>;
}) {
  const spec = DRILLABLE[box]!;

  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      if (spec.kind === "input_tax") {
        // Box 9 is computed from the ledger, so it opens onto the ledger: the
        // 1600 / 1610 / 5720 lines for the period, which are the three
        // attributions `receiveBill` splits input VAT into.
        return tx.execute<DrillRow>(sql`
          SELECT jl.id::text AS id,
                 j.journal_number AS ref,
                 j.posting_date::text AS dt,
                 COALESCE(j.narration, '') AS party,
                 COALESCE(b.name, 'Group') AS bu,
                 COALESCE(b.color_token, 'slate') AS color_token,
                 j.journal_number AS journals,
                 '0' AS net,
                 (jl.base_debit - jl.base_credit)::text AS vat,
                 a.code || ' · ' || a.name AS detail
            FROM journal_lines jl
            JOIN journals j ON j.id = jl.journal_id
            JOIN accounts a ON a.id = jl.account_id
            LEFT JOIN business_units b ON b.id = jl.business_unit_id
           WHERE a.system_key IN ('VAT_INPUT','VAT_INPUT_RESIDUAL','VAT_IRRECOVERABLE')
             AND j.posting_date BETWEEN ${from}::date AND ${to}::date
           ORDER BY j.posting_date DESC, j.journal_number DESC
           LIMIT 200
        `);
      }

      if (spec.kind === "reverse_charge") {
        return tx.execute<DrillRow>(sql`
          SELECT dl.id::text AS id,
                 d.doc_number AS ref,
                 d.issue_date::text AS dt,
                 d.party_name_snapshot AS party,
                 b.name AS bu,
                 b.color_token,
                 COALESCE((SELECT string_agg(DISTINCT j.journal_number, ', ')
                             FROM journals j
                            WHERE j.source_table = 'documents' AND j.source_id = d.id), '') AS journals,
                 ((dl.line_total - dl.tax_amount)
                   * CASE WHEN d.doc_type = 'debit_note' THEN -1 ELSE 1 END)::text AS net,
                 '0' AS vat,
                 COALESCE(dl.description, '') AS detail
            FROM document_lines dl
            JOIN documents d ON d.id = dl.document_id
            JOIN business_units b ON b.id = d.business_unit_id
            JOIN tax_codes tc ON tc.id = dl.tax_code_id
           WHERE d.doc_type IN ('bill','debit_note') AND d.direction = 'out'
             AND d.status NOT IN ('cancelled','void','draft')
             AND tc.treatment = 'reverse_charge'
             AND d.issue_date BETWEEN ${from}::date AND ${to}::date
           ORDER BY d.issue_date DESC, d.doc_number
           LIMIT 200
        `);
      }

      return tx.execute<DrillRow>(sql`
        SELECT dl.id::text AS id,
               d.doc_number AS ref,
               d.issue_date::text AS dt,
               d.party_name_snapshot AS party,
               b.name AS bu,
               b.color_token,
               COALESCE((SELECT string_agg(DISTINCT j.journal_number, ', ')
                           FROM journals j
                          WHERE j.source_table = 'documents' AND j.source_id = d.id), '') AS journals,
               ((dl.line_total - dl.tax_amount)
                 * CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END)::text AS net,
               (dl.tax_amount
                 * CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END)::text AS vat,
               COALESCE(dl.description, '') AS detail
          FROM document_lines dl
          JOIN documents d ON d.id = dl.document_id
          JOIN business_units b ON b.id = d.business_unit_id
          LEFT JOIN tax_codes tc ON tc.id = dl.tax_code_id
         WHERE d.doc_type IN ('invoice','credit_note') AND d.direction = 'in'
           AND d.status NOT IN ('cancelled','void','draft')
           AND COALESCE(tc.treatment::text, 'standard') = ${spec.treatment!}
           AND d.issue_date BETWEEN ${from}::date AND ${to}::date
         ORDER BY d.issue_date DESC, d.doc_number
         LIMIT 200
      `);
    },
  );

  return (
    <Card>
      <CardHeader
        title={spec.title}
        subtitle={
          spec.kind === "input_tax"
            ? "The 1600 / 1610 / 5720 ledger lines this box is built from"
            : "The document lines this box is built from, and the journals they posted"
        }
        action={
          <Link href={closeHref} className="text-2xs text-muted hover:text-[var(--text)]">
            Close
          </Link>
        }
      />
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <TableEmpty
            title="Nothing in this box for the period"
            detail={
              spec.kind === "reverse_charge"
                ? "No imported services are recorded. Bills do not carry a tax code today, so nothing can be identified as reverse-charge — see the note on box 3."
                : "No lines contributed to this box between these dates."
            }
          />
        }
        columns={[
          { key: "ref", header: "Reference", render: (r) => <span className="font-medium">{r.ref}</span> },
          { key: "dt", header: "Date", render: (r) => <span className="tnum text-muted">{r.dt}</span> },
          { key: "bu", header: "Business", render: (r) => <BuTag name={r.bu} color={r.color_token} /> },
          {
            key: "detail",
            header: "Detail",
            render: (r) => (
              <div>
                <p className="truncate max-w-[28ch]">{r.detail || r.party}</p>
                {r.journals && <p className="text-2xs text-subtle tnum">{r.journals}</p>}
              </div>
            ),
          },
          {
            key: "net",
            header: `Net (${ccy})`,
            numeric: true,
            render: (r) =>
              Number(r.net) ? formatMoney(Number(r.net), ccy, 2) : <span className="text-subtle">—</span>,
          },
          {
            key: "vat",
            header: `VAT (${ccy})`,
            numeric: true,
            render: (r) =>
              Number(r.vat) ? formatMoney(Number(r.vat), ccy, 2) : <span className="text-subtle">—</span>,
          },
        ]}
      />
      {rows.length === 200 && (
        <p className="text-2xs text-subtle px-4 pb-3">
          Showing the 200 most recent lines. The box total above is the whole period.
        </p>
      )}
    </Card>
  );
}
