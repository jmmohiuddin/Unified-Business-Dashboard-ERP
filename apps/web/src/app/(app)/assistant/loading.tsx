/**
 * Loading state.
 *
 * Per LEAF route, never on the (app) group — a group-level loading.tsx makes
 * Next stream every route in the group and commit HTTP 200 before the component
 * runs, which turns `notFound()` in the catch-all into a 200.
 *
 * Shaped like the answer that is coming rather than like a generic tile grid:
 * a question bubble, a paragraph, then two evidence cards. Waiting for an AI
 * answer is the longest wait in the product — a model round trip, not a query
 * — so the skeleton's job is to tell the owner what will appear, and roughly
 * how much of it.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <div className="skeleton h-7 w-44 rounded-[var(--radius-md)]" />

      <div className="card p-4 space-y-4">
        <div className="flex justify-end">
          <div className="skeleton h-8 w-64 rounded-[var(--radius-md)]" />
        </div>
        <div className="space-y-1.5">
          <div className="skeleton h-2.5 w-full rounded-[var(--radius-md)]" />
          <div className="skeleton h-2.5 w-11/12 rounded-[var(--radius-md)]" />
          <div className="skeleton h-2.5 w-7/12 rounded-[var(--radius-md)]" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="skeleton h-24 rounded-[var(--radius-md)]" />
          <div className="skeleton h-24 rounded-[var(--radius-md)]" />
        </div>
      </div>

      <div className="skeleton h-32 rounded-[var(--radius-lg)]" />
    </div>
  );
}
