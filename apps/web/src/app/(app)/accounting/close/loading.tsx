import { GridSkeleton } from "@/components/ui";

/**
 * Loading state for the close screen.
 *
 * Per LEAF route, never on the `(app)` group — a group-level `loading.tsx`
 * makes Next stream every route in the group, which commits HTTP 200 before the
 * component runs and turns `notFound()` and `redirect()` elsewhere in the group
 * into 200s. The reasoning is the same one written up in
 * `accounting/vat/loading.tsx`.
 *
 * This page is slower than most: the checklist is eight aggregate queries plus
 * a trial balance over `journal_lines`, so a skeleton here is doing real work
 * rather than papering over a fast page.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <div className="skeleton h-7 w-48 rounded-[var(--radius-md)]" />
      <div className="flex gap-1 flex-wrap">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton h-6 w-14 rounded-[var(--radius-md)]" />
        ))}
      </div>
      <GridSkeleton count={5} />
      <div className="skeleton h-72 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-32 rounded-[var(--radius-lg)]" />
    </div>
  );
}
