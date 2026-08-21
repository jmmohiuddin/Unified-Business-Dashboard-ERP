"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@nexus/db";
import { ServiceError, reportError, type ServiceContext } from "@nexus/core";
/**
 * Imported from the service module directly rather than through the
 * `@nexus/core` barrel.
 *
 * `packages/core/src/services/index.ts` is coordinator-owned while nine
 * features land in one working tree, so this feature's `export * from
 * "./rentals.ts"` line has not been added yet. Every other module in the app
 * reaches core through the barrel and this one should too: once the line is
 * there, change these two imports — here and in `rentals/rent-run/page.tsx` —
 * to `@nexus/core` and nothing else moves.
 */
import {
  commitRentRun,
  createLease,
  renewLease,
  terminateLease,
} from "../../../../../packages/core/src/services/rentals.ts";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";

/**
 * Rentals server actions.
 *
 * A thin adapter over `@nexus/core/services/rentals`, following the contract in
 * `lib/actions.ts` exactly — one transaction per action, `writeBudget` before
 * anything runs, `ServiceError` translated into something a form can render,
 * and never a raw database error on screen. It lives in its own module rather
 * than in the shared `actions.ts` because that file is contended by every
 * feature at once; the behaviour is deliberately identical.
 *
 * All validation, permission checking, VAT treatment, ledger posting and
 * auditing lives in the service. Nothing below decides anything.
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

/** Write throttle, keyed by user. Same budget as every other mutating path. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

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
const flag = (fd: FormData, key: string): boolean => str(fd, key) === "on" || str(fd, key) === "true";

/**
 * The cheque bundle, read out of `chequeNumber1 … chequeNumber12`.
 *
 * A gap in the middle is closed rather than preserved: the schedule's instalment
 * N is the Nth cheque handed over, and a blank third box with a filled fourth
 * would otherwise date the fourth cheque to the third instalment's period. The
 * operator enters what they physically hold, in date order.
 */
function chequeBundle(formData: FormData): { chequeNumber: string; bankName?: string }[] {
  const bank = str(formData, "chequeBank");
  const out: { chequeNumber: string; bankName?: string }[] = [];
  for (let i = 1; i <= 12; i++) {
    const number = str(formData, `chequeNumber${i}`);
    if (number) out.push({ chequeNumber: number, bankName: bank });
  }
  return out;
}

// ── Rent run ────────────────────────────────────────────────────────────────

/**
 * Commit a rent run.
 *
 * The preview is a read and lives on the page; this is the only half that
 * writes. The period travels in the form payload, so the idempotency digest
 * `ActionForm` derives is a fingerprint of "raise September's rent" — press the
 * button twice and the second press replays the first result rather than
 * raising a second month of invoices.
 */
