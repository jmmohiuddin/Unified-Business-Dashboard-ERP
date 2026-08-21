"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { createHash } from "node:crypto";
import { withTenant } from "@nexus/db";
import {
  ServiceError,
  acceptInvite,
  createInvite,
  INVITE_TTL_HOURS,
  reportError,
  revokeInvite,
  security,
  setMembershipScope,
  type ServiceContext,
} from "@nexus/core";
import { createSession, requireSession } from "../session";
import { mfaRequiredFor, setAuthLevel } from "../mfa";
import { hashPassword, validatePasswordStrength } from "../crypto";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";
import type { ActionResult } from "../actions";

/**
 * INVITATIONS AND SCOPE — server actions.
 *
 * Split out of `lib/actions.ts` rather than added to it, in line with the
 * module-per-feature convention this directory now follows. The adapter shape
 * is deliberately identical to the shared file's — build a `ServiceContext`,
 * call the service, translate the outcome, revalidate — because every rule that
 * matters (permission, ceiling, audit, single-use) lives in
 * `@nexus/core/services/users.ts` and must be identical for a future mobile
 * client that never runs a Server Action at all.
 *
 * One thing here is genuinely different from every other action module, and it
 * is the reason this file needs reading rather than skimming: `acceptInvite`
 * runs for a caller with NO SESSION. It is the newest unauthenticated write
 * surface in the product, so the protections a session would normally provide
 * are re-created explicitly below — throttling by IP and by token, a refusal to
 * distinguish one failure from another, and security events on the attempts
 * that fail rather than only on the ones that succeed.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Session = Awaited<ReturnType<typeof requireSession>>;

async function buildContext(tx: Tx, session: Session): Promise<ServiceContext> {
  const h = await headers();
  const ip = h.get("x-client-ip");
  return {
    tx,
    tenantId: session.tenantId,
    principal: session.principal,
    today: resolveToday(session.timezone),
    baseCurrency: session.baseCurrency,
    ipAddress: ip && ip !== "local" ? ip : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

/** Same blunt backstop as `writeBudget` in lib/actions.ts, keyed the same way
 *  so a script cannot spend one budget by switching to the other module. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Some of those values are not valid." };
  }
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** Repeated checkbox fields — `getAll`, because a single `get` silently keeps
 *  only the first business the administrator ticked. */
const strList = (fd: FormData, key: string): string[] =>
  fd
    .getAll(key)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * The link an administrator has to pass on by hand.
 *
 * The tenant id is in the path because acceptance is unauthenticated and
 * `user_invites` is RLS-scoped — there is no session to read the tenant from,
 * so it has to travel with the token. See the docblock on `acceptInvite` for
 * why that is an addressing detail rather than a second credential.
 *
 * `NEXT_PUBLIC_APP_URL` gives an absolute link when it is configured, because
 * a relative path is useless in a WhatsApp message. Where it is not set the
 * path is returned as-is rather than guessing a hostname — a link to the wrong
 * origin is worse than one the administrator has to prefix themselves.
 */
function inviteLink(tenantId: string, token: string): string {
  const path = `/invite/${tenantId}/${token}`;
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  return origin ? `${origin}${path}` : path;
}

// ── Invite ──────────────────────────────────────────────────────────────────

/**
 * Create an invitation and hand the link back to the administrator.
 *
 * The link is in the SUCCESS MESSAGE, not in an email, and the message says so.
 * There is still no outbound delivery channel — `consoleProvider` is the only
 * `DeliveryProvider` implementation in the product (FR-P03) — and a wave-1
 * finding was the outbox marking undelivered messages `success`. Telling the
 * user "we have emailed them" would be the same lie in a new place. It is also
 * the only chance to show it: the database keeps a SHA-256, so the token cannot
 * be re-read afterwards and reissuing means inviting again.
 */
export async function inviteUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createInvite(await buildContext(tx, session), {
          email: str(formData, "email"),
          roleKey: str(formData, "roleKey"),
          businessUnitIds: strList(formData, "businessUnitIds"),
        }),
    );
    revalidatePath("/settings/users");
    return {
      ok: true,
      message:
        `Invitation ready for ${result.email} as ${result.roleName}. ` +
        `Nothing has been sent — copy this link to them yourself. It is shown ` +
        `only once and expires in ${INVITE_TTL_HOURS / 24} days: ` +
        `${inviteLink(result.tenantId, result.token)}`,
      data: { link: inviteLink(result.tenantId, result.token), expiresAt: result.expiresAt },
    };
  } catch (err) {
    return toResult(err);
  }
}

