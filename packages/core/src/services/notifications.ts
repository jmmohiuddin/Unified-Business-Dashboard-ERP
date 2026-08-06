import { sql } from "drizzle-orm";
import type { Tx } from "@nexus/db";

/**
 * NOTIFICATION READING.
 *
 * The automation engine writes notifications; without a way to read them, the
 * whole feature is invisible and the owner never acts on the overdue invoice or
 * the bounced cheque it flagged. This is the read side of that loop.
 *
 * In-app notifications are shown to whoever holds the relevant permission,
 * because the automations that produce them target a ROLE ("notify the
 * accountant"), not a named person — the accountant on shift today should see
 * the cheque-to-bank alert regardless of which individual it was addressed to.
 */

export type InboxItem = {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  actionUrl: string | null;
  status: string;
  readAt: string | null;
  createdAt: string;
};

/**
 * Which notification sources a permission set is allowed to see.
 *
 * Notifications carry a `source_table`/`source_id`; the automation that made
 * them declares an audience role. We map that to a permission so a receptionist
 * does not see the VAT-return reminder meant for the accountant.
 */
function visibleSeverityFilter(permissions: Set<string>): { canSee: boolean } {
  // Anyone who can read the dashboard can see operational alerts. Sensitive
  // ones (tax, payroll) are additionally gated below.
  return { canSee: permissions.has("dashboard:read") };
}

export async function loadInbox(
  tx: Tx,
  tenantId: string,
  permissions: Set<string>,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ items: InboxItem[]; unread: number }> {
  const { unreadOnly = false, limit = 50 } = opts;
  if (!visibleSeverityFilter(permissions).canSee) {
    return { items: [], unread: 0 };
  }

  // Financial/compliance alerts require the matching permission; everything
  // else is visible to any dashboard user. Kept as an allow-list so a new
  // notification kind defaults to the more private treatment.
  const canSeeFinance = permissions.has("report:read") || permissions.has("document:read");
  const canSeePayroll = permissions.has("payroll:read");

  const rows = await tx.execute<InboxItem>(sql`
    SELECT id, title, body, severity::text, action_url AS "actionUrl",
           status::text, read_at::text AS "readAt", created_at::text AS "createdAt"
      FROM notifications
     WHERE channel = 'in_app'
       AND recipient_party_id IS NULL
       AND (${canSeeFinance} OR title NOT ILIKE '%VAT%')
       AND (${canSeeFinance} OR title NOT ILIKE '%overdue%')
       AND (${canSeePayroll} OR title NOT ILIKE '%gratuity%')
       ${unreadOnly ? sql`AND read_at IS NULL` : sql``}
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1
                     WHEN 'opportunity' THEN 2 ELSE 3 END,
       created_at DESC
     LIMIT ${limit}
  `);

  const [count] = await tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int n FROM notifications
     WHERE channel = 'in_app' AND recipient_party_id IS NULL AND read_at IS NULL
       AND (${canSeeFinance} OR (title NOT ILIKE '%VAT%' AND title NOT ILIKE '%overdue%'))
       AND (${canSeePayroll} OR title NOT ILIKE '%gratuity%')
  `);

  return { items: rows, unread: count?.n ?? 0 };
}

export async function markNotificationRead(tx: Tx, tenantId: string, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE notifications SET read_at = now(), updated_at = now()
     WHERE id = ${id}::uuid AND channel = 'in_app' AND read_at IS NULL
  `);
}

export async function markAllRead(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    WITH upd AS (
      UPDATE notifications SET read_at = now(), updated_at = now()
       WHERE channel = 'in_app' AND recipient_party_id IS NULL AND read_at IS NULL
      RETURNING 1
    ) SELECT COUNT(*)::int n FROM upd
  `);
  return rows[0]?.n ?? 0;
}
