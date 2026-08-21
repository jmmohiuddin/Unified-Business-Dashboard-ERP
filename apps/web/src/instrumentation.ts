import type { ErrorReport, SecurityEvent } from "@nexus/core";

/** The core barrel, as imported at boot. */
type Core = typeof import("@nexus/core");

/**
 * BOOT-TIME SECURITY GATE AND OBSERVABILITY WIRING.
 *
 * `assertConfiguration` has existed since the security batch and its docblock
 * claims "the app refuses to start". It did not: nothing ever called it. The
 * validator was exported from the core barrel and then never wired to anything,
 * so for the whole life of the project the fail-closed guarantee was a comment.
 * This file is what makes the claim true.
 *
 * The same was true of the two observability hooks. `setErrorSink` was called
 * only from its own unit test and `setAlertSink` was never called at all, so
 * `ALERTABLE` — the list that exists to take a lockout or a cross-tenant
 * attempt "straight to a pager" — could never fire. Every production 500 ended
 * at `console.error`, which on Vercel is ephemeral with no drain. Three
 * carefully-written modules were a no-op for want of four lines here.
 *
 * So `register()` now does three things, in an order that matters:
 *
 *   1. Validate the environment      — because step 2 reads values it validates.
 *   2. Install the sinks             — because step 3 needs to be able to alert.
 *   3. Prove RLS cannot be bypassed  — the one check that talks to the database.
 *
 * Next calls `register()` exactly once per server instance, before the first
 * request is served — which is the only place a boot gate can live in an App
 * Router app.
 *
 * Node runtime only. The checks read `process.env`, open a database connection
 * and throw; the edge runtime neither has the full environment nor should take
 * a hard dependency on the domain package.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const core = await import("@nexus/core");

  // Throws in production, prints loudly in development — a fresh clone must
  // still run. See packages/core/src/security/config.ts for the severity rules.
  core.assertConfiguration(process.env);

  installSinks(core.setErrorSink, core.setAlertSink);

  await assertRlsCannotBeBypassed(core);
}

const isProduction = process.env.NODE_ENV === "production";

/** How long a sink POST may take before it is abandoned. */
const SINK_TIMEOUT_MS = 2_000;

/** How long the RLS probe may take before the result is treated as unknown. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Non-secret deployment identity, stamped onto everything the sinks send.
 *
 * An alert that says "a tenant tried to read another tenant" is only actionable
 * if you know which deploy and which region produced it.
 *
 * A fixed allow-list of three keys, never a spread of `process.env`. The whole
 * point of the redaction in `reporting.ts` and `events.ts` is that nothing
 * secret reaches a sink; enriching the payload from the environment at the last
 * step would walk straight around it.
 */
const deployment = {
  env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
  region: process.env.VERCEL_REGION ?? "local",
  commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
};

/**
 * Wire the error reporter and the security alert stream.
 *
 * Deliberately not a vendor SDK. Both sinks do the same two things in the same
 * order, and the order is the whole design:
 *
 *   • **stdout first, always.** One JSON object per line, in the exact shape
 *     the defaults already emitted — a Vercel log drain (or CloudWatch, or
 *     Loki) ingests it with no account, no agent and no dependency, and
 *     installing a sink does not change the format an existing drain query is
 *     already matching on. This is the durable path.
 *   • **webhook second, best-effort.** `ERROR_SINK_URL` and `ALERT_SINK_URL`
 *     are optional. The POST is never awaited and its failure is never
 *     propagated, so a provider outage cannot slow or break a request. That is
 *     only safe *because* the durable write already happened.
 *
 * Redaction is not this adapter's job and must not become it: `reportError` and
 * `securityEvent` scrub their payloads before either sink is called, which is
 * why an Emirates ID, an IBAN, an argon2 hash or a connection string cannot
 * reach a network here. See `reporting.test.ts` for the assertions that hold
 * that line. This code adds nothing to the payload except `deployment` above.
 */
