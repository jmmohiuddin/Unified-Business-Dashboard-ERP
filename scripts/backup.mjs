/**
 * Backup and RESTORE DRILL.
 *
 *   node scripts/backup.mjs            # take a backup
 *   node scripts/backup.mjs --verify   # take one, restore it, prove it reconciles
 *
 * The `--verify` path is the point of this file. An untested backup is not a
 * backup — it is a file you hope is a backup. This restores into a scratch
 * database and asserts that the trial balance, the document count and the
 * gratuity provision all reproduce exactly. If any of those drift, the backup
 * is unusable and you find out now rather than during an incident.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env" });
config({ path: ".env.example" });

const url = new URL(process.env.DATABASE_URL ?? "postgresql://nexus:nexus@127.0.0.1:5432/nexus");
const dbName = url.pathname.slice(1);
const verify = process.argv.includes("--verify");
const outDir = resolve(process.env.BACKUP_DIR ?? "./backups");

/**
 * Backup encryption.
 *
 * A database dump is the single most valuable file the business owns: it
 * contains every customer, every amount, and — before this — would have been
 * the easiest way to bypass all the field-level encryption in the app by simply
 * copying the file. Encrypting it closes that path.
 *
 * AES-256-GCM: authenticated, so a tampered or truncated backup fails loudly on
 * restore instead of quietly producing corrupt data. Keyed by
 * BACKUP_ENCRYPTION_KEY, which must be stored somewhere other than next to the
 * backups themselves.
 */
const backupKeyRaw = process.env.BACKUP_ENCRYPTION_KEY;
const encryptBackups = Boolean(backupKeyRaw);
const backupKey = backupKeyRaw
  ? scryptSync(backupKeyRaw, "nexus-backup-v1", 32)
  : null;

async function encryptFile(source, target) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", backupKey, iv.subarray(0, 12));
  const out = createWriteStream(target);
  // Header: magic, IV. The auth tag is appended after the stream completes.
  out.write(Buffer.concat([Buffer.from("NEXBK1"), iv.subarray(0, 12)]));
  await pipeline(createReadStream(source), cipher, out, { end: false });
  out.write(cipher.getAuthTag());
  await new Promise((res) => out.end(res));
}

async function decryptFile(source, target) {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(source);
  if (raw.subarray(0, 6).toString() !== "NEXBK1") {
    throw new Error("Not a Nexus encrypted backup.");
  }
  const iv = raw.subarray(6, 18);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(18, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", backupKey, iv);
  decipher.setAuthTag(tag);
  const { writeFileSync } = await import("node:fs");
  // GCM authenticates on final() — a tampered backup throws rather than
  // restoring silently corrupted data.
  writeFileSync(target, Buffer.concat([decipher.update(body), decipher.final()]));
}

const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
const conn = ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username)];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { env: pgEnv, encoding: "utf8", ...opts });
}

/** The numbers a restore must reproduce exactly. */
async function fingerprint(database) {
  const target = new URL(url.toString());
  target.pathname = `/${database}`;
  const sql = postgres(target.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM journal_lines) AS journal_lines,
        (SELECT COUNT(*)::int FROM cheques) AS cheques,
        (SELECT COALESCE(SUM(base_debit), 0)::text FROM journal_lines) AS total_debits,
        (SELECT COALESCE(SUM(base_credit), 0)::text FROM journal_lines) AS total_credits,
        (SELECT COALESCE(SUM(gratuity_accrued), 0)::text FROM employees) AS gratuity,
        (SELECT COALESCE(SUM(amount_due), 0)::text FROM documents WHERE direction = 'in') AS receivables,
        (SELECT COUNT(*)::int FROM employees WHERE emirates_id_enc LIKE 'p1.%') AS encrypted_pii
    `;
    return row;
  } finally {
    await sql.end();
  }
}

async function main() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Timestamped, custom format so pg_restore can do selective and parallel
  // restores. Plain SQL dumps cannot.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = resolve(outDir, `${dbName}-${stamp}.dump`);

  console.log(`\n· Backing up ${dbName} → ${file}`);
  run("pg_dump", [...conn, "-d", dbName, "-Fc", "-f", file]);
  const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(1);

  let artefact = file;
  if (encryptBackups) {
    artefact = `${file}.enc`;
    await encryptFile(file, artefact);
    // The plaintext dump must not linger next to the encrypted one.
    unlinkSync(file);
    console.log(`✓ Backup written and encrypted (${sizeMb} MB) → ${artefact}`);
  } else {
    console.log(`✓ Backup written (${sizeMb} MB)`);
    console.warn(
      "! BACKUP_ENCRYPTION_KEY is not set — this dump is plaintext and contains\n" +
        "  every customer record. Set it before taking a production backup.",
    );
  }

  if (!verify) {
    console.log(`\nRun with --verify to prove the backup actually restores.\n`);
    return;
  }

  // ── Restore drill ─────────────────────────────────────────────────────────
  const scratch = `${dbName}_restore_check`;
  console.log(`\n· Restoring into ${scratch} to verify…`);

  const before = await fingerprint(dbName);

  run("psql", [...conn, "-d", "postgres", "-c",
    `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`]);
  run("psql", [...conn, "-d", "postgres", "-c", `CREATE DATABASE ${scratch}`]);

  // Restoring from the ENCRYPTED artefact, not a retained plaintext copy —
  // otherwise the drill proves the dump restores but says nothing about
  // whether the thing actually stored offsite can be decrypted.
  let restoreFrom = artefact;
  if (encryptBackups) {
    restoreFrom = `${file}.verify.tmp`;
    await decryptFile(artefact, restoreFrom);
    console.log("  decrypted the stored artefact for restore");
  }

  try {
    run("pg_restore", [...conn, "-d", scratch, "--no-owner", "--no-privileges", restoreFrom], {
      stdio: "pipe",
    });
  } catch (err) {
    // pg_restore exits non-zero on benign warnings (missing roles, extensions
    // already present). Real failures surface in the fingerprint comparison.
    const out = String(err.stderr ?? "");
    if (!/error/i.test(out)) console.log("  (pg_restore reported warnings, continuing)");
    else throw err;
  }

  const after = await fingerprint(scratch);

  const checks = [
    ["documents", before.documents, after.documents],
    ["journal lines", before.journal_lines, after.journal_lines],
    ["cheques", before.cheques, after.cheques],
    ["total debits", before.total_debits, after.total_debits],
    ["total credits", before.total_credits, after.total_credits],
    ["gratuity provision", before.gratuity, after.gratuity],
    ["receivables", before.receivables, after.receivables],
    ["encrypted PII count", before.encrypted_pii, after.encrypted_pii],
  ];

  console.log("");
  let failed = 0;
  for (const [label, a, b] of checks) {
    const ok = String(a) === String(b);
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(20)} ${a}${ok ? "" : `  →  ${b}`}`);
  }

  // The restored ledger must still balance. A backup that restores a
  // half-written transaction is worse than useless.
  const balanced = String(after.total_debits) === String(after.total_credits);
  console.log(`  ${balanced ? "✓" : "✗"} restored ledger balances`);
  if (!balanced) failed++;

  run("psql", [...conn, "-d", "postgres", "-c",
    `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`]);
  if (encryptBackups && existsSync(restoreFrom)) unlinkSync(restoreFrom);

  if (failed > 0) {
    console.error(`\n✗ Restore drill FAILED — ${failed} check(s) did not reproduce.\n`);
    process.exit(1);
  }
  console.log(`\n✓ Restore drill passed. The backup is usable.\n`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
