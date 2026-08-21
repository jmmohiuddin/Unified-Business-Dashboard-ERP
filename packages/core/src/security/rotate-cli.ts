/**
 * PII key rotation.
 *
 *   npm run pii:rotate                       # report what needs re-encrypting
 *   npm run pii:rotate -- --commit           # do it
 *   npm run pii:rotate -- --secrets          # report on AUTH_SECRET-keyed secrets
 *   npm run pii:rotate -- --secrets --commit # re-key them from AUTH_SECRET_PREVIOUS
 *
 * Rotation is online and incremental. Add a new key to PII_ENCRYPTION_KEYS, set
 * PII_ACTIVE_KEY_ID to it, and run this: new writes already use the new key,
 * and this walks the existing rows. The OLD key must stay in the keyring until
 * this reports zero remaining, or the data encrypted under it becomes
 * permanently unreadable.
 *
 * A scheme you cannot rotate is a scheme that will still be using its first key
 * the day it leaks.
 *
 * ── WHY THERE ARE TWO SWEEPS ────────────────────────────────────────────────
 *
 * This file used to sweep `users.mfa_secret_enc` alongside the identity columns
 * and it could not work, because that column is not in this scheme at all. MFA
 * seeds are written by `encryptSecret` (apps/web/src/lib/crypto.ts) as
 * `v1.<iv>.<tag>.<data>` under a key derived from AUTH_SECRET; the identity
 * columns are written by `encryptPii` as `p1.<keyId>.<iv>.<tag>.<data>` under
 * PII_ENCRYPTION_KEYS. The second field means "IV" in one and "key id" in the
 * other, so every MFA secret looked stale, and the run then died decrypting a
 * `v1.` value as a `p1.` one — after `employees` and `parties` had already been
 * written, with no resume path.
 *
 * The two are kept apart rather than merged, and the choice is deliberate:
 *
 *   · DIFFERENT KEY CUSTODY. Rotating a PII key is a routine, online, per-row
 *     migration that no user notices. Rotating AUTH_SECRET invalidates every
 *     session and every signed MFA challenge in the same instant. Putting both
 *     behind one flag would let an operator perform the second while intending
 *     the first.
 *   · DIFFERENT SCOPE. `employees` and `parties` are tenant-scoped and RLS-
 *     protected, so they must be swept per tenant under `withTenant`. `users` is
 *     one of the six deliberately global tables (packages/db/src/sql/rls.ts), so
 *     sweeping it per tenant would process every row once per tenant.
 *   · THE `v1.` FORMAT CARRIES NO KEY ID, so it cannot express "this row is on
 *     the old key" the way a `p1.` envelope can. Its rotation is necessarily
 *     all-or-nothing against a named previous secret, not incremental.
 *
 * Migrating MFA seeds onto `encryptPii` instead would work, but `decryptSecret`
 * in apps/web would have to learn the `p1.` format for the enrolled users who
 * already exist — a change to the authentication path to fix a rotation bug.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────
 *
 *   0  nothing left to do — every value is on the active key. Only now is it
 *      safe to retire the old key from PII_ENCRYPTION_KEYS.
 *   2  work remains. A dry run found stale rows, or a --commit run finished with
 *      rows it could not rotate. Re-run; the sweep is idempotent per row and
 *      commits per tenant, so it resumes rather than restarting.
 *   1  the run could not complete at all (bad configuration, no database).
 *
 * "Zero rows rotated" and "the job never looked" must never share an exit code:
 * an operator who retires a key on the strength of a false all-clear makes every
 * remaining row permanently unreadable, which `decryptPii` enforces by design.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant, withoutTenant } from "@nexus/db";
import { ForeignEnvelopeError, keyIdOf, loadKeyring, rotateEnvelope } from "./pii.ts";
import { securityEvent } from "./events.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const commit = process.argv.includes("--commit");
const secretsMode = process.argv.includes("--secrets");

const EXIT_CLEAN = 0;
const EXIT_ERROR = 1;
const EXIT_INCOMPLETE = 2;

/**
 * Every TENANT-SCOPED encrypted column in the schema. Adding one here is the
 * only step required to bring it into the rotation.
 *
 * Everything in this list must be written by `encryptPii`. A column encrypted by
 * anything else does not belong here — see the header.
 */
