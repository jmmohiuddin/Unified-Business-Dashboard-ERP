"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import {
  ServiceError,
  reportError,
  postManualJournal,
  recordCashPayment,
  recordCashReceipt,
  recordOwnerContribution,
  recordOwnerDrawing,
  reverseEntry,
  type ServiceContext,
} from "@nexus/core";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";

/**
 * Server actions for manual and cash entry.
 *
 * A thin adapter, exactly like `lib/actions.ts`: build a ServiceContext, call
 * the service, turn the outcome into something a form can render, revalidate.
 * Every rule that matters — permission, period lock, the cash floor, the
 * balance gate, idempotency, audit — lives in
 * `@nexus/core/services/manual-entry`, so the assistant and the future mobile
 * API get identical behaviour instead of a second implementation with its own
 * bugs. Nothing here decides anything about money.
 *
 * It lives in its own module rather than in `lib/actions.ts` because that file
 * is the shared one; a module per feature keeps the write surface reviewable.
 *
 * IDEMPOTENCY KEYS ARE NOT OPTIONAL HERE. `ActionForm` fingerprints the
 * submitted payload and sends it as `idempotencyKey`; every action below passes
 * it straight through. This is the module used one-handed, in a hurry, on a
 * connection that drops — a double-tapped "Record AED 400" must replay the
 * first result, not take the money twice.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Session = Awaited<ReturnType<typeof requireSession>>;

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

async function buildContext(tx: Tx, session: Session): Promise<ServiceContext> {
  const h = await headers();
  const ip = h.get("x-client-ip");
  return {
    tx,
    tenantId: session.tenantId,
    principal: session.principal,
    today: resolveToday(session.timezone),
    baseCurrency: session.baseCurrency,
    ipAddress: ip && ip !== "local" ? ip : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

/** The same blunt per-user write throttle every other mutating path uses. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

/**
 * Turn a thrown error into something a form can display.
 *
 * `ServiceError` messages are written for the person holding the cash and are
 * shown verbatim — "Marina float holds 150.00 … short by 250.00" is the whole
 * point of the check. Anything unexpected is reported server-side and
 * generalised, because a raw database error rendered in the UI is a leak and an
 * unreported one is invisible.
 */
function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Some of those values are not valid." };
  }
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const num = (fd: FormData, key: string) => Number(fd.get(key) ?? 0);
const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** Every cash screen shows the same figures; refresh them all after a write. */
function revalidateCash() {
  revalidatePath("/cash");
  revalidatePath("/cash/received");
  revalidatePath("/cash/paid");
  revalidatePath("/cash/owner-in");
  revalidatePath("/cash/owner-out");
  revalidatePath("/cash/journal");
  revalidatePath("/");
}

async function run<T>(
  fn: (ctx: ServiceContext) => Promise<T>,
  onOk: (result: T) => string,
): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) => fn(await buildContext(tx, session)),
    );
    revalidateCash();
    return { ok: true, message: onOk(result), data: result };
  } catch (err) {
    return toResult(err);
  }
}

