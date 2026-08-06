/**
 * Automation runner CLI.
 *
 *   npm run automations           # dry run — shows what WOULD happen
 *   npm run automations -- --commit
 *
 * Dry run is the default and that is not a convenience. This process can
 * generate customer-facing messages; the safe default has to be "show me first".
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { runAutomations } from "./runner.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const commit = process.argv.includes("--commit");
const today = process.env.NEXUS_DEMO_TODAY || "2026-08-06";

async function main() {
  const [tenant] = await adminDb().execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM tenants LIMIT 1`,
  );
  if (!tenant) throw new Error("No tenant found — run `npm run db:seed` first.");

  console.log(
    `\nAutomations for ${tenant.name} · ${today} · ${commit ? "COMMIT" : "DRY RUN"}\n`,
  );

  const outcomes = await withTenant({ tenantId: tenant.id }, (tx) =>
    runAutomations(tx, tenant.id, { commit, today }),
  );

  let totalMatched = 0;
  let totalCreated = 0;

  for (const o of outcomes) {
    totalMatched += o.matched;
    totalCreated += o.created;

    const status = o.error
      ? "✗"
      : o.heldForApproval
        ? "⏸"
        : o.matched === 0
          ? "·"
          : "✓";
    console.log(`${status} ${o.name}`);

    if (o.error) {
      console.log(`    ${o.error}`);
      continue;
    }
    if (o.heldForApproval) {
      console.log(`    ${o.matched} matched — held for approval, nothing sent`);
      continue;
    }
    if (o.matched === 0) {
      console.log(`    nothing matched`);
      continue;
    }

    console.log(
      `    ${o.matched} matched` +
        (commit ? `, ${o.created} created, ${o.skippedDuplicate} already sent` : " (dry run)") +
        (o.cappedAt ? `  ⚠ CAPPED at ${o.cappedAt}` : ""),
    );
    for (const s of o.samples) {
      console.log(`      • ${s.title}`);
    }
    if (o.matched > o.samples.length) {
      console.log(`      … and ${o.matched - o.samples.length} more`);
    }
  }

  console.log(
    `\n${outcomes.length} rules · ${totalMatched} matches · ` +
      (commit ? `${totalCreated} notifications created` : "no writes (dry run)"),
  );
  if (!commit) console.log(`Re-run with --commit to actually create notifications.\n`);
  else console.log("");

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
