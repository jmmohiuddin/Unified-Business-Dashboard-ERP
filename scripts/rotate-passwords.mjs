/**
 * CREDENTIAL ROTATION.
 *
 *   node scripts/rotate-passwords.mjs --host <hostname> --all
 *   node scripts/rotate-passwords.mjs --host <hostname> --all --commit <hostname>
 *
 * Runbook: docs/OPS-08-credential-rotation.md. Read that first — this header is
 * the *reasoning*, not the procedure.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The seed hashed the literal `demo1234` for all nine demo accounts, including
 * `owner@sumon.test`, whose role expands to `["*"]`. The repository is public,
 * so that password has to be treated as published — permanently, because it is
 * in git history and history is not rewritable on a repo other people have
 * cloned. `resolveSeedPassword()` in packages/db/src/seed/index.ts now refuses
 * to write it to a non-local target, which fixes every *future* seed and
 * changes nothing about a database that was already seeded. Audit finding F-1
 * asked for the rotation as a separate act, and it did not happen across three
 * waves of work partly because there was no tool to do it with. This is it.
 *
 * ── The four things it refuses to get wrong ─────────────────────────────────
 *
 * 1. THE WRONG DATABASE. Rotating production when you meant staging locks nine
 *    people out of the live system with credentials that exist only in the
 *    scrollback of a terminal you have already closed. So there is no default
 *    target: the connection string is read from a named environment variable,
 *    and the operator must state the hostname they believe that variable points
 *    at (`--host`). A mismatch is fatal before a single row is read. Committing
 *    requires typing the hostname a second time (`--commit <hostname>`), which
 *    is the one piece of ceremony in this file that is deliberately not
 *    convenient.
 *
 * 2. THE WRONG ACCOUNTS. There is no implicit "everyone". `--all` or an
 *    explicit `--account` list, and if any named account does not exist the
 *    whole run is refused rather than silently rotating the subset that
 *    matched — "8 of 9 rotated" is the shape of an outage nobody notices.
 *
 * 3. A PASSWORD THAT DOES NOT AUTHENTICATE. The argon2id parameters here must
 *    match apps/web/src/lib/crypto.ts exactly or the rotated account is simply
 *    bricked, and you find that out on the login page with the old password
 *    already destroyed. They are asserted twice: once against the hash in
 *    memory, and once against the value read back out of the database inside
 *    the transaction. A failure at either point rolls the whole thing back.
 *
 * 4. A ROTATION THAT ROTATES NOTHING. A changed password with a live 30-day
 *    session cookie still in play has revoked nothing from whoever holds that
 *    cookie. Sessions are revoked in the SAME transaction as the password
 *    write, mirroring deactivateUser() in packages/core/src/services/users.ts,
 *    which is the existing precedent for "kill this person's access now".
 *
 * ── Dry run by default ──────────────────────────────────────────────────────
 *
 * The dry run is not a simulation. It executes every statement a real rotation
 * executes — the update, the read-back verification, the revocations, the audit
 * insert — and then rolls the transaction back. So it proves the mechanism
 * against the real target, with the real schema and the real privileges, rather
 * than proving that a code path that has never run would probably work.
 *
 * The only thing it withholds is the generated passwords, which are discarded
 * with the rollback and would be actively misleading to print.
 */
import { hostname, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * `.env` only — never `.env.example`.
 *
 * The same rule scripts/backup.mjs arrived at the hard way: an example file is
 * documentation, and treating it as configuration means the deployment that
 * never set the variable gets the value published in a public repository. Here
 * it would mean rotating against whatever placeholder URL `.env.example` ships.
 */
config({ path: ".env", quiet: true });

/**
 * argon2id parameters — MUST equal ARGON2_OPTIONS in apps/web/src/lib/crypto.ts.
 *
 * Duplicated rather than imported because that module is `server-only` TypeScript
 * inside the Next app and this is a plain Node script run from the repo root.
 * The duplication is the risk this file's read-back verification exists to
 * catch: if these ever drift, `verifyPassword` rejects a password this script
 * just wrote, and the assertion below fails before COMMIT rather than at a
 * login prompt three days later.
 */
const ARGON2_OPTIONS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
};

