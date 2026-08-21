import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { security } from "@nexus/core";
import { clearMfaChallenge, createSession, readMfaChallenge } from "@/lib/session";
import { setAuthLevel, verifyChallenge } from "@/lib/mfa";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * MFA challenge.
 *
 * A separate route with a separate short-lived cookie, so there is no state in
 * which a password-only session could be mistaken for a fully authenticated
 * one. The pending cookie is HMAC-signed and expires in ten minutes.
 */
async function verifyMfa(formData: FormData) {
  "use server";
  const code = String(formData.get("code") ?? "").trim();
  const pending = await readMfaChallenge();
  if (!pending) redirect("/login?error=1");

  const h = await headers();
  const ip = h.get("x-client-ip") ?? "local";
  const meta = {
    ip,
    userAgent: h.get("user-agent") ?? undefined,
    userId: pending.userId,
    tenantId: pending.tenantId,
  };
  // Tighter than the password limit: six digits is a small keyspace, so the
  // number of guesses matters far more than it does for a passphrase.
  const limit = await rateLimit(`mfa:${pending.userId}:${ip}`, 8, 300);
  if (!limit.allowed) {
    security.throttled({ ...meta, detail: { stage: "mfa challenge" } });
    await clearMfaChallenge();
    redirect("/login?error=throttled");
  }

  const result = await verifyChallenge(pending.userId, code);
  if (result === "invalid" || result === "not_enrolled") {
    // Someone who cleared the password factor and cannot clear the second one
    // is the single most interesting event in this file — it is what a stolen
    // or phished password looks like from the server's side.
    security.mfaFailure({ ...meta, detail: { result } });
    redirect("/login/verify?error=1");
  }

  await clearMfaChallenge();
  const token = await createSession(pending.userId, pending.tenantId);
  // The second factor is satisfied, so this session is unrestricted regardless
  // of what the role requires. See setAuthLevel() in lib/mfa.ts.
  await setAuthLevel("full", token);
  if (result === "recovery_used") {
    // Alertable: a recovery code means the authenticator is gone, which is
    // either a lost phone or an attacker who has one and not the other.
    security.recoveryUsed({ ...meta, detail: { stage: "login" } });
  }
  redirect(result === "recovery_used" ? "/?recovery=1" : "/");
}

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const pending = await readMfaChallenge();
  if (!pending) redirect("/login");
  const { error } = await searchParams;

  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-6">
          <div
            className="w-7 h-7 rounded-lg grid place-items-center text-xs font-bold"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            N
          </div>
          <span className="font-semibold tracking-tight">Nexus</span>
        </div>

        <h1 className="text-xl font-semibold tracking-tight">Two-factor verification</h1>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          Enter the six-digit code from your authenticator app, or one of your recovery codes.
        </p>

        <form action={verifyMfa} className="mt-6 space-y-3">
          <div>
            <label htmlFor="code" className="label block mb-1.5">
              Code
            </label>
            <input
              id="code"
              name="code"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              required
              placeholder="123456"
              className="w-full px-3 py-2 rounded-[var(--radius-md)] text-lg tnum tracking-[0.3em] text-center"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
            />
          </div>

          {error && (
            <p
              className="text-xs px-3 py-2 rounded-[var(--radius-md)]"
              style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
              role="alert"
            >
              That code was not valid. Codes rotate every 30 seconds.
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full">
            Verify
          </button>
        </form>

        <p className="text-2xs text-subtle mt-4 leading-relaxed">
          Recovery codes are single use — once entered, that code is deleted. If you have run out,
          an administrator must reset your second factor.
        </p>

        <Link href="/login" className="btn btn-ghost text-xs mt-4">
          ← Use a different account
        </Link>
      </div>
    </main>
  );
}