const money = (value: number) =>
  new Intl.NumberFormat("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value);

// ── FR-M01 · Received cash ──────────────────────────────────────────────────

export async function recordCashReceiptAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return run(
    (ctx) =>
      recordCashReceipt(ctx, {
        businessUnitId: str(formData, "businessUnitId"),
        amount: num(formData, "amount"),
        receivedOn: str(formData, "receivedOn") ?? resolveToday(session.timezone),
        cashPointId: str(formData, "cashPointId") ?? null,
        partyId: str(formData, "partyId") ?? null,
        invoiceId: str(formData, "invoiceId") ?? null,
        reason: str(formData, "reason"),
        note: str(formData, "note"),
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) =>
      r.settledInvoices?.length
        ? `Recorded AED ${money(r.amount)} — ${r.settledInvoices.map((s) => s.docNumber).join(", ")} updated.`
        : `Recorded AED ${money(r.amount)}. Cash in hand is now AED ${money(r.cashPointBalance)}.`,
  );
}

// ── FR-M02 · Paid cash ──────────────────────────────────────────────────────

export async function recordCashPaymentAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return run(
    (ctx) =>
      recordCashPayment(ctx, {
        businessUnitId: str(formData, "businessUnitId"),
        amount: num(formData, "amount"),
        paidOn: str(formData, "paidOn") ?? resolveToday(session.timezone),
        cashPointId: str(formData, "cashPointId") ?? null,
        category: str(formData, "category"),
        supplierId: str(formData, "supplierId") ?? null,
        billId: str(formData, "billId") ?? null,
        servesTaxCode: str(formData, "servesTaxCode"),
        note: str(formData, "note"),
        overrideReason: str(formData, "overrideReason"),
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) =>
      `Recorded AED ${money(r.amount)}. Cash in hand is now AED ${money(r.cashPointBalance)}.` +
      (r.recoverableVat > 0 ? ` VAT of AED ${money(r.recoverableVat)} is reclaimable.` : "") +
      (r.belowFloor ? " Recorded below zero — the reason is in the audit trail." : ""),
  );
}

// ── FR-M03 / FR-M04 · The owner's own money ─────────────────────────────────

export async function recordOwnerContributionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return run(
    (ctx) =>
      recordOwnerContribution(ctx, {
        businessUnitId: str(formData, "businessUnitId"),
        amount: num(formData, "amount"),
        onDate: str(formData, "onDate") ?? resolveToday(session.timezone),
        via: str(formData, "via") ?? "bank",
        cashPointId: str(formData, "cashPointId") ?? null,
        note: str(formData, "note"),
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) =>
      `Recorded AED ${money(r.amount)} in. This is not income — it does not appear on any profit figure.`,
  );
}

export async function recordOwnerDrawingAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return run(
    (ctx) =>
      recordOwnerDrawing(ctx, {
        businessUnitId: str(formData, "businessUnitId"),
        amount: num(formData, "amount"),
        onDate: str(formData, "onDate") ?? resolveToday(session.timezone),
        via: str(formData, "via") ?? "cash",
        cashPointId: str(formData, "cashPointId") ?? null,
        note: str(formData, "note"),
        overrideReason: str(formData, "overrideReason"),
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) =>
      `Recorded AED ${money(r.amount)} out. This is not an expense — your profit figure does not change.`,
  );
}

// ── FR-M08 · Manual journal ─────────────────────────────────────────────────

/**
 * The accountant's free-form entry.
 *
 * Lines arrive as `line0Account`, `line0Debit`, … because the form is server
 * rendered and adds no client JavaScript to manage a dynamic list. Empty slots
 * are dropped here rather than sent as zero-value lines, which the service
 * would refuse — an unfilled row on a six-row form is not a mistake the user
 * needs telling about.
 */
export async function postManualJournalAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const lines: {
    accountKey: string;
    businessUnitId: string | null;
    debit?: number;
    credit?: number;
    memo?: string;
  }[] = [];

  for (let i = 0; i < 12; i++) {
    const accountKey = str(formData, `line${i}Account`);
    if (!accountKey) continue;
    const debit = num(formData, `line${i}Debit`);
    const credit = num(formData, `line${i}Credit`);
    if (debit === 0 && credit === 0) continue;
    lines.push({
      accountKey,
      businessUnitId: str(formData, `line${i}Bu`) ?? str(formData, "businessUnitId") ?? null,
      debit: debit > 0 ? debit : undefined,
      credit: credit > 0 ? credit : undefined,
      memo: str(formData, `line${i}Memo`),
    });
  }

  if (lines.length < 2) {
    return { ok: false, message: "A journal needs at least two lines with amounts on them." };
  }

  return run(
    (ctx) =>
      postManualJournal(ctx, {
        postingDate: str(formData, "postingDate") ?? resolveToday(session.timezone),
        narration: str(formData, "narration") ?? "",
        lines,
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) => `${r.journalNumber} posted — ${r.lines} lines, AED ${money(r.total)} each side.`,
  );
}

// ── FR-M09 · Reversal ───────────────────────────────────────────────────────

export async function reverseEntryAction(formData: FormData): Promise<ActionResult> {
  return run(
    (ctx) =>
      reverseEntry(ctx, {
        journalId: str(formData, "journalId"),
        reason: str(formData, "reason") ?? "",
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    (r) =>
      `${r.reversedJournalNumber} reversed by ${r.reversalJournalNumber}. Both stay in the books.`,
  );
}
