import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { IMPORTERS, IMPORT_ORDER, can, listImportBatches } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, Chip, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { ImportWizard, type KindOption } from "./wizard";

export const dynamic = "force-dynamic";

/**
 * BRINGING THE REAL BOOKS IN — FR-D01.
 *
 * The screen that decides whether this product is ever used for anything. Until
 * an import runs, Nexus holds seed data and the owner's actual portfolio lives
 * in a spreadsheet; PRD §2.3 puts poor migration behind 38 percent of ERP
 * implementation failures, and audit risk R2 rates "migrated opening data is
 * wrong" as Critical.
 *
 * Everything on this page is arranged around the one sentence the wireframe
 * insists on: nothing has been saved yet. The wizard runs a dry run, shows the
 * diff, and only then offers a separate Import button. Below it, every batch
 * that HAS been committed, each with its reversal window and whether the
 * accountant has signed the reconciliation — because decision D5 makes that
 * signature the go-live gate, and a gate nobody can see the state of is not a
 * gate.
 *
 * The five states of WF-05 §0 are all here, and three of them are not
 * hypothetical: permission-denied is what a branch manager gets, empty is the
 * state this screen spends its whole first week in, and error is what a
 * malformed spreadsheet produces on nearly every first attempt.
 */
export default async function ImportPage() {
  const session = await requireSession();

  /**
   * Permission-denied, per importer rather than per page.
   *
   * A read-only auditor and a branch manager both legitimately reach this
   * screen — one to see what was migrated, the other because it is under
   * Settings. Neither may import employees. Showing the whole page and greying
   * the rows they cannot use tells them what exists and who to ask; hiding the
   * page entirely tells them the feature is missing.
   */
  const kinds: KindOption[] = IMPORT_ORDER.map((kind) => {
    const importer = IMPORTERS[kind];
    return {
      kind,
      label: importer.label,
      description: importer.description,
      requiresBusinessUnit: importer.requiresBusinessUnit,
      template: [...importer.template],
      permitted: can(session.principal, importer.permission),
      permission: importer.permission,
    };
  });
  const mayImportAnything = kinds.some((k) => k.permitted);
  const mayRead = can(session.principal, "report:read");

  const { businesses, warehouses, batches } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const bu = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM business_units
         WHERE deleted_at IS NULL AND is_active = true
         ORDER BY sort_order, name
      `);
      const wh = await tx.execute<{ code: string; name: string }>(sql`
        SELECT code, name FROM warehouses
         WHERE deleted_at IS NULL AND is_active = true ORDER BY code
      `);
      return {
        businesses: bu,
        warehouses: wh.map((w) => w.code),
        batches: mayRead
          ? await listImportBatches({
              tx,
              tenantId: session.tenantId,
              principal: session.principal,
              today: resolveToday(session.timezone),
              baseCurrency: session.baseCurrency,
            })
          : [],
      };
    },
  );

  const awaitingSignOff = batches.filter((b) => b.needsSignOff);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
      <PageHeader
        title="Bring your books in"
        subtitle="Every import runs as a dry run first. Nothing is saved until you say so."
      />

      {awaitingSignOff.length > 0 && (
        <Card className="p-4" as="div">
          <p className="text-xs" style={{ color: "var(--caution)" }}>
            Go-live is blocked: {awaitingSignOff.length} opening-balance import
            {awaitingSignOff.length === 1 ? "" : "s"} still need the accountant&apos;s signed
            reconciliation.{" "}
            {awaitingSignOff.map((b) => (
              <Link key={b.id} href={`/settings/import/${b.id}`} className="underline">
                {b.filename}
              </Link>
            ))}
          </p>
        </Card>
      )}

      {!mayImportAnything ? (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            You can see what has been imported, but not import anything yourself. That needs
            one of the create permissions for the records concerned —{" "}
            <code className="text-2xs">journal:post</code> for opening balances.
          </p>
        </Card>
      ) : businesses.length === 0 ? (
        <Card className="p-4" as="div">
          <p className="text-xs text-muted">
            There are no businesses set up yet. Most imports belong to one, so create your
            businesses before migrating anything into them.
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="New import"
            subtitle="Choose what you are importing, upload the file, read the diff"
          />
          <div className="px-4 pb-4">
            <ImportWizard
              kinds={kinds}
              businesses={businesses}
              warehouses={warehouses}
              today={resolveToday(session.timezone)}
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="What has been imported"
          subtitle={`A batch can be reversed as a unit for 72 hours after it commits`}
        />
        <div className="px-4 pb-4">
          {!mayRead ? (
            <p className="text-xs text-muted py-4">
              Seeing past imports needs the <code className="text-2xs">report:read</code>{" "}
              permission.
            </p>
          ) : batches.length === 0 ? (
            <EmptyState
              title="Nothing has been imported yet"
              detail="Start with your trial balance. Everything else reconciles against it."
            />
          ) : (
            <div className="space-y-2">
              {batches.map((b) => (
                <div
                  key={b.id}
                  className="py-2.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <Link href={`/settings/import/${b.id}`} className="text-xs font-medium hover:underline">
                        {b.label} · {b.filename}
                      </Link>
                      <p className="text-2xs text-subtle truncate">
                        {b.committedAt}
                        {b.committedBy ? ` · ${b.committedBy}` : ""}
                        {b.businessUnit ? ` · ${b.businessUnit}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {b.reversed ? (
                        <Chip tone="neutral">reversed</Chip>
                      ) : b.signedOffAt ? (
                        <Chip tone="positive">signed off</Chip>
                      ) : b.needsSignOff ? (
                        <Chip tone="caution">needs sign-off</Chip>
                      ) : null}
                      {b.reversible && <Chip tone="neutral">reversible to {b.reversibleUntil}</Chip>}
                    </div>
                  </div>
                  <p className="text-2xs text-subtle mt-1 tnum">
                    {b.createdCount} created · {b.updatedCount} updated
                    {b.reversedReason ? ` · reversed: ${b.reversedReason}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4" as="div">
        <p className="text-2xs text-subtle leading-relaxed">
          Run them in this order: {IMPORT_ORDER.map((k) => IMPORTERS[k].label).join(" → ")}. Each
          one refuses to invent the records it points at, so a lease imported before its unit is
          a rejected row rather than a second, duplicate flat.
        </p>
      </Card>
    </div>
  );
}
