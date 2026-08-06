import Link from "next/link";
import { requireSession } from "@/lib/session";
import { loadNotifications } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { ActionForm } from "@/components/action-form";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

/**
 * The notification inbox.
 *
 * This is the read side of the automation loop. The engine flags the overdue
 * invoice, the cheque to bank, the licence about to expire — and this is where
 * the owner sees them, ranked by severity, each one deep-linking to the screen
 * that fixes it. Without this page the automation engine does real work into a
 * void.
 */
const SEVERITY_STYLE: Record<string, { dot: string; label: string }> = {
  critical: { dot: "var(--negative)", label: "Critical" },
  warning: { dot: "var(--caution)", label: "Warning" },
  opportunity: { dot: "var(--accent)", label: "Opportunity" },
  info: { dot: "var(--text-subtle)", label: "Info" },
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  const { filter } = await searchParams;
  const unreadOnly = filter === "unread";
  const { items, unread } = await loadNotifications(session, { unreadOnly });

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="Notifications"
        subtitle={`${unread} unread · produced by your automation rules`}
        actions={
          <div className="flex items-center gap-1.5">
            <Link href="/inbox" className={`btn text-xs ${unreadOnly ? "btn-ghost" : "btn-primary"}`}>
              All
            </Link>
            <Link
              href="/inbox?filter=unread"
              className={`btn text-xs ${unreadOnly ? "btn-primary" : "btn-ghost"}`}
            >
              Unread
            </Link>
            {unread > 0 && (
              <ActionForm
                action={markAllNotificationsReadAction}
                submitLabel="Mark all read"
                pendingLabel="…"
                variant="ghost"
              />
            )}
          </div>
        }
      />

      <Card>
        <CardHeader
          title={unreadOnly ? "Unread" : "All notifications"}
          subtitle="Most urgent first"
        />
        {items.length === 0 ? (
          <EmptyState
            title={unreadOnly ? "Nothing unread" : "No notifications"}
            detail={
              unreadOnly
                ? "You are all caught up."
                : "Automation rules will post alerts here — overdue invoices, cheques to bank, licences to renew."
            }
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {items.map((n) => {
              const style = SEVERITY_STYLE[n.severity] ?? SEVERITY_STYLE.info;
              const unreadRow = n.readAt === null;
              return (
                <li
                  key={n.id}
                  className="flex items-start gap-3 px-4 py-3"
                  style={unreadRow ? { background: "var(--surface-2)" } : undefined}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                    style={{ background: style!.dot }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={`text-xs truncate ${unreadRow ? "font-semibold" : "font-medium"}`}>
                        {n.title}
                      </p>
                      <span className="text-2xs text-subtle shrink-0 tnum">
                        {n.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    {n.body && <p className="text-2xs text-subtle mt-0.5 leading-snug">{n.body}</p>}
                    <div className="flex items-center gap-3 mt-1.5">
                      {n.actionUrl && (
                        <Link
                          href={n.actionUrl}
                          className="text-2xs font-semibold"
                          style={{ color: "var(--accent)" }}
                        >
                          Open →
                        </Link>
                      )}
                      {unreadRow && (
                        <ActionForm
                          action={markNotificationReadAction}
                          submitLabel="Mark read"
                          pendingLabel="…"
                          variant="ghost"
                          hidden={{ id: n.id }}
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
