/**
 * PII key rotation.
 *
 *   npm run pii:rotate            # report what needs re-encrypting
 *   npm run pii:rotate -- --commit
 *
 * Rotation is online and incremental. Add a new key to PII_ENCRYPTION_KEYS, set
 * PII_ACTIVE_KEY_ID to it, and run this: new writes already use the new key,
 * and this walks the existing rows. The OLD key must stay in the keyring until
 * this reports zero remaining, or the data encrypted under it becomes
 * permanently unreadable.
 *
 * A scheme you cannot rotate is a scheme that will still be using its first key
 * the day it leaks.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { keyIdOf, loadKeyring, rotateEnvelope } from "./pii.ts";
import { securityEvent } from "./events.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const commit = process.argv.includes("--commit");

/** Every encrypted column in the schema. Adding one here is the only step
 *  required to bring it into the rotation. */
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
  { table: "users", idColumn: "id", columns: ["mfa_secret_enc"] },
];

async function main() {
  const keyring = loadKeyring();
  console.log(
    `\nPII key rotation · active key "${keyring.activeKeyId}" · ` +
      `${Object.keys(keyring.keys).length} key(s) in keyring · ` +
      `${commit ? "COMMIT" : "DRY RUN"}\n`,
  );

  const [tenant] = await adminDb().execute<{ id: string }>(sql`SELECT id FROM tenants LIMIT 1`);
  if (!tenant) throw new Error("No tenant found.");

  let totalStale = 0;
  let totalRotated = 0;

  await withTenant({ tenantId: tenant.id }, async (tx) => {
    for (const spec of ENCRYPTED_COLUMNS) {
      for (const column of spec.columns) {
        const rows = await tx.execute<Record<string, string | null>>(
          sql.raw(
            `SELECT ${spec.idColumn} AS row_id, ${column} AS value
               FROM ${spec.table} WHERE ${column} IS NOT NULL`,
          ),
        );

        const stale = rows.filter((r) => keyIdOf(r.value) !== keyring.activeKeyId);
        if (stale.length === 0) {
          if (rows.length > 0) {
            console.log(`  · ${spec.table}.${column.padEnd(24)} ${rows.length} row(s), all current`);
          }
          continue;
        }

        totalStale += stale.length;
        const byKey = stale.reduce<Record<string, number>>((acc, r) => {
          const k = keyIdOf(r.value) ?? "?";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
        console.log(
          `  ${commit ? "→" : "!"} ${spec.table}.${column.padEnd(24)} ${stale.length} stale ` +
            `(${Object.entries(byKey).map(([k, n]) => `key ${k}: ${n}`).join(", ")})`,
        );

        if (!commit) continue;

        for (const row of stale) {
          const next = rotateEnvelope(row.value!, keyring);
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
          totalRotated++;
        }
      }
    }
  });

  if (commit && totalRotated > 0) {
    securityEvent({
      kind: "pii.key_rotated",
      severity: "critical",
      tenantId: tenant.id,
      detail: { activeKeyId: keyring.activeKeyId, rowsRotated: totalRotated },
    });
  }

  console.log(
    `\n${totalStale} row(s) on an old key · ${commit ? `${totalRotated} rotated` : "no writes (dry run)"}`,
  );
  if (totalStale === 0) {
    console.log("Every encrypted value is on the active key. Retired keys can now be removed.\n");
  } else if (!commit) {
    console.log("Re-run with --commit to rotate.\n");
  } else {
    console.log("Keep the old key in the keyring until this reports zero.\n");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
