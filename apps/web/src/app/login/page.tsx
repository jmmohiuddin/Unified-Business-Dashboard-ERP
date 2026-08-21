import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { withTenant, withoutTenant } from "@nexus/db";
import { security } from "@nexus/core";
import {
  clearMfaChallenge,
  createMfaChallenge,
  createSession,
  getSession,
  listDemoUsers,
  readMfaChallenge,
  verifyPassword,
} from "@/lib/session";
import { currentAuthLevel, isMfaEnabled, mfaRequiredFor, setAuthLevel, verifyChallenge } from "@/lib/mfa";
import {
  clearFailedLogins,
  isLockedOut,
  rateLimit,
  recordFailedLogin,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * DEMO MODE — off unless explicitly switched on.
 *
 * This screen used to prefill `owner@sumon.test` / `demo1234` and render a
 * one-click list of every seeded account. That is a good demo and an
 * indefensible sign-in page: the deployed site published working credentials
 * for the whole tenant to anyone who loaded it.
 *
 * The fix is a flag that defaults to OFF, not a deletion — the role picker is
 * genuinely the clearest way to show that permissions are enforced per role.
 * A real deployment simply never sets it, so it cannot leak by omission.
 */
const DEMO_MODE = process.env.NEXUS_DEMO_MODE === "true";

/** Generic failure. Never distinguishes wrong password from unknown account
 *  from locked account — each distinction is a user-enumeration oracle. */
const FAIL = "/login?error=1";

/**
 * The role this membership carries.
 *
 * Read through `withTenant`, not `withoutTenant`: `memberships` and `roles` are
 * RLS-protected and the app connection sees nothing without tenant context —
 * the same two-phase dance getSession() does. An account with no active
 * membership resolves to "", which requires nothing; that is not a hole,
 * because getSession() will refuse to build a principal for it either.
 */
async function roleKeyFor(userId: string, tenantId: string): Promise<string> {
  const rows = await withTenant({ tenantId, userId }, (tx) =>
    tx.execute<{ role_key: string }>(sql`
      SELECT r.key AS role_key
        FROM memberships m
        JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = ${userId}::uuid AND m.status = 'active'
       LIMIT 1
    `),
  );
  return rows[0]?.role_key ?? "";
}

async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const h = await headers();
  const ip = h.get("x-client-ip") ?? "local";
  // Carried on every event below. An authentication log without the caller is
  // a log you cannot act on during an incident.
  const meta = { ip, userAgent: h.get("user-agent") ?? undefined };

  // Two independent limits. The IP throttle stops a script; the per-account
  // limit stops a targeted attack that rotates IPs.
  const byIp = await rateLimit(`login:ip:${ip}`, 30, 300);
  const byAccount = await rateLimit(`login:acct:${email}`, 10, 300);
  if (!byIp.allowed || !byAccount.allowed) {
    security.throttled({
      ...meta,
      detail: { email, limit: byIp.allowed ? "account" : "ip" },
    });
    redirect("/login?error=throttled");
  }

  if (await isLockedOut(email)) {
    // Same generic failure — the attacker learns nothing from the lockout.
    // The *log* says everything, which is the whole point of keeping the two
    // channels separate: silent to the attacker, loud to the operator.
    security.lockout({ ...meta, detail: { email, stage: "locked account attempted" } });
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
    security.loginFailure({
      ...meta,
      userId: user?.id,
      detail: { email, reason: user ? "bad password" : "no such account" },
    });
    redirect(FAIL);
  }

  await clearFailedLogins(user.id);

  // Password is only the first factor. If MFA is enrolled, the real session is
  // not issued until the challenge is cleared.
  if (await isMfaEnabled(user.id)) {
    await createMfaChallenge(user.id, user.default_tenant_id);
    redirect("/login/verify");
  }

  /**
   * MFA is required by ROLE, not merely offered.
   *
   * The check above asks a question about the *user* — "did you turn this on?"
   * — and an owner who never turned it on answered no and was let straight in.
   * That is not an MFA policy, it is an MFA suggestion. `mfaRequiredFor` asks
   * the question that matters: may an account with this role move money without
   * a second factor? For owner, accountant and general manager the answer is
   * no, so a session is issued that can reach exactly one page — the one where
   * they can fix it. See setAuthLevel() in lib/mfa.ts for why the marker has to
   * be positive, and proxy.ts for where it is enforced.
   */
  const roleKey = await roleKeyFor(user.id, user.default_tenant_id);
  if (mfaRequiredFor(roleKey)) {
    const restricted = await createSession(user.id, user.default_tenant_id);
    await setAuthLevel("mfa_setup", restricted);
    security.loginSuccess({
      ...meta,
      userId: user.id,
      tenantId: user.default_tenant_id,
      actorRole: roleKey,
      detail: { email, outcome: "restricted — role requires MFA and none is enrolled" },
    });
    redirect("/settings/security?mfa=required");
  }

  const token = await createSession(user.id, user.default_tenant_id);
  await setAuthLevel("full", token);
  security.loginSuccess({
    ...meta,
    userId: user.id,
    tenantId: user.default_tenant_id,
    actorRole: roleKey,
    detail: { email, outcome: "password only — role does not require MFA" },
  });
  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  // Next 16: params and searchParams are Promises.
  searchParams: Promise<{ error?: string }>;
}) {
  // Only a FULLY authenticated session gets bounced away from sign-in. A
  // restricted `mfa_setup` session must be able to reach this page: proxy.ts
  // lists /login in MFA_SETUP_PATHS precisely so the enrolment gate cannot
  // strand anyone, and redirecting it to "/" would defeat that — the proxy
  // sends "/" straight back to /settings/security, so someone who opened the
  // wrong account could never get to the sign-in form to switch.
  if ((await getSession()) && (await currentAuthLevel()) === "full") redirect("/");
  const { error } = await searchParams;
  // Not merely hidden — outside demo mode the account list is never queried,
  // so it cannot reach the client in any form.
  const demoUsers = DEMO_MODE ? await listDemoUsers() : [];

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
                defaultValue={DEMO_MODE ? "owner@sumon.test" : undefined}
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
                defaultValue={DEMO_MODE ? "demo1234" : undefined}
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
                  : error === "session"
                    ? "Your session has ended. Sign in again."
                    : "Those credentials did not match an account."}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full">
              Sign in
            </button>
          </form>

          {DEMO_MODE && (
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
          )}
        </div>
      </section>
    </main>
  );
}
