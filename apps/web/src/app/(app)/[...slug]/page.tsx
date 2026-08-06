import Link from "next/link";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Honest placeholder for modules that are specified and schema-complete but
 * whose screens are scheduled for a later phase.
 *
 * Deliberately NOT a fake screen with plausible-looking widgets. A demo that
 * pretends a module is finished is how stakeholders sign off on work that does
 * not exist. Each entry states what is already built underneath and which phase
 * delivers the UI.
 */
const ROADMAP: Record<
  string,
  { title: string; phase: string; built: string[]; next: string[] }
> = {
  services: {
    title: "Field service",
    phase: "Phase 2",
    built: [
      "jobs / job_visits / job_lines / job_photos / service_contracts tables, seeded with 527 jobs",
      "SLA targets, technician skills, van stock as warehouses, inter-company jobs on owned units",
      "open_service_requests metric with per-trade and SLA-breach breakdown (live on the dashboard)",
    ],
    next: ["Dispatch board", "Technician mobile app (Expo)", "Photo capture and customer signature"],
  },
  rentals: {
    title: "Rentals — property & parking",
    phase: "Phase 2",
    built: [
      "sites / units / leases / lease_charges / meter_readings, seeded with 16 flats and 40 parking bays",
      "One active lease per unit enforced by a partial unique index",
      "occupancy_rate metric including monthly rent lost to vacancy (live on the dashboard)",
    ],
    next: ["Lease detail and renewal flow", "Automated monthly rent run", "Tenant self-service portal"],
  },
  salon: {
    title: "Salon",
    phase: "Phase 2",
    built: [
      "resources / appointments / appointment_services / membership plans, seeded with 1,671 bookings",
      "Double-booking made impossible by a GiST exclusion constraint on (resource, time range)",
      "appointments_today metric with chair utilisation (live on the dashboard)",
    ],
    next: ["Day/week calendar board", "Online booking page", "Commission statement per stylist"],
  },
  inventory: {
    title: "Inventory",
    phase: "Phase 2",
    built: [
      "Immutable stock_moves ledger with derived stock_levels cache",
      "serial_units for IMEI tracking and warranty lookup",
      "low_stock_items ranked by days of cover (live on the dashboard)",
    ],
    next: ["Stock take flow", "Purchase order and goods receipt", "Barcode scanning in the browser"],
  },
  crm: {
    title: "Customers",
    phase: "Phase 2",
    built: [
      "Unified parties table — one record whether someone is a customer, tenant, supplier or staff",
      "RFM recency/frequency/monetary scoring and churn banding, refreshed nightly",
      "churn_risk_customers metric (live on the dashboard)",
    ],
    next: ["Customer 360 timeline", "Segment builder", "WhatsApp conversation thread"],
  },
  assistant: {
    title: "Ask Nexus",
    phase: "Phase 3",
    built: [
      "Semantic metric layer: 21 typed, permission-checked metrics already exposed as Claude tool definitions via metricsAsAiTools()",
      "ai_conversations / ai_messages / ai_insights tables with per-message tool-call and cost audit trail",
      "Insight evidence model — every AI claim carries the metric ids and values behind it",
    ],
    next: [
      "Chat UI with streaming",
      "Daily executive briefing job",
      "Evaluation suite scored against the deterministic seed",
    ],
  },
  compliance: {
    title: "UAE compliance",
    phase: "Phase 2",
    built: [
      "Trade licence, establishment card, visa, labour card and Ejari expiry tracking — surfaced live on the dashboard watchlist",
      "VAT201 position with input-tax apportionment: residential rent is exempt, so only the taxable share of overhead VAT is recoverable",
      "End-of-service gratuity engine per Federal Decree-Law 33/2021, accrued nightly and posted as a provision",
      "WPS Salary Information File generator with pre-flight validation (Person ID, IBAN, routing code)",
      "Corporate tax estimate at 9% above AED 375,000, including Small Business Relief eligibility",
    ],
    next: [
      "VAT201 filing pack export for the FTA portal",
      "One-click WPS SIF download per payroll run",
      "Document vault for licences and Emirates IDs with renewal workflow",
    ],
  },
  ecommerce: {
    title: "Online store",
    phase: "Phase 3",
    built: [
      "channels / channel_listings / fulfilments with COD float tracking",
      "channel_performance metric net of marketplace commission (live on the dashboard)",
    ],
    next: ["Order fulfilment board", "Daraz + Facebook catalogue sync", "Returns workflow"],
  },
};

export default async function ModulePage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const key = slug[0] ?? "";
  const entry = ROADMAP[key];

  if (!entry) {
    return (
      <div className="px-4 lg:px-6 py-10 max-w-2xl mx-auto text-center">
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-xs text-muted mt-1.5">
          <code className="text-2xs">/{slug.join("/")}</code> does not exist.
        </p>
        <Link href="/" className="btn btn-primary mt-5 text-xs">
          Back to overview
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-3xl mx-auto space-y-4">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{entry.title}</h1>
          <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            {entry.phase}
          </span>
        </div>
        <p className="text-xs text-muted mt-1">
          The data model and metrics for this module are built and running. The screens ship in{" "}
          {entry.phase.toLowerCase()}.
        </p>
      </header>

      <Card className="p-4">
        <p className="label mb-2">Already built and running</p>
        <ul className="space-y-1.5">
          {entry.built.map((b) => (
            <li key={b} className="flex gap-2 text-xs leading-relaxed">
              <span style={{ color: "var(--positive)" }} aria-hidden>
                ✓
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <p className="label mb-2">Next in this module</p>
        <ul className="space-y-1.5">
          {entry.next.map((n) => (
            <li key={n} className="flex gap-2 text-xs leading-relaxed text-muted">
              <span className="text-subtle" aria-hidden>
                ○
              </span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Link href="/" className="btn btn-ghost text-xs">
        ← Back to overview
      </Link>
    </div>
  );
}
