import { GridSkeleton } from "@/components/ui";

/**
 * Loading state.
 *
 * Per LEAF route, never on the (app) group — a group-level loading.tsx makes
 * Next stream every route in the group, which commits HTTP 200 before the
 * component runs and silently turns `notFound()` into a 200. See the note on
 * `hr/gratuity/loading.tsx`.
 *
 * The payroll preview runs a lateral join per employee over attendance, leave,
 * commission and advances, so it is one of the slower reads in the product and
 * one of the ones a user is most anxious about. A skeleton beats a blank month.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 space-y-5">
      <div className="skeleton h-7 w-64 rounded-[var(--radius-md)]" />
      <GridSkeleton count={5} />
      <div className="skeleton h-72 rounded-[var(--radius-lg)]" />
    </div>
  );
}
