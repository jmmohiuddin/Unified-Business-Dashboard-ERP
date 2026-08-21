"use client";

import { useEffect } from "react";

/**
 * Error state for /businesses/interco.
 *
 * A leaf boundary rather than relying on the (app) group one, for a reason
 * specific to this screen: the group boundary says "this screen failed to
 * load", which on every other page is the whole story. Here the reader's next
 * question is always the same — "are my books wrong?" — and the honest answer
 * is no. This screen only READS; the reciprocal balances it renders are derived
 * from the journals on each load and nothing about a failed render can have
 * changed them. Saying so is the difference between a retry and a phone call.
 *
 * Deliberately says nothing about WHAT failed. This page renders financial data
 * and an error string can carry a query fragment or a column name; the detail
 * goes to the server log, keyed by the digest so a user can quote it.
 */
export default function IntercoError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[interco-error]", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="px-4 lg:px-6 py-16 max-w-md mx-auto text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        Could not load the inter-business balances
      </h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">
        Nothing was changed. This screen only reads — what your businesses owe
        each other is unaffected, and every other screen still works.
      </p>

      <div className="flex gap-2 justify-center mt-5">
        <button type="button" onClick={reset} className="btn btn-primary text-xs">
          Try again
        </button>
        <a href="/businesses" className="btn btn-ghost text-xs">
          Back to businesses
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
