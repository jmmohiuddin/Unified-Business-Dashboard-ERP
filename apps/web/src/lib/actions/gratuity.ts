"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { ServiceError, reportError, formatMoney, type ServiceContext } from "@nexus/core";
import { rehireEmployee, settleGratuity } from "@nexus/core/services";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";
import type { ActionResult } from "../actions";

/**
 * End-of-service settlement and rehire, as server actions.
 *
 * A thin adapter over `packages/core/src/services/gratuity-payout.ts`, exactly
 * like `lib/actions.ts` is over the rest of the write layer: build a
 * `ServiceContext`, call the service inside ONE transaction, translate the
 * outcome into something `ActionForm` can render.
 *
 * Nothing about a settlement is decided here — not the posting split between
 * the provision and the P&L, not the service clock a rehired employee restarts
 * on, and above all not what a gross-misconduct dismissal is worth. That last
 * one is open question Q-2b, and the refusal that keeps it open lives in the
 * service, where the future mobile client and any API caller hit it too. A
 * control that only exists in the browser is not a control.
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
 * `ServiceError` messages here are long on purpose and must reach the user
 * intact — the Q-2b refusal is four sentences explaining that a zero settlement
 * rests on an unconfirmed reading of the labour law, and truncating it to
 * "Invalid" would defeat the entire mechanism.
 */
function toResult(err: unknown): ActionResult {
  if (err instanceof ServiceError) return { ok: false, message: err.message };
  if (err instanceof Error && err.name === "ZodError") {
    return { ok: false, message: "Check the dates and amounts on the settlement." };
  }
  reportError(err, "server-action");
  return { ok: false, message: "Something went wrong. Nothing was saved." };
}

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** An amount that was left blank is absent, not zero — the two mean different
 *  things for `advanceRecovery`, where absent means "recover all of it". */
const optNum = (fd: FormData, key: string): number | undefined => {
  const v = str(fd, key);
  return v === undefined ? undefined : Number(v);
};

const num = (fd: FormData, key: string): number => optNum(fd, key) ?? 0;

/** Every screen that shows a gratuity figure, so none can go stale while
 *  another shows the settled one. */
function revalidateGratuity(): void {
  revalidatePath("/hr/gratuity");
  revalidatePath("/compliance");
  revalidatePath("/");
}

/**
 * Settle an employee's end of service and pay them.
 *
 * Irreversible: money leaves, a statutory obligation is discharged, and the
 * employment record closes. The screen puts this behind an `ActionForm confirm`
 * stating the effect in plain language — see WF-05 §0 and the eight
 * single-click posting paths that confirmation was introduced for.
 *
 * The success message deliberately reports the SPLIT, not just the total. An
 * owner who sees "AED 34,520.55 paid" learns nothing about whether the accrual
 * was right; "AED 30,000.00 released from the provision, AED 4,520.55 charged
 * to this month" tells them their monthly accrual is running light, which is
 * the only moment anyone ever finds that out.
 */
export async function settleGratuityAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  const ccy = session.baseCurrency;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        settleGratuity(await buildContext(tx, session), {
          employeeId: str(formData, "employeeId"),
          reason: str(formData, "reason"),
          lastWorkingDay: str(formData, "lastWorkingDay"),
          unpaidLeaveDays: num(formData, "unpaidLeaveDays"),
          unpaidSalary: num(formData, "unpaidSalary"),
          leaveEncashment: num(formData, "leaveEncashment"),
          noticePay: num(formData, "noticePay"),
          otherEarnings: num(formData, "otherEarnings"),
          advanceRecovery: optNum(formData, "advanceRecovery"),
          settledVia: str(formData, "settledVia") ?? "bank_transfer",
          acknowledgeForfeitureAssumption:
            formData.get("acknowledgeForfeitureAssumption") === "on",
          note: str(formData, "note"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateGratuity();

    const split =
      result.expenseShortfall > 0
        ? ` ${formatMoney(result.provisionApplied, ccy)} came out of the provision and ` +
          `${formatMoney(result.expenseShortfall, ccy)} was charged to this month — the accrual ` +
          "was running light."
        : result.provisionReleased > 0
          ? ` ${formatMoney(result.provisionApplied, ccy)} came out of the provision, of which ` +
            `${formatMoney(result.provisionReleased, ccy)} was over-accrued and released back to profit.`
          : ` It came entirely out of the provision, which was exactly right.`;
    const forfeited = result.forfeitureAssumed
      ? " Settled at zero gratuity on the Article 44 forfeiture ASSUMPTION — open question Q-2b."
      : "";

    return {
      ok: true,
      message:
        `${result.settlementNumber}: ${result.employeeName} settled to ${result.lastWorkingDay}. ` +
        `Gratuity ${formatMoney(result.gratuityAmount, ccy)}, net paid ` +
        `${formatMoney(result.netPayable, ccy)}.${split}${forfeited}`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Bring a settled employee back — edge case EC-05.
 *
 * No money moves, so no `confirm` is strictly required, but the screen uses one
 * anyway: this is the write that decides what the NEXT settlement pays, and
 * getting the date wrong either hands someone a second payment for years
 * already bought or quietly deletes service they are entitled to.
 */
export async function rehireEmployeeAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;
  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        rehireEmployee(await buildContext(tx, session), {
          employeeId: str(formData, "employeeId"),
          rehiredOn: str(formData, "rehiredOn"),
          businessUnitId: str(formData, "businessUnitId"),
          basicSalary: optNum(formData, "basicSalary"),
          housingAllowance: optNum(formData, "housingAllowance"),
          transportAllowance: optNum(formData, "transportAllowance"),
          otherAllowance: optNum(formData, "otherAllowance"),
          note: str(formData, "note"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidateGratuity();
    const settled = result.settledThrough
      ? ` Service to ${result.settledThrough} was settled under ${result.previousSettlement} and is not counted again.`
      : "";
    return {
      ok: true,
      message:
        `${result.employeeName} is back. Gratuity accrues from ${result.serviceStart}, not from ` +
        `their joining date of ${result.joinedOn}.${settled}`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}
