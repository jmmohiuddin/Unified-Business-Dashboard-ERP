import Link from "next/link";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { rentRunAction } from "@/lib/actions/rentals";
import { DataTable, FilterTabs, PageHeader, StatStrip, TableEmpty } from "@/components/page";
/**
 * See the note in `lib/actions/rentals.ts`: this reaches into the service
 * module directly only until the coordinator adds the rentals line to the
 * `@nexus/core` services barrel.
 */
import {
  previewRentRun,
  type RentRunPreview,
  type RentRunWarning,
} from "../../../../../../../packages/core/src/services/rentals.ts";

export const dynamic = "force-dynamic";

/**
 * THE RENT RUN — WF-05 §9.2.
 *
 * Two steps, and the first one is the product. Everything above the button is
 * there so that an accountant can refuse to press it.
 *
 * The organising decision is that the VAT split is not a detail shown after the
 * fact — it is the first thing on the screen after the totals, stated in words
 * rather than as a rate. Residential rent is exempt and standalone parking is
 * standard-rated; the two share one lease model and one screen, so the only
 * thing standing between a misconfigured lease and thirty wrong invoices is
 * somebody reading this split and noticing that a flat is sitting in the 5%
 * row. That is the whole argument for a preview step, and PRD §6 Epic B calls
 * this the highest-return feature in the backlog for the same reason.
 *
 * Nothing on this page writes. The preview is a pure read that runs the exact
 * selection and arithmetic the commit will run — not an approximation of it —
 * so the figure on screen is the figure that posts.
 */

/** Months the operator can run, newest first: the current one and the three before. */
function selectableMonths(today: string): { key: string; label: string }[] {
  const [y, m] = today.split("-").map((p) => parseInt(p, 10));
  const names = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];
  const out: { key: string; label: string }[] = [];
  for (let back = 0; back < 4; back++) {
    const d = new Date(Date.UTC(y!, m! - 1 - back, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: `${names[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}` });
  }
  return out;
}

const SEVERITY_STYLE: Record<RentRunWarning["severity"], { bg: string; fg: string; label: string }> = {
  critical: { bg: "var(--negative-soft)", fg: "var(--negative)", label: "Check before committing" },
  warning: { bg: "var(--caution-soft)", fg: "var(--caution)", label: "Worth knowing" },
  info: { bg: "var(--surface-3)", fg: "var(--text-muted)", label: "Already handled" },
};

