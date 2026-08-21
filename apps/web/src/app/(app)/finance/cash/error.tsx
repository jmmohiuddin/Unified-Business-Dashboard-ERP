"use client";

import { useEffect } from "react";

/**
 * Error state for the cash register, scoped to this leaf.
 *
 * WF-05 §17 asks for a PER-SECTION error on this screen rather than a whole-app
 * failure page, and a leaf boundary is how that is achieved: a failure loading
 * variance history takes out this route and leaves the shell, the nav and every
 * other screen intact.
 *
 * Two things it deliberately does NOT do.
 *
 * It does not print the error. This screen renders cash positions, and a thrown
 * database error can carry a column name, a query fragment or an amount. The
 * detail goes to the server log, keyed by the digest quoted below.
 *
 * It does not say "your data may not have saved". Every write on this screen
 * runs inside one transaction — the count, the journal and the audit record
 * either all landed or none did — so "nothing was saved" is the truth and is
 * worth stating plainly to someone standing at a till wondering whether to
 * count again.
 *
 * `retry()` rather than `reset()`: this segment failed on a server read, and
 * `reset()` re-renders the boundary's children WITHOUT re-fetching, which would
 * show the same failure again. `retry()` re-fetches. (Next 16.3; the app-group
 * boundary still uses `reset`.)
 */
export default function CashError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[cash-register]", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="px-4 lg:px-6 py-16 max-w-md mx-auto text-center">
      <h1 className="text-xl font-semibold tracking-tight">The cash register did not load</h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">
        Nothing was saved and no till was changed. Any count you submitted either went through
        completely or not at all — reload and check &ldquo;Open now&rdquo; before counting again.
      </p>

      <div className="flex gap-2 justify-center mt-5">
        <button type="button" onClick={() => retry()} className="btn btn-primary text-xs">
          Try again
        </button>
        <a href="/" className="btn btn-ghost text-xs">
          Back to overview
        </a>
      </div>

      {error.digest && (
        <p className="text-2xs text-subtle mt-6">
          Reference <code className="text-2xs">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
