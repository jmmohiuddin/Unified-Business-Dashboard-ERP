/**
 * FAIL-CLOSED CONFIGURATION CHECKS.
 *
 * The most common serious security incident in a small SaaS is not a clever
 * exploit — it is shipping to production with the development secret still in
 * place, or with the app connected as the database owner so RLS silently does
 * nothing. Both are invisible until someone goes looking.
 *
 * So the app refuses to start. A hard crash at boot is embarrassing for ten
 * minutes; a silent misconfiguration is a breach that surfaces months later.
 */

export interface ConfigProblem {
  key: string;
  severity: "fatal" | "warning";
  message: string;
  fix?: string;
}

/** Values that must never survive into production. */
const KNOWN_DEV_SECRETS = [
  "dev-only-change-me-to-32-bytes-of-random",
  "changeme",
  "secret",
  "password",
  "development",
];

function looksWeak(value: string): boolean {
  if (value.length < 32) return true;
  if (KNOWN_DEV_SECRETS.some((d) => value.toLowerCase().includes(d))) return true;
  // A secret with almost no distinct characters is a repeated pattern, not a
  // random value — "aaaa…" passes a naive length check.
  return new Set(value).size < 12;
}

export function checkConfiguration(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProduction = env.NODE_ENV === "production";
  const fatal = (key: string, message: string, fix?: string) =>
    problems.push({ key, severity: isProduction ? "fatal" : "warning", message, fix });
  const warn = (key: string, message: string, fix?: string) =>
    problems.push({ key, severity: "warning", message, fix });

  // ── Session signing ───────────────────────────────────────────────────────
  const authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    fatal("AUTH_SECRET", "Not set. Sessions and the MFA challenge cannot be signed.",
      "openssl rand -base64 48");
  } else if (looksWeak(authSecret)) {
    fatal("AUTH_SECRET", "Is a development placeholder or too weak for production.",
      "openssl rand -base64 48");
  }

  // ── PII keys ──────────────────────────────────────────────────────────────
  if (!env.PII_ENCRYPTION_KEYS) {
    fatal("PII_ENCRYPTION_KEYS",
      "Not set. Identity documents would be stored under a key derived from AUTH_SECRET.",
      "npm run keygen");
  } else {
    try {
      const keys = JSON.parse(env.PII_ENCRYPTION_KEYS) as Record<string, string>;
      const bad = Object.entries(keys).filter(
        ([, v]) => Buffer.from(v, "base64").length !== 32,
      );
      if (bad.length > 0) {
        fatal("PII_ENCRYPTION_KEYS",
          `Key(s) ${bad.map(([k]) => k).join(", ")} are not 32 bytes.`);
      }
      const active = env.PII_ACTIVE_KEY_ID;
      if (active && !keys[active]) {
        fatal("PII_ACTIVE_KEY_ID", `"${active}" is not present in PII_ENCRYPTION_KEYS.`);
      }
      if (Object.keys(keys).length > 1 && !active) {
        warn("PII_ACTIVE_KEY_ID",
          "Multiple keys configured but no active key named; the highest id is assumed.");
      }
    } catch {
      fatal("PII_ENCRYPTION_KEYS", "Is not valid JSON.");
    }
  }

  // ── Database roles ────────────────────────────────────────────────────────
  const appUrl = env.APP_DATABASE_URL;
  const adminUrl = env.DATABASE_URL;
  if (!adminUrl) {
    fatal("DATABASE_URL", "Not set.");
  }
  if (!appUrl) {
    fatal("APP_DATABASE_URL",
      "Not set. The app would fall back to the owner role, which BYPASSES row-level security.",
      "Create a non-owner role: npm run db:rls");
  } else if (appUrl === adminUrl) {
    // This is the single highest-impact misconfiguration in the whole system.
    fatal("APP_DATABASE_URL",
      "Is identical to DATABASE_URL. The app would run as the table owner and every " +
        "RLS policy would be silently ignored — one tenant could read all the others.",
      "Point APP_DATABASE_URL at the nexus_app role.");
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  if (isProduction) {
    if (appUrl && !/sslmode=(require|verify-full|verify-ca)/.test(appUrl)) {
      warn("APP_DATABASE_URL", "No sslmode set — database traffic may be unencrypted.",
        "Append ?sslmode=verify-full");
    }
    if (env.TRUST_PROXY !== "true") {
      warn("TRUST_PROXY",
        "Not enabled. Behind a load balancer the rate limiter will see one IP for everyone.");
    }
  } else if (env.TRUST_PROXY === "true") {
    // Trusting a forwarded header with no proxy in front lets any client forge
    // its own IP and walk straight past the rate limiter.
    warn("TRUST_PROXY",
      "Enabled outside production. X-Forwarded-For can be spoofed to bypass rate limits.");
  }

  // ── Backups ───────────────────────────────────────────────────────────────
  // Deliberately a warning, not a fatal. The web app does not take backups, so
  // refusing to serve requests because a backup key is absent would couple two
  // unrelated concerns. Enforcement lives at the point of use: scripts/backup.mjs
  // exits non-zero rather than writing a plaintext dump. This check exists so the
  // gap is visible before someone discovers it during an incident.
  if (isProduction) {
    if (!env.BACKUP_ENCRYPTION_KEY) {
      warn("BACKUP_ENCRYPTION_KEY",
        "Not set. Backups will refuse to run, so there is no recovery path.",
        "npm run keygen");
    } else if (looksWeak(env.BACKUP_ENCRYPTION_KEY)) {
      warn("BACKUP_ENCRYPTION_KEY",
        "Is weak. It is the only thing standing between a stolen dump and every record.",
        "npm run keygen");
    }
  }

  // ── AI ────────────────────────────────────────────────────────────────────
  if (env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
    warn("ANTHROPIC_API_KEY", "Does not look like an Anthropic key.");
  }

  return problems;
}

/**
 * Call at boot. Throws in production, prints loudly in development.
 *
 * Development deliberately continues: an engineer cloning the repo must be able
 * to run it, and the warnings tell them exactly what to fix before deploying.
 */
export function assertConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const problems = checkConfiguration(env);
  if (problems.length === 0) return;

  const fatals = problems.filter((p) => p.severity === "fatal");
  const lines = problems.map(
    (p) =>
      `  ${p.severity === "fatal" ? "✗" : "!"} ${p.key}: ${p.message}` +
      (p.fix ? `\n      fix: ${p.fix}` : ""),
  );

  if (fatals.length > 0) {
    throw new Error(
      `Refusing to start — ${fatals.length} fatal configuration problem(s):\n${lines.join("\n")}`,
    );
  }
  console.warn(`\n[security] configuration warnings:\n${lines.join("\n")}\n`);
}
