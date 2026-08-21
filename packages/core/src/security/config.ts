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

/** The part of a connection string that decides which role connects where. */
interface DatabaseTarget {
  user: string;
  host: string;
  port: string;
  database: string;
}

/**
 * Reduce a connection string to the four things that determine its privileges.
 *
 * The owner-role gate below used to be `appUrl === adminUrl` — a raw string
 * compare on two URLs, guarding what its own comment correctly calls the single
 * highest-impact misconfiguration in the system. Four edits that change nothing
 * about *which role connects to which database* defeat a string compare:
 *
 *     …neon.tech/nexus   vs  …neon.tech/nexus/                 trailing slash
 *     …neon.tech/nexus   vs  …neon.tech/nexus?sslmode=require  query string
 *     …ep-x.neon.tech/…  vs  …ep-X.neon.tech/…                 host case
 *     …:5432/nexus       vs  …/nexus                           default port
 *
 * The second is not hypothetical: the transport check further down tells the
 * operator to append `?sslmode=verify-full` to APP_DATABASE_URL, which is
 * exactly the edit that makes two identical connections compare unequal and the
 * gate fall silent. A check that its own neighbouring advice disarms is worse
 * than no check, because it reports green.
 *
 * Returns null when the URL cannot be parsed, which the caller treats as fatal
 * rather than falling back to a weaker compare — see the reasoning there.
 */
