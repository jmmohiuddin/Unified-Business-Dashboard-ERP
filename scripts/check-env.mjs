#!/usr/bin/env node
/**
 * ENVIRONMENT FENCE — does this deployment agree with itself about where it is?
 *
 *   node scripts/check-env.mjs              check this process's environment
 *   node scripts/check-env.mjs --self-test  run the fixtures, touch no real env
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * Today every Vercel preview deployment of this repository connects to the
 * PRODUCTION database. That is not a hypothetical: it is written down in
 * README.md ("Vercel preview deployments share the production database, so they
 * are not staging") and it is the reason docs/OPS-07 §2.1 row 3 has never been
 * tickable. A preview is a full copy of the application with every server
 * action enabled, so a branch that half-rewrites the rent run posts real
 * journals into the real ledger, and a `TRUNCATE` in a migration under review
 * destroys real records. Nothing in the system currently notices.
 *
 * The existing gate in packages/core/src/security/config.ts asks a different
 * and narrower question: does APP_DATABASE_URL resolve to the same *role* as
 * DATABASE_URL, which would mean RLS is a no-op. That check is correct and
 * unaffected by this one. But it passes cleanly when a preview deployment is
 * connected to production as `nexus_app` — which is precisely the shape of the
 * accident. RLS is enforced, tenant isolation holds, and the writes are still
 * landing in production.
 *
 * The missing question is about IDENTITY, not privilege:
 *
 *     "Which environment does this deployment believe it is,
 *      and is the database it is connected to the one that belief implies?"
 *
 * Neither half can be inferred. `VERCEL_ENV` cannot answer it, because a second
 * Vercel project serving staging from `main` reports VERCEL_ENV=production —
 * staging genuinely is that project's production. And a connection string
 * cannot answer it either, because a Neon branch's hostname has no derivable
 * relationship to its parent's. So both halves have to be DECLARED, and this
 * script checks the declaration against the connection.
 *
 * ── The two declarations ────────────────────────────────────────────────────
 *
 *   NEXUS_ENV                    what this deployment believes it is:
 *                                production | staging | preview | development | test
 *
 *   NEXUS_PRODUCTION_DB_HOST     which database is production, as `host` or
 *                                `host/database`. NOT a secret and not a
 *                                credential — a hostname only. It is set
 *                                identically in every environment, including
 *                                the ones that must never reach it, because a
 *                                fence you only install on the safe side of the
 *                                gap is not a fence.
 *
 *   NEXUS_PRODUCTION_KEY_DIGEST  optional. The SHA-256 of production's
 *                                PII_INDEX_KEY, hex. Also not a secret: it is a
 *                                one-way digest of 32 random bytes. It catches
 *                                the other half of the same accident — a
 *                                staging environment created by copying
 *                                production's environment variables wholesale,
 *                                which leaves staging able to decrypt every
 *                                Emirates ID, passport and IBAN it holds.
 *
 * ── Where it runs, and why that is "refuses to start" ───────────────────────
 *
 * On Vercel this runs as the first half of the build command, so a confused
 * deployment fails to build and therefore never serves a request. That is a
 * stronger guarantee than a boot-time crash, not a weaker one: a boot crash
 * still produces a deployment that exists, can be promoted, and can be aliased.
 *
 * It also runs in .github/workflows/staging.yml immediately before the staging
 * migration step, where it is load-bearing in the most direct way available: if
 * STAGING_DATABASE_URL has production's hostname in it, `drizzle-kit migrate`
 * never runs.
 *
 * The runtime half is not yet wired. `apps/web/src/instrumentation.ts` would
 * need to call the same logic from `register()` for a long-lived instance whose
 * environment changed under it to refuse to keep serving. That file is owned
 * elsewhere; see docs/08-staging.md § "Handoff" for the exact call.
 *
 * ── Which way it fails ──────────────────────────────────────────────────────
 *
 * A contradiction is fatal in every environment, not only production. The whole
 * class of bug is "this is not the environment you think it is", so trusting
 * NODE_ENV to decide how seriously to take it would be circular.
 *
 * An absent fence is fatal for `staging` and `preview` and a warning for
 * `production`, and the asymmetry is deliberate. Production connected to
 * production is the default state of the world; the check being unavailable
 * there means the operator loses a confirmation. Staging or preview connected
 * to production is the accident itself, and there the check being unavailable
 * means the only thing standing between a branch and the real ledger is
 * somebody's memory. On a laptop (`development`, `test`) the fence is silently
 * optional, for the same reason config.ts downgrades its own checks there: a
 * fresh clone has to run.
 *
 * Nothing here prints a password. Every message quotes user, host, port and
 * database — never the URL — because these strings go into build logs, GitHub
 * Actions annotations and, via config.problem, a webhook.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The five things a deployment is allowed to believe it is. */
