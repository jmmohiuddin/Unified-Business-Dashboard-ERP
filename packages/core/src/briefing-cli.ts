/**
 * Daily briefing job.
 *
 *   npm run briefing            # compose and print, no writes
 *   npm run briefing -- --commit
 *
 * In production this runs on a 06:00 cron per tenant. Dry-run prints the
 * briefing; --commit persists it as an insight the owner sees on the dashboard.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { composeBriefing, persistBriefing } from "./briefing.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const commit = process.argv.includes("--commit");
const today = process.env.NEXUS_DEMO_TODAY || "2026-08-06";

async function main() {
  const [tenant] = await adminDb().execute<{ id: string; base_currency: string; timezone: string; name: string }>(
    sql`SELECT id, base_currency, timezone, name FROM tenants LIMIT 1`,
  );
  if (!tenant) throw new Error("Seed the database first.");

  const briefing = await withTenant({ tenantId: tenant.id }, async (tx) => {
    const b = await composeBriefing({
      tx, tenantId: tenant.id, today,
      baseCurrency: tenant.base_currency, allowedBusinessUnitIds: null,
    });
    if (commit) await persistBriefing(tx, tenant.id, today, b);
    return b;
  });

  console.log(`\n${briefing.headline}\n${"─".repeat(briefing.headline.length)}`);
  for (const line of briefing.lines) console.log(`  • ${line}`);
  console.log(`\nseverity: ${briefing.severity} · ${briefing.metrics.length} metrics cited`);
  console.log(commit ? "Saved to the insights feed.\n" : "Dry run — re-run with --commit to save.\n");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
