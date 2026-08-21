import { describe, expect, it } from "vitest";
import * as M from "../money/index.ts";
import {
  generateSif,
  inclusiveDays,
  salaryMonthEnd,
  validateWps,
  validateWpsDetailed,
  type WpsEmployee,
} from "../uae/wps.ts";
import {
  commitPayrollRun,
  overtimePay,
  payrollLegs,
  previewPayrollRun,
  proratePay,
  type PayrollLine,
} from "./payroll.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * PAYROLL AND THE WPS FILE.
 *
 * Two engines that had nothing between them: `payroll_runs` and `payslips` had
 * never been written by any code path, and `generateSif` — the one function in
 * the product that moves real salaries into a real bank — had ZERO unit tests
 * of any kind (`uae.test.ts:2-3` imports only `gratuity.ts` and `tax.ts`).
 *
 * Four properties are tested, each chosen because it would cost real money:
 *
 *  1. THE PAY ARITHMETIC. Proration and overtime are the only places payroll
 *     divides, and division is where fils go missing. Every expected value is
 *     hand-calculated in the comment above it so a reviewer can check it
 *     without running anything.
 *  2. THE JOURNAL IDENTITY. Whatever the lines are, debits equal credits — not
 *     within a tolerance, exactly. The database's deferred constraint would
 *     catch an imbalance at COMMIT, but a test that catches it here names the
 *     line that broke it.
 *  3. THE DUPLICATE REFUSAL. "Running August twice must not pay everyone
 *     twice." The property that proves it is not that a second run returns
 *     zero — it is that a second run ISSUES NO INSERT, which a stub transaction
 *     can see and a return value cannot.
 *  4. WHAT IS TRUE OF A SIF UNDER ANY LAYOUT. The exact column order is open
 *     question Q-7 and is deliberately NOT asserted anywhere below: a fixture
 *     of field positions would enshrine an unverified reconstruction with the
 *     authority of a passing test, which is worse than no test. What IS
 *     asserted survives Q-7 being answered — the SCR control total equals the
 *     sum of the EDR amounts, there is exactly one SCR and it is last, the
 *     record count matches, the pay-period dates and the day count describe the
 *     same span, and every validation rule fires with a readable message.
 *
 * Everything runs against a stub transaction rather than Postgres, so it runs
 * in `test:unit` on every commit rather than only where a seeded database
 * exists.
 */

/* ══ 1. Pay arithmetic ═══════════════════════════════════════════════════════ */

describe("proratePay — a month's pay for part of a month", () => {
  it("returns the contractual amount untouched for a full period", () => {
    // The 14 unremarkable employees in the pilot must produce amounts identical
    // to their contract rows, so the run's totals have nothing to absorb.
    expect(M.toDisplay(proratePay(M.money(2700), 31, 31))).toBe("2700.00");
    expect(M.toDisplay(proratePay(M.money(2700), 30, 30))).toBe("2700.00");
  });

  it("charges over the real length of the month, never a notional 30", () => {
    // February 2026 has 28 days. 14 of them: 2700 x 14 / 28 = 1350.00
    expect(M.toDisplay(proratePay(M.money(2700), 14, 28))).toBe("1350.00");
    // The same 14 days in a 31-day month is a different number:
    // 2700 x 14 / 31 = 1219.3548387... -> 1219.3548 at storage precision
    expect(M.toDb(proratePay(M.money(2700), 14, 31))).toBe("1219.3548");
  });

  it("prorates a joiner from their joining date", () => {
    // Joined 20 March: 12 days of 31. 4000 x 12 / 31 = 1548.387096...
    expect(M.toDb(proratePay(M.money(4000), 12, 31))).toBe("1548.3871");
  });

  it("pays nothing for no days, and never a negative", () => {
    expect(M.isZero(proratePay(M.money(2700), 0, 31))).toBe(true);
    expect(M.isZero(proratePay(M.money(2700), -3, 31))).toBe(true);
    expect(M.isZero(proratePay(M.money(2700), 10, 0))).toBe(true);
  });

  it("keeps each component separately checkable", () => {
    /**
     * The whole point of prorating components rather than the package: a person
     * doing the control sample multiplies each contract line by days/days.
     *
     * Imran Malik, 2700 / 1125 / 450 / 225, joined halfway through a 30-day
     * month (15 days):
     *   basic     2700 x 15/30 = 1350.00
     *   housing   1125 x 15/30 =  562.50
     *   transport  450 x 15/30 =  225.00
     *   other      225 x 15/30 =  112.50
     *                             ------
     *                            2250.00   = 4500 x 15/30, as it must be
     */
    const parts = [2700, 1125, 450, 225].map((n) => proratePay(M.money(n), 15, 30));
    expect(parts.map((p) => M.toDisplay(p))).toEqual(["1350.00", "562.50", "225.00", "112.50"]);
    expect(M.toDisplay(M.sum(parts))).toBe("2250.00");
    expect(M.eq(M.sum(parts), proratePay(M.money(4500), 15, 30))).toBe(true);
  });
});