const ENVIRONMENTS = ["production", "staging", "preview", "development", "test"];

/** Environments where being wrong writes to somebody's real ledger. */
const DANGEROUS_IF_UNVERIFIED = new Set(["staging", "preview"]);

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Reduce a connection string to the four things that identify a database.
 *
 * Deliberately the same normalisation as `parseDatabaseTarget` in
 * packages/core/src/security/config.ts — lowercased host, defaulted port,
 * stripped path slashes — for the reason documented at length there: a trailing
 * slash, an added `?sslmode=verify-full`, or a change of host casing must not
 * be able to make two identical connections compare unequal and silence a gate.
 *
 * Duplicated rather than imported because this file has to run in a Vercel
 * build command and in a GitHub job before `npm ci`, where `@nexus/core` is not
 * built and may not even be installed. A guard that cannot run in the place the
 * accident happens is not a guard.
 */
function parseDatabaseTarget(url) {
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("postgres")) return null;
    return {
      user: decodeURIComponent(u.username),
      host: u.hostname.toLowerCase(),
      port: u.port || "5432",
      database: decodeURIComponent(u.pathname).replace(/^\/+/, "").replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

/** How a target is named in a message. Never includes the password. */
function describeTarget(t) {
  return `${t.user || "?"}@${t.host}:${t.port}/${t.database || "?"}`;
}

/**
 * Parse the production fence.
 *
 * Accepts `ep-cool-frost-123.eu-central-1.aws.neon.tech` or that plus
 * `/nexus`. A bare hostname matches any database on that host, which is the
 * right default for Neon: a branch gets its own endpoint hostname, so the host
 * alone already distinguishes production from every branch of it.
 *
 * Returns `{ invalid, reason }` rather than null-on-anything, because the two
 * failure modes need different messages and one of them is a security problem
 * in its own right: an operator who pastes the whole production connection
 * string in here has just put a password into a variable this file was designed
 * to echo freely into build logs.
 */
function parseFence(raw) {
  const value = (raw ?? "").trim();
  if (!value) return null;

  if (value.includes("://") || value.includes("@")) {
    return {
      invalid: true,
      reason:
        "looks like a connection string, not a hostname. This value is echoed into " +
        "build logs and CI annotations on purpose, so it must never carry a credential.",
    };
  }

  const [hostPart, ...rest] = value.split("/");
  const host = hostPart.split(":")[0].toLowerCase();
  if (!host || !/^[a-z0-9.\-_]+$/.test(host)) {
    return { invalid: true, reason: `"${value}" is not a hostname.` };
  }
  const database = rest.join("/").replace(/\/+$/, "") || null;
  return { host, database };
}

/** Does this connection target sit behind the fence? */
function matchesFence(target, fence) {
  if (target.host !== fence.host) return false;
  if (fence.database && target.database !== fence.database) return false;
  return true;
}

/**
 * What this deployment believes it is, and on whose authority.
 *
 * `NEXUS_ENV` is the authority when set. VERCEL_ENV is only a fallback — and
 * only a partial one, because it cannot express the staging case: a dedicated
 * Vercel project for staging reports VERCEL_ENV=production for its own
 * production deployments. Reading VERCEL_ENV as the answer would therefore
 * label staging "production", which is the exact confusion being guarded.
 */
function declaredEnvironment(env) {
  const explicit = (env.NEXUS_ENV ?? "").trim().toLowerCase();
  if (explicit) {
    return ENVIRONMENTS.includes(explicit)
      ? { name: explicit, source: "NEXUS_ENV" }
      : { name: null, source: "NEXUS_ENV", invalid: explicit };
  }

  const vercel = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercel === "preview") return { name: "preview", source: "VERCEL_ENV" };
  if (vercel === "development") return { name: "development", source: "VERCEL_ENV" };
  if (vercel === "production") return { name: "production", source: "VERCEL_ENV" };

  if (env.CI === "true") return { name: "test", source: "CI" };
  if (env.NODE_ENV === "production") return { name: null, source: "NODE_ENV" };
  return { name: "development", source: "default" };
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

// ── The check ───────────────────────────────────────────────────────────────

/**
 * Pure. Takes an environment, returns problems. Reads nothing, prints nothing.
 *
 * Pure so that `--self-test` can drive it with fixtures, which is what makes
 * this file more than an assertion about itself: CI proves that a preview
 * pointed at production is actually rejected, rather than proving that the
 * script exits zero on a runner where nothing is misconfigured.
 */
export function checkEnvironment(env) {
  const problems = [];
  const fatal = (key, message, fix) => problems.push({ key, severity: "fatal", message, fix });
  const warn = (key, message, fix) => problems.push({ key, severity: "warning", message, fix });

  // ── 1. The claim ──────────────────────────────────────────────────────────
  const declared = declaredEnvironment(env);

  if (declared.invalid !== undefined) {
    fatal(
      "NEXUS_ENV",
      `Is "${declared.invalid}", which is not one of ${ENVIRONMENTS.join(", ")}. An ` +
        "unrecognised value is treated as no answer at all rather than guessed at, " +
        "because every check below keys off it.",
      `Set NEXUS_ENV to one of: ${ENVIRONMENTS.join(", ")}`,
    );
    return problems;
  }

  if (!declared.name) {
    fatal(
      "NEXUS_ENV",
      "Not set, and nothing else can answer for it. NODE_ENV is production but there " +
        "is no VERCEL_ENV, so this could be production, staging, or a copy of either. " +
        "The database fence below cannot be evaluated without knowing which.",
      "Set NEXUS_ENV explicitly on every deployed environment. See docs/08-staging.md.",
    );
    return problems;
  }

  const name = declared.name;

  // A Vercel *preview* deployment is never production, whatever it claims.
  // The converse is not true and must not be asserted: VERCEL_ENV=production on
  // a dedicated staging project is correct and common.
  const vercelEnv = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercelEnv === "preview" && name === "production") {
    fatal(
      "NEXUS_ENV",
      'Claims "production" on a Vercel preview deployment (VERCEL_ENV=preview). A ' +
        "preview is built from an unmerged branch and is never the production " +
        "environment; a deployment that believes otherwise will happily be pointed " +
        "at the production database by the checks below.",
      "Set NEXUS_ENV=preview for the Preview environment in the Vercel project.",
    );
  }

  // ── 2. The fence value itself ─────────────────────────────────────────────
  const fence = parseFence(env.NEXUS_PRODUCTION_DB_HOST);
  if (fence?.invalid) {
    fatal(
      "NEXUS_PRODUCTION_DB_HOST",
      `Cannot be used as a fence: ${fence.reason}`,
      "Set it to production's hostname only, optionally with /database — " +
        "e.g. ep-example-123.eu-central-1.aws.neon.tech/nexus",
    );
    return problems;
  }

  // ── 3. The connection ─────────────────────────────────────────────────────
  const urls = [
    ["APP_DATABASE_URL", env.APP_DATABASE_URL],
    ["DATABASE_URL", env.DATABASE_URL],
  ].filter(([, v]) => Boolean(v));

  const targets = [];
  for (const [key, value] of urls) {
    const target = parseDatabaseTarget(value);
    if (!target) {
      // config.ts makes this fatal at boot for its own reasons. It is fatal
      // here too, and for a reason of this file's own: an unparseable URL means
      // the fence comparison did not happen, and "I could not evaluate the
      // check" must never present as "the check passed".
      fatal(
        key,
        "Is not a parseable postgres:// URL, so it cannot be compared against the " +
          "production fence. Refusing rather than skipping the comparison.",
        "postgresql://user:PASSWORD@host:5432/nexus?sslmode=verify-full",
      );
      continue;
    }
    targets.push([key, target]);
  }

  if (fence && targets.length > 0) {
    const behindFence = targets.filter(([, t]) => matchesFence(t, fence));

    if (name !== "production" && behindFence.length > 0) {
      // The accident. Fatal everywhere, including development — a laptop
      // pointed at production is the same accident with a smaller audience.
      for (const [key, target] of behindFence) {
        fatal(
          key,
          `This deployment declares NEXUS_ENV=${name}, but ${key} resolves to ` +
            `${describeTarget(target)}, which NEXUS_PRODUCTION_DB_HOST names as the ` +
            "PRODUCTION database. Every write this deployment performs — a server " +
            "action, a migration, a seed — lands in the real ledger, and row-level " +
            "security does not help because the tenant is the same real tenant.",
          "Point this environment at its own Neon branch. docs/08-staging.md § 3.",
        );
      }
    }

    if (name === "production" && behindFence.length === 0) {
      // The mirror image, and it is not merely untidy. Production serving from
      // a staging branch shows stale figures to the accountant and writes real
      // invoices into a database that the next staging refresh overwrites.
      const seen = targets.map(([key, t]) => `${key}=${describeTarget(t)}`).join(", ");
      fatal(
        "NEXUS_PRODUCTION_DB_HOST",
        `This deployment declares NEXUS_ENV=production, but none of its database ` +
          `URLs point at the declared production host "${fence.host}" (${seen}). ` +
          "Either production is serving from a copy — in which case its writes will " +
          "be discarded by the next staging refresh — or the fence is out of date " +
          "after a database move.",
        "Update NEXUS_PRODUCTION_DB_HOST if production moved; otherwise fix the " +
          "database URLs on the production environment.",
      );
    }
  }

  if (!fence) {
    const message =
      "Not set, so it is not possible to tell whether this deployment is connected " +
      "to the production database.";
    if (DANGEROUS_IF_UNVERIFIED.has(name)) {
      fatal(
        "NEXUS_PRODUCTION_DB_HOST",
        `${message} NEXUS_ENV=${name} is exactly the environment where that mistake ` +
          "is unrecoverable, so an unverifiable answer is refused rather than assumed.",
        "Set NEXUS_PRODUCTION_DB_HOST to production's hostname in EVERY environment, " +
          "including this one. It is a hostname, not a secret. docs/08-staging.md § 2.",
      );
    } else if (name === "production") {
      warn(
        "NEXUS_PRODUCTION_DB_HOST",
        `${message} Production connected to production is the expected state, so this ` +
          "is a lost confirmation rather than a hazard — but the fence only works if " +
          "it is set identically everywhere, and an unset value here usually means it " +
          "is unset on preview too.",
        "Set NEXUS_PRODUCTION_DB_HOST to this deployment's own database hostname.",
      );
    }
  }

  // `urls`, not `targets`: a URL that is present but unparseable has already
  // been reported immediately above, and reporting it a second time as "not
  // set" would be wrong on the facts and would bury the accurate message.
  if (fence && urls.length === 0 && name !== "development" && name !== "test") {
    fatal(
      "APP_DATABASE_URL",
      `Neither APP_DATABASE_URL nor DATABASE_URL is set, so the production fence ` +
        `cannot be evaluated for NEXUS_ENV=${name}.`,
      "Set APP_DATABASE_URL for this environment.",
    );
  }

  // ── 4. Key material ───────────────────────────────────────────────────────
  //
  // A separate database is not enough on its own. Staging is normally created
  // by restoring a production dump, and the identity columns in that dump are
  // ciphertext — so an operator who copies production's PII_ENCRYPTION_KEYS
  // across to "make staging work" has built a second production system holding
  // readable Emirates IDs, passports and IBANs, with weaker access control and
  // a wider audience. The anonymisation pass in docs/08-staging.md § 4 exists
  // precisely so that staging never needs production's keys.
  //
  // Compared as a digest so the fence variable can be set in every environment
  // without being a secret: it is SHA-256 over 32 bytes of random key material.
  const expected = (env.NEXUS_PRODUCTION_KEY_DIGEST ?? "").trim().toLowerCase();
  const indexKey = env.PII_INDEX_KEY;

  if (expected && indexKey && name !== "production" && sha256(indexKey) === expected) {
    fatal(
      "PII_INDEX_KEY",
      `This deployment declares NEXUS_ENV=${name} but holds PRODUCTION's PII key ` +
        "material. Anything restored here from a production dump is readable in " +
        "clear: Emirates IDs, passport numbers, IBANs and TOTP secrets. The blind " +
        "index would also match production's, so a staging query can confirm whether " +
        "a given Emirates ID exists in production.",
      "Generate this environment's own keys (npm run keygen) and re-encrypt during " +
        "the anonymisation pass. docs/08-staging.md § 4.",
    );
  }

  if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
    warn(
      "NEXUS_PRODUCTION_KEY_DIGEST",
      "Is set but is not a 64-character hex SHA-256 digest, so it can never match " +
        "and the key-separation check silently passes.",
      'Set it to: node -e \'console.log(require("crypto").createHash("sha256")' +
        '.update(process.env.PII_INDEX_KEY).digest("hex"))\' run against production.',
    );
  }

  if (!expected && DANGEROUS_IF_UNVERIFIED.has(name)) {
    warn(
      "NEXUS_PRODUCTION_KEY_DIGEST",
      "Not set, so nothing detects this environment holding production's PII keys. " +
        "A warning rather than a refusal: the database fence above is the primary " +
        "control and this is the second line.",
      "See docs/08-staging.md § 2 for how to compute it.",
    );
  }

  return problems;
}

