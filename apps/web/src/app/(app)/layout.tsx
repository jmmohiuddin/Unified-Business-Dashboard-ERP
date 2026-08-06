import Link from "next/link";
import { redirect } from "next/navigation";
import { destroySession, requireSession, revokeAllSessions } from "@/lib/session";
import { loadBusinessUnits, loadNotifications } from "@/lib/data";
import { BU_COLOR } from "@/components/ui";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/", label: "Overview", icon: "◱", permission: "dashboard:read" },
  { href: "/businesses", label: "Businesses", icon: "◲", permission: "dashboard:consolidated" },
  { href: "/receivables", label: "Money owed", icon: "◳", permission: "document:read" },
  { href: "/purchases", label: "Bills & POs", icon: "◱", permission: "document:read" },
  { href: "/services", label: "Service jobs", icon: "◴", permission: "job:read" },
  { href: "/rentals", label: "Rentals", icon: "◵", permission: "unit:read" },
  { href: "/salon", label: "Salon", icon: "◶", permission: "appointment:read" },
  { href: "/inventory", label: "Inventory", icon: "◷", permission: "stock:read" },
  { href: "/crm", label: "Customers", icon: "◰", permission: "party:read" },
  { href: "/compliance", label: "Compliance", icon: "⬡", permission: "settings:read" },
  { href: "/assistant", label: "Ask Nexus", icon: "✦", permission: "ai:ask" },
];

async function signOut() {
  "use server";
  await destroySession();
  redirect("/login");
}

/** The remedy a user needs when they suspect a compromise. Changing a password
 *  does nothing to an already-issued session token; this does. */
async function signOutEverywhere() {
  "use server";
  const session = await requireSession();
  await revokeAllSessions(session.userId);
  redirect("/login?signedOutEverywhere=1");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const businessUnits = await loadBusinessUnits(session);
  const { unread } = await loadNotifications(session, { unreadOnly: true });
  const nav = NAV.filter((n) => session.principal.permissions.has(n.permission));

  // The bell is a nav row like any other, so the unread count follows the same
  // permission filtering the notifications themselves do.
  const bell = (compact: boolean) => (
    <Link
      href="/inbox"
      className={
        compact
          ? "flex flex-col items-center justify-center gap-0.5 py-2 text-2xs text-muted min-h-[3.25rem] relative"
          : "flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium text-muted hover:bg-surface-2 hover:text-[var(--text)] transition-colors relative"
      }
    >
      <span className={compact ? "text-sm" : "w-4 text-center text-subtle"} aria-hidden>
        ◔
      </span>
      {compact ? "Alerts" : "Notifications"}
      {unread > 0 && (
        <span
          className="chip tnum ml-auto"
          style={{ background: "var(--negative)", color: "var(--text-inverse)", minWidth: "1.1rem", justifyContent: "center" }}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );

  return (
    <div className="min-h-dvh flex flex-col lg:flex-row">
      {/* ── Sidebar (desktop) ────────────────────────────────────────────── */}
      <aside
        className="hidden lg:flex w-56 shrink-0 flex-col border-r"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="px-4 h-14 flex items-center gap-2.5 border-b" style={{ borderColor: "var(--border)" }}>
          <div
            className="w-6 h-6 rounded-md grid place-items-center text-2xs font-bold shrink-0"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            N
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate leading-tight">{session.tenantName}</p>
            <p className="text-2xs text-subtle leading-tight">{businessUnits.length} businesses</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 scrollbar-none">
          {bell(false)}
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium text-muted hover:bg-surface-2 hover:text-[var(--text)] transition-colors"
            >
              <span className="w-4 text-center text-subtle" aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </Link>
          ))}

          <p className="label px-2.5 mt-5 mb-1.5">Businesses</p>
          {businessUnits.map((bu) => (
            <Link
              key={bu.id}
              href={`/businesses/${bu.code.toLowerCase()}`}
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs text-muted hover:bg-surface-2 hover:text-[var(--text)] transition-colors"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: BU_COLOR[bu.colorToken] ?? "var(--accent)" }}
                aria-hidden
              />
              <span className="truncate">{bu.name}</span>
            </Link>
          ))}
        </nav>

        <div className="p-2 border-t" style={{ borderColor: "var(--border)" }}>
          <Link
            href="/settings/security"
            className="block px-2.5 py-2 rounded-[var(--radius-md)] hover:bg-surface-2 transition-colors"
          >
            <p className="text-xs font-medium truncate">{session.fullName}</p>
            <p className="text-2xs text-subtle truncate">
              {session.principal.roleKey.replace(/_/g, " ")} · security settings
            </p>
          </Link>
          <form action={signOut}>
            <button type="submit" className="btn btn-ghost w-full justify-start text-xs">
              Sign out
            </button>
          </form>
          <form action={signOutEverywhere}>
            <button
              type="submit"
              className="btn btn-ghost w-full justify-start text-2xs"
              title="Revokes every active session on every device"
            >
              Sign out everywhere
            </button>
          </form>
        </div>
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────────────── */}
      <header
        className="lg:hidden sticky top-0 z-20 h-14 px-4 flex items-center justify-between border-b backdrop-blur"
        style={{ background: "color-mix(in oklch, var(--surface) 88%, transparent)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-6 h-6 rounded-md grid place-items-center text-2xs font-bold shrink-0"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            N
          </div>
          <p className="text-xs font-semibold truncate">{session.tenantName}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/inbox" className="relative text-lg" aria-label={`${unread} unread notifications`}>
            <span aria-hidden>◔</span>
            {unread > 0 && (
              <span
                className="absolute -top-1 -right-1 rounded-full text-[9px] font-bold tnum grid place-items-center"
                style={{ background: "var(--negative)", color: "var(--text-inverse)", minWidth: "1rem", height: "1rem" }}
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>
          <form action={signOut}>
            <button type="submit" className="text-2xs text-muted">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="flex-1 min-w-0 pb-20 lg:pb-0">{children}</main>

      {/* ── Mobile bottom nav: the five things an owner opens the app for ── */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 grid grid-cols-5 border-t backdrop-blur"
        style={{
          background: "color-mix(in oklch, var(--surface) 92%, transparent)",
          borderColor: "var(--border)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {nav.slice(0, 5).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex flex-col items-center justify-center gap-0.5 py-2 text-2xs text-muted min-h-[3.25rem]"
          >
            <span className="text-sm" aria-hidden>
              {item.icon}
            </span>
            <span className="truncate max-w-full px-1">{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
