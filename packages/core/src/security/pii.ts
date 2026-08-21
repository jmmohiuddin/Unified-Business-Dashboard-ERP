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
 *
 * ── THE TWO ENVELOPE FORMATS IN THIS CODEBASE ───────────────────────────────
 *
 * There are two, and confusing them has already cost one broken control:
 *
 *   `p1.<keyId>.<iv>.<tag>.<data>`  THIS module. Keyed from PII_ENCRYPTION_KEYS,
 *                                   carries a key id, rotatable online.
 *   `v1.<iv>.<tag>.<data>`          apps/web/src/lib/crypto.ts — MFA seeds and
 *                                   recovery codes. Keyed from AUTH_SECRET,
 *                                   carries NO key id.
 *
 * The second field means completely different things in the two formats. The
 * rotation CLI used to read it blindly, so for every MFA secret it took the
 * base64url IV to be a key id, decided the row was stale, and then died trying
 * to decrypt a `v1.` envelope as a `p1.` one — halfway through a sweep, with no
 * resume path. `keyIdOf` below therefore refuses to answer for anything that is
 * not a `p1.` envelope: "I do not know" is the only answer that cannot be
 * mistaken for a real key id.
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
 * Highest key id, comparing ids as NUMBERS when they look like numbers.
 *
 * `Object.keys(keys).sort().at(-1)` is a lexicographic sort, so it picks "9"
 * over "10" — the tenth rotation would silently start writing under the ninth
 * key and the rotation sweep would then keep reporting rows as stale forever.
 * Ids that are not numeric fall back to a string compare so a keyring labelled
 * `{"2024a": …}` still resolves deterministically.
 */
function highestKeyId(ids: string[]): string {
  const allNumeric = ids.every((id) => /^\d+$/.test(id));
  return [...ids].sort((a, b) => (allNumeric ? Number(a) - Number(b) : a < b ? -1 : 1)).at(-1)!;
}

/**
 * Resolve the blind-index key.
 *
 * THE DEPENDENCY THIS FUNCTION EXISTS TO MAKE LOUD. The blind index is what
 * makes an encrypted column searchable; `employees_emirates_id_bidx_uq` is a
 * UNIQUE index over it, so it is also what stops the same person being onboarded
 * twice. Every stored `_bidx` was computed under whatever key was in force when
 * the row was written, and the rotation sweep deliberately does NOT rebuild them
 * — it re-encrypts `_enc` only.
 *
 * So if the index key is DERIVED from the active encryption key, rotating the
 * encryption key changes every blind index, and every exact-match lookup on
 * Emirates ID, passport and national ID quietly returns zero rows. Nothing
 * throws. The system simply stops finding people, and the duplicate-employee
 * guard stops guarding.
 *
 * The fix is not to derive more cleverly, it is to derive from something the
 * rotation never touches:
 *
 *   PII_INDEX_KEY set   — use it. This is the only supported production shape,
 *                         and `npm run keygen` emits it.
 *   unset, production   — refuse. Fail-closed: the CLIs (rotation, seed, backup)
 *                         never call `checkConfiguration`, so the boot gate
 *                         cannot be the only place this is enforced.
 *   unset, development  — derive from AUTH_SECRET, which the rotation CLI does
 *                         not change, and say so loudly on every boot.
 */
