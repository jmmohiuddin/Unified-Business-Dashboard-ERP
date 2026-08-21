import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import {
  CASH_SESSION_PERMISSION,
  CASH_VARIANCE_ACK_PERMISSION,
  canViewCashRegister,
  can,
  formatMoney,
  loadCashBoard,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadBusinessUnits } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import {
  BuTag,
  DataTable,
  PageHeader,
  StatStrip,
  TableEmpty,
} from "@/components/page";
import {
  acknowledgeCashVarianceAction,
  createCashRegisterAction,
  openCashSessionAction,
  recordCashVarianceReasonAction,
  submitCashCountAction,
} from "@/lib/actions/cash-sessions";
import { VariancePlot, variancePattern, type VariancePoint } from "./variance-plot";

export const dynamic = "force-dynamic";

/**
 * THE CASH REGISTER — FR-M07, WF-05 §4.
 *
 * The screen a salon manager opens twice a day, on a tablet, wearing gloves.
 * Three things it has to get right and one it has to not get wrong.
 *
 * RIGHT: (1) which tills are open and who has them; (2) closing one is a count
 * and a button, not a form; (3) the variance history is a scatter by till, so a
 * pattern is visible instead of each day being judged alone.
 *
 * NOT WRONG: an open session's expected cash is not on this page. It is not
 * fetched, not passed as a prop, not rendered hidden, and not in the RSC
 * payload — `loadCashBoard` cannot produce it and asserts as much on the way
 * out. The reconciliation the cashier sees is the RETURN VALUE of the submit
 * that carried their count. See WF-05 §4.2, which calls this non-negotiable,
 * and the header of `packages/core/src/services/cash-sessions.ts`, which
 * explains how it is enforced rather than merely promised.
 *
 * The five states of WF-05 §0 are all here: default below, `loading.tsx`,
 * `error.tsx`, the "no cash points yet" empty state with its setup path, and
 * the permission-denied card immediately after the session lookup.
 */
