import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@nexus/core";
import { destroySession, requireSession, revokeAllSessions } from "@/lib/session";
import { loadBusinessUnits, loadNotifications } from "@/lib/data";
import { BU_COLOR } from "@/components/ui";
import { SearchBox } from "@/components/search-box";

export const dynamic = "force-dynamic";

type NavItem = { href: string; label: string; icon: string; permission: string };
type NavGroup = { label: string | null; items: NavItem[] };

/**
 * The application's whole navigation surface, grouped.
 *
 * WF-05 §1.2 requires labelled groups — MONEY / BUSINESS / COMPLIANCE /
 * REPORTS — and says so explicitly as "the fix for the audit's finding that
 * grouping is implicit". A flat list forces every user to hold the taxonomy in
 * their head; the accountant and the owner then read the same ten rows looking
 * for different things and both scan all ten.
 *
 * Two rules govern this table:
 *
 *  1. **Every live route belongs to exactly one group.** `/accounting/vat`,
 *     `/accounting/profit-loss` and `/hr/gratuity` were live, CI-guarded routes
 *     with no nav entry at all — the accountant's three primary screens were
 *     reachable only by drill-down or by typing the URL, and `hr/gratuity` had
 *     zero references anywhere in `apps/web/src`. A route that ships without a
 *     way to reach it has not shipped.
 *  2. **The group is a label, not a path.** Grouping deliberately does NOT move
 *     any route: cheques stay at `/rentals/cheques`, VAT at `/accounting/vat`.
 *     The §5.2 route restructure is a separate, larger piece of work.
 *
 * `permission` mirrors the permission on the metric that feeds each screen, so
 * a role that cannot read the numbers is not offered the screen that shows
 * them (`report:read` for VAT and P&L, `payroll:read` for gratuity,
 * `lease:read` for the rent-cheque register).
 */
const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/", label: "Overview", icon: "◱", permission: "dashboard:read" }],
  },
  {
    label: "Money",
    items: [
      { href: "/receivables", label: "Money owed", icon: "◳", permission: "document:read" },
      { href: "/purchases", label: "Bills & POs", icon: "▤", permission: "document:read" },
      { href: "/rentals/cheques", label: "Cheques", icon: "▭", permission: "lease:read" },
      // The adoption gate: if cash cannot be recorded in three taps, it gets
      // recorded on paper instead and the ledger is fiction. It belongs beside
      // the money screens, not buried in settings.
      { href: "/cash", label: "Cash entry", icon: "⊕", permission: "payment:create" },
      { href: "/finance/cash", label: "Cash register", icon: "▣", permission: "settings:update" },
      // FR-M05 / JTBD J2: what the owner has put in versus taken out. Drawings
      // are not an expense, so they appear nowhere in P&L — without this screen
      // the single largest movement of the owner's own money is invisible.
      { href: "/finance/owner", label: "Owner ledger", icon: "◈", permission: "report:read" },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/businesses", label: "Compare", icon: "◲", permission: "dashboard:consolidated" },
      { href: "/rentals", label: "Rentals", icon: "◵", permission: "unit:read" },
      { href: "/services", label: "Service jobs", icon: "◴", permission: "job:read" },
      { href: "/salon", label: "Salon", icon: "◶", permission: "appointment:read" },
      { href: "/inventory", label: "Inventory", icon: "◷", permission: "stock:read" },
      { href: "/crm", label: "Customers", icon: "◰", permission: "party:read" },
      { href: "/businesses/interco", label: "Between businesses", icon: "⇄", permission: "report:read" },
    ],
  },
  {
    label: "Compliance",
    items: [
      { href: "/compliance", label: "Watchlist", icon: "⬡", permission: "settings:read" },
      { href: "/accounting/vat", label: "VAT", icon: "▧", permission: "report:read" },
      { href: "/hr/gratuity", label: "Gratuity", icon: "▨", permission: "payroll:read" },
      { href: "/accounting/close", label: "Period close", icon: "▦", permission: "period:read" },
      { href: "/compliance/e-invoicing", label: "E-invoicing", icon: "◈", permission: "settings:read" },
    ],
  },
  {
    label: "Reports",
    items: [
      {
        href: "/accounting/profit-loss",
        label: "Profit & loss",
        icon: "▩",
        permission: "report:read",
      },
      { href: "/settings/import", label: "Import data", icon: "▼", permission: "journal:post" },
    ],
  },
  {
    label: null,
    items: [
      // Re-enabled per decision D2. The page no longer redirects: without
      // ANTHROPIC_API_KEY it renders an honest "not configured" state rather
      // than 500ing or bouncing the user back where they came from, which is
      // what made the old dashboard CTA a dead end.
      { href: "/assistant", label: "Ask Nexus", icon: "✦", permission: "ai:ask" },
    ],
  },
];

/**
 * What the bottom bar shows before it starts overflowing, in preference order.
 *
 * WF-05 §1.1 sketches `Today · Money · Biz · ⊕ · More`. The `⊕` cash-entry
 * sheet is not built, so the four slots go to destinations and the fifth is
 * always `More`. Anything a role cannot see simply promotes the next entry —
 * the bar never renders a gap, and nothing is ever silently dropped, because
 * whatever does not fit lands in `More` rather than off the end of a `slice`.
 */
