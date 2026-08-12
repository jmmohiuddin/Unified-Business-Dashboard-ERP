/**
 * ROUTE GUARD.
 *
 *   npm run check:routes
 *
 * Every metric that declares a `drilldownHref` must point at a route that
 * exists.
 *
 * This closes a defect the 227-check suite was structurally unable to see.
 * Fifteen of twenty-one drill-down targets had no route — four of them on the
 * main dashboard, including `overdue_debt` and `revenue_today`, the two figures
 * the owner opens the app to check. The suite could not catch it for two
 * reasons: it never followed a drill-down, and the `[...slug]` catch-all
 * answered every unmatched path with HTTP 200, so even a status assertion would
 * have passed. Both are fixed; this keeps them fixed.
 *
 * Static analysis on purpose — no server, no database, runs in milliseconds, so
 * it can gate every pull request.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const METRICS_DIR = "packages/core/src/metrics";
const APP_DIR = "apps/web/src/app/(app)";

/** Routes the app actually serves, as hrefs. */
function routes(dir, prefix = "") {
  const found = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Route groups like (app) do not appear in the URL.
      const segment = entry.name.startsWith("(") ? "" : `/${entry.name}`;
      for (const r of routes(join(dir, entry.name), prefix + segment)) found.add(r);
    } else if (entry.name === "page.tsx") {
      found.add(prefix === "" ? "/" : prefix);
    }
  }
  return found;
}

const live = routes(APP_DIR);

/** Every declared drilldown target, with the metric that declares it. */
const declared = [];
for (const file of readdirSync(METRICS_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(METRICS_DIR, file), "utf8");
  // Track the nearest preceding metric id so a failure names the culprit.
  let id = "(unknown)";
  for (const line of src.split("\n")) {
    const m = /id: *"([a-z0-9_]+)"/.exec(line);
    if (m) id = m[1];
    const h = /drilldownHref: *"([^"]+)"/.exec(line);
    if (h) declared.push({ id, href: h[1], file });
  }
}

const dead = declared.filter(({ href }) => {
  // A dynamic segment cannot be checked statically; the path prefix can.
  const path = href.split("?")[0];
  return !live.has(path);
});

if (dead.length > 0) {
  console.error(`\n✗ ${dead.length} metric drill-down(s) point at a route that does not exist:\n`);
  for (const d of dead) console.error(`  ✗ ${d.id.padEnd(28)} → ${d.href}   (${d.file})`);
  console.error(
    `\n  Add the route, or repoint the metric at the screen that already serves it.\n` +
      `  Live routes: ${[...live].sort().join(", ")}\n`,
  );
  process.exit(1);
}

console.log(`✓ All ${declared.length} metric drill-downs resolve to real routes.`);