export async function rentRunAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        commitRentRun(await buildContext(tx, session), {
          period: str(formData, "period"),
          businessUnitId: str(formData, "businessUnitId"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/rentals");
    revalidatePath("/rentals/rent-run");
    revalidatePath("/receivables");
    revalidatePath("/");
    const vat = result.totals.vat > 0
      ? ` VAT ${result.totals.vat.toFixed(2)} on the standard-rated leases.`
      : " No VAT — every lease in this run is exempt.";
    return {
      ok: true,
      message: `${result.created.length} invoices raised for ${result.label}.${vat}`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

// ── Lease lifecycle ─────────────────────────────────────────────────────────

/**
 * Create a lease.
 *
 * Redirects to the new lease on success rather than returning a message,
 * because the operator's next action is always to look at the schedule they
 * just generated. `redirect` throws a control-flow signal that must escape the
 * try block, so the service call and the navigation are deliberately separate.
 */
export async function createLeaseAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  let leaseId: string;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createLease(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          unitId: str(formData, "unitId"),
          partyId: str(formData, "partyId"),
          startsOn: str(formData, "startsOn"),
          endsOn: str(formData, "endsOn"),
          annualRent: str(formData, "annualRent") ? num(formData, "annualRent") : undefined,
          rentAmount: str(formData, "rentAmount") ? num(formData, "rentAmount") : undefined,
          billingDay: num(formData, "billingDay") || 1,
          graceDays: str(formData, "graceDays") ? num(formData, "graceDays") : 5,
          noticePeriodDays: str(formData, "noticePeriodDays") ? num(formData, "noticePeriodDays") : 90,
          autoRenew: flag(formData, "autoRenew"),
          escalationRate: str(formData, "escalationRate")
            ? num(formData, "escalationRate") / 100
            : 0,
          collectionMethod: str(formData, "collectionMethod") ?? "post_dated_cheques",
          chequeCount: str(formData, "chequeCount") ? num(formData, "chequeCount") : undefined,
          depositAmount: num(formData, "depositAmount") || 0,
          depositReceivedVia: str(formData, "depositReceivedVia"),
          ejariNumber: str(formData, "ejariNumber"),
          ejariRegisteredOn: str(formData, "ejariRegisteredOn"),
          dewaPremiseNumber: str(formData, "dewaPremiseNumber"),
          itemId: str(formData, "itemId"),
          cheques: chequeBundle(formData),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    leaseId = result.leaseId;
    revalidatePath("/rentals");
    revalidatePath("/rentals/cheques");
    revalidatePath("/");
  } catch (err) {
    return toResult(err);
  }
  redirect(`/rentals/lease/${leaseId}`);
}

export async function renewLeaseAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  let leaseId: string;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        renewLease(await buildContext(tx, session), {
          leaseId: str(formData, "leaseId"),
          startsOn: str(formData, "startsOn"),
          endsOn: str(formData, "endsOn"),
          annualRent: str(formData, "annualRent") ? num(formData, "annualRent") : undefined,
          rentAmount: str(formData, "rentAmount") ? num(formData, "rentAmount") : undefined,
          billingDay: str(formData, "billingDay") ? num(formData, "billingDay") : undefined,
          chequeCount: str(formData, "chequeCount") ? num(formData, "chequeCount") : undefined,
          ejariNumber: str(formData, "ejariNumber"),
          ejariRegisteredOn: str(formData, "ejariRegisteredOn"),
          additionalDeposit: num(formData, "additionalDeposit") || 0,
          additionalDepositVia: str(formData, "additionalDepositVia"),
          cheques: chequeBundle(formData),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    leaseId = result.leaseId;
    revalidatePath("/rentals");
    revalidatePath("/rentals/cheques");
    revalidatePath("/");
  } catch (err) {
    return toResult(err);
  }
  redirect(`/rentals/lease/${leaseId}`);
}

/**
 * Terminate a lease and settle the deposit.
 *
 * Stays on the page and reports the settlement, because the numbers ARE the
 * outcome: how much of the deposit was withheld, how much went against arrears
 * and how much is going back to the tenant is what the operator has to read
 * out to the person standing in front of them.
 */
export async function terminateLeaseAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const deductionLabel = str(formData, "deductionLabel");
    const deductionAmount = num(formData, "deductionAmount");
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        terminateLease(await buildContext(tx, session), {
          leaseId: str(formData, "leaseId"),
          terminatedOn: str(formData, "terminatedOn") ?? resolveToday(session.timezone),
          reason: str(formData, "reason") ?? "No reason given",
          billFinalRent: str(formData, "billFinalRent") !== "false",
          creditUnusedRent: str(formData, "creditUnusedRent") !== "false",
          deductions:
            deductionLabel && deductionAmount > 0
              ? [{ label: deductionLabel, amount: deductionAmount }]
              : [],
          applyToArrears: str(formData, "applyToArrears")
            ? num(formData, "applyToArrears")
            : undefined,
          refundAmount: str(formData, "refundAmount") ? num(formData, "refundAmount") : undefined,
          refundVia: str(formData, "refundVia") ?? "bank_transfer",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/rentals");
    revalidatePath(`/rentals/lease/${str(formData, "leaseId")}`);
    revalidatePath("/rentals/cheques");
    revalidatePath("/");

    const s = result.settlement;
    const parts = [
      `Deposit ${s.depositHeld.toFixed(2)}`,
      s.deductions > 0 ? `less ${s.deductions.toFixed(2)} withheld` : null,
      s.appliedToArrears > 0 ? `${s.appliedToArrears.toFixed(2)} against arrears` : null,
      s.refunded > 0 ? `${s.refunded.toFixed(2)} refunded` : "nothing left to refund",
    ].filter(Boolean);
    const tail = result.uncreditedUnusedRent > 0
      ? ` ${result.uncreditedUnusedRent.toFixed(2)} of rent is still invoiced beyond the end date — issue a credit note.`
      : "";
    return { ok: true, message: `${parts.join(", ")}.${tail}`, data: result };
  } catch (err) {
    return toResult(err);
  }
}
