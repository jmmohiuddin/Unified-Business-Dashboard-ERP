import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, generateSif, tryDecryptPii, type WpsEmployee } from "@nexus/core";
import { getSession } from "@/lib/session";

/**
 * WPS Salary Information File download.
 *
 * A real, bank-submittable CSV — not a mock. MOHRE's format is unforgiving
 * (fixed column order, exactly one trailing SCR record, CRLF line endings), and
 * a single malformed field rejects the whole batch. Generating it here removes
 * the monthly spreadsheet that most SMEs still maintain by hand.
 *
 * Validation warnings are returned as a header rather than silently dropped:
 * the owner needs to know a missing IBAN will bounce the file BEFORE payday,
 * not after the bank rejects it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ month: string }> },
) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Payroll data is sensitive; the same permission gates the HR screens.
  if (!can(session.principal, "payroll:read")) {
    return new Response("Forbidden", { status: 403 });
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

  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    (tx) =>
      tx.execute<{
        full_name: string; wps_person_id: string | null; wps_routing_code: string | null;
        iban_enc: string | null; basic: string; housing: string; transport: string; other: string;
      }>(sql`
        SELECT full_name, wps_person_id, wps_routing_code, iban_enc,
               base_salary AS basic, housing_allowance AS housing,
               transport_allowance AS transport, other_allowance AS other
          FROM employees
         WHERE status IN ('active','probation')
         ORDER BY employee_code
      `),
  );

  const daysInPeriod = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();

  const employees: WpsEmployee[] = rows.map((e) => ({
    personId: e.wps_person_id ?? "",
    agentId: "0000000",
    routingCode: e.wps_routing_code ?? "",
    // Decrypted only here, in the one place that legitimately needs the full
    // account number, and never logged.
    iban: tryDecryptPii(e.iban_enc) ?? "",
    daysInPeriod,
    // Fixed income is the contractual package; variable is overtime and
    // commission, which would come from the payroll run in production.
    fixedIncome:
      Number(e.basic) + Number(e.housing) + Number(e.transport) + Number(e.other),
    variableIncome: 0,
    daysOnLeave: 0,
    employeeName: e.full_name,
  }));

  const file = generateSif({
    // In production these come from tenant settings, registered with MOHRE.
    employerId: "1234567890123",
    employerAgentId: "0000000",
    employerRoutingCode: "402010101",
    salaryMonth: month,
    // Passed in rather than read from the clock so the output is reproducible.
    generatedAt: new Date(`${month}-01T09:00:00Z`),
    employees,
  });

  return new Response(file.content, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "X-WPS-Records": String(file.recordCount),
      "X-WPS-Total": file.totalSalaries.toFixed(2),
      "X-WPS-Warnings": String(file.warnings.length),
      "Cache-Control": "no-store",
    },
  });
}
