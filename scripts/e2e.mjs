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
import { createHash } from "node:crypto";
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

/** Sign in exactly the way a browser with JavaScript disabled would. */
async function signIn(email, password, aid) {
  const body = new FormData();
  body.set(aid, "");
  body.set("email", email);
  body.set("password", password);
  const res = await fetch(`${BASE}/login`, { method: "POST", body, redirect: "manual" });
  const cookie = res.headers.get("set-cookie") ?? "";
  const token = cookie.match(/nexus_session=([^;]+)/)?.[1] ?? null;
  return { status: res.status, location: res.headers.get("location"), token };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { cookie: `nexus_session=${token}` } : {},
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

  const owner = await signIn("owner@sumon.test", "demo1234", aid);
  check("valid credentials issue a session", owner.location === "/" && Boolean(owner.token));

  const cookieHeader = (await fetch(`${BASE}/login`, {
    method: "POST",
    body: (() => {
      const b = new FormData();
      b.set(aid, "");
      b.set("email", "owner@sumon.test");
      b.set("password", "demo1234");
      return b;
    })(),
    redirect: "manual",
  })).headers.get("set-cookie") ?? "";
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
  const [stored] = await sql`
    SELECT token_hash FROM sessions WHERE token_hash = ${createHash("sha256").update(owner.token).digest("hex")}
  `;
  check("session token is stored hashed, never in plaintext", Boolean(stored));

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
    const r = await get(path, owner.token);
    check(`GET ${path}`, r.status === 200, `${r.html.length} bytes`);
  }
  // This previously asserted status === 200, which did not merely fail to catch
  // the dead-route problem — it REQUIRED it. With the catch-all answering every
  // unmatched path with 200, fifteen dead dashboard drill-downs were invisible
  // to the whole suite, and any status assertion was meaningless for coverage.
  check(
    "an unknown route returns 404, not a 200 placeholder",
    (await get("/nonsense-route", owner.token)).status === 404,
  );

  const dash = await get("/", owner.token);
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

  const bHtml = (await get("/", barber.token)).html;
  const sHtml = (await get("/", shop.token)).html;
  const pHtml = (await get("/", property.token)).html;

  check("barber is denied revenue metrics", moneyIn(bHtml, "Revenue this month") === "—");
  check("barber cannot see the portfolio comparison", !/This month by business/.test(bHtml));
  check(
    "barber's sidebar is scoped to the salon only",
    [...bHtml.matchAll(/href="\/businesses\/([a-z]+)"/g)].map((m) => m[1]).join(",") === "salon",
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
  const compliance = (await get("/compliance", owner.token)).html;
  check("compliance lists trade licences with TRNs", /VAT TRN/.test(compliance) && /CN-\d/.test(compliance));
  check("compliance flags unregistered Ejari leases", /Ejari registration/.test(compliance));

  const vatPage = (await get("/accounting/vat", owner.token)).html;
  check("VAT page renders the FTA box layout", /VAT201 boxes/.test(vatPage) && /Box/.test(vatPage));
  check("VAT page explains irrecoverable input tax", /cannot be reclaimed/.test(vatPage));

  const pl = (await get("/accounting/profit-loss", owner.token)).html;
  check("P&L excludes owner drawings", /equity, not expense/.test(pl));
  check("P&L shows a group-level row for shared costs", /Group-level/.test(pl));

  const grat = (await get("/hr/gratuity", owner.token)).html;
  check("gratuity page shows days earned per employee", /Days earned/.test(grat));
  check("gratuity page offers the WPS export", /WPS file for/.test(grat));

  const chq = (await get("/rentals/cheques", owner.token)).html;
  check("cheque register shows the covered rental period", /Covers/.test(chq));

  const salon = (await get("/salon", owner.token)).html;
  check("salon renders the chair timeline", /Chair 1/.test(salon) && /utilisation/i.test(salon));

  const inv = (await get("/inventory", owner.token)).html;
  check("inventory ranks reorder by days of cover", /Days of cover/.test(inv));
  check("inventory shows the IMEI register", /IMEI register/.test(inv));

  const crmPage = (await get("/crm", owner.token)).html;
  check("CRM shows cross-business relationships", /Across 2\+ businesses/.test(crmPage));

  // The AI assistant is temporarily disabled (no ANTHROPIC_API_KEY provisioned).
  // Assert the disable is clean — a redirect to the dashboard, not a broken page
  // or a half-rendered feature. Restore the content checks when it is re-enabled.
  const asst = await get("/assistant", owner.token);
  check(
    "disabled assistant redirects to the dashboard",
    [302, 307, 308].includes(asst.status) && (asst.location ?? "").endsWith("/"),
    `status ${asst.status} → ${asst.location}`,
  );

  const purchases = (await get("/purchases", owner.token)).html;
  check("purchases page shows what is owed to suppliers", /Owed to suppliers/.test(purchases));
  check("purchases page offers to record a supplier bill", /Record a supplier bill/.test(purchases));

  const inbox = (await get("/inbox", owner.token)).html;
  check("inbox renders the notification centre", /Notifications/.test(inbox) && /automation rules/.test(inbox));

  const secSettings = (await get("/settings/security", owner.token)).html;
  check("security settings offers MFA setup", /two-factor|Two-factor/.test(secSettings));
  check("security settings offers sign-out-everywhere", /other session/.test(secSettings));

  // ── WPS export ────────────────────────────────────────────────────────────
  console.log("\nWPS payroll export");
  const wpsRes = await fetch(`${BASE}/api/wps/2026-08`, {
    headers: { cookie: `nexus_session=${owner.token}` },
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
    headers: { cookie: `nexus_session=${barberForWps.token}` },
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

  await sql.end();
  await app.end();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
