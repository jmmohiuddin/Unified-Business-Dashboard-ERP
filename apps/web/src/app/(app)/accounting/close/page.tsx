import Link from "next/link";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import {
  displayPeriod,
  getPeriodOverview,
  PERM_CLOSE,
  PERM_READ,
  PERM_REOPEN,
  REOPEN_MIN_ROLE_LEVEL,
  type ChecklistItem,
  type PeriodOverview,
} from "@nexus/core/services";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { closePeriodAction, reopenPeriodAction } from "@/lib/actions/periods";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { DataTable, PageHeader, StatStrip, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * MONTH-END CLOSE.  FR-C01, WF-05 §10.4.
 *
 * The screen that turns `assertPeriodOpen` from unreachable code into a working
 * control. That guard has been called by `postJournal` on every posting in the
 * product's life and has never once fired, because nothing anywhere wrote a row
 * to `fiscal_periods` for it to read. This page is where the row comes from.
 *
 * Three things it refuses to do, all for the same reason — that a control which
 * only exists in the browser is not a control:
 *
 *   It does not decide who may close. The button is hidden without
 *   `period:close`, but the service checks it again and would refuse a
 *   hand-rolled POST.
 *
 *   It does not decide whether the checklist is satisfied. The counts here and
 *   the counts the service re-reads inside the closing transaction come from
 *   the same function; the ones that matter are the second set, because the
 *   first are already stale by the time the button is pressed.
 *
 *   It does not make reopening easier. The reopen panel is behind a
 *   `Disclosure` and asks for the label and a reason, and every one of those
 *   gates is enforced in `periods.ts` as well.
 *
 * The five states of WF-05 §0: default and empty are below, `loading.tsx` is
 * beside this file, the error state is the group boundary in
 * `app/(app)/error.tsx`, and permission-denied is the first branch of the
 * component — checked before the service is called, so a user without
 * `report:read` gets an explanation rather than the error boundary.
 */

const TONE = {
  ok: { fg: "var(--positive)", bg: "var(--positive-soft)", mark: "✓" },
  warning: { fg: "var(--caution)", bg: "var(--caution-soft)", mark: "!" },
  blocking: { fg: "var(--negative)", bg: "var(--negative-soft)", mark: "×" },
  info: { fg: "var(--text-muted)", bg: "var(--surface-3)", mark: "·" },
} as const;

function toneOf(item: ChecklistItem) {
  if (item.count === 0) return TONE.ok;
  if (item.severity === "blocking") return TONE.blocking;
  if (item.severity === "warning") return TONE.warning;
  return TONE.info;
}

/** "2026-07" → "Jul 26", for a row of chips that has to fit a phone. */
function shortLabel(label: string): string {
  const [name, year] = displayPeriod(label).split(" ");
  return `${name?.slice(0, 3) ?? label} ${year?.slice(2) ?? ""}`;
}

export default async function ClosePeriodPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const ccy = session.baseCurrency;

  // ── Permission denied ─────────────────────────────────────────────────────
  if (!can(session.principal, PERM_READ)) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Close period" />
        <Card className="p-4" as="div">
          <p className="text-xs text-muted leading-relaxed">
            The month-end close is part of the books. Seeing it needs the{" "}
            <code className="text-2xs">{PERM_READ}</code> permission, which the accountant, the
            general manager and the owner hold.
          </p>
        </Card>
      </div>
    );
  }

  const { period } = await searchParams;
  const overview: PeriodOverview = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      getPeriodOverview(
        {
          tx,
          tenantId: session.tenantId,
          principal: session.principal,
          today: resolveToday(session.timezone),
          baseCurrency: session.baseCurrency,
        },
        { label: period ?? null },
      ),
  );

  const isClosed = overview.status === "closed";
  const mayClose = can(session.principal, PERM_CLOSE);
  const mayReopen =
    can(session.principal, PERM_REOPEN) && session.principal.roleLevel >= REOPEN_MIN_ROLE_LEVEL;
  const blockers = overview.checklist.filter((c) => c.severity === "blocking" && c.count > 0);
  const cautions = overview.checklist.filter((c) => c.severity === "warning" && c.count > 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="Close period"
        subtitle={`${overview.displayLabel} · ${overview.startsOn} to ${overview.endsOn}`}
        back={{ href: "/compliance", label: "Compliance" }}
      />

      {/* Period picker. Links rather than a select, so the URL is shareable and
          the page needs no client JavaScript. */}
      <div className="flex gap-1 flex-wrap">
        {overview.selectable.map((label) => {
          const active = label === overview.label;
          return (
            <Link
              key={label}
              href={`/accounting/close?period=${label}`}
              className="px-2.5 py-1 rounded-[var(--radius-md)] text-2xs font-semibold transition-colors"
              style={
                active
                  ? { background: "var(--accent)", color: "var(--text-inverse)" }
                  : { background: "var(--surface-2)", color: "var(--text-muted)" }
              }
            >
              {shortLabel(label)}
            </Link>
          );
        })}
      </div>

      <StatStrip
        stats={[
          {
            label: "Status",
            value: isClosed ? "Closed" : overview.status === "unopened" ? "Never closed" : "Open",
            tone: isClosed ? "positive" : "caution",
            hint: isClosed
              ? `by ${overview.closedBy ?? "someone"}${overview.closedAt ? ` · ${overview.closedAt}` : ""}`
              : overview.hasEnded
                ? "the month has ended"
                : "still running",
          },
          { label: "Journals in the month", value: String(overview.journalCount) },
          {
            label: "Debits",
            value: formatMoney(Number(overview.trialBalance.debits), ccy, 0),
          },
          {
            label: "Credits",
            value: formatMoney(Number(overview.trialBalance.credits), ccy, 0),
          },
          {
            label: overview.trialBalance.balanced ? "Balanced" : "OUT OF BALANCE",
            value: overview.trialBalance.balanced ? "✓" : "✗",
            tone: overview.trialBalance.balanced ? "positive" : "negative",
            hint: "Dr = Cr",
          },
        ]}
      />

      {/* ── Before you close ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Before you close"
          subtitle={
            blockers.length > 0
              ? `${blockers.length} must be fixed first`
              : cautions.length > 0
                ? `${cautions.length} to review — none of them stop the close`
                : "Nothing outstanding"
          }
        />
        <DataTable
          rows={overview.checklist}
          rowKey={(c) => c.key}
          empty={<TableEmpty title="No checks configured" detail="Nothing to show." />}
          columns={[
            {
              key: "mark",
              header: "",
              width: "2.25rem",
              render: (c) => {
                const tone = toneOf(c);
                return (
                  <span
                    className="w-5 h-5 rounded-full grid place-items-center text-2xs font-semibold"
                    style={{ background: tone.bg, color: tone.fg }}
                    aria-hidden
                  >
                    {tone.mark}
                  </span>
                );
              },
            },
            {
              key: "label",
              header: "Check",
              render: (c) => (
                <div>
                  <p className="font-medium">{c.label}</p>
                  <p className="text-2xs text-subtle leading-relaxed">{c.detail}</p>
                </div>
              ),
            },
            {
              key: "count",
              header: "Outstanding",
              numeric: true,
              render: (c) =>
                c.count === 0 ? (
                  <span className="text-subtle">nil</span>
                ) : (
                  <div>
                    <p className="tnum font-semibold" style={{ color: toneOf(c).fg }}>
                      {c.count}
                    </p>
                    {c.amount && (
                      <p className="text-2xs text-subtle tnum">
                        {formatMoney(Number(c.amount), ccy, 0)}
                      </p>
                    )}
                  </div>
                ),
            },
            {
              key: "fix",
              header: "",
              width: "4rem",
              render: (c) =>
                c.count > 0 && c.href ? (
                  <Link
                    href={c.href}
                    className="text-2xs font-semibold hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    Fix →
                  </Link>
                ) : null,
            },
          ]}
        />
      </Card>

      {/* ── Trial balance ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Trial balance"
          subtitle={`Everything posted between ${overview.startsOn} and ${overview.endsOn}`}
          href="/accounting/profit-loss"
        />
        {overview.journalCount === 0 ? (
          <EmptyState
            title="Nothing was posted in this month"
            detail="An empty month can still be closed — that is what stops something being backdated into it later."
            icon="○"
          />
        ) : (
          <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <p className="label">Debits</p>
              <p className="text-lg font-semibold tnum tracking-tight">
                {formatMoney(Number(overview.trialBalance.debits), ccy, 2)}
              </p>
            </div>
            <div>
              <p className="label">Credits</p>
              <p className="text-lg font-semibold tnum tracking-tight">
                {formatMoney(Number(overview.trialBalance.credits), ccy, 2)}
              </p>
            </div>
            <div>
              <p className="label">Difference</p>
              <p
                className="text-lg font-semibold tnum tracking-tight"
                style={{
                  color: overview.trialBalance.balanced ? "var(--positive)" : "var(--negative)",
                }}
              >
                {overview.trialBalance.balanced
                  ? "Balanced"
                  : formatMoney(
                      Number(overview.trialBalance.debits) -
                        Number(overview.trialBalance.credits),
                      ccy,
                      2,
                    )}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* ── The action ───────────────────────────────────────────────────── */}
      {isClosed ? (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--positive)" }}>
            {overview.displayLabel} is closed.
          </p>
          <p className="text-2xs text-muted mt-1 leading-relaxed">
            Closed by {overview.closedBy ?? "someone"}
            {overview.closedAt ? ` on ${overview.closedAt}` : ""}. Any posting dated inside it is
            refused by the ledger, whichever screen or API it comes from.
          </p>

          {mayReopen ? (
            <div className="mt-3 -mx-4 border-t pt-1" style={{ borderColor: "var(--border)" }}>
              <Disclosure summary="Reopen this period">
                <p className="text-2xs text-muted leading-relaxed mb-3">
                  Reopening lets anyone post into {overview.displayLabel} again, including into a
                  quarter whose VAT return has been filed. Periods reopen newest first, and the
                  reason below is kept on the audit log permanently — it is the only record of why
                  a filed month was changed.
                </p>
                <ActionForm
                  action={reopenPeriodAction}
                  submitLabel="Reopen period"
                  pendingLabel="Reopening…"
                  variant="ghost"
                  hidden={{ label: overview.label }}
                  confirm={`This unlocks ${overview.displayLabel} for everyone. ${overview.journalCount} journals in it become changeable, and reports already sent out can move.`}
                >
                  <div className="grid sm:grid-cols-2 gap-3 mb-3">
                    <Field
                      label={`Type ${overview.label} to confirm`}
                      name="confirmLabel"
                      placeholder={overview.label}
                      required
                    />
                    <Field
                      label="Reason (kept on the audit log)"
                      name="reason"
                      placeholder="Supplier credit note arrived after the close…"
                      required
                    />
                  </div>
                </ActionForm>
              </Disclosure>
            </div>
          ) : (
            <p className="text-2xs text-subtle mt-2">
              Only the owner can reopen a closed period. Ask Sumon.
            </p>
          )}
        </Card>
      ) : !overview.hasEnded ? (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold">{overview.displayLabel} has not ended yet.</p>
          <p className="text-2xs text-muted mt-1 leading-relaxed">
            A month still running has takings in it that have not happened. It can be closed from{" "}
            {overview.endsOn} onwards.
          </p>
        </Card>
      ) : !mayClose ? (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted leading-relaxed">
            You can see the checklist but not close the month. That needs the{" "}
            <code className="text-2xs">{PERM_CLOSE}</code> permission, which the accountant and the
            owner hold.
          </p>
        </Card>
      ) : blockers.length > 0 ? (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            {overview.displayLabel} cannot be closed yet.
          </p>
          <p className="text-2xs text-muted mt-1 leading-relaxed">
            {blockers.map((b) => `${b.label.toLowerCase()} (${b.count})`).join(", ")}. Freezing the
            month now would make the error permanent — fix these first, then come back.
          </p>
        </Card>
      ) : (
        <Card className="p-4" as="div">
          <ActionForm
            action={closePeriodAction}
            submitLabel={`Close ${overview.displayLabel}`}
            pendingLabel="Closing…"
            hidden={{ label: overview.label }}
            confirm={
              `Nobody will be able to post into ${overview.displayLabel} after this` +
              (overview.cascade.months > 0
                ? `, or into the ${overview.cascade.months} earlier month${
                    overview.cascade.months === 1 ? "" : "s"
                  } back to ${displayPeriod(overview.cascade.earliest ?? overview.label)}, which have never been closed`
                : "") +
              ". Only the owner can reopen it."
            }
          >
            {cautions.length > 0 && (
              <label className="flex items-start gap-2 mb-3 text-2xs leading-relaxed cursor-pointer">
                <input
                  type="checkbox"
                  name="acknowledgeWarnings"
                  required
                  className="mt-0.5 shrink-0"
                />
                <span className="text-muted">
                  I have reviewed the {cautions.length} item
                  {cautions.length === 1 ? "" : "s"} above —{" "}
                  {cautions.map((c) => c.label.toLowerCase()).join(", ")} — and{" "}
                  {overview.displayLabel} is correct as it stands.
                </span>
              </label>
            )}
            <Field
              label="Note (optional, kept on the audit log)"
              name="note"
              placeholder="Reviewed with Priya, VAT computed."
              className="mb-3"
            />
          </ActionForm>

          <p className="text-2xs text-subtle mt-3 leading-relaxed">
            Closing freezes the month in the ledger itself, not just on this screen: every posting
            path calls the same guard.
            {overview.cascade.months > 0 && (
              <>
                {" "}
                It also freezes the {overview.cascade.months} earlier month
                {overview.cascade.months === 1 ? "" : "s"} back to{" "}
                {displayPeriod(overview.cascade.earliest ?? overview.label)}, and everything before
                the ledger begins — a month left unmaterialised is a month that is still writable,
                so &ldquo;closed to {overview.endsOn}&rdquo; would otherwise not be true.
              </>
            )}
          </p>
        </Card>
      )}
    </div>
  );
}
