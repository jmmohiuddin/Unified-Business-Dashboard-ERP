import { GridSkeleton } from "@/components/ui";

/**
 * Loading state for /businesses/interco.
 *
 * Per LEAF route, never on the (app) group — see the note in
 * `businesses/loading.tsx` for why: a group-level file makes Next stream every
 * route in the group and commits HTTP 200 before the component runs, which
 * silently turned `notFound()` and `redirect()` into 200s.
 *
 * This screen runs four ledger-wide aggregates over `journal_lines`, so it is
 * one of the slower reads in the app and one of the ones most worth a skeleton
 * rather than a blank pane.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 space-y-5">
      <div className="skeleton h-7 w-64 rounded-[var(--radius-md)]" />
      <GridSkeleton count={5} />
      <div className="skeleton h-10 rounded-[var(--radius-md)]" />
      <div className="skeleton h-56 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-48 rounded-[var(--radius-lg)]" />
    </div>
  );
}