function installSinks(
  setErrorSink: (sink: ((r: ErrorReport) => void) | null) => void,
  setAlertSink: (sink: ((e: SecurityEvent) => void) | null) => void,
): void {
  setErrorSink((report) => {
    // Same line shape as reporting.ts's built-in default, so a drain filter
    // written against `type=error` keeps working now that a sink exists.
    console.error(JSON.stringify({ type: "error", ...report, deployment }));
    post(process.env.ERROR_SINK_URL, { type: "error", ...report, deployment });
  });

  setAlertSink((event) => {
    // securityEvent has already written the `log=security` line to stdout by
    // the time it calls us, so this half is the pager and nothing else.
    post(process.env.ALERT_SINK_URL, { type: "alert", ...event, deployment });
  });
}

/**
 * True once a sink POST has failed, so the failure is reported exactly once.
 *
 * Not silence — a webhook that has never worked must be discoverable — but not
 * a line per request either. During a provider outage every request would fail
 * the same way, and flooding stdout with delivery errors would bury the reports
 * on the log path that is still working.
 */
let sinkFailureReported = false;

/**
 * Fire-and-forget POST.
 *
 * Never throws, never awaits, never calls `reportError`. That last one is not
 * fastidiousness: `reportError` invokes the error sink, which calls this
 * function, so reporting a delivery failure through the reporter is an
 * unbounded loop that starts exactly when the system is already in trouble.
 */
function post(url: string | undefined, body: unknown): void {
  if (!url) return;
  try {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Without this a wedged endpoint holds the serverless function open until
      // the platform kills it, turning an alerting failure into a billed hang.
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
      keepalive: true,
    }).catch(reportSinkFailureOnce);
  } catch {
    // JSON.stringify on a circular payload, or fetch rejecting synchronously.
    reportSinkFailureOnce();
  }
}

function reportSinkFailureOnce(): void {
  if (sinkFailureReported) return;
  sinkFailureReported = true;
  // console, not reportError — see post().
  console.error(
    JSON.stringify({
      type: "sink_failure",
      message:
        "A configured observability webhook rejected a delivery. Reports are still " +
        "being written to stdout. This is logged once per instance.",
      deployment,
    }),
  );
}

// A type alias, not an interface: drizzle's `execute<T>` constrains T to
// Record<string, unknown>, and only aliases get the implicit index signature.
type RlsProbeRow = {
  role: string;
  bypasses: boolean | null;
  is_super: boolean | null;
};

/**
 * OPS-07 §1.4: refuse to start if the connected role can bypass row-level
 * security.
 *
 * The configuration gate compares APP_DATABASE_URL against DATABASE_URL, which
 * catches the operator who pasted the same connection string twice. It cannot
 * catch the operator who pointed APP_DATABASE_URL at a *different* role that
 * also happens to be privileged — and on Neon that is the likely mistake,
 * because `nexus_app` is created by the runtime `db:rls` path and is not part
 * of the committed migration chain, so a fresh Neon branch has the policies but
 * not the role. Only the database can answer the question that matters.
 *
 * Two attributes, because they are two different mechanisms and each alone is
 * insufficient:
 *
 *   • `rolbypassrls` is the attribute RLS itself checks.
 *   • `rolsuper` short-circuits that check before it is reached, so a
 *     superuser reads back `rolbypassrls = false` while still ignoring every
 *     policy. The local owner role is exactly this shape.
 *
 * And note what does *not* help: `FORCE ROW LEVEL SECURITY` (sql/rls.ts) closes
 * the table-*owner* case only. It has no effect on a role holding the BYPASSRLS
 * attribute. Those are separate mechanisms and only the latter is in play here.
 *
 * Runs on the **app** pool — `withoutTenant` uses `appDb()`. Probing the admin
 * pool would prove nothing, since the owner is supposed to be privileged.
 *
 * ── Which way it fails ──────────────────────────────────────────────────────
 *
 * A definite YES is fatal in production: the answer is unambiguous, tenant
 * isolation is not being enforced, and no amount of retrying changes it.
 *
 * An INDETERMINATE result — unreachable database, timeout, `pg_roles` not
 * readable, no row for `current_user` — deliberately does **not** stop the
 * boot, in either environment. Whether a role can bypass RLS is a static
 * property: a boot that could not read it will get the same answer, and refuse,
 * on the next attempt. Crashing instead would convert a transient network blip
 * into a total outage that repeats on every serverless cold start — a strictly
 * worse failure than the one being guarded, and one an attacker could trigger
 * deliberately. So it fails open on *unknown* and closed on *known-bad*.
 *
 * What it must never do is pass quietly. An indeterminate result emits a
 * `config.problem` event at `critical`, which `securityEvent` routes to the
 * alert sink installed immediately above — so an unverifiable control pages
 * someone instead of scrolling past.
 */