// ── Self-test ───────────────────────────────────────────────────────────────

/**
 * The fixtures are the point of this file being in CI.
 *
 * Running the guard against a green runner proves only that a correct
 * environment passes. What has to be proven is the opposite: that each accident
 * is actually caught, and stays caught when somebody edits the parsing. Each
 * row asserts the EXACT set of fatal keys, so a change that widens a rule until
 * everything fails fails here too.
 */
const PROD_HOST = "ep-prod-9f2c.eu-central-1.aws.neon.tech";
const STAGING_HOST = "ep-staging-4a71.eu-central-1.aws.neon.tech";
const prodUrl = (user) => `postgresql://${user}:pw@${PROD_HOST}/nexus?sslmode=require`;
const stagingUrl = (user) => `postgresql://${user}:pw@${STAGING_HOST}/nexus?sslmode=require`;

const FIXTURES = [
  {
    name: "production on the production database",
    env: {
      NEXUS_ENV: "production",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      DATABASE_URL: prodUrl("nexus"),
      APP_DATABASE_URL: prodUrl("nexus_app"),
    },
    fatal: [],
  },
  {
    name: "staging on its own branch",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      NEXUS_PRODUCTION_KEY_DIGEST: sha256("production-index-key"),
      DATABASE_URL: stagingUrl("nexus"),
      APP_DATABASE_URL: stagingUrl("nexus_app"),
      PII_INDEX_KEY: "staging-index-key",
    },
    fatal: [],
  },
  {
    name: "THE ACCIDENT — a preview pointed at production",
    env: {
      VERCEL_ENV: "preview",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      APP_DATABASE_URL: prodUrl("nexus_app"),
    },
    fatal: ["APP_DATABASE_URL"],
  },
  {
    name: "staging pointed at production, with the fence set",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      DATABASE_URL: prodUrl("nexus"),
      APP_DATABASE_URL: prodUrl("nexus_app"),
    },
    fatal: ["APP_DATABASE_URL", "DATABASE_URL"],
  },
  {
    // The four edits that defeat a raw string compare, per config.ts.
    name: "staging pointed at production through cosmetic URL differences",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: `${PROD_HOST}/nexus`,
      APP_DATABASE_URL: `postgresql://nexus_app:pw@${PROD_HOST.toUpperCase()}:5432/nexus/`,
    },
    fatal: ["APP_DATABASE_URL"],
  },
  {
    name: "staging with no fence configured",
    env: {
      NEXUS_ENV: "staging",
      APP_DATABASE_URL: stagingUrl("nexus_app"),
    },
    fatal: ["NEXUS_PRODUCTION_DB_HOST"],
  },
  {
    name: "production with no fence configured — a warning, not a refusal",
    env: {
      NEXUS_ENV: "production",
      APP_DATABASE_URL: prodUrl("nexus_app"),
    },
    fatal: [],
    warning: ["NEXUS_PRODUCTION_DB_HOST"],
  },
  {
    name: "production serving from a copy",
    env: {
      NEXUS_ENV: "production",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      APP_DATABASE_URL: stagingUrl("nexus_app"),
    },
    fatal: ["NEXUS_PRODUCTION_DB_HOST"],
  },
  {
    name: "a preview deployment that claims to be production",
    env: {
      VERCEL_ENV: "preview",
      NEXUS_ENV: "production",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      APP_DATABASE_URL: stagingUrl("nexus_app"),
    },
    // Both fire, and both are true: it is not production, AND it is not on the
    // production database either.
    fatal: ["NEXUS_ENV", "NEXUS_PRODUCTION_DB_HOST"],
  },
  {
    name: "staging holding production's PII keys",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      NEXUS_PRODUCTION_KEY_DIGEST: sha256("production-index-key"),
      APP_DATABASE_URL: stagingUrl("nexus_app"),
      PII_INDEX_KEY: "production-index-key",
    },
    fatal: ["PII_INDEX_KEY"],
  },
  {
    name: "the fence set to a whole connection string",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: prodUrl("nexus"),
      APP_DATABASE_URL: stagingUrl("nexus_app"),
    },
    fatal: ["NEXUS_PRODUCTION_DB_HOST"],
  },
  {
    name: "an unparseable database URL is refused, not skipped",
    env: {
      NEXUS_ENV: "staging",
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      APP_DATABASE_URL: "postgres//nexus_app@wherever",
    },
    fatal: ["APP_DATABASE_URL"],
  },
  {
    name: "NODE_ENV=production with nothing declaring where this is",
    env: { NODE_ENV: "production", APP_DATABASE_URL: prodUrl("nexus_app") },
    fatal: ["NEXUS_ENV"],
  },
  {
    name: "an unrecognised NEXUS_ENV is not guessed at",
    env: { NEXUS_ENV: "stage", APP_DATABASE_URL: stagingUrl("nexus_app") },
    fatal: ["NEXUS_ENV"],
  },
  {
    name: "a laptop with no fence and no claim",
    env: {
      DATABASE_URL: "postgresql://nexus:nexus@127.0.0.1:5432/nexus",
      APP_DATABASE_URL: "postgresql://nexus_app:nexus_app@127.0.0.1:5432/nexus",
    },
    fatal: [],
    warning: [],
  },
  {
    name: "a laptop pointed at production is still the accident",
    env: {
      NEXUS_PRODUCTION_DB_HOST: PROD_HOST,
      APP_DATABASE_URL: prodUrl("nexus_app"),
    },
    fatal: ["APP_DATABASE_URL"],
  },
];