export default async function RentRunPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const months = selectableMonths(today);
  const { period = months[0]!.key } = await searchParams;

  // PERMISSION-DENIED, per WF-05 §17: the action is absent, not disabled. A
  // greyed-out "Create 34 invoices" tells a receptionist there is a button they
  // are not allowed to press, which is an invitation rather than a boundary.
  const mayPreview = can(session.principal, "document:read");
  const mayCommit = can(session.principal, "document:create");

  let preview: RentRunPreview | null = null;
  let failure: string | null = null;
  if (mayPreview) {
    try {
      preview = await withTenant(
        { tenantId: session.tenantId, userId: session.userId },
        async (tx) =>
          previewRentRun(
            {
              tx,
              tenantId: session.tenantId,
              principal: session.principal,
              today,
              baseCurrency: session.baseCurrency,
            },
            { period },
          ),
      );
    } catch (err) {
      // ERROR STATE, per WF-05 §17: "Preview error, nothing posted." Said out
      // loud, because the anxiety a failed rent run produces is entirely about
      // whether it half-ran.
      failure = err instanceof Error ? err.message : "The preview could not be built.";
    }
  }

  const header = (
    <PageHeader
      title="Rent run"
      subtitle={
        preview
          ? `${preview.label} · every lease whose rent falls due this month`
          : "Generate a month of rent invoices in one action"
      }
      back={{ href: "/rentals", label: "Rentals" }}
      actions={
        <FilterTabs
          basePath="/rentals/rent-run"
          param="period"
          active={period}
          options={months.map((m) => ({ key: m.key, label: m.label }))}
        />
      }
    />
  );

  if (!mayPreview) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
        {header}
        <Card>
          <EmptyState
            icon="—"
            title="Not available for your role"
            detail="Raising rent invoices needs access to sales documents. Ask the owner or the accountant to run it."
          />
        </Card>
      </div>
    );
  }

  if (failure || !preview) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
        {header}
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            The preview could not be built
          </p>
          <p className="text-xs text-muted mt-1.5 leading-relaxed">{failure}</p>
          <p className="text-2xs text-subtle mt-2">
            Nothing has been posted. No invoice is created until the preview is approved.
          </p>
        </Card>
      </div>
    );
  }

  const critical = preview.warnings.filter((w) => w.severity === "critical");
  const advisory = preview.warnings.filter((w) => w.severity === "warning");
  const handled = preview.warnings.filter((w) => w.severity === "info");
  const nothingToDo = preview.lines.length === 0;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
      {header}

      <StatStrip
        stats={[
          {
            label: "Invoices to create",
            value: String(preview.totals.invoices),
            tone: preview.totals.invoices > 0 ? "accent" : "default",
            hint: preview.alreadyBilled.length
              ? `${preview.alreadyBilled.length} already billed`
              : undefined,
          },
          { label: "Net rent", value: formatMoney(preview.totals.net, ccy, 0) },
          {
            label: "VAT",
            value: formatMoney(preview.totals.vat, ccy, 2),
            tone: preview.totals.vat > 0 ? "caution" : "default",
            hint: preview.totals.vat > 0 ? "standard-rated leases only" : "all exempt",
          },
          { label: "Total to bill", value: formatMoney(preview.totals.gross, ccy, 0) },
          {
            label: "Already run?",
            value: preview.alreadyRun ? "Yes" : "No",
            tone: preview.alreadyRun ? "positive" : "default",
            hint: preview.alreadyRun ? "nothing left to raise" : undefined,
          },
        ]}
      />

      {/* ── The split. The reason this screen exists. ────────────────────── */}
      <Card>
        <CardHeader
          title="VAT treatment"
          subtitle="Read this before you press the button — it is the highest-risk figure in the pilot business"
        />
        {preview.byTreatment.length === 0 ? (
          <TableEmpty
            title="Nothing to split"
            detail="No lease falls due in this period, so there is no VAT position to check."
          />
        ) : (
          <div className="px-4 pb-4 space-y-2">
            {preview.byTreatment.map((g) => (
              <div
                key={g.treatment}
                className="rounded-[var(--radius-md)] px-3 py-2.5"
                style={{
                  background: g.treatment === "standard" ? "var(--caution-soft)" : "var(--surface-2)",
                }}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="text-xs font-semibold capitalize">
                    {g.treatment.replace(/_/g, " ")}
                    <span className="ml-1.5 text-2xs font-normal text-muted tnum">
                      {g.taxCodes.join(", ")}
                    </span>
                  </p>
                  <p className="text-xs tnum">
                    <span className="text-muted">{g.invoices} invoices · net </span>
                    <span className="font-semibold">{formatMoney(g.net, ccy, 2)}</span>
                    <span className="text-muted"> · VAT </span>
                    <span className="font-semibold">{formatMoney(g.vat, ccy, 2)}</span>
                    <span className="text-muted"> · </span>
                    <span className="font-semibold">{formatMoney(g.gross, ccy, 2)}</span>
                  </p>
                </div>
                <p className="text-2xs mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  {g.label}
                </p>
              </div>
            ))}
            <p className="text-2xs text-subtle leading-relaxed pt-1">
              Treatment comes from the tax code on each lease&rsquo;s own charge item, never from
              the unit type. Whether a standalone parking bay is standard-rated — and whether the
              group should apply for floorspace apportionment — is still with the tax adviser
              (open question Q-1). When that is answered it is a change to the tax code, not to
              this screen.
            </p>
          </div>
        )}
      </Card>

      {/* ── Warnings ────────────────────────────────────────────────────── */}
      {preview.warnings.length > 0 && (
        <Card>
          <CardHeader
            title="Before you commit"
            subtitle={`${critical.length} to check · ${advisory.length} worth knowing · ${handled.length} already handled`}
          />
          <div className="px-4 pb-4 space-y-3">
            {([critical, advisory, handled] as RentRunWarning[][]).map((group) =>
              group.length === 0 ? null : (
                <div key={group[0]!.severity}>
                  <p
                    className="label mb-1.5"
                    style={{ color: SEVERITY_STYLE[group[0]!.severity].fg }}
                  >
                    {SEVERITY_STYLE[group[0]!.severity].label}
                  </p>
                  <ul className="space-y-1">
                    {group.map((w, i) => (
                      <li
                        key={`${w.leaseId}-${w.code}-${i}`}
                        className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
                        style={{
                          background: SEVERITY_STYLE[w.severity].bg,
                          color: SEVERITY_STYLE[w.severity].fg,
                        }}
                      >
                        <Link href={`/rentals/lease/${w.leaseId}`} className="font-semibold underline">
                          {w.leaseNumber} · {w.unitCode}
                        </Link>{" "}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        </Card>
      )}

      {/* ── What will be created ────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Invoices to be created"
          subtitle="Each one names the lease it derives from and the treatment applied"
        />
        <DataTable
          rows={preview.lines}
          rowKey={(l) => l.leaseId}
          empty={
            preview.alreadyRun ? (
              <EmptyState
                title={`${preview.label} has already been run`}
                detail={`Every lease due this month is invoiced — ${preview.alreadyBilled.length} of them. Running it again creates nothing.`}
              />
            ) : (
              <TableEmpty
                title="No active leases fall due"
                detail="No lease has a billing date in this month. Create a lease, or pick a different month."
              />
            )
          }
          columns={[
            {
              key: "unit",
              header: "Unit",
              render: (l) => (
                <div className="min-w-0">
                  <p className="font-medium">{l.unitCode}</p>
                  <Link
                    href={`/rentals/lease/${l.leaseId}`}
                    className="text-2xs text-subtle hover:underline"
                  >
                    {l.leaseNumber}
                  </Link>
                </div>
              ),
            },
            {
              key: "party",
              header: "Tenant",
              render: (l) => <span className="truncate">{l.partyName}</span>,
            },
            {
              key: "period",
              header: "Covers",
              render: (l) => (
                <div>
                  <p className="text-2xs text-muted tnum">
                    {l.periodStart} → {l.periodEnd}
                  </p>
                  {l.prorated && (
                    <p className="text-2xs" style={{ color: "var(--caution)" }}>
                      apportioned {l.daysCharged}/{l.daysInPeriod} days
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: "vat",
              header: "Treatment",
              render: (l) => (
                <span
                  className="chip"
                  style={
                    l.taxTreatment === "exempt"
                      ? { background: "var(--surface-3)", color: "var(--text-muted)" }
                      : { background: "var(--caution-soft)", color: "var(--caution)" }
                  }
                >
                  {l.taxTreatment === "exempt" ? "exempt" : `${l.taxRatePercent}%`}
                </span>
              ),
            },
            {
              key: "net",
              header: "Net",
              numeric: true,
              render: (l) => formatMoney(l.net, ccy, 2),
            },
            {
              key: "tax",
              header: "VAT",
              numeric: true,
              render: (l) =>
                l.vat > 0 ? formatMoney(l.vat, ccy, 2) : <span className="text-subtle">—</span>,
            },
            {
              key: "gross",
              header: "Total",
              numeric: true,
              render: (l) => <span className="font-semibold">{formatMoney(l.gross, ccy, 2)}</span>,
            },
          ]}
        />
      </Card>

      {/* ── Step two ────────────────────────────────────────────────────── */}
      {mayCommit && !nothingToDo && (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold mb-1">
            Create {preview.totals.invoices} invoices for {preview.label}
          </p>
          <p className="text-2xs text-subtle mb-3 leading-relaxed">
            {formatMoney(preview.totals.gross, ccy, 2)} in total, of which{" "}
            {formatMoney(preview.totals.vat, ccy, 2)} is output VAT on the standard-rated leases.
            Running this month again afterwards creates nothing.
          </p>
          <ActionForm
            action={rentRunAction}
            submitLabel={`Create ${preview.totals.invoices} invoices`}
            pendingLabel="Raising invoices…"
            hidden={{ period: preview.period }}
            confirm={
              critical.length > 0
                ? `${critical.length} lease${critical.length === 1 ? " has" : "s have"} a problem flagged above. This posts ${preview.totals.invoices} invoices and ${formatMoney(preview.totals.gross, ccy, 2)} to the ledger. There is no bulk undo — each invoice would have to be credited individually.`
                : `Posts ${preview.totals.invoices} invoices and ${formatMoney(preview.totals.gross, ccy, 2)} to the ledger, with ${formatMoney(preview.totals.vat, ccy, 2)} of output VAT. There is no bulk undo — each invoice would have to be credited individually.`
            }
          />
        </Card>
      )}

      {!mayCommit && (
        <Card className="p-4" as="div">
          <p className="text-2xs text-subtle leading-relaxed">
            You can read this preview but not raise the invoices. That needs permission to create
            sales documents.
          </p>
        </Card>
      )}

      <Card className="p-4" as="div">
        <p className="label mb-1.5">How a month is apportioned</p>
        <p className="text-xs leading-relaxed text-muted">
          Rent is charged on each lease&rsquo;s own anniversary day, not on the first of the month,
          because that is the date the tenant&rsquo;s cheque is written for and the period the
          cheque register matches against. A lease that starts, ends or renews part-way through a
          period is charged for the days it was actually let, over the real length of that period
          — 28, 30 or 31 days, never a notional 30.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          A renewal that changes the rent mid-period produces two lines rather than one: the
          outgoing term to the day before the renewal, and the new term from its start. Neither
          restates the other&rsquo;s days, so a VAT return that has already been filed is never
          rewritten.
        </p>
      </Card>
    </div>
  );
}
