import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { acceptInvite, createInvite, setMembershipScope } from "./users.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * THE INVITE IS THE OBVIOUS WAY ROUND THE ROLE CEILING.
 *
 * Wave 1 gave `changeRole` a privilege ceiling: nobody may grant, or take away,
 * rank they do not hold themselves (`assertRoleCeiling` in users.ts). That
 * guard protects the accounts that already exist and nothing else. An invite
 * creates an account, and if the invited role is not measured against the
 * inviter's own then the whole ceiling has a hole in it shaped like a new hire:
 * a level-60 manager who cannot promote anybody to `owner` simply invites one,
 * opens the link themselves — the product has no delivery channel, so the
 * inviter is holding it — and signs in with `["*"]`.
 *
 * That is the headline case below. The same argument applies on the second
 * axis: a membership limited to two businesses must not be able to invite
 * somebody who can see all seven, which is not a promotion but is the same
 * access gained by a different route.
 *
 * These run against a stub transaction, as `users.test.ts` does and for the
 * same reason: the property under test is a comparison made before any SQL is
 * issued, so proving it needs no Postgres and it runs in `test:unit` on every
 * commit. `writes` is what proves a refusal refused — a guard that throws after
 * the INSERT has landed is not a guard.
 */

const ROLES: Record<string, { id: string; name: string; level: number }> = {
  super_admin: { id: "10000000-0000-4000-8000-000000000001", name: "Super Admin", level: 100 },
  owner: { id: "20000000-0000-4000-8000-000000000002", name: "Business Owner", level: 90 },
  accountant: { id: "25000000-0000-4000-8000-000000000005", name: "Accountant", level: 70 },
  branch_manager: { id: "30000000-0000-4000-8000-000000000003", name: "Branch Manager", level: 60 },
  receptionist: { id: "40000000-0000-4000-8000-000000000004", name: "Receptionist", level: 30 },
};

const ACTOR = "aaaaaaaa-1111-4111-8111-111111111111";
const TENANT = "dddddddd-4444-4444-b444-444444444444";
const SALON = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARKING = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
 * The parameters bound into a drizzle `sql` template, in order.
 *
 * Drizzle boxes interpolated primitives (a `String` or `Number` object sits in
 * `queryChunks` where the value goes) and keeps literal text in `StringChunk`,
 * whose `value` is an array. Telling them apart is what makes it possible to
 * assert what a statement actually CARRIED — a token, a password hash, or
 * nothing — rather than only what it said. `sql.join` nests, so this recurses.
 */
function sqlParams(query: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (chunk === null || chunk === undefined) continue;
      if (typeof chunk !== "object") {
        out.push(chunk);
        continue;
      }
      if (Array.isArray((chunk as { value?: unknown }).value)) continue; // StringChunk
      if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
        walk(chunk);
        continue;
      }
      out.push(chunk.valueOf());
    }
  };
  walk(query);
  return out;
}

interface InviteWorld {
  /** The membership the invited address already holds, if any. */
  existingMembership?: { status: string; full_name: string };
  /** Business units the tenant actually has. */
  businessUnits?: string[];
}

/**
 * A transaction that answers `createInvite`'s four reads and records the rest.
 *
 * Anything that is not one of the recognised SELECTs is treated as a write and
 * remembered by its first three words, so a test can assert that a refusal
 * wrote nothing at all.
 */
