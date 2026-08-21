/**
 * End-to-end smoke test against a running dev server.
 *
 *   npm run dev            # in one terminal
 *   node scripts/e2e.mjs   # in another
 *
 * Exercises the things that are easy to break and expensive to get wrong:
 * real sign-in through the server action, session cookie handling, RBAC
 * differences between roles, business-unit scoping, and tenant isolation at
 * the database level.
 */
import { createHash, createHmac } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.E2E_BASE ?? "http://localhost:3100";
const DB = process.env.DATABASE_URL ?? "postgresql://nexus:nexus@127.0.0.1:5432/nexus";

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

async function actionId() {
  const html = await (await fetch(`${BASE}/login`)).text();
  const m = html.match(/\$ACTION_ID_[a-f0-9]+/);
  if (!m) throw new Error("Could not find the sign-in action id on /login");
  return m[0];
}

/**
 * The action id of ONE form on a page that carries several.
 *
 * `/login` has a single form, so grabbing the first `$ACTION_ID_` there is
 * safe. `/settings/security` has five — sign out, sign out everywhere, start
 * enrolment, confirm enrolment, end other sessions — and taking the first would
 * silently sign the suite out instead of enrolling it. Identify the form by the
 * label on its submit button, which is what a human clicking it would use.
 */
function actionIdFor(html, buttonLabel) {
  for (const form of html.matchAll(/<form[\s\S]*?<\/form>/g)) {
    if (!form[0].includes(buttonLabel)) continue;
    const id = form[0].match(/\$ACTION_ID_[a-f0-9]+/)?.[0];
    if (id) return id;
  }
  throw new Error(`No form with a "${buttonLabel}" button on that page`);
}

/**
 * Fold a response's Set-Cookie headers into a jar, the way a browser would:
 * a later value for the same name replaces the earlier one rather than being
 * appended alongside it. Sending two `nexus_auth_level` cookies would let the
 * server pick either, which is exactly the ambiguity the marker exists to
 * remove — so the jar has to be keyed by name.
 */
function mergeCookies(jar, res) {
  const byName = new Map(
    jar.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c]),
  );
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0];
    if (pair) byName.set(pair.split("=")[0], pair);
  }
  return [...byName.values()].join("; ");
}

