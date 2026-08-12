import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can } from "@nexus/core";
import { requireSession } from "@/lib/session";
import {
  changeRoleAction,
  deactivateUserAction,
  reactivateUserAction,
} from "@/lib/actions";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { Card, CardHeader, Chip } from "@/components/ui";
import { PageHeader } from "@/components/page";

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
 */
export default async function UsersPage() {
  const session = await requireSession();
  const mayManage = can(session.principal, "user:update");

  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      tx.execute<{
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
      `),
  );

  const roles = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      tx.execute<{ key: string; name: string }>(sql`
        SELECT key, name FROM roles ORDER BY level DESC NULLS LAST, name
      `),
  );
  const roleOptions = roles.map((r) => ({ value: r.key, label: r.name }));

  const active = rows.filter((r) => r.status === "active");
  const inactive = rows.filter((r) => r.status !== "active");

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="People and access"
        subtitle={`${active.length} active · ${inactive.length} deactivated`}
      />

      {!mayManage && (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            You can see who has access, but not change it. That needs the{" "}
            <code className="text-2xs">user:update</code> permission.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader title="Active" subtitle="Signed-in devices are shown per person" />
        <div className="px-4 pb-4 space-y-2">
          {active.map((u) => (
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
          ))}
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
        Inviting a new person is not built yet — accounts are created by the
        seed. Deactivation and role changes are, and both are audited with the
        actor, the reason and the number of sessions revoked.
      </p>
    </div>
  );
}
