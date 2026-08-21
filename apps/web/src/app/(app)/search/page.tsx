import { Suspense } from "react";
import Link from "next/link";
import { withTenant } from "@nexus/db";
import {
  can,
  formatMoneyCompact,
  MIN_QUERY_LENGTH,
  search,
  ServiceError,
  type SearchGroupResult,
  type SearchHit,
  type SearchResult,
} from "@nexus/core";
import { requireSession, type SessionUser } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { SearchBox } from "@/components/search-box";
import { Card, EmptyState } from "@/components/ui";
import { BuTag, PageHeader, StatusPill } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * FIND — FR-P10, WF-05 §15.
 *
 * The product had no search of any kind. With 447 parties and 4,151 documents
 * the only route to a specific record was to guess which list screen it lived
 * on and page through it, which is why WF-05 puts a `find` affordance in the
 * shell on both breakpoints.
 *
 * Everything that decides what appears here happens in
 * `packages/core/src/services/search.ts`, in the query. This file renders. That
 * split is the point: search is the one surface a scoped user reaches by typing
 * rather than by following a nav entry the shell already filtered, so hiding a
 * row in JSX would be hiding it from the reader and not from the requester.
 *
 * ── THE FIVE STATES (WF-05 §0) ──────────────────────────────────────────────
 *
 *   default            results, grouped, strongest match first
 *   loading            `<Suspense key={term}>` below, plus `loading.tsx` for
 *                      the first arrival. Keyed on the term so REFINING the
 *                      query re-triggers the fallback — an unkeyed boundary
 *                      resolves once and every later keystroke then swaps the
 *                      results in with no indication anything happened.
 *   empty              TWO of them, and they are not the same screen. Nothing
 *                      typed is an invitation; typed-and-found-nothing is a
 *                      dead end that has to say what WAS searched and offer the
 *                      way out. Collapsing the two is the single most common
 *                      search-screen defect.
 *   error              rethrown to `(app)/error.tsx`.
 *   permission-denied  a principal who can read none of the seven groups. The
 *                      service throws `forbidden` and this file names the
 *                      permissions rather than rendering an empty page, which
 *                      would say "there is nothing here" about records that
 *                      exist.
 */

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[860px] mx-auto space-y-4">{children}</div>
);

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession();
  const { q = "" } = await searchParams;
  const term = q.trim().replace(/\s+/g, " ");

  return (
    <Shell>
      <PageHeader
        title="Find"
        subtitle="Everything you are allowed to see, in one box"
      />

      <SearchBox defaultValue={term} variant="page" />

      <Suspense key={term} fallback={<ResultsSkeleton />}>
        <Results session={session} term={term} />
      </Suspense>
    </Shell>
  );
}

/* ── STATE: loading ───────────────────────────────────────────────────────── */

function ResultsSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-hidden>
      {[0, 1].map((group) => (
        <Card key={group} className="p-4" as="div">
          <div className="h-2.5 w-28 rounded" style={{ background: "var(--surface-2)" }} />
          {[0, 1, 2].map((row) => (
            <div key={row} className="mt-3 flex items-center justify-between gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-44 rounded" style={{ background: "var(--surface-2)" }} />
                <div className="h-2.5 w-60 rounded" style={{ background: "var(--surface-2)" }} />
              </div>
              <div className="h-5 w-16 rounded-full" style={{ background: "var(--surface-2)" }} />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

/* ── The query ────────────────────────────────────────────────────────────── */

async function Results({ session, term }: { session: SessionUser; term: string }) {
  /* ── STATE: empty query ─────────────────────────────────────────────────── */
  if (term.length < MIN_QUERY_LENGTH) {
    return <StartHere session={session} typed={term.length > 0} />;
  }

  let result: SearchResult;
  try {
    result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      (tx) =>
        search(
          {
            tx,
            tenantId: session.tenantId,
            principal: session.principal,
            today: resolveToday(session.timezone),
            baseCurrency: session.baseCurrency,
          },
          term,
          { perGroup: 6 },
        ),
    );
  } catch (err) {
    /* ── STATE: permission denied ─────────────────────────────────────────── */
    if (err instanceof ServiceError && err.code === "forbidden") {
      return <NoPermission message={err.message} />;
    }
    // Anything else is a real failure and belongs to the error boundary. It is
    // deliberately not caught into a friendly panel here: a search that quietly
    // reports "nothing found" because the database was unreachable is the
    // false-green this codebase has already paid for once.
    throw err;
  }

  /* ── STATE: no results ──────────────────────────────────────────────────── */
  if (result.groups.length === 0) {
    return <NothingFound session={session} result={result} />;
  }

  /* ── STATE: default ─────────────────────────────────────────────────────── */
  return (
    <div className="space-y-3">
      <p className="text-2xs text-subtle tnum">
        {result.matched.toLocaleString()}
        {result.groups.some((g) => g.capped) ? "+" : ""} match
        {result.matched === 1 ? "" : "es"} · {result.tookMs} ms
        {result.denied.length > 0 && (
          <>
            {" · "}
            <span title={result.denied.join(", ")}>
              {result.denied.length} area{result.denied.length === 1 ? "" : "s"} outside your access
            </span>
          </>
        )}
      </p>

      {result.identity === "unavailable" && <IdentityUnavailable />}
      {result.identity === "matched" && (
        <p className="text-2xs" style={{ color: "var(--caution)" }}>
          Matched a registered identity document. The number itself is encrypted and is not shown.
        </p>
      )}

      {result.groups.map((group) => (
        <GroupCard key={group.group} group={group} currency={session.baseCurrency} />
      ))}

      <AskFallback session={session} term={result.query} />
    </div>
  );
}

/* ── Results ──────────────────────────────────────────────────────────────── */

function GroupCard({ group, currency }: { group: SearchGroupResult; currency: string }) {
  return (
    <Card as="div">
      <div className="px-4 pt-3 pb-1 flex items-baseline justify-between gap-3">
        <h2 className="label uppercase tracking-[0.07em] text-2xs">{group.label}</h2>
        <span className="text-2xs text-subtle tnum">
          {group.total.toLocaleString()}
          {group.capped ? "+" : ""}
        </span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
        {group.hits.map((hit) => (
          <li key={`${hit.group}:${hit.id}`}>
            <HitRow hit={hit} currency={currency} />
          </li>
        ))}
      </ul>
      {group.moreHref && (
        <div className="px-4 py-2 border-t" style={{ borderColor: "var(--border)" }}>
          <Link href={group.moreHref} className="text-2xs text-muted hover:underline">
            All {group.total.toLocaleString()}
            {group.capped ? "+" : ""} in {group.label.toLowerCase()} →
          </Link>
        </div>
      )}
    </Card>
  );
}

/**
 * One result row.
 *
 * Three lines of context, not an id. The wireframe's own examples — "Marina
 * 1204 · let", "INV-1042 · 12,000 · Aug", "CHQ 447811 · 42,000 · due" — are all
 * "enough to pick the right one without opening it", and that is the bar: two
 * cheques from the same tenant differ only by date and amount, so both are on
 * the row.
 *
 * `matchedOn === "identity"` renders no identifier and no masked tail. It says
 * only that a registered document matched, which is the most the screen may say
 * about a value that is encrypted at rest precisely so that screens cannot show
 * it.
 */
function HitRow({ hit, currency }: { hit: SearchHit; currency: string }) {
  return (
    <Link
      href={hit.href}
      className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{hit.title}</p>
        <p className="text-2xs text-muted truncate">
          {[hit.subtitle, hit.context].filter(Boolean).join(" · ") || " "}
        </p>
        {hit.matchedOn === "identity" && (
          <p className="text-2xs mt-0.5" style={{ color: "var(--caution)" }}>
            matched on a registered ID document
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0 text-2xs">
        {hit.amount !== null && (
          <span className="tnum">
            {formatMoneyCompact(hit.amount.toNumber(), hit.currency ?? currency)}
          </span>
        )}
        {hit.status && <StatusPill status={hit.status} />}
        {hit.businessUnit && (
          <BuTag name={hit.businessUnit.name} color={hit.businessUnit.colorToken} />
        )}
      </div>
    </Link>
  );
}

/* ── STATE: empty query ───────────────────────────────────────────────────── */

/**
 * What the box can find, before anything has been typed.
 *
 * A blank screen under a search field is the worst empty state in any product:
 * it teaches nothing and looks broken. This lists what is actually searchable
 * FOR THIS USER — the same permission map the service gates on — so a
 * receptionist is not invited to type a cheque number that will never match.
 */
function StartHere({ session, typed }: { session: SessionUser; typed: boolean }) {
  const areas: [string, string][] = [
    ["party:read", "customers, tenants and suppliers — by name or phone"],
    ["document:read", "invoices, bills and credit notes — by number or customer"],
    ["unit:read", "flats and parking bays — by building or unit code"],
    ["lease:read", "leases and cheques — by number, tenant or bank"],
    ["job:read", "service jobs — by job number or what the job was"],
    ["employee:read", "staff — by name, code or role"],
  ].filter(([permission]) => can(session.principal, permission)) as [string, string][];

  return (
    <Card className="p-4" as="div">
      <p className="text-xs font-semibold">
        {typed ? `Keep going — ${MIN_QUERY_LENGTH} characters minimum` : "Type to search"}
      </p>
      {areas.length === 0 ? (
        <p className="text-2xs text-muted mt-1.5 leading-relaxed">
          Your role has no read access to any of the records this box covers.
        </p>
      ) : (
        <>
          <p className="text-2xs text-muted mt-1.5">You can find:</p>
          <ul className="mt-1.5 space-y-1">
            {areas.map(([permission, label]) => (
              <li key={permission} className="text-2xs text-muted flex gap-2">
                <span className="text-subtle" aria-hidden>
                  ·
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ul>
          <p className="text-2xs text-subtle mt-3 leading-relaxed">
            Identity documents are encrypted, so they are matched exactly or not at all — a partial
            Emirates ID finds nothing, and a full one finds the person without ever showing the
            number.
          </p>
        </>
      )}
    </Card>
  );
}

/* ── STATE: nothing found ─────────────────────────────────────────────────── */

/**
 * A no-results state that is worth reading.
 *
 * "Nothing found" alone is a dead end. This one states what was searched, what
 * was NOT searched because of permissions — the honest reason a record the user
 * knows exists did not appear — and hands over to the assistant, which is
 * WF-05 §15's own fallback: "the last row routes an unmatched query to the
 * assistant, which is the right fallback for a search that finds nothing."
 */
function NothingFound({ session, result }: { session: SessionUser; result: SearchResult }) {
  return (
    <div className="space-y-3">
      <Card as="div">
        <EmptyState
          icon="⌕"
          title={`Nothing matches “${result.query}”`}
          detail={`Searched in ${result.tookMs} ms across everything your role can read.`}
        />
        <div
          className="px-4 pb-4 pt-1 space-y-1.5 border-t mt-1"
          style={{ borderColor: "var(--border)" }}
        >
          <p className="text-2xs text-muted leading-relaxed">
            Numbers are matched anywhere in the value, so <code className="text-[10px]">01669</code>{" "}
            finds <code className="text-[10px]">INV-SALON-01669</code>. Names are matched on the
            display name and phone number, not on email.
          </p>
          {result.denied.length > 0 && (
            <p className="text-2xs leading-relaxed" style={{ color: "var(--caution)" }}>
              {result.denied.length} area{result.denied.length === 1 ? " was" : "s were"} not
              searched at all, because your role cannot read{" "}
              {result.denied.map((g) => g).join(", ")}. If you expected a record from one of those,
              it exists — you just cannot reach it from here.
            </p>
          )}
          {result.identity === "no_match" && (
            <p className="text-2xs text-muted leading-relaxed">
              That looks like an identity document. Those are matched exactly, so a partial number
              or a different formatting of the same number will not find it.
            </p>
          )}
          {result.identity === "unavailable" && <IdentityUnavailable />}
        </div>
      </Card>

      <AskFallback session={session} term={result.query} />
    </div>
  );
}

/* ── WF-05 §15: the assistant fallback row ────────────────────────────────── */

/**
 * The link is to `/assistant` with NO query attached, and that is a known gap
 * rather than an oversight.
 *
 * WF-05 §15 wants the unmatched query handed over — «* "how is marina doing"».
 * The assistant screen's only search parameter is `c`, a conversation id, and
 * putting a search term in it would send `loadConversation(session, "marina")`
 * a value it will try to read as a uuid. So the row offers the assistant and
 * lets the user retype, rather than fabricating a hand-off that ends in a 500.
 * Closing it properly needs a `q` parameter on the assistant page, which
 * belongs to another agent this wave; it is named in the report.
 */
function AskFallback({ session, term }: { session: SessionUser; term: string }) {
  if (!can(session.principal, "ai:ask")) return null;
  return (
    <Link
      href="/assistant"
      className="card px-4 py-3 flex items-center gap-3 hover:bg-surface-2 transition-colors"
    >
      <span className="text-sm" aria-hidden style={{ color: "var(--accent)" }}>
        ✦
      </span>
      <span className="min-w-0">
        <span className="text-xs font-medium block truncate">
          Ask the assistant about “{term}”
        </span>
        <span className="text-2xs text-muted">
          It answers in sentences rather than rows — you will need to type the question there.
        </span>
      </span>
    </Link>
  );
}

/* ── STATE: permission denied ─────────────────────────────────────────────── */

function NoPermission({ message }: { message: string }) {
  return (
    <Card className="p-4" as="div">
      <p className="text-xs font-semibold">{message}</p>
      <p className="text-2xs text-muted mt-1.5 leading-relaxed">
        This box searches customers, invoices, units, leases, cheques, service jobs and staff, and
        each is gated on the same permission as the screen it belongs to —{" "}
        <code className="text-[10px]">party:read</code>,{" "}
        <code className="text-[10px]">document:read</code>,{" "}
        <code className="text-[10px]">unit:read</code>,{" "}
        <code className="text-[10px]">lease:read</code>,{" "}
        <code className="text-[10px]">job:read</code>,{" "}
        <code className="text-[10px]">employee:read</code>. Your role holds none of them. Ask the
        owner or the accountant for the one you need rather than for a search permission; there
        isn&apos;t one.
      </p>
    </Card>
  );
}

/**
 * The keyring would not load.
 *
 * Said out loud rather than absorbed into "nothing found". Exact lookup by
 * Emirates ID or passport is impossible while this is true, and a search box
 * that answers "no such person" for a person who is in the database is worse
 * than one that admits it cannot check.
 */
function IdentityUnavailable() {
  return (
    <p className="text-2xs leading-relaxed" style={{ color: "var(--negative)" }}>
      Lookup by identity document is unavailable — the encryption keyring did not load, so exact ID
      matching could not run. Everything else was searched normally. This needs an administrator:
      see <code className="text-[10px]">PII_INDEX_KEY</code>.
    </p>
  );
}
