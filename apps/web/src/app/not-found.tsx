import Link from "next/link";

/**
 * 404.
 *
 * Reachable now that the `[...slug]` catch-all calls `notFound()` instead of
 * rendering a not-found body with HTTP 200.
 */
export default function NotFound() {
  return (
    <main className="min-h-dvh grid place-items-center px-6">
      <div className="text-center max-w-sm">
        <p className="label">404</p>
        <h1 className="text-xl font-semibold tracking-tight mt-1">Page not found</h1>
        <p className="text-xs text-muted mt-2 leading-relaxed">
          That address does not exist. If you followed a link from inside the
          app, it is a bug worth reporting.
        </p>
        <Link href="/" className="btn btn-primary text-xs mt-5 inline-block">
          Back to overview
        </Link>
      </div>
    </main>
  );
}
