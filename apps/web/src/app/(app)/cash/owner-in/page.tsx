import { can } from "@nexus/core";
import { ActionForm, Field } from "@/components/action-form";
import { recordOwnerContributionAction } from "@/lib/actions/manual";
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
 * FR-M03 — the owner putting money in.
 *
 * The mirror of "took my money out", and it carries the same lesson from the
 * other side: this is not income. A business that books the owner's own money
 * as revenue reports a profit it did not earn, and then pays corporate tax on
 * it. The line above the button says so in the words the owner would use, at
 * the moment they are about to record it.
 */
export default async function OwnerInPage() {
  const { session, today, businessUnits, cashPoints, owner } = await loadCashScreen();
  if (!can(session.principal, "payment:create")) {
    return <NotAllowed what="Put my money in" permission="payment:create" />;
  }
  const points = cashPointOptions(cashPoints);

  return (
    <EntryShell
      title="Put my money in"
      lede="Your own money going into a business — a top-up, not a sale."
    >
      <Card className="p-4" as="div">
        <ActionForm
          action={recordOwnerContributionAction}
          submitLabel="Record it"
          pendingLabel="Recording…"
        >
          <AmountField currency={session.baseCurrency} />

          <div className="grid gap-3 sm:grid-cols-2 mt-2 mb-3">
            <Field
              name="businessUnitId"
              label="Into which business?"
              options={businessOptions(businessUnits)}
              required
            />
            <Field
              name="via"
              label="How?"
              options={[
                { value: "bank", label: "Into the bank" },
                { value: "cash", label: "Cash into a till" },
              ]}
              defaultValue="bank"
            />
            <Field name="onDate" label="When?" type="date" defaultValue={today} required />
            {points && <Field name="cashPointId" label="Which till?" options={points} />}
          </div>

          <EffectNote>
            This is not income. It is your own money, so it never appears in revenue and no
            profit figure moves.
            <br />
            Across all your businesses you have put in AED{" "}
            {owner.contributed.toLocaleString("en-AE")} and taken out AED{" "}
            {owner.drawn.toLocaleString("en-AE")}.
          </EffectNote>

          <Field name="note" label="Note" placeholder="Optional" className="mb-3" />
        </ActionForm>
      </Card>
    </EntryShell>
  );
}
