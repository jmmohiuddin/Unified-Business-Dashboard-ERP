/**
 * Outbox dispatcher CLI.
 *
 *   npm run outbox              # dry run — shows what would be sent
 *   npm run outbox -- --commit
 *
 * Dry run is the default because this is the process that talks to customers.
 * A misconfigured environment must not be able to message real people; the
 * failure mode of "it accidentally sent" is far worse than "it accidentally
 * didn't".
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { consoleProvider, dispatchOutbox, inQuietHours } from "./outbox.ts";

config({ path: "../../.env" });
config({ path: ".env" });

const commit = process.argv.includes("--commit");
const now = process.env.NEXUS_DEMO_NOW ? new Date(process.env.NEXUS_DEMO_NOW) : new Date();

async function main() {
  const [tenant] = await adminDb().execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM tenants LIMIT 1`,
  );
  if (!tenant) throw new Error("No tenant found — run `npm run db:seed` first.");

  const quiet = inQuietHours(now);
  console.log(
    `\nOutbox for ${tenant.name} · ${now.toISOString()} · ` +
      `${commit ? "COMMIT" : "DRY RUN"}${quiet ? " · QUIET HOURS (21:00–08:00 GST)" : ""}\n`,
  );

  const summary = await withTenant({ tenantId: tenant.id }, (tx) =>
    dispatchOutbox(tx, { commit, provider: consoleProvider, now }),
  );

  const icon: Record<string, string> = {
    sent: "→", "would send": "→", suppressed: "⊘", deferred: "⏸",
  };
  for (const d of summary.detail.slice(0, 25)) {
    console.log(
      `${icon[d.outcome] ?? "✗"} ${d.title}` + (d.reason ? `  — ${d.reason}` : ""),
    );
  }
  if (summary.detail.length > 25) {
    console.log(`  … and ${summary.detail.length - 25} more`);
  }

  console.log(
    `\n${summary.considered} considered · ${summary.sent} ${commit ? "sent" : "would send"} · ` +
      `${summary.suppressed} suppressed · ${summary.deferred} deferred · ${summary.failed} failed`,
  );
  if (!commit) console.log("Re-run with --commit to actually deliver.\n");
  else console.log("");

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
