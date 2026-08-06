import { config } from "dotenv";
import postgres from "postgres";
import { buildRlsStatements, TENANT_SCOPED_TABLES, VERIFY_RLS_SQL } from "./sql/rls.ts";

config({ path: "../../.env" });
config({ path: "../../.env.example" });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  console.log(`Securing ${TENANT_SCOPED_TABLES.length} tenant-scoped tables…`);

  const appRole = process.env.APP_ROLE ?? "nexus_app";
  const appPassword = process.env.APP_ROLE_PASSWORD ?? appRole;
  const statements = buildRlsStatements(appRole, appPassword);
  let applied = 0;
  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt);
      applied++;
    } catch (err) {
      console.error(`\n✗ Failed statement:\n${stmt.trim().slice(0, 200)}`);
      throw err;
    }
  }
  console.log(`  ${applied} statements applied.`);

  // Fail loudly rather than shipping a table without isolation.
  const unprotected = await sql.unsafe(VERIFY_RLS_SQL);
  if (unprotected.length > 0) {
    console.error("\n✗ Tables with tenant_id but no enforced RLS policy:");
    for (const row of unprotected) console.error(`   - ${row.table_name}`);
    process.exit(1);
  }

  console.log("✓ RLS verified: every tenant-scoped table has FORCEd isolation.");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