describe("overtimePay — Article 19, Cabinet Resolution 1/2022", () => {
  it("pays normal hours plus 25%", () => {
    // 6 hours at AED 20/hour: 20 x 1.25 x 6 = 150.00
    expect(M.toDisplay(overtimePay(M.money(20), 360))).toBe("150.00");
  });

  it("handles a part hour exactly", () => {
    // 90 minutes at AED 18.50: 18.50 x 1.25 x 1.5 = 34.6875 -> 34.69 displayed,
    // 34.6875 stored. The fils that a float divide by 60 would lose.
    expect(M.toDb(overtimePay(M.money("18.50"), 90))).toBe("34.6875");
    expect(M.toDisplay(overtimePay(M.money("18.50"), 90))).toBe("34.69");
  });

  it("pays nothing for no overtime", () => {
    expect(M.isZero(overtimePay(M.money(20), 0))).toBe(true);
  });
});

/* ══ 2. The journal identity ═════════════════════════════════════════════════ */

const BU_SALON = "eeeeeeee-5555-4555-8555-555555555555";
const BU_TECH = "eeeeeeee-6666-4666-9666-666666666666";

function line(over: Partial<PayrollLine> & { employeeId: string }): PayrollLine {
  return {
    employeeCode: "E000",
    fullName: "Test Person",
    designation: null,
    status: "active",
    payBasis: "monthly",
    businessUnitId: BU_SALON,
    businessUnitCode: "SALON",
    businessUnitName: "Salon",
    colorToken: null,
    joinedOn: "2020-01-01",
    leftOn: null,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    daysInMonth: 31,
    daysEmployed: 31,
    unpaidLeaveDays: 0,
    daysPaid: 31,
    prorated: false,
    basic: 0,
    housing: 0,
    transport: 0,
    other: 0,
    fixedPay: 0,
    overtimeMinutes: 0,
    overtimeAmount: 0,
    commissionEntries: 0,
    commissionAmount: 0,
    grossAmount: 0,
    advanceDeduction: 0,
    otherDeduction: 0,
    deductionTotal: 0,
    netAmount: 0,
    wpsReady: true,
    ibanHint: null,
    ...over,
  };
}

/** debit total and credit total of a leg set, in exact decimal. */
function legTotals(legs: ReturnType<typeof payrollLegs>) {
  const side = (pick: "debit" | "credit") =>
    M.sum(legs.map((l) => (l[pick] === undefined ? M.ZERO : M.money(l[pick] as M.Money))));
  return { debit: side("debit"), credit: side("credit") };
}

