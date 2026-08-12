"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import {
  ServiceError,
  adjustStock,
  bookAppointment,
  completeJob,
  createCreditNote,
  createInvoice,
  createJob,
  changeRole,
  createPurchaseOrder,
  deactivateUser,
  markAllRead,
  markNotificationRead,
  payBill,
  reactivateUser,
  receiveBill,
  recordPayment,
  setAppointmentStatus,
  transitionCheque,
  type ServiceContext,
} from "@nexus/core";
import { requireSession } from "./session";
import { rateLimit } from "./rate-limit";
import { resolveToday } from "./data";

/**
 * Server actions.
 *
 * These are a thin adapter, on purpose: build a ServiceContext, call the
 * service, translate the outcome into something a form can render, revalidate
 * the affected paths. All validation, permission checking, ledger posting and
 * auditing lives in `@nexus/core/services`, so the future mobile API gets
 * identical behaviour rather than a second implementation with its own bugs.
 *
 * Every action runs inside ONE transaction: if the journal fails to balance,
 * the payment does not exist either.
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

/**
 * Write throttle.
 *
 * Every mutating action was unthrottled: the login form and the read API were
 * rate-limited, but the fourteen paths that actually move money were not. A
 * session cookie plus a loop could post journals as fast as the database would
 * accept them.
 *
 * Keyed by user rather than IP — the authenticated session is the capability
 * being abused, and an IP key is both spoofable and shared behind NAT. 120/min
 * is far beyond human form-filling and far below what a script wants.
 *
 * This is a blunt backstop, not a business rule. Per-action limits belong with
 * the approval gates in the automation engine, not here.
 */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return {
    ok: false,
    message: "Too many changes in a short time. Wait a moment and try again.",
  };
}

/** Turn a thrown error into something a form can display. */
function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Some of those values are not valid." };
  }
  // Anything unexpected is logged server-side and generalised for the user —
  // a raw database error rendered in the UI is an information leak.
  console.error("[action]", err);
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const num = (fd: FormData, key: string) => Number(fd.get(key) ?? 0);
const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

// ── Payments ────────────────────────────────────────────────────────────────

