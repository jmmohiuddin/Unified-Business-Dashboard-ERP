import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { membershipStatus, scopeLevel } from "./_enums.ts";
import { metadata, pk, timestamps } from "./_shared.ts";
import { businessUnits, locations, tenants } from "./tenancy.ts";

/**
 * Users are GLOBAL, memberships are tenant-scoped. An accountant can serve two
 * different owners; a barber who also rents a shop from the owner is one user
 * with two memberships. Modelling users inside the tenant makes that
 * impossible to fix later.
 */
export const users = pgTable(
  "users",
  {
    id: pk(),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    avatarUrl: text("avatar_url"),
    passwordHash: text("password_hash"),
    /** TOTP secret, encrypted at the application layer before it lands here. */
    mfaSecretEnc: text("mfa_secret_enc"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    recoveryCodesEnc: text("recovery_codes_enc"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginCount: jsonb("failed_login_count").notNull().default(sql`'0'::jsonb`),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    locale: varchar("locale", { length: 10 }).notNull().default("en"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    /**
     * The tenant to open on sign-in.
     *
     * Denormalised onto the (global, un-RLS'd) users table to break a genuine
     * chicken-and-egg: `memberships` is tenant-isolated, but at login there is
     * no tenant context yet to read it under. The alternatives were to punch a
     * hole in the memberships policy or to run the login query as the database
     * owner — both trade a permanent weakening of isolation for one column.
     * Multi-tenant users switch through an authenticated, tenant-scoped path.
     */
    defaultTenantId: uuid("default_tenant_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    uniqueIndex("users_phone_uq").on(t.phone),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Only the hash is stored, so a database leak does not hand over sessions. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/**
 * Roles are per-tenant rows, not a hard-coded enum, because the brief asks for
 * "customisable permissions". System roles are seeded and flagged read-only;
 * an owner clones one to make "Branch Manager (Uttara)".
 */
export const roles = pgTable(
  "roles",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 60 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    /** System roles have tenant_id NULL and are visible to every tenant. */
    isSystem: boolean("is_system").notNull().default(false),
    /** Ranking used for "can this user edit that user" checks. */
    level: jsonb("level").notNull().default(sql`'50'::jsonb`),
    ...timestamps,
  },
  (t) => [uniqueIndex("roles_tenant_key_uq").on(t.tenantId, t.key)],
);

/**
 * Permissions are `resource:action` strings (`invoice:approve`, `payroll:read`).
 * Storing them as rows rather than a bitmask keeps them greppable and lets the
 * UI render a permission matrix without a lookup table in code.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: pk(),
    key: varchar("key", { length: 80 }).notNull(),
    resource: varchar("resource", { length: 40 }).notNull(),
    action: varchar("action", { length: 40 }).notNull(),
    module: varchar("module", { length: 40 }).notNull(),
    description: text("description"),
    /** Permissions that can move money or expose payroll get a second look in
     *  the UI and are always written to the audit log. */
    isSensitive: boolean("is_sensitive").notNull().default(false),
  },
  (t) => [uniqueIndex("permissions_key_uq").on(t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("role_permissions_pk").on(t.roleId, t.permissionId)],
);

/** A user's presence inside one tenant. */
export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    status: membershipStatus("status").notNull().default("active"),
    /** How wide this membership can see. `business_unit` + rows in
     *  membership_scopes is the common case for a branch manager. */
    scope: scopeLevel("scope").notNull().default("tenant"),
    title: varchar("title", { length: 100 }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Per-user permission overrides on top of the role: {"grant":[],"deny":[]} */
    permissionOverrides: metadata("permission_overrides"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

/** Which businesses / branches a scoped membership may touch. */
export const membershipScopes = pgTable(
  "membership_scopes",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "cascade",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("membership_scopes_membership_idx").on(t.membershipId),
    uniqueIndex("membership_scopes_uq").on(t.membershipId, t.businessUnitId, t.locationId),
  ],
);

/**
 * API tokens for the mobile app and any programmatic client.
 *
 * A token is bound to ONE membership, so it inherits that user's role, scope
 * and permissions exactly — there is no separate "API permission" surface to
 * drift out of sync with the UI. Only the SHA-256 is stored, like a session;
 * the plaintext is shown once at creation and never again. Scopes narrow a
 * token below its user (a read-only reporting token for a full-access owner),
 * never widen it.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** First 8 chars of the token, shown so a user can identify it in a list. */
    prefix: varchar("prefix", { length: 12 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** Optional narrowing: e.g. ["metrics:read"]. Empty = full user rights. */
    scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_tokens_hash_uq").on(t.tokenHash),
    index("api_tokens_membership_idx").on(t.membershipId),
  ],
);

/**
 * Rate-limit counters.
 *
 * Global (not tenant-scoped) because the thing being limited — an IP hammering
 * the login form — exists before any tenant is known. Deliberately in Postgres
 * rather than memory: an in-memory limiter resets on deploy and is per-instance,
 * so it stops nobody the moment you run two containers. Redis is the upgrade
 * when volume justifies it, not a prerequisite for having a limit.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    id: pk(),
    key: varchar("key", { length: 160 }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limit_key_at_idx").on(t.key, t.at)],
);

/**
 * Append-only audit trail. Written by the service layer for every mutation that
 * touches money, permissions or customer PII. Partition by month in production.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: varchar("actor_label", { length: 200 }),
    businessUnitId: uuid("business_unit_id"),
    action: varchar("action", { length: 80 }).notNull(),
    entityTable: varchar("entity_table", { length: 63 }).notNull(),
    entityId: uuid("entity_id"),
    /** Only the changed fields, never the whole row — keeps the log readable
     *  and avoids duplicating PII across every update. */
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 40 }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_tenant_at_idx").on(t.tenantId, t.at),
    index("audit_entity_idx").on(t.entityTable, t.entityId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
}));

export const membershipsRelations = relations(memberships, ({ one, many }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [memberships.tenantId], references: [tenants.id] }),
  role: one(roles, { fields: [memberships.roleId], references: [roles.id] }),
  scopes: many(membershipScopes),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
}));
