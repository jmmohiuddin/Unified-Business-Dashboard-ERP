"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import {
  ServiceError,
  acknowledgeCashVariance,
  createCashRegister,
  formatMoney,
  openCashSession,
  recordCashVarianceReason,
  reportError,
  submitCashCount,
  type ServiceContext,
} from "@nexus/core";
import { requireSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { resolveToday } from "@/lib/data";
import type { ActionResult } from "@/lib/actions";

/**
 * Cash point server actions — FR-M07.
 *
 * A thin adapter, like `lib/actions.ts`: build a ServiceContext, call the
 * service, turn the outcome into something `ActionForm` can render, revalidate.
 * Every rule — the permission gate, the blind count, the threshold, the ledger
 * posting — lives in `@nexus/core/services/cash-sessions`, so the eventual
 * mobile client gets identical behaviour rather than a second implementation
 * with its own way of being wrong.
 *
 * WHY THIS IS A SEPARATE MODULE. `lib/actions.ts` is shared and contended; a
 * feature-scoped file keeps its own imports and its own revalidation targets.
 * The helpers below are deliberately duplicated from it rather than exported
 * across — a "use server" module may only export async functions, so lifting
 * `buildContext` into a shared file would mean a third file and an import cycle
 * for four lines of glue.
 *
 * ── THE ONE THING NOT TO BREAK IN THIS FILE ──────────────────────────────────
 *
 * `submitCashCountAction` is the only path by which the expected figure reaches
 * a browser, and it does so as the RETURN VALUE of the submission that carries
 * the count. Nothing here loads a session in order to render a close form: the
 * form needs the session id and nothing else. If a future "prefill" or
 * "preview" action appears in this file that reads a session before a count has
 * been submitted, it has to be as careful as `loadCashBoard` is, or the blind
 * count is over. See WF-05 §4.2.
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

/** Same blunt per-user write throttle the shared actions use. A cash screen on
 *  a shared tablet is exactly where a stuck finger produces a hundred submits. */
async function writeBudget(userId: string): Promise<ActionResult | null> {
  const limit = await rateLimit(`write:${userId}`, 120, 60);
  if (limit.allowed) return null;
  return {
    ok: false,
    message: "Too many changes in a short time. Wait a moment and try again.",
  };
}

/** Turn a thrown error into something a form can display. A raw database error
 *  rendered in the UI is an information leak; an unreported one is invisible. */
function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Some of those values are not valid." };
  }
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** Everything on this screen changes this screen, and the dashboard's cash
 *  figures come off the same ledger the variance posts into. */
function revalidateCash(): void {
  revalidatePath("/finance/cash");
  revalidatePath("/");
}

/* ── Opening ───────────────────────────────────────────────────────────────── */

export async function openCashSessionAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        openCashSession(await buildContext(tx, session), {
          cashRegisterId: str(formData, "cashRegisterId"),
          // Passed as the submitted STRING, never through Number(). A float
          // round trip on a float is how a till starts the day 0.0000001 out.
          openingFloat: str(formData, "openingFloat") ?? "0",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateCash();
    return {
      ok: true,
      message: `${result.registerName} is open with ${formatMoney(result.openingFloat, session.baseCurrency, 0)}.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

/* ── The blind count ───────────────────────────────────────────────────────── */

/**
 * Submit the counted cash and receive the reconciliation.
 *
 * The message this returns IS step 2 of WF-05 §4.2 — counted, expected, the
 * difference, and what happens next — and it is the first moment any of it
 * exists on the client. It is written in the words a cash handler uses: "short"
 * and "over", not "negative variance"; "the till is closed", not "session
 * state: closed".
 */
export async function submitCashCountAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        submitCashCount(await buildContext(tx, session), {
          sessionId: str(formData, "sessionId"),
          countedCash: str(formData, "countedCash") ?? "0",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateCash();

    const ccy = session.baseCurrency;
    const counted = formatMoney(result.countedCash, ccy, 2);
    const expected = formatMoney(result.expectedCash, ccy, 2);
    const gap = formatMoney(Math.abs(result.variance), ccy, 2);
    const limit = formatMoney(result.threshold, ccy, 0);

    const headline =
      result.variance === 0
        ? `Counted ${counted}. Expected ${expected}. Exact.`
        : result.variance < 0
          ? `Counted ${counted}. Expected ${expected}. Short ${gap}.`
          : `Counted ${counted}. Expected ${expected}. Over ${gap}.`;

    const tail = result.requiresAcknowledgement
      ? ` Above the ${limit} limit — say what happened below, then a manager has to acknowledge it before ${result.registerName} closes.`
      : result.variance === 0
        ? ` ${result.registerName} is closed.`
        : ` Below the ${limit} limit. Recorded as cash ${result.variance < 0 ? "short" : "over"}, and ${result.registerName} is closed.`;

    return { ok: true, message: headline + tail, data: result };
  } catch (err) {
    return toResult(err);
  }
}

/* ── Reason and acknowledgement ────────────────────────────────────────────── */

export async function recordCashVarianceReasonAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        recordCashVarianceReason(await buildContext(tx, session), {
          sessionId: str(formData, "sessionId"),
          // The quick answers and the free-text box post to the same field, so
          // "Don't know" is recorded as the honest answer WF-05 §4.3 intends
          // rather than as a blank the manager has to interpret.
          reason: str(formData, "reason") ?? str(formData, "quickReason"),
        }),
    );
    revalidateCash();
    return {
      ok: true,
      message: `Recorded. ${result.registerName} is waiting for a manager to acknowledge it.`,
    };
  } catch (err) {
    return toResult(err);
  }
}

export async function acknowledgeCashVarianceAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        acknowledgeCashVariance(await buildContext(tx, session), {
          sessionId: str(formData, "sessionId"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateCash();
    const gap = formatMoney(Math.abs(result.variance), session.baseCurrency, 2);
    return {
      ok: true,
      message:
        result.variance === 0
          ? `${result.registerName} is closed.`
          : `Acknowledged. ${result.registerName} is closed, and ${gap} ${result.variance < 0 ? "short" : "over"} is posted to cash over and short.`,
    };
  } catch (err) {
    return toResult(err);
  }
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

export async function createCashRegisterAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        createCashRegister(await buildContext(tx, session), {
          businessUnitId: str(formData, "businessUnitId"),
          name: str(formData, "name"),
          accountKey: str(formData, "accountKey") ?? "CASH",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateCash();
    return { ok: true, message: `${result.name} is ready to open.`, data: result };
  } catch (err) {
    return toResult(err);
  }
}