function resolveIndexKey(env: NodeJS.ProcessEnv, isProduction: boolean): Buffer {
  if (env.PII_INDEX_KEY) {
    // `.env.example` is loaded as a fallback by the CLIs, so its unsubstituted
    // placeholders arrive here as real values. Say that plainly rather than
    // reporting a byte count: "<run npm run keygen>" decodes to 11 bytes, and
    // "got 11" sends the reader looking for a truncated key that does not exist.
    if (/^<.*>$/.test(env.PII_INDEX_KEY.trim())) {
      throw new Error(
        `PII_INDEX_KEY is still the placeholder ${env.PII_INDEX_KEY.trim()} from .env.example.\n` +
          "  Generate a real one and put it in .env:\n" +
          "      npm run keygen",
      );
    }
    const buf = Buffer.from(env.PII_INDEX_KEY, "base64");
    if (buf.length !== 32) {
      throw new Error(`PII_INDEX_KEY must be exactly 32 bytes of base64 (got ${buf.length}).`);
    }
    return buf;
  }

  if (isProduction) {
    throw new Error(
      "PII_INDEX_KEY is required whenever PII_ENCRYPTION_KEYS is set.\n" +
        "  Without it the blind index would be derived from the ACTIVE encryption\n" +
        "  key, and the next key rotation would silently invalidate every blind\n" +
        "  index — including the unique Emirates ID index. Generate one with:\n" +
        "      npm run keygen",
    );
  }

  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "PII_INDEX_KEY is not set and AUTH_SECRET is too short to derive a development " +
        "blind-index key from. Run: npm run keygen",
    );
  }
  console.warn(
    "⚠ PII_INDEX_KEY is not set. Blind indexes are being derived from AUTH_SECRET.\n" +
      "  This keeps them stable across PII key rotation, but rotating AUTH_SECRET\n" +
      "  will invalidate every blind index. Set PII_INDEX_KEY (npm run keygen).",
  );
  return Buffer.from(hkdfSync("sha256", secret, "nexus-blind-index-from-auth", "v1", 32));
}

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
    if (Object.keys(keys).length === 0) {
      throw new Error("PII_ENCRYPTION_KEYS is empty — at least one key is required.");
    }
    const activeKeyId = env.PII_ACTIVE_KEY_ID ?? highestKeyId(Object.keys(keys));
    if (!keys[activeKeyId]) {
      throw new Error(`PII_ACTIVE_KEY_ID "${activeKeyId}" is not present in PII_ENCRYPTION_KEYS.`);
    }
    cached = { keys, activeKeyId, indexKey: resolveIndexKey(env, isProduction) };
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

/** The only envelope version this module writes or reads. See the header for
 *  the other format in this codebase and why the two must never be conflated. */
export const PII_ENVELOPE_VERSION = "p1";

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
  if (version !== PII_ENVELOPE_VERSION || !keyId || !ivB64 || !tagB64 || !dataB64) {
    // The version tag is echoed — sanitised — because "Malformed PII envelope"
    // on its own sent the last investigation looking for corruption when the
    // real answer was "that is a v1. secret envelope, from a different module
    // with a different key". Never echo any later field: those are key
    // material-adjacent (IV, tag, ciphertext).
    throw new Error(`Malformed PII envelope (version ${describeVersion(version)})`);
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
 * the job can skip the write rather than churning every row on every run — which
 * is also what makes the sweep idempotent and therefore safe to re-run after a
 * partial failure.
 *
 * Throws `ForeignEnvelopeError` rather than a generic decrypt failure when
 * handed something that is not a `p1.` envelope, so the caller can count it,
 * report it and carry on instead of aborting a half-finished rotation.
 */
export class ForeignEnvelopeError extends Error {
  constructor(readonly version: string) {
    super(
      `Not a PII envelope (version ${version}) — this value belongs to another ` +
        `encryption scheme and must not be rotated with the PII keyring.`,
    );
    this.name = "ForeignEnvelopeError";
  }
}

export function rotateEnvelope(envelope: string, keyring = loadKeyring()): string | null {
  const keyId = keyIdOf(envelope);
  if (keyId === null) throw new ForeignEnvelopeError(describeVersion(envelope.split(".")[0]));
  if (keyId === keyring.activeKeyId) return null;
  return encryptPii(decryptPii(envelope, keyring)!, keyring);
}

/** True only for envelopes this module wrote. */
export function isPiiEnvelope(envelope: string | null): boolean {
  return keyIdOf(envelope) !== null;
}

/**
 * The key id an envelope was encrypted under, or null if it does not have one.
 *
 * Null covers two cases that must not be confused with a key id: no value at
 * all, and a value in someone else's envelope format. The second field of a
 * `v1.` secret envelope is the IV, and returning that as a key id is precisely
 * how the rotation sweep came to classify every MFA secret as stale.
 */
export function keyIdOf(envelope: string | null): string | null {
  if (!envelope) return null;
  const [version, keyId] = envelope.split(".");
  return version === PII_ENVELOPE_VERSION && keyId ? keyId : null;
}

/** Version tags are structural, not secret — but only echo one back if it looks
 *  like a tag. Arbitrary bytes in that position are corruption, not a label. */
function describeVersion(version: string | undefined): string {
  return version && /^[A-Za-z0-9_-]{1,8}$/.test(version) ? `"${version}"` : "unrecognised";
}

/** Generate a fresh key, for `npm run keygen`. */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}