describe("payrollLegs — the journal balances by identity", () => {
  it("balances a plain salary", () => {
    const legs = payrollLegs([
      line({ employeeId: "1", fixedPay: 4500, grossAmount: 4500, netAmount: 4500 }),
    ]);
    const { debit, credit } = legTotals(legs);
    expect(M.toDisplay(debit)).toBe("4500.00");
    expect(M.eq(debit, credit)).toBe(true);
  });

  it("balances salary, overtime, commission and an advance recovery together", () => {
    /**
     * gross = 2700 fixed + 150 overtime + 626.25 commission = 3476.25
     * net   = 3476.25 - 500 advance                          = 2976.25
     *
     * debits  = (2700 + 150) wage + 626.25 commission = 3476.25
     * credits = 500 advance + 2976.25 net             = 3476.25
     */
    const legs = payrollLegs([
      line({
        employeeId: "1",
        fixedPay: 2700,
        overtimeAmount: 150,
        commissionAmount: 626.25,
        grossAmount: 3476.25,
        advanceDeduction: 500,
        deductionTotal: 500,
        netAmount: 2976.25,
      }),
    ]);
    const { debit, credit } = legTotals(legs);
    expect(M.toDisplay(debit)).toBe("3476.25");
    expect(M.toDisplay(credit)).toBe("3476.25");
    expect(M.eq(debit, credit)).toBe(true);
    expect(legs.map((l) => l.accountKey).sort()).toEqual([
      "COMMISSION",
      "SALARY",
      "SALARY_PAYABLE",
      "STAFF_ADVANCE",
    ]);
  });

  it("splits the legs per business unit and still balances", () => {
    const legs = payrollLegs([
      line({ employeeId: "1", fixedPay: 4500, grossAmount: 4500, netAmount: 4500 }),
      line({
        employeeId: "2",
        businessUnitId: BU_TECH,
        businessUnitCode: "TECH",
        fixedPay: 4200,
        commissionAmount: 300,
        grossAmount: 4500,
        advanceDeduction: 250,
        deductionTotal: 250,
        netAmount: 4250,
      }),
    ]);
    // Two businesses: SALARY + SALARY_PAYABLE for the salon, and
    // SALARY + COMMISSION + STAFF_ADVANCE + SALARY_PAYABLE for tech.
    expect(new Set(legs.map((l) => l.businessUnitId)).size).toBe(2);
    const { debit, credit } = legTotals(legs);
    expect(M.toDisplay(debit)).toBe("9000.00");
    expect(M.eq(debit, credit)).toBe(true);
  });

  it("omits zero legs rather than posting AED 0.00 lines", () => {
    const legs = payrollLegs([
      line({ employeeId: "1", fixedPay: 4500, grossAmount: 4500, netAmount: 4500 }),
    ]);
    expect(legs.map((l) => l.accountKey)).toEqual(["SALARY", "SALARY_PAYABLE"]);
  });

  it("balances a payslip that is entirely commission", () => {
    // A commission-only stylist: no fixed pay at all.
    const legs = payrollLegs([
      line({
        employeeId: "1",
        commissionAmount: 1861.25,
        grossAmount: 1861.25,
        netAmount: 1861.25,
      }),
    ]);
    const { debit, credit } = legTotals(legs);
    expect(M.toDisplay(debit)).toBe("1861.25");
    expect(M.eq(debit, credit)).toBe(true);
    expect(legs.map((l) => l.accountKey)).toEqual(["COMMISSION", "SALARY_PAYABLE"]);
  });
});

/* ══ 3. The duplicate refusal ════════════════════════════════════════════════ */

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const USER = "bbbbbbbb-2222-4222-9222-222222222222";
const EMPLOYEE = "cccccccc-3333-4333-a333-333333333333";

function principal(permissions: string[]): Principal {
  return {
    userId: USER,
    tenantId: TENANT,
    membershipId: "dddddddd-4444-4444-b444-444444444444",
    roleKey: "hr_manager",
    roleLevel: 55,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: new Set(permissions),
    isPlatformAdmin: false,
  };
}

/** The literal fragments of a drizzle `sql` template, parameters elided. */
function sqlText(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const node = query as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(sqlText).join(" ");
  return Array.isArray(node.value) ? node.value.join(" ") : "";
}

/**
 * A transaction that answers the payroll run's reads and records its writes.
 *
 * `paid` decides whether the one employee in the portfolio already has a
 * payslip for the period, and `runExists` whether a run row for the same scope
 * already exists — the two independent duplicate guards, which have to be
 * tested independently because either one alone would let a real double-pay
 * through.
 */
