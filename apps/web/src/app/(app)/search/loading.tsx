import { Card } from "@/components/ui";

/**
 * First-arrival loading state for `/search`.
 *
 * The in-page `<Suspense key={term}>` covers every subsequent keystroke; this
 * covers the navigation into the route, which is the one moment Suspense cannot
 * — the page shell itself has not rendered yet. Both exist because a search
 * screen with only one of them flickers in exactly the case the other handles.
 *
 * The search field is drawn as a real skeleton rather than omitted, so the box
 * does not jump down the page when the results land.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[860px] mx-auto space-y-4 animate-pulse">
      <div>
        <div className="h-6 w-24 rounded" style={{ background: "var(--surface-2)" }} />
        <div className="h-3 w-64 rounded mt-2" style={{ background: "var(--surface-2)" }} />
      </div>
      <div className="h-10 w-full rounded-[var(--radius-md)]" style={{ background: "var(--surface-2)" }} />
      {[0, 1].map((group) => (
        <Card key={group} className="p-4" as="div">
          <div className="h-2.5 w-28 rounded" style={{ background: "var(--surface-2)" }} />
          {[0, 1, 2].map((row) => (
            <div key={row} className="mt-3 flex items-center justify-between gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-44 rounded" style={{ background: "var(--surface-2)" }} />
                <div className="h-2.5 w-60 rounded" style={{ background: "var(--surface-2)" }} />
              </div>
              <div className="h-5 w-16 rounded-full" style={{ background: "var(--surface-2)" }} />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}