function inviteTx(world: InviteWorld = {}) {
  const writes: string[] = [];
  const statements: { text: string; params: unknown[] }[] = [];
  let requestedRoleKey: string | undefined;

  const execute = async (query: unknown) => {
    const text = sqlText(query);
    statements.push({ text, params: sqlParams(query) });

    if (/FROM roles WHERE key/i.test(text)) {
      const role = requestedRoleKey ? ROLES[requestedRoleKey] : undefined;
      return role
        ? [{ id: role.id, name: role.name, key: requestedRoleKey, level: String(role.level) }]
        : [];
    }
    if (/SELECT id FROM business_units/i.test(text)) {
      return (world.businessUnits ?? [SALON, PARKING]).map((id) => ({ id }));
    }
    if (/FROM memberships m JOIN users u/i.test(text)) {
      return world.existingMembership ? [world.existingMembership] : [];
    }
    if (/UPDATE user_invites/i.test(text)) {
      writes.push("UPDATE user_invites");
      return [];
    }
    if (/INSERT INTO user_invites/i.test(text)) {
      writes.push("INSERT INTO user_invites");
      return [{ id: "eeee0000-0000-4000-8000-00000000ffff", expires_at: "2026-08-24T09:00:00Z" }];
    }
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return {
    writes,
    statements,
    tx: { execute } as unknown as ServiceContext["tx"],
    setRoleKey: (k: string) => {
      requestedRoleKey = k;
    },
  };
}

function ctxFor(
  actorRoleKey: string,
  tx: ServiceContext["tx"],
  opts: { scope?: Principal["scope"]; businessUnitIds?: string[] | null } = {},
): ServiceContext {
  const role = ROLES[actorRoleKey]!;
  const principal: Principal = {
    userId: ACTOR,
    tenantId: TENANT,
    membershipId: "eeeeeeee-5555-4555-8555-555555555555",
    roleKey: actorRoleKey,
    roleLevel: role.level,
    scope: opts.scope ?? "tenant",
    businessUnitIds: opts.businessUnitIds ?? null,
    locationIds: null,
    // The exact shape the wave-1 finding describes: an ordinary role handed the
    // user-administration permissions through `permission_overrides.grant`,
    // with no role change and therefore no rank change.
    permissions: new Set(["user:read", "user:update", "user:delete", "user:invite"]),
    isPlatformAdmin: false,
  };
  return { tx, tenantId: TENANT, principal, today: "2026-08-21", baseCurrency: "AED" };
}

async function attemptInvite(
  actorRoleKey: string,
  invitedRoleKey: string,
  opts: {
    businessUnitIds?: string[];
    actorScope?: Principal["scope"];
    actorUnits?: string[] | null;
    world?: InviteWorld;
  } = {},
) {
  const stub = inviteTx(opts.world);
  stub.setRoleKey(invitedRoleKey);
  const ctx = ctxFor(actorRoleKey, stub.tx, {
    scope: opts.actorScope,
    businessUnitIds: opts.actorUnits,
  });
  const outcome = await createInvite(ctx, {
    email: "newhire@sumon.test",
    roleKey: invitedRoleKey,
    businessUnitIds: opts.businessUnitIds ?? [],
  }).then(
    (r) => ({ ok: true as const, value: r }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  return { ...outcome, writes: stub.writes, statements: stub.statements };
}

describe("createInvite role ceiling", () => {
  it("refuses to let a branch manager invite an owner", async () => {
    const attempt = await attemptInvite("branch_manager", "owner");

    expect(attempt.ok).toBe(false);
    const error = (attempt as { error: unknown }).error;
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("forbidden");
    expect((error as ServiceError).message).toContain("ranks above your own role");

    // The refusal is worthless if the row already exists. Nothing at all may
    // have been written — not the invite, not the audit entry.
    expect(attempt.writes).toEqual([]);
  });

  it("refuses every role above the inviter, not merely the top one", async () => {
    for (const above of ["super_admin", "owner", "accountant"]) {
      const attempt = await attemptInvite("branch_manager", above);
      expect(attempt.ok, `branch_manager must not invite ${above}`).toBe(false);
      expect(attempt.writes).toEqual([]);
    }
  });

  it("allows an invite at or below the inviter's own rank", async () => {
    const below = await attemptInvite("branch_manager", "receptionist");
    expect(below.ok).toBe(true);
    expect(below.writes).toContain("INSERT INTO user_invites");

    // `<=`, not `<`, for the reason `assertRoleCeiling` gives: a rank you
    // already hold confers nothing new, and `<` would make a co-owner
    // unappointable by the only owner in the tenant.
    const peer = await attemptInvite("branch_manager", "branch_manager");
    expect(peer.ok).toBe(true);

    const coOwner = await attemptInvite("owner", "owner");
    expect(coOwner.ok).toBe(true);
  });

  it("emits a security event when the ceiling refuses, because the audit log cannot", async () => {
    // A refused invite changes nothing, so `writeAudit` has nothing to record.
    // The attempt is only visible in the security stream — which is the reason
    // the two channels are separate.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      await attemptInvite("branch_manager", "owner");
    } finally {
      spy.mockRestore();
    }

    const event = errors.map((l) => JSON.parse(l)).find((e) => e.kind === "authz.denied");
    expect(event).toBeDefined();
    expect(event.detail.attempted).toBe("user.invite");
    expect(event.detail.role).toBe("owner");
    // Redaction is applied on the way out: the address is masked, not published.
    expect(event.detail.email).not.toContain("newhire@");
    expect(event.detail.email).toContain("@sumon.test");
  });
});

describe("createInvite scope ceiling", () => {
  it("refuses to let a branch-scoped inviter grant tenant-wide access", async () => {
    // No business units named means EVERY business. From an actor who can see
    // one, that is an escalation with no role change attached to it.
    const attempt = await attemptInvite("branch_manager", "receptionist", {
      actorScope: "business_unit",
      actorUnits: [SALON],
      businessUnitIds: [],
    });

    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("forbidden");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses to let a branch-scoped inviter grant a business they cannot see", async () => {
    const attempt = await attemptInvite("branch_manager", "receptionist", {
      actorScope: "business_unit",
      actorUnits: [SALON],
      businessUnitIds: [PARKING],
    });

    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("forbidden");
    expect(attempt.writes).toEqual([]);
  });

  it("allows a branch-scoped inviter to grant their own business", async () => {
    const attempt = await attemptInvite("branch_manager", "receptionist", {
      actorScope: "business_unit",
      actorUnits: [SALON],
      businessUnitIds: [SALON],
      world: { businessUnits: [SALON] },
    });

    expect(attempt.ok).toBe(true);
    expect(attempt.writes).toContain("INSERT INTO user_invites");
  });
});

describe("createInvite and existing people", () => {
  it("refuses to invite somebody who already has access", async () => {
    const attempt = await attemptInvite("owner", "receptionist", {
      world: { existingMembership: { status: "active", full_name: "Maya Rahman" } },
    });

    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("conflict");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses to let an invite undo a deactivation", async () => {
    // `deactivateUser` revokes every live session in the same transaction. If an
    // invitation could mint a fresh `active` membership for the same person,
    // offboarding would last exactly as long as it took to send a new link.
    const attempt = await attemptInvite("owner", "receptionist", {
      world: { existingMembership: { status: "suspended", full_name: "Ahmed Khan" } },
    });

    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.message).toContain("Restore their access");
    expect(attempt.writes).toEqual([]);
  });
});

describe("createInvite token handling", () => {
  it("returns the token once and never writes it down in the clear", async () => {
    const attempt = await attemptInvite("owner", "receptionist");
    expect(attempt.ok).toBe(true);
    const token = (attempt as { value: { token: string } }).value.token;

    // 32 random bytes, base64url — 43 characters, no padding, URL-safe.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const insert = attempt.statements.find((s) => /INSERT INTO user_invites/i.test(s.text));
    const audit = attempt.statements.find((s) => /INSERT INTO audit_log/i.test(s.text));
    expect(insert).toBeDefined();
    expect(audit).toBeDefined();

    // The row carries a 64-character SHA-256 and never the token itself.
    expect(insert!.params).toContainEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(insert!.params).not.toContain(token);

    // The audit diff carries neither. An audit log that records the credential
    // it is auditing is a second copy of the credential.
    const diff = JSON.stringify(audit!.params);
    expect(diff).not.toContain(token);
    expect(diff).not.toMatch(/[0-9a-f]{64}/);
  });
});

// ── Scope editing ───────────────────────────────────────────────────────────

function scopeTx(target: { roleKey: string; scope?: string; userId?: string }) {
  const writes: string[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);
    if (/FROM memberships m JOIN users u/i.test(text)) {
      return [
        {
          id: TARGET_MEMBERSHIP,
          user_id: target.userId ?? TARGET_USER,
          full_name: "Target Person",
          scope: target.scope ?? "business_unit",
          role_level: String(ROLES[target.roleKey]!.level),
        },
      ];
    }
    if (/SELECT id FROM business_units/i.test(text)) return [{ id: SALON }, { id: PARKING }];
    if (/SELECT business_unit_id FROM membership_scopes/i.test(text)) return [{ business_unit_id: SALON }];
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return { writes, tx: { execute } as unknown as ServiceContext["tx"] };
}

async function attemptScope(
  actorRoleKey: string,
  target: { roleKey: string; scope?: string; userId?: string },
  businessUnitIds: string[],
  actor: { scope?: Principal["scope"]; units?: string[] | null } = {},
) {
  const stub = scopeTx(target);
  const ctx = ctxFor(actorRoleKey, stub.tx, {
    scope: actor.scope,
    businessUnitIds: actor.units,
  });
  const outcome = await setMembershipScope(ctx, {
    membershipId: TARGET_MEMBERSHIP,
    businessUnitIds,
  }).then(
    (r) => ({ ok: true as const, value: r }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  return { ...outcome, writes: stub.writes };
}

describe("setMembershipScope", () => {
  it("narrows and widens an existing membership", async () => {
    const attempt = await attemptScope("owner", { roleKey: "receptionist" }, [SALON, PARKING]);
    expect(attempt.ok).toBe(true);
    expect((attempt as { value: { scope: string } }).value.scope).toBe("business_unit");
    expect(attempt.writes).toContain("DELETE FROM membership_scopes");
    expect(attempt.writes).toContain("INSERT INTO membership_scopes");
    expect(attempt.writes).toContain("UPDATE memberships SET");
    expect(attempt.writes).toContain("INSERT INTO audit_log");
  });

  it("treats an empty list as tenant-wide", async () => {
    const attempt = await attemptScope("owner", { roleKey: "receptionist" }, []);
    expect(attempt.ok).toBe(true);
    expect((attempt as { value: { scope: string } }).value.scope).toBe("tenant");
  });

  it("refuses to change the caller's own reach", async () => {
    const attempt = await attemptScope(
      "owner",
      { roleKey: "owner", userId: ACTOR },
      [SALON],
    );
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("invalid");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses to re-scope somebody senior", async () => {
    const attempt = await attemptScope("branch_manager", { roleKey: "owner" }, [SALON]);
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("forbidden");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses to widen somebody beyond the caller's own reach", async () => {
    const attempt = await attemptScope(
      "branch_manager",
      { roleKey: "receptionist" },
      [PARKING],
      { scope: "business_unit", units: [SALON] },
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.writes).toEqual([]);
  });

  it("leaves location-scoped memberships alone rather than rewriting them", async () => {
    const attempt = await attemptScope(
      "owner",
      { roleKey: "receptionist", scope: "location" },
      [SALON],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.writes).toEqual([]);
  });
});

// ── Acceptance ──────────────────────────────────────────────────────────────

const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$0123456789abcdefghijklmnopqrstuv";

/** SHA-256 of "the-token-under-test", computed by the same primitive the
 *  service uses so the stub's row matches what `findInvite` will look up. */
function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const TOKEN = "the-token-under-test-0123456789";

function acceptTx(invite: Partial<Record<string, unknown>> | null, opts: {
  existingUser?: { id: string; default_tenant_id: string | null; full_name: string };
  membershipConflict?: boolean;
} = {}) {
  const writes: string[] = [];
  const statements: { text: string; params: unknown[] }[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);
    statements.push({ text, params: sqlParams(query) });

    if (/FROM user_invites i JOIN roles r/i.test(text)) {
      return invite ? [invite] : [];
    }
    if (/SELECT id, default_tenant_id, full_name FROM users/i.test(text)) {
      return opts.existingUser ? [opts.existingUser] : [];
    }
    if (/INSERT INTO users/i.test(text)) {
      writes.push("INSERT INTO users");
      return [{ id: "99999999-9999-4999-8999-999999999999" }];
    }
    if (/INSERT INTO memberships/i.test(text)) {
      writes.push("INSERT INTO memberships");
      return opts.membershipConflict ? [] : [{ id: TARGET_MEMBERSHIP }];
    }
    if (/INSERT INTO membership_scopes/i.test(text)) {
      writes.push("INSERT INTO membership_scopes");
      return [{ id: "aaaa1111-1111-4111-8111-111111111111" }];
    }
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return { writes, statements, tx: { execute } as unknown as ServiceContext["tx"] };
}

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "eeee0000-0000-4000-8000-00000000ffff",
    tenant_id: TENANT,
    email: "newhire@sumon.test",
    role_id: ROLES.receptionist!.id,
    role_key: "receptionist",
    role_name: "Receptionist",
    scope: "business_unit",
    business_unit_ids: [SALON],
    token_hash: digestOf(TOKEN),
    expires_at: "2099-01-01T00:00:00Z",
    expired: false,
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-08-21T09:00:00Z",
    ...overrides,
  };
}

async function attemptAccept(
  row: Record<string, unknown> | null,
  opts: Parameters<typeof acceptTx>[1] = {},
  token = TOKEN,
) {
  const stub = acceptTx(row, opts);
  const outcome = await acceptInvite(
    {
      tx: stub.tx,
      tenantId: TENANT,
      baseCurrency: "AED",
      today: "2026-08-21",
    },
    { token, fullName: "Maya Rahman", passwordHash: HASH },
  ).then(
    (r) => ({ ok: true as const, value: r }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  return { ...outcome, writes: stub.writes, statements: stub.statements };
}

describe("acceptInvite refuses a link that is not live", () => {
  it("refuses an unknown token and writes nothing", async () => {
    const attempt = await attemptAccept(null);
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("not_found");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses a token whose digest does not match the row it found", async () => {
    // Unreachable through the index lookup, and checked anyway: the second
    // comparison in `findInvite` is this module's own guarantee that nothing
    // in application code short-circuits on the first differing byte.
    const attempt = await attemptAccept(inviteRow({ token_hash: digestOf("a-different-token") }));
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("not_found");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses an expired link", async () => {
    // `expired` is what the service reads — computed by Postgres, never parsed
    // from the rendered timestamp. See `findInvite`.
    const attempt = await attemptAccept(
      inviteRow({ expires_at: "2020-01-01T00:00:00Z", expired: true }),
    );
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.message).toContain("expired");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses a link that has already been used", async () => {
    const attempt = await attemptAccept(inviteRow({ accepted_at: "2026-08-21T10:00:00Z" }));
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.message).toContain("already been used");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses a cancelled link", async () => {
    const attempt = await attemptAccept(inviteRow({ revoked_at: "2026-08-21T10:00:00Z" }));
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.message).toContain("cancelled");
    expect(attempt.writes).toEqual([]);
  });

  it("refuses a row whose tenant disagrees with the transaction's", async () => {
    const attempt = await attemptAccept(inviteRow({ tenant_id: "ffffffff-6666-4666-8666-666666666666" }));
    expect(attempt.ok).toBe(false);
    expect(attempt.writes).toEqual([]);
  });
});