export async function recordPaymentAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        recordPayment(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          partyId: str(formData, "partyId") ?? null,
          amount: num(formData, "amount"),
          method: str(formData, "method") ?? "cash",
          receivedOn: str(formData, "receivedOn") ?? resolveToday(session.timezone),
          reference: str(formData, "reference"),
          allocations: str(formData, "documentId")
            ? [{ documentId: str(formData, "documentId")!, amount: num(formData, "amount") }]
            : undefined,
          autoAllocate: !str(formData, "documentId"),
          // Supplied by the form, so a double-submit replays the original
          // result instead of taking the money twice.
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/receivables");
    revalidatePath("/");
    return {
      ok: true,
      message: `${result.paymentNumber} recorded — ${result.settledInvoices.length} invoice(s) settled.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

// ── Cheques ─────────────────────────────────────────────────────────────────

export async function chequeAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const action = str(formData, "action") ?? "deposit";
    await withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) =>
      transitionCheque(await buildContext(tx, session), {
        chequeId: str(formData, "chequeId"),
        action,
        onDate: str(formData, "onDate") ?? resolveToday(session.timezone),
        bounceReason: str(formData, "bounceReason"),
        bankCharge: num(formData, "bankCharge") || 0,
        replacement: str(formData, "replacementNumber")
          ? {
              chequeNumber: str(formData, "replacementNumber")!,
              bankName: str(formData, "replacementBank"),
              chequeDate: str(formData, "replacementDate") ?? resolveToday(session.timezone),
              amount: num(formData, "replacementAmount"),
            }
          : undefined,
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    );
    revalidatePath("/rentals/cheques");
    revalidatePath("/");
    return { ok: true, message: `Cheque ${action}ed.` };
  } catch (err) {
    return toResult(err);
  }
}

// ── Sales ───────────────────────────────────────────────────────────────────

export async function createInvoiceAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createInvoice(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          partyId: str(formData, "partyId") ?? null,
          issueDate: str(formData, "issueDate") ?? resolveToday(session.timezone),
          dueDays: num(formData, "dueDays") || 0,
          lines: [
            {
              itemId: str(formData, "itemId"),
              quantity: num(formData, "quantity") || 1,
              unitPrice: str(formData, "unitPrice") ? num(formData, "unitPrice") : undefined,
              employeeId: str(formData, "employeeId") ?? null,
            },
          ],
          payment: str(formData, "payNow")
            ? { method: (str(formData, "method") ?? "cash") as never }
            : undefined,
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/receivables");
    revalidatePath("/");
    return { ok: true, message: `${result.docNumber} created.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

// ── Salon ───────────────────────────────────────────────────────────────────

export async function bookAppointmentAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        bookAppointment(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          resourceId: str(formData, "resourceId"),
          employeeId: str(formData, "employeeId") ?? null,
          itemId: str(formData, "itemId"),
          // Times are entered in Gulf local, which is what the person at the
          // desk is reading off the clock on the wall.
          startsAt: new Date(
            `${str(formData, "date")}T${str(formData, "time")}:00+04:00`,
          ).toISOString(),
          partyId: str(formData, "partyId") ?? null,
          walkInName: str(formData, "walkInName"),
          walkInPhone: str(formData, "walkInPhone"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/salon");
    return { ok: true, message: `Booked — ${result.reference}.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

export async function appointmentStatusAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    await withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) =>
      setAppointmentStatus(await buildContext(tx, session), {
        appointmentId: str(formData, "appointmentId"),
        status: str(formData, "status"),
      }),
    );
    revalidatePath("/salon");
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

// ── Field service ───────────────────────────────────────────────────────────

export async function createJobAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createJob(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          serviceKind: str(formData, "serviceKind") ?? "handyman",
          title: str(formData, "title") ?? "Service call",
          description: str(formData, "description"),
          partyId: str(formData, "partyId") ?? null,
          siteId: str(formData, "siteId") ?? null,
          unitId: str(formData, "unitId") ?? null,
          priority: str(formData, "priority") ?? "normal",
          itemId: str(formData, "itemId") ?? null,
          assignEmployeeId: str(formData, "assignEmployeeId") ?? null,
          scheduledStart: str(formData, "scheduledDate")
            ? new Date(
                `${str(formData, "scheduledDate")}T${str(formData, "scheduledTime") ?? "09:00"}:00+04:00`,
              ).toISOString()
            : undefined,
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/services");
    revalidatePath("/");
    return { ok: true, message: `${result.jobNumber} raised.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

export async function completeJobAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        completeJob(await buildContext(tx, session), {
          jobId: str(formData, "jobId"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/services");
    revalidatePath("/");
    return { ok: true, message: `${result.jobNumber} completed.` };
  } catch (err) {
    return toResult(err);
  }
}

// ── Payables and purchasing ─────────────────────────────────────────────────

export async function receiveBillAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        receiveBill(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          supplierId: str(formData, "supplierId"),
          billDate: str(formData, "billDate") ?? resolveToday(session.timezone),
          supplierReference: str(formData, "supplierReference"),
          paymentTermDays: num(formData, "paymentTermDays") || 30,
          receiveStock: str(formData, "receiveStock") !== "false",
          lines: [
            {
              itemId: str(formData, "itemId"),
              quantity: num(formData, "quantity") || 1,
              unitCost: num(formData, "unitCost"),
              vatRate: str(formData, "vatRate") ? num(formData, "vatRate") : 0.05,
            },
          ],
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/purchases");
    revalidatePath("/inventory");
    revalidatePath("/");
    return { ok: true, message: `${result.docNumber} recorded.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

export async function payBillAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        payBill(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          supplierId: str(formData, "supplierId"),
          amount: num(formData, "amount"),
          method: str(formData, "method") ?? "bank_transfer",
          paidOn: str(formData, "paidOn") ?? resolveToday(session.timezone),
          billId: str(formData, "billId") ?? null,
          reference: str(formData, "reference"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/purchases");
    revalidatePath("/");
    return { ok: true, message: `${result.paymentNumber} paid.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

export async function createPurchaseOrderAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createPurchaseOrder(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          supplierId: str(formData, "supplierId"),
          issueDate: str(formData, "issueDate") ?? resolveToday(session.timezone),
          lines: [
            {
              itemId: str(formData, "itemId"),
              quantity: num(formData, "quantity") || 1,
              unitCost: num(formData, "unitCost"),
            },
          ],
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/purchases");
    return { ok: true, message: `${result.docNumber} raised.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}

// ── Inventory ───────────────────────────────────────────────────────────────

export async function adjustStockAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  // "warehouseId::businessUnitId" — the warehouse dropdown carries its owning
  // business so the variance posts to the right P&L regardless of which one.
  const [warehouseId, businessUnitId] = (str(formData, "warehouseRef") ?? "").split("::");
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        adjustStock(await buildContext(tx, session), {
          businessUnitId: businessUnitId || undefined,
          warehouseId: warehouseId || undefined,
          itemId: str(formData, "itemId"),
          countedQuantity: num(formData, "countedQuantity"),
          reason: str(formData, "reason") ?? "count",
          note: str(formData, "note"),
          onDate: str(formData, "onDate") ?? resolveToday(session.timezone),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/inventory");
    return {
      ok: true,
      message: result.adjusted
        ? `Adjusted by ${result.delta > 0 ? "+" : ""}${result.delta}.`
        : "No variance — nothing to adjust.",
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

// ── Credit notes ────────────────────────────────────────────────────────────

export async function createCreditNoteAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createCreditNote(await buildContext(tx, session), {
          invoiceId: str(formData, "invoiceId"),
          reason: str(formData, "reason") ?? "Return",
          full: str(formData, "full") === "true",
          refundMethod: str(formData, "refundMethod") ?? "credit_on_account",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/receivables");
    revalidatePath("/");
    return {
      ok: true,
      message: `${result.docNumber} — ${result.refunded > 0 ? "refunded" : "credited"}.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

// ── Notifications ───────────────────────────────────────────────────────────

export async function markNotificationReadAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  const id = str(formData, "id");
  if (!id) return { ok: false };
  await withTenant({ tenantId: session.tenantId, userId: session.userId }, (tx) =>
    markNotificationRead(tx, session.tenantId, id),
  );
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  const n = await withTenant({ tenantId: session.tenantId, userId: session.userId }, (tx) =>
    markAllRead(tx, session.tenantId),
  );
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
  return { ok: true, message: `${n} marked read.` };
}

// ── User management ─────────────────────────────────────────────────────────

export async function deactivateUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        deactivateUser(await buildContext(tx, session), {
          membershipId: str(formData, "membershipId"),
          reason: str(formData, "reason") ?? "No reason given",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/users");
    return {
      ok: true,
      message: `Access removed. ${result.sessionsRevoked} active session${
        result.sessionsRevoked === 1 ? "" : "s"
      } signed out immediately.`,
    };
  } catch (err) {
    return toResult(err);
  }
}

export async function reactivateUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    await withTenant({ tenantId: session.tenantId, userId: session.userId }, async (tx) =>
      reactivateUser(await buildContext(tx, session), {
        membershipId: str(formData, "membershipId"),
        idempotencyKey: str(formData, "idempotencyKey"),
      }),
    );
    revalidatePath("/settings/users");
    return { ok: true, message: "Access restored. They can sign in again." };
  } catch (err) {
    return toResult(err);
  }
}

export async function changeRoleAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        changeRole(await buildContext(tx, session), {
          membershipId: str(formData, "membershipId"),
          roleKey: str(formData, "roleKey"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/settings/users");
    return { ok: true, message: `Role changed to ${result.roleKey}. It applies on their next request.` };
  } catch (err) {
    return toResult(err);
  }
}
