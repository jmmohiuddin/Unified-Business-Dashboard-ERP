import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers.
 *
 * Applied in proxy (the Next 16 rename of middleware) rather than per-route so a
 * new page cannot ship without them — the same reasoning as generating RLS
 * policies from the schema. A header you have to remember to add is a header you
 * will eventually forget.
 *
 * Runs on the edge runtime, so nothing here may touch the database.
 */

/**
 * Content Security Policy.
 *
 * `'unsafe-inline'` on style-src is a real, acknowledged weakening: React
 * injects inline styles and this product uses inline CSS custom properties for
 * theming. It is scoped to styles only — script-src stays strict with a
 * per-request nonce, which is where XSS actually lands.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  return [
    `default-src 'self'`,
    // Next's dev overlay needs eval; production does not get it.
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    // No third-party analytics, no CDN — the app talks to itself only.
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    ...(isDev ? [] : [`upgrade-insecure-requests`]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Client IP for the rate limiter. Trust the proxy header only when a proxy is
  // actually in front — otherwise a client can forge it and bypass the limit.
  requestHeaders.set(
    "x-client-ip",
    (process.env.TRUST_PROXY === "true"
      ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      : null) ?? "local",
  );

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", buildCsp(nonce));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // This app needs none of these. Denying by default is cheaper than auditing.
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  response.headers.set("X-DNS-Prefetch-Control", "off");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");

  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

export const config = {
  // Everything except static assets — including API routes, which need the
  // headers just as much as pages do.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