async function assertRlsCannotBeBypassed(core: Core): Promise<void> {
  // The build machine's environment is not the environment that will serve
  // traffic, so a probe here would certify the wrong database — or none.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  let row: RlsProbeRow | undefined;
  try {
    const [{ withoutTenant }, { sql }] = await Promise.all([
      import("@nexus/db"),
      import("drizzle-orm"),
    ]);

    const query = withoutTenant((db) =>
      db.execute<RlsProbeRow>(sql`
        SELECT current_user AS role,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses,
               (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_super
      `),
    );

    const rows = await Promise.race([
      query,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rls probe timed out")), PROBE_TIMEOUT_MS).unref?.(),
      ),
    ]);
    row = rows[0];
  } catch (err) {
    return indeterminate(core, describeError(err));
  }

  if (!row || row.bypasses === null || row.is_super === null) {
    return indeterminate(core, "pg_roles returned no row for current_user");
  }

  if (!row.bypasses && !row.is_super) return; // The healthy path.

  const why = [row.bypasses && "BYPASSRLS", row.is_super && "SUPERUSER"]
    .filter(Boolean)
    .join(" and ");
  const message =
    `APP_DATABASE_URL connects as "${row.role}", which has ${why}. Every RLS policy ` +
    `is a no-op for this role, so tenant isolation — the primary control in the threat ` +
    `model — is not being enforced. Note that FORCE ROW LEVEL SECURITY does not help: ` +
    `it covers the table owner, not the BYPASSRLS attribute.`;

  // The offending attributes go in one string *value*, not in the key names.
  // The redactor's SENSITIVE_KEYS pattern matches /pass/i, so a field called
  // `bypasses` comes out "[redacted]" — technically correct, useless in an
  // alert. Values are not key-matched, so "BYPASSRLS" survives intact.
  core.security.configProblem({
    detail: { check: "rls_bypass", role: row.role, attributes: why },
  });

  if (isProduction) {
    throw new Error(`Refusing to start — ${message}`);
  }
  // Development keeps running, for the same reason assertConfiguration does: a
  // fresh clone that has not run `npm run db:rls` yet has no nexus_app role and
  // falls back to the owner. The warning is what tells them to.
  console.warn(`\n[security] ${message}\n      fix: npm run db:rls\n`);
}

/**
 * Flatten an error and its causes into one diagnosable line.
 *
 * Drizzle wraps the driver error, and its own message is the failing SQL — so
 * `err.message` alone reports the statement we already know and hides the part
 * that matters ("ECONNREFUSED", "permission denied for view pg_roles"). Walk
 * the cause chain and keep the `code`, capping each link so one verbose layer
 * cannot push the others out of the truncated event.
 */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    const tag = typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
    parts.push(`${e.name}${tag}: ${e.message}`.slice(0, 140));
    e = e.cause;
  }
  return parts.length ? parts.join(" <- ") : String(err);
}

/**
 * The probe could not answer. Say so loudly and carry on.
 *
 * The reason is a raw driver message, so it goes through `scrubMessage` first:
 * a postgres connection failure quotes the connection string, password and all,
 * and this string is about to be posted to a webhook. `redact` would not help —
 * it matches object keys, not secrets embedded in free text. Newlines are
 * collapsed too, because the driver includes the whole failing statement.
 */
function indeterminate(core: Core, reason: string): void {
  const safe = core.scrubMessage(reason.replace(/\s+/g, " ")).slice(0, 300);
  core.security.configProblem({
    detail: { check: "rls_bypass", result: "indeterminate", reason: safe },
  });
  console.error(
    `[security] could not verify that the app role cannot bypass RLS: ${safe}. ` +
      `Continuing — see instrumentation.ts for why this fails open on unknown.`,
  );
}