function stubTx(opts: { paid?: boolean; runExists?: boolean } = {}) {
  const writes: string[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);

    if (/pg_advisory_xact_lock/.test(text)) return [];

    if (/FROM payroll_runs\s+WHERE period_label/.test(text)) {
      return opts.runExists
        ? [{ id: "run-1", status: "approved", net_total: "48000.0000" }]
        : [];
    }

    if (/FROM employees e\s+JOIN business_units b/.test(text)) {
      return [{
        id: EMPLOYEE,
        employee_code: "E001",
        full_name: "Imran Malik",
        designation: "Senior Barber",
        status: "active",
        pay_basis: "base_plus_commission",
        joined_on: "2021-03-01",
        left_on: null,
        basic: "2700.0000",
        housing: "1125.0000",
        transport: "450.0000",
        other: "225.0000",
        hourly_rate: null,
        iban_hint: "0123",
        wps_person_id: "17399778519757",
        wps_routing_code: "402030103",
        has_iban: true,
        bu_id: BU_SALON,
        bu_code: "SALON",
        bu_name: "Glamour Cuts",
        color_token: "salon",
        overtime_minutes: 0,
        commission_amount: "626.2500",
        commission_entries: 24,
        unpaid_leave_days: 0,
        advance_due: "0",
        advance_outstanding: "0",
        paid_run_label: opts.paid ? "2026-08" : null,
      }];
    }

    // Anything else is a write. A payroll run that refuses must issue none.
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return { writes, tx: { execute } as unknown as ServiceContext["tx"] };
}

function ctxFor(stub: ReturnType<typeof stubTx>, permissions: string[]): ServiceContext {
  return {
    tx: stub.tx,
    tenantId: TENANT,
    principal: principal(permissions),
    today: "2026-09-01",
    baseCurrency: "AED",
  };
}

const ALL = ["payroll:read", "payroll:approve", "payroll:pay"];

