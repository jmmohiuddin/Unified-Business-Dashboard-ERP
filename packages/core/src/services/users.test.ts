import { describe, expect, it } from "vitest";
import { changeRole, deactivateUser } from "./users.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * RBAC BOUNDARY TESTS.
 *
 * OPS-07 §1.1 asks for unit tests covering each role's boundary; the one that
 * was missing is the boundary that matters most — the ceiling. `user:update`
 * used to accept any role key at all, so a holder could promote an account they
 * controlled to `owner` (permissions `["*"]`) and sign in as it. Nothing in the
 * suite would have noticed.
 *
 * These run against a stub transaction rather than Postgres. The property under
 * test is a comparison between two integers made before any SQL is issued, and
 * proving it needs no database — which is the point: it runs in `test:unit`, on
 * every commit, not only where a seeded database exists.
 */

const ROLES: Record<string, { id: string; name: string; level: number }> = {
  super_admin: { id: "10000000-0000-4000-8000-000000000001", name: "Super Admin", level: 100 },
  owner: { id: "20000000-0000-4000-8000-000000000002", name: "Business Owner", level: 90 },
  branch_manager: { id: "30000000-0000-4000-8000-000000000003", name: "Branch Manager", level: 60 },
  barber: { id: "40000000-0000-4000-8000-000000000004", name: "Barber", level: 20 },
};

const ACTOR = "aaaaaaaa-1111-4111-8111-111111111111";
const TARGET_MEMBERSHIP = "bbbbbbbb-2222-4222-9222-222222222222";
const TARGET_USER = "cccccccc-3333-4333-a333-333333333333";

/** The literal fragments of a drizzle `sql` template, with the parameters
 *  elided — enough to tell one statement from another. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = c && typeof c === "object" ? (c as { value?: unknown }).value : undefined;
      return Array.isArray(v) ? v.join(" ") : "";
    })
    .join(" ");
}

/**
 * A transaction that answers the two lookups `users.ts` makes and records
 * everything else. `writes` is what proves a refusal refused: a guard that
 * throws after the UPDATE has landed is not a guard.
 */
function stubTx(target: { roleKey: string; status?: string }) {
  const writes: string[] = [];
  let requestedRoleKey: string | undefined;

  const execute = async (query: unknown) => {
    const text = sqlText(query);
    if (/FROM roles WHERE key/i.test(text)) {
      const role = requestedRoleKey ? ROLES[requestedRoleKey] : undefined;
      return role ? [{ id: role.id, name: role.name, level: String(role.level) }] : [];
    }
    if (/FROM memberships m/i.test(text)) {
      const role = ROLES[target.roleKey]!;
      return [{
        id: TARGET_MEMBERSHIP,
        user_id: TARGET_USER,
        full_name: "Target Person",
        status: target.status ?? "active",
        role_key: target.roleKey,
        role_level: String(role.level),
      }];
    }
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return {
    writes,
    tx: { execute } as unknown as ServiceContext["tx"],
    setRoleKey: (k: string) => { requestedRoleKey = k; },
  };
}

function ctxFor(actorRoleKey: string, tx: ServiceContext["tx"]): ServiceContext {
  const role = ROLES[actorRoleKey]!;
  const principal: Principal = {
    userId: ACTOR,
    tenantId: "dddddddd-4444-4444-b444-444444444444",
    membershipId: "eeeeeeee-5555-4555-8555-555555555555",
    roleKey: actorRoleKey,
    roleLevel: role.level,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    // The exact shape the finding describes: an ordinary role handed
    // `user:update` through `permission_overrides.grant`, with no role change.
    permissions: new Set(["user:read", "user:update", "user:delete"]),
    isPlatformAdmin: false,
  };
  return {
    tx,
    tenantId: principal.tenantId,
    principal,
    today: "2026-08-21",
    baseCurrency: "AED",
  };
}

async function attemptChange(actorRoleKey: string, targetRoleKey: string, newRoleKey: string) {
  const stub = stubTx({ roleKey: targetRoleKey });
  stub.setRoleKey(newRoleKey);
  const result = await changeRole(ctxFor(actorRoleKey, stub.tx), {
    membershipId: TARGET_MEMBERSHIP,
    roleKey: newRoleKey,
  }).then(
    (r) => ({ ok: true as const, value: r }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  return { ...result, writes: stub.writes };
}

describe("changeRole role ceiling", () => {
  it("refuses to let a branch manager grant owner", async () => {
    const r = await attemptChange("branch_manager", "barber", "owner");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBeInstanceOf(ServiceError);
    expect(r.ok === false && (r.error as ServiceError).code).toBe("forbidden");
    expect(r.ok === false && (r.error as ServiceError).message).toContain("ranks above your own");
    // Nothing was written — not the membership, not even an audit row.
    expect(r.writes).toEqual([]);
  });

  it("refuses to let a branch manager grant super_admin", async () => {
    const r = await attemptChange("branch_manager", "barber", "super_admin");
    expect(r.ok).toBe(false);
    expect(r.ok === false && (r.error as ServiceError).code).toBe("forbidden");
    expect(r.writes).toEqual([]);
  });

  it("refuses to let a branch manager demote an owner", async () => {
    const r = await attemptChange("branch_manager", "owner", "barber");
    expect(r.ok).toBe(false);
    expect(r.ok === false && (r.error as ServiceError).message).toContain("senior to yours");
    expect(r.writes).toEqual([]);
  });

  it("allows a grant at or below the actor's own level", async () => {
    const down = await attemptChange("owner", "barber", "branch_manager");
    expect(down.ok).toBe(true);
    expect(down.ok && down.value.roleKey).toBe("branch_manager");

    // Equal rank is allowed on purpose: it confers nothing the actor does not
    // already hold, and refusing it would make a co-owner unappointable — the
    // last-owner-standing hazard documented in users.ts.
    const peer = await attemptChange("owner", "branch_manager", "owner");
    expect(peer.ok).toBe(true);
  });

  it("still refuses self-service role changes before it reaches the ceiling", async () => {
    const stub = stubTx({ roleKey: "owner" });
    stub.setRoleKey("owner");
    const ctx = ctxFor("owner", stub.tx);
    // Same user id on both sides: the target membership is the actor's own.
    (ctx.principal as { userId: string }).userId = TARGET_USER;
    await expect(
      changeRole(ctx, { membershipId: TARGET_MEMBERSHIP, roleKey: "owner" }),
    ).rejects.toThrow(/your own role/);
    expect(stub.writes).toEqual([]);
  });
});

describe("deactivateUser role ceiling", () => {
  it("refuses to let a branch manager offboard an owner", async () => {
    const stub = stubTx({ roleKey: "owner" });
    await expect(
      deactivateUser(ctxFor("branch_manager", stub.tx), {
        membershipId: TARGET_MEMBERSHIP,
        reason: "hostile takeover attempt",
      }),
    ).rejects.toThrow(/senior to yours/);
    // In particular no session was revoked.
    expect(stub.writes).toEqual([]);
  });

  it("allows an owner to offboard someone junior", async () => {
    const stub = stubTx({ roleKey: "barber" });
    const res = await deactivateUser(ctxFor("owner", stub.tx), {
      membershipId: TARGET_MEMBERSHIP,
      reason: "left the business",
    });
    expect(res.membershipId).toBe(TARGET_MEMBERSHIP);
  });
});
