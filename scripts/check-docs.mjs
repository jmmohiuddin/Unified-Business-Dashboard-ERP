/**
 * DOC GUARD.
 *
 *   npm run check:docs
 *
 * The README claimed 94 tables when there were 95, and claimed "no dead ends"
 * when fifteen drill-downs were dead. Documentation drifts silently because
 * nothing compiles it. This asserts the counts that are cheap to check.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: ".env" });

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const [{ n }] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`;
await sql.end();

const readme = readFileSync("README.md", "utf8");
const claimed = /\*\*(\d+) tables\*\*/.exec(readme)?.[1];

if (!claimed) {
  console.error("✗ README no longer states a table count — update this check or the README.");
  process.exit(1);
}
if (Number(claimed) !== n) {
  console.error(`✗ README claims ${claimed} tables; the database has ${n}.`);
  process.exit(1);
}
console.log(`✓ README table count matches the database (${n}).`);