export default async function CashRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ close?: string }>;
}) {
  const session = await requireSession();
  const { close: focusedSessionId } = await searchParams;
  const ccy = session.baseCurrency;

  const mayView = canViewCashRegister(session.principal.permissions);
  const mayHandleCash = can(session.principal, CASH_SESSION_PERMISSION);
  const maySignOff = can(session.principal, CASH_VARIANCE_ACK_PERMISSION);
  const maySetUp = can(session.principal, "settings:update");

  /* ── STATE: permission denied ───────────────────────────────────────────── */
  // Deliberately a real answer rather than a 404. The nav hides this route from
  // roles without the permission (WF-05 §17), so anyone landing here followed a
  // link or a bookmark, and "you cannot see this, here is the permission you
  // would need" is more use to them and to whoever they ask than a dead end.
  if (!mayView) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Cash" />
        <Card className="p-5" as="div">
          <p className="text-xs font-semibold">You do not have access to the cash register.</p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[52ch]">
            Till floats, day-end counts and variance history need either{" "}
            <code className="text-2xs">pos:read</code> (people who work a till) or{" "}
            <code className="text-2xs">report:read</code> (people who read the numbers it
            produces). Ask whoever manages access on the People and access screen.
          </p>
        </Card>
      </div>
    );
  }

  // One transaction for the whole screen: one SET LOCAL, one connection, the
  // board and the setup form's account list together. `loadBusinessUnits` opens
  // its own and is `cache()`d across the layout and this page, so it stays out
  // of this block rather than nesting a savepoint inside it.
  const businessUnits = await loadBusinessUnits(session);
  const { board, cashAccounts } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => ({
      board: await loadCashBoard(tx, { windowDays: 30, limit: 60, timezone: session.timezone }),
      // Only postable asset accounts with a system key can back a till — a
      // variance is posted by key, so a till on an unkeyed account could not be
      // closed. Filtering here means the setup form cannot offer a broken one.
      cashAccounts: await tx.execute<{ system_key: string; code: string; name: string }>(sql`
        SELECT system_key, code, name FROM accounts
         WHERE type = 'asset' AND system_key IS NOT NULL
           AND is_postable = true AND is_active = true
           AND code LIKE '11%'
         ORDER BY code
      `),
    }),
  );

  /* ── STATE: empty ───────────────────────────────────────────────────────── */
  // Not "no data" — "nothing has been set up". Those need different screens:
  // the first is a wait, the second is a task, and showing an empty table for
  // the second is how a product reads as broken on day one.
  if (board.registers.length === 0) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Cash" subtitle="Till floats, day-end counts and variance" />
        <Card>
          <EmptyState
            icon="▣"
            title="No cash points yet"
            detail="A cash point is a physical place that holds money — the salon till, the parking kiosk, your pocket float. Add one and it can be opened with a float each morning and counted each night."
          />
          {maySetUp ? (
            <div className="border-t" style={{ borderColor: "var(--border)" }}>
              <SetupForm businessUnits={businessUnits} cashAccounts={cashAccounts} />
            </div>
          ) : (
            <p className="px-4 pb-5 text-2xs text-subtle text-center">
              Setting up a cash point needs the <code className="text-2xs">settings:update</code>{" "}
              permission.
            </p>
          )}
        </Card>
      </div>
    );
  }

  /* ── STATE: default ─────────────────────────────────────────────────────── */

  const idleTills = board.registers.filter((r) => r.isActive && !r.hasOpenSession);
  const awaitingSignOff = board.open.filter((s) => s.awaitingAcknowledgement);
  const shortCloses = board.closed.filter((s) => s.variance < 0).length;
  const focused = board.closed.find((s) => s.sessionId === focusedSessionId);

  const points: VariancePoint[] = board.closed.map((s) => ({
    sessionId: s.sessionId,
    registerId: s.registerId,
    registerName: s.registerName,
    colorToken: s.colorToken,
    closedAt: s.closedAt,
    closedOn: s.closedOn,
    variance: s.variance,
    openedBy: s.openedBy,
  }));
  const conclusion = variancePattern(board.pattern, ccy);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <PageHeader
        title="Cash"
        subtitle="Till floats, day-end counts and variance"
      />

      <StatStrip
        stats={[
          {
            label: "Open now",
            value: String(board.open.length),
            tone: board.open.length > 0 ? "accent" : "default",
            hint: `${idleTills.length} till${idleTills.length === 1 ? "" : "s"} closed`,
          },
          {
            label: "Waiting on a manager",
            value: String(awaitingSignOff.length),
            tone: awaitingSignOff.length > 0 ? "caution" : "positive",
            hint: awaitingSignOff.length > 0 ? "counted, not yet closed" : "nothing outstanding",
          },
          {
            label: "Closes, 30 days",
            value: String(board.closed.length),
            hint: `across ${board.pattern.length} till${board.pattern.length === 1 ? "" : "s"}`,
          },
          {
            label: "Short closes",
            value: String(shortCloses),
            tone: shortCloses > 0 ? "negative" : "positive",
            // Never a net figure. See the note on the dot plot: a total across
            // tills is the one number that can hide the problem entirely.
            hint: "counted, not netted",
          },
          {
            label: "Sign-off limit",
            value: formatMoney(board.threshold, ccy, 0),
            hint: "placeholder — Q-11",
          },
        ]}
      />

      {/* ── OPEN NOW ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Open now"
          subtitle={
            mayHandleCash
              ? "Count the cash, then enter the total. You will see what was expected afterwards."
              : "You can see which tills are open, but not count them."
          }
        />

        {board.open.length === 0 ? (
          <TableEmpty
            title="Every till is closed"
            detail="Open one below with the cash that is physically in the drawer."
          />
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {board.open.map((s) => (
              <div key={s.sessionId} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: `var(--color-bu-${s.colorToken})` }}
                        aria-hidden
                      />
                      {s.registerName}
                    </p>
                    <p className="text-2xs text-subtle mt-0.5">
                      {s.businessUnitName} · opened{" "}
                      {new Date(s.openedAt).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: session.timezone,
                      })}{" "}
                      by {s.openedBy}
                    </p>
                    <p className="text-2xs text-muted mt-0.5 tnum">
                      Float {formatMoney(s.openingFloat, ccy, 0)} · {s.entryCount}{" "}
                      {s.entryCount === 1 ? "entry" : "entries"}
                    </p>
                  </div>

                  {/*
                    Where the expected figure would go on a lesser screen. It is
                    not rendered as dots or blurred text because there is
                    nothing to blur: the number does not exist until a count is
                    submitted.
                  */}
                  {!s.awaitingAcknowledgement && mayHandleCash && (
                    <div className="shrink-0 w-full sm:w-auto sm:max-w-[15rem]">
                      <ActionForm
                        action={submitCashCountAction}
                        submitLabel="Submit count"
                        pendingLabel="Counting…"
                        hidden={{ sessionId: s.sessionId }}
                        confirm={`Records your count for ${s.registerName}. A till is counted once — the figure cannot be changed afterwards, and that is what makes it evidence. You will see what was expected next.`}
                      >
                        <Field
                          label={`Count the cash and enter the total (${ccy})`}
                          name="countedCash"
                          type="text"
                          placeholder="0.00"
                          required
                          className="mb-2"
                        />
                      </ActionForm>
                    </div>
                  )}
                </div>

                {/* WF-05 §4.3 — counted, over the limit, waiting on the two
                    things the PRD requires before it may close. */}
                {s.awaitingAcknowledgement && (
                  <div
                    className="mt-3 rounded-[var(--radius-md)] px-3 py-2.5"
                    style={{ background: "var(--caution-soft)" }}
                  >
                    <p className="text-2xs font-semibold" style={{ color: "var(--caution)" }}>
                      Counted, and above the {formatMoney(board.threshold, ccy, 0)} limit.
                    </p>
                    <p className="text-2xs mt-1 leading-relaxed" style={{ color: "var(--caution)" }}>
                      {s.closeNote
                        ? `Reason given: "${s.closeNote}". A manager has to acknowledge this before ${s.registerName} closes.`
                        : `Say what happened, then a manager acknowledges it. Until both are done, ${s.registerName} is still open.`}
                    </p>

                    {mayHandleCash && (
                      <div className="mt-2.5">
                        <ActionForm
                          action={recordCashVarianceReasonAction}
                          submitLabel={s.closeNote ? "Update reason" : "Save reason"}
                          variant="ghost"
                          hidden={{ sessionId: s.sessionId }}
                        >
                          <Field
                            label="What happened?"
                            name="reason"
                            type="text"
                            defaultValue={s.closeNote ?? undefined}
                            placeholder="Recount · Paid out, no receipt · Wrong change · Don't know"
                            required
                            className="mb-2"
                          />
                          <p className="text-2xs mb-2" style={{ color: "var(--caution)" }}>
                            &ldquo;Don&rsquo;t know&rdquo; is a real answer. An honest blank is
                            better data than an invented reason.
                          </p>
                        </ActionForm>
                      </div>
                    )}

                    {maySignOff && (
                      <div className="mt-2.5">
                        <ActionForm
                          action={acknowledgeCashVarianceAction}
                          submitLabel="Acknowledge and close"
                          pendingLabel="Closing…"
                          hidden={{ sessionId: s.sessionId }}
                          confirm={`Closes ${s.registerName} and posts the difference to cash over and short. The journal cannot be edited afterwards, only reversed.`}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Opening a till. Inline rather than on its own screen — this is a
            thirty-second task done twice a day on a shared device. */}
        {mayHandleCash && idleTills.length > 0 && (
          <div className="border-t" style={{ borderColor: "var(--border)" }}>
            <Disclosure summary="Open a till">
              <div className="grid gap-3 sm:grid-cols-2">
                {idleTills.map((till) => (
                  <div
                    key={till.registerId}
                    className="rounded-[var(--radius-md)] p-3"
                    style={{ background: "var(--surface-2)" }}
                  >
                    <p className="text-xs font-semibold">{till.name}</p>
                    <p className="text-2xs text-subtle mb-2">
                      {till.businessUnitName} · {till.accountName}
                    </p>
                    <ActionForm
                      action={openCashSessionAction}
                      submitLabel="Open till"
                      pendingLabel="Opening…"
                      variant="ghost"
                      hidden={{ cashRegisterId: till.registerId }}
                    >
                      <Field
                        label={`Cash in the drawer now (${ccy})`}
                        name="openingFloat"
                        type="text"
                        placeholder="0.00"
                        required
                        className="mb-2"
                      />
                    </ActionForm>
                  </div>
                ))}
              </div>
            </Disclosure>
          </div>
        )}
      </Card>

      {/* ── VARIANCE HISTORY ────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Variance, last 30 days"
          subtitle="One dot per close, coloured by till"
        />
        {points.length === 0 ? (
          <TableEmpty
            title="Nothing closed yet"
            detail="Variance history appears once tills have been counted at the end of a shift."
          />
        ) : (
          <>
            <VariancePlot points={points} threshold={board.threshold} currency={ccy} />
            {conclusion && (
              <p className="px-4 pb-4 text-xs leading-relaxed text-muted max-w-[62ch]">
                {conclusion}
              </p>
            )}
          </>
        )}
      </Card>

      {/* ── ONE CLOSE IN FULL ───────────────────────────────────────────── */}
      {focused && (
        <Card className="p-4" as="div">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold">
                {focused.registerName} · {focused.closedOn}
              </p>
              <p className="text-2xs text-subtle mt-0.5">Closed by {focused.openedBy}</p>
            </div>
            <Link href="/finance/cash" className="text-2xs text-subtle hover:underline">
              Close
            </Link>
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
            {[
              ["Opening float", formatMoney(focused.openingFloat, ccy, 2)],
              ["Counted", formatMoney(focused.countedCash, ccy, 2)],
              ["Expected", formatMoney(focused.expectedCash, ccy, 2)],
              [
                focused.variance === 0 ? "Exact" : focused.variance < 0 ? "Short" : "Over",
                formatMoney(Math.abs(focused.variance), ccy, 2),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="label">{label}</dt>
                <dd className="text-sm font-semibold tnum mt-0.5">{value}</dd>
              </div>
            ))}
          </dl>
          {focused.varianceNote && (
            <p className="text-2xs text-muted mt-3 leading-relaxed">
              Reason given: &ldquo;{focused.varianceNote}&rdquo;
            </p>
          )}
        </Card>
      )}

      {/* ── CLOSED SESSIONS ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Closed sessions" subtitle="Most recent first" />
        <DataTable
          rows={board.closed}
          rowKey={(s) => s.sessionId}
          caption="Closed cash sessions with their counted variance"
          empty={
            <TableEmpty
              title="No closes in the last 30 days"
              detail="A session appears here once it has been counted and closed."
            />
          }
          columns={[
            { key: "day", header: "Day", render: (s) => s.closedOn },
            { key: "till", header: "Till", render: (s) => s.registerName },
            {
              key: "bu",
              header: "Business",
              render: (s) => <BuTag name={s.businessUnitName} color={s.colorToken} />,
            },
            { key: "who", header: "Closed by", render: (s) => s.openedBy },
            {
              key: "counted",
              header: "Counted",
              numeric: true,
              render: (s) => formatMoney(s.countedCash, ccy, 2),
            },
            {
              key: "variance",
              header: "Difference",
              numeric: true,
              render: (s) => (
                <span
                  className="tnum"
                  style={{
                    color:
                      s.variance === 0
                        ? "var(--text-muted)"
                        : Math.abs(s.variance) > board.threshold
                          ? "var(--negative)"
                          : "var(--caution)",
                  }}
                >
                  {s.variance === 0
                    ? "—"
                    : `${s.variance < 0 ? "−" : "+"}${formatMoney(Math.abs(s.variance), ccy, 2)}`}
                </span>
              ),
            },
            {
              key: "why",
              header: "Reason",
              render: (s) =>
                s.varianceNote ? (
                  <span className="text-2xs text-muted">{s.varianceNote}</span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "go",
              header: "",
              render: (s) => (
                <Link
                  href={`/finance/cash?close=${s.sessionId}`}
                  className="text-2xs hover:underline"
                  style={{ color: "var(--accent)" }}
                >
                  →
                </Link>
              ),
            },
          ]}
        />
      </Card>

      {maySetUp && (
        <Card>
          <Disclosure summary="Add a cash point">
            <SetupForm businessUnits={businessUnits} cashAccounts={cashAccounts} />
          </Disclosure>
        </Card>
      )}

      <Card className="p-4" as="div">
        <p className="label mb-1.5">Why the count comes before the figure</p>
        <p className="text-xs leading-relaxed text-muted max-w-[70ch]">
          The expected amount is not sent to this screen while a till is open. It is worked out
          from the ledger the moment your count arrives, and shown to you straight afterwards. If
          the number were visible first, a short drawer would simply be typed as the right answer
          and the whole exercise would measure nothing.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed max-w-[70ch]">
          A difference either way is normal and is posted to cash over and short, so the cash
          account agrees with the drawer. Above{" "}
          {formatMoney(board.threshold, ccy, 0)} a reason and a manager&rsquo;s acknowledgement are
          needed before the till closes. That limit is a placeholder until the owner sets it.
        </p>
      </Card>
    </div>
  );
}

/**
 * Register a cash point.
 *
 * The account choice is the part that matters and the part a non-accountant
 * will not think about, so it is labelled by what it does rather than by its
 * code. Two tills that share an account cannot both be open at once — the
 * service refuses it, because their expected figures would each include the
 * other's takings.
 */
function SetupForm({
  businessUnits,
  cashAccounts,
}: {
  businessUnits: { id: string; name: string }[];
  cashAccounts: { system_key: string; code: string; name: string }[];
}) {
  return (
    <div className="pt-1">
      <ActionForm action={createCashRegisterAction} submitLabel="Add cash point">
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <Field
            label="Name it after the place"
            name="name"
            placeholder="Salon till"
            required
          />
          <Field
            label="Business"
            name="businessUnitId"
            options={businessUnits.map((b) => ({ value: b.id, label: b.name }))}
            required
          />
          <Field
            label="Where its cash sits in the accounts"
            name="accountKey"
            options={cashAccounts.map((a) => ({
              value: a.system_key,
              label: `${a.code} · ${a.name}`,
            }))}
            required
          />
        </div>
      </ActionForm>
    </div>
  );
}
