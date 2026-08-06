/**
 * Create (or recreate) the local database and roles.
 *
 * Works against a locally installed PostgreSQL or the bundled docker-compose
 * stack — whichever DATABASE_URL points at. Pass `--drop` to wipe first.
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env" });
config({ path: ".env.example" });

const url = new URL(process.env.DATABASE_URL ?? "postgresql://nexus:nexus@127.0.0.1:5432/nexus");
const dbName = url.pathname.slice(1);
const owner = decodeURIComponent(url.username);
const ownerPw = decodeURIComponent(url.password);
const drop = process.argv.includes("--drop");

// Connect to the maintenance database to create the target one.
const adminUrl = new URL(url.toString());
adminUrl.pathname = "/postgres";

async function tryConnect(u) {
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await sql`SELECT 1`;
  return sql;
}

async function main() {
  let sql;
  try {
    sql = await tryConnect(adminUrl);
  } catch {
    // First run: the owner role may not exist yet. Fall back to the OS user,
    // which is how Homebrew and most local installs are set up.
    const fallback = new URL(adminUrl.toString());
    fallback.username = process.env.USER ?? "postgres";
    fallback.password = "";
    sql = await tryConnect(fallback);
  }

  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
        CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPw}' CREATEDB CREATEROLE;
      END IF;
    END $$;
  `);

  if (drop) {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    console.log(`· Dropped database ${dbName}`);
  }

  const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (!exists) {
    await sql.unsafe(`CREATE DATABASE ${dbName} OWNER ${owner}`);
    console.log(`· Created database ${dbName}`);
  } else {
    console.log(`· Database ${dbName} already exists`);
  }

  if (drop) {
    // The schema is recreated from scratch so `db:push` never has to guess
    // whether a changed column is a rename or a new column.
    const target = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await target.unsafe(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`);
    await target.unsafe(`GRANT ALL ON SCHEMA public TO ${owner};`);
    await target.end();
    console.log("· Reset public schema");
  }

  await sql.end();
  console.log(`✓ Ready: ${url.protocol}//${owner}@${url.host}/${dbName}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
