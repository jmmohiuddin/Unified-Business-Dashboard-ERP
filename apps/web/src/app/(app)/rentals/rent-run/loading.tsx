import { GridSkeleton } from "@/components/ui";

/**
 * Loading state — WF-05 §17 asks for "preview spinner with count" here.
 *
 * The count is not knowable before the query runs, so the skeleton shows the
 * shape instead: the stat strip, the VAT split block, and the table of
 * invoices. Per leaf route, never on the (app) group — see the note in
 * `rentals/loading.tsx`.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
      <div className="skeleton h-7 w-48 rounded-[var(--radius-md)]" />
      <GridSkeleton count={5} />
      <div className="skeleton h-32 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-64 rounded-[var(--radius-lg)]" />
    </div>
  );
}