export async function revokeInviteAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        revokeInvite(await buildContext(tx, session), {
          inviteId: str(formData, "inviteId"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/users");
    return { ok: true, message: `The link sent to ${result.email} no longer works.` };
  } catch (err) {
    return toResult(err);
  }
}

// ── Scope ───────────────────────────────────────────────────────────────────

export async function setMembershipScopeAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        setMembershipScope(await buildContext(tx, session), {
          membershipId: str(formData, "membershipId"),
          businessUnitIds: strList(formData, "businessUnitIds"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/users");
    return {
      ok: true,
      message:
        result.scope === "tenant"
          ? "They can now see every business. It applies on their next request."
          : `Limited to ${result.businessUnitIds.length} business${result.businessUnitIds.length === 1 ? "" : "es"}. It applies on their next request.`,
    };
  } catch (err) {
    return toResult(err);
  }
}


// ── Acceptance (unauthenticated) ────────────────────────────────────────────

/**
 * Throttle a caller who has no account to throttle.
 *
 * Two independent limits, mirroring the login form's reasoning:
 *
 *   BY IP     — stops a script walking the token space from one place. Twenty
 *               attempts in five minutes is far past a person mistyping a name.
 *   BY TOKEN  — stops the same link being pounded from a rotating set of
 *               addresses, which is the shape the IP limit alone misses.
 *
 * The token key is a SHORT PREFIX OF ITS DIGEST, never the token and never the
 * full hash. `rate_limit_hits` is an operational table that is pruned nightly,
 * pasted into support tickets and read by anyone debugging a throttle; putting
 * the credential — or the exact value stored in `user_invites.token_hash` — in
 * it would undo the reason the token is hashed at all. Sixteen hex characters
 * distinguish one link from another without reconstructing either.
 *
 * A brute force against a 256-bit token was never going to succeed. What the
 * limit actually buys is that it cannot be attempted at a rate that costs the
 * database anything, and that the attempt is visible while it is happening.
 */
async function acceptBudget(token: string): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-client-ip") ?? "local";
  const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);

  const byIp = await rateLimit(`invite:ip:${ip}`, 20, 300);
  const byToken = await rateLimit(`invite:tok:${fingerprint}`, 10, 300);
  if (byIp.allowed && byToken.allowed) return null;

  security.throttled({
    ip,
    userAgent: h.get("user-agent") ?? undefined,
    detail: { surface: "invite.accept", limit: byIp.allowed ? "token" : "ip", fingerprint },
  });
  return "Too many attempts. Wait a few minutes and try again.";
}

/** What the redemption produced, before any cookie has been written. */
type Redeemed =
  | { ok: false; message: string }
  | {
      ok: true;
      outcome: "created" | "linked";
      userId: string;
      tenantId: string;
      roleKey: string;
    };

/**
 * The write half. Returns rather than redirects, because `redirect()` throws
 * and must be called outside the try block that translates service errors —
 * a NEXT_REDIRECT swallowed by a `catch (err)` becomes "Something went wrong"
 * on a request that in fact succeeded completely.
 */
