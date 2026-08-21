import { can } from "@nexus/core";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { recordCashPaymentAction } from "@/lib/actions/manual";
import { Card } from "@/components/ui";
import { loadCashScreen } from "../data";
import {
  AmountField,
  EffectNote,
  EntryShell,
  NotAllowed,
  businessOptions,
  cashPointOptions,
} from "../form-parts";

export const dynamic = "force-dynamic";

/**
 * FR-M02 — paid cash.
 *
 * Two things on this screen are not decoration.
 *
 * THE FLOAT LINE. It states what the till holds now, because the entry is
 * refused if this would take it below zero (EC-13) and being told that before
 * typing an amount is better than being told after. A negative till is not a
 * policy question — it means a receipt was never entered — so the refusal is
 * enforced by the service, not warned about here. The override is behind a
 * disclosure, needs a written reason, and needs a manager.
 *
 * THE VAT QUESTION, asked only if there is a tax invoice. Reclaiming VAT
 * without one is not allowed, and most cash spending in this business has none.
 * When there is one, the only thing that decides recoverability is what the
 * money was spent ON: a filter fitted to a residential flat is an
 * irrecoverable cost even though the supplier charged 5%, because residential
 * rent is exempt. That is the single most important UAE rule in the system and
 * it is asked in one plain sentence, at the moment it applies.
 */
export default async function PaidCashPage() {
  const { session, today, businessUnits, cashPoints, categories } = await loadCashScreen();
  if (!can(session.principal, "payment:create")) {
    return <NotAllowed what="Paid cash" permission="payment:create" />;
  }

  const points = cashPointOptions(cashPoints);
  const mayOverride = can(session.principal, "payment:void");
  const lowest = [...cashPoints].sort((a, b) => a.balance - b.balance)[0];

  return (
    <EntryShell
      title="Paid cash"
      lede="Money that left a till or a pocket. Say what it was for — the account it lands on follows from that."
    >
      <Card className="p-4" as="div">
        <ActionForm
          action={recordCashPaymentAction}
          submitLabel="Record it"
          pendingLabel="Recording…"
        >
          <AmountField currency={session.baseCurrency} />

          <div className="grid gap-3 sm:grid-cols-2 mt-2 mb-3">
            <Field
              name="businessUnitId"
              label="Which business?"
              options={businessOptions(businessUnits)}
              required
            />
            <Field
              name="category"
              label="What for?"
              options={categories.map((c) => ({ value: c.key, label: c.label }))}
            />
            <Field name="paidOn" label="When?" type="date" defaultValue={today} required />
            {points && <Field name="cashPointId" label="Out of which till?" options={points} />}
          </div>

          <EffectNote>
            {lowest
              ? `Lowest till right now: ${lowest.businessUnitName} at AED ${lowest.balance.toLocaleString("en-AE")}.`
              : "The books do not show any cash held yet."}
            <br />
            A till cannot go below zero. If this would, it is refused — that almost always means
            money came in that nobody recorded, so look for the missing receipt first.
          </EffectNote>

          <Disclosure summary="The supplier gave a tax invoice">
            <div className="grid gap-3 mb-2">
              <Field
                name="servesTaxCode"
                label="What was the money spent on?"
                options={[
                  { value: "", label: "No tax invoice — do not reclaim any VAT" },
                  { value: "VAT5", label: "Something the business charges VAT on" },
                  { value: "EXEMPT", label: "A flat or villa we rent out (VAT cannot be reclaimed)" },
                  { value: "PARKING", label: "The parking business" },
                ]}
              />
              <p className="text-2xs text-subtle leading-relaxed">
                Not what the supplier charged — what the money was spent on. VAT on the upkeep of
                residential property can never be reclaimed, whatever the supplier put on the
                invoice, because residential rent is exempt. Left blank, nothing is reclaimed and
                the whole amount is treated as a cost, which is the safe answer.
              </p>
              <Field name="note" label="Note" placeholder="Optional" />
            </div>
          </Disclosure>

          {mayOverride && (
            <Disclosure summary="Record it even though the till has not got it">
              <div className="grid gap-3 mb-2">
                <Field
                  name="overrideReason"
                  label="Why is the till short?"
                  placeholder="The morning float was never entered into the system"
                />
                <p className="text-2xs leading-relaxed" style={{ color: "var(--caution)" }}>
                  This records a till going below zero, which cannot physically happen. Use it
                  only when you know why — the reason, your name and the balance either side all
                  go into the audit trail, and the negative balance stays visible until the
                  missing entry is found.
                </p>
              </div>
            </Disclosure>
          )}
        </ActionForm>
      </Card>
    </EntryShell>
  );
}
