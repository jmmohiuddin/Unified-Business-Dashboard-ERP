import { GridSkeleton } from "@/components/ui";

/**
 * Loading state for the owner ledger.
 *
 * Per LEAF route, never on the `(app)` group — a group-level `loading.tsx`
 * makes Next stream every route in the group and commits HTTP 200 before the
 * component runs, which turns `notFound()` and `redirect()` elsewhere in the
 * group into 200s. The reasoning is spelled out in `accounting/vat/loading.tsx`;
 * this file exists so this screen follows it rather than blocking on an
 * aggregate over the whole journal with nothing on screen.
 *
 * Skeletal in the same SHAPE as the real page — header, net-position card,
 * stat strip, the by-business bars, ageing, movements. A skeleton that does not
 * match the layout it precedes causes a visible jump that reads as a bug.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <div className="skeleton h-7 w-44 rounded-[var(--radius-md)]" />
      <div className="skeleton h-40 rounded-[var(--radius-lg)]" />
      <GridSkeleton count={5} />
      <div className="skeleton h-56 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-44 rounded-[var(--radius-lg)]" />
      <div className="skeleton h-64 rounded-[var(--radius-lg)]" />
    </div>
  );
}