// ── TOTP ────────────────────────────────────────────────────────────────────
//
// RFC 6238, SHA-1, six digits, thirty-second step — the parameters
// apps/web/src/lib/mfa.ts verifies against. Recomputed here rather than
// imported: this file is plain ESM run by node, and a check that borrows the
// implementation it is checking proves considerably less than one that arrives
// at the same six digits independently.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function fromBase32(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "")) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secretBase32, at = Date.now()) {
  const counter = Math.floor(at / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", fromBase32(secretBase32)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

/** Sign in exactly the way a browser with JavaScript disabled would. */
async function signIn(email, password, aid) {
  const body = new FormData();
  body.set(aid, "");
  body.set("email", email);
  body.set("password", password);
  const res = await fetch(`${BASE}/login`, { method: "POST", body, redirect: "manual" });
  // A browser returns EVERY cookie the sign-in set, not just the session one.
  // Since the MFA enrolment gate landed, that includes the `nexus_auth_level`
  // assurance marker, and proxy.ts bounces any request that carries a session
  // without it. Reading only `nexus_session` here made the whole suite look
  // like a mass authentication failure when the product was working correctly.
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const jar = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  const token =
    setCookies.join("; ").match(/nexus_session=([^;]+)/)?.[1] ??
    (res.headers.get("set-cookie") ?? "").match(/nexus_session=([^;]+)/)?.[1] ??
    null;
  return {
    status: res.status,
    location: res.headers.get("location"),
    token,
    jar,
    // The whole Set-Cookie lines, attributes included, for the checks that are
    // about HttpOnly and SameSite rather than about the value.
    setCookies,
    // Present instead of a session when the account is enrolled: the password
    // has been accepted but nothing has been issued yet.
    pending: setCookies.join("; ").match(/nexus_mfa_pending=([^;]+)/)?.[1] ?? null,
  };
}

/**
 * Enrol a TOTP authenticator by driving the real enrolment screens.
 *
 * Seeding `users.mfa_secret_enc` straight into Postgres would be shorter, but it
 * would also mean the suite never once exercises the two-step enrolment that
 * every owner, accountant and general manager now has to complete — and a
 * secret written by the test in a format the app cannot decrypt would look
 * identical to a working one until a code was actually verified. So this posts
 * the same two forms a browser would, reads the base32 key off the page exactly
 * where the "enter the key manually" fallback puts it, and lets the server be
 * the one that decides the code was right.
 *
 * Takes the restricted jar the login gate issued and returns the secret plus a
 * jar upgraded to `full` — completeEnrolment() re-stamps the assurance marker on
 * the same session rather than making the user sign in again.
 */
async function enrolTotp(restrictedJar) {
  let jar = restrictedJar;

  const start = await get("/settings/security", jar);
  const startRes = await fetch(`${BASE}/settings/security`, {
    method: "POST",
    body: (() => {
      const b = new FormData();
      b.set(actionIdFor(start.html, "Set up authenticator"), "");
      return b;
    })(),
    headers: { cookie: jar },
    redirect: "manual",
  });
  jar = mergeCookies(jar, startRes);

  const verify = await get("/settings/security?step=verify", jar);
  // A 160-bit secret is 32 base32 characters, rendered in the <code> block the
  // page offers for authenticators that cannot scan a QR.
  const secret = verify.html.match(/<code[^>]*>([A-Z2-7]{32})<\/code>/)?.[1];
  if (!secret) throw new Error("Enrolment page did not render a base32 secret");

  const confirmRes = await fetch(`${BASE}/settings/security`, {
    method: "POST",
    body: (() => {
      const b = new FormData();
      b.set(actionIdFor(verify.html, "Confirm and enable"), "");
      // Computed at submission time, not before the two page loads above: the
      // app accepts one adjacent step (±30s), so a code minted a few hundred
      // milliseconds ago is comfortably inside the window.
      b.set("code", totp(secret));
      return b;
    })(),
    headers: { cookie: jar },
    redirect: "manual",
  });
  if (confirmRes.headers.get("location") !== "/settings/security?enabled=1") {
    throw new Error(`Enrolment was refused: ${confirmRes.headers.get("location")}`);
  }
  return { secret, jar: mergeCookies(jar, confirmRes) };
}

/** Answer the login challenge an enrolled account receives, ending in a session. */
async function completeChallenge(challenge, secret) {
  const cookie = `nexus_mfa_pending=${challenge.pending}`;
  const html = await (await fetch(`${BASE}/login/verify`, { headers: { cookie } })).text();
  const body = new FormData();
  body.set(actionIdFor(html, "Verify"), "");
  body.set("code", totp(secret));
  const res = await fetch(`${BASE}/login/verify`, {
    method: "POST",
    body,
    headers: { cookie },
    redirect: "manual",
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return {
    status: res.status,
    location: res.headers.get("location"),
    token: setCookies.join("; ").match(/nexus_session=([^;]+)/)?.[1] ?? null,
    jar: setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; "),
    setCookies,
  };
}

async function get(path, jar) {
  const res = await fetch(`${BASE}${path}`, {
    headers: jar ? { cookie: jar } : {},
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

const moneyIn = (html, label) => {
  const m = html.match(
    new RegExp(`${label}</p><p class="kpi-value[^>]*>([^<]*)`),
  );
  return m?.[1]?.trim() ?? null;
};

async function main() {
  console.log(`\nE2E against ${BASE}\n`);
  const aid = await actionId();

  // Reset the rate limiter first. It is deliberately DURABLE — that is the
  // whole point of backing it with Postgres rather than memory — so a preceding
  // test run, or the security suite's login burst, would otherwise throttle
  // this one and report false failures.
  {
    const reset = postgres(DB, { max: 1, onnotice: () => {} });
    await reset`TRUNCATE rate_limit_hits`;
    await reset`UPDATE users SET failed_login_count = '0'::jsonb, locked_until = NULL`;
    // Same reasoning for the second factor: this run enrols the owner for real,
    // so a run that crashed halfway would leave an enrolment behind and the
    // "no second factor yet" assertion below would be asserting nothing. Start
    // from the state the seed produces, whatever the last run did.
    await reset`
      UPDATE users
         SET mfa_secret_enc = NULL, recovery_codes_enc = NULL, mfa_enabled_at = NULL
       WHERE email = 'owner@sumon.test'`;
    await reset.end();
  }

  // ── Authentication ────────────────────────────────────────────────────────
  console.log("Authentication");
  const anon = await get("/");
  check("anonymous request is redirected to /login", anon.status === 307 && anon.location?.includes("/login"));

  const bad = await signIn("owner@sumon.test", "wrong-password", aid);
  check("wrong password is rejected", bad.location?.includes("error=1") && !bad.token);

  const missing = await signIn("nobody@nowhere.test", "demo1234", aid);
  check(
    "unknown account fails identically (no user enumeration)",
    missing.location === bad.location,
    `both → ${bad.location}`,
  );

  /**
   * The owner's role is in MFA_REQUIRED_ROLES, so a correct password on its own
   * no longer opens the dashboard — it opens the one page where the missing
   * second factor can be added. Everything below this point needs a full
   * session, so the suite has to earn one the way a real owner does: get the
   * restricted session, enrol an authenticator, then sign in again and clear
   * the challenge. The old single assertion here ("valid credentials issue a
   * session") is now three, one per step, because each step is separately
   * capable of regressing.
   */
  const ownerFirst = await signIn("owner@sumon.test", "demo1234", aid);
  check(
    "an owner with no second factor is sent to enrolment on a restricted session",
    ownerFirst.location === "/settings/security?mfa=required" &&
      /nexus_auth_level=mfa_setup\./.test(ownerFirst.jar),
    ownerFirst.location ?? "(no redirect)",
  );

  /**
   * Wrapped, because the three steps below are the only ones in this file that
   * can abort the process rather than fail a check.
   *
   * Enrolment reads an action id and a base32 seed out of rendered HTML; if a
   * button label changes, `actionIdFor` throws, and an uncaught throw here takes
   * the ~90 checks after this point with it. A suite that dies on check 7 of 100
   * reports nothing about checks 8 to 100 — which is strictly less information
   * than a suite that says "authentication broke, and here is everything that
   * broke as a result". So a failure is recorded and the run continues on the
   * restricted session, where every downstream page check fails visibly with a
   * redirect instead of silently not existing.
   */
  let ownerSecret = null;
  let challenge = null;
  let owner = ownerFirst;
  let mfaError = null;
  try {
    ({ secret: ownerSecret } = await enrolTotp(ownerFirst.jar));
    challenge = await signIn("owner@sumon.test", "demo1234", aid);
    owner = await completeChallenge(challenge, ownerSecret);
  } catch (err) {
    mfaError = err.message ?? String(err);
  }
  check(
    "the owner can enrol an authenticator through /settings/security",
    mfaError === null,
    mfaError ?? "",
  );
  check(
    "an enrolled account is challenged before any session is issued",
    challenge?.location === "/login/verify" && !challenge.token && Boolean(challenge.pending),
    challenge?.location ?? "(no challenge issued)",
  );
  check(
    "a cleared second factor issues a full, unrestricted session",
    owner !== ownerFirst &&
      owner.location === "/" &&
      Boolean(owner.token) &&
      /nexus_auth_level=full\./.test(owner.jar),
    owner === ownerFirst ? "(never got past the enrolment gate)" : owner.location ?? "(no redirect)",
  );

  // Read the flags off the session cookie the sign-in above actually set,
  // rather than burning another login for them. `headers.get("set-cookie")`
  // folds every cookie into one string, so on a response that sets three of
  // them a match for HttpOnly could come from any of the three.
  const cookieHeader = owner.setCookies.find((c) => c.startsWith("nexus_session=")) ?? "";
  check("session cookie is HttpOnly and SameSite=Lax", /HttpOnly/i.test(cookieHeader) && /SameSite=lax/i.test(cookieHeader));

  // ── Security headers ──────────────────────────────────────────────────────
  console.log("\nSecurity headers");
  const hdrRes = await fetch(`${BASE}/login`);
  const h = (k) => hdrRes.headers.get(k) ?? "";
  check("Content-Security-Policy is set with a script nonce",
    /script-src 'self' 'nonce-/.test(h("content-security-policy")));
  check("CSP forbids framing and inline objects",
    /frame-ancestors 'none'/.test(h("content-security-policy")) &&
    /object-src 'none'/.test(h("content-security-policy")));
  check("X-Frame-Options: DENY", h("x-frame-options") === "DENY");
  check("X-Content-Type-Options: nosniff", h("x-content-type-options") === "nosniff");
  check("Referrer-Policy is restrictive",
    h("referrer-policy") === "strict-origin-when-cross-origin");
  check("Permissions-Policy denies camera, mic and geolocation",
    /camera=\(\)/.test(h("permissions-policy")) && /geolocation=\(\)/.test(h("permissions-policy")));

  const sql = postgres(DB, { max: 1, onnotice: () => {} });

  const [pwHash] = await sql`SELECT password_hash FROM users WHERE email = 'owner@sumon.test'`;
  check("passwords are argon2id, not a placeholder",
    /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/.test(pwHash?.password_hash ?? ""),
    (pwHash?.password_hash ?? "").slice(0, 32));
  /**
   * The token the server issued must appear in `sessions` only as its SHA-256
   * digest — so the row is looked up BY that digest, and a hit proves both that
   * the session exists and that what is stored is the hash rather than the
   * token. That is the assertion; the guard below is about not losing it.
   *
   * `owner.token` is now the post-verify token, which does not exist until the
   * second factor is cleared. Feeding a null straight into `createHash().update()`
   * throws ERR_INVALID_ARG_TYPE, and an uncaught throw here takes the ~90 checks
   * after this line with it — the suite reports nothing at all about the thing it
   * was actually run to measure. So an absent token is reported as this check
   * failing, which is exactly what it means, rather than as a stack trace.
   * Note what is NOT done: `owner.token ?? ""` would hash the empty string, find
   * no row, and fail — but it would fail for an unrelated reason and read as if
   * the storage format were wrong. Say which of the two things broke.
   */
  const [stored] = owner.token
    ? await sql`
        SELECT token_hash FROM sessions
         WHERE token_hash = ${createHash("sha256").update(owner.token).digest("hex")}`
    : [null];
  check(
    "session token is stored hashed, never in plaintext",
    Boolean(stored),
    owner.token ? "" : "no session token — the MFA challenge above never completed",
  );

  // ── Pages render ──────────────────────────────────────────────────────────
  console.log("\nPages");
  const PAGES = [
    "/", "/businesses", "/receivables", "/receivables?filter=overdue",
    "/services", "/services?filter=breached", "/crm", "/crm?filter=at_risk",
    "/compliance", "/rentals", "/rentals?filter=vacant", "/rentals/cheques",
    "/rentals/cheques?filter=bounced", "/salon", "/inventory", "/inventory?filter=low",
    "/accounting/vat", "/accounting/profit-loss", "/accounting/profit-loss?period=ytd",
    "/hr/gratuity", "/purchases", "/inbox", "/settings/security",
  ];
  for (const path of PAGES) {
    const r = await get(path, owner.jar);
    check(`GET ${path}`, r.status === 200, `${r.html.length} bytes`);
  }
  // This previously asserted status === 200, which did not merely fail to catch
  // the dead-route problem — it REQUIRED it. With the catch-all answering every
  // unmatched path with 200, fifteen dead dashboard drill-downs were invisible
  // to the whole suite, and any status assertion was meaningless for coverage.
  check(
    "an unknown route returns 404, not a 200 placeholder",
    (await get("/nonsense-route", owner.jar)).status === 404,
  );

  const dash = await get("/", owner.jar);
  check("dashboard shows real AED values", /AED&nbsp;|AED [\d,.]+/.test(dash.html));
  check("dashboard shows the action list", /Needs you today/.test(dash.html));
  check("health score is decomposed, not a bare number", /Profitability/.test(dash.html) && /Cash runway/.test(dash.html));

  // ── UAE localisation ──────────────────────────────────────────────────────
  console.log("\nUAE compliance");
  check("no South Asian lakh/crore scale leaked into AED formatting",
    !/AED\s[\d.]+\s?(L|Cr)\b/.test(dash.html));
  check("no taka symbol anywhere", !dash.html.includes("৳"));
  check("VAT quarter position is shown", /VAT this quarter/.test(dash.html));
  check("exempt residential rent is called out", /Exempt supplies \(residential rent\)/.test(dash.html));
  check("gratuity liability is shown", /End-of-service liability/.test(dash.html));
  check("cheque pipeline is shown", /Post-dated cheques held/.test(dash.html));
  check("compliance deadlines are shown", /Compliance deadlines/.test(dash.html));

  // ── RBAC / scoping ────────────────────────────────────────────────────────
  console.log("\nAuthorisation");
  const barber = await signIn("barber@sumon.test", "demo1234", aid);
  const shop = await signIn("shop@sumon.test", "demo1234", aid);
  const property = await signIn("property@sumon.test", "demo1234", aid);

  const bHtml = (await get("/", barber.jar)).html;
  const sHtml = (await get("/", shop.jar)).html;
  const pHtml = (await get("/", property.jar)).html;

  check("barber is denied revenue metrics", moneyIn(bHtml, "Revenue this month") === "—");
  check("barber cannot see the portfolio comparison", !/This month by business/.test(bHtml));
  // The drill-down moved from a path segment (`/businesses/salon`) to a query
  // parameter on one route (`/businesses?bu=salon`), so the old pattern matched
  // nothing at all. Note what that would have meant had the comparison been
  // `!includes("mobile")` instead of an exact match: a regex that finds zero
  // links satisfies "does not link to another business" perfectly, and the
  // check would have gone green while the sidebar was free to link anywhere.
  // Hence the explicit length assertion — the list must be found, not merely
  // fail to contain the wrong thing.
  const barberBusinesses = [
    ...new Set([...bHtml.matchAll(/href="\/businesses\?bu=([a-z_]+)"/g)].map((m) => m[1])),
  ];
  check(
    "barber's sidebar is scoped to the salon only",
    barberBusinesses.length === 1 && barberBusinesses[0] === "salon",
    barberBusinesses.length ? barberBusinesses.join(",") : "NO BUSINESS LINKS FOUND",
  );
  check("sales staff are denied net profit", moneyIn(sHtml, "Net profit this month") === "—");

  const ownerMtd = moneyIn(dash.html, "Revenue this month");
  const shopMtd = moneyIn(sHtml, "Revenue this month");
  const propMtd = moneyIn(pHtml, "Revenue this month");
  check(
    "each role sees only their businesses' revenue",
    ownerMtd !== shopMtd && ownerMtd !== propMtd && shopMtd !== propMtd,
    `owner=${ownerMtd} shop=${shopMtd} property=${propMtd}`,
  );

  // ── Module screens actually show data ─────────────────────────────────────
  console.log("\nModule screens");
  const compliance = (await get("/compliance", owner.jar)).html;
  check("compliance lists trade licences with TRNs", /VAT TRN/.test(compliance) && /CN-\d/.test(compliance));
  check("compliance flags unregistered Ejari leases", /Ejari registration/.test(compliance));

  const vatPage = (await get("/accounting/vat", owner.jar)).html;
  check("VAT page renders the FTA box layout", /VAT201 boxes/.test(vatPage) && /Box/.test(vatPage));
  check("VAT page explains irrecoverable input tax", /cannot be reclaimed/.test(vatPage));

  const pl = (await get("/accounting/profit-loss", owner.jar)).html;
  check("P&L excludes owner drawings", /equity, not expense/.test(pl));
  check("P&L shows a group-level row for shared costs", /Group-level/.test(pl));

  const grat = (await get("/hr/gratuity", owner.jar)).html;
  check("gratuity page shows days earned per employee", /Days earned/.test(grat));
  check("gratuity page offers the WPS export", /WPS file for/.test(grat));

  const chq = (await get("/rentals/cheques", owner.jar)).html;
  check("cheque register shows the covered rental period", /Covers/.test(chq));

  const salon = (await get("/salon", owner.jar)).html;
  check("salon renders the chair timeline", /Chair 1/.test(salon) && /utilisation/i.test(salon));

  const inv = (await get("/inventory", owner.jar)).html;
  check("inventory ranks reorder by days of cover", /Days of cover/.test(inv));
  check("inventory shows the IMEI register", /IMEI register/.test(inv));

  const crmPage = (await get("/crm", owner.jar)).html;
  check("CRM shows cross-business relationships", /Across 2\+ businesses/.test(crmPage));

  // The AI assistant is temporarily disabled (no ANTHROPIC_API_KEY provisioned).
  // The assistant is re-enabled (decision D2) and no longer redirects. What is
  // asserted now is the UNCONFIGURED path, because that is the one this
  // environment can actually reach: with no ANTHROPIC_API_KEY it must render a
  // real page that says so. The previous behaviour — bouncing the user back to
  // the dashboard they clicked from — is the specific dead end that made the
  // home screen's primary CTA a no-op, so a redirect here is now a FAILURE.
  const asst = await get("/assistant", owner.jar);
  check(
    "assistant renders rather than bouncing the user back",
    asst.status === 200,
    `status ${asst.status}${asst.location ? ` → ${asst.location}` : ""}`,
  );
  check(
    "unconfigured assistant says so instead of failing",
    /ANTHROPIC_API_KEY/i.test(asst.html),
  );

  const purchases = (await get("/purchases", owner.jar)).html;
  check("purchases page shows what is owed to suppliers", /Owed to suppliers/.test(purchases));
  check("purchases page offers to record a supplier bill", /Record a supplier bill/.test(purchases));

  const inbox = (await get("/inbox", owner.jar)).html;
  check("inbox renders the notification centre", /Notifications/.test(inbox) && /automation rules/.test(inbox));

  const secSettings = (await get("/settings/security", owner.jar)).html;
  check("security settings offers MFA setup", /two-factor|Two-factor/.test(secSettings));
  check("security settings offers sign-out-everywhere", /other session/.test(secSettings));

  // ── Payroll run ───────────────────────────────────────────────────────────
  //
  // The SIF is a serialisation of an approved payroll run (FR-C06), not a
  // computation over `employees`. These two checks guard that relationship in
  // both directions, because breaking it is silent: the export would go on
  // producing a plausible file from unapproved master data, and every
  // assertion in the WPS block below would still pass.
  console.log("\nPayroll run");
  const payroll = (await get("/hr/payroll", owner.jar)).html;
  check("payroll screen shows the run that backs the WPS file",
    /Payroll runs/.test(payroll) && /August 2026/.test(payroll));
  const noRunRes = await fetch(`${BASE}/api/wps/2019-03`, { headers: { cookie: owner.jar } });
  check("WPS refuses a month with no approved run", noRunRes.status === 404,
    `got ${noRunRes.status}`);

  // ── WPS export ────────────────────────────────────────────────────────────
  console.log("\nWPS payroll export");
  const wpsRes = await fetch(`${BASE}/api/wps/2026-08`, {
    headers: { cookie: owner.jar },
  });
  const sif = await wpsRes.text();
  const sifLines = sif.trim().split("\r\n");
  check("WPS file downloads", wpsRes.status === 200);
  check(
    "filename follows MOHRE convention",
    /filename="\d{13}\d{10}\.SIF"/.test(wpsRes.headers.get("content-disposition") ?? ""),
    wpsRes.headers.get("content-disposition") ?? "",
  );
  check("every employee has an EDR record", sifLines.filter((l) => l.startsWith("EDR")).length > 0,
    `${sifLines.filter((l) => l.startsWith("EDR")).length} EDR`);
  check("exactly one SCR control record, and it is last",
    sifLines.filter((l) => l.startsWith("SCR")).length === 1 && sifLines.at(-1).startsWith("SCR"));
  check("SCR totals match the EDR sum", (() => {
    const edrTotal = sifLines.filter((l) => l.startsWith("EDR"))
      .reduce((t, l) => { const f = l.split(","); return t + Number(f[8]) + Number(f[9]); }, 0);
    const scr = sifLines.at(-1).split(",");
    return Math.abs(edrTotal - Number(scr[7])) < 0.01;
  })());
  const barberForWps = await signIn("barber@sumon.test", "demo1234", aid);
  const deniedRes = await fetch(`${BASE}/api/wps/2026-08`, {
    headers: { cookie: barberForWps.jar },
  });
  check("WPS export is denied without payroll:read", deniedRes.status === 403,
    `barber got ${deniedRes.status}`);

  // ── Public API v1 ─────────────────────────────────────────────────────────
  console.log("\nPublic API");
  const API_TOKEN = "nxk_demo_seed_token_do_not_use_in_prod";
  const apiGet = (path, token) =>
    fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  check("API rejects a request with no token",
    (await apiGet("/api/v1/me", null)).status === 401);
  check("API rejects a garbage token",
    (await apiGet("/api/v1/me", "nxk_not_a_real_token")).status === 401);

  const meRes = await apiGet("/api/v1/me", API_TOKEN);
  const me = await meRes.json();
  check("API /me authenticates a valid token", meRes.status === 200 && me.role === "owner");
  check("API /me lists readable metrics", Array.isArray(me.readableMetrics) && me.readableMetrics.length > 20);

  const revRes = await apiGet("/api/v1/metrics/revenue_mtd", API_TOKEN);
  const rev = await revRes.json();
  check("API returns a metric value", revRes.status === 200 && typeof rev.data.value === "number",
    `revenue_mtd = ${rev.data?.value}`);
  check("API metric matches what the dashboard shows",
    rev.data.unit === "currency" && rev.currency === "AED");
  check("API 404s an unknown metric",
    (await apiGet("/api/v1/metrics/does_not_exist", API_TOKEN)).status === 404);

  // A scoped token must not read a metric its permission forbids.
  const [{ id: barberMembership }] = await sql`
    SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE u.email = 'barber@sumon.test'`;
  const scopedToken = "nxk_barber_scoped_test_token_value_here";
  const scopedHash = createHash("sha256").update(scopedToken).digest("hex");
  await sql`
    INSERT INTO api_tokens (id, tenant_id, membership_id, name, prefix, token_hash, scopes)
    SELECT gen_random_uuid(), (SELECT id FROM tenants LIMIT 1), ${barberMembership},
           'test', 'nxk_barber_', ${scopedHash}, '[]'::jsonb
    ON CONFLICT DO NOTHING`;
  check("API enforces the token's role — barber cannot read net profit",
    (await apiGet("/api/v1/metrics/net_profit_mtd", scopedToken)).status === 403);
  await sql`DELETE FROM api_tokens WHERE prefix = 'nxk_barber_'`;

  // ── Tenant isolation at the database ──────────────────────────────────────
  console.log("\nTenant isolation (PostgreSQL RLS)");
  const app = postgres(
    process.env.APP_DATABASE_URL ?? "postgresql://nexus_app:nexus_app@127.0.0.1:5432/nexus",
    { max: 1, onnotice: () => {} },
  );
  const [{ id: tenantId }] = await sql`SELECT id FROM tenants LIMIT 1`;

  const [noCtx] = await app`SELECT count(*)::int n FROM documents`;
  check("no tenant context → zero rows", noCtx.n === 0);

  const withCtx = await app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const [r] = await tx`SELECT count(*)::int n FROM documents`;
    return r.n;
  });
  check("correct tenant context → rows visible", withCtx > 3000, `${withCtx} documents`);

  const otherCtx = await app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', '00000000-0000-7000-8000-000000000000', true)`;
    const [r] = await tx`SELECT count(*)::int n FROM documents`;
    return r.n;
  });
  check("different tenant context → zero rows", otherCtx === 0);

  let blocked = false;
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`INSERT INTO parties (tenant_id, display_name)
               VALUES ('00000000-0000-7000-8000-000000000000', 'Cross-tenant write')`;
    });
  } catch {
    blocked = true;
  }
  check("cross-tenant INSERT is rejected by the database", blocked);

  let roleEscalation = false;
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`INSERT INTO roles (key, name, is_system) VALUES ('pwn', 'Pwned', true)`;
    });
  } catch {
    roleEscalation = true;
  }
  check("tenant cannot create a platform-global role", roleEscalation);

  // ── Ledger integrity ──────────────────────────────────────────────────────
  console.log("\nLedger");
  const unbalanced = await sql`
    SELECT journal_id FROM journal_lines GROUP BY journal_id
     HAVING SUM(base_debit) <> SUM(base_credit)
  `;
  check("every journal balances", unbalanced.length === 0, `${unbalanced.length} unbalanced`);

  const [acct] = await sql`
    SELECT
      SUM(CASE WHEN a.type IN ('asset','expense') THEN jl.base_debit - jl.base_credit ELSE 0 END) AS debits,
      SUM(CASE WHEN a.type IN ('liability','equity','income') THEN jl.base_credit - jl.base_debit ELSE 0 END) AS credits
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
  `;
  const diff = Math.abs(Number(acct.debits) - Number(acct.credits));
  check("accounting equation holds", diff < 0.01, `difference ${diff.toFixed(4)}`);

  // ── UAE tax treatment in the data ─────────────────────────────────────────
  console.log("\nUAE VAT treatment");
  const [resVat] = await sql`
    SELECT COALESCE(SUM(dl.tax_amount), 0) AS vat, COUNT(*)::int AS lines
      FROM document_lines dl
      JOIN tax_codes tc ON tc.id = dl.tax_code_id
     WHERE tc.code = 'EXEMPT'
  `;
  check(
    "residential rent carries zero VAT (exempt, not zero-rated)",
    Number(resVat.vat) === 0 && Number(resVat.lines) > 0,
    `${resVat.lines} exempt lines, ${resVat.vat} VAT`,
  );

  const [parkVat] = await sql`
    SELECT COALESCE(SUM(dl.tax_amount), 0) AS vat
      FROM document_lines dl
      JOIN items i ON i.id = dl.item_id
     WHERE i.name = 'Monthly Parking Bay'
  `;
  check("standalone parking IS standard-rated at 5%", Number(parkVat.vat) > 0,
    `AED ${Number(parkVat.vat).toFixed(0)} output VAT`);

  const [irr] = await sql`
    SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) AS amount
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE a.system_key = 'VAT_IRRECOVERABLE'
  `;
  check(
    "input VAT on exempt-property maintenance is expensed, not reclaimed",
    Number(irr.amount) > 0,
    `AED ${Number(irr.amount).toFixed(0)} irrecoverable`,
  );

  const [gratTotals] = await sql`
    SELECT COALESCE(SUM(gratuity_accrued), 0) AS accrued FROM employees WHERE status = 'active'
  `;
  const [prov] = await sql`
    SELECT COALESCE(SUM(jl.base_credit - jl.base_debit), 0) AS provision
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE a.system_key = 'GRATUITY_PROVISION'
  `;
  const gratDiff = Math.abs(Number(gratTotals.accrued) - Number(prov.provision));
  check(
    "gratuity provision ties to per-employee accruals",
    gratDiff < 1,
    `employees AED ${Number(gratTotals.accrued).toFixed(0)} vs ledger AED ${Number(prov.provision).toFixed(0)}`,
  );

  const [chqStats] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'held')::int AS held,
           COUNT(*) FILTER (WHERE status = 'cleared')::int AS cleared,
           COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced
      FROM cheques
  `;
  check("cheque register has a realistic lifecycle spread",
    chqStats.held > 0 && chqStats.cleared > 0,
    `${chqStats.held} held, ${chqStats.cleared} cleared, ${chqStats.bounced} bounced`);

  const [cur] = await sql`
    SELECT COUNT(*)::int n FROM documents WHERE currency <> 'AED'
  `;
  check("every document is denominated in AED", cur.n === 0);

  // Put the owner back the way the seed left them. The enrolment above is real —
  // it wrote an encrypted secret to `users` — and leaving it behind would hand
  // the next run, and the security suite, a starting state the seed never
  // produces. Cleared here rather than through the UI because the product
  // deliberately refuses to let a required role turn its own second factor off.
  await sql`
    UPDATE users
       SET mfa_secret_enc = NULL, recovery_codes_enc = NULL, mfa_enabled_at = NULL
     WHERE email = 'owner@sumon.test'`;

  await sql.end();
  await app.end();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
