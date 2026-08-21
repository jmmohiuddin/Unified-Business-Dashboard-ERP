import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers, client IP, and the MFA enrolment gate.
 *
 * Applied in proxy (the Next 16 rename of middleware) rather than per-route so a
 * new page cannot ship without them — the same reasoning as generating RLS
 * policies from the schema. A header you have to remember to add is a header you
 * will eventually forget.
 *
 * Runs on the edge runtime, so nothing here may touch the database. Everything
 * this file decides is decided from the request and a signing key.
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

// ── MFA enrolment gate ──────────────────────────────────────────────────────

/** Must match SESSION_COOKIE / AUTH_LEVEL_COOKIE in lib/mfa.ts, which mint it. */
const SESSION_COOKIE = "nexus_session";
const AUTH_LEVEL_COOKIE = "nexus_auth_level";

/**
 * The only paths an `mfa_setup` session may reach.
 *
 * `/settings/security` is where enrolment happens — and where the sign-out
 * action in the app shell is rendered, so the user is never stranded.
 * `/login` is allowed so that "use a different account" still works.
 */
const MFA_SETUP_PATHS = ["/settings/security", "/login"];

function base64url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-checked, non-short-circuiting compare. Signatures deserve it even
 *  when the attacker would have to measure a network round trip to exploit it. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the assurance marker written by setAuthLevel() in lib/mfa.ts.
 *
 * Returns null for absent, expired, tampered, or bound-to-another-session — all
 * of which mean the same thing here: this request has not proved it completed
 * login under the current rules. See the docblock in lib/mfa.ts for the format
 * and for why the marker is positive rather than a "restricted" flag.
 */
async function readAuthLevel(
  sessionToken: string,
  cookieValue: string | undefined,
): Promise<"full" | "mfa_setup" | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !cookieValue) return null;

  const [level, expiresAt, mac] = cookieValue.split(".");
  if (!level || !expiresAt || !mac) return null;
  if (level !== "full" && level !== "mfa_setup") return null;
  if (!(Number(expiresAt) > Date.now())) return null;

  const encoder = new TextEncoder();
  const binding = hex(await crypto.subtle.digest("SHA-256", encoder.encode(sessionToken)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64url(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${level}.${expiresAt}.${binding}`)),
  );
  return safeEqual(expected, mac) ? level : null;
}

/**
 * Refuse to carry a session further than the login path allowed it to go.
 *
 * Three outcomes, and the middle one is the point of the whole mechanism:
 *
 *  - No session cookie — anonymous. Nothing to check; the pages do their own
 *    `requireSession()`.
 *  - Session cookie with no valid marker — issued before this rule existed, or
 *    forged. End it. A thirty-day cookie must not outrun a change to who is
 *    allowed to hold one.
 *  - Marker says `mfa_setup` — the password was right but the role requires a
 *    second factor that this user has not enrolled. Only `/settings/security`
 *    is reachable until they do.
 */
async function guardAuthLevel(
  request: NextRequest,
  requestHeaders: Headers,
): Promise<NextResponse> {
  const proceed = () => NextResponse.next({ request: { headers: requestHeaders } });

  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionToken) return proceed();

  const level = await readAuthLevel(sessionToken, request.cookies.get(AUTH_LEVEL_COOKIE)?.value);

  if (level === null) {
    const bounced = NextResponse.redirect(new URL("/login?error=session", request.url));
    // Clear it on the way out, or the next request repeats this redirect.
    bounced.cookies.delete(SESSION_COOKIE);
    bounced.cookies.delete(AUTH_LEVEL_COOKIE);
    return bounced;
  }

  if (level === "mfa_setup") {
    const path = request.nextUrl.pathname;
    if (!MFA_SETUP_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
      return NextResponse.redirect(new URL("/settings/security?mfa=required", request.url));
    }
  }

  return proceed();
}

/**
 * CLIENT IP.
 *
 * `X-Forwarded-For` is only worth reading when something trustworthy wrote it;
 * with nothing in front, any client can forge it and walk past the rate limit.
 * But the previous default — `TRUST_PROXY` unset means "do not trust" — is the
 * wrong default *for this deployment*, and it fails in the unsafe direction:
 * every request then keys the limiter as `login:ip:local`, so thirty-one login
 * POSTs from one attacker lock every real user out of the whole deployment, and
 * `audit_log.ip_address` is NULL on every row because actions.ts discards the
 * literal "local". A limiter that cannot tell two callers apart is worse than
 * none, because the dashboard says throttling is on.
 *
 * So the default is derived rather than assumed: on Vercel a proxy is in front
 * by definition (`VERCEL` is set in every runtime there, and Vercel's edge
 * rewrites the header), so trust it unless `TRUST_PROXY=false` says otherwise.
 * Anywhere else, trust nothing unless `TRUST_PROXY=true` says so.
 *
 * The value taken is the RIGHTMOST hop, not the leftmost. Each proxy appends
 * the address it received the connection from, so everything to the left of the
 * last entry was written by someone we do not control and may be invented. With
 * one trusted proxy — the Vercel case — leftmost and rightmost coincide; behind
 * two (a CDN in front of Vercel, say) set TRUST_PROXY_HOPS=2 so the entry the
 * *outermost* trusted hop wrote is the one used.
 */
function clientIp(request: NextRequest): string {
  const trusted =
    process.env.TRUST_PROXY === "true" ||
    (process.env.TRUST_PROXY !== "false" && Boolean(process.env.VERCEL));
  if (!trusted) return "local";

  const parts = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "local";

  const hops = Math.max(1, Math.min(parts.length, Number(process.env.TRUST_PROXY_HOPS ?? 1) || 1));
  return parts[parts.length - hops] ?? "local";
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-client-ip", clientIp(request));

  const response = await guardAuthLevel(request, requestHeaders);

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
