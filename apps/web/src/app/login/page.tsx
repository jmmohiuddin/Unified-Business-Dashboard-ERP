import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { withoutTenant } from "@nexus/db";
import {
  clearMfaChallenge,
  createMfaChallenge,
  createSession,
  getSession,
  listDemoUsers,
  readMfaChallenge,
  verifyPassword,
} from "@/lib/session";
import { isMfaEnabled, verifyChallenge } from "@/lib/mfa";
import {
  clearFailedLogins,
  isLockedOut,
  rateLimit,
  recordFailedLogin,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Generic failure. Never distinguishes wrong password from unknown account
 *  from locked account — each distinction is a user-enumeration oracle. */
const FAIL = "/login?error=1";

async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const ip = (await headers()).get("x-client-ip") ?? "local";

  // Two independent limits. The IP throttle stops a script; the per-account
  // limit stops a targeted attack that rotates IPs.
  const byIp = await rateLimit(`login:ip:${ip}`, 30, 300);
  const byAccount = await rateLimit(`login:acct:${email}`, 10, 300);
  if (!byIp.allowed || !byAccount.allowed) redirect("/login?error=throttled");

  if (await isLockedOut(email)) {
    // Same generic failure — the attacker learns nothing from the lockout.
    redirect(FAIL);
  }

  const rows = await withoutTenant((db) =>
    db.execute<{ id: string; password_hash: string | null; default_tenant_id: string | null }>(sql`
      SELECT u.id, u.password_hash, u.default_tenant_id
        FROM users u
       WHERE lower(u.email) = ${email}
       LIMIT 1
    `),
  );

  const user = rows[0];
  // verifyPassword burns comparable time on a missing account, so response
  // latency does not reveal whether the address exists.
  const ok = await verifyPassword(password, user?.password_hash ?? null);

  if (!user || !user.default_tenant_id || !ok) {
    if (user) await recordFailedLogin(email);
    redirect(FAIL);
  }

  await clearFailedLogins(user.id);

  // Password is only the first factor. If MFA is enrolled, the real session is
  // not issued until the challenge is cleared.
  if (await isMfaEnabled(user.id)) {
    await createMfaChallenge(user.id, user.default_tenant_id);
    redirect("/login/verify");
  }

  await createSession(user.id, user.default_tenant_id);
  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  // Next 16: params and searchParams are Promises.
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;
  const demoUsers = await listDemoUsers();

  return (
    <main className="min-h-dvh grid lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden lg:flex flex-col justify-between p-10" style={{ background: "var(--surface)" }}>
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg grid place-items-center text-xs font-bold"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            N
          </div>
          <span className="font-semibold tracking-tight">Nexus</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold tracking-tight leading-[1.15]">
            Seven businesses.
            <br />
            <span style={{ color: "var(--accent)" }}>One number that matters.</span>
          </h1>
          <p className="text-muted mt-4 text-base leading-relaxed">
            Salon, mobile shop, online store, JVC apartments, Business Bay parking, technical
            services and contracting — consolidated into one ledger, one customer list and one
            answer to &ldquo;how are we doing?&rdquo;
          </p>
          <dl className="mt-8 grid grid-cols-3 gap-4">
            {[
              ["7", "businesses"],
              ["AED", "5% VAT, Dubai"],
              ["88", "isolated tables"],
            ].map(([v, k]) => (
              <div key={k}>
                <dt className="text-xl font-semibold tnum tracking-tight">{v}</dt>
                <dd className="text-2xs text-subtle mt-0.5">{k}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="text-2xs text-subtle">
          argon2id passwords · TOTP second factor · tenant isolation enforced by PostgreSQL RLS.
        </p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
          <p className="text-xs text-muted mt-1">Welcome back to Sumon Group.</p>

          <form action={signIn} className="mt-6 space-y-3">
            <div>
              <label htmlFor="email" className="label block mb-1.5">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                defaultValue="owner@sumon.test"
                className="w-full px-3 py-2 rounded-[var(--radius-md)] text-sm"
                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
              />
            </div>
            <div>
              <label htmlFor="password" className="label block mb-1.5">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                defaultValue="demo1234"
                className="w-full px-3 py-2 rounded-[var(--radius-md)] text-sm"
                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {error && (
              <p
                className="text-xs px-3 py-2 rounded-[var(--radius-md)]"
                style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
                role="alert"
              >
                {error === "throttled"
                  ? "Too many attempts. Wait a few minutes and try again."
                  : "Those credentials did not match an account."}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full">
              Sign in
            </button>
          </form>

          <div className="mt-8">
            <p className="label mb-2">Or explore a role</p>
            <div className="grid gap-1 max-h-56 overflow-y-auto scrollbar-none">
              {demoUsers.map((u) => (
                <form key={u.email ?? u.full_name} action={signIn}>
                  <input type="hidden" name="email" value={u.email ?? ""} />
                  <input type="hidden" name="password" value="demo1234" />
                  <button
                    type="submit"
                    className="w-full text-left px-3 py-2 rounded-[var(--radius-md)] hover:bg-surface-2 flex items-center justify-between gap-2 transition-colors"
                  >
                    <span className="text-xs font-medium truncate">{u.full_name}</span>
                    <span className="text-2xs text-subtle shrink-0">{u.role_name}</span>
                  </button>
                </form>
              ))}
            </div>
            <p className="text-2xs text-subtle mt-3 leading-relaxed">
              Each role sees a different dashboard — the barber sees only their own schedule,
              the auditor sees everything read-only. Permissions are enforced server-side, not
              hidden in the UI.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
