import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * FIELD-LEVEL ENCRYPTION FOR PERSONAL DATA.
 *
 * RLS protects one tenant from another. It does nothing about a stolen backup,
 * a compromised read replica, or a support engineer with a psql prompt. For
 * identity documents that is not good enough: an Emirates ID, a passport number
 * and an IBAN together are enough to attempt identity fraud, and under UAE
 * Federal Decree-Law 45/2021 (PDPL) they are personal data the controller is
 * obliged to protect with appropriate technical measures.
 *
 * The three problems this module solves, in the order they bite:
 *
 *  1. ENCRYPTION. AES-256-GCM with a per-value random IV. Authenticated, so a
 *     tampered ciphertext fails loudly rather than decrypting to garbage.
 *
 *  2. SEARCH. Encrypted columns cannot be queried with `=`. A deterministic
 *     cipher would restore search but leak equality across the whole table.
 *     Instead each value carries a BLIND INDEX — HMAC-SHA256 under a separate
 *     key — which supports exact lookup and nothing else. No range queries, no
 *     prefix matching, no frequency analysis beyond exact duplicates.
 *
 *  3. ROTATION. The key id is embedded in every envelope, so a new key can be
 *     introduced without a big-bang re-encryption: new writes use the active
 *     key, old values decrypt under their original key, and a background job
 *     migrates them. A scheme without this is a scheme you can never rotate.
 *
 * Display uses a masked hint stored alongside (last four characters), so a list
 * screen never needs to decrypt hundreds of rows just to show `••••1234`.
 */

export interface PiiKeyring {
  /** Key id → 32-byte key. Ids are small integers as strings. */
  keys: Record<string, Buffer>;
  /** The key new writes are encrypted under. */
  activeKeyId: string;
  /** Separate key for blind indexes — never the same as an encryption key. */
  indexKey: Buffer;
}

let cached: PiiKeyring | null = null;

/**
 * Build the keyring from the environment.
 *
 * Production requires `PII_ENCRYPTION_KEYS`. Development derives a key from
 * `AUTH_SECRET` so the app runs out of the box — but that derivation is
 * explicitly refused in production, because a key derived from a value that
 * also signs cookies is not a key, it is a liability.
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): PiiKeyring {
  if (cached) return cached;

  const raw = env.PII_ENCRYPTION_KEYS;
  const isProduction = env.NODE_ENV === "production";

  if (raw) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("PII_ENCRYPTION_KEYS must be JSON: {\"1\":\"<base64 32 bytes>\"}");
    }
    const keys: Record<string, Buffer> = {};
    for (const [id, b64] of Object.entries(parsed)) {
      const buf = Buffer.from(b64, "base64");
      if (buf.length !== 32) {
        throw new Error(`PII key "${id}" must be exactly 32 bytes (got ${buf.length}).`);
      }
      keys[id] = buf;
    }
    const activeKeyId = env.PII_ACTIVE_KEY_ID ?? Object.keys(keys).sort().at(-1)!;
    if (!keys[activeKeyId]) {
      throw new Error(`PII_ACTIVE_KEY_ID "${activeKeyId}" is not present in PII_ENCRYPTION_KEYS.`);
    }
    const indexKey = env.PII_INDEX_KEY
      ? Buffer.from(env.PII_INDEX_KEY, "base64")
      : Buffer.from(hkdfSync("sha256", keys[activeKeyId]!, "nexus-blind-index", "v1", 32));
    cached = { keys, activeKeyId, indexKey };
    return cached;
  }

  if (isProduction) {
    throw new Error(
      "PII_ENCRYPTION_KEYS is required in production. Generate one with:\n" +
        "  node -e \"console.log(JSON.stringify({1: require('crypto').randomBytes(32).toString('base64')}))\"",
    );
  }

  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET must be at least 16 characters to derive a development PII key.");
  }
  const derived = Buffer.from(hkdfSync("sha256", secret, "nexus-pii-dev", "v1", 32));
  cached = {
    keys: { dev: derived },
    activeKeyId: "dev",
    indexKey: Buffer.from(hkdfSync("sha256", secret, "nexus-blind-index-dev", "v1", 32)),
  };
  return cached;
}

/** Test/rotation hook. */
export function resetKeyring(): void {
  cached = null;
}

