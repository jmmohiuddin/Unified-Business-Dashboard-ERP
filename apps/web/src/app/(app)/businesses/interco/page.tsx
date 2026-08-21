import Link from "next/link";
import { withTenant } from "@nexus/db";
import { can, formatMoney, formatMoneyCompact, type ServiceContext } from "@nexus/core";
import {
  interBusinessBalances,
  interBusinessEliminations,
  interBusinessReconciliation,
  interBusinessTransfers,
  type InterBusinessBalance,
  type InterBusinessEliminations,
  type InterBusinessReconciliation,
  type InterBusinessTransferRow,
} from "@nexus/core/services";
import { requireSession } from "@/lib/session";
import { loadBusinessUnits, resolveToday } from "@/lib/data";
import {
  recordInterBusinessTransferAction,
  settleInterBusinessAction,
} from "@/lib/actions/interco";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { BU_COLOR, Card, CardHeader, Chip, EmptyState } from "@/components/ui";
import { DataTable, DaysPill, PageHeader, StatStrip, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * BETWEEN BUSINESSES — WF-05 §6.
 *
 * The screen that makes the product's wedge visible. Every other screen shows
 * one business at a time; this one shows what the businesses owe each other,
 * which is the thing seven QuickBooks files structurally cannot show and the
 * reason the owner bought this rather than an eighth one.
 *
 * Three panels, in the order the wireframe puts them, because the order is the
 * argument:
 *
 *  1. WHAT IS OWED, and how long it has sat. A running total is not enough —
 *     the documented failure mode of inter-company balances is going stale for
 *     years, so the age is on the card next to the amount, not behind a filter.
 *  2. DO THE TWO SIDES AGREE. `ok All balances reconcile` is not decoration.
 *     It is EC-16 rendered: if any reciprocal pair fails to match, the ledger
 *     is broken and nothing else on this screen can be trusted, so it turns
 *     into a critical exception rather than being quietly omitted.
 *  3. WHAT IT DOES TO GROUP PROFIT. WF-05 §11 argues the owner will not trust
 *     the group number unless he can see that it is smaller than the sum of the
 *     parts and why. The honest answer is more reassuring than the slogan:
 *     revenue and cost are both grossed up and cancel exactly, and the only
 *     residue is the VAT that genuinely leaves the group.
 *
 * All reads go through the service layer rather than SQL in this file, so the
 * balance shown here and the balance the settlement refuses to overshoot are
 * derived by the same code. Two derivations of "what is owed" is two answers.
 */

const monthStart = (today: string) => `${today.slice(0, 7)}-01`;

function tone(balance: InterBusinessBalance) {
  if (!balance.reconciles) return "negative" as const;
  if ((balance.ageDays ?? 0) > 90) return "caution" as const;
  return "neutral" as const;
}

export default async function IntercoPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  // ── Permission denied ─────────────────────────────────────────────────────
  //
  // Checked here as well as in the service. Not belt-and-braces theatre: the
  // service throws, and a thrown ServiceError on a read would land the user on
  // the generic error boundary saying "something went wrong", which is a lie —
  // nothing went wrong, they are simply not allowed to see this.
  const mayRead = can(session.principal, "report:read");
  if (!mayRead) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Between businesses" />
        <Card className="p-4" as="div">
          <p className="text-xs text-muted leading-relaxed">
            This screen shows what each of your businesses owes the others, which
            means it shows figures from all of them at once. That needs the{" "}
            <code className="text-2xs">report:read</code> permission, which your
            role does not have.
          </p>
        </Card>
      </div>
    );
  }

  const mayPost = can(session.principal, "journal:post");
  const businessUnits = await loadBusinessUnits(session);

  const {
    balances,
    reconciliation,
    eliminations,
    transfers,
  }: {
    balances: InterBusinessBalance[];
    reconciliation: InterBusinessReconciliation;
    eliminations: InterBusinessEliminations;
    transfers: InterBusinessTransferRow[];
  } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const ctx: ServiceContext = {
        tx,
        tenantId: session.tenantId,
        principal: session.principal,
        today,
        baseCurrency: ccy,
      };
      return {
        balances: await interBusinessBalances(ctx),
        reconciliation: await interBusinessReconciliation(ctx),
        eliminations: await interBusinessEliminations(ctx, {
          from: monthStart(today),
          to: today,
        }),
        transfers: await interBusinessTransfers(ctx, { limit: 15 }),
      };
    },
  );

  const open = balances.filter((b) => Number(b.outstanding) !== 0);
  const totalOutstanding = open.reduce((t, b) => t + Number(b.outstanding), 0);
  const oldest = open.reduce((t, b) => Math.max(t, b.ageDays ?? 0), 0);
  const stale = open.filter((b) => (b.ageDays ?? 0) > 90);
  const maxOutstanding = open.reduce((t, b) => Math.max(t, Number(b.outstanding)), 0);

  const colorOf = (token: string) => BU_COLOR[token] ?? "var(--accent)";
  const buOptions = businessUnits.map((b) => ({ value: b.id, label: b.name }));

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <PageHeader
        title="Between businesses"
        subtitle="What your businesses owe each other, and what it does to the group total"
        back={{ href: "/businesses", label: "Businesses" }}
      />

      <StatStrip
        stats={[
          {
            label: "Owed between businesses",
            value: formatMoney(totalOutstanding, ccy),
            hint: `${open.length} open ${open.length === 1 ? "balance" : "balances"}`,
            tone: totalOutstanding > 0 ? "accent" : "default",
          },
          {
            label: "Oldest unsettled",
            value: oldest > 0 ? `${oldest} days` : "—",
            hint: stale.length > 0 ? `${stale.length} over 90 days` : "nothing stale",
            tone: oldest > 90 ? "caution" : "default",
          },
          {
            label: "Charged this month",
            value: formatMoney(Number(eliminations.revenueElimination), ccy),
            hint: `${eliminations.rows.reduce((t, r) => t + r.transfers, 0)} transfers`,
          },
          {
            label: "Effect on group profit",
            value: formatMoney(-Number(eliminations.profitElimination), ccy),
            hint:
              Number(eliminations.profitElimination) === 0
                ? "transfers at cost — no effect"
                : "internal margin removed",
            tone: Number(eliminations.profitElimination) === 0 ? "positive" : "caution",
          },
          {
            label: "Irrecoverable VAT",
            value: formatMoney(Number(eliminations.irrecoverableVat), ccy),
            hint: "a real group cost",
            tone: Number(eliminations.irrecoverableVat) > 0 ? "caution" : "default",
          },
        ]}
      />

      {/* ── The reconcile check — EC-16, surfaced ──────────────────────────── */}
      <ReconcileBanner reconciliation={reconciliation} />

      {/* ── Balances ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Balances"
          subtitle="Each row is one direction. Settling reverses both sides at once."
        />
        {open.length === 0 ? (
          <EmptyState
            title="Nothing owed between your businesses"
            detail={
              balances.length === 0
                ? "No business has paid for or worked for another yet. When one does — a job on your own flat, a bill paid by the wrong company — it will be recorded on both sides and appear here."
                : "Every balance has been settled. New transfers will appear here as they happen."
            }
          />
        ) : (
          <div className="px-4 pb-4 space-y-2.5">
            {open.map((b) => (
              <div
                key={`${b.creditorBusinessUnitId}:${b.debtorBusinessUnitId}`}
                className="rounded-[var(--radius-md)] px-3.5 py-3"
                style={{ background: "var(--surface-2)" }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold flex items-center gap-1.5 flex-wrap">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: colorOf(b.creditorColor) }}
                        aria-hidden
                      />
                      <span>{b.creditorName}</span>
                      <span className="text-subtle" aria-label="owed by">
                        →
                      </span>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: colorOf(b.debtorColor) }}
                        aria-hidden
                      />
                      <span>{b.debtorName}</span>
                    </p>
                    <p className="text-2xs text-subtle mt-1">
                      {b.transfers} {b.transfers === 1 ? "transfer" : "transfers"}
                      {b.settlements > 0 && `, ${b.settlements} settled`} · last movement{" "}
                      {b.lastMovementOn}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-semibold tnum tracking-tight">
                      {formatMoney(Number(b.outstanding), ccy)}
                    </p>
                    <div className="flex items-center gap-1.5 justify-end mt-1">
                      {b.ageDays !== null && <DaysPill days={b.ageDays} />}
                      {!b.reconciles && <Chip tone="negative">does not net</Chip>}
                    </div>
                  </div>
                </div>

                {/* Relative size, so the balance worth acting on is obvious
                    without reading five numbers and comparing them. */}
                <div
                  className="h-1 rounded-full mt-2.5 overflow-hidden"
                  style={{ background: "var(--surface-3)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${maxOutstanding > 0 ? Math.max(2, (Number(b.outstanding) / maxOutstanding) * 100) : 0}%`,
                      background:
                        tone(b) === "negative"
                          ? "var(--negative)"
                          : tone(b) === "caution"
                            ? "var(--caution)"
                            : colorOf(b.creditorColor),
                    }}
                  />
                </div>

                {mayPost ? (
                  <div className="mt-2.5">
                    <ActionForm
                      action={settleInterBusinessAction}
                      submitLabel="Settle"
                      pendingLabel="Settling…"
                      variant="ghost"
                      hidden={{
                        creditorBusinessUnitId: b.creditorBusinessUnitId,
                        debtorBusinessUnitId: b.debtorBusinessUnitId,
                        amount: b.outstanding,
                        settledOn: today,
                        method: "bank",
                      }}
                      // Money genuinely moves between two bank accounts and
                      // there is no undo. The confirmation states the effect,
                      // not "are you sure?".
                      confirm={`${b.debtorName} will pay ${b.creditorName} ${formatMoney(
                        Number(b.outstanding),
                        ccy,
                      )} by bank transfer. Both sides are recorded at once and this cannot be undone from here.`}
                    />
                  </div>
                ) : (
                  <p className="text-2xs text-subtle mt-2.5">
                    Settling needs the <code className="text-2xs">journal:post</code>{" "}
                    permission.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Effect on group profit ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Effect on group profit"
          subtitle={`${eliminations.from} to ${eliminations.to}`}
        />
        <div className="px-4 pb-4">
          {eliminations.rows.length === 0 ? (
            <TableEmpty
              title="No transfers this month"
              detail="Nothing has moved between your businesses in this period, so the group total is simply the sum of the parts."
            />
          ) : (
            <>
              <dl className="text-xs space-y-1.5">
                <Row
                  label="Revenue recorded between businesses"
                  value={formatMoney(Number(eliminations.revenueElimination), ccy)}
                />
                <Row
                  label="Cost recorded between businesses"
                  value={`-${formatMoney(Number(eliminations.costElimination), ccy)}`}
                />
                <div
                  className="border-t pt-1.5"
                  style={{ borderColor: "var(--border)" }}
                />
                <Row
                  label="Net effect on group profit"
                  value={formatMoney(-Number(eliminations.profitElimination), ccy)}
                  strong
                  tone={
                    Number(eliminations.profitElimination) === 0 ? "positive" : "caution"
                  }
                />
                {Number(eliminations.irrecoverableVat) !== 0 && (
                  <Row
                    label="VAT the group cannot reclaim on these"
                    value={`-${formatMoney(Number(eliminations.irrecoverableVat), ccy)}`}
                    tone="negative"
                  />
                )}
                <div
                  className="border-t pt-1.5"
                  style={{ borderColor: "var(--border)" }}
                />
                <Row
                  label="Sum of your businesses"
                  value={formatMoney(Number(eliminations.sumOfBusinessProfit), ccy)}
                />
                <Row
                  label="Group profit"
                  value={formatMoney(Number(eliminations.groupProfit), ccy)}
                  strong
                />
              </dl>

              <p className="text-2xs text-subtle mt-3 leading-relaxed max-w-[60ch]">
                These transfers move money between your businesses. They do not
                make or lose you money — the revenue one business records and the
                cost the other records cancel out exactly
                {Number(eliminations.irrecoverableVat) !== 0 && (
                  <>
                    {" "}
                    — except for {formatMoney(Number(eliminations.irrecoverableVat), ccy)}{" "}
                    of VAT, which really does leave the group, because the
                    business being charged makes exempt supplies and cannot
                    reclaim it
                  </>
                )}
                .
              </p>

              <ul className="mt-3 space-y-1">
                {eliminations.rows.map((r) => (
                  <li
                    key={`${r.creditorBusinessUnitId}:${r.debtorBusinessUnitId}`}
                    className="flex items-baseline justify-between gap-3 text-2xs"
                  >
                    <span className="text-muted truncate">
                      {r.creditorName} → {r.debtorName}
                    </span>
                    <span className="tnum shrink-0">
                      {formatMoneyCompact(Number(r.internalRevenue), ccy)}
                      {Number(r.internalMargin) !== 0 && (
                        <span style={{ color: "var(--caution)" }}>
                          {" "}
                          ({formatMoneyCompact(Number(r.internalMargin), ccy)} margin)
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="text-2xs text-subtle mt-3 leading-relaxed">
                <Link href="/accounting/profit-loss" className="underline">
                  Group profit and loss →
                </Link>
              </p>
            </>
          )}
        </div>
      </Card>

      {/* ── Recent transfers ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Recent transfers"
          subtitle="The pricing basis is what a transfer-pricing enquiry asks for"
        />
        <DataTable
          rows={transfers}
          rowKey={(t) => t.documentId}
          empty={
            <TableEmpty
              title="No transfers recorded"
              detail="When one business pays for or works for another, it will be listed here with the basis it was priced on."
            />
          }
          columns={[
            { key: "date", header: "Date", render: (t) => <span className="tnum">{t.issueDate}</span> },
            { key: "ref", header: "Reference", render: (t) => t.docNumber },
            {
              key: "flow",
              header: "From → to",
              render: (t) => (
                <span className="whitespace-nowrap">
                  {t.payingCode} <span className="text-subtle">→</span> {t.benefitingCode}
                </span>
              ),
            },
            {
              key: "what",
              header: "What",
              render: (t) => <span className="text-muted">{t.description}</span>,
            },
            {
              key: "basis",
              header: "Priced at",
              render: (t) =>
                t.pricingBasis === null ? (
                  // Historic rows carry no basis. Showing "at cost" here would
                  // be inventing evidence for a transfer-pricing file.
                  <Chip tone="caution">not recorded</Chip>
                ) : t.pricingBasis === "arms_length" ? (
                  <Chip tone="accent">market rate</Chip>
                ) : (
                  <Chip>cost</Chip>
                ),
            },
            {
              key: "net",
              header: "Net",
              numeric: true,
              render: (t) => formatMoney(Number(t.net), ccy),
            },
            {
              key: "vat",
              header: "VAT",
              numeric: true,
              render: (t) =>
                Number(t.tax) === 0 ? (
                  <span className="text-subtle">—</span>
                ) : (
                  formatMoney(Number(t.tax), ccy)
                ),
            },
          ]}
        />
      </Card>

      {/* ── Record one ─────────────────────────────────────────────────────── */}
      {mayPost && (
        <Card>
          <Disclosure summary="One business paid for another">
            <p className="text-2xs text-subtle mb-3 leading-relaxed max-w-[62ch]">
              Recorded on both sides in one go: the business that paid shows an
              amount owed to it, the business that benefited shows the cost and
              the amount it owes. Your group total does not change.
            </p>
            <ActionForm
              action={recordInterBusinessTransferAction}
              submitLabel="Record"
              pendingLabel="Recording…"
            >
              <div className="grid gap-2.5 sm:grid-cols-2 mb-3">
                <Field
                  label="Who paid or did the work"
                  name="payingBusinessUnitId"
                  options={buOptions}
                  required
                />
                <Field
                  label="For whom"
                  name="benefitingBusinessUnitId"
                  options={buOptions}
                  required
                />
                <Field label="Amount (excluding VAT)" name="amount" type="number" step="0.01" min="0.01" required />
                <Field label="When" name="transferDate" type="date" defaultValue={today} required />
                <Field
                  label="What"
                  name="nature"
                  options={[
                    { value: "service_performed", label: "Work done" },
                    { value: "shared_cost", label: "Shared cost" },
                    { value: "cash_advance", label: "Cash advance" },
                  ]}
                />
                <Field
                  label="Priced at"
                  name="pricingBasis"
                  options={[
                    { value: "at_cost", label: "Cost" },
                    { value: "arms_length", label: "Market rate" },
                  ]}
                />
                <Field
                  label="If market rate, how was it set?"
                  name="pricingBasisNote"
                  placeholder="Price list, third-party quote, comparable job"
                  className="sm:col-span-2"
                />
                <Field label="Note" name="note" className="sm:col-span-2" />
              </div>
            </ActionForm>
          </Disclosure>
        </Card>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "positive" | "caution" | "negative";
}) {
  const color =
    tone === "positive" ? "var(--positive)"
    : tone === "caution" ? "var(--caution)"
    : tone === "negative" ? "var(--negative)"
    : undefined;
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "font-semibold" : "text-muted"}>{label}</dt>
      <dd
        className={`tnum shrink-0 ${strong ? "font-semibold" : ""}`}
        style={color ? { color } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * `ok All balances reconcile` — or the critical exception it becomes.
 *
 * WF-05 §6 is specific that this line turns into a critical exception if any
 * reciprocal pair fails to match, and TRD-03 ADR-006 makes the same check
 * CI-gated. A green tick that cannot go red is worse than no tick: it teaches
 * the owner that the number is checked when nothing is checking it.
 */
function ReconcileBanner({
  reconciliation,
}: {
  reconciliation: InterBusinessReconciliation;
}) {
  if (reconciliation.ok) {
    return (
      <div
        className="rounded-[var(--radius-md)] px-3.5 py-2.5 flex items-center gap-2 text-2xs"
        style={{ background: "var(--positive-soft)", color: "var(--positive)" }}
        role="status"
      >
        <span aria-hidden>✓</span>
        <span>
          All balances reconcile — every amount one business is owed matches
          exactly what the other records owing, across{" "}
          {reconciliation.pairsChecked}{" "}
          {reconciliation.pairsChecked === 1 ? "pair" : "pairs"}.
        </span>
      </div>
    );
  }

  return (
    <div
      className="rounded-[var(--radius-md)] px-3.5 py-3 text-2xs leading-relaxed"
      style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
      role="alert"
    >
      <p className="font-semibold">Balances do not reconcile. Do not close the period.</p>
      <p className="mt-1">
        One side of an inter-business balance does not match the other, which
        means the general ledger disagrees with itself. Every figure on this
        screen is unreliable until it is fixed.
      </p>
      <ul className="mt-2 space-y-1">
        {reconciliation.breaks.map((b) => (
          <li key={`${b.creditorCode}:${b.debtorCode}`} className="tnum">
            {b.creditorCode} → {b.debtorCode}: owed {b.dueFrom}, recorded owing {b.dueTo} (out
            by {b.difference})
          </li>
        ))}
        {reconciliation.malformed.map((m) => (
          <li key={m.journalId}>
            {m.journalNumber} ({m.postingDate}) {m.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
