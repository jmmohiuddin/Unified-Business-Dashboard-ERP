import { can } from "@nexus/core";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { recordOwnerDrawingAction } from "@/lib/actions/manual";
import { Card } from "@/components/ui";
import { loadCashScreen } from "../data";
import {
  AmountField,
  EntryShell,
  NotAllowed,
  businessOptions,
  cashPointOptions,
} from "../form-parts";

export const dynamic = "force-dynamic";

/**
 * FR-M04 — the owner taking money out.
 *
 * "This is not an expense. It is your own money."
 *
 * WF-05 §3.3 calls that the single most important sentence in the manual-entry
 * module, and it is the reason this screen exists as its own route rather than
 * as an option on "paid cash". The misconception it corrects — that money the
 * owner takes is a business cost — corrupts small-business books more than any
 * other single thing: it understates profit, it misstates the corporate-tax
 * position, and it hides the one figure a portfolio owner most needs, which is
 * how much of each business's earnings they have actually withdrawn.
 *
 * So the sentence is rendered at full size, above the amount, before anything
 * has been typed. And the year's running total sits under it, because the
 * question the number answers — "how much have I taken from this business
 * already?" — is one owners almost never know, and the answer is the beginning
 * of the director's-loan conversation the accountant will otherwise have to
 * start a year late.
 */
export default async function OwnerOutPage() {
  const { session, today, businessUnits, cashPoints, owner } = await loadCashScreen();
  if (!can(session.principal, "payment:create")) {
    return <NotAllowed what="Took my money out" permission="payment:create" />;
  }
  const points = cashPointOptions(cashPoints);
  const mayOverride = can(session.principal, "payment:void");

  return (
    <EntryShell
      title="Took my money out"
      lede="Your own money leaving a business — for yourself, not for the business."
    >
      <Card className="p-4 space-y-1" as="div">
        <p className="text-sm font-semibold leading-snug">
          This is not an expense. It is your own money.
        </p>
        <p className="text-2xs text-subtle leading-relaxed">
          Nothing you record here changes any profit figure, because it was never a cost of
          running the business. It reduces what the business owes you — or increases what you
          owe it.
        </p>
        <p className="text-2xs leading-relaxed pt-1.5">
          Across all your businesses you have taken out AED{" "}
          <span className="tnum font-semibold">{owner.drawn.toLocaleString("en-AE")}</span> and
          put in AED{" "}
          <span className="tnum font-semibold">{owner.contributed.toLocaleString("en-AE")}</span>
          {owner.daysSinceLastMovement !== null && (
            <> · last movement {owner.daysSinceLastMovement} days ago</>
          )}
          .
        </p>
        {owner.isMaterial && (
          <p className="text-2xs leading-relaxed pt-1" style={{ color: "var(--caution)" }}>
            You are net AED {Math.abs(owner.net).toLocaleString("en-AE")} drawn, above the AED{" "}
            {owner.materialityThreshold.toLocaleString("en-AE")} the accountant asked to be told
            about. Worth a conversation before the year end.
          </p>
        )}
      </Card>

      <Card className="p-4" as="div">
        <ActionForm
          action={recordOwnerDrawingAction}
          submitLabel="Record it"
          pendingLabel="Recording…"
        >
          <AmountField currency={session.baseCurrency} />

          <div className="grid gap-3 sm:grid-cols-2 mt-2 mb-3">
            <Field
              name="businessUnitId"
              label="Out of which business?"
              options={businessOptions(businessUnits)}
              required
            />
            <Field
              name="via"
              label="How?"
              options={[
                { value: "cash", label: "Cash from a till" },
                { value: "bank", label: "Out of the bank" },
              ]}
              defaultValue="cash"
            />
            <Field name="onDate" label="When?" type="date" defaultValue={today} required />
            {points && <Field name="cashPointId" label="Which till?" options={points} />}
          </div>

          <Field name="note" label="Note" placeholder="Optional" className="mb-3" />

          {mayOverride && (
            <Disclosure summary="The till has not got it">
              <div className="grid gap-3 mb-2">
                <Field
                  name="overrideReason"
                  label="Why is the till short?"
                  placeholder="Cash was taken before the day's takings were entered"
                />
                <p className="text-2xs leading-relaxed" style={{ color: "var(--caution)" }}>
                  Only when you know why. The reason and your name go into the audit trail, and
                  the till stays visibly negative until the missing entry is found.
                </p>
              </div>
            </Disclosure>
          )}
        </ActionForm>
      </Card>
    </EntryShell>
  );
}
