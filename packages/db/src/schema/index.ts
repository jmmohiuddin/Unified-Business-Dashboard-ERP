/**
 * Schema barrel.
 *
 * Module boundaries here mirror the bounded contexts in docs/02-data-model.md.
 * Cross-context references are by UUID column without a foreign key where the
 * dependency would create a cycle (e.g. documents -> jobs), and with a foreign
 * key everywhere else. That is a deliberate trade: referential integrity where
 * it protects money, loose coupling where it protects modularity.
 */
export * from "./_enums.ts";
export * from "./_shared.ts";

export * from "./tenancy.ts";
export * from "./identity.ts";
export * from "./parties.ts";
export * from "./catalog.ts";
export * from "./inventory.ts";
export * from "./documents.ts";
export * from "./accounting.ts";
export * from "./operations.ts";
export * from "./hr.ts";
export * from "./platform.ts";
