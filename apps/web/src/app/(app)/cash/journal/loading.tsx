/**
 * Loading state for an entry form.
 *
 * WF-05 §3.7: "the sheet opens instantly … a spinner never blocks the amount
 * field". The skeleton therefore mirrors the form's own shape — hero amount,
 * then fields — so the layout does not jump under a thumb that is already
 * moving towards where the amount is about to be.
 */
export default function Loading() {
  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[560px] mx-auto space-y-4">
      <div className="skeleton h-7 w-48 rounded-[var(--radius-md)]" />
      <div className="card p-4 space-y-4">
        <div className="skeleton h-12 w-40 mx-auto rounded-[var(--radius-md)]" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="skeleton h-12 rounded-[var(--radius-md)]" />
          <div className="skeleton h-12 rounded-[var(--radius-md)]" />
          <div className="skeleton h-12 rounded-[var(--radius-md)]" />
          <div className="skeleton h-12 rounded-[var(--radius-md)]" />
        </div>
        <div className="skeleton h-16 rounded-[var(--radius-md)]" />
        <div className="skeleton h-8 w-28 rounded-[var(--radius-md)]" />
      </div>
    </div>
  );
}
