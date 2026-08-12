"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * There were none. Nineteen pages, zero `error.tsx`, so any throw in a server
 * component — a database timeout in `loadMetrics`, a `withTenant` failure —
 * surfaced the framework's default error page: a stack trace in development and
 * a blank wall in production, with no way back into the app.
 *
 * Deliberately says nothing about what failed. This app renders financial data;
 * an error string here can carry a query fragment or a column name. The detail
 * goes to the server log and, once ADR-009 lands, to Sentry — keyed by the
 * digest below so a user can quote it and an engineer can find it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="px-4 lg:px-6 py-16 max-w-md mx-auto text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-xs text-muted mt-2 leading-relaxed">
        Nothing was saved. This screen failed to load — you can try again, and
        the rest of the app is unaffected.
      </p>

      <div className="flex gap-2 justify-center mt-5">
        <button type="button" onClick={reset} className="btn btn-primary text-xs">
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
