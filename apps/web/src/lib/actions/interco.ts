"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { ServiceError, reportError, type ServiceContext } from "@nexus/core";
import { interBusinessTransfer, settleInterBusiness } from "@nexus/core/services";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";
import type { ActionResult } from "../actions";

/**
 * Inter-business transfers, as server actions.
 *
 * A thin adapter over `packages/core/src/services/interco.ts`, exactly like
 * `lib/actions.ts` is over the rest of the write layer: build a
 * `ServiceContext`, call the service inside ONE transaction, translate the
 * outcome into something `ActionForm` can render.
 *
 * NOTHING about inter-business posting lives here — not the account mapping,
 * not the VAT decision, not the reciprocal invariant, not the permission check.
 * That matters more for this feature than for most: the same transfer has to be
 * postable from the field application when a technician closes a job, and a
 * second implementation of "both legs or neither" is two chances to write one.
 *
 * In its own module because `lib/actions.ts` is shared and contended; the
 * patterns below (`writeBudget`, `buildContext`, `toResult`) are its patterns,
 * reproduced rather than imported because they are not exported — a "use
 * server" module may only export async functions.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Session = Awaited<ReturnType<typeof requireSession>>;

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

/** Same blunt backstop as every other mutating path: 120 writes a minute,
 *  keyed on the session rather than the IP, because the session is the
 *  capability being abused. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return {
    ok: false,
    message: "Too many changes in a short time. Wait a moment and try again.",
  };
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

/** Every screen that shows an inter-business figure, so none of them can go
 *  stale while another shows the new balance. */
function revalidateInterco(): void {
  revalidatePath("/businesses/interco");
  revalidatePath("/businesses");
  revalidatePath("/accounting/profit-loss");
  revalidatePath("/");
}

/**
 * "One business paid for another" — WF-05 §3.4, FR-M06.
 *
 * `pricingBasis` reaches the service verbatim rather than being defaulted here,
 * because Q-12 (at cost vs arm's length) is open and the default belongs in ONE
 * place. If this file defaulted it too, resolving Q-12 would mean finding both.
 */
export async function recordInterBusinessTransferAction(
  formData: FormData,
): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        interBusinessTransfer(await buildContext(tx, session), {
          payingBusinessUnitId: str(formData, "payingBusinessUnitId"),
          benefitingBusinessUnitId: str(formData, "benefitingBusinessUnitId"),
          amount: num(formData, "amount"),
          nature: str(formData, "nature") ?? "service_performed",
          transferDate: str(formData, "transferDate") ?? resolveToday(session.timezone),
          pricingBasis: str(formData, "pricingBasis") ?? "at_cost",
          pricingBasisNote: str(formData, "pricingBasisNote"),
          benefitAccountKey: str(formData, "benefitAccountKey"),
          note: str(formData, "note"),
          // Supplied by ActionForm as a digest of the submitted values, so a
          // double-tap replays the original posting instead of charging the
          // other business twice.
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateInterco();
    return {
      ok: true,
      message:
        `${result.docNumber} recorded — AED ${result.gross} charged. ` +
        "Your group total does not change.",
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Settle what one business owes another — the `[Settle]` button in WF-05 §6.
 *
 * The amount defaults to the whole outstanding balance, which is what the
 * button in the wireframe means; a partial settlement is possible by sending a
 * smaller `amount`. Over-settlement is refused in the service, exactly, not
 * clamped here.
 */
export async function settleInterBusinessAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        settleInterBusiness(await buildContext(tx, session), {
          creditorBusinessUnitId: str(formData, "creditorBusinessUnitId"),
          debtorBusinessUnitId: str(formData, "debtorBusinessUnitId"),
          amount: num(formData, "amount"),
          settledOn: str(formData, "settledOn") ?? resolveToday(session.timezone),
          method: str(formData, "method") ?? "bank",
          note: str(formData, "note"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateInterco();
    return {
      ok: true,
      message:
        `AED ${result.settled} settled.` +
        (result.remaining === "0.0000" ? " Nothing left outstanding." : ` AED ${result.remaining} still outstanding.`),
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}
