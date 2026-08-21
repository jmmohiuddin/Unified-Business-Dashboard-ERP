import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm, Field } from "@/components/action-form";
import { createLeaseAction } from "@/lib/actions/rentals";
import { DataTable, PageHeader, StatusPill, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * LEASE EDITOR — WF-05 §9.3.
 *
 * Two steps, because the whole screen depends on the unit and this app ships
 * essentially no client JavaScript: choose the unit from the vacancy list, then
 * fill in the tenancy against it. Picking the unit first is not a compromise —
 * it is what makes the VAT explanation possible. The wireframe's "Type —
 * derived from unit / VAT exempt" and the paragraph at the bottom are the point
 * of the design: the treatment is explained AT THE MOMENT IT IS SET, in the
 * form, not in documentation nobody opens. A server-rendered form cannot do
 * that for a unit the operator has not chosen yet.
 *
 * The tenant must already exist as a customer. Creating a party from here would
 * mean reimplementing the encrypted-PII path that `parties` requires, and a
 * second implementation of that is exactly what the service layer exists to
 * prevent.
 */

const TREATMENT_COPY: Record<string, { headline: string; body: string }> = {
  exempt: {
    headline: "Residential rent is VAT exempt.",
    body:
      "No VAT is charged on this lease. The other half matters just as much: VAT you pay on " +
      "costs attributable to this unit — maintenance, agency fees, service charge — cannot be " +
      "reclaimed, because input VAT on an exempt supply is not recoverable.",
  },
  standard: {
    headline: "This lease is standard rated at 5%.",
    body:
      "VAT is charged on top of the rent and is payable to the FTA whether or not the tenant has " +
      "paid you. Input VAT on costs for this unit is recoverable in full. Whether a standalone " +
      "parking bay belongs here is still with the tax adviser (open question Q-1) — if the answer " +
      "changes, change the tax code on the rent item, not the lease.",
  },
  zero_rated: {
    headline: "This lease is zero rated.",
    body:
      "0% is charged, but unlike an exempt supply the input VAT on costs for this unit is still " +
      "recoverable in full. The difference does not show on the invoice; it shows on the return.",
  },
};

export default async function NewLeasePage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string }>;
}) {
  const session = await requireSession();
  const { unit: unitId } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  // PERMISSION-DENIED: the route renders an explanation rather than a form.
  if (!can(session.principal, "lease:create")) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="New lease" back={{ href: "/rentals", label: "Rentals" }} />
        <Card>
          <EmptyState
            icon="—"
            title="Not available for your role"
            detail="Signing a tenancy needs the property manager or owner role."
          />
        </Card>
      </div>
    );
  }

  const { units, parties, chosen } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const units = await tx.execute<{
        id: string; code: string; name: string | null; kind: string; status: string;
        list_rent: string; deposit_months: string; bedrooms: number | null;
        site: string; bu: string; bu_code: string;
      }>(sql`
        SELECT u.id, u.code, u.name, u.kind::text, u.status::text, u.list_rent,
               u.deposit_months, u.bedrooms, st.name AS site, b.name AS bu, b.code AS bu_code
          FROM units u
          JOIN sites st ON st.id = u.site_id
          JOIN business_units b ON b.id = u.business_unit_id
         WHERE u.status <> 'occupied'
           AND NOT EXISTS (
             SELECT 1 FROM leases l
              WHERE l.unit_id = u.id AND l.status IN ('draft','active','expiring','defaulted')
                AND l.deleted_at IS NULL
           )
         ORDER BY b.sort_order, u.code
      `);

      const parties = await tx.execute<{ id: string; display_name: string; phone: string | null }>(sql`
        SELECT id, display_name, primary_phone AS phone
          FROM parties
         WHERE is_customer = true AND deleted_at IS NULL
         ORDER BY is_tenant_renter DESC, display_name
         LIMIT 500
      `);

      const chosen = unitId
        ? (
            await tx.execute<{
              id: string; code: string; name: string | null; kind: string;
              list_rent: string; deposit_months: string; bedrooms: number | null;
              area: string | null; site: string; bu: string; bu_id: string;
              item_id: string | null; item_name: string | null;
              tax_code: string | null; tax_rate: string | null; treatment: string | null;
            }>(sql`
              SELECT u.id, u.code, u.name, u.kind::text, u.list_rent, u.deposit_months,
                     u.bedrooms, u.area_sqft AS area, st.name AS site,
                     b.name AS bu, b.id AS bu_id,
                     i.id AS item_id, i.name AS item_name,
                     tc.code AS tax_code, tc.rate AS tax_rate, tc.treatment::text AS treatment
                FROM units u
                JOIN sites st ON st.id = u.site_id
                JOIN business_units b ON b.id = u.business_unit_id
                LEFT JOIN LATERAL (
                  SELECT id, name, tax_code_id FROM items
                   WHERE type = 'rent' AND is_active = true AND business_unit_id = u.business_unit_id
                   ORDER BY created_at LIMIT 1
                ) i ON TRUE
                LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
               WHERE u.id = ${unitId}::uuid
            `)
          )[0] ?? null
        : null;

      return { units, parties, chosen };
    },
  );

  // ── Step one: which space is being let ────────────────────────────────
  if (!chosen) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
        <PageHeader
          title="New lease"
          subtitle="Choose the unit first — its type sets the VAT treatment of the whole tenancy"
          back={{ href: "/rentals", label: "Rentals" }}
        />
        <Card>
          <CardHeader title="Available to let" subtitle="Units with no live tenancy against them" />
          <DataTable
            rows={units}
            rowKey={(u) => u.id}
            empty={
              <TableEmpty
                title="Every unit is let"
                detail="There is no vacant apartment or bay to write a lease against. Terminate or expire a tenancy first."
              />
            }
            columns={[
              {
                key: "code",
                header: "Unit",
                render: (u) => (
                  <div>
                    <p className="font-medium">{u.name ?? u.code}</p>
                    <p className="text-2xs text-subtle">{u.site}</p>
                  </div>
                ),
              },
              {
                key: "kind",
                header: "Type",
                render: (u) => (
                  <span className="text-muted">
                    {u.kind === "parking_bay" ? "Parking bay" : `${u.bedrooms ?? "?"} bed`}
                  </span>
                ),
              },
              { key: "status", header: "Status", render: (u) => <StatusPill status={u.status} /> },
              {
                key: "rent",
                header: "List rent / month",
                numeric: true,
                render: (u) => formatMoney(Number(u.list_rent), ccy, 0),
              },
              {
                key: "do",
                header: "",
                render: (u) => (
                  <Link href={`/rentals/lease/new?unit=${u.id}`} className="btn btn-primary text-xs">
                    Let
                  </Link>
                ),
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  // ── Step two: the tenancy ─────────────────────────────────────────────
  const treatment = chosen.treatment ?? "none";
  const copy = TREATMENT_COPY[treatment];
  const monthly = Number(chosen.list_rent);
  const depositMonths = Number(chosen.deposit_months || 1);
  const startDefault = today;
  const endDefault = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title={`New lease — ${chosen.name ?? chosen.code}`}
        subtitle={`${chosen.site} · ${chosen.bu}`}
        back={{ href: "/rentals/lease/new", label: "Choose a different unit" }}
      />

      <Card>
        <CardHeader
          title="Unit and treatment"
          subtitle="Derived from the unit — the lease inherits it and the rent run reads it"
        />
        <div className="px-4 pb-4 grid sm:grid-cols-3 gap-3 text-xs">
          <div>
            <p className="label">Unit</p>
            <p className="font-medium mt-0.5">{chosen.code}</p>
          </div>
          <div>
            <p className="label">Type</p>
            <p className="font-medium mt-0.5">
              {chosen.kind === "parking_bay"
                ? "Parking bay"
                : `${chosen.bedrooms ?? "?"} bed · ${Math.round(Number(chosen.area ?? 0))} sqft`}
            </p>
          </div>
          <div>
            <p className="label">VAT</p>
            <p className="font-medium mt-0.5">
              {chosen.tax_code ? (
                <>
                  {chosen.tax_code} · {treatment.replace(/_/g, " ")}
                </>
              ) : (
                <span style={{ color: "var(--negative)" }}>no rent item configured</span>
              )}
            </p>
          </div>
        </div>
      </Card>

      {!chosen.item_id && (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            {chosen.bu} has no rent item in the catalogue
          </p>
          <p className="text-2xs text-muted mt-1.5 leading-relaxed">
            A lease bills through a catalogue item, and the item&rsquo;s tax code is what decides
            the VAT treatment. Add a rent item for this business before signing a tenancy — a lease
            with no tax code would raise invoices at 0% and misstate the VAT return.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader title="Tenancy" subtitle="Annual contract, collected in instalments" />
        <div className="px-4 pb-4">
          <ActionForm
            action={createLeaseAction}
            submitLabel="Create lease"
            pendingLabel="Creating…"
            hidden={{ unitId: chosen.id, businessUnitId: chosen.bu_id }}
          >
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <Field
                label="Tenant"
                name="partyId"
                required
                options={parties.map((p) => ({
                  value: p.id,
                  label: p.phone ? `${p.display_name} · ${p.phone}` : p.display_name,
                }))}
              />
              <Field
                label="Collection"
                name="collectionMethod"
                options={[
                  { value: "post_dated_cheques", label: "Post-dated cheques" },
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "direct_debit", label: "Direct debit" },
                  { value: "cash", label: "Cash" },
                  { value: "mixed", label: "Mixed" },
                ]}
              />
              <Field label="From" name="startsOn" type="date" required defaultValue={startDefault} />
              <Field label="To" name="endsOn" type="date" defaultValue={endDefault} />
              <Field
                label={`Rent per month (${ccy})`}
                name="rentAmount"
                type="number"
                step="0.01"
                min="0"
                required
                defaultValue={monthly || undefined}
              />
              <Field
                label="Rent falls due on day"
                name="billingDay"
                type="number"
                min="1"
                defaultValue={1}
              />
              <Field
                label="Instalments (cheques)"
                name="chequeCount"
                options={[
                  { value: "4", label: "4 cheques — quarterly" },
                  { value: "1", label: "1 cheque — the whole year" },
                  { value: "2", label: "2 cheques — half-yearly" },
                  { value: "6", label: "6 cheques" },
                  { value: "12", label: "12 cheques — monthly" },
                ]}
              />
              <Field
                label={`Security deposit (${ccy})`}
                name="depositAmount"
                type="number"
                step="0.01"
                min="0"
                defaultValue={monthly ? Math.round(monthly * depositMonths) : undefined}
              />
              <Field
                label="Deposit received by"
                name="depositReceivedVia"
                options={[
                  { value: "", label: "Not yet received" },
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "cash", label: "Cash" },
                  { value: "cheque", label: "Cheque" },
                ]}
              />
              <Field label="Annual increase %" name="escalationRate" type="number" step="0.1" min="0" defaultValue={0} />
              <Field label="Ejari number" name="ejariNumber" placeholder="required to enforce at the RDC" />
              <Field label="Ejari registered on" name="ejariRegisteredOn" type="date" />
              <Field label="DEWA premise number" name="dewaPremiseNumber" />
              <Field label="Grace days before late" name="graceDays" type="number" min="0" defaultValue={5} />
            </div>

            <p className="label mb-1.5">Cheques handed over, in date order</p>
            <p className="text-2xs text-subtle mb-2 leading-relaxed">
              Leave blank if the tenant has not handed the bundle over yet. The rent run will flag
              every month with no cheque on file until they do. Dates and amounts are derived from
              the term and the instalment count — you enter only what is written on the cheques.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
              <Field label="Bank" name="chequeBank" placeholder="Emirates NBD" className="col-span-2 sm:col-span-1" />
              {[1, 2, 3, 4].map((i) => (
                <Field key={i} label={`Cheque ${i}`} name={`chequeNumber${i}`} />
              ))}
            </div>

            {copy && (
              <div
                className="rounded-[var(--radius-md)] px-3 py-2.5 mb-3"
                style={{
                  background: treatment === "exempt" ? "var(--surface-2)" : "var(--caution-soft)",
                }}
              >
                <p
                  className="text-xs font-semibold"
                  style={{ color: treatment === "exempt" ? "var(--text)" : "var(--caution)" }}
                >
                  {copy.headline}
                </p>
                <p className="text-2xs mt-1 leading-relaxed text-muted">{copy.body}</p>
              </div>
            )}
          </ActionForm>
        </div>
      </Card>

      <Card className="p-4" as="div">
        <p className="label mb-1.5">What creating this does</p>
        <p className="text-xs leading-relaxed text-muted">
          The lease, its charge schedule and the unit&rsquo;s status all change together, in one
          transaction. The deposit — if you record it as received — posts as a liability to Tenant
          Security Deposits, never as income: it is the tenant&rsquo;s money until the tenancy ends,
          and booking it to revenue would overstate profit by a month&rsquo;s rent and hide what you
          owe back. Any cheques you enter are filed against the periods they cover, so the register
          can tell you which instrument covers which month during a dispute.
        </p>
      </Card>
    </div>
  );
}
