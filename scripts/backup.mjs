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
/**
 * Fail closed.
 *
 * This previously read `encryptBackups = Boolean(key)`: with no key set it
 * printed a warning and wrote a PLAINTEXT dump anyway. A control that silently
 * degrades to "no control" when a variable is missing is not a control — and
 * the missing-variable case is exactly the hurried production run you most need
 * it for. There is no unencrypted path any more.
 */
const backupKeyRaw = process.env.BACKUP_ENCRYPTION_KEY;
if (!backupKeyRaw) {
  console.error(
    "✗ BACKUP_ENCRYPTION_KEY is not set.\n\n" +
      "  A database dump is the easiest way to bypass every field-level\n" +
      "  encryption control in this product, so backups are never written in\n" +
      "  plaintext. Generate a key and put it in .env:\n\n" +
      "      npm run keygen\n",
  );
  process.exit(1);
}

/**
 * Key derivation salt.
 *
 * v1 derived the key with the hardcoded salt "nexus-backup-v1", so every
 * deployment of this product shared one salt and a precomputation attack
 * against a weak passphrase was reusable across all of them. v2 stores a random
 * per-backup salt in the header.
 */
const LEGACY_SALT = "nexus-backup-v1";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const deriveKey = (salt) => scryptSync(backupKeyRaw, salt, 32);

async function encryptFile(source, target) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const out = createWriteStream(target);
  // Header: magic, salt, IV. The auth tag is appended after the stream completes.
  out.write(Buffer.concat([Buffer.from("NEXBK2"), salt, iv]));
  await pipeline(createReadStream(source), cipher, out, { end: false });
  out.write(cipher.getAuthTag());
  await new Promise((res) => out.end(res));
}

async function decryptFile(source, target) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const raw = readFileSync(source);
  const magic = raw.subarray(0, 6).toString();

  // v1 archives must stay readable. Rotating the format is not a licence to
  // orphan every backup taken before the rotation — that would turn a security
  // fix into data loss.
  let key, iv, body;
  if (magic === "NEXBK2") {
    const salt = raw.subarray(6, 6 + SALT_BYTES);
    key = deriveKey(salt);
    iv = raw.subarray(6 + SALT_BYTES, 6 + SALT_BYTES + IV_BYTES);
    body = raw.subarray(6 + SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES);
  } else if (magic === "NEXBK1") {
    key = deriveKey(LEGACY_SALT);
    iv = raw.subarray(6, 6 + IV_BYTES);
    body = raw.subarray(6 + IV_BYTES, raw.length - TAG_BYTES);
  } else {
    throw new Error("Not a Nexus encrypted backup.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
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

  // Encryption is unconditional — the process exits above without a key.
  const artefact = `${file}.enc`;
  await encryptFile(file, artefact);
  // The plaintext dump must not linger next to the encrypted one.
  unlinkSync(file);
  console.log(`✓ Backup written and encrypted (${sizeMb} MB) → ${artefact}`);

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
  const restoreFrom = `${file}.verify.tmp`;
  await decryptFile(artefact, restoreFrom);
  console.log("  decrypted the stored artefact for restore");

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
  if (existsSync(restoreFrom)) unlinkSync(restoreFrom);

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
