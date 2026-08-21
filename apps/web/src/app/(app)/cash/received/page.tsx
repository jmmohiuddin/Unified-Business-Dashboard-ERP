import { can } from "@nexus/core";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { recordCashReceiptAction } from "@/lib/actions/manual";
import { Card } from "@/components/ui";
import { loadCashScreen, loadOpenInvoices } from "../data";
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
 * FR-M01 — received cash.
 *
 * Four fields: amount, which business, what for, when. Everything else is
 * behind a disclosure, because the entry that matters is the one made at the
 * counter with one hand while a customer waits, and every extra visible field
 * is a reason to write it on a piece of paper instead.
 *
 * "What for" is the only question about tax that is ever asked, and it is not
 * phrased as one. Rent on a flat is exempt, parking is standard-rated, a salon
 * service is standard-rated — the service maps each answer to its revenue
 * account and its tax code, so the VAT is right without anyone being asked
 * about VAT. That mapping is the whole of PRD §7.1's design principle: the user
 * describes what happened, the system decides what to debit.
 */
export default async function ReceivedCashPage() {
  const { session, today, businessUnits, cashPoints, reasons } = await loadCashScreen();
  if (!can(session.principal, "payment:create")) {
    return <NotAllowed what="Received cash" permission="payment:create" />;
  }

  const invoices = await loadOpenInvoices();
  const points = cashPointOptions(cashPoints);

  return (
    <EntryShell
      title="Received cash"
      lede="Money someone handed over. If it settles an invoice, say which one and the invoice updates too."
    >
      <Card className="p-4" as="div">
        <ActionForm
          action={recordCashReceiptAction}
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
              name="reason"
              label="What for?"
              options={reasons.map((r) => ({ value: r.key, label: r.label }))}
            />
            <Field name="receivedOn" label="When?" type="date" defaultValue={today} required />
            {points && <Field name="cashPointId" label="Into which till?" options={points} />}
          </div>

          {/*
            The float figures are listed rather than shown for the selected
            business: the form is server rendered and adds no client JavaScript,
            so a single line would have to guess which business is chosen and
            would be wrong most of the time. A wrong float figure is worse than
            a list, because the whole purpose of showing it is to be checked
            against the notes in the drawer.
          */}
          <EffectNote>
            What the books say each till is holding right now:{" "}
            {cashPoints
              .map((p) => `${p.businessUnitName} AED ${p.balance.toLocaleString("en-AE")}`)
              .join(" · ")}
            . This adds to whichever you choose.
            <br />
            Rent on a flat or villa is VAT-exempt, so nothing is taken out for tax. Everything
            else is treated as VAT-inclusive — the amount above is what the customer handed over.
          </EffectNote>

          <Disclosure summary="It is paying off an invoice">
            <div className="grid gap-3 mb-2">
              <Field
                name="invoiceId"
                label="Which invoice?"
                options={[
                  { value: "", label: "Not settling an invoice" },
                  ...invoices.map((i) => ({ value: i.value, label: i.label })),
                ]}
              />
              <p className="text-2xs text-subtle leading-relaxed">
                Choosing an invoice makes this a payment against it: the amount due goes down
                and nothing is added to revenue, because that sale was already counted when the
                invoice was raised. The amount cannot exceed what is outstanding.
              </p>
              <Field name="note" label="Note" placeholder="Optional" />
            </div>
          </Disclosure>
        </ActionForm>
      </Card>
    </EntryShell>
  );
}
