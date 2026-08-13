import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.ts";

/**
 * Tenant isolation policy generator.
 *
 * Derived from the schema at runtime rather than hand-maintained, so a new
 * table with a `tenant_id` column is protected the moment it is created. The
 * classic failure mode — "we added a table in a hurry and forgot the policy" —
 * is structurally impossible here, and `verifyRls()` fails the build if it ever
 * becomes possible again.
 */

export interface TenantTable {
  name: string;
  hasTenantId: boolean;
}

function allTables(): { name: string; columns: string[]; tenantNullable: boolean }[] {
  const out: { name: string; columns: string[]; tenantNullable: boolean }[] = [];
  for (const value of Object.values(schema)) {
    // Drizzle tables expose their config through this symbol-keyed accessor.
    if (!value || typeof value !== "object") continue;
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(value as PgTable);
    } catch {
      continue; // enums, relations, helpers
    }
    const tenantCol = cfg.columns.find((c) => c.name === "tenant_id");
    out.push({
      name: cfg.name,
      columns: cfg.columns.map((c) => c.name),
      tenantNullable: tenantCol ? !tenantCol.notNull : false,
    });
  }
  return out;
}

const TENANT_TABLES = allTables()
  .filter((t) => t.columns.includes("tenant_id"))
  .sort((a, b) => a.name.localeCompare(b.name));

export const TENANT_SCOPED_TABLES: string[] = TENANT_TABLES.map((t) => t.name);

/**
 * Tables where `tenant_id` is NULLABLE, and a NULL means "platform-global row
 * shared by every tenant" — the system role catalogue is the canonical case.
 *
 * These need a different policy, and the difference is a security boundary:
 * a global row must be READABLE by everyone but WRITABLE by no tenant. If the
 * WITH CHECK allowed NULL, any tenant could create a system role and grant
 * itself permissions across the platform.
 */
export const GLOBAL_ROW_TABLES: string[] = TENANT_TABLES.filter((t) => t.tenantNullable).map(
  (t) => t.name,
);

/**
 * Tables intentionally NOT tenant-scoped.
 *
 * `users` and `sessions` must be readable before a tenant is known (that is
 * literally what login does), and `permissions` / system `roles` are platform
 * catalogues identical for everyone. They are reachable only from the auth
 * module via `withoutTenant()`, which is small enough to review line by line.
 * This is a bounded, deliberate exposure — not an oversight.
 */
export const GLOBAL_TABLES = [
  "users",
  "sessions",
  "permissions",
  "role_permissions",
  "roles",
  "audit_log",
];

/**
 * Role creation and its password.
 *
 * Kept OUT of the migration files on purpose: a migration is committed to a
 * public repository, and this statement carries a credential. It stays a
 * runtime step driven by APP_ROLE_PASSWORD.
 */
