import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can } from "@nexus/core";
import { requireSession } from "@/lib/session";
import {
  changeRoleAction,
  deactivateUserAction,
  reactivateUserAction,
} from "@/lib/actions";
import {
  inviteUserAction,
  revokeInviteAction,
  setMembershipScopeAction,
} from "@/lib/actions/invites";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { Card, CardHeader, Chip } from "@/components/ui";
import { PageHeader, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * People and access.
 *
 * The product had no way to change who could do what. Every staff change was a
 * direct database edit, which made offboarding an engineering task — and
 * editing the row did nothing to the sessions that person already held, so
 * their access continued until the token expired on its own.
 *
 * The line that matters on this screen is the one under "Remove access":
 * deactivation signs them out of every device in the same transaction.
 *
 * Onboarding arrived later and is the other half of the same screen. Two things
 * about it are visible here and both are deliberate:
 *
 *   THE LINK IS SHOWN, NOT SENT. There is still no outbound delivery channel —
 *   `consoleProvider` is the only `DeliveryProvider` in the product (FR-P03) —
 *   so the invitation comes back as a link for the administrator to pass on,
 *   and the screen says so in those words. A message reading "we have emailed
 *   them" would be the wave-1 outbox defect in a new place: a `success` shown
 *   for something nobody delivered.
 *
 *   IT IS SHOWN ONCE. The database keeps only a SHA-256 of the token, exactly
 *   as it does for sessions and API tokens, so the link cannot be re-read
 *   afterwards. "Send again" is therefore "invite again", which mints a new
 *   link and kills the old one.
 *
 * THE ROLE AND BUSINESS LISTS ARE FILTERED TO WHAT THE VIEWER MAY ACTUALLY
 * GRANT. That filtering is a courtesy, not the control: `createInvite`,
 * `changeRole` and `setMembershipScope` all re-check the ceiling server-side,
 * because a `<select>` is a suggestion and a form post is not.
 *
 * Five states (WF-05 §0): default and empty are below; loading is `loading.tsx`
 * beside this file; error is the `(app)/error.tsx` boundary; permission-denied
 * is the notice rendered when the viewer lacks `user:update`, which also
 * removes every form rather than showing controls that would be refused.
 */
export default async function UsersPage() {
  const session = await requireSession();
  const mayManage = can(session.principal, "user:update");
  const mayInvite = can(session.principal, "user:invite");

  const data = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const rows = await tx.execute<{
        membership_id: string; user_id: string; full_name: string | null;
        email: string | null; role_key: string; role_name: string;
        status: string; scope: string; mfa_enabled: boolean; last_seen: string | null;
        live_sessions: number;
      }>(sql`
        SELECT m.id AS membership_id, u.id AS user_id, u.full_name, u.email,
               r.key AS role_key, r.name AS role_name,
               m.status::text, m.scope::text,
               (u.mfa_enabled_at IS NOT NULL) AS mfa_enabled,
               to_char(u.last_login_at, 'DD Mon YYYY') AS last_seen,
               (SELECT COUNT(*)::int FROM sessions s
                 WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())
                 AS live_sessions
          FROM memberships m
          JOIN users u ON u.id = m.user_id
          JOIN roles r ON r.id = m.role_id
         ORDER BY (m.status = 'active') DESC, r.level DESC NULLS LAST, u.full_name
      `);

      const roles = await tx.execute<{ key: string; name: string; level: string }>(sql`
        SELECT key, name, level::text AS level FROM roles ORDER BY level DESC NULLS LAST, name
      `);

      const businessUnits = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM business_units WHERE deleted_at IS NULL ORDER BY name
      `);

      // One query for every membership's business scope, joined in memory —
      // seven businesses and a handful of staff do not justify a lateral.
      const scopes = await tx.execute<{ membership_id: string; business_unit_id: string }>(sql`
        SELECT membership_id, business_unit_id FROM membership_scopes
         WHERE business_unit_id IS NOT NULL
      `);

      const invites = await tx.execute<{
        id: string; email: string; role_name: string; scope: string;
        business_unit_ids: string[] | null; expires_label: string; expired: boolean;
        invited_by: string | null;
      }>(sql`
        SELECT i.id, i.email, r.name AS role_name, i.scope::text,
               i.business_unit_ids,
               to_char(i.expires_at, 'DD Mon, HH24:MI') AS expires_label,
               (i.expires_at <= now()) AS expired,
               inviter.full_name AS invited_by
          FROM user_invites i
          JOIN roles r ON r.id = i.role_id
          LEFT JOIN users inviter ON inviter.id = i.invited_by_user_id
         WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
         ORDER BY i.created_at DESC
      `);

      return { rows, roles, businessUnits, scopes, invites };
    },
  );

  /**
   * What this viewer may hand out.
   *
   * Mirrors `assertRoleCeiling` — at or below the viewer's own rank, `<=` and
   * not `<` for the same reason stated there — and `assertScopeCeiling` for the
   * business list. A role or a business that would be refused is not offered,
   * so the form cannot produce a request the service will reject.
   */
  const grantableRoles = data.roles.filter(
    (r) => Number(r.level) <= session.principal.roleLevel,
  );
  const roleOptions = grantableRoles.map((r) => ({ value: r.key, label: r.name }));
  const grantableUnits =
    session.principal.scope === "tenant"
      ? data.businessUnits
      : data.businessUnits.filter((b) => session.principal.businessUnitIds?.includes(b.id));

  const unitName = new Map(data.businessUnits.map((b) => [b.id, b.name]));
  const scopeOf = new Map<string, string[]>();
  for (const s of data.scopes) {
    scopeOf.set(s.membership_id, [...(scopeOf.get(s.membership_id) ?? []), s.business_unit_id]);
  }

  const active = data.rows.filter((r) => r.status === "active");
  const inactive = data.rows.filter((r) => r.status !== "active");

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="People and access"
        subtitle={`${active.length} active · ${data.invites.length} invited · ${inactive.length} deactivated`}
      />

      {!mayManage && (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            You can see who has access, but not change it. That needs the{" "}
            <code className="text-2xs">user:update</code> permission.
          </p>
        </Card>
      )}

      {mayInvite && (
        <Card>
          <CardHeader
            title="Invite someone"
            subtitle="Their role and which businesses they can see are decided now, not by them"
          />
          <div className="px-4 pb-4">
            <ActionForm action={inviteUserAction} submitLabel="Create invitation">
              <div className="grid gap-2 sm:grid-cols-2">
                <Field
                  name="email"
                  label="Email"
                  type="email"
                  required
                  placeholder="maya@sumon.test"
                />
                <Field name="roleKey" label="Role" options={roleOptions} />
              </div>

              <fieldset className="mt-3">
                <legend className="label mb-1.5">Businesses they can see</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {grantableUnits.map((b) => (
                    <label key={b.id} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="businessUnitIds" value={b.id} />
                      {b.name}
                    </label>
                  ))}
                </div>
                <p className="text-2xs text-subtle mt-1.5 leading-relaxed">
                  {session.principal.scope === "tenant"
                    ? "Tick none to give them every business."
                    : "You can only grant the businesses you can see yourself, so tick at least one."}
                </p>
              </fieldset>

              <p className="text-2xs mt-3 leading-relaxed" style={{ color: "var(--caution)" }}>
                Nothing is emailed — the product has no delivery channel yet. The
                link appears here once, expires in three days, and works only
                once. Copy it to them yourself.
              </p>
            </ActionForm>
          </div>
        </Card>
      )}

      {mayInvite && (
        <Card>
          <CardHeader title="Waiting to accept" subtitle="Links that have not been used yet" />
          <div className="px-4 pb-4 space-y-2">
            {data.invites.length === 0 ? (
              <TableEmpty
                title="Nobody is waiting"
                detail="Invitations you create appear here until they are accepted, cancelled or expire."
              />
            ) : (
              data.invites.map((i) => (
                <div
                  key={i.id}
                  className="py-2.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{i.email}</p>
                      <p className="text-2xs text-subtle truncate">
                        {i.scope === "tenant"
                          ? "every business"
                          : (i.business_unit_ids ?? [])
                              .map((b) => unitName.get(b) ?? "a closed business")
                              .join(", ")}
                        {i.invited_by ? ` · invited by ${i.invited_by}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Chip tone="neutral">{i.role_name}</Chip>
                      <Chip tone={i.expired ? "caution" : "neutral"}>
                        {i.expired ? "expired" : `expires ${i.expires_label}`}
                      </Chip>
                    </div>
                  </div>
                  <div className="mt-2">
                    <ActionForm
                      action={revokeInviteAction}
                      submitLabel="Cancel invitation"
                      variant="ghost"
                      confirm="The link stops working immediately. Inviting them again creates a new one."
                    >
                      <input type="hidden" name="inviteId" value={i.id} />
                    </ActionForm>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Active" subtitle="Signed-in devices are shown per person" />
        <div className="px-4 pb-4 space-y-2">
          {active.map((u) => {
            const held = scopeOf.get(u.membership_id) ?? [];
            return (
              <div
                key={u.membership_id}
                className="py-2.5 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      {u.full_name ?? "Unnamed"}
                      {u.user_id === session.userId && (
                        <span className="text-2xs text-subtle font-normal"> · you</span>
                      )}
                    </p>
                    <p className="text-2xs text-subtle truncate">{u.email ?? "no email"}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Chip tone="neutral">{u.role_name}</Chip>
                    {u.scope !== "tenant" && <Chip tone="neutral">{u.scope}</Chip>}
                    <Chip tone={u.mfa_enabled ? "positive" : "caution"}>
                      {u.mfa_enabled ? "MFA on" : "MFA off"}
                    </Chip>
                  </div>
                </div>

                <p className="text-2xs text-subtle mt-1">
                  {u.scope === "tenant"
                    ? "Every business"
                    : held.length === 0
                      ? "No businesses — they can sign in and see nothing"
                      : held.map((b) => unitName.get(b) ?? "closed business").join(", ")}
                  {" · "}
                  {u.live_sessions} active session{u.live_sessions === 1 ? "" : "s"}
                  {u.last_seen ? ` · last seen ${u.last_seen}` : " · never signed in"}
                </p>

                {mayManage && u.user_id !== session.userId && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Disclosure summary="Change role">
                      <ActionForm action={changeRoleAction} submitLabel="Change role">
                        <input type="hidden" name="membershipId" value={u.membership_id} />
                        <Field
                          name="roleKey"
                          label="New role"
                          options={roleOptions}
                          defaultValue={u.role_key}
                        />
                        <p className="text-2xs text-subtle">
                          Applies on their next request, not their next sign-in — a
                          demotion takes effect immediately.
                        </p>
                      </ActionForm>
                    </Disclosure>

                    <Disclosure summary="Business access">
                      <ActionForm action={setMembershipScopeAction} submitLabel="Save access">
                        <input type="hidden" name="membershipId" value={u.membership_id} />
                        <fieldset>
                          <legend className="label mb-1.5">Businesses</legend>
                          <div className="grid gap-1">
                            {grantableUnits.map((b) => (
                              <label key={b.id} className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  name="businessUnitIds"
                                  value={b.id}
                                  defaultChecked={held.includes(b.id)}
                                />
                                {b.name}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <p className="text-2xs text-subtle mt-1.5 leading-relaxed">
                          {session.principal.scope === "tenant"
                            ? "Tick none to give them every business."
                            : "You can only grant the businesses you can see yourself."}
                          {" "}Applies on their next request.
                        </p>
                      </ActionForm>
                    </Disclosure>

                    <Disclosure summary="Remove access">
                      <ActionForm action={deactivateUserAction} submitLabel="Remove access">
                        <input type="hidden" name="membershipId" value={u.membership_id} />
                        <Field name="reason" label="Reason" placeholder="Left the company" />
                        <p className="text-2xs" style={{ color: "var(--caution)" }}>
                          They will be signed out of every device immediately.
                          Their record and everything they did stay in the system,
                          and you can restore access later.
                        </p>
                      </ActionForm>
                    </Disclosure>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {inactive.length > 0 && (
        <Card>
          <CardHeader title="Deactivated" subtitle="Records are kept — nothing is deleted" />
          <div className="px-4 pb-4 space-y-2">
            {inactive.map((u) => (
              <div
                key={u.membership_id}
                className="py-2.5 border-b last:border-0 flex items-center justify-between gap-3 flex-wrap"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{u.full_name ?? "Unnamed"}</p>
                  <p className="text-2xs text-subtle truncate">
                    {u.role_name} · {u.email ?? "no email"}
                  </p>
                </div>
                {mayManage && (
                  <ActionForm action={reactivateUserAction} submitLabel="Restore access">
                    <input type="hidden" name="membershipId" value={u.membership_id} />
                  </ActionForm>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="text-2xs text-subtle leading-relaxed">
        Every action on this screen is audited with the actor, the reason where
        one is asked for, and what changed. Deactivation additionally records how
        many sessions it revoked. Invitations record who issued them and whether
        they were ever accepted — the link itself is never written down anywhere,
        only its hash.
      </p>
    </div>
  );
}