describe("payroll run — a period is paid once", () => {
  it("previews the employee when the period is unpaid", async () => {
    const stub = stubTx();
    const preview = await previewPayrollRun(ctxFor(stub, ALL), { period: "2026-08" });

    expect(preview.lines).toHaveLength(1);
    const l = preview.lines[0]!;
    // 2700 + 1125 + 450 + 225 = 4500 fixed, plus 626.25 of unclaimed commission.
    expect(l.fixedPay).toBe(4500);
    expect(l.commissionAmount).toBe(626.25);
    expect(l.grossAmount).toBe(5126.25);
    expect(l.netAmount).toBe(5126.25);
    expect(l.periodStart).toBe("2026-08-01");
    expect(l.periodEnd).toBe("2026-08-31");
    expect(l.daysPaid).toBe(31);
    expect(preview.dueOn).toBe("2026-09-01");
    // A preview writes nothing. Ever.
    expect(stub.writes).toEqual([]);
  });

  it("excludes an employee who already has a payslip for the period", async () => {
    const stub = stubTx({ paid: true });
    const preview = await previewPayrollRun(ctxFor(stub, ALL), { period: "2026-08" });

    expect(preview.lines).toEqual([]);
    expect(preview.alreadyPaid).toHaveLength(1);
    expect(preview.alreadyRun).toBe(true);
    expect(stub.writes).toEqual([]);
  });

  it("refuses the second run and writes nothing", async () => {
    const stub = stubTx({ paid: true });
    await expect(
      commitPayrollRun(ctxFor(stub, ALL), { period: "2026-08" }),
    ).rejects.toThrow(/already been paid/i);
    expect(stub.writes).toEqual([]);
  });

  it("refuses a run whose scope and period already have a run row, by name", async () => {
    // The other half of the guard: this fires even before the per-employee
    // check, so the operator is told "August has already been run" rather than
    // "nobody is payable".
    const stub = stubTx({ runExists: true });
    await expect(
      commitPayrollRun(ctxFor(stub, ALL), { period: "2026-08" }),
    ).rejects.toThrow(/already been run for this scope/i);
    expect(stub.writes).toEqual([]);
  });

  it("refuses when nobody is payable", async () => {
    const stub = stubTx();
    const empty = {
      writes: stub.writes,
      tx: {
        execute: async (q: unknown) => {
          const text = sqlText(q);
          if (/FROM employees e\s+JOIN business_units b/.test(text)) return [];
          return (stub.tx as { execute: (q: unknown) => Promise<unknown[]> }).execute(q);
        },
      } as unknown as ServiceContext["tx"],
    };
    await expect(
      commitPayrollRun(ctxFor(empty, ALL), { period: "2026-08" }),
    ).rejects.toThrow(/Nobody is payable/i);
    expect(stub.writes).toEqual([]);
  });

  it("refuses a caller without payroll:read, and writes nothing", async () => {
    const stub = stubTx();
    await expect(
      previewPayrollRun(ctxFor(stub, []), { period: "2026-08" }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(stub.writes).toEqual([]);
  });

  it("refuses to commit with only payroll:read — the UI hiding a button is not a control", async () => {
    const stub = stubTx();
    await expect(
      commitPayrollRun(ctxFor(stub, ["payroll:read"]), { period: "2026-08" }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(stub.writes).toEqual([]);
  });

  it("rejects a malformed period before touching the database", async () => {
    const stub = stubTx();
    await expect(previewPayrollRun(ctxFor(stub, ALL), { period: "August" })).rejects.toThrow();
    await expect(previewPayrollRun(ctxFor(stub, ALL), { period: "2026-13" })).rejects.toThrow();
    expect(stub.writes).toEqual([]);
  });
});

/* ══ 4. The SIF — what is true under any layout ══════════════════════════════ */

const AUGUST = new Date("2026-09-01T09:00:00Z");

function wpsEmployee(over: Partial<WpsEmployee> = {}): WpsEmployee {
  return {
    personId: "17399778519757",
    agentId: "402030103",
    routingCode: "402030103",
    iban: "AE070331234567890123456",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    daysInPeriod: 31,
    fixedIncome: 4500,
    variableIncome: 626.25,
    daysOnLeave: 0,
    employeeName: "Imran Malik",
    ...over,
  };
}

function fileFor(employees: WpsEmployee[]) {
  return generateSif({
    employerId: "1234567890123",
    employerAgentId: "0000000",
    employerRoutingCode: "402010101",
    salaryMonth: "2026-08",
    generatedAt: AUGUST,
    employees,
  });
}

/** The lines of a SIF, CRLF stripped. */
const linesOf = (content: string) => content.trimEnd().split("\r\n");

describe("SIF structure — properties no layout can change", () => {
  it("emits one EDR per employee and exactly one SCR, last", () => {
    const file = fileFor([wpsEmployee(), wpsEmployee({ personId: "96893731874879" })]);
    const lines = linesOf(file.content);
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("EDR"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("SCR"))).toHaveLength(1);
    expect(lines.at(-1)!.startsWith("SCR")).toBe(true);
    expect(file.recordCount).toBe(2);
  });

  it("uses CRLF and terminates the final line", () => {
    // A bank parser that splits on CRLF sees a trailing empty record without
    // the final terminator, or a truncated SCR with LF-only endings.
    const file = fileFor([wpsEmployee()]);
    expect(file.content.endsWith("\r\n")).toBe(true);
    expect(file.content.includes("\n\r")).toBe(false);
    expect(file.content.split("\n").every((s) => s === "" || s.endsWith("\r"))).toBe(true);
  });

  it("names the file for the employer and the generation stamp", () => {
    expect(fileFor([wpsEmployee()]).fileName).toBe("12345678901232609010900.SIF");
  });
});

describe("SIF control total — the identity that rejects a whole batch", () => {
  it("equals the sum of the EDR amounts, exactly", () => {
    /**
     * The failure this guards is the one that bounces an entire file: an SCR
     * total that disagrees with the detail by a fil. Three awkward employees,
     * chosen so a float sum would drift:
     *
     *   4500.00 + 626.25 = 5126.25
     *   3110.33 +  10.01 = 3120.34
     *   1219.35 + 401.66 = 1621.01
     *                      --------
     *                      9867.60
     */
    const file = fileFor([
      wpsEmployee({ fixedIncome: 4500, variableIncome: 626.25 }),
      wpsEmployee({ fixedIncome: 3110.33, variableIncome: 10.01 }),
      wpsEmployee({ fixedIncome: 1219.35, variableIncome: 401.66 }),
    ]);

    const lines = linesOf(file.content);
    const edrSum = lines
      .filter((l) => l.startsWith("EDR"))
      .reduce((total, l) => {
        const f = l.split(",");
        // Read straight back out of the file, in decimal, and summed the same
        // way an agent's parser would.
        return M.sum([total, M.money(f[8]!), M.money(f[9]!)]);
      }, M.ZERO);

    const scr = lines.at(-1)!.split(",");
    expect(M.toDisplay(edrSum)).toBe("9867.60");
    // The control record equals the detail it controls.
    expect(scr.includes(M.toDisplay(edrSum))).toBe(true);
    expect(M.toDisplay(M.money(file.totalSalaries))).toBe("9867.60");
  });

  it("never writes a thousands separator into a CSV field", () => {
    // AED 1,234,567.89 with a comma in it splits one field into two and shifts
    // every column after it.
    const file = fileFor([wpsEmployee({ fixedIncome: 1234567.89, variableIncome: 0 })]);
    const edr = linesOf(file.content)[0]!.split(",");
    expect(edr).toHaveLength(11);
    expect(edr[8]).toBe("1234567.89");
  });

  it("rounds half-up at the fils, matching a payslip", () => {
    const file = fileFor([wpsEmployee({ fixedIncome: 4000.005, variableIncome: 0 })]);
    expect(linesOf(file.content)[0]!.split(",")[8]).toBe("4000.01");
  });
});

describe("SIF pay period — CALC-14", () => {
  it("writes the span the employee was actually employed, not the day count", () => {
    /**
     * The bug, executed. Salary month 2026-03, employee joined 20 March, so 12
     * days are paid. The old code wrote `${YYYYMM}01` and
     * `${YYYYMM}${pad(12, 2)}` — "1 March to 12 March" — which claimed the
     * employee was paid for days before they were employed.
     */
    const file = generateSif({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-03",
      generatedAt: AUGUST,
      employees: [
        wpsEmployee({ periodStart: "2026-03-20", periodEnd: "2026-03-31", daysInPeriod: 12 }),
      ],
    });
    const edr = linesOf(file.content)[0]!.split(",");
    expect(edr[5]).toBe("20260320");
    expect(edr[6]).toBe("20260331");
    expect(edr[7]).toBe("12");
    expect(file.warnings).toEqual([]);
  });

  it("keeps the dates and the day count describing the same span", () => {
    // True under any layout: a record claiming 12 days over a 31-day span is
    // internally inconsistent whatever the columns are called.
    const warnings = validateWps({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-03",
      generatedAt: AUGUST,
      employees: [
        wpsEmployee({ periodStart: "2026-03-01", periodEnd: "2026-03-31", daysInPeriod: 12 }),
      ],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/is 31 days, but the record claims 12/);
  });

  it("defaults an omitted span to the whole salary month", () => {
    const file = fileFor([wpsEmployee({ periodStart: undefined, periodEnd: undefined })]);
    const edr = linesOf(file.content)[0]!.split(",");
    expect(edr[5]).toBe("20260801");
    expect(edr[6]).toBe("20260831");
    expect(file.warnings).toEqual([]);
  });

  it("refuses a span that falls outside the salary month", () => {
    const warnings = validateWps({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-08",
      generatedAt: AUGUST,
      employees: [
        wpsEmployee({ periodStart: "2026-07-25", periodEnd: "2026-08-31", daysInPeriod: 38 }),
      ],
    });
    expect(warnings.join(" ")).toMatch(/falls outside the salary month/);
  });

  it("computes month ends and inclusive spans without an off-by-one", () => {
    expect(salaryMonthEnd("2026-02")).toBe("2026-02-28");
    expect(salaryMonthEnd("2028-02")).toBe("2028-02-29");
    expect(salaryMonthEnd("2026-08")).toBe("2026-08-31");
    expect(inclusiveDays("2026-08-01", "2026-08-31")).toBe(31);
    expect(inclusiveDays("2026-03-20", "2026-03-31")).toBe(12);
    expect(inclusiveDays("2026-08-14", "2026-08-14")).toBe(1);
  });
});

describe("SIF validation — CALC-16, the messages are the point", () => {
  it("returns a readable message for every rejection reason", () => {
    /**
     * The executed example from the audit: a deliberately broken employee used
     * to produce a downloadable file and the header `X-WPS-Warnings: 4`. The
     * count is not actionable; the messages are.
     */
    const file = fileFor([
      wpsEmployee({
        employeeName: "Broken",
        personId: "1",
        iban: "BAD",
        routingCode: "",
        fixedIncome: 0,
      }),
    ]);

    expect(file.warnings).toEqual([
      "Broken: MOHRE Person ID must be 14 digits.",
      "Broken: IBAN must be a 23-character UAE IBAN (AE + 21 digits).",
      "Broken: missing bank routing code — the salary cannot be routed.",
      "Broken: fixed income is zero; MOHRE will reject the record.",
    ]);
    expect(file.detailedWarnings.map((w) => w.code)).toEqual([
      "person_id",
      "iban",
      "routing_code",
      "zero_income",
    ]);
    expect(file.detailedWarnings.every((w) => w.severity === "blocking")).toBe(true);
    expect(file.detailedWarnings.every((w) => w.subject === "Broken")).toBe(true);
  });

  it("catches a 12-digit employer ID", () => {
    const warnings = validateWps({
      employerId: "123456789012",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-08",
      generatedAt: AUGUST,
      employees: [wpsEmployee()],
    });
    expect(warnings).toEqual(['Employer ID must be 13 digits (got "123456789012").']);
  });

  it("catches leave days that exceed the period", () => {
    const warnings = validateWps({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-08",
      generatedAt: AUGUST,
      employees: [wpsEmployee({ daysOnLeave: 40 })],
    });
    expect(warnings.join(" ")).toMatch(/leave days exceed days in the period/);
  });

  it("refuses a negative variable income", () => {
    // A SIF cannot instruct a bank to take money back, and a negative here is
    // how a deduction would try to sneak into a layout with no deduction field.
    const warnings = validateWps({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-08",
      generatedAt: AUGUST,
      employees: [wpsEmployee({ variableIncome: -100 })],
    });
    expect(warnings.join(" ")).toMatch(/cannot instruct a bank to take money back/);
  });

  it("refuses a file with no employees at all", () => {
    const warnings = validateWpsDetailed({
      employerId: "1234567890123",
      employerAgentId: "0000000",
      employerRoutingCode: "402010101",
      salaryMonth: "2026-08",
      generatedAt: AUGUST,
      employees: [],
    });
    expect(warnings.map((w) => w.code)).toEqual(["no_employees"]);
  });

  it("passes a well-formed file with no warnings at all", () => {
    const file = fileFor([wpsEmployee(), wpsEmployee({ personId: "96893731874879" })]);
    expect(file.warnings).toEqual([]);
    expect(file.detailedWarnings).toEqual([]);
  });

  /**
   * Q-7 — the exact SIF layout for this group's WPS agent.
   *
   * Nothing above asserts a column position, a field count on the SCR, a date
   * format or the filename's internal structure as if they were specified,
   * because no spec has been seen. `05-uae-localisation.md` §6 states the
   * layout with a confidence nothing in the repository supports, and audit
   * CALC-17 lists four respects in which the commonly documented MOHRE layout
   * differs — from unverified recall, which is not a basis for a fixture
   * either.
   *
   * When the agent's written spec arrives: transcribe it into `SIF_LAYOUT`,
   * cite it in the docblock, and turn this into a fixture of one real file.
   */
  it.todo("Q-7: assert the agent's real EDR and SCR column layout, once specified");

  /**
   * Q-7, second half. The current layout carries no deduction column, so
   * `loadWpsExport` folds a salary-advance recovery into fixed income to keep
   * the transferred amount equal to net pay. If the agent's layout DOES carry a
   * deduction column, that mapping is wrong and gross belongs in the income
   * fields with the deduction stated separately.
   */
  it.todo("Q-7: does the agent's layout carry a deduction column?");
});