/**
 * Mirrors MFA_REQUIRED_ROLES in apps/web/src/lib/mfa.ts. Not used to enforce
 * anything — only to tell the operator, per account, that this login will land
 * on the enrolment screen rather than the dashboard, so a correct rotation is
 * not mistaken for a broken one.
 */
const MFA_REQUIRED_ROLES = ["super_admin", "owner", "accountant", "general_manager"];

/** The published password. Never written by this tool; see assertUsable(). */
const PUBLISHED_DEMO_PASSWORD = "demo1234";

// ── Arguments ───────────────────────────────────────────────────────────────

const USAGE = `
Rotate account passwords and revoke every live session.

  node scripts/rotate-passwords.mjs --host <hostname> --all
  node scripts/rotate-passwords.mjs --host <hostname> --account a@b.test --commit <hostname>

Required
  --host <hostname>        The hostname you believe the target URL points at.
                           Refuses to run if the URL disagrees.
  --all                    Every account that currently has a password.
    or
  --account <email>        One account. Repeatable, or comma-separated.

Optional
  --commit <hostname>      Actually write. Without it this is a dry run that
                           rolls back. The hostname must be typed again and match.
  --url-env <VAR>          Environment variable holding the connection string.
                           Default DATABASE_URL.
  --operator <label>       Who is running this, for the audit trail.
                           Default <user>@<machine>.
  --include-passwordless   Also rotate accounts that have no password set today.
                           Off by default: giving a dormant, never-activated
                           account a working password creates a login that did
                           not previously exist.
  --help
`;

function parseArgs(argv) {
  const out = {
    host: null,
    commit: null,
    urlEnv: "DATABASE_URL",
    accounts: [],
    all: false,
    operator: null,
    includePasswordless: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `--flag=value` and `--flag value` are both accepted; operators type both.
    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq > 2 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const value = () => {
      const v = inlineValue ?? argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case "--host": out.host = value().trim().toLowerCase(); break;
      case "--commit": out.commit = value().trim().toLowerCase(); break;
      case "--url-env": out.urlEnv = value().trim(); break;
      case "--operator": out.operator = value().trim(); break;
      case "--account":
        for (const e of value().split(",")) if (e.trim()) out.accounts.push(e.trim().toLowerCase());
        break;
      case "--all": out.all = true; break;
      case "--include-passwordless": out.includePasswordless = true; break;
      case "--help": case "-h": out.help = true; break;
      default: fail(`Unrecognised argument "${arg}".${USAGE}`);
    }
  }
  return out;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ── Password generation ─────────────────────────────────────────────────────

/**
 * Unambiguous alphabet: no 0/O, no 1/l/I. These passwords get read off a
 * terminal and typed into a password manager by a human, and a rotation that
 * produces a credential nobody can transcribe accurately is a rotation that
 * ends in a second rotation.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUPS = 5;
const GROUP_LEN = 5;

/**
 * 25 characters from a 56-symbol alphabet ≈ 145 bits, which is far past the
 * point where the argon2id work factor matters and costs nothing to generate.
 *
 * Rejection sampling rather than `% ALPHABET.length`: the modulo would bias the
 * first 256 % 56 = 32 symbols upward. The bias is small and completely
 * unnecessary — this is the one place in the file where "close enough" has no
 * argument in its favour.
 */
function generatePassword() {
  const chars = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (chars.length < GROUPS * GROUP_LEN) {
    for (const byte of randomBytes(64)) {
      if (byte >= limit) continue;
      chars.push(ALPHABET[byte % ALPHABET.length]);
      if (chars.length === GROUPS * GROUP_LEN) break;
    }
  }
  const groups = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN).join(""));
  return groups.join("-");
}

/**
 * Mirrors validatePasswordStrength in apps/web/src/lib/crypto.ts.
 *
 * A generated password failing this is essentially impossible, which is exactly
 * why it is worth asserting: the alternative is writing a credential the product
 * itself would have rejected, and only discovering the inconsistency when
 * somebody tries to set the same value through the change-password screen.
 */