const ENCRYPTED_COLUMNS: { table: string; idColumn: string; columns: string[] }[] = [
  {
    table: "employees",
    idColumn: "id",
    columns: [
      "emirates_id_enc",
      "passport_number_enc",
      "iban_enc",
      "visa_number_enc",
      "labour_card_number_enc",
    ],
  },
  { table: "parties", idColumn: "id", columns: ["national_id_enc", "tax_id_enc"] },
];

interface Counts {
  scanned: number;
  stale: number;
  rotated: number;
  /** Rows that could not be rotated. Counted, never fatal — one poisoned value
   *  must not strand the other ten thousand on a retired key. */
  failed: number;
}

const zero = (): Counts => ({ scanned: 0, stale: 0, rotated: 0, failed: 0 });

function add(into: Counts, from: Counts): void {
  into.scanned += from.scanned;
  into.stale += from.stale;
  into.rotated += from.rotated;
  into.failed += from.failed;
}

/**
 * Every tenant, not just the first.
 *
 * The previous version took `SELECT id FROM tenants LIMIT 1` and wrapped the
 * whole sweep in one `withTenant`. RLS then hid every other tenant's rows and
 * the job reported "all current" — so the operator retired the old key on that
 * assurance and every other tenant's identity documents became permanently
 * unreadable. This is the same silent-zero the cron route documents at
 * api/cron/[job]/route.ts, and it is solved the same way: a bootstrap read as
 * the owner, then per-tenant work under `withTenant`.
 */
