import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { daysUntil, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { DataTable, DaysPill, PageHeader, StatStrip, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * UAE compliance register.
 *
 * Everything on this page can stop the business if it lapses, which is why it
 * is a first-class screen rather than a settings tab. An expired trade licence
 * freezes the company bank account and blocks every visa renewal; an
 * unregistered tenancy cannot be enforced at the Rental Dispute Centre; a
 * missed VAT return carries an escalating penalty.
 */
export default async function CompliancePage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [
    { metricId: "vat_return_position" },
    { metricId: "gratuity_liability", params: { limit: 50 } },
    { metricId: "corporate_tax_estimate" },
  ]);
  const vat = metric(m, "vat_return_position");
  const ctax = metric(m, "corporate_tax_estimate");
  const gratuity = metric(m, "gratuity_liability");

  const { licences, staff, unregistered } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const licences = await tx.execute<{
        id: string; name: string; color_token: string; trn: string | null;
        licence_no: string | null; authority: string | null; licence_expiry: string | null;
        card_expiry: string | null; is_legal: boolean;
      }>(sql`
        SELECT id, name, color_token, tax_registration_no AS trn,
               trade_license_no AS licence_no, licensing_authority AS authority,
               trade_license_expiry::text AS licence_expiry,
               establishment_card_expiry::text AS card_expiry,
               is_separate_legal_entity AS is_legal
          FROM business_units WHERE is_active = true ORDER BY trade_license_expiry
      `);

      const staff = await tx.execute<{
        id: string; full_name: string; designation: string; nationality: string | null;
        emirates_id_hint: string | null; visa_expiry: string | null;
        labour_card_expiry: string | null; passport_expiry: string | null;
      }>(sql`
        -- Only the masked hint is read here. The full Emirates ID is encrypted
        -- and a compliance list has no business decrypting 14 of them to render
        -- a table nobody is going to copy a number out of.
        SELECT id, full_name, designation, nationality, emirates_id_hint,
               visa_expiry::text, labour_card_expiry::text, passport_expiry::text
          FROM employees
         WHERE status IN ('active','probation','on_leave')
         ORDER BY visa_expiry NULLS LAST
      `);

      const unregistered = await tx.execute<{
        id: string; lease_number: string; unit: string; party: string; starts_on: string;
      }>(sql`
        SELECT l.id, l.lease_number, u.code AS unit, p.display_name AS party,
               l.starts_on::text
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN parties p ON p.id = l.party_id
         WHERE l.status = 'active' AND l.ejari_number IS NULL
         ORDER BY l.starts_on
      `);

      return { licences, staff, unregistered };
    },
  );

  const expiringSoon = (d: string | null) => d !== null && daysUntil(d, today) <= 90;
  const urgentCount =
    licences.filter((l) => expiringSoon(l.licence_expiry)).length +
    staff.filter((s) => expiringSoon(s.visa_expiry)).length +
    unregistered.length;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Compliance"
        subtitle="Dubai Department of Economy & Tourism · Federal Tax Authority · MOHRE"
      />

      <Card className="px-4 py-2.5" as="div">
        <p className="text-2xs text-subtle leading-relaxed">
          Identity documents on this page are <strong>encrypted at rest</strong> and shown masked.
          Emirates IDs, passport numbers and IBANs are stored as AES-256-GCM ciphertext with a
          keyed blind index for lookup, so a stolen backup yields nothing usable. Full values are
          decrypted only where a process genuinely needs them — the WPS payroll file being the
          one example.
        </p>
      </Card>

      <StatStrip
        stats={[
          {
            label: "Needs action ≤90 days",
            value: String(urgentCount),
            tone: urgentCount > 0 ? "negative" : "positive",
            hint: "Licences, visas and Ejari",
          },
          {
            label: "VAT this quarter",
            value: vat ? formatMoney(Math.abs(vat.value), ccy, 0) : "—",
            tone: (vat?.value ?? 0) > 0 ? "caution" : "positive",
            hint: (vat?.value ?? 0) > 0 ? "payable to FTA" : "refundable",
          },
          {
            label: "Corporate tax estimate",
            value: ctax ? formatMoney(ctax.value, ccy, 0) : "—",
            hint: "9% above AED 375k",
          },
          {
            label: "Gratuity liability",
            value: gratuity ? formatMoney(gratuity.value, ccy, 0) : "—",
            tone: "caution",
            hint: "Accrued, not yet paid",
          },
          {
            label: "Leases without Ejari",
            value: String(unregistered.length),
            tone: unregistered.length > 0 ? "negative" : "positive",
            hint: "Unenforceable at the RDC",
          },
        ]}
      />

      {/* ── Trade licences ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Trade licences"
          subtitle="An expired licence freezes the bank account and blocks visa renewals"
        />
        <DataTable
          rows={licences}
          rowKey={(l) => l.id}
          empty={<TableEmpty title="No businesses" detail="Nothing to show." />}
          columns={[
            {
              key: "name", header: "Business",
              render: (l) => (
                <span className="inline-flex items-center gap-2">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: `var(--color-bu-${l.color_token})` }}
                    aria-hidden
                  />
                  <span className="font-medium">{l.name}</span>
                  {l.is_legal && (
                    <span className="text-2xs text-subtle">separate entity</span>
                  )}
                </span>
              ),
            },
            { key: "no", header: "Licence no.", render: (l) => <span className="tnum">{l.licence_no ?? "—"}</span> },
            { key: "trn", header: "VAT TRN", render: (l) => <span className="tnum text-muted">{l.trn ?? "—"}</span> },
            { key: "auth", header: "Authority", render: (l) => <span className="text-muted">{l.authority ?? "—"}</span> },
            { key: "exp", header: "Licence expires", render: (l) => l.licence_expiry ?? "—" },
            {
              key: "days", header: "", numeric: true,
              render: (l) => (l.licence_expiry ? <DaysPill days={daysUntil(l.licence_expiry, today)} /> : null),
            },
            {
              key: "card", header: "Est. card", numeric: true,
              render: (l) => (l.card_expiry ? <DaysPill days={daysUntil(l.card_expiry, today)} /> : <span className="text-subtle">—</span>),
            },
          ]}
        />
      </Card>

      {/* ── Visas and labour cards ─────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Residency & labour documents"
          subtitle="Employing someone on an expired visa exposes the company to per-person fines"
        />
        <DataTable
          rows={staff}
          rowKey={(s) => s.id}
          empty={<TableEmpty title="No active employees" detail="Nothing to track." />}
          columns={[
            {
              key: "name", header: "Employee",
              render: (s) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{s.full_name}</p>
                  <p className="text-2xs text-subtle truncate">
                    {s.designation}
                    {s.nationality ? ` · ${s.nationality}` : ""}
                  </p>
                </div>
              ),
            },
            {
              key: "eid", header: "Emirates ID",
              render: (s) => (
                <span className="tnum text-muted" title="Encrypted at rest — masked for display">
                  {s.emirates_id_hint ?? "—"}
                </span>
              ),
            },
            { key: "visa", header: "Visa expires", render: (s) => s.visa_expiry ?? "—" },
            {
              key: "vd", header: "", numeric: true,
              render: (s) => (s.visa_expiry ? <DaysPill days={daysUntil(s.visa_expiry, today)} /> : null),
            },
            {
              key: "lc", header: "Labour card", numeric: true,
              render: (s) => (s.labour_card_expiry ? <DaysPill days={daysUntil(s.labour_card_expiry, today)} /> : <span className="text-subtle">—</span>),
            },
            {
              key: "pp", header: "Passport", numeric: true,
              render: (s) => (s.passport_expiry ? <DaysPill days={daysUntil(s.passport_expiry, today)} /> : <span className="text-subtle">—</span>),
            },
          ]}
        />
      </Card>

      {/* ── Ejari ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Ejari registration"
          subtitle="Mandatory in Dubai — an unregistered tenancy cannot be enforced and the tenant cannot activate DEWA"
        />
        {unregistered.length === 0 ? (
          <EmptyState
            title="Every active lease is registered"
            detail="All tenancy contracts carry an Ejari number."
          />
        ) : (
          <DataTable
            rows={unregistered}
            rowKey={(l) => l.id}
            empty={<TableEmpty title="None" detail="" />}
            columns={[
              { key: "lease", header: "Lease", render: (l) => <span className="font-medium">{l.lease_number}</span> },
              { key: "unit", header: "Unit", render: (l) => l.unit },
              { key: "party", header: "Tenant", render: (l) => l.party },
              { key: "start", header: "Started", render: (l) => l.starts_on },
              {
                key: "age", header: "Unregistered for", numeric: true,
                render: (l) => (
                  <span style={{ color: "var(--negative)" }} className="tnum font-semibold">
                    {Math.abs(daysUntil(l.starts_on, today))} days
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