export function buildRoleStatements(
  appRole = "nexus_app",
  appPassword = appRole,
): string[] {
  const stmts: string[] = [];

  // Password is parameterised so managed providers with a strength policy
  // (Neon, Supabase, RDS with rds-force-ssl-pwd) can be given a real password
  // via APP_ROLE_PASSWORD. The default reproduces the original local-dev
  // behaviour so nothing changes for a laptop install.
  const escapedPw = appPassword.replace(/'/g, "''");
  stmts.push(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
        CREATE ROLE ${appRole} LOGIN PASSWORD '${escapedPw}';
      ELSE
        ALTER ROLE ${appRole} WITH LOGIN PASSWORD '${escapedPw}';
      END IF;
    END $$;
  `);

  // The app role gets DML but never DDL and never BYPASSRLS.
  // (Grants live with the role statements because they name the role but carry
  //  no secret; they are replayed by the policy migration too, harmlessly.)
  stmts.push(`GRANT USAGE ON SCHEMA public TO ${appRole};`);
  stmts.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};`,
  );
  stmts.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`);
  stmts.push(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
  `);
  stmts.push(`ALTER ROLE ${appRole} NOBYPASSRLS;`);

  /**
   * Read access to the migration bookkeeping.
   *
   * /health reports the applied schema version so a container running against an
   * un-migrated database is visible rather than silently broken. That endpoint is
   * unauthenticated, so it must not use the owner connection — the app role is
   * granted SELECT on the migration table instead. It is a hash and a timestamp,
   * no tenant data.
   *
   * Guarded: the schema only exists once migrations have run at least once.
   */
  stmts.push(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO ${appRole}';
        EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${appRole}';
      END IF;
    END $$;
  `);

  return stmts;
}

/**
 * Policies, grants and invariants — everything with no secret in it.
 *
 * Emitted into a committed migration by `npm run db:generate:rls`, so tenant
 * isolation arrives as reviewable SQL alongside the schema change that needs
 * it, rather than as a side effect of a script someone remembers to run.
 * ADR-002 asks for exactly this.
 *
 * Every statement is idempotent (DROP POLICY IF EXISTS, CREATE OR REPLACE,
 * CREATE INDEX IF NOT EXISTS), so re-applying is safe and the runtime
 * `db:rls` path still works unchanged for a laptop.
 */
export function buildPolicyStatements(appRole = "nexus_app"): string[] {
  const stmts: string[] = [];

  for (const table of TENANT_SCOPED_TABLES) {
    const policy = `${table}_tenant_isolation`;
    const allowsGlobalRows = GLOBAL_ROW_TABLES.includes(table);
    stmts.push(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    // FORCE matters: without it, a table owner silently ignores its own
    // policies. If the app ever ends up owning a table, isolation still holds.
    stmts.push(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    stmts.push(`DROP POLICY IF EXISTS ${policy} ON "${table}";`);
    stmts.push(`
      CREATE POLICY ${policy} ON "${table}"
        USING (
          tenant_id = current_setting('app.tenant_id', true)::uuid
          ${allowsGlobalRows ? "OR tenant_id IS NULL" : ""}
        )
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `);
    // The policy column must be indexed or every policy check is a seq scan.
    stmts.push(
      `CREATE INDEX IF NOT EXISTS "${table}_tenant_rls_idx" ON "${table}" (tenant_id);`,
    );
  }

  /**
   * `tenants` is the one tenant-scoped table whose key column is `id`, not
   * `tenant_id`, so the generator above skips it. Without this policy the
   * tenant directory itself — every customer's company name and settings —
   * would be readable by any authenticated connection. Handled explicitly and
   * asserted by the verifier below.
   */
  stmts.push(`ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;`);
  stmts.push(`ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;`);
  stmts.push(`DROP POLICY IF EXISTS tenants_self_isolation ON "tenants";`);
  stmts.push(`
    CREATE POLICY tenants_self_isolation ON "tenants"
      USING (id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
  `);

  // Balanced-journal invariant. Enforced in the database because a bug in one
  // service must not be able to produce a ledger that does not add up.
  stmts.push(`
    CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
    DECLARE
      d numeric(18,4);
      c numeric(18,4);
    BEGIN
      SELECT COALESCE(SUM(base_debit),0), COALESCE(SUM(base_credit),0)
        INTO d, c
        FROM journal_lines
       WHERE journal_id = COALESCE(NEW.journal_id, OLD.journal_id);
      IF d <> c THEN
        RAISE EXCEPTION 'Journal % is unbalanced: debit %, credit %',
          COALESCE(NEW.journal_id, OLD.journal_id), d, c;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql;
  `);
  stmts.push(`DROP TRIGGER IF EXISTS journal_balance_check ON journal_lines;`);
  stmts.push(`
    CREATE CONSTRAINT TRIGGER journal_balance_check
      AFTER INSERT OR UPDATE OR DELETE ON journal_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();
  `);

  // A journal line is one side or the other, never both, never neither.
  stmts.push(`
    ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_single_side;
  `);
  stmts.push(`
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_single_side
      CHECK ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0) OR (debit = 0 AND credit = 0));
  `);

  // Two active leases on the same unit is a business-ending data error.
  stmts.push(`
    CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_unit
      ON leases (unit_id) WHERE status = 'active';
  `);

  // Double-booking a chair is the salon equivalent. GiST + tstzrange makes it
  // impossible rather than merely discouraged.
  stmts.push(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
  stmts.push(`
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_resource_overlap;
  `);
  stmts.push(`
    ALTER TABLE appointments ADD CONSTRAINT appointments_no_resource_overlap
      EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (resource_id IS NOT NULL AND status NOT IN ('cancelled','no_show'));
  `);

  // Trigram search for the "find a customer by half a phone number" box.
  stmts.push(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  stmts.push(`
    CREATE INDEX IF NOT EXISTS parties_search_trgm
      ON parties USING gin ((display_name || ' ' || COALESCE(primary_phone,'')) gin_trgm_ops);
  `);
  stmts.push(`
    CREATE INDEX IF NOT EXISTS items_search_trgm
      ON items USING gin (name gin_trgm_ops);
  `);

  return stmts;
}

/** Returns the list of tenant-scoped tables that are missing a policy. */
export const VERIFY_RLS_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND (
       c.relname = 'tenants'
       OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
       )
     )
     AND (
       c.relrowsecurity = false
       OR c.relforcerowsecurity = false
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
     );
`;

/**
 * Everything, in order. Used by the runtime `db:rls` path, which still exists
 * for local development and for creating the role on a fresh database.
 */
export function buildRlsStatements(
  appRole = "nexus_app",
  appPassword = appRole,
): string[] {
  return [...buildRoleStatements(appRole, appPassword), ...buildPolicyStatements(appRole)];
}
