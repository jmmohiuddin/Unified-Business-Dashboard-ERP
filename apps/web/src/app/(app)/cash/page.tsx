import Link from "next/link";
import { can } from "@nexus/core";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { reverseEntryAction } from "@/lib/actions/manual";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { Money, PageHeader, StatStrip, TableEmpty } from "@/components/page";
import { loadCashScreen } from "./data";

export const dynamic = "force-dynamic";

/**
 * CASH ENTRY — the chooser.
 *
 * WF-05 §3.1: the `⊕` opens a sheet asking "What happened?" in five tiles, and
 * the target is fifteen seconds, one-handed. This is that sheet as a route,
 * because the product is server rendered and a route is shareable, linkable and
 * costs no client JavaScript — the shell can open it in a sheet later without
 * anything here changing.
 *
 * The tiles say what the user did, not what the ledger will do. "Took my money
 * out" rather than "Owner drawing (DR 3200)". Every one of them lands on a form
 * with four fields or fewer, and the account each posting hits is decided by
 * the service, never chosen here.
 *
 * The float figures under the tiles are the second half of the design: they are
 * the number the user can check against the notes in their hand, which is the
 * only reason a recorded cash balance is worth anything.
 */
export default async function CashPage() {
  const { session, cashPoints, entries, owner, today } = await loadCashScreen();
  const mayRecord = can(session.principal, "payment:create");
  const mayJournal = can(session.principal, "journal:post");
  const mayReverse = can(session.principal, "journal:reverse");

  if (!mayRecord && !mayJournal) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Cash" />
        <Card className="p-6" as="div">
          <p className="text-xs font-semibold">You cannot record money on this account.</p>
          <p className="text-2xs text-subtle mt-1.5 max-w-[52ch] leading-relaxed">
            Recording cash needs the <code className="text-2xs">payment:create</code>{" "}
            permission. Ask the owner or the accountant to add it — everything you record is
            stamped with your name, so it is given to a person, not to a device.
          </p>
        </Card>
      </div>
    );
  }

  const totalCash = cashPoints.reduce((t, p) => t + p.balance, 0);
  const negative = cashPoints.filter((p) => p.balance < 0);

  const tiles = [
    { href: "/cash/received", title: "Received cash", hint: "Someone paid you", show: mayRecord },
    { href: "/cash/paid", title: "Paid cash", hint: "You paid someone", show: mayRecord },
    { href: "/cash/owner-in", title: "Put my money in", hint: "Your own money, into the business", show: mayRecord },
    { href: "/cash/owner-out", title: "Took my money out", hint: "Your own money, out again", show: mayRecord },
    { href: "/cash/journal", title: "Manual journal", hint: "Accountant only", show: mayJournal },
  ].filter((t) => t.show);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="What happened?"
        subtitle={`Recording as ${session.fullName} · ${today}`}
      />

      <StatStrip
        stats={[
          { label: "Cash in hand", value: `AED ${totalCash.toLocaleString("en-AE")}` },
          { label: "Cash points", value: String(cashPoints.length) },
          {
            label: "Owner net position",
            value: `AED ${Math.abs(owner.net).toLocaleString("en-AE")}`,
            hint: owner.net < 0 ? "taken out, net" : "put in, net",
            tone: owner.net < 0 ? "caution" : "positive",
          },
          {
            label: "Below zero",
            value: String(negative.length),
            tone: negative.length > 0 ? "negative" : "default",
            hint: negative.length > 0 ? "an entry is missing somewhere" : undefined,
          },
        ]}
      />

      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="card px-4 py-5 min-h-[88px] flex flex-col justify-center hover:bg-surface-2 transition-colors"
          >
            <p className="text-sm font-semibold tracking-tight">{t.title}</p>
            <p className="text-2xs text-subtle mt-1">{t.hint}</p>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader
          title="What the books say is in each till"
          subtitle="Count the notes and compare. A number that does not match means an entry is missing"
        />
        {cashPoints.length === 0 ? (
          <TableEmpty
            title="No cash points yet"
            detail="Every business gets one automatically once it has recorded any cash. Nothing to set up."
          />
        ) : (
          <div className="px-4 pb-4 space-y-1.5">
            {cashPoints.map((p) => (
              <div
                key={`${p.businessUnitId}:${p.id ?? "default"}`}
                className="flex items-baseline justify-between gap-3 py-1.5 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="text-xs truncate">{p.businessUnitName}</p>
                  <p className="text-2xs text-subtle truncate">{p.name}</p>
                </div>
                <Money
                  amount={p.balance}
                  currency={session.baseCurrency}
                  tone={p.balance < 0 ? "negative" : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recently recorded"
          subtitle="Nothing here is ever edited or deleted — a mistake is corrected by reversing it"
        />
        {entries.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            detail="Everything you record through the tiles above shows up here, with your name on it."
          />
        ) : (
          <div className="px-4 pb-4 space-y-1">
            {entries.map((e) => (
              <div
                key={e.auditId}
                className="py-2 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      {e.kind}
                      {e.businessUnitName && (
                        <span className="text-subtle font-normal"> · {e.businessUnitName}</span>
                      )}
                      {e.isReversed && (
                        <span
                          className="chip ml-1.5"
                          style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
                        >
                          reversed
                        </span>
                      )}
                      {e.isReversal && (
                        <span
                          className="chip ml-1.5"
                          style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}
                        >
                          reverses {e.reversesJournalNumber}
                        </span>
                      )}
                    </p>
                    <p className="text-2xs text-subtle truncate">
                      {e.at} · {e.actor ?? "unknown"} · {e.journalNumber ?? "no journal"}
                    </p>
                  </div>
                  <Money
                    amount={e.amount}
                    currency={session.baseCurrency}
                    tone={e.isReversed ? "muted" : undefined}
                  />
                </div>

                {mayReverse && e.journalId && !e.isReversed && !e.isReversal && (
                  <div className="mt-1.5">
                    <Disclosure summary="This is wrong">
                      <ActionForm
                        action={reverseEntryAction}
                        submitLabel="Reverse it"
                        variant="ghost"
                        confirm={
                          `This posts the opposite entry against ${e.journalNumber}. Both stay in the ` +
                          `books, linked, and the original is marked as reversed. Nothing is deleted.`
                        }
                      >
                        <input type="hidden" name="journalId" value={e.journalId} />
                        <Field
                          name="reason"
                          label="What went wrong?"
                          placeholder="Rang it up twice"
                          required
                          className="mb-2"
                        />
                      </ActionForm>
                    </Disclosure>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
