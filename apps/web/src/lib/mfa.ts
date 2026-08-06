import "server-only";
import { Secret, TOTP } from "otpauth";
import { sql } from "drizzle-orm";
import { withoutTenant } from "@nexus/db";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./crypto";
export { encryptSecret } from "./crypto";

/**
 * TOTP multi-factor authentication (RFC 6238).
 *
 * Required for roles that can move money — owner, accountant, general manager —
 * and optional for everyone else. The gate is by *capability*, not seniority:
 * anyone who can approve a payment or read payroll needs a second factor,
 * because those are the accounts worth stealing.
 */

const ISSUER = "Nexus";
const DIGITS = 6;
const PERIOD = 30;
/**
 * Accept the adjacent window (±30s). One step, not two: every extra step
 * widens the brute-force surface and 30 seconds of clock skew is already
 * generous for a phone.
 */
const WINDOW = 1;

export const MFA_REQUIRED_ROLES = ["super_admin", "owner", "accountant", "general_manager"];

export function mfaRequiredFor(roleKey: string): boolean {
  return MFA_REQUIRED_ROLES.includes(roleKey);
}

function totpFor(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1", // what every authenticator app actually supports
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secret),
  });
}

export interface MfaEnrolment {
  secretBase32: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

/**
 * Begin enrolment.
 *
 * Nothing is persisted here. The secret is only written once the user proves
 * they can generate a valid code from it — otherwise a half-finished enrolment
 * locks them out of their own account.
 */
export function beginEnrolment(email: string): MfaEnrolment {
  const secret = new Secret({ size: 20 }); // 160 bits, the RFC 4226 recommendation
  const base32 = secret.base32;
  return {
    secretBase32: base32,
    otpauthUri: totpFor(base32, email).toString(),
    recoveryCodes: generateRecoveryCodes(),
  };
}

export function verifyCode(secretBase32: string, code: string, email = "user"): boolean {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== DIGITS) return false;
  const delta = totpFor(secretBase32, email).validate({ token: clean, window: WINDOW });
  return delta !== null;
}

/** Persist enrolment only after a code has been verified against the secret. */
export async function completeEnrolment(
  userId: string,
  email: string,
  secretBase32: string,
  code: string,
  recoveryCodes: string[],
): Promise<boolean> {
  if (!verifyCode(secretBase32, code, email)) return false;

  const encSecret = encryptSecret(secretBase32);
  // Recovery codes are HASHED, not encrypted — they are compared, never shown
  // again, so there is no reason for the server to be able to read them back.
  const encCodes = JSON.stringify(recoveryCodes.map(hashRecoveryCode));

  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE users
         SET mfa_secret_enc = ${encSecret},
             recovery_codes_enc = ${encCodes},
             mfa_enabled_at = now()
       WHERE id = ${userId}::uuid
    `),
  );
  return true;
}

export async function isMfaEnabled(userId: string): Promise<boolean> {
  const rows = await withoutTenant((db) =>
    db.execute<{ enabled: boolean }>(sql`
      SELECT (mfa_enabled_at IS NOT NULL AND mfa_secret_enc IS NOT NULL) AS enabled
        FROM users WHERE id = ${userId}::uuid
    `),
  );
  return Boolean(rows[0]?.enabled);
}

export type MfaResult = "ok" | "invalid" | "not_enrolled" | "recovery_used";

/**
 * Verify a login challenge, accepting either a TOTP code or a recovery code.
 *
 * A used recovery code is REMOVED, not just marked — single use has to be
 * enforced by deletion or it is not single use.
 */
export async function verifyChallenge(userId: string, code: string): Promise<MfaResult> {
  const rows = await withoutTenant((db) =>
    db.execute<{ secret: string | null; codes: string | null; email: string | null }>(sql`
      SELECT mfa_secret_enc AS secret, recovery_codes_enc AS codes, email
        FROM users WHERE id = ${userId}::uuid
    `),
  );
  const row = rows[0];
  if (!row?.secret) return "not_enrolled";

  if (verifyCode(decryptSecret(row.secret), code, row.email ?? "user")) return "ok";

  // Fall through to recovery codes.
  const stored: string[] = row.codes ? JSON.parse(row.codes) : [];
  const attempted = hashRecoveryCode(code);
  const index = stored.indexOf(attempted);
  if (index === -1) return "invalid";

  stored.splice(index, 1);
  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE users SET recovery_codes_enc = ${JSON.stringify(stored)}
       WHERE id = ${userId}::uuid
    `),
  );
  return "recovery_used";
}

export async function disableMfa(userId: string): Promise<void> {
  await withoutTenant((db) =>
    db.execute(sql`
      UPDATE users
         SET mfa_secret_enc = NULL, recovery_codes_enc = NULL, mfa_enabled_at = NULL
       WHERE id = ${userId}::uuid
    `),
  );
}

/**
 * Carry the in-progress enrolment secret between showing the QR and verifying
 * the first code.
 *
 * A signed, short-lived cookie rather than a database row: an abandoned
 * enrolment must leave no trace, and persisting an unverified secret is exactly
 * the half-finished state that locks a user out. The secret is encrypted inside
 * the cookie so a stolen cookie does not hand over the seed.
 */
const ENROL_COOKIE = "nexus_mfa_enrol";
const ENROL_WINDOW_MINUTES = 15;

export async function stashEnrolment(secretBase32: string, recoveryCodes: string[]): Promise<void> {
  const { cookies } = await import("next/headers");
  const payload = JSON.stringify({ s: secretBase32, r: recoveryCodes });
  const jar = await cookies();
  jar.set(ENROL_COOKIE, encryptSecret(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ENROL_WINDOW_MINUTES * 60,
  });
}

export async function readStashedEnrolment(): Promise<{ secret: string; recoveryCodes: string[] } | null> {
  const { cookies } = await import("next/headers");
  const raw = (await cookies()).get(ENROL_COOKIE)?.value;
  if (!raw) return null;
  try {
    const { s, r } = JSON.parse(decryptSecret(raw));
    return { secret: s, recoveryCodes: r };
  } catch {
    return null;
  }
}

export async function clearStashedEnrolment(): Promise<void> {
  const { cookies } = await import("next/headers");
  (await cookies()).delete(ENROL_COOKIE);
}
