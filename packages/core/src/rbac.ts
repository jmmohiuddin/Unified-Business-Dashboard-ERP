/**
 * Authorisation.
 *
 * Two distinct concerns, deliberately kept apart:
 *
 *   ISOLATION  — "can this connection see another tenant's rows at all?"
 *                Answered by Postgres RLS. Not this file's job, and not
 *                trusted to application code.
 *
 *   AUTHORISATION — "within this tenant, may this user perform this action on
 *                these businesses?" That is what lives here.
 *
 * Conflating the two is how multi-tenant systems end up with a permission bug
 * that becomes a data breach.
 */

export interface Principal {
  userId: string;
  tenantId: string;
  membershipId: string;
  roleKey: string;
  roleLevel: number;
  scope: "tenant" | "business_unit" | "location" | "self";
  /** null = every business in the tenant. */
  businessUnitIds: string[] | null;
  locationIds: string[] | null;
  permissions: Set<string>;
  isPlatformAdmin: boolean;
}

export function can(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}

export function canAny(principal: Principal, permissions: string[]): boolean {
  return permissions.some((p) => principal.permissions.has(p));
}

/** Throwing variant for server actions, where a silent false is a bug. */
export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(principal: Principal, permission: string): void {
  if (!can(principal, permission)) throw new ForbiddenError(permission);
}

/** Can this principal act on this specific business? */
export function canAccessBusinessUnit(principal: Principal, businessUnitId: string): boolean {
  if (principal.scope === "tenant") return true;
  return principal.businessUnitIds?.includes(businessUnitId) ?? false;
}

/**
 * Resolve effective permissions from role grants plus per-user overrides.
 * Deny always beats grant — a revoked permission must not be recoverable by
 * adding a role, which is the failure mode of grant-wins systems.
 */
export function resolvePermissions(
  rolePermissions: string[],
  overrides?: { grant?: string[]; deny?: string[] } | null,
): Set<string> {
  const set = new Set(rolePermissions);
  for (const g of overrides?.grant ?? []) set.add(g);
  for (const d of overrides?.deny ?? []) set.delete(d);
  return set;
}
