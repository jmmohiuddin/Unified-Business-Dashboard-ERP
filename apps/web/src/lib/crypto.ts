import "server-only";
import { hash, verify } from "@node-rs/argon2";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Password hashing and secret encryption.
 *
 * Every credential-handling primitive lives in this one file so the security
 * review has a single surface to read rather than a hunt through the codebase.
 */

/**
 * argon2id parameters.
 *
 * OWASP's current recommendation is a minimum of 19 MiB memory, 2 iterations
 * and 1 degree of parallelism. We run 64 MiB / 3 / 4, which is comfortably
 * above that and still lands around 50–80 ms on server hardware — slow enough
 * to make offline cracking expensive, fast enough that login does not feel slow.
 *
 * argon2id (not argon2i or argon2d) because it is the hybrid that resists both
 * GPU cracking and side-channel attacks, and it is what OWASP names first.
 */
const ARGON2_OPTIONS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a password.
 *
 * Returns false rather than throwing on a malformed hash, so a corrupt row
 * cannot become a 500 that distinguishes "bad hash" from "wrong password" —
 * which would be an oracle.
 */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Still burn comparable time so a missing account is not detectable by
    // response latency. This is the classic user-enumeration side channel.
    await hash("timing-equalisation-dummy", ARGON2_OPTIONS).catch(() => {});
    return false;
  }
  try {
    return await verify(stored, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** Minimum viable password policy. Length beats composition rules. */
export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 256) return "That is longer than 256 characters.";
  // Rejecting the handful of passwords that actually get used is worth more
  // than forcing a symbol nobody remembers.
  const common = ["password", "12345678", "qwerty", "letmein", "admin123", "welcome1"];
  if (common.some((c) => pw.toLowerCase().includes(c))) {
    return "That contains a very common password. Pick something else.";
  }
  return null;
}

// ── Secret encryption (MFA seeds, recovery codes) ───────────────────────────

/**
 * AES-256-GCM envelope for secrets that must be RECOVERABLE rather than hashed.
 *
 * A TOTP seed cannot be hashed — the server needs the original to compute the
 * expected code. Storing it in plaintext means a database leak hands over every
 * second factor, which defeats the point of having one. So it is encrypted at
 * the application layer with a key that lives outside the database.
 */
function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET must be set to at least 16 characters");
  }
  // Derived, not used raw, so AUTH_SECRET can be a human-typed string.
  return scryptSync(secret, "nexus-secret-encryption-v1", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** Ten single-use codes, shown once at enrolment. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase())
    .digest("hex");
}

/** Constant-time comparison for anything token-shaped. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
