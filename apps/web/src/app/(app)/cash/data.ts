import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import {
  listCashPoints,
  listManualEntries,
  ownerPosition,
  paymentCategories,
  receiptReasons,
  type CashPointSummary,
  type ManualEntryRow,
  type OwnerPosition,
  type ServiceContext,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadBusinessUnits, resolveToday, type BusinessUnitSummary } from "@/lib/data";

/**
 * Reads for the cash screens.
 *
 * These are reads, so they are NOT server actions and do not live in
 * `lib/actions/manual.ts`: a `"use server"` module exports a callable endpoint
 * for every function in it, and a data loader does not need to be one.
 *
 * Everything goes through the service functions rather than fresh SQL, so the
 * permission checks and the business-unit scoping are the same ones the write
 * path uses. A screen that queried the ledger directly would be a second
 * authorisation model, and the second one is always the one that leaks.
 */

export interface CashScreenData {
  session: Awaited<ReturnType<typeof requireSession>>;
  today: string;
  businessUnits: BusinessUnitSummary[];
  cashPoints: CashPointSummary[];
  entries: ManualEntryRow[];
  owner: OwnerPosition;
  reasons: { key: string; label: string }[];
  categories: { key: string; label: string }[];
}

function contextFor(
  tx: ServiceContext["tx"],
  session: CashScreenData["session"],
  today: string,
): ServiceContext {
  return {
    tx,
    tenantId: session.tenantId,
    principal: session.principal,
    today,
    baseCurrency: session.baseCurrency,
  };
}

/**
 * One transaction for the whole screen.
 *
 * Wrapped in React `cache()` so a page and the panels inside it can each ask
 * for it while only one round trip happens — the same de-duplication
 * `getSession` and `loadBusinessUnits` already rely on.
 */
export const loadCashScreen = cache(async (): Promise<CashScreenData> => {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const businessUnits = await loadBusinessUnits(session);

  const { cashPoints, entries, owner } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const ctx = contextFor(tx, session, today);
      return {
        cashPoints: await listCashPoints(ctx, { asOf: today }),
        entries: await listManualEntries(ctx, { limit: 12 }),
        owner: await ownerPosition(ctx, { asOf: today }),
      };
    },
  );

  return {
    session,
    today,
    businessUnits,
    cashPoints,
    entries,
    owner,
    reasons: receiptReasons(),
    categories: paymentCategories(),
  };
});

/** The owner's position with one business, for the drawing screen's framing. */
export const loadOwnerPosition = cache(
  async (businessUnitId: string | null): Promise<OwnerPosition> => {
    const session = await requireSession();
    const today = resolveToday(session.timezone);
    return withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) =>
      ownerPosition(contextFor(tx, session, today), { businessUnitId, asOf: today }),
    );
  },
);

export interface AccountOption {
  value: string;
  label: string;
}

/**
 * The postable chart, for the manual journal only.
 *
 * Parent accounts are excluded — they exist for report grouping and a posting
 * to one is a mistake the ledger cannot express. This list is never rendered on
 * any other screen in the module: the whole design principle is that the person
 * describing what happened does not choose an account.
 */
export const loadPostableAccounts = cache(async (): Promise<AccountOption[]> => {
  const session = await requireSession();
  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      tx.execute<{ code: string; name: string; system_key: string | null }>(sql`
        SELECT code, name, system_key FROM accounts
         WHERE is_active = true AND is_postable = true AND system_key IS NOT NULL
         ORDER BY code
      `),
  );
  return rows.map((r) => ({ value: r.system_key!, label: `${r.code} · ${r.name}` }));
});

export interface OpenInvoiceOption {
  value: string;
  label: string;
  businessUnitId: string;
  partyId: string | null;
}

/**
 * Open invoices a cash receipt could settle.
 *
 * Capped and ordered oldest-first, matching how `recordPayment` allocates when
 * nothing is named: the oldest debt is what a customer walking in with cash
 * almost always intends to clear, and settling the newest would leave a
 * permanently "90 days overdue" balance that is in fact being paid.
 */
export const loadOpenInvoices = cache(async (): Promise<OpenInvoiceOption[]> => {
  const session = await requireSession();
  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      tx.execute<{
        id: string; doc_number: string; amount_due: string;
        party: string | null; business_unit_id: string; party_id: string | null;
      }>(sql`
        SELECT id, doc_number, amount_due, party_name_snapshot AS party,
               business_unit_id, party_id
          FROM documents
         WHERE direction = 'in' AND doc_type = 'invoice' AND amount_due > 0
           AND status NOT IN ('cancelled', 'void', 'draft')
         ORDER BY due_date ASC NULLS LAST, issue_date ASC
         LIMIT 60
      `),
  );
  return rows.map((r) => ({
    value: r.id,
    label: `${r.doc_number} · ${r.party ?? "no name"} · AED ${r.amount_due}`,
    businessUnitId: r.business_unit_id,
    partyId: r.party_id,
  }));
});
