import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
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
 * This screen deliberately does not offer to file. It produces the position and
 * shows the working; submission is the accountant's, on the FTA portal.
 */
export default async function VatPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "vat_return_position" }]);
  const vat = metric(m, "vat_return_position");

  const qStartMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const quarterStart = `${today.slice(0, 4)}-${String(qStartMonth).padStart(2, "0")}-01`;
  const quarterLabel = `Q${Math.floor((qStartMonth - 1) / 3) + 1} ${today.slice(0, 4)}`;

  const byBusiness = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) =>
      tx.execute<{
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
           AND d.issue_date BETWEEN ${quarterStart}::date AND ${today}::date
         GROUP BY b.name, b.color_token, tc.treatment
         ORDER BY 4 DESC
      `),
  );

  const box = (k: string) => vat?.breakdown?.find((b) => b.key === k)?.value ?? 0;
  const ratio = box("ratio");
  const irrecoverable = box("irrecoverable");

  /** The FTA form, box by box. */
  const BOXES = [
    { no: "1", label: "Standard-rated supplies", net: box("box1"), vat: box("output"),
      note: `Emirate of ${"Dubai"}` },
    { no: "3", label: "Reverse-charge provisions", net: 0, vat: 0, note: "Imported services" },
    { no: "4", label: "Zero-rated supplies", net: box("box4"), vat: 0, note: "Input VAT still recoverable" },
    { no: "5", label: "Exempt supplies", net: box("box5"), vat: 0,
      note: "Residential rent — input VAT NOT recoverable" },
    { no: "9", label: "Recoverable input VAT", net: 0, vat: -Math.abs(box("input")),
      note: "After apportionment" },
  ];

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1200px] mx-auto space-y-5">
      <PageHeader
        title={`VAT return — ${quarterLabel}`}
        subtitle={`Period ${quarterStart} to ${today} · filed quarterly with the Federal Tax Authority`}
        back={{ href: "/compliance", label: "Compliance" }}
      />

      <StatStrip
        stats={[
          {
            label: vat && vat.value > 0 ? "Payable to FTA" : "Refundable",
            value: formatMoney(Math.abs(vat?.value ?? 0), ccy, 0),
            tone: vat && vat.value > 0 ? "caution" : "positive",
          },
          { label: "Output VAT collected", value: formatMoney(box("output"), ccy, 0) },
          { label: "Input VAT reclaimed", value: formatMoney(Math.abs(box("input")), ccy, 0) },
          {
            label: "Irrecoverable input VAT",
            value: formatMoney(irrecoverable, ccy, 0),
            tone: irrecoverable > 0 ? "negative" : "default",
            hint: "A cost, not a reclaim",
          },
          { label: "Recovery ratio", value: `${ratio}%`, hint: "Taxable ÷ total supplies" },
        ]}
      />

      <Card>
        <CardHeader title="VAT201 boxes" subtitle="As they appear on the FTA return" />
        <DataTable
          rows={BOXES}
          rowKey={(b) => b.no}
          empty={<TableEmpty title="No supplies this quarter" detail="Nothing to report." />}
          columns={[
            { key: "no", header: "Box", width: "3rem", render: (b) => <span className="tnum text-subtle">{b.no}</span> },
            {
              key: "label", header: "Description",
              render: (b) => (
                <div>
                  <p className="font-medium">{b.label}</p>
                  <p className="text-2xs text-subtle">{b.note}</p>
                </div>
              ),
            },
            { key: "net", header: "Amount (AED)", numeric: true,
              render: (b) => (b.net ? formatMoney(b.net, ccy, 2) : <span className="text-subtle">—</span>) },
            {
              key: "vat", header: "VAT (AED)", numeric: true,
              render: (b) =>
                b.vat ? (
                  <span style={{ color: b.vat < 0 ? "var(--positive)" : undefined }}>
                    {formatMoney(b.vat, ccy, 2)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
          ]}
        />
        <div
          className="flex items-baseline justify-between gap-4 px-4 py-3 border-t"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <span className="text-xs font-semibold">
            Net VAT {vat && vat.value > 0 ? "payable to" : "refundable from"} the FTA
          </span>
          <span
            className="text-lg font-semibold tnum"
            style={{ color: vat && vat.value > 0 ? "var(--caution)" : "var(--positive)" }}
          >
            {formatMoney(Math.abs(vat?.value ?? 0), ccy, 2)}
          </span>
        </div>
      </Card>

      {irrecoverable > 0 && (
        <Card className="p-4" as="div">
          <p className="label mb-1.5">Why some input VAT cannot be reclaimed</p>
          <p className="text-xs leading-relaxed text-muted">
            Residential rent is an <strong>exempt</strong> supply under UAE VAT law — not
            zero-rated. Both charge 0% output VAT, but they behave oppositely on the input side:
            a business making exempt supplies cannot recover the VAT it pays on costs serving
            them. {formatMoney(box("box5"), ccy, 0)} of this quarter&apos;s turnover is exempt
            residential rent, so only <strong>{ratio}%</strong> of shared overhead VAT is
            recoverable and{" "}
            <strong style={{ color: "var(--negative)" }}>
              {formatMoney(irrecoverable, ccy, 2)}
            </strong>{" "}
            is expensed to account 5720 rather than reclaimed.
          </p>
          <p className="text-2xs text-subtle mt-2 leading-relaxed">
            Reclaiming input VAT in full while letting residential property is one of the more
            common FTA assessment findings. The apportionment here uses the standard method:
            taxable supplies divided by total supplies.
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
              key: "treatment", header: "Treatment",
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
              key: "vat", header: "Output VAT", numeric: true,
              render: (r) =>
                Number(r.vat) > 0 ? formatMoney(Number(r.vat), ccy, 2)
                  : <span className="text-subtle">nil</span>,
            },
          ]}
        />
      </Card>
    </div>
  );
}
