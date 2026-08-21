import { GridSkeleton } from "@/components/ui";

/**
 * Loading state for the chooser.
 *
 * Per LEAF route, never on the (app) group — a group-level loading.tsx makes
 * Next stream every route in the group and commits HTTP 200 before the
 * component runs, which turns notFound() into a 200.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <div className="skeleton h-7 w-56 rounded-[var(--radius-md)]" />
      <GridSkeleton count={4} />
      <div className="skeleton h-44 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-64 rounded-[var(--radius-lg)]" />
    </div>
  );
}
