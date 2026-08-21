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
import { adminDb, withTenant, type Tx } from "@nexus/db";
import { assessErasure, erasePartyPii } from "@nexus/core/security";
import type { Principal } from "@nexus/core";

config({ path: ".env" });

const partyId = process.argv[2];
if (!partyId) {
  console.error("Usage: npx tsx scripts/erase-party.ts <partyId>");
  process.exit(1);
}

/**
 * Resolve the acting user's REAL membership, role and permissions.
 *
 * `erasePartyPii` now takes the actor from `ctx.principal` and checks
 * `party:delete` rather than accepting a caller-supplied `{ userId, roleKey }`
 * it trusted blindly. That hardening is only worth anything if the context
 * handed to it is genuine: synthesising a principal with a full permission set
 * here would satisfy the check while proving nothing, and would put a fabricated
 * actor into the erasure audit row — the one record that has to survive to show
 * who destroyed the data and under what authority.
 *
 * So the operator named in ERASURE_ACTOR must actually hold the permission.
 */
async function resolvePrincipal(tx: Tx, tenantId: string, email: string): Promise<Principal> {
  const [row] = await tx.execute<{
    user_id: string; membership_id: string; scope: string;
    role_key: string; role_level: string;
  }>(sql`
    SELECT u.id AS user_id, m.id AS membership_id, m.scope::text AS scope,
           r.key AS role_key, r.level::text AS role_level
      FROM users u
      JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
      JOIN roles r ON r.id = m.role_id
     WHERE u.email = ${email} AND m.tenant_id = ${tenantId}::uuid
     LIMIT 1
  `);
  if (!row) throw new Error(`No active membership for "${email}" in this tenant.`);

  const scopes = await tx.execute<{ business_unit_id: string | null; location_id: string | null }>(
    sql`SELECT business_unit_id, location_id FROM membership_scopes
         WHERE membership_id = ${row.membership_id}::uuid`,
  );
  const perms = await tx.execute<{ key: string }>(sql`
    SELECT p.key FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.key = ${row.role_key}
  `);

  return {
    userId: row.user_id,
    tenantId,
    membershipId: row.membership_id,
    roleKey: row.role_key,
    roleLevel: Number(row.role_level),
    scope: row.scope as Principal["scope"],
    businessUnitIds:
      row.scope === "tenant"
        ? null
        : (scopes.map((s) => s.business_unit_id).filter(Boolean) as string[]),
    locationIds: scopes.map((s) => s.location_id).filter(Boolean) as string[],
    permissions: new Set(perms.map((p) => p.key)),
    isPlatformAdmin: false,
  };
}

async function main() {
  const db = adminDb();
  const [tenant] = await db.execute<{ id: string; base_currency: string }>(
    sql`SELECT id, base_currency FROM tenants LIMIT 1`,
  );
  if (!tenant) throw new Error("Seed the database first.");
  const actorEmail = process.env.ERASURE_ACTOR ?? "owner@sumon.test";

  await withTenant({ tenantId: tenant.id }, async (tx) => {
    const principal = await resolvePrincipal(tx, tenant.id, actorEmail);
    const ctx = {
      tx,
      tenantId: tenant.id,
      principal,
      today: new Date().toISOString().slice(0, 10),
      baseCurrency: tenant.base_currency ?? "AED",
    };

    const assessment = await assessErasure(ctx, partyId!);
    if (!assessment.canErase) {
      console.error(`Cannot erase:\n  ${assessment.blockers.join("\n  ")}`);
      process.exit(1);
    }
    const result = await erasePartyPii(ctx, partyId!, "subject request (CLI)");
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