function parseDatabaseTarget(url: string): DatabaseTarget | null {
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("postgres")) return null;
    return {
      user: decodeURIComponent(u.username),
      // Hostnames are case-insensitive; ep-X and ep-x are one server.
      host: u.hostname.toLowerCase(),
      // An omitted port and an explicit 5432 are the same connection.
      port: u.port || "5432",
      // "/nexus", "/nexus/" and "//nexus" are all the database `nexus`.
      database: decodeURIComponent(u.pathname).replace(/^\/+/, "").replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

function sameDatabaseTarget(a: DatabaseTarget, b: DatabaseTarget): boolean {
  return (
    a.user === b.user && a.host === b.host && a.port === b.port && a.database === b.database
  );
}

export function checkConfiguration(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProduction = env.NODE_ENV === "production";
  const fatal = (key: string, message: string, fix?: string) =>
    problems.push({ key, severity: isProduction ? "fatal" : "warning", message, fix });
  const warn = (key: string, message: string, fix?: string) =>
    problems.push({ key, severity: "warning", message, fix });
  // `fatal` is really "fatal in production, a warning elsewhere", because a
  // fresh clone must still run. This one is not conditional — reserve it for a
  // value whose absence makes the app unusable in *every* environment, where
  // downgrading to a warning would only trade a clear boot error for a
  // confusing runtime one.
  const alwaysFatal = (key: string, message: string, fix?: string) =>
    problems.push({ key, severity: "fatal", message, fix });

  // ── Session signing ───────────────────────────────────────────────────────
  const authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    // Unset is fatal everywhere, not only in production, for two reasons that
    // point the same way.
    //
    // The visible one: proxy.ts verifies the signed auth-level marker on every
    // request (`readAuthLevel`, :84) and fails closed without a secret —
    // `level === null` redirects to /login?error=session and deletes both
    // cookies (:136-142). Nobody can hold a session, so signing in is
    // impossible on a laptop exactly as much as in production, and warning
    // instead would swap one clear message for an unexplained redirect loop.
    //
    // The dangerous one: `lib/session.ts:161,180` HMAC the MFA challenge and
    // the session payload with `process.env.AUTH_SECRET ?? ""`. A missing
    // secret does not fail there — it signs with the empty key, which anyone
    // who knows the payload format can reproduce. So the choice is not between
    // "works" and "warns"; it is between refusing to boot and running a second
    // factor whose challenge is forgeable. That must not be survivable in any
    // environment, because a development instance with real data in it is
    // still an instance.
    alwaysFatal("AUTH_SECRET",
      "Not set. Sessions and the MFA challenge would be signed with an empty key — " +
        "forgeable by anyone — and proxy.ts will bounce every authenticated request " +
        "to /login, so no one can sign in at all.",
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
  } else {
    // This is the single highest-impact misconfiguration in the whole system,
    // so it is compared on the parsed target rather than the raw string. See
    // parseDatabaseTarget for the four edits a string compare misses.
    const appTarget = parseDatabaseTarget(appUrl);
    const adminTarget = adminUrl ? parseDatabaseTarget(adminUrl) : null;

    // An unparseable URL is fatal rather than a silent fall-back to the string
    // compare it replaces. The gate is fail-closed by design; "I could not
    // evaluate the check" must not present as "the check passed", which is the
    // exact shape of the defect being fixed here.
    if (!appTarget) {
      fatal("APP_DATABASE_URL",
        "Is not a parseable postgres:// URL, so it cannot be checked against DATABASE_URL. " +
          "The app refuses to start rather than run an owner-role check it could not perform.",
        "postgresql://nexus_app:PASSWORD@host:5432/nexus?sslmode=verify-full");
    } else if (adminUrl && !adminTarget) {
      fatal("DATABASE_URL",
        "Is not a parseable postgres:// URL, so APP_DATABASE_URL cannot be checked against it.",
        "postgresql://nexus:PASSWORD@host:5432/nexus?sslmode=verify-full");
    } else if (adminTarget && sameDatabaseTarget(appTarget, adminTarget)) {
      fatal("APP_DATABASE_URL",
        `Resolves to the same role on the same database as DATABASE_URL ` +
          `(${appTarget.user}@${appTarget.host}:${appTarget.port}/${appTarget.database}). ` +
          "The app would run as the table owner and every RLS policy would be silently " +
          "ignored — one tenant could read all the others. Differing query strings, " +
          "trailing slashes or host casing do not make them different connections.",
        "Point APP_DATABASE_URL at the nexus_app role.");
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  if (isProduction) {
    if (appUrl && !/sslmode=(require|verify-full|verify-ca)/.test(appUrl)) {
      warn("APP_DATABASE_URL", "No sslmode set — database traffic may be unencrypted.",
        "Append ?sslmode=verify-full");
    }
    // Fatal, not a warning — and the reason is explicitness, not breakage.
    //
    // `clientIp` in apps/web/src/proxy.ts derives trust: `TRUST_PROXY=true`, or
    // the `VERCEL` variable being present unless `TRUST_PROXY=false` overrides
    // it. So on Vercel with this unset the limiter already works; nothing is
    // broken. That derived default is a safety net for the environments this
    // gate does not reach — preview deploys, anywhere NODE_ENV is not
    // "production" — and it is not a substitute for configuration.
    //
    // What it must not become is the thing production silently depends on. The
    // inference is "`VERCEL` is set, therefore a trustworthy proxy rewrote
    // X-Forwarded-For", and that is true only for as long as this app is served
    // from Vercel. Move it behind anything else and the inference fails with no
    // symptom: `clientIp` returns the literal "local" for every caller on earth,
    // so `api:local` and `login:local` become one global counter. That is not a
    // degraded limiter, it is an inverted one — one attacker spending the
    // 120-per-minute budget locks out every real customer, and a distributed
    // credential-stuffing run is indistinguishable from a single client. The
    // dashboard still says throttling is on.
    //
    // Requiring the operator to state the intent turns that silent forensics
    // gap into a boot failure on the day the platform changes. A deployment
    // whose IP handling rests on an inference nobody wrote down is one bad
    // inference away from having no rate limiting at all.
    //
    // Note `TRUST_PROXY=false` is load-bearing downstream and does not mean the
    // same as unset — it actively disables trust even on Vercel. So what this
    // gate demands is an ANSWER, not a particular answer: "false" is a valid,
    // deliberate deployment (self-hosted, nothing trustworthy in front) and
    // must boot. Rejecting it would contradict this check's own remedy text and
    // would make the app undeployable anywhere but Vercel.
    if (env.TRUST_PROXY !== "true" && env.TRUST_PROXY !== "false") {
      fatal("TRUST_PROXY",
        env.TRUST_PROXY === undefined || env.TRUST_PROXY === ""
          ? "Not set explicitly. proxy.ts infers trust from the VERCEL variable, which is " +
              "correct only while this app is served from Vercel; production must state it."
          : `Set to "${env.TRUST_PROXY}", which is neither "true" nor "false". An ` +
              "unrecognised value is treated as no answer at all.",
        "Set TRUST_PROXY=true — Vercel's proxy overwrites X-Forwarded-For. Set it to " +
          "false only if nothing trustworthy sits in front.");
    }
  } else if (env.TRUST_PROXY === "true") {
    // Trusting a forwarded header with no proxy in front lets any client forge
    // its own IP and walk straight past the rate limiter.
    warn("TRUST_PROXY",
      "Enabled outside production. X-Forwarded-For can be spoofed to bypass rate limits.");
  }

  // `clientIp` counts hops from the RIGHT of X-Forwarded-For, so hop 1 is the
  // entry the nearest trusted proxy wrote and a client-forged left entry cannot
  // win. It clamps anything unparseable to 1 — which is the safe direction, but
  // silently, and that is the problem. An operator who put a CDN in front of
  // Vercel and typed TRUST_PROXY_HOPS=2 with a typo gets 1 back, which reads
  // the CDN's own address instead of the caller's. Every request arriving
  // through that CDN then shares a single bucket: the same global-counter
  // failure the check above exists to prevent, one layer further out, and just
  // as invisible. A security knob that corrects your typo without telling you
  // is a knob you cannot rely on.
  //
  // Empty counts as unset, not as garbage: a key left blank in .env.example is
  // how every optional variable in this file is declared, and failing a boot
  // over a placeholder nobody filled in would be the check crying wolf.
  const hops = env.TRUST_PROXY_HOPS;
  if (hops && !/^[1-9]\d*$/.test(hops)) {
    fatal("TRUST_PROXY_HOPS",
      `Is "${hops}", which is not a positive integer. proxy.ts would silently clamp it ` +
        "to 1 and read the wrong hop of X-Forwarded-For.",
      "Leave it blank for the normal single-proxy case, or set the number of trusted " +
        "proxies in front of the app (a CDN ahead of Vercel is 2).");
  }

  // ── Demo mode ─────────────────────────────────────────────────────────────
  // Demo mode prefills working credentials on the sign-in page and lists every
  // seeded account. Harmless on a laptop, a published credential leak anywhere
  // reachable.
  if (isProduction && env.NEXUS_DEMO_MODE === "true") {
    fatal("NEXUS_DEMO_MODE",
      "Enabled in production. The sign-in page will publish working credentials " +
        "for every seeded account to anyone who loads it.",
      "Unset NEXUS_DEMO_MODE.");
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

  // ── Observability sinks ───────────────────────────────────────────────────
  // Both are optional: the default sink writes structured JSON to stdout, which
  // a Vercel log drain collects with no account and no vendor SDK. A webhook is
  // the upgrade, not the baseline.
  //
  // They are checked here because the failure mode is otherwise invisible. A
  // sink URL with a typo does not raise anything at boot and does not break a
  // request — the adapter is deliberately fail-safe — so the first sign that
  // alerting was never delivering is the incident nobody was paged for. Better
  // to refuse to start than to believe you are being watched.
  //
  // Treat both values as secrets: for Slack, Discord and Better Stack the URL
  // *is* the credential, so nothing here ever echoes the value back.
  for (const key of ["ERROR_SINK_URL", "ALERT_SINK_URL"] as const) {
    const raw = env[key];
    if (!raw) continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      fatal(key, "Is set but is not a valid http(s) URL, so nothing would ever be delivered.",
        "Unset it to fall back to structured stdout, or fix the URL.");
    } else if (isProduction && parsed.protocol !== "https:") {
      fatal(key,
        "Is plain http. Reports carry stack frames and request context, and for most " +
          "providers the URL itself is the credential.",
        "Use https.");
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
