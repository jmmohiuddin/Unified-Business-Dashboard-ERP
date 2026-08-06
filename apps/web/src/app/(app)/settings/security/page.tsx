import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { withoutTenant } from "@nexus/db";
import { mfaRequiredFor } from "@/lib/mfa";
import {
  beginEnrolment,
  clearStashedEnrolment,
  completeEnrolment,
  disableMfa,
  isMfaEnabled,
  readStashedEnrolment,
  stashEnrolment,
} from "@/lib/mfa";
import { requireSession, revokeAllSessions } from "@/lib/session";
import { qrSvg } from "@/lib/qr";
import { Card, CardHeader, Chip } from "@/components/ui";
import { PageHeader } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Per-user security settings.
 *
 * The login flow already ENFORCES MFA for money-handling roles — but nothing
 * let a user turn it on. This closes that loop: enrol an authenticator, save
 * recovery codes, and sign out other sessions. A security control the user
 * cannot actually enable is not a control.
 *
 * The enrolment is two steps on purpose. Step one shows a QR and holds the
 * secret in a short-lived encrypted cookie; step two persists it only once the
 * user proves they can generate a valid code. A half-finished enrolment leaves
 * no trace and cannot lock anyone out.
 */

async function startEnrolment() {
  "use server";
  const session = await requireSession();
  const enrol = beginEnrolment(session.email ?? "user");
  await stashEnrolment(enrol.secretBase32, enrol.recoveryCodes);
  redirect("/settings/security?step=verify");
}

async function confirmEnrolment(formData: FormData) {
  "use server";
  const session = await requireSession();
  const stashed = await readStashedEnrolment();
  if (!stashed) redirect("/settings/security?error=expired");

  const ok = await completeEnrolment(
    session.userId,
    session.email ?? "user",
    stashed.secret,
    String(formData.get("code") ?? ""),
    stashed.recoveryCodes,
  );
  if (!ok) redirect("/settings/security?step=verify&error=code");

  await clearStashedEnrolment();
  redirect("/settings/security?enabled=1");
}

async function turnOff() {
  "use server";
  const session = await requireSession();
  if (mfaRequiredFor(session.principal.roleKey)) {
    // The login flow requires MFA for this role; letting them disable it would
    // just lock them out on next sign-in. Refuse rather than create that trap.
    redirect("/settings/security?error=required");
  }
  await disableMfa(session.userId);
  redirect("/settings/security?disabled=1");
}

async function endOtherSessions() {
  "use server";
  const session = await requireSession();
  await revokeAllSessions(session.userId, { keepCurrent: true });
  redirect("/settings/security?sessions=1");
}

