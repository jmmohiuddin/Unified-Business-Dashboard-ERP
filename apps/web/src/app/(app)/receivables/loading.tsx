import { GridSkeleton } from "@/components/ui";

/**
 * Loading state.
 *
 * TileSkeleton and GridSkeleton were built during the design-system work and
 * then rendered nowhere, because no loading.tsx existed anywhere — every page
 * blocked on its slowest query with no feedback.
 *
 * Per LEAF route, never on the (app) group. A group-level loading.tsx makes
 * Next stream every route in the group, which commits HTTP 200 before the
 * component runs — so notFound() in the catch-all and redirect() in /assistant
 * silently became 200s. Verified: with a group-level file those return 200,
 * with per-leaf files they return 404 and 307. A skeleton is not worth losing
 * correct status codes on the routes whose whole job is to return one.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 space-y-5">
      <div className="skeleton h-7 w-56 rounded-[var(--radius-md)]" />
      <GridSkeleton count={4} />
      <div className="skeleton h-64 rounded-[var(--radius-lg)]" />
    </div>
  );
}
