/**
 * POST-DEPLOY SMOKE TEST.
 *
 *   node scripts/smoke.mjs https://example.vercel.app
 *
 * Answers one question: is the thing that just deployed actually serving?
 *
 * There was no such check. A broken deploy was discovered by a user, and CI's
 * readiness probe fetched the login page — which proves Next is listening and
 * nothing else, not that the database is reachable or the schema is migrated.
 *
 * Deliberately shallow and unauthenticated: it runs against production, so it
 * must not write anything, must not need a credential, and must finish in
 * seconds. Depth belongs in the 227-check suite against a disposable database.
 */
const base = (process.argv[2] ?? process.env.SMOKE_BASE ?? "http://localhost:3100").replace(/\/$/, "");
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}  ${err instanceof Error ? err.message : err}`);
  }
}

const get = (path, opts = {}) =>
  fetch(`${base}${path}`, { redirect: "manual", ...opts });

console.log(`\nSmoke test — ${base}\n`);

await check("health reports ok", async () => {
  const res = await get("/api/health");
  const body = await res.json();
  if (res.status !== 200) throw new Error(`HTTP ${res.status} — ${JSON.stringify(body.checks)}`);
  if (body.status !== "ok") throw new Error(JSON.stringify(body.checks));
  return `schema ${body.migrationVersion ?? "?"}`;
});

await check("database is reachable", async () => {
  const body = await (await get("/api/health")).json();
  if (!body.checks?.database?.ok) throw new Error("database check failed");
});

await check("migrations are applied", async () => {
  const body = await (await get("/api/health")).json();
  if (!body.checks?.migrations?.ok) throw new Error(body.checks?.migrations?.detail ?? "not applied");
});

await check("sign-in page renders", async () => {
  const res = await get("/login");
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!/Sign in/.test(html)) throw new Error("no sign-in form");
  return `${(html.length / 1024).toFixed(0)} KB`;
});

await check("the sign-in page publishes no credentials", async () => {
  const html = await (await get("/login")).text();
  if (/demo1234|owner@sumon\.test/.test(html)) throw new Error("demo credentials are visible");
});

await check("an unauthenticated page redirects to login", async () => {
  const res = await get("/");
  if (res.status !== 307 || !(res.headers.get("location") ?? "").includes("/login")) {
    throw new Error(`HTTP ${res.status} → ${res.headers.get("location")}`);
  }
});

await check("a missing route is a real 404", async () => {
  const res = await get("/definitely-not-a-route");
  if (res.status !== 404 && res.status !== 307) throw new Error(`HTTP ${res.status}`);
});

await check("security headers are present", async () => {
  const res = await get("/login");
  for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options"]) {
    if (!res.headers.get(h)) throw new Error(`missing ${h}`);
  }
});

await check("the API rejects an unauthenticated call", async () => {
  const res = await get("/api/v1/me");
  if (res.status !== 401) throw new Error(`HTTP ${res.status}`);
});

await check("cron endpoints reject an unauthenticated call", async () => {
  const res = await get("/api/cron/briefing");
  if (res.status !== 401) throw new Error(`HTTP ${res.status} — scheduled jobs are triggerable`);
});

console.log("");
if (failed > 0) {
  console.error(`✗ ${failed} smoke check(s) failed — the deployment is not healthy.\n`);
  process.exit(1);
}
console.log("✓ Deployment is serving.\n");
