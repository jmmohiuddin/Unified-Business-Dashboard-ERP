"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { ServiceError, reportError, type ServiceContext } from "@nexus/core";
import { closePeriod, reopenPeriod } from "@nexus/core/services";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";
import type { ActionResult } from "../actions";

/**
 * Period close and reopen, as server actions.
 *
 * A thin adapter over `packages/core/src/services/periods.ts`, exactly like
 * `lib/actions.ts` is over the rest of the write layer: build a
 * `ServiceContext`, call the service inside ONE transaction, translate the
 * outcome into something `ActionForm` can render. No rule lives here. The
 * permission checks, the checklist, the cascade and the audit record are all in
 * the service, so the future mobile API gets the same lock rather than a second
 * one with its own idea of who may reopen a month.
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

/** Same blunt per-user write throttle as every other mutating action. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return { ok: false, message: "Too many changes in a short time. Wait a moment and try again." };
}

/**
 * Turn a thrown error into something the form can display.
 *
 * `ServiceError` messages are written for the accountant and are safe to show —
 * "July 2026 cannot be closed yet: all cash sessions closed (1)" is the whole
 * value of the checklist. Anything else is reported server-side and generalised,
 * because a raw database error rendered on a close screen is an information
 * leak and an unreported one is invisible.
 */
function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Check the period and the reason you gave." };
  }
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/**
 * Close a period.
 *
 * `acknowledgeWarnings` arrives from a checkbox the accountant has to tick. The
 * screen also hides the button until it is ticked; the service refuses without
 * it regardless, which is the half that counts.
 */
export async function closePeriodAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        closePeriod(await buildContext(tx, session), {
          label: str(formData, "label"),
          note: str(formData, "note"),
          acknowledgeWarnings: formData.get("acknowledgeWarnings") === "on",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/accounting/close");
    revalidatePath("/compliance");
    revalidatePath("/");
    const cascade =
      result.cascaded.length > 0
        ? ` ${result.cascaded.length} earlier period${
            result.cascaded.length === 1 ? "" : "s"
          } were locked with it.`
        : "";
    return {
      ok: true,
      message: `${result.displayLabel} is closed.${cascade} ${result.journalsStamped} journals stamped.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Reopen a closed period.
 *
 * Every gate that makes this harder than closing lives in the service — the
 * separate permission, the owner rank floor, the typed-back label, the
 * twenty-character reason, and the refusal to reopen a month with a closed one
 * on top of it. This function adds nothing and must not: a control that is only
 * strict in the browser is not strict.
 */
export async function reopenPeriodAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        reopenPeriod(await buildContext(tx, session), {
          label: str(formData, "label"),
          confirmLabel: str(formData, "confirmLabel") ?? "",
          reason: str(formData, "reason") ?? "",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePath("/accounting/close");
    revalidatePath("/compliance");
    revalidatePath("/");
    return {
      ok: true,
      message: `${result.displayLabel} is open again. ${result.journalsAffected} journals in it can now be changed.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}