/** Normalise before hashing so formatting variants match: 784-1990-1234567-1
 *  and 78419901234567 1 index identically. */
function normalise(value: string): string {
  return value.replace(/[\s\-/._]/g, "").toUpperCase();
}

/** Envelope: `p1.<keyId>.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptPii(plain: string, keyring = loadKeyring()): string {
  const key = keyring.keys[keyring.activeKeyId]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The key id is authenticated additional data, so an attacker cannot swap the
  // label to force decryption under a different (perhaps leaked) key.
  cipher.setAAD(Buffer.from(keyring.activeKeyId, "utf8"));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "p1",
    keyring.activeKeyId,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptPii(envelope: string | null, keyring = loadKeyring()): string | null {
  if (!envelope) return null;
  const [version, keyId, ivB64, tagB64, dataB64] = envelope.split(".");
  if (version !== "p1" || !keyId || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed PII envelope");
  }
  const key = keyring.keys[keyId];
  if (!key) {
    // A retired key must never be silently dropped from the keyring: the data
    // encrypted under it becomes permanently unreadable.
    throw new Error(`PII key "${keyId}" is not in the keyring — cannot decrypt.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(keyId, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Best-effort decrypt for display paths where one bad row must not break a
 *  whole list. Returns null and lets the caller show the mask instead. */
export function tryDecryptPii(envelope: string | null): string | null {
  try {
    return decryptPii(envelope);
  } catch {
    return null;
  }
}

/**
 * Blind index — exact-match lookup over encrypted data.
 *
 * Keyed HMAC, not a plain hash: an unkeyed hash of an Emirates ID is trivially
 * reversible by brute force, because the format is only ~10^11 possibilities.
 * Truncated to 128 bits, which is far beyond collision risk at this scale and
 * halves the index size.
 */
export function blindIndex(value: string | null, keyring = loadKeyring()): string | null {
  if (!value) return null;
  return createHmac("sha256", keyring.indexKey)
    .update(normalise(value))
    .digest("base64url")
    .slice(0, 22);
}

/** Constant-time blind-index comparison, for code paths that compare in JS. */
export function blindIndexEquals(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Masked hint stored in plaintext for display.
 *
 * Last four characters only. Enough for a human to confirm they are looking at
 * the right record, useless to anyone who steals the table.
 */
export function maskHint(value: string | null): string | null {
  if (!value) return null;
  const clean = normalise(value);
  return clean.length <= 4 ? "••••" : `••••${clean.slice(-4)}`;
}

/** Everything needed to persist one protected field. */
export interface ProtectedField {
  enc: string | null;
  bidx: string | null;
  hint: string | null;
}

export function protect(value: string | null | undefined): ProtectedField {
  if (!value || value.trim() === "") return { enc: null, bidx: null, hint: null };
  const trimmed = value.trim();
  return {
    enc: encryptPii(trimmed),
    bidx: blindIndex(trimmed),
    hint: maskHint(trimmed),
  };
}

/**
 * Re-encrypt an envelope under the active key.
 *
 * Used by the rotation job. Returns null when the value is already current, so
 * the job can skip the write rather than churning every row on every run.
 */
export function rotateEnvelope(envelope: string, keyring = loadKeyring()): string | null {
  const keyId = envelope.split(".")[1];
  if (keyId === keyring.activeKeyId) return null;
  return encryptPii(decryptPii(envelope, keyring)!, keyring);
}

export function keyIdOf(envelope: string | null): string | null {
  return envelope?.split(".")[1] ?? null;
}

/** Generate a fresh key, for `npm run keygen`. */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}
