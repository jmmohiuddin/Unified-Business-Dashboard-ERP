import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ServiceError,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

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
 * Nothing is ever deleted. The membership is suspended and the user row and
 * their entire audit history survive — an ERP has to answer "who did this" for
 * people who left years ago.
 */

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
      id: string; user_id: string; status: string; full_name: string | null;
    }>(sql`
      SELECT m.id, m.user_id, m.status::text, u.full_name
        FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.id = ${input.membershipId}::uuid
       FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("That person is not a member of this business.", "not_found");

    // Removing your own access locks you out of the screen you are standing on,
    // and there may be no one else who can undo it.
    if (m.user_id === ctx.principal.userId) {
      throw new ServiceError("You cannot deactivate your own access.", "invalid");
    }
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
    const [role] = await ctx.tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM roles WHERE key = ${input.roleKey}
    `);
    if (!role) throw new ServiceError(`Unknown role "${input.roleKey}".`, "invalid");

    const [m] = await ctx.tx.execute<{
      id: string; user_id: string; full_name: string | null; role_key: string;
    }>(sql`
      SELECT m.id, m.user_id, u.full_name, r.key AS role_key
        FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
       WHERE m.id = ${input.membershipId}::uuid FOR UPDATE OF m
    `);
    if (!m) throw new ServiceError("Membership not found.", "not_found");

    // Demoting yourself can strip the permission you need to undo it.
    if (m.user_id === ctx.principal.userId) {
      throw new ServiceError("You cannot change your own role.", "invalid");
    }

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