describe("acceptInvite creates the account and the access", () => {
  it("creates a user, a membership and the business scopes", async () => {
    const attempt = await attemptAccept(inviteRow());
    expect(attempt.ok).toBe(true);

    const value = (attempt as { value: { outcome: string; businessUnitsGranted: number } }).value;
    expect(value.outcome).toBe("created");
    expect(value.businessUnitsGranted).toBe(1);

    expect(attempt.writes).toContain("INSERT INTO users");
    expect(attempt.writes).toContain("INSERT INTO memberships");
    expect(attempt.writes).toContain("INSERT INTO membership_scopes");
    expect(attempt.writes).toContain("UPDATE user_invites SET");
    expect(attempt.writes).toContain("INSERT INTO audit_log");
  });

  it("does not claim the address was verified", async () => {
    // There is no delivery channel (FR-P03), so the link reached its holder
    // because an administrator passed it on — not because it arrived in the
    // mailbox it names. Redeeming it proves nothing about the address.
    const attempt = await attemptAccept(inviteRow());
    const insert = attempt.statements.find((s) => /INSERT INTO users/i.test(s.text));
    expect(insert!.text).not.toMatch(/email_verified_at/i);
  });
});

describe("acceptInvite never takes over an existing account", () => {
  const existing = {
    id: "77777777-7777-4777-8777-777777777777",
    default_tenant_id: "88888888-8888-4888-8888-888888888888",
    full_name: "Priya Sharma",
  };

  it("links an existing account without setting its password", async () => {
    // The takeover this closes: anybody holding `user:invite` invites an
    // address that already has an account — an owner of another tenant, say —
    // opens the link themselves, and chooses that account's new password.
    const attempt = await attemptAccept(inviteRow(), { existingUser: existing });
    expect(attempt.ok).toBe(true);
    expect((attempt as { value: { outcome: string } }).value.outcome).toBe("linked");

    expect(attempt.writes).not.toContain("INSERT INTO users");
    const touchedPassword = attempt.statements.some(
      (s) => /UPDATE users/i.test(s.text) && /password_hash/i.test(s.text),
    );
    expect(touchedPassword).toBe(false);
    // The hash never reaches any statement at all on this path.
    expect(attempt.statements.some((s) => s.params.includes(HASH))).toBe(false);
  });

  it("does not repoint an existing account's default tenant", async () => {
    const attempt = await attemptAccept(inviteRow(), { existingUser: existing });
    const repointed = attempt.statements.some(
      (s) => /UPDATE users/i.test(s.text) && /default_tenant_id/i.test(s.text),
    );
    expect(repointed).toBe(false);
  });

  it("adopts the tenant only when the account has none", async () => {
    const attempt = await attemptAccept(inviteRow(), {
      existingUser: { ...existing, default_tenant_id: null },
    });
    const repointed = attempt.statements.some(
      (s) => /UPDATE users/i.test(s.text) && /default_tenant_id/i.test(s.text),
    );
    expect(repointed).toBe(true);
  });

  it("refuses when a membership appeared between the invite and its acceptance", async () => {
    // `ON CONFLICT DO NOTHING` returning no row is a suspended — or already
    // active — membership. Silently reinstating it would let a stale link undo
    // an offboarding.
    const attempt = await attemptAccept(inviteRow(), { membershipConflict: true });
    expect(attempt.ok).toBe(false);
    expect((attempt as { error: ServiceError }).error.code).toBe("conflict");
  });
});