async function redeem(formData: FormData): Promise<Redeemed> {
  const tenantId = str(formData, "tenantId");
  const token = str(formData, "token");
  const fullName = str(formData, "fullName");
  const password =
    typeof formData.get("password") === "string" ? String(formData.get("password")) : "";

  if (!tenantId || !token) return { ok: false, message: "This invitation link is not valid." };

  const throttledMessage = await acceptBudget(token);
  if (throttledMessage) return { ok: false, message: throttledMessage };

  // Checked before the work, and in this order, so an invitee is told their
  // password is too short without a database round trip — and so a weak
  // password cannot be hashed and stored by a slow path that gave up later.
  const weak = validatePasswordStrength(password);
  if (weak) return { ok: false, message: weak };
  if (!fullName) return { ok: false, message: "Tell us your name." };

  const h = await headers();
  const rawIp = h.get("x-client-ip");
  const userAgent = h.get("user-agent") ?? undefined;
  const ip = rawIp && rawIp !== "local" ? rawIp : undefined;

  /**
   * Hashed BEFORE the transaction opens.
   *
   * argon2id at 64 MiB and 3 iterations is deliberately 50-80 ms of CPU, and
   * this is an unauthenticated endpoint. Doing it inside the transaction would
   * hold a pooled connection — and, once `findInvite` has taken `FOR UPDATE`,
   * a row lock — across work an anonymous caller can trigger at will.
   */
  const passwordHash = await hashPassword(password);

  try {
    const result = await withTenant({ tenantId }, async (tx) => {
      // Read inside the same transaction so the currency and timezone the audit
      // context carries are this tenant's rather than a default.
      const [tenant] = await tx.execute<{ base_currency: string; timezone: string }>(sql`
        SELECT base_currency, timezone FROM tenants WHERE id = ${tenantId}::uuid
      `);
      return acceptInvite(
        {
          tx,
          tenantId,
          baseCurrency: tenant?.base_currency ?? "AED",
          today: resolveToday(tenant?.timezone ?? "Asia/Dubai"),
          ipAddress: ip,
          userAgent,
        },
        { token, fullName, passwordHash },
      );
    });

    security.loginSuccess({
      tenantId,
      userId: result.userId,
      actorRole: result.roleKey,
      ip,
      userAgent,
      detail: {
        surface: "invite.accept",
        email: result.email,
        outcome: result.outcome,
        businessUnitsGranted: result.businessUnitsGranted,
      },
    });

    return {
      ok: true,
      outcome: result.outcome,
      userId: result.userId,
      tenantId,
      roleKey: result.roleKey,
    };
  } catch (err) {
    if (err instanceof ServiceError) {
      /**
       * A failed redemption belongs in the stream that records ATTEMPTS.
       *
       * There is nothing for the audit log to hold — nothing changed — and that
       * asymmetry is the whole reason the security stream exists separately.
       * Only the reason code travels: the message names the state of the link,
       * and the detail must not name the address the link was issued to.
       */
      security.loginFailure({
        tenantId,
        ip,
        userAgent,
        detail: { surface: "invite.accept", reason: err.code },
      });
      return { ok: false, message: err.message };
    }
    if (err instanceof Error && err.name === "ZodError") {
      return { ok: false, message: "Check the name and password you entered." };
    }
    reportError(err, "invite-accept");
    return { ok: false, message: "Something went wrong. Nothing was saved." };
  }
}

/**
 * Redeem an invitation, then put the new arrival somewhere coherent.
 *
 * Three destinations, and the difference between the first two is the reason
 * this cannot simply redirect to "/":
 *
 *  `created` + MFA-REQUIRED ROLE → `/settings/security?mfa=required`.
 *      An invited owner, accountant or general manager is subject to
 *      `MFA_REQUIRED_ROLES` from their very first request. Issuing a `full`
 *      marker here would hand exactly those roles — the ones that can move
 *      money — a way to skip the enrolment the login path enforces, simply by
 *      arriving through the invitation instead. So the session is stamped
 *      `mfa_setup`, which proxy.ts confines to the enrolment page, and they are
 *      sent straight there rather than being bounced off "/" by a redirect they
 *      did not ask for and cannot explain.
 *
 *  `created` + any other role → `/`. They chose the password a moment ago, so
 *      a session is theirs to hold.
 *
 *  `linked` → STAYS PUT, with an explanation. The address already had an
 *      account and this redemption did NOT set its password. Issuing a session
 *      would mean authenticating somebody on the strength of a link an
 *      administrator minted and could equally have opened themselves — the
 *      account-takeover path `acceptInvite` refuses to walk. So no session is
 *      issued, and rather than dropping them on a sign-in form with no idea
 *      what just happened, the page tells them what changed and points at the
 *      sign-in link it already renders. A redirect carrying an explanatory
 *      query parameter was the alternative, and `/login` does not read one —
 *      a link that promises a message the target never shows is the defect
 *      `check:routes` exists to catch.
 */
export async function acceptInviteAction(formData: FormData): Promise<ActionResult> {
  const result = await redeem(formData);
  if (!result.ok) return { ok: false, message: result.message };

  if (result.outcome === "linked") {
    return {
      ok: true,
      message:
        "You already had a Nexus account with this address, and it now has access. " +
        "Sign in with the password you already use — it has not been changed.",
    };
  }

  const token = await createSession(result.userId, result.tenantId);
  const needsMfa = mfaRequiredFor(result.roleKey);
  await setAuthLevel(needsMfa ? "mfa_setup" : "full", token);

  redirect(needsMfa ? "/settings/security?mfa=required" : "/");
}
