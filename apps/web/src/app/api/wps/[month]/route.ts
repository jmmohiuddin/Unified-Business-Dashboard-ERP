import { withTenant } from "@nexus/db";
import { can, generateSif, reportError, security } from "@nexus/core";
import { getSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
/**
 * Imported from the service module directly rather than through the
 * `@nexus/core` barrel.
 *
 * `packages/core/src/services/index.ts` is coordinator-owned while several
 * features land in one working tree, so this feature's
 * `export * from "./payroll.ts"` line has not been added yet. Once it is,
 * change this import and the two in `(app)/hr/payroll/**` to `@nexus/core` and
 * nothing else moves.
 */
import { loadWpsExport } from "../../../../../../../packages/core/src/services/payroll.ts";

/**
 * WPS Salary Information File download.
 *
 * A real, bank-submittable CSV — not a mock.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED ───────────────────────────────────────
 *
 * This route used to BUILD the payroll. It read `employees`, summed four
 * allowance columns, and declared every person a full-month, fixed-package
 * payee with no overtime, no commission, no leave and no deductions
 * (audit CALC-15). Joiners, leavers and part-months were all misreported by
 * construction, and the resulting file — an instruction to a bank to move real
 * salaries — was a computation nobody in the business had ever approved,
 * running in parallel to a `payroll_runs` table that nothing wrote.
 *
 * It is now a serialiser over a committed payroll run (FR-C06). Every amount
 * comes from a payslip that was reconciled, journalled and audited;
 * `loadWpsExport` reads it and `generateSif` lays it out. If no run has been
 * approved for the month, this route produces NOTHING and says so — which is
 * the honest answer, and the whole point: the file is a consequence of the
 * payroll, not a second opinion about it.
 *
 * ── VALIDATION IS A GATE, NOT A HEADER (CALC-16) ─────────────────────────────
 *
 * `validateWps` warnings used to be reduced to `X-WPS-Warnings: 4` and the file
 * was handed over regardless — so a SIF containing `BAD` as an IBAN, an empty
 * routing field and a zero salary downloaded silently, and the bank found out
 * two days before payday. The messages are now returned as JSON with HTTP 409
 * and the download is refused, unless the caller explicitly acknowledges them
 * with `?acknowledgeWarnings=1`. The escape hatch exists because a validation
 * rule written against an unverified layout (Q-7) must not be able to make
 * payroll impossible; it is deliberately not the default.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────────
 *
 * The hardening this endpoint acquired after a past incident: the try/catch
 * that keeps stack traces off the wire, the per-user rate limit, the
 * shape-and-range check on the month, and the business-unit scope filter. All
 * still here, all still for the reasons stated at each one.
 */

/**
 * Employer identity, as registered with MOHRE.
 *
 * Still constants. They belong in tenant settings — the audit says so and it is
 * right — but that is a settings-schema change owned elsewhere, and moving them
 * here would have been a change to a file this feature does not own. Named and
 * grouped so the move is one edit.
 */
const EMPLOYER = {
  id: "1234567890123",
  agentId: "0000000",
  routingCode: "402010101",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ month: string }> },
) {
  try {
    return await handle(req, params);
  } catch (err) {
    // This endpoint decrypts IBANs. An unhandled throw here would surface a
    // framework stack trace, and stack traces from this code path can carry
    // query fragments and column names. Log server-side, return nothing useful.
    reportError(err, "api/wps");
    return new Response("Could not generate the file", { status: 500 });
  }
}