export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string; enabled?: string; disabled?: string; sessions?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const enabled = await isMfaEnabled(session.userId);
  const required = mfaRequiredFor(session.principal.roleKey);

  const [sessionRow] = await withoutTenant((db) =>
    db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int n FROM sessions
       WHERE user_id = ${session.userId}::uuid AND revoked_at IS NULL AND expires_at > now()
    `),
  );
  const activeSessions = sessionRow?.n ?? 1;

  // If we're mid-enrolment, show the QR and the verify form.
  const stashed = sp.step === "verify" ? await readStashedEnrolment() : null;
  const otpauth = stashed
    ? new (await import("otpauth")).TOTP({
        issuer: "Nexus",
        label: session.email ?? "user",
        secret: (await import("otpauth")).Secret.fromBase32(stashed.secret),
      }).toString()
    : null;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[720px] mx-auto space-y-5">
      <PageHeader
        title="Security"
        subtitle={`${session.fullName} · ${session.principal.roleKey.replace(/_/g, " ")}`}
      />

      {sp.enabled && <Banner tone="positive">Two-factor authentication is now on.</Banner>}
      {sp.disabled && <Banner tone="caution">Two-factor authentication has been turned off.</Banner>}
      {sp.sessions && <Banner tone="positive">All other sessions were signed out.</Banner>}
      {sp.error === "required" && (
        <Banner tone="negative">Your role requires two-factor authentication — it cannot be turned off.</Banner>
      )}
      {sp.error === "expired" && (
        <Banner tone="negative">That enrolment expired. Start again.</Banner>
      )}

      {/* ── MFA ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Two-factor authentication"
          subtitle="A time-based code from an authenticator app, on top of your password"
          action={
            <Chip tone={enabled ? "positive" : required ? "negative" : "caution"}>
              {enabled ? "on" : required ? "required" : "off"}
            </Chip>
          }
        />
        <div className="px-4 pb-4">
          {enabled ? (
            <div className="space-y-3">
              <p className="text-xs text-muted leading-relaxed">
                Your account is protected by a second factor. You will be asked for a code at each
                sign-in.
              </p>
              {!required && (
                <form action={turnOff}>
                  <button type="submit" className="btn btn-ghost text-xs">
                    Turn off
                  </button>
                </form>
              )}
              {required && (
                <p className="text-2xs text-subtle">
                  Your role handles money, so two-factor authentication is mandatory and cannot be
                  disabled.
                </p>
              )}
            </div>
          ) : stashed && otpauth ? (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-[auto_1fr] gap-4 items-start">
                <div
                  className="rounded-[var(--radius-md)] overflow-hidden shrink-0"
                  style={{ width: 180, height: 180, background: "#fff", padding: 8 }}
                  dangerouslySetInnerHTML={{ __html: qrSvg(otpauth, 164) }}
                />
                <div className="min-w-0 space-y-2">
                  <p className="text-xs leading-relaxed">
                    Scan this with Google Authenticator, Microsoft Authenticator, 1Password or any
                    TOTP app. Or enter the key manually:
                  </p>
                  <code
                    className="block text-2xs tnum break-all px-2 py-1.5 rounded-[var(--radius-sm)]"
                    style={{ background: "var(--surface-2)" }}
                  >
                    {stashed.secret}
                  </code>
                  <div>
                    <p className="label mb-1">Recovery codes — save these now</p>
                    <div className="grid grid-cols-2 gap-1">
                      {stashed.recoveryCodes.map((c) => (
                        <code
                          key={c}
                          className="text-2xs tnum px-1.5 py-0.5 rounded-[var(--radius-sm)]"
                          style={{ background: "var(--surface-2)" }}
                        >
                          {c}
                        </code>
                      ))}
                    </div>
                    <p className="text-2xs text-subtle mt-1">
                      Each works once if you lose your phone. They are shown only now.
                    </p>
                  </div>
                </div>
              </div>

              <form action={confirmEnrolment} className="flex items-end gap-2 flex-wrap">
                <div>
                  <label htmlFor="code" className="label block mb-1">
                    Enter the 6-digit code to confirm
                  </label>
                  <input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    placeholder="123456"
                    className="px-3 py-2 rounded-[var(--radius-md)] text-sm tnum tracking-[0.25em] w-40 text-center"
                    style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
                <button type="submit" className="btn btn-primary text-xs">
                  Confirm and enable
                </button>
              </form>
              {sp.error === "code" && (
                <p className="text-2xs" style={{ color: "var(--negative)" }} role="alert">
                  That code was not valid. Codes rotate every 30 seconds.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted leading-relaxed">
                {required
                  ? "Your role requires two-factor authentication. Set it up now to keep access."
                  : "Add a second factor so a stolen password alone cannot sign in as you."}
              </p>
              <form action={startEnrolment}>
                <button type="submit" className="btn btn-primary text-xs">
                  Set up authenticator
                </button>
              </form>
            </div>
          )}
        </div>
      </Card>

      {/* ── Sessions ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Active sessions"
          subtitle={`${activeSessions} device${activeSessions === 1 ? "" : "s"} signed in`}
        />
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted leading-relaxed">
            If you have signed in somewhere you no longer trust, end every other session. Unlike a
            password change, this immediately invalidates their tokens.
          </p>
          <form action={endOtherSessions}>
            <button
              type="submit"
              className="btn btn-ghost text-xs"
              disabled={activeSessions <= 1}
            >
              Sign out all other sessions
            </button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: "positive" | "caution" | "negative" }) {
  const bg = tone === "positive" ? "var(--positive-soft)" : tone === "negative" ? "var(--negative-soft)" : "var(--caution-soft)";
  const fg = tone === "positive" ? "var(--positive)" : tone === "negative" ? "var(--negative)" : "var(--caution)";
  return (
    <div className="text-xs px-3 py-2 rounded-[var(--radius-md)]" style={{ background: bg, color: fg }} role="status">
      {children}
    </div>
  );
}
