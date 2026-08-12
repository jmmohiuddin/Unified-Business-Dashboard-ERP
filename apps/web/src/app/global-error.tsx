"use client";

/**
 * Last-resort boundary — catches failures in the root layout itself, which the
 * route-group boundary cannot. Ships its own <html>/<body> because at this
 * point the layout is what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Nexus could not start</h1>
        <p style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.5rem" }}>
          Nothing was saved. Try again, or contact whoever runs this deployment.
        </p>
        <button type="button" onClick={reset} style={{ marginTop: "1.5rem", padding: "0.5rem 1rem" }}>
          Try again
        </button>
        {error.digest && (
          <p style={{ fontSize: "0.7rem", opacity: 0.5, marginTop: "2rem" }}>
            Reference {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