async function tenants(): Promise<{ id: string; name: string }[]> {
  return adminDb().execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM tenants WHERE deleted_at IS NULL ORDER BY created_at, id`,
  );
}

/**
 * Sweep one tenant, inside one transaction.
 *
 * `withTenant` opens a transaction, so a tenant either finishes completely or
 * leaves nothing behind. That is what makes the job resumable: a crash on tenant
 * four does not half-write tenant four, and the tenants already committed are
 * skipped on the next run because `rotateEnvelope` returns null for a value that
 * is already on the active key.
 */
async function sweepTenant(
  tenantId: string,
  keyring: ReturnType<typeof loadKeyring>,
): Promise<Counts> {
  const totals = zero();

  await withTenant({ tenantId }, async (tx) => {
    for (const spec of ENCRYPTED_COLUMNS) {
      for (const column of spec.columns) {
        const rows = await tx.execute<Record<string, string | null>>(
          sql.raw(
            `SELECT ${spec.idColumn} AS row_id, ${column} AS value
               FROM ${spec.table} WHERE ${column} IS NOT NULL`,
          ),
        );
        totals.scanned += rows.length;

        const stale = rows.filter((r) => keyIdOf(r.value) !== keyring.activeKeyId);
        if (stale.length === 0) {
          if (rows.length > 0) {
            console.log(`    · ${spec.table}.${column.padEnd(24)} ${rows.length} row(s), all current`);
          }
          continue;
        }

        totals.stale += stale.length;
        const byKey = stale.reduce<Record<string, number>>((acc, r) => {
          // Key ids are structural labels, not key material, and null means
          // "this is not one of our envelopes" rather than an unknown id.
          const id = keyIdOf(r.value);
          const label = id === null ? "not a PII envelope" : `key ${id}`;
          acc[label] = (acc[label] ?? 0) + 1;
          return acc;
        }, {});
        console.log(
          `    ${commit ? "→" : "!"} ${spec.table}.${column.padEnd(24)} ${stale.length} stale ` +
            `(${Object.entries(byKey).map(([k, n]) => `${k}: ${n}`).join(", ")})`,
        );

        if (!commit) continue;

        for (const row of stale) {
          let next: string | null;
          try {
            next = rotateEnvelope(row.value!, keyring);
          } catch (err) {
            // Decrypt failures are JS-side and leave the transaction healthy, so
            // the remaining rows still rotate. Report the row id and the reason
            // — never the value, which is the ciphertext of an identity
            // document and would end up in a terminal scrollback.
            totals.failed++;
            const why =
              err instanceof ForeignEnvelopeError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err);
            console.error(`      ✗ ${spec.table}.${column} ${row.row_id}: ${why}`);
            continue;
          }
          if (!next) continue;
          // Re-encrypt only. The blind index is derived from the INDEX key,
          // which rotates separately and much less often — changing it means
          // rebuilding every index in one pass, so it is a distinct operation.
          //
          // Table and column names come from the constant above, never from
          // input; the values are still bound parameters.
          await tx.execute(
            sql`UPDATE ${sql.identifier(spec.table)}
                   SET ${sql.identifier(column)} = ${next}
                 WHERE ${sql.identifier(spec.idColumn)} = ${row.row_id}::uuid`,
          );
          totals.rotated++;
        }
      }
    }
  });

  return totals;
}

// ── AUTH_SECRET-keyed secrets ───────────────────────────────────────────────

/**
 * The `v1.` secret envelope, as written by `encryptSecret` in
 * apps/web/src/lib/crypto.ts.
 *
 * Reimplemented here rather than imported because `packages/core` cannot depend
 * on `apps/web` — the dependency runs the other way. That duplication is a
 * genuine hazard and it is contained two ways: this pass never writes a value it
 * has not first decrypted under AUTH_SECRET_PREVIOUS and then decrypted back
 * under AUTH_SECRET, so a divergence in this codec fails loudly and writes
 * nothing; and the proper end state is a single `security/secrets.ts` that both
 * this file and crypto.ts consume, which is a change to crypto.ts.
 */
const SECRET_SALT = "nexus-secret-encryption-v1";
const secretKey = (authSecret: string): Buffer => scryptSync(authSecret, SECRET_SALT, 32);

function decryptV1(payload: string, authSecret: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(authSecret),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptV1(plain: string, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(authSecret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

/**
 * Rotate — or just audit — the MFA seeds.
 *
 * `users` is global, not tenant-scoped, so this runs once for the whole
 * database rather than per tenant.
 *
 * Without AUTH_SECRET_PREVIOUS this only reports, because there is nothing to
 * rotate FROM: a `v1.` envelope carries no key id, so the only way to know which
 * secret a row was written under is to be told. Reporting is still worth doing —
 * it is the number of users who would lose their second factor if AUTH_SECRET
 * were changed without this step, and nothing else in the system will tell you.
 */
async function sweepSecrets(): Promise<Counts> {
  const totals = zero();
  const authSecret = process.env.AUTH_SECRET;
  const previous = process.env.AUTH_SECRET_PREVIOUS;

  const rows = await withoutTenant((db) =>
    db.execute<{ row_id: string; value: string }>(
      sql`SELECT id AS row_id, mfa_secret_enc AS value
            FROM users WHERE mfa_secret_enc IS NOT NULL`,
    ),
  );
  totals.scanned = rows.length;

  if (rows.length === 0) {
    console.log("    · users.mfa_secret_enc         no enrolled secrets");
    return totals;
  }

  const foreign = rows.filter((r) => !r.value.startsWith("v1."));
  if (foreign.length > 0) {
    totals.failed += foreign.length;
    console.error(
      `    ✗ users.mfa_secret_enc         ${foreign.length} row(s) are not a v1. secret envelope`,
    );
  }

  if (!previous) {
    console.log(
      `    · users.mfa_secret_enc         ${rows.length} secret(s) held under the ` +
        `AUTH_SECRET-derived key`,
    );
    console.log(
      "      These are NOT part of the PII key rotation. Changing AUTH_SECRET makes\n" +
        "      them undecryptable and every one of those users must re-enrol. To\n" +
        "      re-key them instead, set AUTH_SECRET to the new value, keep the old\n" +
        "      one in AUTH_SECRET_PREVIOUS, and re-run with --secrets --commit.",
    );
    return totals;
  }

  if (!authSecret) throw new Error("AUTH_SECRET is not set.");
  if (authSecret === previous) {
    throw new Error("AUTH_SECRET_PREVIOUS is the same as AUTH_SECRET — nothing to rotate from.");
  }

  /**
   * Which rows are already done.
   *
   * A `v1.` envelope carries no key id, so "is this on the current secret?" can
   * only be answered by trying to decrypt it. Doing that makes the sweep
   * idempotent — a second run after a partial failure re-keys only what is left
   * rather than mangling what already succeeded, which is the whole point of a
   * job an operator may have to run twice.
   */
  const isCurrent = (value: string): boolean => {
    try {
      decryptV1(value, authSecret);
      return true;
    } catch {
      return false;
    }
  };
  const pending = rows.filter((r) => r.value.startsWith("v1.") && !isCurrent(r.value));
  totals.stale = pending.length;
  if (pending.length === 0) {
    console.log(`    · users.mfa_secret_enc         ${rows.length} secret(s), all current`);
    return totals;
  }
  console.log(
    `    ${commit ? "→" : "!"} users.mfa_secret_enc         ${totals.stale} secret(s) to re-key`,
  );
  if (!commit) return totals;

  await withoutTenant(async (db) => {
    for (const row of pending) {
      let next: string;
      try {
        const plain = decryptV1(row.value, previous);
        next = encryptV1(plain, authSecret);
        // Prove the round trip before writing. If the codec above ever drifts
        // from apps/web/src/lib/crypto.ts this is where it stops, with the old
        // value still intact.
        if (decryptV1(next, authSecret) !== plain) {
          throw new Error("re-encrypted value did not decrypt back to the original");
        }
      } catch (err) {
        totals.failed++;
        console.error(
          `      ✗ users.mfa_secret_enc ${row.row_id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      await db.execute(
        sql`UPDATE users SET mfa_secret_enc = ${next} WHERE id = ${row.row_id}::uuid`,
      );
      totals.rotated++;
    }
  });

  return totals;
}

