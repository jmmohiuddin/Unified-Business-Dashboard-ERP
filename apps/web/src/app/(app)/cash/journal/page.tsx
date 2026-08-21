import { can } from "@nexus/core";
import { ActionForm, Field } from "@/components/action-form";
import { postManualJournalAction } from "@/lib/actions/manual";
import { Card, CardHeader } from "@/components/ui";
import { loadCashScreen, loadPostableAccounts } from "../data";
import { EntryShell, NotAllowed, businessOptions } from "../form-parts";

export const dynamic = "force-dynamic";

/** How many empty line slots the form offers. Unfilled ones are dropped. */
const LINE_SLOTS = 6;

/**
 * FR-M08 — the manual journal.
 *
 * The only screen in this module that shows an account picker, and the only one
 * that can post anything to anywhere. It is rendered exclusively for holders of
 * `journal:post` — the accountant and the owner — and the service refuses
 * anyone else regardless of what this page did or did not render, because
 * hiding a button is not authorisation.
 *
 * A fixed number of line slots rather than an "add line" button: this is the
 * one client component in the app and it wraps forms, it does not manage
 * dynamic lists. Six lines covers an accrual, a reclass and a correction, and
 * empty slots are dropped server-side rather than sent as zero-value lines.
 *
 * The entry must balance before it is submitted, must carry a narrative, and is
 * refused in a closed period with a message naming the period and who closed
 * it. All four checks live in the service; what this screen adds is saying so
 * before the accountant has typed twelve numbers.
 */
export default async function ManualJournalPage() {
  const { session, today, businessUnits } = await loadCashScreen();
  if (!can(session.principal, "journal:post")) {
    return <NotAllowed what="Manual journal" permission="journal:post" />;
  }
  const accounts = await loadPostableAccounts();
  const accountOptions = [{ value: "", label: "—" }, ...accounts];

  return (
    <EntryShell
      title="Manual journal"
      lede="Free-form double entry. Everything else in this module exists so that this is rarely needed."
    >
      <Card>
        <CardHeader
          title="New entry"
          subtitle="It must balance, it must say why, and it can never be edited or deleted — only reversed"
        />
        <div className="px-4 pb-4">
          <ActionForm
            action={postManualJournalAction}
            submitLabel="Post the journal"
            pendingLabel="Posting…"
            confirm={
              "This posts to the general ledger immediately. It cannot be edited or deleted " +
              "afterwards — a mistake is corrected by posting the reverse, and both entries " +
              "stay in the books."
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 mb-3">
              <Field name="postingDate" label="Date" type="date" defaultValue={today} required />
              <Field
                name="businessUnitId"
                label="Business (default for every line)"
                options={[
                  { value: "", label: "None — group level" },
                  ...businessOptions(businessUnits),
                ]}
              />
            </div>

            <Field
              name="narration"
              label="Why is this entry being made?"
              placeholder="Accrue the August audit fee"
              required
              className="mb-3"
            />

            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                    <th className="py-2 label font-medium">Account</th>
                    <th className="py-2 label font-medium text-right w-28">Debit</th>
                    <th className="py-2 label font-medium text-right w-28">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: LINE_SLOTS }, (_, i) => (
                    <tr key={i} className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                      <td className="py-1.5 pr-2">
                        <select
                          name={`line${i}Account`}
                          aria-label={`Line ${i + 1} account`}
                          className="w-full px-2 py-1 rounded-[var(--radius-md)] text-xs"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border-strong)",
                            color: "var(--text)",
                          }}
                        >
                          {accountOptions.map((a) => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          name={`line${i}Debit`}
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          aria-label={`Line ${i + 1} debit`}
                          className="w-full px-2 py-1 rounded-[var(--radius-md)] text-xs text-right tnum"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border-strong)",
                            color: "var(--text)",
                          }}
                        />
                      </td>
                      <td className="py-1.5">
                        <input
                          name={`line${i}Credit`}
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          aria-label={`Line ${i + 1} credit`}
                          className="w-full px-2 py-1 rounded-[var(--radius-md)] text-xs text-right tnum"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border-strong)",
                            color: "var(--text)",
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-2xs text-subtle leading-relaxed my-3 max-w-[60ch]">
              Debits must equal credits exactly — to the fils, with no tolerance. A line with
              both a debit and a credit is refused; split it in two. Leave the rows you do not
              need empty.
            </p>
          </ActionForm>
        </div>
      </Card>
    </EntryShell>
  );
}