const MOBILE_PRIMARY = ["/", "/receivables", "/businesses", "/services"];
const MOBILE_SLOTS = 4;

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

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((n) => session.principal.permissions.has(n.permission)),
  })).filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);

  // Preference order first, then everything else in nav order, so the bar is
  // full for any role. `primary` and `overflow` partition `flat` exactly.
  const primary = [
    ...MOBILE_PRIMARY.map((href) => flat.find((i) => i.href === href)).filter(
      (i): i is NavItem => i !== undefined,
    ),
    ...flat.filter((i) => !MOBILE_PRIMARY.includes(i.href)),
  ].slice(0, MOBILE_SLOTS);
  const overflow = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !primary.includes(i)) }))
    .filter((g) => g.items.length > 0);

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

  const navRow = (item: NavItem) => (
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
  );

  const groupLabel = (label: string) => (
    <p className="label uppercase tracking-[0.07em] text-2xs text-subtle px-2.5 mt-4 mb-1">
      {label}
    </p>
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

        {/* WF-05 §1.2 puts `find` in the shell on BOTH breakpoints. With 447
            parties and 4,151 documents, guessing which list screen holds a
            record and paging through it was the only way to reach anything. */}
        {can(session.principal, "party:read") && (
          <div className="px-2 pt-2">
            <SearchBox variant="shell" />
          </div>
        )}

        <nav className="flex-1 overflow-y-auto py-3 px-2 scrollbar-none">
          {bell(false)}
          {groups.map((group) => (
            <div key={group.label ?? "primary"}>
              {group.label && groupLabel(group.label)}
              {group.items.map(navRow)}
            </div>
          ))}

          {/* Per-business rows.
           *
           * These used to link to `/businesses/${code}`, a route that has never
           * existed — every one of them fell through the catch-all to a real
           * HTTP 404, in the persistent chrome, on every page. They now point at
           * the comparison screen that does exist, carrying the unit as `?bu=`.
           * NOTE: `businesses/page.tsx` does not read `bu` yet, so the link
           * lands on the unfiltered comparison rather than on that business.
           * `check:routes` reports the unread parameter by name so this stays
           * visible until that page consumes it. */}
          <p className="label uppercase tracking-[0.07em] text-2xs text-subtle px-2.5 mt-4 mb-1">
            Businesses
          </p>
          {businessUnits.map((bu) => (
            <Link
              key={bu.id}
              href={`/businesses?bu=${bu.code.toLowerCase()}`}
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
          {can(session.principal, "user:read") && (
            <Link
              href="/settings/users"
              className="block px-2.5 py-1.5 rounded-[var(--radius-md)] hover:bg-surface-2 transition-colors text-2xs text-subtle"
            >
              People and access
            </Link>
          )}
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
          {can(session.principal, "party:read") && (
            <Link href="/search" className="text-lg" aria-label="Search">
              <span aria-hidden>⌕</span>
            </Link>
          )}
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

      {/* ── Mobile bottom nav ─────────────────────────────────────────────
       *
       * Four destinations plus `More`, per WF-05 §1.1.
       *
       * This was `nav.slice(0, 5)` against a flat ten-entry list with no
       * overflow affordance, so Rentals, Salon, Inventory, Customers and
       * Compliance — and with them VAT, P&L and gratuity — simply did not
       * exist on a phone. `More` is a plain `<details>`: the layout is a server
       * component and a disclosure that needs no client JavaScript cannot break
       * when hydration does.
       */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 grid border-t backdrop-blur"
        style={{
          // Column count follows what this role can actually see. A fixed
          // five-column grid left a barber — who sees two destinations — with
          // three empty cells and a bar that looked broken.
          gridTemplateColumns: `repeat(${primary.length + 1}, minmax(0, 1fr))`,
          background: "color-mix(in oklch, var(--surface) 92%, transparent)",
          borderColor: "var(--border)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {primary.map((item) => (
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

        <details className="group relative">
          <summary
            className="list-none [&::-webkit-details-marker]:hidden flex flex-col items-center justify-center gap-0.5 py-2 text-2xs text-muted min-h-[3.25rem] cursor-pointer"
            aria-label="More destinations"
          >
            <span className="text-sm" aria-hidden>
              ⋯
            </span>
            <span className="truncate max-w-full px-1">More</span>
          </summary>

          <div
            className="fixed inset-x-0 bottom-[3.25rem] z-40 max-h-[70dvh] overflow-y-auto border-t px-3 py-3"
            style={{
              background: "var(--surface)",
              borderColor: "var(--border)",
              paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
            }}
          >
            {overflow.map((group) => (
              <div key={group.label ?? "primary"}>
                {group.label && groupLabel(group.label)}
                {group.items.map(navRow)}
              </div>
            ))}

            {/* Settings lived only in the desktop sidebar footer, which meant a
             *  user on a phone could not reach their own security settings or
             *  the people-and-access screen at all. */}
            {groupLabel("Settings")}
            <Link
              href="/settings/security"
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium text-muted hover:bg-surface-2 hover:text-[var(--text)] transition-colors"
            >
              <span className="w-4 text-center text-subtle" aria-hidden>
                ◍
              </span>
              Security settings
            </Link>
            {can(session.principal, "user:read") && (
              <Link
                href="/settings/users"
                className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium text-muted hover:bg-surface-2 hover:text-[var(--text)] transition-colors"
              >
                <span className="w-4 text-center text-subtle" aria-hidden>
                  ◎
                </span>
                People and access
              </Link>
            )}
            <form action={signOutEverywhere}>
              <button
                type="submit"
                className="btn btn-ghost w-full justify-start text-2xs mt-1"
                title="Revokes every active session on every device"
              >
                Sign out everywhere
              </button>
            </form>
          </div>
        </details>
      </nav>
    </div>
  );
}