async function main(): Promise<number> {
  const keyring = loadKeyring();
  console.log(
    `\nPII key rotation · active key "${keyring.activeKeyId}" · ` +
      `${Object.keys(keyring.keys).length} key(s) in keyring · ` +
      `${commit ? "COMMIT" : "DRY RUN"}\n`,
  );

  const all = await tenants();
  if (all.length === 0) {
    // Zero tenants is not "all clear" — it is a database this job cannot see.
    console.error("✗ No tenants found. Refusing to report an all-clear.\n");
    return EXIT_ERROR;
  }

  const totals = zero();
  const failedTenants: string[] = [];

  for (const [i, tenant] of all.entries()) {
    console.log(`  Tenant ${i + 1}/${all.length}  ${tenant.name}  ${tenant.id}`);
    try {
      const counts = await sweepTenant(tenant.id, keyring);
      add(totals, counts);
      console.log(
        `    ${counts.scanned} scanned · ${counts.stale} stale · ` +
          `${commit ? `${counts.rotated} rotated` : "no writes (dry run)"}` +
          `${counts.failed > 0 ? ` · ${counts.failed} FAILED` : ""}`,
      );
      if (commit && counts.rotated > 0) {
        securityEvent({
          kind: "pii.key_rotated",
          severity: "critical",
          tenantId: tenant.id,
          detail: { activeKeyId: keyring.activeKeyId, rowsRotated: counts.rotated },
        });
      }
    } catch (err) {
      // The tenant's transaction rolled back whole. Record it and keep going:
      // stopping here would leave the operator unable to tell which of the
      // remaining tenants are clean, which is how the old version stranded data.
      failedTenants.push(tenant.id);
      console.error(`    ✗ tenant sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }

  if (secretsMode) {
    console.log("  Secrets (AUTH_SECRET-keyed, database-wide — not tenant-scoped)");
    try {
      const counts = await sweepSecrets();
      add(totals, counts);
    } catch (err) {
      totals.failed++;
      console.error(`    ✗ secret sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }

  console.log(
    `${all.length} tenant(s) · ${totals.scanned} value(s) scanned · ` +
      `${totals.stale} on an old key · ` +
      `${commit ? `${totals.rotated} rotated` : "no writes (dry run)"}` +
      `${totals.failed > 0 ? ` · ${totals.failed} failed` : ""}`,
  );

  if (failedTenants.length > 0) {
    console.error(
      `\n✗ ${failedTenants.length} tenant(s) did not complete: ${failedTenants.join(", ")}\n` +
        "  Their changes were rolled back. Fix the cause and re-run — the sweep is\n" +
        "  idempotent, so completed tenants are skipped.\n",
    );
    return EXIT_INCOMPLETE;
  }
  if (totals.failed > 0) {
    console.error(
      `\n✗ ${totals.failed} value(s) could not be rotated. KEEP THE OLD KEY IN THE KEYRING.\n`,
    );
    return EXIT_INCOMPLETE;
  }
  if (totals.stale > 0 && !commit) {
    console.log("\nRe-run with --commit to rotate.\n");
    return EXIT_INCOMPLETE;
  }
  if (totals.stale > totals.rotated) {
    console.log("\nKeep the old key in the keyring until this reports zero.\n");
    return EXIT_INCOMPLETE;
  }
  console.log(
    "\n✓ Every encrypted value is on the active key. Retired keys can now be removed.\n" +
      (secretsMode ? "" : "  (MFA secrets were not inspected — add --secrets.)\n"),
  );
  return EXIT_CLEAN;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(EXIT_ERROR);
  });
