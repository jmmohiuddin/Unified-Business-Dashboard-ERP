import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Honest placeholder for modules that are specified and schema-complete but
 * whose screens are scheduled for a later phase.
 *
 * Seven entries were removed here: services, rentals, salon, inventory, crm,
 * assistant and compliance all have real routes now, so the catch-all could
 * never render them. Dead code that describes shipped features as unbuilt is
 * worse than no placeholder.
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

  // A missing page must be a real 404.
  //
  // This used to render a "Page not found" body with HTTP **200**, which meant
  // every status assertion in the suites was worthless for route coverage —
  // `GET /anything === 200` passed for routes that did not exist. Fifteen dead
  // dashboard drill-downs shipped behind that, and the tests could not see them.
  if (!entry) notFound();

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
