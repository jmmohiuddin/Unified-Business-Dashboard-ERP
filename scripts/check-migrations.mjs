/**
 * MIGRATION DRIFT GUARD.
 *
 *   npm run check:migrations
 *
 * Fails if the Drizzle schema has changed without a committed migration.
 *
 * Schema used to deploy with `drizzle-kit push --force`: it diffed the live
 * database against TypeScript and applied the DDL directly, with `--force`
 * suppressing the destructive-change prompt. No reviewable artefact, no down
 * path, no record of what version any environment was on — for a system whose
 * whole purpose is holding financial records. There were zero .sql files in the
 * repository and the configured output directory did not exist.
 *
 * This runs `drizzle-kit generate` and fails if it produced anything new. The
 * generator is deterministic against the committed snapshot, so a clean tree
 * means the migrations describe the schema exactly.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const DIR = "packages/db/drizzle";
const sqlFiles = () => readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const before = sqlFiles();

try {
  execFileSync("npm", ["run", "generate", "-w", "@nexus/db"], { stdio: "pipe", encoding: "utf8" });
} catch (err) {
  console.error("✗ drizzle-kit generate failed:\n", String(err.stdout ?? err.message));
  process.exit(1);
}

const after = sqlFiles();
const added = after.filter((f) => !before.includes(f));

if (added.length > 0) {
  console.error(
    `\n✗ The schema has changed without a committed migration.\n\n` +
      `  Generated: ${added.join(", ")}\n\n` +
      `  Run \`npm run db:generate\`, review the SQL, and commit it with your\n` +
      `  schema change. Reviewing the DDL is the point — an ORM diff applied\n` +
      `  straight to a production database is how data goes missing.\n`,
  );
  process.exit(1);
}

console.log(`✓ Migrations are in sync with the schema (${after.length} committed).`);
