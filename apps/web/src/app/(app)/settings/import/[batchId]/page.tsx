import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { ServiceError, buildReconciliation, can, type ReconciliationReport } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { reverseImportBatchAction, signOffImportAction } from "@/lib/actions/import";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { Card, CardHeader, Chip } from "@/components/ui";
import { PageHeader } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * THE RECONCILIATION AND THE SIGN-OFF — FR-D01, decision D5.
 *
 * The gate metric for the whole MVP is "migrated trial balance versus the
 * accountant's figure — ties to the fils", measured by a signed reconciliation.
 * This is that screen.
 *
 * Its job is to make a difference IMPOSSIBLE TO MISS AND POSSIBLE TO FIX. A
 * reconciliation that reports "does not tie" and stops has told the accountant
 * nothing they did not already suspect; every line is therefore shown with what
 * the file said, what the ledger holds, and the difference between them, with
 * the failing lines pulled to the top. The signature form refuses a figure that
 * does not match, and says by how much it is out.
 *
 * The reversal sits on the same screen, deliberately. The correct response to a
 * reconciliation that does not tie is almost always "reverse it, fix the
 * spreadsheet, import it again", and putting that action three clicks away
 * invites the alternative: a manual journal to force the balance, which is how
 * a set of books stops being reconcilable at all.
 */
