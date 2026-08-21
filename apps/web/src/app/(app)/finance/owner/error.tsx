"use client";

import { useEffect } from "react";

/**
 * Error state for the owner ledger, scoped to this leaf.
 *
 * WF-05 §17 asks for a per-section error rather than a whole-app failure page,
 * and a leaf boundary is how that is achieved: a failure aggregating the
 * journal takes out this route and leaves the shell, the nav and every other
 * screen intact.
 *
 * It does not print the error. This screen renders the owner's personal
 * position, and a thrown database error can carry a column name, a query
 * fragment or an amount. The detail goes to the server log, keyed by the digest
 * quoted below.
 *
 * It says "nothing was changed" and means it literally: this route issues no
 * INSERT, UPDATE or DELETE at all — `owner-ledger.test.ts` asserts as much — so
 * a failure here cannot have left a half-written balance behind. That is worth
 * stating outright on a page about money the owner has taken out of his own
 * businesses.
 *
 * `retry()` rather than `reset()`: this segment failed on a server read, and
 * `reset()` re-renders the boundary's children WITHOUT re-fetching, which would
 * show the same failure again. (Next 16.3; the app-group boundary still uses
 * `reset`.)
 */
export default function OwnerLedgerError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[owner-ledger]", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="px-4 lg:px-6 py-16 max-w-md mx-auto text-center">
      <h1 className="text-xl font-semibold tracking-tight">The owner ledger did not load</h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">
        Nothing was changed. This page only reads the ledger — it records no entry of its own, so
        no balance has moved and nothing needs checking before you try again.
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
