"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withTenant } from "@nexus/db";
import { ServiceError, reportError, type ServiceContext } from "@nexus/core";
/**
 * Imported from the service module directly rather than through the
 * `@nexus/core` barrel.
 *
 * `packages/core/src/services/index.ts` is coordinator-owned while several
 * features land in one working tree, so this feature's
 * `export * from "./payroll.ts"` line has not been added yet. Once it is,
 * change this import, the one in `api/wps/[month]/route.ts` and the two in
 * `(app)/hr/payroll/**` to `@nexus/core` and nothing else moves.
 */
import {
  commitPayrollRun,
  markPayrollRunPaid,
} from "../../../../../packages/core/src/services/payroll.ts";
import { requireSession } from "../session";
import { rateLimit } from "../rate-limit";
import { resolveToday } from "../data";

/**
 * Payroll server actions — FR-C06.
 *
 * A thin adapter over `@nexus/core/services/payroll`, following the contract in
 * `lib/actions.ts` exactly — one transaction per action, `writeBudget` before
 * anything runs, `ServiceError` translated into something a form can render,
 * and never a raw database error on screen. It lives in its own module rather
 * than in the shared `actions.ts` because that file is contended by every
 * feature at once; the behaviour is deliberately identical.
 *
 * All validation, permission checking, proration, commission claiming, ledger
 * posting and auditing lives in the service. Nothing below decides anything —
 * in particular, nothing below decides whether a month has already been run.
 * Two operators in two tabs defeat any check made here; the domain's advisory
 * lock and per-employee guard are the ones that hold.
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

const str = (fd: FormData, key: string): string | undefined => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

const money = (n: number) => n.toFixed(2);

function revalidatePayroll() {
  revalidatePath("/hr/payroll");
  revalidatePath("/hr/gratuity");
  revalidatePath("/compliance");
  revalidatePath("/");
}

/**
 * Approve a payroll run.
 *
 * The period travels in the form payload, so the idempotency digest
 * `ActionForm` derives is a fingerprint of "approve August's payroll" — press
 * the button twice and the second press replays the first result rather than
 * paying everyone a second time. That is the weakest of the three duplicate
 * guards and the only one this file participates in; see the service header.
 */
export async function payrollRunAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        commitPayrollRun(await buildContext(tx, session), {
          period: str(formData, "period"),
          businessUnitId: str(formData, "businessUnitId"),
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePayroll();

    const deductions =
      result.totals.deductions > 0
        ? ` ${money(result.totals.deductions)} of salary advances recovered.`
        : "";
    return {
      ok: true,
      message:
        `${result.label} payroll approved — ${result.totals.employees} payslips, ` +
        `${money(result.totals.gross)} gross, ${money(result.totals.net)} net, due ` +
        `${result.dueOn}.${deductions} The wage journal is posted; the money has not moved yet.`,
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * Release the money — DR SALARY_PAYABLE, CR BANK.
 *
 * Separate action, separate permission (`payroll:pay`), separate confirmation.
 * The accountant approves the payroll; the owner pays it. Collapsing the two
 * would mean anyone who could compute a payroll could also move the cash.
 */
export async function payrollPayAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const throttled = await writeBudget(session.userId);
  if (throttled) return throttled;

  try {
    const result = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        markPayrollRunPaid(await buildContext(tx, session), {
          runId: str(formData, "runId"),
          paidOn: str(formData, "paidOn"),
          paidVia: str(formData, "paidVia") ?? "wps",
          idempotencyKey: str(formData, "idempotencyKey"),
        }),
    );
    revalidatePayroll();
    revalidatePath("/cash");
    revalidatePath("/finance/cash");

    return {
      ok: true,
      message:
        `${result.label} payroll marked paid — ${money(result.net)} released to ` +
        `${result.employees} employees via ${result.paidVia} on ${result.paidOn}. ` +
        "Salaries payable is discharged.",
      data: result,
    };
  } catch (err) {
    return toResult(err);
  }
}
