import Link from "next/link";
import { withTenant } from "@nexus/db";
import { can, loadEInvoiceReadiness, type EInvoiceReadiness } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * E-INVOICING READINESS — FR-C07, WF-05 §10.3.
 *
 * The only screen in this product whose entire purpose is a date that has not
 * arrived. UAE e-invoicing is mandatory from 1 July 2027 and the accredited
 * service provider through which every document must pass has to be appointed
 * by 31 March 2027 — the one statutory deadline in the project, and the one the
 * prior audit found implemented nowhere at all.
 *
 * WHY IT SHIPS EMPTY. WF-05 lists this route as "Skeleton · readiness state is
 * the empty state", and that is exactly right: today there is no provider, no
 * transmission and no exception queue, and the honest rendering of that is a
 * checklist of gaps and a countdown. The wireframe's own argument for building
 * it now is that the deadline should be "visible for the 231 days before it
 * becomes urgent rather than the week after". A screen introduced in March 2027
 * is a screen that reports a missed deadline.
 *
 * The five states (WF-05 §0): the countdown and checklist are the default;
 * `loading.tsx` covers loading; a tenant with no legal entities gets the empty
 * state inside the checklist card; a failed read renders the error card rather
 * than a stack trace; and a user without `settings:read` gets the denial,
 * enforced in `loadEInvoiceReadiness` as well as here.
 */
export default async function EInvoicingPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);

  if (!can(session.principal, "settings:read")) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="E-invoicing" back={{ href: "/compliance", label: "Compliance" }} />
        <Card className="p-6 text-center">
          <p className="text-xs font-semibold">You do not have access to this screen</p>
          <p className="text-2xs text-subtle mt-1.5 max-w-[44ch] mx-auto leading-relaxed">
            Entity registration details and tax numbers are restricted. Ask the owner for the
            settings permission if you need them.
          </p>
        </Card>
      </div>
    );
  }

  let readiness: EInvoiceReadiness | null = null;
  let failure: string | null = null;
  try {
    readiness = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      (tx) =>
        loadEInvoiceReadiness(tx, session.tenantId, session.principal.permissions, today),
    );
  } catch (err) {
    // Shown, not swallowed. The `legal_entities` table arrives in migration
    // 0003; before it is applied this read fails, and a blank page would leave
    // the reader unable to tell a missing migration from a missing deadline.
    failure = err instanceof Error ? err.message : "The readiness check could not be run.";
  }

  const c = readiness?.countdown;
  const tone =
    c?.urgency === "overdue" || c?.urgency === "urgent"
      ? "var(--negative)"
      : c?.urgency === "live"
        ? "var(--positive)"
        : "var(--caution)";

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="E-invoicing"
        subtitle="Federal Tax Authority · PINT AE · five-corner Peppol model"
        back={{ href: "/compliance", label: "Compliance" }}
      />

      {failure && (
        <Card className="p-4">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            The readiness check could not be run
          </p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed">{failure}</p>
        </Card>
      )}

      {/* ── The countdown ──────────────────────────────────────────────── */}
      {c && (
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-xs font-semibold">
              {c.urgency === "live" ? "Provider appointed" : "Not yet required"}
            </p>
            <p className="text-2xs text-subtle tnum">
              Live by {c.liveBy} · {c.daysToGoLive} days
            </p>
          </div>

          <p className="text-2xs text-muted mt-2 leading-relaxed max-w-[62ch]">
            You must appoint an accredited service provider by{" "}
            <strong className="tnum">{c.appointBy}</strong> and be transmitting by{" "}
            <strong className="tnum">{c.liveBy}</strong>. Nexus does not connect to the network
            itself — the provider relationship is the compliance mechanism, and appointing one is
            a procurement cycle rather than a setting.
          </p>

          <p className="kpi-value mt-3 tnum" style={{ color: tone }}>
            {c.daysToAppoint >= 0
              ? `${c.daysToAppoint} days to appoint`
              : `${Math.abs(c.daysToAppoint)} days overdue`}
          </p>

          {/* Width is the elapsed share of the runway, clamped in the core so
              the bar can never overrun its track and read as a render bug. */}
          <div
            className="mt-2 h-1.5 rounded-full overflow-hidden"
            style={{ background: "var(--surface-3)" }}
            role="img"
            aria-label={`${Math.round(c.elapsedFraction * 100)} percent of the time to appoint a provider has elapsed`}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${c.elapsedFraction * 100}%`, background: tone }}
            />
          </div>

          <p className="text-2xs text-subtle mt-3 leading-relaxed">
            There is no provider to set up yet. The interface a provider plugs into exists
            (<code>EInvoiceProvider</code>), its default records and transmits nothing, and the
            document serialiser is a registered placeholder — the PINT AE mandatory field list is
            still an open question with the Ministry of Finance.
          </p>
        </Card>
      )}

      {/* ── Readiness checklist ────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Readiness"
          subtitle="Every row here has a lead time measured in weeks, not in deploys"
        />
        {!readiness || readiness.checks.every((k) => k.status === "none") ? (
          <EmptyState
            icon="◇"
            title="Nothing to check yet"
            detail="No legal entities are on file, so there is nothing to hold a tax number or appoint a provider."
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {readiness.checks.map((k) => (
              <li key={k.key} className="px-4 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{k.label}</p>
                  <p className="text-2xs text-subtle mt-0.5 leading-relaxed max-w-[58ch]">
                    {k.detail}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className="text-xs font-semibold tnum"
                    style={{
                      color:
                        k.status === "ok"
                          ? "var(--positive)"
                          : k.status === "gap"
                            ? "var(--negative)"
                            : "var(--text-muted)",
                    }}
                  >
                    {k.total === 0 ? "—" : `${k.done} of ${k.total}`}
                  </p>
                  {/* Status is carried by a word as well as by colour, so a
                      colour-blind reader loses nothing (PDD-04, FR-V02). */}
                  <p className="text-2xs text-subtle mt-0.5">
                    {k.status === "ok"
                      ? "ok"
                      : k.status === "gap"
                        ? "gap"
                        : k.status === "info"
                          ? "counted"
                          : "none yet"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="px-4 py-3" as="div">
        <p className="text-2xs text-subtle leading-relaxed max-w-[66ch]">
          Business-to-consumer sales stay outside the mandate: salon walk-ins, counter sales and
          direct e-commerce orders keep producing a compliant local tax invoice and are never
          transmitted. Once a provider is live, this screen shows transmission status per
          document and the queue of anything a provider rejected. Trade licences and tax
          registration numbers are recorded on the{" "}
          <Link href="/compliance" className="hover:underline" style={{ color: "var(--accent)" }}>
            compliance register
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