function selfTest() {
  let failures = 0;
  console.log("\nEnvironment fence — self-test\n");

  for (const fixture of FIXTURES) {
    const problems = checkEnvironment(fixture.env);
    const keysOf = (severity) =>
      problems
        .filter((p) => p.severity === severity)
        .map((p) => p.key)
        .sort();

    const mismatches = [];
    const gotFatal = keysOf("fatal");
    const wantFatal = [...fixture.fatal].sort();
    if (gotFatal.join(",") !== wantFatal.join(",")) {
      mismatches.push(`fatal: expected [${wantFatal}] got [${gotFatal}]`);
    }
    if (fixture.warning) {
      const gotWarning = keysOf("warning");
      const wantWarning = [...fixture.warning].sort();
      if (gotWarning.join(",") !== wantWarning.join(",")) {
        mismatches.push(`warning: expected [${wantWarning}] got [${gotWarning}]`);
      }
    }

    if (mismatches.length === 0) {
      console.log(`  ✓ ${fixture.name}`);
    } else {
      failures++;
      console.error(`  ✗ ${fixture.name}`);
      for (const m of mismatches) console.error(`      ${m}`);
      for (const p of problems) console.error(`      · ${p.severity} ${p.key}: ${p.message}`);
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(`✗ ${failures} of ${FIXTURES.length} fixtures did not behave as documented.\n`);
    process.exit(1);
  }
  console.log(`✓ ${FIXTURES.length} fixtures — the fence catches what it claims to.\n`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

function report(env) {
  const declared = declaredEnvironment(env);
  const fence = parseFence(env.NEXUS_PRODUCTION_DB_HOST);
  const where = declared.name ?? "UNDECLARED";
  const via = declared.source === "NEXUS_ENV" ? "" : ` (derived from ${declared.source})`;

  console.log(`\nEnvironment fence — this deployment declares itself "${where}"${via}`);
  console.log(
    `  production database fence: ${
      fence?.invalid ? "INVALID" : fence ? `${fence.host}${fence.database ? `/${fence.database}` : ""}` : "not set"
    }`,
  );
  for (const key of ["APP_DATABASE_URL", "DATABASE_URL"]) {
    const target = env[key] ? parseDatabaseTarget(env[key]) : null;
    console.log(`  ${key}: ${env[key] ? (target ? describeTarget(target) : "UNPARSEABLE") : "not set"}`);
  }
  console.log("");

  const problems = checkEnvironment(env);
  if (problems.length === 0) {
    console.log("✓ The declared environment and the connected database agree.\n");
    return 0;
  }

  for (const p of problems) {
    const mark = p.severity === "fatal" ? "✗" : "!";
    console.error(`  ${mark} ${p.key}: ${p.message}`);
    if (p.fix) console.error(`      fix: ${p.fix}`);
  }
  console.error("");

  const fatals = problems.filter((p) => p.severity === "fatal");
  if (fatals.length > 0) {
    console.error(
      `✗ ${fatals.length} fatal environment problem(s). Refusing to continue — a deployment ` +
        "that does not know which database it is talking to must not be built or migrated.\n",
    );
    return 1;
  }
  console.warn("! Environment warnings only; continuing.\n");
  return 0;
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  // Convenience for a laptop, and nothing more: on Vercel and in GitHub Actions
  // there is no .env and the real values are already in process.env. dotenv
  // never overwrites an existing variable, so loading it cannot mask the
  // deployed configuration with a developer's.
  const envFile = resolve(ROOT, ".env");
  if (existsSync(envFile)) {
    try {
      const { config } = await import("dotenv");
      config({ path: envFile });
    } catch {
      // Not installed — this file deliberately runs before `npm ci`.
    }
  }
  process.exit(report(process.env));
}
