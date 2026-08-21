import { Card } from "@/components/ui";

/**
 * Loading state for people and access.
 *
 * The screen opens one transaction that reads memberships, roles, businesses,
 * scopes and pending invitations, so its first paint waits on all five. Every
 * other list route in the app already has one of these; this one did not, which
 * is FR-P04's finding rather than a new one — added here because the screen
 * grew from two queries to five and the gap became visible.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5 animate-pulse">
      <div>
        <div className="h-6 w-48 rounded" style={{ background: "var(--surface-2)" }} />
        <div className="h-3 w-64 rounded mt-2" style={{ background: "var(--surface-2)" }} />
      </div>
      {[0, 1].map((card) => (
        <Card key={card} className="p-4" as="div">
          <div className="h-4 w-32 rounded" style={{ background: "var(--surface-2)" }} />
          {[0, 1, 2].map((row) => (
            <div key={row} className="mt-3 flex items-center justify-between gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-40 rounded" style={{ background: "var(--surface-2)" }} />
                <div className="h-2.5 w-56 rounded" style={{ background: "var(--surface-2)" }} />
              </div>
              <div className="h-5 w-16 rounded-full" style={{ background: "var(--surface-2)" }} />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}