export default async function ImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const session = await requireSession();
  const { batchId } = await params;

  // A malformed id must 404 rather than reach the service and surface a
  // database error to a user who simply mistyped a URL.
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) notFound();

  if (!can(session.principal, "report:read")) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Reconciliation" back={{ href: "/settings/import", label: "Imports" }} />
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            Reading a reconciliation needs the <code className="text-2xs">report:read</code>{" "}
            permission.
          </p>
        </Card>
      </div>
    );
  }

  let report: ReconciliationReport;
  let reversible = false;
  let reversibleUntil = "";
  try {
    const loaded = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) => {
        const ctx = {
          tx,
          tenantId: session.tenantId,
          principal: session.principal,
          today: resolveToday(session.timezone),
          baseCurrency: session.baseCurrency,
        };
        const window = await tx.execute<{ reversible: boolean; until: string }>(sql`
          SELECT (reversed_at IS NULL AND now() <= reversible_until) AS reversible,
                 to_char(reversible_until, 'DD Mon YYYY HH24:MI') AS until
            FROM import_batches WHERE id = ${batchId}::uuid
        `);
        return { report: await buildReconciliation(ctx, batchId), window: window[0] };
      },
    );
    report = loaded.report;
    reversible = loaded.window?.reversible ?? false;
    reversibleUntil = loaded.window?.until ?? "";
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }

  const maySign = can(session.principal, "journal:post");
  const failing = [
    ...report.lines.filter((l) => !l.ties),
    ...report.controls.filter((c) => !c.ties),
  ].length;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="Reconciliation"
        back={{ href: "/settings/import", label: "Imports" }}
        subtitle={`${report.filename} · imported ${report.committedAt}`}
        actions={
          report.reversed ? (
            <Chip tone="neutral">reversed</Chip>
          ) : report.signedOff ? (
            <Chip tone="positive">signed off</Chip>
          ) : report.ties ? (
            <Chip tone="caution">ties · not yet signed</Chip>
          ) : (
            <Chip tone="negative">does not tie</Chip>
          )
        }
      />

      {report.reversed && (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            This batch has been reversed. The records it created were removed and, where it
            posted to the ledger, a reversing journal was written — the original journal is
            still there, as an auditor expects.
          </p>
        </Card>
      )}

      {report.lines.length > 0 && (
        <Card>
          <CardHeader
            title="Line by line"
            subtitle={
              failing === 0
                ? "Every account ties to the fils"
                : `${failing} account${failing === 1 ? "" : "s"} do not tie`
            }
          />
          <div className="px-4 pb-4 overflow-x-auto">
            <table className="w-full text-2xs tnum">
              <thead>
                <tr className="text-left" style={{ color: "var(--text-subtle)" }}>
                  <th className="py-1.5 font-semibold text-left">Account</th>
                  <th className="py-1.5 font-semibold text-right">Your file Dr</th>
                  <th className="py-1.5 font-semibold text-right">Your file Cr</th>
                  <th className="py-1.5 font-semibold text-right">Ledger Dr</th>
                  <th className="py-1.5 font-semibold text-right">Ledger Cr</th>
                  <th className="py-1.5 font-semibold text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {/* Failing lines first. An accountant scanning sixty accounts for
                    the one that is wrong should not have to scan. */}
                {[...report.lines]
                  .sort((a, b) => Number(a.ties) - Number(b.ties))
                  .map((l) => (
                    <tr
                      key={l.accountCode}
                      className="border-t"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <td className="py-1.5 text-left">
                        <span className="font-semibold">{l.accountCode}</span>{" "}
                        <span className="text-subtle">{l.accountName}</span>
                      </td>
                      <td className="py-1.5 text-right">{l.fileDebit}</td>
                      <td className="py-1.5 text-right">{l.fileCredit}</td>
                      <td className="py-1.5 text-right">{l.ledgerDebit}</td>
                      <td className="py-1.5 text-right">{l.ledgerCredit}</td>
                      <td
                        className="py-1.5 text-right font-semibold"
                        style={{ color: l.ties ? "var(--text-subtle)" : "var(--negative)" }}
                      >
                        {l.difference}
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2" style={{ borderColor: "var(--border-strong)" }}>
                  <td className="py-1.5 font-semibold">Total</td>
                  <td className="py-1.5 text-right font-semibold">{report.fileTotalDebit}</td>
                  <td className="py-1.5 text-right font-semibold">{report.fileTotalCredit}</td>
                  <td className="py-1.5 text-right font-semibold">{report.ledgerTotalDebit}</td>
                  <td className="py-1.5 text-right font-semibold">{report.ledgerTotalCredit}</td>
                  <td
                    className="py-1.5 text-right font-semibold"
                    style={{ color: report.ties ? "var(--positive)" : "var(--negative)" }}
                  >
                    {report.difference}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {report.controls.length > 0 && (
        <Card>
          <CardHeader
            title="Against the control accounts"
            subtitle="What this import loaded, against the balance the trial balance posted"
          />
          <div className="px-4 pb-4 space-y-2">
            {report.controls.map((c) => (
              <div
                key={c.accountCode}
                className="flex justify-between gap-3 items-baseline flex-wrap py-1.5 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="text-xs min-w-0">{c.label}</span>
                <span className="text-2xs tnum shrink-0">
                  <span className="text-subtle">this import </span>
                  {c.subledger}
                  <span className="text-subtle"> · ledger </span>
                  {c.ledger}
                  <span
                    className="font-semibold"
                    style={{ color: c.ties ? "var(--positive)" : "var(--negative)" }}
                  >
                    {" "}
                    · {c.ties ? "ties" : `out by ${c.difference}`}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report.lines.length === 0 && report.controls.length === 0 && (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            This import posted nothing to the ledger and has no control account to tie to, so
            there is nothing to reconcile. Its records are visible on the screens that own
            them.
          </p>
        </Card>
      )}

      {!report.reversed && (
        <Card>
          <CardHeader
            title="The accountant's sign-off"
            subtitle="Go-live is blocked until the opening balances are signed"
          />
          <div className="px-4 pb-4 space-y-3">
            {report.signedOff ? (
              <p className="text-xs" style={{ color: "var(--positive)" }}>
                Signed on {report.signedOff.at}
                {report.signedOff.by ? ` by ${report.signedOff.by}` : ""} at AED{" "}
                {report.signedOff.total}.
                {report.signedOff.note && (
                  <span className="text-muted"> “{report.signedOff.note}”</span>
                )}
              </p>
            ) : !maySign ? (
              <p className="text-xs text-muted">
                Only the accountant or the owner can sign this off — it needs the{" "}
                <code className="text-2xs">journal:post</code> permission.
              </p>
            ) : report.lines.length === 0 && report.controls.length === 0 ? (
              <p className="text-xs text-muted">
                There is nothing to reconcile on this import, so there is nothing to sign.
                The signature that gates go-live is the one on the opening balances.
              </p>
            ) : !report.ties ? (
              <p className="text-xs" style={{ color: "var(--negative)" }}>
                This cannot be signed while it does not tie. Reverse the batch, correct the
                file and import it again — do not post a journal to force the balance.
              </p>
            ) : (
              <ActionForm
                action={signOffImportAction}
                submitLabel="Sign off"
                pendingLabel="Signing…"
                hidden={{ batchId: report.batchId }}
              >
                <p className="text-2xs text-subtle mb-2">
                  Type the total from your own records, not from this screen. It has to match
                  to the fils.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 mb-2">
                  <Field
                    label="Your trial balance total (AED)"
                    name="accountantTotal"
                    required
                    placeholder="4182440.00"
                  />
                  <Field label="Note, optional" name="note" placeholder="Agreed with Priya" />
                </div>
              </ActionForm>
            )}

            <Disclosure summary="Reverse this import">
              {reversible ? (
                <ActionForm
                  action={reverseImportBatchAction}
                  submitLabel="Reverse the batch"
                  pendingLabel="Reversing…"
                  variant="danger"
                  hidden={{ batchId: report.batchId }}
                  confirm={
                    `This removes every record this import created, restores anything it ` +
                    `changed, and posts a reversing journal for what it put in the ledger. ` +
                    (report.signedOff ? "The sign-off on it will be cleared. " : "") +
                    `It refuses if anything created since points at these records.`
                  }
                >
                  <p className="text-2xs text-subtle mb-2">
                    Reversible until {reversibleUntil}. After that, correct the records
                    individually or post an adjusting journal.
                  </p>
                  <Field
                    label="Why"
                    name="reason"
                    required
                    placeholder="Wrong as-at date on the trial balance"
                    className="mb-2"
                  />
                </ActionForm>
              ) : (
                <p className="text-2xs text-muted">
                  The 72-hour reversal window closed on {reversibleUntil}. Reversing books that
                  have been trading for days would take away the work done since, so from here
                  the correction is an adjusting journal.
                </p>
              )}
            </Disclosure>
          </div>
        </Card>
      )}
    </div>
  );
}