function assertUsable(password) {
  if (password === PUBLISHED_DEMO_PASSWORD) return "the published demo password";
  if (password.length < 12) return "shorter than 12 characters";
  if (password.length > 256) return "longer than 256 characters";
  const common = ["password", "12345678", "qwerty", "letmein", "admin123", "welcome1"];
  const lower = password.toLowerCase();
  if (common.some((c) => lower.includes(c))) return "contains a common password";
  return null;
}

function newPassword() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generatePassword();
    if (!assertUsable(candidate)) return candidate;
  }
  // Unreachable short of a broken RNG, and a broken RNG is precisely the
  // condition under which this must not quietly proceed.
  fail("Could not generate a password that passes the strength policy.");
}

// ── Target resolution ───────────────────────────────────────────────────────

/**
 * There is no default target.
 *
 * `DATABASE_URL` is whatever the last person to edit `.env` made it, and this
 * script is run rarely, under pressure, from a shell whose environment nobody
 * has audited that morning. Requiring the operator to state the host and
 * proving the URL agrees turns "I think this points at production" into a
 * checked assertion. It is the whole reason a `--host` flag exists rather than
 * the tool simply reading the variable and getting on with it.
 */
function resolveTarget(args) {
  const raw = process.env[args.urlEnv];
  if (!raw) {
    fail(
      `${args.urlEnv} is not set, so there is nothing to connect to.\n` +
        `  Set it in .env or the shell, or name a different variable with --url-env.`,
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${args.urlEnv} is not a valid connection URL.`);
  }
  const host = url.hostname.toLowerCase();
  const database = url.pathname.replace(/^\//, "") || "(default)";

  if (!args.host) {
    fail(
      `--host is required.\n` +
        `  ${args.urlEnv} currently points at "${host}" (database "${database}").\n` +
        `  Re-run with --host ${host} if that is the database you mean to rotate.`,
    );
  }
  if (args.host !== host) {
    fail(
      `Target mismatch — refusing to touch anything.\n` +
        `  You said:            --host ${args.host}\n` +
        `  ${args.urlEnv} points at: ${host} (database "${database}")\n` +
        `  One of those is wrong. Fix it before running this again.`,
    );
  }
  if (args.commit !== null && args.commit !== host) {
    fail(
      `--commit must repeat the hostname exactly.\n` +
        `  Expected: --commit ${host}\n` +
        `  Got:      --commit ${args.commit || "(no value)"}`,
    );
  }
  return { url: raw, host, database, user: url.username || "(default)" };
}

// ── Reporting helpers ───────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? "").padEnd(n);

function banner(target, args, accountCount) {
  const mode = args.commit ? "COMMIT — this will write" : "DRY RUN — nothing will be written";
  console.log("");
  console.log("┌─ Credential rotation ────────────────────────────────────────────");
  console.log(`│  Target host : ${target.host}`);
  console.log(`│  Database    : ${target.database}`);
  console.log(`│  Connecting  : ${target.user}   (from ${args.urlEnv})`);
  console.log(`│  Accounts    : ${accountCount} ${args.all ? "(--all)" : "(named)"}`);
  console.log(`│  Operator    : ${args.operator}`);
  console.log(`│  Mode        : ${mode}`);
  console.log("└──────────────────────────────────────────────────────────────────");
  console.log("");
}

/**
 * The credentials are printed ONCE, here, and nowhere else.
 *
 * Not to a file, not to the audit log, not to the error path. Whoever runs this
 * has one chance to capture them, which is deliberate: a rotation whose output
 * is sitting in `~/rotation-2026-08.txt` has moved the published-credential
 * problem rather than solved it. The nearest this script can come to enforcing
 * that is refusing to write the file itself and saying so loudly, which is what
 * the trailing notice does.
 */
function printCredentials(results, target) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  NEW CREDENTIALS — shown once, never stored, not recoverable");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");
  for (const r of results) {
    console.log(`  ${r.email}`);
    console.log(`      password : ${r.password}`);
    console.log(`      role     : ${r.roleKey ?? "(no active membership)"}${r.mfaRequired ? "   · MFA required" : ""}`);
    console.log("");
  }
  console.log("───────────────────────────────────────────────────────────────────");
  console.log("  Put these in the password manager NOW, before closing this shell.");
  console.log("  They are not written to any file and cannot be printed again — the");
  console.log("  database holds only the argon2id hash. Losing one means running");
  console.log("  this tool again for that account.");
  if (!process.stdout.isTTY) {
    console.log("");
    console.log("  ⚠ stdout is NOT a terminal. If you piped or redirected this run,");
    console.log("    these passwords are now in a file or a log. Move them into the");
    console.log("    password manager and delete that file.");
  }
  console.log(`  Rotated on: ${target.host} / ${target.database}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");
}

// ── Main ────────────────────────────────────────────────────────────────────

/** Thrown to roll a dry run back. Carried out of `sql.begin` and swallowed. */
const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  args.operator ??= `${userInfo().username}@${hostname()}`;

  if (!args.all && args.accounts.length === 0) {
    fail(
      `Nothing selected. Pass --all, or name accounts with --account.\n` +
        `  There is no default set on purpose: "rotate everything" and "rotate one\n` +
        `  account" have very different blast radii and should not share a spelling.`,
    );
  }
  if (args.all && args.accounts.length > 0) {
    fail("--all and --account are mutually exclusive. Pick one.");
  }

  const target = resolveTarget(args);
  const sql = postgres(target.url, { max: 1, onnotice: () => {} });

  try {
    /**
     * Who are we connected as? Reported in the banner, and used by the
     * membership-visibility check further down. `rolsuper` matters as well as
     * `rolbypassrls`: a superuser bypasses row-level security whether or not
     * the BYPASSRLS attribute is set, which is why the local `nexus` role reads
     * `memberships` fine while `nexus_app` cannot.
     */
    const [role] = await sql`
      SELECT current_user AS name,
             coalesce((SELECT rolbypassrls OR rolsuper FROM pg_roles
                        WHERE rolname = current_user), false) AS unrestricted
    `;

    /**
     * Selected OUTSIDE the transaction so the operator sees who is in scope,
     * with their MFA position, before anything is generated or written. In a
     * dry run this listing is most of the value.
     */
    const rows = args.all
      ? await sql`
          SELECT u.id, lower(u.email) AS email, u.full_name,
                 u.password_hash IS NOT NULL AS has_password,
                 u.default_tenant_id, u.mfa_enabled_at IS NOT NULL AS mfa_enrolled,
                 r.key AS role_key, m.status::text AS membership_status,
                 (SELECT count(*)::int FROM sessions s
                   WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions
            FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            LEFT JOIN roles r ON r.id = m.role_id
           WHERE u.password_hash IS NOT NULL
           ORDER BY u.email
        `
      : await sql`
          SELECT u.id, lower(u.email) AS email, u.full_name,
                 u.password_hash IS NOT NULL AS has_password,
                 u.default_tenant_id, u.mfa_enabled_at IS NOT NULL AS mfa_enrolled,
                 r.key AS role_key, m.status::text AS membership_status,
                 (SELECT count(*)::int FROM sessions s
                   WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions
            FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            LEFT JOIN roles r ON r.id = m.role_id
           WHERE lower(u.email) = ANY(${args.accounts})
           ORDER BY u.email
        `;

    /**
     * All or nothing on the named set.
     *
     * A typo'd address that silently rotates eight of nine accounts leaves one
     * person still holding the published password, and the run that was supposed
     * to close that hole reports success. Refuse the whole thing instead.
     */
    if (!args.all) {
      const found = new Set(rows.map((r) => r.email));
      const missing = args.accounts.filter((e) => !found.has(e));
      if (missing.length) {
        fail(
          `No such account on ${target.host}: ${missing.join(", ")}\n` +
            `  Nothing was rotated. Check the spelling, or check you are pointed at\n` +
            `  the database you think you are.`,
        );
      }
    }

    const skipped = args.includePasswordless ? [] : rows.filter((r) => !r.has_password);
    const targets = rows.filter((r) => args.includePasswordless || r.has_password);
    if (targets.length === 0) fail(`No accounts to rotate on ${target.host}.`);

    banner(target, args, targets.length);

    /**
     * Could the role actually be resolved?
     *
     * `memberships` is tenant-scoped and the selection above runs outside any
     * tenant context, so a NOBYPASSRLS connection reads NULL for every role —
     * and every account then displays as "MFA optional", which is a wrong
     * answer wearing the costume of a right one. The MFA notice is the whole
     * reason the owner is not surprised by landing on the enrolment screen
     * after rotation, so a blank column has to announce itself.
     *
     * Checked empirically rather than inferred from the connecting role: an
     * account with a tenant but no visible active membership is either genuinely
     * unmembered or hidden by RLS, and the operator needs to be told which.
     */
    const unresolved = targets.filter((r) => r.default_tenant_id && !r.role_key);
    if (unresolved.length && !role?.unrestricted) {
      console.log(`  ⚠ Connected as "${role?.name}", which does not bypass row-level`);
      console.log("    security, so `memberships` is invisible and the ROLE and MFA columns");
      console.log("    below are blank for reasons that have nothing to do with those accounts.");
      console.log("    Rotation still works. The MFA notice does not. Re-run with the owner");
      console.log("    connection string if you want it — docs/OPS-08-credential-rotation.md §2.");
      console.log("");
    } else if (unresolved.length) {
      console.log(`  ⚠ ${unresolved.length} account(s) below have no active membership, so no`);
      console.log("    role and no MFA requirement could be resolved. Rotating them gives them");
      console.log("    a working password for a tenant they cannot currently enter.");
      console.log("");
    }

    console.log(`  ${pad("ACCOUNT", 26)} ${pad("ROLE", 18)} ${pad("MFA", 14)} LIVE SESSIONS`);
    console.log(`  ${"─".repeat(26)} ${"─".repeat(18)} ${"─".repeat(14)} ────────`);
    for (const r of targets) {
      const mfaRequired = MFA_REQUIRED_ROLES.includes(r.role_key ?? "");
      // "unknown", never "optional", when the role could not be read. An
      // unresolved requirement is not the same fact as no requirement.
      const mfa = r.mfa_enrolled
        ? "enrolled"
        : mfaRequired
          ? "REQUIRED, none"
          : r.role_key
            ? "optional"
            : "unknown";
      console.log(
        `  ${pad(r.email ?? "(no email)", 26)} ${pad(r.role_key ?? "—", 18)} ${pad(mfa, 14)} ${r.live_sessions}`,
      );
    }
    for (const r of skipped) {
      console.log(`  ${pad(r.email ?? "(no email)", 26)} ${pad("—", 18)} ${pad("—", 14)} skipped: no password set`);
    }
    console.log("");

    /**
     * Generate and hash BEFORE opening the transaction.
     *
     * argon2id at 64 MiB × 3 is deliberately slow — call it 100 ms per hash,
     * doubled by the self-check. Doing that work inside the transaction would
     * hold row locks on `users` for as long as it takes, on a table every single
     * login reads. There is nothing transactional about deriving a hash.
     */
    const prepared = [];
    for (const r of targets) {
      const password = newPassword();
      const hash = await argon2Hash(password, ARGON2_OPTIONS);
      // First of two verifications: the hash we just derived accepts the
      // password we just generated. Catches a parameter or encoding fault here,
      // where nothing has been written and the failure costs nothing.
      if (!(await argon2Verify(hash, password, ARGON2_OPTIONS))) {
        fail(`argon2id round trip failed in memory for ${r.email}. Nothing written.`);
      }
      prepared.push({
        id: r.id,
        email: r.email,
        fullName: r.full_name,
        tenantId: r.default_tenant_id,
        roleKey: r.role_key,
        mfaEnrolled: r.mfa_enrolled,
        mfaRequired: MFA_REQUIRED_ROLES.includes(r.role_key ?? ""),
        password,
        hash,
      });
    }
    console.log(`· Generated and self-verified ${prepared.length} argon2id hashes.`);

    let results = [];
    try {
      results = await sql.begin(async (tx) => {
        const done = [];
        for (const p of prepared) {
          /**
           * `FOR UPDATE` so a concurrent login-related write cannot interleave
           * between the update and the read-back below. The row is held for the
           * few milliseconds this loop body takes, not for the hashing.
           */
          const [locked] = await tx`
            SELECT id FROM users WHERE id = ${p.id}::uuid FOR UPDATE
          `;
          if (!locked) throw new Error(`${p.email} disappeared mid-rotation. Rolled back.`);

          /**
           * `locked_until` and `failed_login_count` are cleared alongside the
           * password, and the sliding-window failure/lockout keys are deleted —
           * exactly what clearFailedLogins() in apps/web/src/lib/rate-limit.ts
           * does on a successful sign-in. Without this, an account that was
           * being credential-stuffed at the moment you rotated it stays locked,
           * and the operator concludes the new password does not work.
           */
          const [updated] = await tx`
            UPDATE users
               SET password_hash = ${p.hash},
                   failed_login_count = '0'::jsonb,
                   locked_until = NULL,
                   updated_at = now()
             WHERE id = ${p.id}::uuid
            RETURNING password_hash
          `;

          /**
           * Second verification, and the one that matters: the password is
           * checked against the bytes Postgres actually stored, not against the
           * string held in this process. A column type change, an encoding
           * mangle or a truncating varchar would all pass the in-memory check
           * and fail here — before COMMIT, with the old password still valid.
           */
          if (!(await argon2Verify(updated.password_hash, p.password, ARGON2_OPTIONS))) {
            throw new Error(
              `Read-back verification FAILED for ${p.email}: the stored hash does not ` +
                `accept the password just generated. Entire rotation rolled back.`,
            );
          }

          /**
           * Revoke every live session in the same transaction.
           *
           * Mirrors deactivateUser() in packages/core/src/services/users.ts:207.
           * `sessions` is not tenant-scoped, so this is a direct write rather
           * than a call into the web app's cookie-aware revokeAllSessions() —
           * that one can only ever revoke the *acting* user's own sessions,
           * which is the wrong direction for an operator rotating someone else.
           *
           * The `nexus_auth_level` marker cookie is HMAC-bound to the session
           * token (setAuthLevel in apps/web/src/lib/mfa.ts), so it dies with the
           * session it attests to and needs no separate revocation.
           *
           * Expiry is deliberately NOT part of the predicate. An already-expired
           * row cannot authenticate, so revoking it changes nothing an attacker
           * could use — but leaving it unrevoked means the two counts the
           * operator sees (live sessions before, sessions closed) disagree for
           * no reason a reader can work out. Both numbers are reported, and the
           * `live` one is the one that mattered.
           */
          const [revoked] = await tx`
            WITH gone AS (
              UPDATE sessions SET revoked_at = now()
               WHERE user_id = ${p.id}::uuid AND revoked_at IS NULL
              RETURNING expires_at > now() AS was_live
            ) SELECT count(*)::int AS n,
                     count(*) FILTER (WHERE was_live)::int AS live
                FROM gone
          `;

          if (p.email) {
            await tx`
              DELETE FROM rate_limit_hits
               WHERE key IN (${`login:fail:${p.email}`}, ${`login:lock:${p.email}`})
            `;
          }

          /**
           * Audit: who, when, which account, how many sessions died — and NO
           * password and NO hash. The plaintext is obvious; the hash matters
           * too, because an audit log is read by more people than the users
           * table and a stored argon2id hash is a crackable artefact. The
           * assertion below is the structural guarantee rather than the promise.
           */
          const diff = {
            operator: args.operator,
            tool: "scripts/rotate-passwords.mjs",
            target: { host: target.host, database: target.database },
            email: p.email,
            roleKey: p.roleKey,
            sessionsRevoked: revoked.n,
            liveSessionsRevoked: revoked.live,
            lockoutCleared: true,
            mfaRequiredByRole: p.mfaRequired,
            mfaEnrolled: p.mfaEnrolled,
            hashAlgorithm: "argon2id",
            hashParams: ARGON2_OPTIONS,
          };
          const serialised = JSON.stringify(diff);
          if (serialised.includes(p.password) || serialised.includes(p.hash)) {
            throw new Error("Refusing to write a credential into the audit log. Rolled back.");
          }

          /**
           * `audit_log` carries `tenant_id` and therefore an RLS policy whose
           * WITH CHECK requires `app.tenant_id` to match. Set transaction-locally
           * so this works when connected as the NOBYPASSRLS application role as
           * well as the owner — the same `set_config(..., true)` that
           * withTenant() uses in packages/db/src/client.ts. An account with no
           * default tenant gets a NULL-tenant row, which the policy rejects, so
           * it is left to the owner connection.
           */
          if (p.tenantId) {
            await tx`SELECT set_config('app.tenant_id', ${p.tenantId}, true)`;
          }
          await tx`
            INSERT INTO audit_log (id, tenant_id, actor_user_id, actor_label, action,
                                   entity_table, entity_id, diff, at)
            VALUES (gen_random_uuid(), ${p.tenantId}, NULL,
                    ${`cli:rotate-passwords ${args.operator}`.slice(0, 200)},
                    'user.password_rotate', 'users', ${p.id}::uuid,
                    ${sql.json(diff)}, now())
          `;

          done.push({
            email: p.email,
            password: p.password,
            roleKey: p.roleKey,
            mfaRequired: p.mfaRequired,
            mfaEnrolled: p.mfaEnrolled,
            sessionsRevoked: revoked.n,
            liveSessionsRevoked: revoked.live,
          });
          console.log(
            `  ✓ ${pad(p.email, 26)} password verified against stored hash · ` +
              `${revoked.n} session${revoked.n === 1 ? "" : "s"} closed ` +
              `(${revoked.live} live)`,
          );
        }
        if (!args.commit) throw DRY_RUN_ROLLBACK;
        return done;
      });
    } catch (err) {
      if (err !== DRY_RUN_ROLLBACK) throw err;
      console.log("");
      console.log("· DRY RUN — transaction rolled back. Nothing changed.");
      console.log("  Every statement above ran against the real database and was undone,");
      console.log("  including the read-back verification of each new hash.");
      console.log("");
      console.log(`  To rotate for real:  node scripts/rotate-passwords.mjs \\`);
      console.log(`      --host ${target.host} ${args.all ? "--all" : args.accounts.map((a) => `--account ${a}`).join(" ")} \\`);
      console.log(`      --commit ${target.host}`);
      console.log("");
      return;
    }

    printCredentials(results, target);

    const withMfa = results.filter((r) => r.mfaRequired && !r.mfaEnrolled);
    if (withMfa.length) {
      console.log("  MFA — expected behaviour, not a failure:");
      console.log("  These roles require a second factor and have none enrolled, so the");
      console.log("  first sign-in lands on /settings/security in a restricted `mfa_setup`");
      console.log("  session that can reach nothing else until enrolment completes:");
      for (const r of withMfa) console.log(`      ${r.email}  (${r.roleKey})`);
      console.log("");
    }

    const totalSessions = results.reduce((n, r) => n + r.sessionsRevoked, 0);
    const totalLive = results.reduce((n, r) => n + r.liveSessionsRevoked, 0);
    console.log(
      `· Committed. ${results.length} account${results.length === 1 ? "" : "s"} rotated, ` +
        `${totalSessions} session${totalSessions === 1 ? "" : "s"} closed ` +
        `(${totalLive} of them still live), ` +
        `${results.length} audit row${results.length === 1 ? "" : "s"} written.`,
    );
    console.log("");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Deliberately not `.catch(console.error)`: a rotation that half-fails must
// exit non-zero so a wrapping shell script or runbook step stops.
main().catch((err) => {
  console.error(`\n✗ Rotation failed: ${err?.message ?? err}`);
  console.error("  The transaction was rolled back — no password was changed.\n");
  process.exit(1);
});
