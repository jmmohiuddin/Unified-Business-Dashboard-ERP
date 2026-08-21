import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";
import { z } from "zod";
import {
  ServiceError,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";
import { security } from "../security/events.ts";

/**
 * USER MANAGEMENT.
 *
 * There was none. A user could not be invited, re-roled or deactivated from
 * inside the product — every staff change was a direct database edit, which
 * meant offboarding was an engineering task and, worse, editing the row did
 * nothing to the sessions that person already held. They kept working access
 * until the token expired on its own.
 *
 * The rule that makes deactivation mean something: it revokes every live
 * session in the same transaction as the status change. A membership marked
 * inactive while a valid cookie still opens the dashboard is not an offboarding,
 * it is a note.
 *
 * The rule that keeps `user:update` from being a master key: nobody may hand
 * out, or take away, rank they do not themselves hold. See `assertRoleCeiling`
 * below — without it, one ordinary permission is a route to `owner`.
 *
 * Nothing is ever deleted. The membership is suspended and the user row and
 * their entire audit history survive — an ERP has to answer "who did this" for
 * people who left years ago.
 *
 * ── ONBOARDING ──────────────────────────────────────────────────────────────
 *
 * The other half, and it arrived later than the offboarding half. Until it did,
 * adding a new hire was still the direct database edit described above; a
 * product that can revoke access but cannot grant it has automated the easy
 * direction and left the frequent one to an engineer.
 *
 * `createInvite` mints a single-use, expiring, hashed token that fixes the
 * role AND the business-unit scope at invite time; `acceptInvite` redeems it
 * without a session, because the person redeeming it does not have one yet.
 *
 * The rule that keeps the invite from being a hole in the ceiling above:
 * **the invited role answers to exactly the same rank check as `changeRole`.**
 * If it did not, a manager who cannot promote anyone to `owner` could simply
 * invite an `owner` instead, and the guard in `assertRoleCeiling` would protect
 * only the accounts that already exist. The equivalent rule applies to scope: a
 * membership limited to two branches cannot invite somebody who can see all
 * seven, because that is the same escalation measured on the other axis.
 *
 * The rule that keeps acceptance from being an account takeover: an invitation
 * addressed to an email that ALREADY has an account creates the membership and
 * nothing else. It never sets a password, never issues a session, and never
 * repoints `default_tenant_id` on an account that has one. See `acceptInvite`.
 */

// ── Role ranking ────────────────────────────────────────────────────────────

/**
 * THE CEILING: you may never hand out — or take away — rank you do not hold.
 *
 * `roles.level` exists for exactly this ("Ranking used for 'can this user edit
 * that user' checks", identity.ts) and `Principal.roleLevel` carries the
 * actor's, but nothing compared the two. `user:update` was therefore not a
 * permission to administer people below you, it was a permission to become
 * anyone: the holder promotes a second account they control to `owner`, whose
 * grant is `["*"]`, and signs in as it. That is a full escalation from one
 * ordinary permission.
 *
 * It is currently masked — only `super_admin` (100) and `owner` (90) hold
 * `user:update`, and both are already at the top. The mask comes off the moment
 * a `permission_overrides.grant` hands `user:update` to a single membership
 * without changing its role, which is a supported and un-audited operation.
 *
 * Two comparisons, because rank is abusable in both directions:
 *
 *   NEW role   ≤ actor  — the escalation guard. Grant no rank above your own.
 *   CURRENT role ≤ actor — the peer guard. Without it a level-60 with the
 *                          override could demote the owner to `barber`, which
 *                          is not escalation but is a hostile takeover with the
 *                          same end state.
 *
 * Deliberately `≤` and not `<`. Granting a rank you already hold confers
 * nothing you could not already do yourself, so it is not escalation — and `<`
 * would make a co-owner unappointable: this tenant has one `owner` and zero
 * `super_admin`s, so under `<` the owner rank could never be issued again by
 * anyone inside the tenant. A single owner who is hit by a bus would end the
 * business's ability to administer itself.
 *
 * LAST OWNER STANDING is what makes `≤` safe. `changeRole` and
 * `deactivateUser` both refuse to act on the caller's own membership, so the
 * only way to strip the last owner is for another owner to do it — and an
 * owner can only exist while an owner exists. Whoever acts first survives, so
 * the count of live owner memberships can be driven down to one but never to
 * zero. Nobody can lock the tenant out of itself.
 *
 * A rank that will not parse fails closed, in whichever direction closes it: an
 * unreadable role level is treated as above everything, an unreadable actor
 * level as below everything. Left as raw NaN it would compare false in every
 * direction and wave the whole thing through, which is the shape of this bug in
 * the first place.
 */
function levelOf(raw: string | null | undefined): number {
  const n = Number(raw); // money-guard-ignore: a role rank, not an amount
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * `currentLevel: null` is the ONE case with no incumbent rank to protect: an
 * invitation, where nobody holds the membership yet. Only the escalation guard
 * applies there, and it applies with full force — see `createInvite`, which is
 * the obvious way around this ceiling if the invited role is not checked
 * against the inviter's own. Every other caller passes a real level and gets
 * both guards, unchanged.
 *
 * Spelled as an explicit `!== null` rather than left to `levelOf(null)`, which
 * happens to return 0 because `Number(null)` is 0. That is an accident of
 * JavaScript, not a decision, and a guard that is correct by accident is a
 * guard that stops being correct the first time someone tidies it.
 */
function assertRoleCeiling(
  ctx: ServiceContext,
  target: { name: string | null; currentLevel: string | null; grantedLevel?: string | null; grantedName?: string },
) {
  const mine = Number.isFinite(ctx.principal.roleLevel)
    ? ctx.principal.roleLevel
    : Number.NEGATIVE_INFINITY;
  const who = target.name ?? "That person";

  if (target.currentLevel !== null && levelOf(target.currentLevel) > mine) {
    throw new ServiceError(
      `${who} holds a role senior to yours. You cannot change it.`,
      "forbidden",
    );
  }
  if (target.grantedLevel !== undefined && levelOf(target.grantedLevel) > mine) {
    throw new ServiceError(
      `You cannot grant "${target.grantedName}" — it ranks above your own role.`,
      "forbidden",
    );
  }
}

// ── Deactivate ──────────────────────────────────────────────────────────────

export const deactivateUserInput = z.object({
  membershipId: z.uuid(),
  reason: z.string().min(3).max(500),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function deactivateUser(ctx: ServiceContext, raw: unknown) {
  const input = deactivateUserInput.parse(raw);
  requirePermission(ctx, "user:delete");

  return withIdempotency(ctx, input.idempotencyKey, "deactivateUser", async () => {
    const [m] = await ctx.tx.execute<{
      id: string; user_id: string; status: string; full_name: string | null; role_level: string;
    }>(sql`
      SELECT m.id, m.user_id, m.status::text, u.full_name, r.level::text AS role_level
        FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
       WHERE m.id = ${input.membershipId}::uuid
       FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("That person is not a member of this business.", "not_found");

    // Removing your own access locks you out of the screen you are standing on,
    // and there may be no one else who can undo it.
    if (m.user_id === ctx.principal.userId) {
      throw new ServiceError("You cannot deactivate your own access.", "invalid");
    }
    // Suspending a senior is a demotion to zero, so it answers to the same
    // ceiling as `changeRole` — otherwise the peer guard there is trivially
    // routed around by offboarding the owner instead of re-roling them.
    assertRoleCeiling(ctx, { name: m.full_name, currentLevel: m.role_level });
    if (m.status === "suspended") {
      throw new ServiceError(`${m.full_name ?? "That person"} is already deactivated.`, "conflict");
    }

    await ctx.tx.execute(sql`
      UPDATE memberships SET status = 'suspended', updated_at = now()
       WHERE id = ${input.membershipId}::uuid
    `);

    /**
     * Revoke every live session, in the same transaction.
     *
     * `sessions` is not tenant-scoped, so this is a direct write rather than a
     * call into the web app's cookie-aware helper — that one can only revoke
     * the *acting* user's own sessions, which is exactly the wrong direction
     * for offboarding someone else.
     */
    const revoked = await ctx.tx.execute<{ n: number }>(sql`
      WITH gone AS (
        UPDATE sessions SET revoked_at = now()
         WHERE user_id = ${m.user_id}::uuid AND revoked_at IS NULL
        RETURNING 1
      ) SELECT COUNT(*)::int n FROM gone
    `);
    const sessionsRevoked = revoked[0]?.n ?? 0;

    await writeAudit(ctx, {
      action: "user.deactivate",
      entityTable: "memberships",
      entityId: input.membershipId,
      diff: { name: m.full_name, from: m.status, to: "suspended", reason: input.reason, sessionsRevoked },
    });

    return { membershipId: input.membershipId, sessionsRevoked };
  });
}

// ── Reactivate ──────────────────────────────────────────────────────────────

export const reactivateUserInput = z.object({
  membershipId: z.uuid(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function reactivateUser(ctx: ServiceContext, raw: unknown) {
  const input = reactivateUserInput.parse(raw);
  requirePermission(ctx, "user:update");

  return withIdempotency(ctx, input.idempotencyKey, "reactivateUser", async () => {
    const [m] = await ctx.tx.execute<{ id: string; full_name: string | null; status: string }>(sql`
      SELECT m.id, u.full_name, m.status::text
        FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.id = ${input.membershipId}::uuid FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("Membership not found.", "not_found");

    await ctx.tx.execute(sql`
      UPDATE memberships SET status = 'active', updated_at = now()
       WHERE id = ${input.membershipId}::uuid
    `);
    // Deliberately does NOT restore sessions. Reactivation grants the ability to
    // sign in again; it does not resurrect tokens issued before the suspension.
    await writeAudit(ctx, {
      action: "user.reactivate",
      entityTable: "memberships",
      entityId: input.membershipId,
      diff: { name: m.full_name, from: m.status, to: "active" },
    });
    return { membershipId: input.membershipId };
  });
}

// ── Change role ─────────────────────────────────────────────────────────────

export const changeRoleInput = z.object({
  membershipId: z.uuid(),
  roleKey: z.string().min(2).max(40),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export async function changeRole(ctx: ServiceContext, raw: unknown) {
  const input = changeRoleInput.parse(raw);
  requirePermission(ctx, "user:update");

  return withIdempotency(ctx, input.idempotencyKey, "changeRole", async () => {
    // `roles.level` is jsonb holding a bare number, so it reads back through
    // ::text — the same idiom the session loader uses to build roleLevel.
    const [role] = await ctx.tx.execute<{ id: string; name: string; level: string }>(sql`
      SELECT id, name, level::text AS level FROM roles WHERE key = ${input.roleKey}
    `);
    if (!role) throw new ServiceError(`Unknown role "${input.roleKey}".`, "invalid");

    const [m] = await ctx.tx.execute<{
      id: string; user_id: string; full_name: string | null; role_key: string; role_level: string;
    }>(sql`
      SELECT m.id, m.user_id, u.full_name, r.key AS role_key, r.level::text AS role_level
        FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
       WHERE m.id = ${input.membershipId}::uuid FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("Membership not found.", "not_found");

    // Demoting yourself can strip the permission you need to undo it.
    if (m.user_id === ctx.principal.userId) {
      throw new ServiceError("You cannot change your own role.", "invalid");
    }

    assertRoleCeiling(ctx, {
      name: m.full_name,
      currentLevel: m.role_level,
      grantedLevel: role.level,
      grantedName: role.name,
    });

    await ctx.tx.execute(sql`
      UPDATE memberships SET role_id = ${role.id}::uuid, updated_at = now()
       WHERE id = ${input.membershipId}::uuid
    `);

    /**
     * A role change takes effect on the next REQUEST, not the next login,
     * because permissions are resolved per request from the membership. That is
     * the right behaviour for a demotion — the person should lose access
     * immediately, not whenever they next happen to sign out.
     */
    await writeAudit(ctx, {
      action: "user.change_role",
      entityTable: "memberships",
      entityId: input.membershipId,
      diff: { name: m.full_name, from: m.role_key, to: input.roleKey },
    });

    return { membershipId: input.membershipId, roleKey: input.roleKey };
  });
}

// ── Business-unit scope ─────────────────────────────────────────────────────

/**
 * THE SECOND CEILING: you may not hand out reach you do not have.
 *
 * `assertRoleCeiling` measures rank. This measures breadth, and the two are
 * independent — a `branch_manager` scoped to Royal Cuts holds level 60 whether
 * they can see one business or all seven. Without this check that manager
 * could invite a second `branch_manager` with tenant-wide scope, sign in as
 * them, and read the parking, property and contracting ledgers they were
 * explicitly excluded from. No rank was gained, so the rank ceiling sees
 * nothing wrong; the actual access still doubled.
 *
 * An empty list means TENANT-WIDE, which is why the empty case is checked
 * first and not treated as "nothing to verify". That inversion — where the
 * absence of a restriction is the widest possible grant — is exactly the shape
 * that gets waved through by a loop over an empty array.
 *
 * `requireBusinessUnit` is the same gate every posting path uses, so a scope
 * grant is authorised against precisely the list the ledger authorises writes
 * against. Two implementations of "which businesses may this person touch"
 * would eventually disagree, and the disagreement would be silent.
 */
function assertScopeCeiling(ctx: ServiceContext, businessUnitIds: string[]): void {
  if (businessUnitIds.length === 0) {
    if (ctx.principal.scope !== "tenant") {
      throw new ServiceError(
        "You can only grant access to the businesses you can see yourself, so you must name at least one.",
        "forbidden",
      );
    }
    return;
  }
  for (const id of businessUnitIds) requireBusinessUnit(ctx, id);
}

/**
 * Confirm every named business exists inside this tenant.
 *
 * RLS already stops a business unit from another tenant being read here, so
 * this is not the isolation control — it is the honesty control. Without it an
 * id that matches nothing is accepted, stored, and then silently dropped when
 * `membership_scopes` is written, and the screen reports a grant that does not
 * exist. A scope that says "Royal Cuts" while the database says "nothing" is
 * worse than a refusal, because nobody goes looking for it.
 */
async function assertBusinessUnitsExist(
  ctx: ServiceContext,
  businessUnitIds: string[],
): Promise<void> {
  if (businessUnitIds.length === 0) return;
  const found = await ctx.tx.execute<{ id: string }>(sql`
    SELECT id FROM business_units
     WHERE id = ANY(ARRAY[${sql.join(businessUnitIds.map((b) => sql`${b}::uuid`), sql`, `)}]::uuid[])
       AND deleted_at IS NULL
  `);
  if (found.length !== businessUnitIds.length) {
    throw new ServiceError("One of those businesses no longer exists.", "invalid");
  }
}

export const setMembershipScopeInput = z.object({
  membershipId: z.uuid(),
  /** Empty = every business in the tenant. See `assertScopeCeiling`. */
  businessUnitIds: z.array(z.uuid()).max(50).default([]),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Assign or edit which businesses an existing membership may touch.
 *
 * The users screen has always DISPLAYED scope — the chip next to the role —
 * and never offered a way to set it, so a branch manager's scope was whatever
 * the seed happened to give them and narrowing it meant an INSERT by hand into
 * `membership_scopes`. Displaying a control that cannot be operated is how a
 * screen quietly becomes decorative.
 *
 * Refuses to act on the caller's own membership, for the same reason
 * `changeRole` does: widening your own reach is straightforward escalation, and
 * narrowing it can strip the access you need to undo the change.
 *
 * `location` and `self` scoped memberships are refused rather than converted.
 * This function models one axis — businesses — and a membership scoped to a
 * single chair or to its own records is saying something this screen does not
 * express. Rewriting it to `business_unit` would silently widen it.
 */
export async function setMembershipScope(ctx: ServiceContext, raw: unknown) {
  const input = setMembershipScopeInput.parse(raw);
  requirePermission(ctx, "user:update");

  return withIdempotency(ctx, input.idempotencyKey, "setMembershipScope", async () => {
    const [m] = await ctx.tx.execute<{
      id: string; user_id: string; full_name: string | null; scope: string; role_level: string;
    }>(sql`
      SELECT m.id, m.user_id, u.full_name, m.scope::text, r.level::text AS role_level
        FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
       WHERE m.id = ${input.membershipId}::uuid
       FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("Membership not found.", "not_found");

    if (m.user_id === ctx.principal.userId) {
      throw new ServiceError("You cannot change which businesses you can see yourself.", "invalid");
    }
    if (m.scope === "location" || m.scope === "self") {
      throw new ServiceError(
        `${m.full_name ?? "That person"} is scoped to a ${m.scope.replace("_", " ")}, which this screen cannot edit.`,
        "invalid",
      );
    }

    assertRoleCeiling(ctx, { name: m.full_name, currentLevel: m.role_level });
    assertScopeCeiling(ctx, input.businessUnitIds);
    await assertBusinessUnitsExist(ctx, input.businessUnitIds);

    const before = await ctx.tx.execute<{ business_unit_id: string }>(sql`
      SELECT business_unit_id FROM membership_scopes
       WHERE membership_id = ${input.membershipId}::uuid AND business_unit_id IS NOT NULL
    `);

    // Business-unit rows only. A membership can also carry location rows, and
    // this function has no opinion about those — clearing them here would
    // revoke access nobody asked to revoke, from a form about businesses.
    await ctx.tx.execute(sql`
      DELETE FROM membership_scopes
       WHERE membership_id = ${input.membershipId}::uuid AND business_unit_id IS NOT NULL
    `);

    for (const businessUnitId of input.businessUnitIds) {
      await ctx.tx.execute(sql`
        INSERT INTO membership_scopes (id, tenant_id, membership_id, business_unit_id)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.membershipId}::uuid,
                ${businessUnitId}::uuid)
      `);
    }

    const scope = input.businessUnitIds.length === 0 ? "tenant" : "business_unit";
    await ctx.tx.execute(sql`
      UPDATE memberships SET scope = ${scope}::scope_level, updated_at = now()
       WHERE id = ${input.membershipId}::uuid
    `);

    /**
     * Like a role change, this lands on their NEXT REQUEST rather than their
     * next sign-in: `getSession` rebuilds `Principal.businessUnitIds` from
     * `membership_scopes` every time. That is the right behaviour for a
     * narrowing, which is the direction that matters.
     */
    await writeAudit(ctx, {
      action: "user.change_scope",
      entityTable: "memberships",
      entityId: input.membershipId,
      diff: {
        name: m.full_name,
        from: { scope: m.scope, businessUnitIds: before.map((b) => b.business_unit_id) },
        to: { scope, businessUnitIds: input.businessUnitIds },
      },
    });

    return { membershipId: input.membershipId, scope, businessUnitIds: input.businessUnitIds };
  });
}

// ── Invitations ─────────────────────────────────────────────────────────────

/**
 * How long a link is good for.
 *
 * Three days, not thirty. An invitation is a key to the company's books that
 * lives in somebody's chat history, forwarded inbox or screenshot, and the
 * window in which it can be stolen is exactly the window in which it works.
 * Three days survives a weekend and a missed message; it does not survive a
 * laptop being sold.
 */
export const INVITE_TTL_HOURS = 72;

/**
 * Token hashing — SHA-256, the same contract as `sessions.token_hash`.
 *
 * Not argon2: this is a 256-bit random token, not a human-chosen password, so
 * there is no dictionary to slow an attacker down against and nothing for a
 * work factor to buy. The property that matters is that a dump of
 * `user_invites` yields no usable link, and a plain cryptographic digest of a
 * value with 256 bits of entropy already gives that.
 */
function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Why a link cannot be redeemed, or `valid`. */
export type InviteStatus = "valid" | "expired" | "used" | "revoked" | "unknown";

/** `type`, not `interface`, so it carries the implicit index signature
 *  `tx.execute<T extends Record<string, unknown>>` asks for. */
type InviteRow = {
  id: string;
  tenant_id: string;
  email: string;
  role_id: string;
  role_key: string;
  role_name: string;
  scope: string;
  business_unit_ids: string[] | null;
  token_hash: string;
  expires_at: string;
  /** Computed by Postgres. See `findInvite` for why this is not a JS date. */
  expired: boolean;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/**
 * Fetch the invite a token names, in constant-ish time, and say why it fails.
 *
 * TWO comparisons, deliberately. The `WHERE token_hash = …` is an index lookup
 * and is how `sessions` has always resolved a cookie, but a B-tree probe is not
 * a constant-time comparison and it is the database, not this code, deciding
 * how long it takes. The `timingSafeEqual` afterwards is this module's own
 * guarantee: whatever the index did, nothing in application code short-circuits
 * on the first differing byte. It costs one hash comparison on a path that is
 * already rate-limited, and it removes the class of bug entirely rather than
 * arguing about whether it is exploitable over a network.
 *
 * A token that matches nothing returns `unknown` — never "no such invitation
 * for that email", because the caller is unauthenticated and any distinction
 * drawn here is an oracle about who has been invited.
 */
async function findInvite(
  tx: Tx,
  token: string,
  opts: { lock?: boolean } = {},
): Promise<{ status: InviteStatus; row?: InviteRow }> {
  const digest = hashInviteToken(token);
  const rows = await tx.execute<InviteRow>(
    opts.lock
      ? sql`
          SELECT i.id, i.tenant_id, i.email, i.role_id, r.key AS role_key, r.name AS role_name,
                 i.scope::text, i.business_unit_ids, i.token_hash,
                 i.expires_at::text, (i.expires_at <= now()) AS expired,
                 i.accepted_at::text, i.revoked_at::text, i.created_at::text
            FROM user_invites i JOIN roles r ON r.id = i.role_id
           WHERE i.token_hash = ${digest}
           FOR UPDATE OF i
        `
      : sql`
          SELECT i.id, i.tenant_id, i.email, i.role_id, r.key AS role_key, r.name AS role_name,
                 i.scope::text, i.business_unit_ids, i.token_hash,
                 i.expires_at::text, (i.expires_at <= now()) AS expired,
                 i.accepted_at::text, i.revoked_at::text, i.created_at::text
            FROM user_invites i JOIN roles r ON r.id = i.role_id
           WHERE i.token_hash = ${digest}
        `,
  );

  const row = rows[0];
  if (!row) return { status: "unknown" };

  const presented = Buffer.from(digest, "hex");
  const stored = Buffer.from(row.token_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return { status: "unknown" };
  }

  if (row.revoked_at) return { status: "revoked", row };
  if (row.accepted_at) return { status: "used", row };
  /**
   * Expiry is decided by POSTGRES, not by `Date.parse`.
   *
   * `expires_at::text` renders in the server's `DateStyle`, and JavaScript's
   * parser is lenient about the ISO-ish shape that produces — right up until it
   * is not, at which point `Date.parse` returns NaN and `NaN <= Date.now()` is
   * FALSE. The failure mode is therefore that every expired invitation becomes
   * permanently live, silently, because a database setting nobody associates
   * with authentication was changed. The comparison belongs where both operands
   * are timestamps.
   */
  if (row.expired) return { status: "expired", row };
  return { status: "valid", row };
}

/**
 * What the acceptance screen may show BEFORE anyone has proved anything.
 *
 * Deliberately thin: the address the invitation was sent to, the role, and the
 * company name. The address is echoed because the person holding the link needs
 * to know which mailbox it belongs to — it is the one fact they are presumed to
 * have already — and the role because agreeing to become an accountant is not
 * the same as agreeing to become a receptionist.
 *
 * Everything else stays behind the redemption: no inviter, no other members, no
 * business list. And nothing at all is returned unless the token is valid, so a
 * guessed tenant id plus a wrong token reveals not even the company's name.
 */
export async function previewInvite(
  tx: Tx,
  token: string,
): Promise<
  | { status: "valid"; email: string; roleKey: string; roleName: string; expiresAt: string; tenantName: string }
  | { status: Exclude<InviteStatus, "valid"> }
> {
  const found = await findInvite(tx, token);
  if (found.status !== "valid") return { status: found.status };
  const row = found.row!;

  const [tenant] = await tx.execute<{ name: string }>(sql`
    SELECT name FROM tenants WHERE id = ${row.tenant_id}::uuid
  `);

  return {
    status: "valid",
    email: row.email,
    roleKey: row.role_key,
    roleName: row.role_name,
    expiresAt: row.expires_at,
    tenantName: tenant?.name ?? "this business",
  };
}

export const createInviteInput = z.object({
  email: z.email().max(320),
  roleKey: z.string().min(2).max(60),
  /** Empty = every business in the tenant. See `assertScopeCeiling`. */
  businessUnitIds: z.array(z.uuid()).max(50).default([]),
});

/**
 * Invite somebody in.
 *
 * NOT wrapped in `withIdempotency`, and that is a security decision rather than
 * an oversight. `withIdempotency` stores the function's return value in
 * `idempotency_keys.result` so a retry can replay it — and this function's
 * return value contains the plaintext token. Replaying it would mean writing a
 * live credential into a second table in clear, for no benefit: the operation
 * is already safe to repeat, because re-inviting an address revokes the
 * previous link before minting a new one. A double-submitted form therefore
 * leaves exactly one working invitation, which is the outcome idempotency
 * would have bought, without persisting the secret to get there.
 *
 * The token is returned ONCE, here, and is unrecoverable afterwards — the
 * database holds only its SHA-256. That is the same contract as `api_tokens`,
 * and it is why "resend" is implemented as "invite again": there is nothing to
 * resend. The caller is responsible for getting the link to the person, which
 * today means an administrator copying it, because the product still has no
 * outbound delivery channel (FR-P03). Nothing here claims otherwise.
 */
export async function createInvite(ctx: ServiceContext, raw: unknown) {
  const input = createInviteInput.parse(raw);
  requirePermission(ctx, "user:invite");

  const email = input.email.trim().toLowerCase();

  const [role] = await ctx.tx.execute<{ id: string; name: string; key: string; level: string }>(sql`
    SELECT id, name, key, level::text AS level FROM roles WHERE key = ${input.roleKey}
  `);
  if (!role) throw new ServiceError(`Unknown role "${input.roleKey}".`, "invalid");

  /**
   * THE BYPASS THIS CLOSES.
   *
   * `changeRole` refuses to grant rank above the actor's own. An invite that
   * skipped this check would route straight around it: a level-60 manager
   * cannot promote anyone to `owner`, but could invite `newowner@…` as one,
   * accept their own invitation, and sign in with `["*"]`. The ceiling would
   * then protect only the accounts that happened to exist already, which is not
   * a ceiling. `currentLevel: null` because an invitation has no incumbent —
   * see `assertRoleCeiling`.
   */
  try {
    assertRoleCeiling(ctx, {
      name: email,
      currentLevel: null,
      grantedLevel: role.level,
      grantedName: role.name,
    });
    assertScopeCeiling(ctx, input.businessUnitIds);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "forbidden") {
      // The stream that records what was ATTEMPTED. A refused promotion is
      // unremarkable once; the same actor refused eleven times, walking down
      // the role list, is the story — and it is invisible in the audit log,
      // which only records what changed.
      security.denied({
        tenantId: ctx.tenantId,
        userId: ctx.principal.userId,
        actorRole: ctx.principal.roleKey,
        ip: ctx.ipAddress,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
        detail: {
          attempted: "user.invite",
          email,
          role: input.roleKey,
          actorRoleLevel: ctx.principal.roleLevel,
          grantedRoleLevel: role.level,
          reason: err.message,
        },
      });
    }
    throw err;
  }

  await assertBusinessUnitsExist(ctx, input.businessUnitIds);

  /**
   * Somebody who is already here does not need an invitation, and a suspended
   * membership must not be revivable by one.
   *
   * The second half is the point: `deactivateUser` revokes every session in the
   * same transaction as the suspension, and if an invite could quietly mint a
   * fresh `active` membership for the same person, offboarding would last
   * exactly as long as it took to send them a new link. Reinstatement stays
   * where it is auditable as reinstatement — `reactivateUser`.
   *
   * `memberships` is tenant-scoped, so this join answers only for THIS tenant
   * even though `users` is global. An accountant who serves another owner is
   * correctly invisible here.
   */
  const [existing] = await ctx.tx.execute<{ status: string; full_name: string }>(sql`
    SELECT m.status::text, u.full_name
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE lower(u.email) = ${email}
     LIMIT 1
  `);
  if (existing) {
    throw new ServiceError(
      existing.status === "active"
        ? `${existing.full_name} already has access.`
        : `${existing.full_name} was here before. Restore their access instead of inviting them again.`,
      "conflict",
    );
  }

  /**
   * Re-inviting replaces. The partial unique index `user_invites_pending_uq`
   * permits only one live invitation per address per tenant, so this is not
   * merely tidy — without it the INSERT below fails on the second attempt and
   * an administrator whose first link went astray has no way to issue another.
   * Revoking rather than deleting keeps "this link was superseded" answerable.
   */
  const superseded = await ctx.tx.execute<{ id: string }>(sql`
    UPDATE user_invites
       SET revoked_at = now(), revoked_by_user_id = ${ctx.principal.userId}::uuid, updated_at = now()
     WHERE tenant_id = ${ctx.tenantId}::uuid AND email = ${email}
       AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id
  `);

  // 256 bits, base64url so it survives being pasted into a URL, a chat window
  // and back out again without an encoding step that could mangle it.
  const token = randomBytes(32).toString("base64url");
  const scope = input.businessUnitIds.length === 0 ? "tenant" : "business_unit";

  const [invite] = await ctx.tx.execute<{ id: string; expires_at: string }>(sql`
    INSERT INTO user_invites
      (id, tenant_id, email, role_id, scope, business_unit_ids, token_hash,
       expires_at, invited_by_user_id)
    VALUES
      (gen_random_uuid(), ${ctx.tenantId}::uuid, ${email}, ${role.id}::uuid,
       ${scope}::scope_level, ${JSON.stringify(input.businessUnitIds)}::jsonb,
       ${hashInviteToken(token)},
       now() + (${INVITE_TTL_HOURS}::int * interval '1 hour'),
       ${ctx.principal.userId}::uuid)
    RETURNING id, expires_at::text
  `);

  // The token and its hash are BOTH absent from the diff. An audit log that
  // records the credential it is auditing is a second copy of the credential,
  // in the table most likely to be exported to a spreadsheet.
  await writeAudit(ctx, {
    action: "user.invite",
    entityTable: "user_invites",
    entityId: invite!.id,
    diff: {
      email,
      role: role.key,
      scope,
      businessUnitIds: input.businessUnitIds,
      expiresAt: invite!.expires_at,
      supersededInvites: superseded.length,
    },
  });

  return {
    inviteId: invite!.id,
    tenantId: ctx.tenantId,
    email,
    roleKey: role.key,
    roleName: role.name,
    scope,
    businessUnitIds: input.businessUnitIds,
    expiresAt: invite!.expires_at,
    supersededInvites: superseded.length,
    /** Plaintext, once. Never persisted, never logged, never audited. */
    token,
  };
}

export const revokeInviteInput = z.object({
  inviteId: z.uuid(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/**
 * Cancel a link that has not been used.
 *
 * Marked, never deleted — the same rule the rest of this file lives by. "Who
 * invited this person, and did the invitation ever get taken up?" has to stay
 * answerable after the answer becomes inconvenient.
 */
export async function revokeInvite(ctx: ServiceContext, raw: unknown) {
  const input = revokeInviteInput.parse(raw);
  requirePermission(ctx, "user:invite");

  return withIdempotency(ctx, input.idempotencyKey, "revokeInvite", async () => {
    const [invite] = await ctx.tx.execute<{
      id: string; email: string; accepted_at: string | null; revoked_at: string | null;
    }>(sql`
      SELECT id, email, accepted_at::text, revoked_at::text
        FROM user_invites WHERE id = ${input.inviteId}::uuid FOR UPDATE
    `);
    if (!invite) throw new ServiceError("That invitation no longer exists.", "not_found");
    if (invite.accepted_at) {
      throw new ServiceError(
        "That invitation has already been accepted. Remove their access instead.",
        "conflict",
      );
    }
    if (invite.revoked_at) {
      throw new ServiceError("That invitation was already cancelled.", "conflict");
    }

    await ctx.tx.execute(sql`
      UPDATE user_invites
         SET revoked_at = now(), revoked_by_user_id = ${ctx.principal.userId}::uuid,
             updated_at = now()
       WHERE id = ${input.inviteId}::uuid
    `);

    await writeAudit(ctx, {
      action: "user.invite_revoke",
      entityTable: "user_invites",
      entityId: input.inviteId,
      diff: { email: invite.email },
    });

    return { inviteId: input.inviteId, email: invite.email };
  });
}

// ── Acceptance ──────────────────────────────────────────────────────────────

export const acceptInviteInput = z.object({
  token: z.string().min(20).max(200),
  fullName: z.string().trim().min(2).max(200),
  /**
   * Already an argon2id hash when it gets here.
   *
   * Hashing lives in `apps/web/src/lib/crypto.ts` — one file, deliberately, so
   * the security review has a single surface for every credential primitive —
   * and `@nexus/core` does not depend on the argon2 binding. Passing the hash
   * across the boundary keeps it that way, and means this service never holds
   * a plaintext password at all: there is no variable here that could end up in
   * an error message, a log line or a stack trace.
   */
  passwordHash: z.string().min(20).max(512).startsWith("$argon2"),
});

export interface AcceptInviteContext {
  tx: Tx;
  /** From the invitation URL. See the docblock on `acceptInvite`. */
  tenantId: string;
  baseCurrency: string;
  today: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AcceptInviteResult {
  /** `created` minted a new account; `linked` attached an existing one. */
  outcome: "created" | "linked";
  userId: string;
  membershipId: string;
  email: string;
  roleKey: string;
  businessUnitsGranted: number;
}

/**
 * Redeem an invitation. THE ONLY UNAUTHENTICATED WRITE IN THE PRODUCT.
 *
 * Everything else in this layer starts from a `ServiceContext` carrying a
 * `Principal`, and calls `requirePermission` before it reads anything. This
 * cannot: the whole point is that the caller has no account yet. So the token
 * IS the authorisation, and the controls that would normally be a permission
 * check are these instead:
 *
 *  1. SINGLE USE, ENFORCED BY A ROW LOCK. `findInvite` takes `FOR UPDATE`, and
 *     `accepted_at` is stamped inside the same transaction as the membership.
 *     Two simultaneous redemptions of one link serialise, and the second sees
 *     `used`. Checking `accepted_at` before the lock would be check-then-act,
 *     and the prize for winning that race is two memberships from one invite.
 *
 *  2. THE TENANT COMES FROM THE URL, and that is safe for one specific reason.
 *     `user_invites` is tenant-scoped, so RLS will not show the row without
 *     `app.tenant_id` set — and there is no session to read it from. The link
 *     therefore carries the tenant id beside the secret. An attacker supplying
 *     someone else's tenant id opens a transaction scoped to that tenant, which
 *     sounds alarming and buys nothing: the only statement issued before the
 *     token is verified is a lookup by token hash, which returns their own row
 *     or nothing. Nothing is read, and nothing is written, until a 256-bit
 *     secret has matched. The tenant id is an addressing detail, not a
 *     credential, and it is treated as one.
 *
 *  3. AN EXISTING ACCOUNT IS NEVER TAKEN OVER. If the invited address already
 *     has a `users` row, this creates the membership and stops. It does not set
 *     `password_hash`, because that would let anyone who can mint an invitation
 *     — every `user:invite` holder — overwrite the password of any address they
 *     can name, including an owner of another tenant. It does not repoint
 *     `default_tenant_id` when one is set, because that would silently move
 *     somebody else's sign-in to the inviter's tenant. And the caller is told
 *     `linked`, not `created`, precisely so it knows not to issue a session for
 *     an account whose password nobody just proved they know.
 *
 *  4. NO EMAIL IS MARKED VERIFIED. There is still no outbound delivery channel
 *     (FR-P03), so the link reached its holder by an administrator passing it
 *     on, not by arriving in the mailbox it names. Redeeming it therefore
 *     proves nothing about the address, and `email_verified_at` stays NULL
 *     rather than recording a verification that never happened.
 *
 * Rate limiting and the security-event emissions for FAILED attempts belong to
 * the caller, which is the layer that knows the client's IP. See
 * `apps/web/src/lib/actions/invites.ts`.
 */
export async function acceptInvite(
  ctx: AcceptInviteContext,
  raw: unknown,
): Promise<AcceptInviteResult> {
  const input = acceptInviteInput.parse(raw);

  const { status, row } = await findInvite(ctx.tx, input.token, { lock: true });
  if (status !== "valid" || !row) {
    throw new ServiceError(
      status === "expired"
        ? "This invitation has expired. Ask whoever invited you for a new link."
        : status === "used"
          ? "This invitation has already been used. Sign in instead."
          : status === "revoked"
            ? "This invitation was cancelled."
            : "This invitation link is not valid.",
      status === "unknown" ? "not_found" : "invalid",
    );
  }

  // Belt and braces against a link built by hand: RLS already scopes the read
  // to `app.tenant_id`, so a mismatch here should be unreachable. If it ever
  // happens, the tenant context and the row disagree and the safe move is to
  // write nothing.
  if (row.tenant_id !== ctx.tenantId) {
    throw new ServiceError("This invitation link is not valid.", "not_found");
  }

  const [existingUser] = await ctx.tx.execute<{
    id: string; default_tenant_id: string | null; full_name: string;
  }>(sql`
    SELECT id, default_tenant_id, full_name FROM users WHERE lower(email) = ${row.email} LIMIT 1
  `);

  let userId: string;
  let outcome: AcceptInviteResult["outcome"];

  if (existingUser) {
    userId = existingUser.id;
    outcome = "linked";
    // Only when there is none. Overwriting would move an existing user's
    // sign-in destination into the inviting tenant — see rule 3 above.
    if (!existingUser.default_tenant_id) {
      await ctx.tx.execute(sql`
        UPDATE users SET default_tenant_id = ${ctx.tenantId}::uuid, updated_at = now()
         WHERE id = ${userId}::uuid
      `);
    }
  } else {
    outcome = "created";
    const [created] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO users (id, email, full_name, password_hash, default_tenant_id)
      VALUES (gen_random_uuid(), ${row.email}, ${input.fullName}, ${input.passwordHash},
              ${ctx.tenantId}::uuid)
      RETURNING id
    `);
    userId = created!.id;
  }

  /**
   * A suspended membership is not resurrected here.
   *
   * `createInvite` refuses to issue a link to anyone who already has a
   * membership, so reaching this branch means one appeared between the
   * invitation and its acceptance. `ON CONFLICT DO NOTHING` plus an explicit
   * re-read is what makes that a refusal rather than a silent reinstatement:
   * an offboarding that a stale link can undo is not an offboarding.
   */
  const inserted = await ctx.tx.execute<{ id: string }>(sql`
    INSERT INTO memberships
      (id, tenant_id, user_id, role_id, status, scope, invited_at, accepted_at)
    VALUES
      (gen_random_uuid(), ${ctx.tenantId}::uuid, ${userId}::uuid, ${row.role_id}::uuid,
       'active', ${row.scope}::scope_level, ${row.created_at}::timestamptz, now())
    ON CONFLICT (tenant_id, user_id) DO NOTHING
    RETURNING id
  `);
  if (inserted.length === 0) {
    throw new ServiceError(
      "That account already belongs to this business. Sign in instead.",
      "conflict",
    );
  }
  const membershipId = inserted[0]!.id;

  /**
   * Copy the intended scope into the table that actually governs access.
   *
   * Filtered through `business_units` rather than inserted blind: a business
   * closed between the invitation and its acceptance would otherwise fail the
   * foreign key and reject the whole redemption, so a new employee's first
   * morning would end at an error page over a line in an invitation that was
   * never about them. The count comes back so the caller can say what was
   * actually granted instead of what was asked for.
   */
  const wanted = (row.business_unit_ids ?? []).filter((b) => typeof b === "string");
  let businessUnitsGranted = 0;
  if (wanted.length > 0) {
    const granted = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO membership_scopes (id, tenant_id, membership_id, business_unit_id)
      SELECT gen_random_uuid(), ${ctx.tenantId}::uuid, ${membershipId}::uuid, bu.id
        FROM business_units bu
       WHERE bu.id = ANY(ARRAY[${sql.join(wanted.map((b) => sql`${b}::uuid`), sql`, `)}]::uuid[])
         AND bu.deleted_at IS NULL
      RETURNING id
    `);
    businessUnitsGranted = granted.length;
  }

  await ctx.tx.execute(sql`
    UPDATE user_invites
       SET accepted_at = now(), accepted_user_id = ${userId}::uuid, updated_at = now()
     WHERE id = ${row.id}::uuid
  `);

  /**
   * The actor on this audit row is the person who just joined, because they
   * are: nobody else did anything at this moment. The principal below exists
   * only to satisfy `writeAudit`'s contract — it is never returned, never
   * cached, and never passed to `requirePermission`. Its permission set is
   * empty deliberately, so that if it ever does escape into an authorisation
   * check the answer is "no" rather than "everything".
   */
  const auditCtx: ServiceContext = {
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    today: ctx.today,
    baseCurrency: ctx.baseCurrency,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    principal: {
      userId,
      tenantId: ctx.tenantId,
      membershipId,
      roleKey: row.role_key,
      roleLevel: Number.NEGATIVE_INFINITY,
      scope: row.scope as "tenant" | "business_unit" | "location" | "self",
      businessUnitIds: [],
      locationIds: [],
      permissions: new Set<string>(),
      isPlatformAdmin: false,
    },
  };

  await writeAudit(auditCtx, {
    action: "user.invite_accept",
    entityTable: "memberships",
    entityId: membershipId,
    diff: {
      email: row.email,
      role: row.role_key,
      scope: row.scope,
      inviteId: row.id,
      outcome,
      businessUnitsRequested: wanted.length,
      businessUnitsGranted,
    },
  });

  return {
    outcome,
    userId,
    membershipId,
    email: row.email,
    roleKey: row.role_key,
    businessUnitsGranted,
  };
}