/** JSON with no store. Errors from this route are read by a screen, not a parser. */
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function handle(req: Request, params: Promise<{ month: string }>) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Payroll data is sensitive; the same permission gates the HR screens.
  if (!can(session.principal, "payroll:read")) {
    return new Response("Forbidden", { status: 403 });
  }

  /**
   * Rate limit.
   *
   * One request returns the decrypted IBAN of every employee, and the month is
   * a free path parameter spanning 2018–2100 — ~1,000 distinct URLs. Without a
   * limit a stolen session cookie could enumerate the lot at full speed. Keyed
   * by user, not IP: the session is the thing being abused.
   */
  const limit = await rateLimit(`wps:${session.userId}`, 12, 60);
  if (!limit.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const { month } = await params;
  // Shape AND range. `\d{2}` alone happily accepts month 99, which then becomes
  // a nonsense Date and a malformed SIF filename.
  const parsed = /^(\d{4})-(\d{2})$/.exec(month);
  const year = Number(parsed?.[1]);
  const monthNo = Number(parsed?.[2]);
  if (!parsed || monthNo < 1 || monthNo > 12 || year < 2018 || year > 2100) {
    return new Response("Expected a valid month in YYYY-MM form", { status: 400 });
  }

  const acknowledged = new URL(req.url).searchParams.get("acknowledgeWarnings") === "1";

  /**
   * Business-unit scope.
   *
   * RLS guarantees tenant isolation but knows nothing about a membership's
   * business-unit scope, and this query had no scope filter — so a scoped
   * holder of `payroll:read` would have received every employee in the tenant.
   * Today only tenant-scoped roles (owner, accountant, hr) hold that
   * permission, so this was not yet reachable; it is applied anyway, because
   * "no role currently has it" is a fact about the seed, not an invariant.
   *
   * `businessUnitIds === null` means tenant-wide.
   */
  const scope = session.principal.businessUnitIds;

  const source = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) => loadWpsExport(tx, { period: month, businessUnitIds: scope }),
  );

  /**
   * No run, no file.
   *
   * Refusing here is the behaviour change that makes this route trustworthy.
   * The old code would happily produce a file for any month in an eighty-year
   * range, including months that had not happened yet, because it derived
   * everything from current master data.
   */
  if (!source) {
    return json(
      {
        error: `No approved payroll run exists for ${month}.`,
        detail:
          "The WPS file is generated from a committed payroll run, not from the employee " +
          "records. Run and approve payroll for this month first.",
        where: "/hr/payroll",
      },
      404,
    );
  }

  /**
   * The security event.
   *
   * One request decrypts the IBAN of every employee on the run. Nothing
   * recorded that before — `security.piiDecrypted` existed with no caller
   * anywhere in the product — so a stolen session enumerating months left the
   * same trace as a legitimate monthly download: none.
   *
   * The COUNT is recorded and never a value. `securityEvent` redacts
   * sensitive-looking keys before the line leaves the module, but the only
   * guarantee worth relying on is not putting the plaintext in.
   */
  security.piiDecrypted({
    tenantId: session.tenantId,
    userId: session.userId,
    actorRole: session.principal.roleKey,
    detail: {
      route: "api/wps",
      field: "employees.iban_enc",
      period: month,
      decrypted: source.ibanDecryptions,
      failed: source.ibanFailures,
      runIds: source.runIds,
    },
  });

  const file = generateSif({
    employerId: EMPLOYER.id,
    employerAgentId: EMPLOYER.agentId,
    employerRoutingCode: EMPLOYER.routingCode,
    salaryMonth: month,
    // Passed in rather than read from the clock so the output is reproducible.
    generatedAt: new Date(`${month}-01T09:00:00Z`),
    employees: source.employees,
  });

  /* ── CALC-16: block on warnings, and say what they are ─────────────────── */

  if (file.warnings.length > 0 && !acknowledged) {
    return json(
      {
        error: `This SIF would be rejected — ${file.warnings.length} problem${
          file.warnings.length === 1 ? "" : "s"
        } found.`,
        detail:
          "Fix these on the employee records and download again. Catching a malformed IBAN " +
          "here is materially better than the bank rejecting the whole batch two days before " +
          "payday. To download it anyway, add ?acknowledgeWarnings=1.",
        period: month,
        employees: source.employeeCount,
        warnings: file.detailedWarnings,
      },
      409,
    );
  }

  return new Response(file.content, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "X-WPS-Records": String(file.recordCount),
      "X-WPS-Total": file.totalSalaries.toFixed(2),
      // Only ever non-zero on an acknowledged download; the messages themselves
      // came back with the 409 that preceded it.
      "X-WPS-Warnings": String(file.warnings.length),
      "X-WPS-Run-Status": source.status,
      "Cache-Control": "no-store",
    },
  });
}
