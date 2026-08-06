/**
 * Execute a right-to-erasure request.
 *
 *   npx tsx scripts/erase-party.ts <partyId>
 *
 * A CLI rather than a button, deliberately. Erasure is irreversible and
 * statutorily consequential; it should require someone to open a terminal and
 * name the record, not a mis-click on a list screen. The UI surfaces the
 * *assessment* — what would be erased and what must be retained — and this
 * performs it.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { adminDb, withTenant } from "@nexus/db";
import { assessErasure, erasePartyPii } from "@nexus/core/security";

config({ path: ".env" });

const partyId = process.argv[2];
if (!partyId) {
  console.error("Usage: npx tsx scripts/erase-party.ts <partyId>");
  process.exit(1);
}

async function main() {
  const db = adminDb();
  const [tenant] = await db.execute<{ id: string }>(sql`SELECT id FROM tenants LIMIT 1`);
  const [actor] = await db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = 'owner@sumon.test'`,
  );
  if (!tenant || !actor) throw new Error("Seed the database first.");

  await withTenant({ tenantId: tenant.id, userId: actor.id }, async (tx) => {
    const assessment = await assessErasure(tx, partyId!);
    if (!assessment.canErase) {
      console.error(`Cannot erase:\n  ${assessment.blockers.join("\n  ")}`);
      process.exit(1);
    }
    const result = await erasePartyPii(
      tx,
      tenant.id,
      partyId!,
      { userId: actor.id, roleKey: "owner" },
      "subject request (CLI)",
    );
    console.log(
      `Erased ${result.partyId} → "${result.pseudonym}"; ` +
        `${result.documentsRetained} invoice(s) retained, ` +
        `${result.interactionsRedacted} interaction(s) redacted.`,
    );
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
