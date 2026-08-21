import Link from "next/link";
import { withTenant } from "@nexus/db";
import {
  OWNER_LEDGER_PERMISSION,
  UNALLOCATED_NAME,
  canViewOwnerLedger,
  countOwnerMovements,
  formatMoney,
  loadOwnerLedger,
  type OwnerLedgerPosition,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { BU_COLOR, Card, CardHeader, EmptyState } from "@/components/ui";
import {
  BuTag,
  DataTable,
  DaysPill,
  PageHeader,
  Pagination,
  StatStrip,
  TableEmpty,
  pageSlice,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * THE OWNER LEDGER — FR-M05, WF-05 §5, JTBD J2.
 *
 * "Know which existing business actually makes money" is the job the audit
 * marked only partially served, and this is the half that was missing: not
 * profit, but the owner's own money moving between his businesses. Wave 2 built
 * the entries — 3100 Owner Capital and 3200 Owner Drawings both post — and
 * nothing read them back. The owner could put money in and take money out and
 * had no screen anywhere that told him the running result.
 *
 * WHAT THIS SCREEN SAYS THAT A TOTAL CANNOT. Three things, in this order:
 *
 *  1. The net position, in the sentence WF-05 §5 writes: "you have taken out
 *     AED 132,000 more than you put in". Not "net owner position -132,000",
 *     which is the same fact in a form the owner would have to translate.
 *  2. Which businesses, on a diverging scale with zero in the middle, because
 *     the interesting fact is never the total — it is that one business funds
 *     another.
 *  3. HOW LONG. A director's-loan balance goes wrong by sitting still, and an
 *     amount with no clock on it cannot show that. The ageing table and the
 *     stale flag are the parts of this screen that do work no spreadsheet does.
 *
 * Q-10 IS OPEN. Both thresholds — how long is too long, how much is material —
 * are unresolved with the owner and the accountant. They are read from tenant
 * settings with a stated default and the screen SAYS SO wherever it uses them,
 * for the same reason `/finance/cash` labels its variance limit a placeholder:
 * a number presented without that caveat reads as a policy somebody agreed to.
 *
 * IT WRITES NOTHING. There is no Settle and no Note button, though WF-05 §5
 * draws both. Settling an owner balance is a real journal — a contribution, a
 * drawing, or an offset against another business — and which of those it should
 * post depends on Q-10 and on what the accountant decides an "unchanged
 * balance" ought to become. The read is complete and honest; inventing the
 * write would mean inventing the policy. See the report accompanying this wave.
 *
 * The five states of WF-05 §0 are all here: default below, `loading.tsx`,
 * `error.tsx`, the "nothing recorded yet" empty state with the path to the
 * screen that records one, and the permission-denied card immediately after
 * the session lookup.
 */
export default async function OwnerLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ bu?: string; page?: string; per?: string }>;
}) {
  const session = await requireSession();
  const { bu, page: rawPage, per: rawPer } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  /* ── STATE: permission denied ───────────────────────────────────────────── */
  // A real answer rather than a 404, matching `/finance/cash`: the nav hides
  // this route from roles without the permission, so anyone who lands here
  // followed a link or a bookmark and is better served by being told which
  // permission they would need.
  if (!canViewOwnerLedger(session.principal.permissions)) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Owner ledger" />
        <Card className="p-5" as="div">
          <p className="text-xs font-semibold">You do not have access to the owner ledger.</p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[52ch]">
            What the owner has put into each business and taken back out needs{" "}
            <code className="text-2xs">{OWNER_LEDGER_PERMISSION}</code>. It is the owner&rsquo;s
            and the accountant&rsquo;s view of the group. Ask whoever manages access on the People
            and access screen.
          </p>
        </Card>
      </div>
    );
  }

  // `bu` is a business id, the literal `unallocated`, or absent. It narrows the
  // MOVEMENT LIST only — never the figures above it. Filtering the headline
  // would turn "you have taken out AED 286,673" into a quietly smaller claim
  // about one business while still reading as the group total.
  const scope = bu === "unallocated" ? ("unallocated" as const) : bu || undefined;

  const { ledger, slice } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const total = await countOwnerMovements(tx, { asOf: today, businessUnitId: scope });
      const slice = pageSlice({ page: rawPage, per: rawPer }, total, { perPage: 25 });
      return {
        slice,
        ledger: await loadOwnerLedger(tx, {
          asOf: today,
          businessUnitId: scope,
          limit: slice.perPage,
          offset: slice.offset,
        }),
      };
    },
  );

  const { group, businesses, thresholds, ageing, flagged } = ledger;

  /* ── STATE: empty ───────────────────────────────────────────────────────── */
  // "Nothing has been recorded" is a task, not a wait, so it gets the path to
  // the screen that records one rather than an empty table that reads as broken.
  if (businesses.length === 0) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader
          title="Owner ledger"
          subtitle="What you have put in, what you have taken out"
        />
        <Card>
          <EmptyState
            icon="◑"
            title="Nothing recorded yet"
            detail="Money you put into a business and money you take out of it are not income and not expenses — they are your own capital, and they belong here rather than in the profit figure. Record one on the cash entry screen and it appears on this ledger."
          />
          <div className="px-4 pb-5 text-center">
            <Link href="/cash" className="btn btn-primary text-xs">
              Record money in or out
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  /* ── STATE: default ─────────────────────────────────────────────────────── */

  const drawnOut = group.net < 0;
  // Counted separately from `businesses.length` because the unallocated bucket
  // is a row on this screen and is NOT a business — saying "across 1 business"
  // when the only row is "not allocated to a business" is a small lie that
  // happens to be the exact one the bucket exists to prevent.
  const named = businesses.filter((b) => b.businessUnitId !== null).length;
  const hasUnallocated = businesses.some((b) => b.businessUnitId === null);
  const widest = Math.max(1, ...businesses.map((b) => Math.abs(b.net)));
  const stillOut = ageing.reduce((t, band) => t + band.amount, 0);
  // The name to put on the filtered list. Null when `?bu=` names a business
  // that has never had an owner entry — a stale bookmark, or an id typed by
  // hand. It must NOT fall through to the unallocated bucket's label, which
  // would tell the reader they are looking at group-level entries when they are
  // in fact looking at nothing.
  const scopeLabel =
    scope === undefined
      ? null
      : scope === "unallocated"
        ? UNALLOCATED_NAME
        : (businesses.find((b) => b.businessUnitId === scope)?.name ?? null);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <PageHeader
        title="Owner ledger"
        subtitle={`${
          named === 0
            ? "Your own money — no entry has been allocated to a business yet"
            : `Your own money, across ${named} ${named === 1 ? "business" : "businesses"}${
                hasUnallocated ? " plus entries not allocated to one" : ""
              }`
        } · as at ${today}`}
      />

      {/* ── NET POSITION ────────────────────────────────────────────────── */}
      {/* WF-05 §5 writes this as a sentence rather than a labelled figure, and
          the wording is the feature: "net owner position −132,000" is the same
          fact expressed so that the reader has to work out its direction. */}
      <Card className="p-5 text-center" as="div">
        <p className="label">Net position</p>
        <p className="text-xs text-muted mt-2">
          {group.net === 0 ? "You are square with your businesses" : drawnOut ? "You have taken out" : "You have put in"}
        </p>
        <p
          className="text-3xl font-semibold tnum tracking-tight mt-1"
          style={{ color: drawnOut ? "var(--negative)" : group.net > 0 ? "var(--positive)" : undefined }}
        >
          {formatMoney(Math.abs(group.net), ccy, 0)}
        </p>
        {group.net !== 0 && (
          <p className="text-xs text-muted mt-1">
            more than you {drawnOut ? "put in" : "took out"}
          </p>
        )}
        <p className="text-2xs text-subtle mt-3 leading-relaxed max-w-[60ch] mx-auto">
          None of this is profit or loss. Money you put in is capital and money you take out is a
          drawing — both are equity, so neither has ever moved the profit figure you see elsewhere.
          That is why taking out {formatMoney(group.drawn, ccy, 0)} did not make any business look
          less profitable.
        </p>
      </Card>

      <StatStrip
        stats={[
          {
            label: "Put in",
            value: formatMoney(group.contributed, ccy, 0),
            tone: group.contributed > 0 ? "positive" : "default",
            hint: `${group.movements} movement${group.movements === 1 ? "" : "s"}`,
          },
          {
            label: "Taken out",
            value: formatMoney(group.drawn, ccy, 0),
            tone: group.drawn > 0 ? "negative" : "default",
            hint: "never an expense",
          },
          {
            label: "Still out, oldest",
            value: group.ageDays === null ? "—" : `${group.ageDays}d`,
            tone: group.ageDays !== null && group.ageDays > thresholds.staleAfterDays ? "caution" : "default",
            hint: group.oldestUnsettledOn ?? "nothing outstanding",
          },
          {
            label: "Capital at go-live",
            value: formatMoney(group.openingCapital, ccy, 0),
            hint: "brought forward, not a contribution",
          },
          {
            label: "Needs attention",
            value: String(flagged.length),
            tone: flagged.length > 0 ? "caution" : "positive",
            hint: thresholds.configured ? "against your thresholds" : "placeholder — Q-10",
          },
        ]}
      />

      {/* ── BY BUSINESS ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="By business"
          subtitle="Left of the line, you have taken money out. Right of it, you are funding it."
        />
        <div className="px-4 pb-4 space-y-1">
          {businesses.map((b) => (
            <DivergingRow
              key={b.businessUnitId ?? "unallocated"}
              position={b}
              widest={widest}
              currency={ccy}
            />
          ))}
        </div>
        {ledger.conclusion && (
          <p className="px-4 pb-4 text-xs leading-relaxed text-muted max-w-[62ch]">
            {ledger.conclusion}
          </p>
        )}
      </Card>

      {/* ── NEEDS ATTENTION ─────────────────────────────────────────────── */}
      {flagged.length > 0 && (
        <Card>
          <CardHeader
            title="Needs attention"
            subtitle={
              thresholds.configured
                ? `Unchanged for over ${thresholds.staleAfterDays} days, or net drawn above ${formatMoney(thresholds.materiality, ccy, 0)}`
                : `Unchanged for over ${thresholds.staleAfterDays} days, or net drawn above ${formatMoney(thresholds.materiality, ccy, 0)} — both figures are placeholders until the owner and accountant set them`
            }
          />
          <div className="px-4 pb-4 grid gap-3 sm:grid-cols-2">
            {flagged.map((b) => (
              <div
                key={b.businessUnitId ?? "unallocated"}
                className="rounded-[var(--radius-md)] p-3"
                style={{ background: "var(--caution-soft)" }}
              >
                <p className="text-xs font-semibold" style={{ color: "var(--caution)" }}>
                  {b.name}
                </p>
                <p className="text-2xs mt-1 leading-relaxed" style={{ color: "var(--caution)" }}>
                  {b.isStale && b.daysSinceLastMovement !== null
                    ? `Nothing has moved on this balance for ${b.daysSinceLastMovement} days.`
                    : `Net drawn is above the ${formatMoney(thresholds.materiality, ccy, 0)} mark.`}
                  {b.isMaterial && b.isStale
                    ? ` It is also over the ${formatMoney(thresholds.materiality, ccy, 0)} mark.`
                    : ""}
                </p>
                <p className="text-sm font-semibold tnum mt-1.5" style={{ color: "var(--caution)" }}>
                  {formatMoney(Math.abs(b.net), ccy, 0)} {b.net < 0 ? "drawn" : "contributed"}
                </p>
                <Link
                  href={`/finance/owner?bu=${b.businessUnitId ?? "unallocated"}`}
                  className="text-2xs underline mt-1.5 inline-block"
                  style={{ color: "var(--caution)" }}
                >
                  See the entries behind it
                </Link>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── AGEING ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="How long it has been out"
          subtitle={`${formatMoney(stillOut, ccy, 0)} drawn and not yet put back, oldest first`}
        />
        {stillOut === 0 ? (
          <TableEmpty
            title="Nothing outstanding"
            detail="Every drawing has been covered by a later contribution."
          />
        ) : (
          <>
            <DataTable
              rows={ageing}
              rowKey={(band) => band.key}
              caption="Outstanding owner drawings by age"
              empty={<TableEmpty title="Nothing outstanding" detail="" />}
              columns={[
                { key: "band", header: "Age", render: (band) => band.label },
                {
                  key: "amount",
                  header: "Still out",
                  numeric: true,
                  render: (band) => (
                    <span
                      className="tnum"
                      style={{
                        color:
                          band.amount === 0 ? "var(--text-subtle)"
                          : band.key === "current" ? undefined
                          : "var(--caution)",
                      }}
                    >
                      {band.amount === 0 ? "—" : formatMoney(band.amount, ccy, 0)}
                    </span>
                  ),
                },
                {
                  key: "share",
                  header: "",
                  render: (band) =>
                    band.amount === 0 ? null : (
                      <div
                        className="h-1.5 rounded-full"
                        style={{
                          width: `${Math.max(2, (band.amount / stillOut) * 100)}%`,
                          background: band.key === "current" ? "var(--accent)" : "var(--caution)",
                        }}
                      />
                    ),
                },
              ]}
            />
            <p className="px-4 pb-4 pt-1 text-2xs text-subtle leading-relaxed max-w-[70ch]">
              Money put back in settles the oldest drawing first, the same way a customer payment
              settles their oldest invoice — otherwise a balance you are actually paying down would
              keep showing an ancient date forever. The bands are set from the{" "}
              {thresholds.staleAfterDays}-day staleness threshold
              {thresholds.staleConfigured ? "" : ", which is a placeholder until it is agreed"}, so
              anything past the first band is, by that definition, a balance that has sat too long.
            </p>
          </>
        )}
      </Card>

      {/* ── MOVEMENTS ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Movements"
          subtitle={
            scope === undefined
              ? "Every time your own money moved, most recent first"
              : scopeLabel
                ? `${scopeLabel} only`
                : "That business has no owner entries"
          }
          action={
            scope ? (
              <Link href="/finance/owner" className="btn btn-ghost text-xs">
                ← All businesses
              </Link>
            ) : undefined
          }
        />
        <DataTable
          rows={ledger.movements}
          rowKey={(m) => m.journalId}
          caption="Owner contributions and drawings"
          empty={
            <TableEmpty
              title="No movements"
              detail={
                scope
                  ? "Nothing has been recorded against this business."
                  : "Nothing has been recorded yet."
              }
            />
          }
          columns={[
            { key: "on", header: "Date", render: (m) => m.on },
            {
              key: "dir",
              header: "",
              render: (m) => (
                <span
                  className="chip"
                  style={{
                    background: m.direction === "in" ? "var(--positive-soft)" : "var(--negative-soft)",
                    color: m.direction === "in" ? "var(--positive)" : "var(--negative)",
                  }}
                >
                  {m.direction === "in" ? "In" : "Out"}
                </span>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              numeric: true,
              render: (m) => (
                <span
                  className="tnum font-semibold"
                  style={{ color: m.direction === "in" ? "var(--positive)" : "var(--negative)" }}
                >
                  {m.direction === "in" ? "+" : "−"}
                  {formatMoney(m.amount, ccy, 0)}
                </span>
              ),
            },
            {
              key: "bu",
              header: "Business",
              render: (m) => <BuTag name={m.businessUnitName} color={m.colorToken} />,
            },
            {
              key: "ref",
              header: "Reference",
              render: (m) => (
                <span className="text-2xs text-muted">{m.reference ?? m.journalNumber}</span>
              ),
            },
            {
              key: "why",
              header: "Note",
              render: (m) =>
                m.narration ? (
                  <span className="text-2xs text-muted">{m.narration}</span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
          ]}
        />
        <Pagination
          slice={slice}
          basePath="/finance/owner"
          params={{ bu }}
          noun="movements"
        />
      </Card>

      <Card className="p-4" as="div">
        <p className="label mb-1.5">Why this is not on the profit and loss</p>
        <p className="text-xs leading-relaxed text-muted max-w-[70ch]">
          Your own money going in or out of a business is not trading. Booking a drawing as an
          expense is the most common reason an owner-run group&rsquo;s profit figure is wrong, and
          it always makes the business look worse than it is. Keeping it here means the profit
          figure answers &ldquo;is this business worth running&rdquo; and this page answers
          &ldquo;which one am I living off&rdquo;, which are different questions.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed max-w-[70ch]">
          Every figure on this page is re-derived from the ledger on each visit — nothing here is a
          stored balance that could drift from the journals it summarises.
          {thresholds.configured
            ? ""
            : " The staleness and materiality thresholds are placeholders and are shown as such until the owner and the accountant agree them (Q-10)."}
        </p>
      </Card>
    </div>
  );
}

/**
 * One business on a diverging scale, zero in the middle.
 *
 * `BarRow` is the house primitive for a breakdown list and it already renders
 * negatives on the far side of a baseline — but it baselines at the LEFT edge,
 * which is right for "revenue by business" and wrong here. WF-05 §5 asks for a
 * zero-centred scale specifically, because the reading the owner needs is
 * "which side of the line is this business on", and a left-baselined bar makes
 * a business he funds and one he lives off differ only by colour.
 */
function DivergingRow({
  position,
  widest,
  currency,
}: {
  position: OwnerLedgerPosition;
  widest: number;
  currency: string;
}) {
  const out = position.net < 0;
  const pct = Math.min(50, Math.max(position.net === 0 ? 0 : 1.5, (Math.abs(position.net) / widest) * 50));
  const color = out ? "var(--negative)" : BU_COLOR[position.colorToken] ?? "var(--positive)";

  return (
    <Link
      href={`/finance/owner?bu=${position.businessUnitId ?? "unallocated"}`}
      className="block py-1.5 -mx-1 px-1 rounded hover:bg-surface-2"
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-medium truncate flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: BU_COLOR[position.colorToken] ?? "var(--color-bu-slate)" }}
            aria-hidden
          />
          {position.name}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {position.isStale && position.daysSinceLastMovement !== null && (
            <DaysPill days={position.daysSinceLastMovement} />
          )}
          <span className="text-xs font-semibold tnum" style={{ color: out ? "var(--negative)" : undefined }}>
            {position.net === 0 ? "—" : `${out ? "−" : "+"}${formatMoney(Math.abs(position.net), currency, 0)}`}
          </span>
        </span>
      </div>
      {/* Two halves of one track. The centre line is the zero, so a bar's SIDE
          carries the direction and its length carries only the size. */}
      <div className="flex items-center h-1.5" role="presentation">
        <div className="flex-1 flex justify-end h-full rounded-l-full overflow-hidden" style={{ background: "var(--surface-3)" }}>
          {out && <div className="h-full" style={{ width: `${pct * 2}%`, background: color }} />}
        </div>
        <div className="w-px h-2.5 shrink-0" style={{ background: "var(--border)" }} />
        <div className="flex-1 h-full rounded-r-full overflow-hidden" style={{ background: "var(--surface-3)" }}>
          {!out && position.net !== 0 && (
            <div className="h-full" style={{ width: `${pct * 2}%`, background: color }} />
          )}
        </div>
      </div>
      <div className="text-2xs text-subtle mt-1">
        {position.movements} movement{position.movements === 1 ? "" : "s"}
        {position.lastMovementOn ? ` · last on ${position.lastMovementOn}` : ""}
        {position.ageDays !== null
          ? ` · oldest still out ${position.ageDays} day${position.ageDays === 1 ? "" : "s"}`
          : ""}
      </div>
    </Link>
  );
}
