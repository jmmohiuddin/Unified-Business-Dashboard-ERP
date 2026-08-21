import { describe, expect, it } from "vitest";
import {
  loadGratuityRegister,
  rehireEmployee,
  resolveGratuityServiceStart,
  settleGratuity,
} from "./gratuity-payout.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import { calculateGratuity } from "../uae/gratuity.ts";
import * as M from "../money/index.ts";
import type { Principal } from "../rbac.ts";

/**
 * END-OF-SERVICE SETTLEMENT — the properties that make a payout safe to press.
 *
 * Against a stub transaction rather than Postgres, for the reason
 * `cash-sessions.test.ts` gives: what is under test is WHICH JOURNAL LEGS ARE
 * BUILT AND WITH WHAT AMOUNTS, which is decided entirely in TypeScript before a
 * connection is touched. That makes it cheap enough to run on every commit,
 * which is where an accounting rule needs watching.
 *
 * Three groups of tests matter more than the rest:
 *
 *  • THE POSTING SPLIT. A payout is mostly a balance-sheet movement. If the
 *    provision leg ever goes missing, the ledger charges the same money to
 *    profit twice and leaves a discharged liability standing — and every
 *    individual number on the screen still looks right.
 *
 *  • THE LEGAL NEUTRALITY. `settleGratuity` must not contain an answer to Q-2
 *    or Q-2b. The test for that asserts a PASS-THROUGH — that the amount is
 *    whatever `calculateGratuity` says for the reason given — and never that a
 *    particular reason yields a particular figure. Asserting the figure is how
 *    an unconfirmed reading of the labour law becomes a green test nobody
 *    revisits, which is exactly what `uae.test.ts` demoted to `it.todo`.
 *
 *  • EC-05. A day of service that has been paid for must never be paid for
 *    again. The fixture is worth AED 50,339.20 on one employee.
 *
 * Hand-calculated fixtures, all on a 10,000 basic (daily wage 10,000 x 12 / 365
 * = 328.767123287671...) and a 15,000 package:
 *
 *   2019-01-01 → 2024-01-01   5 years exactly   105 days      AED 34,520.5479
 *   2019-01-01 → 2026-08-21   7.635616 years    184.0685 days AED 60,515.6690
 *   2025-03-01 → 2026-08-21   1.473973 years     30.9534 days AED 10,176.4684
 *
 * Amounts are quantised to storage precision (4 dp), not to display precision:
 * 34,520.5479 is what lands in `numeric(18,4)`, and AED 34,520.55 is what the
 * register prints.
 */

/* ── Reading drizzle's `sql` template without a database ───────────────────── */

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
      const value = chunk && typeof chunk === "object" ? (chunk as { value?: unknown }).value : undefined;
      return Array.isArray(value) ? value.join(" ") : "";
    })
    .join(" ");
}

function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object") {
      out.push(chunk);
      continue;
    }
    if ("queryChunks" in chunk) {
      out.push(...sqlParams(chunk));
      continue;
    }
    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value)) continue; // StringChunk — literal SQL, not a parameter.
    out.push(value !== undefined ? value : chunk.valueOf());
  }
  return out;
}

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const TENANT = "11111111-1111-4111-8111-111111111111";
const HR_USER = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE = "33333333-3333-4333-8333-333333333333";
const BU = "44444444-4444-4444-8444-444444444444";
const SETTLEMENT = "55555555-5555-4555-8555-555555555555";
const JOURNAL = "66666666-6666-4666-8666-666666666666";
const ADVANCE_A = "77777777-7777-4777-8777-777777777777";
const ADVANCE_B = "88888888-8888-4888-8888-888888888888";

const ACCOUNT_IDS: Record<string, string> = {
  GRATUITY_PROVISION: "a0000000-0000-4000-8000-000000000001",
  GRATUITY_EXPENSE: "a0000000-0000-4000-8000-000000000002",
  SALARY: "a0000000-0000-4000-8000-000000000003",
  STAFF_ADVANCE: "a0000000-0000-4000-8000-000000000004",
  BANK: "a0000000-0000-4000-8000-000000000005",
  CASH: "a0000000-0000-4000-8000-000000000006",
  SALARY_PAYABLE: "a0000000-0000-4000-8000-000000000007",
};
const KEY_BY_ACCOUNT_ID = new Map(Object.entries(ACCOUNT_IDS).map(([k, v]) => [v, k]));

/** The valuation date every test runs at, unless it says otherwise. */
const TODAY = "2026-08-21";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: over.userId ?? HR_USER,
    tenantId: TENANT,
    membershipId: "99999999-9999-4999-8999-999999999999",
    roleKey: over.roleKey ?? "hr",
    roleLevel: over.roleLevel ?? 60,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: over.permissions ?? new Set(["payroll:pay", "payroll:read", "employee:update"]),
    isPlatformAdmin: false,
  };
}

interface EmployeeState {
  status?: string;
  joined_on?: string;
  service_restarted_on?: string | null;
  left_on?: string | null;
  basic?: string;
  housing?: string;
  transport?: string;
  other?: string;
  accrued?: string;
  settled_through?: string | null;
  settled_number?: string | null;
}

interface JournalLeg {
  accountKey: string;
  debit: string;
  credit: string;
}

function stubTx(
  opts: {
    employee?: EmployeeState;
    /** Rows `salary_advances` returns, oldest first. */
    advances?: { id: string; outstanding: string; issued_on: string }[];
    /** Simulate an idempotency key that has already produced a result. */
    priorResult?: unknown;
    employeeMissing?: boolean;
  } = {},
) {
  const statements: { text: string; params: unknown[] }[] = [];
  const legs: JournalLeg[] = [];

  const employeeRow = {
    id: EMPLOYEE,
    full_name: "Rashid Karim",
    status: opts.employee?.status ?? "active",
    joined_on: opts.employee?.joined_on ?? "2019-01-01",
    service_restarted_on: opts.employee?.service_restarted_on ?? null,
    left_on: opts.employee?.left_on ?? null,
    basic: opts.employee?.basic ?? "10000.0000",
    housing: opts.employee?.housing ?? "3000.0000",
    transport: opts.employee?.transport ?? "1500.0000",
    other: opts.employee?.other ?? "500.0000",
    accrued: opts.employee?.accrued ?? "0.0000",
    bu_id: BU,
    bu_code: "SALON",
    settled_through: opts.employee?.settled_through ?? null,
    settled_number: opts.employee?.settled_number ?? null,
  };

  const execute = async (query: unknown) => {
    const text = sqlText(query).replace(/\s+/g, " ").trim();
    const params = sqlParams(query);
    statements.push({ text, params });

    // Order matters: the register query also joins business_units.
    if (/MAX\(g\.service_period_end\)/i.test(text)) {
      return opts.employeeMissing ? [] : [{ ...employeeRow, employee_code: "EMP-004",
        designation: "Senior Barber", bu_name: "Royal Cuts", color_token: "amber",
        iban_enc: "enc", iban_hint: "••••4417", wps_person_id: "P1", wps_routing_code: "R1",
        settlement_count: opts.employee?.settled_through ? 1 : 0,
        settled_total: opts.employee?.settled_through ? "39398.1585" : "0",
        advance_outstanding: (opts.advances ?? []).reduce(
          (t, a) => M.toDb(M.add(M.money(t), M.fromDb(a.outstanding))), "0.0000",
        ) }];
    }
    if (/FOR UPDATE OF e/i.test(text) && /b\.code AS bu_code/i.test(text)) {
      return opts.employeeMissing ? [] : [employeeRow];
    }
    if (/FOR UPDATE OF e/i.test(text)) {
      return opts.employeeMissing ? [] : [employeeRow];
    }
    if (/FROM salary_advances/i.test(text) && /FOR UPDATE/i.test(text)) {
      return opts.advances ?? [];
    }
    if (/INSERT INTO idempotency_keys/i.test(text)) {
      return opts.priorResult === undefined ? [{ id: "idem" }] : [];
    }
    if (/FROM idempotency_keys/i.test(text)) {
      return [{ done: true, result: opts.priorResult }];
    }
    if (/UPDATE number_series/i.test(text)) return [{ next_value: 7 }];
    if (/FROM fiscal_periods/i.test(text)) return [];
    if (/SELECT system_key, id FROM accounts/i.test(text)) {
      return Object.entries(ACCOUNT_IDS).map(([system_key, id]) => ({ system_key, id }));
    }
    if (/INSERT INTO gratuity_settlements/i.test(text)) return [{ id: SETTLEMENT }];
    if (/INSERT INTO journals/i.test(text)) return [{ id: JOURNAL }];
    if (/INSERT INTO journal_lines/i.test(text)) {
      const accountId = params.find((p) => typeof p === "string" && KEY_BY_ACCOUNT_ID.has(p));
      const amounts = params.filter(
        (p): p is string => typeof p === "string" && /^-?\d+\.\d{4}$/.test(p),
      );
      legs.push({
        accountKey: KEY_BY_ACCOUNT_ID.get(String(accountId)) ?? "?",
        debit: amounts[0] ?? "?",
        credit: amounts[1] ?? "?",
      });
      return [];
    }
    return [];
  };

  return {
    statements,
    legs,
    tx: { execute } as unknown as ServiceContext["tx"],
    /** Statements that changed something. A refusal must produce none. */
    writes: () =>
      statements
        .filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.text))
        // The idempotency claim is written before the service body runs, by
        // design — it is the claim, not the effect.
        .filter((s) => !/idempotency_keys/i.test(s.text))
        .map((s) => s.text.slice(0, 55)),
    /** The parameters of the INSERT that recorded the settlement. */
    settlementInsert: () => statements.find((s) => /INSERT INTO gratuity_settlements/i.test(s.text)),
    employeeUpdate: () => statements.find((s) => /^UPDATE employees/i.test(s.text)),
    advanceUpdates: () => statements.filter((s) => /^UPDATE salary_advances/i.test(s.text)),
  };
}

function ctxFor(tx: ServiceContext["tx"], over: Partial<Principal> = {}): ServiceContext {
  return {
    tx,
    tenantId: TENANT,
    principal: principal(over),
    today: TODAY,
    baseCurrency: "AED",
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("Expected a ServiceError, but the call succeeded.");
}

/** Total debits and credits across the posted legs, in exact decimal. */
function totals(legs: JournalLeg[]): { debit: M.Money; credit: M.Money } {
  return {
    debit: M.sum(legs.map((l) => M.fromDb(l.debit))),
    credit: M.sum(legs.map((l) => M.fromDb(l.credit))),
  };
}

/** The one leg on `key` that carries an amount on `side`. */
const legFor = (legs: JournalLeg[], key: string, side: "debit" | "credit") =>
  legs.find((l) => l.accountKey === key && l[side] !== "0.0000");

const settle = {
  employeeId: EMPLOYEE,
  reason: "termination" as const,
  lastWorkingDay: "2024-01-01",
};

/* ── 1. The posting split ──────────────────────────────────────────────────── */

describe("posting rules", () => {
  /**
   * The whole reason this is not "DR expense, CR bank".
   *
   * The provision has been charged to profit month by month for five years. If
   * the payout does not debit it, the P&L takes the same AED 34,520 twice and
   * the balance sheet keeps carrying a liability that has been discharged. Both
   * halves are invisible on any single screen.
   */
  it("discharges the carried provision and charges only the shortfall to profit", async () => {
    const stub = stubTx({ employee: { accrued: "30000.0000" } });
    const result = await settleGratuity(ctxFor(stub.tx), settle);

    expect(result.gratuityAmount).toBe(34_520.5479);
    expect(result.provisionApplied).toBe(30_000);
    // 34,520.5479 − 30,000 = 4,520.5479 under-accrued.
    expect(result.expenseShortfall).toBe(4_520.5479);
    expect(result.provisionReleased).toBe(0);

    expect(legFor(stub.legs, "GRATUITY_PROVISION", "debit")?.debit).toBe("30000.0000");
    expect(legFor(stub.legs, "GRATUITY_EXPENSE", "debit")?.debit).toBe("4520.5479");
    expect(legFor(stub.legs, "BANK", "credit")?.credit).toBe("34520.5479");

    const { debit, credit } = totals(stub.legs);
    expect(M.toDb(debit)).toBe("34520.5479");
    expect(M.eq(debit, credit)).toBe(true);
  });

  it("releases an over-accrued provision back to profit rather than paying it out", async () => {
    const stub = stubTx({ employee: { accrued: "40000.0000" } });
    const result = await settleGratuity(ctxFor(stub.tx), settle);

    expect(result.provisionApplied).toBe(40_000);
    expect(result.expenseShortfall).toBe(0);
    // 40,000 − 34,520.5479 = 5,479.4521 over-accrued, credited back.
    expect(result.provisionReleased).toBe(5_479.4521);
    expect(result.netPayable).toBe(34_520.5479);

    expect(legFor(stub.legs, "GRATUITY_PROVISION", "debit")?.debit).toBe("40000.0000");
    expect(legFor(stub.legs, "GRATUITY_EXPENSE", "credit")?.credit).toBe("5479.4521");
    const { debit, credit } = totals(stub.legs);
    expect(M.eq(debit, credit)).toBe(true);
    expect(M.toDb(debit)).toBe("40000.0000");
  });

  it("touches profit at all only when the accrual was wrong", async () => {
    const stub = stubTx({ employee: { accrued: "34520.5479" } });
    const result = await settleGratuity(ctxFor(stub.tx), settle);

    expect(result.expenseShortfall).toBe(0);
    expect(result.provisionReleased).toBe(0);
    expect(stub.legs.filter((l) => l.accountKey === "GRATUITY_EXPENSE")).toHaveLength(0);
    expect(stub.legs.map((l) => l.accountKey).sort()).toEqual(["BANK", "GRATUITY_PROVISION"]);
  });

  it("balances a full final settlement: gratuity, other entitlements and an advance", async () => {
    const stub = stubTx({
      employee: { accrued: "30000.0000" },
      advances: [{ id: ADVANCE_A, outstanding: "2000.0000", issued_on: "2023-11-01" }],
    });
    const result = await settleGratuity(ctxFor(stub.tx), {
      ...settle,
      unpaidSalary: 5_000,
      leaveEncashment: 1_200,
      noticePay: 0,
    });

    // 34,520.5479 + 6,200 − 2,000 = 38,720.5479
    expect(result.otherEarnings).toBe(6_200);
    expect(result.advanceRecovered).toBe(2_000);
    expect(result.netPayable).toBe(38_720.5479);

    expect(legFor(stub.legs, "SALARY", "debit")?.debit).toBe("6200.0000");
    expect(legFor(stub.legs, "STAFF_ADVANCE", "credit")?.credit).toBe("2000.0000");
    expect(legFor(stub.legs, "BANK", "credit")?.credit).toBe("38720.5479");

    const { debit, credit } = totals(stub.legs);
    expect(M.eq(debit, credit)).toBe(true);
    expect(M.toDb(debit)).toBe("40720.5479"); // 30,000 + 4,520.5479 + 6,200
  });

  it("credits salary payable, not the bank, when the money moves later", async () => {
    const stub = stubTx({ employee: { accrued: "34520.5479" } });
    await settleGratuity(ctxFor(stub.tx), { ...settle, settledVia: "payable" });
    expect(legFor(stub.legs, "SALARY_PAYABLE", "credit")?.credit).toBe("34520.5479");
  });

  it("credits cash when the settlement is paid in cash", async () => {
    const stub = stubTx({ employee: { accrued: "34520.5479" } });
    await settleGratuity(ctxFor(stub.tx), { ...settle, settledVia: "cash" });
    expect(legFor(stub.legs, "CASH", "credit")?.credit).toBe("34520.5479");
  });

  it("posts nothing, and says so, when there is genuinely nothing to settle", async () => {
    // Under a year, no provision carried, nothing else owed.
    const stub = stubTx({ employee: { joined_on: "2025-09-01", accrued: "0.0000" } });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), { ...settle, lastWorkingDay: "2026-06-30" }),
    );
    expect(err.message).toMatch(/nothing to settle/);
    expect(err.message).toMatch(/No entitlement/);
    expect(stub.legs).toHaveLength(0);
  });
});

/* ── 2. The open legal questions stay open ─────────────────────────────────── */

describe("Q-2 and Q-2b are not answered here", () => {
  /**
   * The pass-through property, stated so it cannot be satisfied by a constant.
   *
   * For every reason the form offers, the amount settled is exactly what
   * `calculateGratuity` returns for that reason. No assertion is made about
   * WHAT the engine returns — that is the part nobody has confirmed. If Q-2 or
   * Q-2b is answered and the engine changes, this test still passes and the
   * settlement follows it, which is the whole design.
   */
  it("settles whatever the engine says for the reason given, and decides nothing itself", async () => {
    for (const reason of ["resignation", "termination", "gross_misconduct"] as const) {
      const stub = stubTx({ employee: { accrued: "50000.0000" } });
      const result = await settleGratuity(ctxFor(stub.tx), {
        ...settle,
        reason,
        acknowledgeForfeitureAssumption: reason === "gross_misconduct",
      });
      const engine = calculateGratuity({
        basicSalary: 10_000,
        totalSalary: 15_000,
        joinedOn: "2019-01-01",
        asOf: "2024-01-01",
        reason,
      });
      expect(result.gratuityAmount).toBe(engine.amount);
      expect(result.explanation).toBe(engine.explanation);
    }
  });

  it("refuses a gross-misconduct settlement until someone acknowledges the assumption", async () => {
    const stub = stubTx({ employee: { accrued: "50000.0000" } });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), { ...settle, reason: "gross_misconduct" }),
    );
    expect(err.message).toMatch(/Q-2b/);
    expect(err.message).toMatch(/ASSUMPTION, not settled law/);
    expect(stub.writes()).toEqual([]);
  });

  /**
   * The acknowledgement is not theatre — it is recorded.
   *
   * If the forfeiture turns out not to have survived Federal Decree-Law
   * 33/2021, this column is how the settlements that have to be revisited are
   * found. Without it a forfeited zero is indistinguishable from an employee
   * who was simply under a year.
   */
  it("marks an acknowledged forfeiture on the settlement row", async () => {
    const stub = stubTx({ employee: { accrued: "50000.0000" } });
    const result = await settleGratuity(ctxFor(stub.tx), {
      ...settle,
      reason: "gross_misconduct",
      acknowledgeForfeitureAssumption: true,
    });
    expect(result.forfeitureAssumed).toBe(true);
    expect(stub.settlementInsert()?.params).toContain(true);
    // The provision still has to come off the balance sheet: the employee has
    // gone, so nothing remains to carry, and it is released to profit rather
    // than paid out.
    expect(legFor(stub.legs, "GRATUITY_PROVISION", "debit")?.debit).toBe("50000.0000");
    expect(legFor(stub.legs, "GRATUITY_EXPENSE", "credit")?.credit).toBe("50000.0000");
    expect(result.netPayable).toBe(0);
    expect(stub.legs.some((l) => l.accountKey === "BANK")).toBe(false);
  });

  // Q-2 — the same block `uae.test.ts` carries, restated at the payout because
  // this is where the money actually leaves.
  it.todo(
    "resignation settles for less than termination: BLOCKED on Q-2. The 2021 law is " +
      "understood to have removed the 1/3 and 2/3 reductions, but no adviser has " +
      "confirmed it. The service passes `reason` to the engine and asserts nothing " +
      "about the result, precisely so this stays unanswered.",
  );

  // Q-2b — blocked on the same adviser.
  it.todo(
    "a gross-misconduct settlement pays AED 0: BLOCKED on Q-2b. The engine forfeits, " +
      "which was the rule under Art. 120/139 of the superseded Federal Law 8/1980. " +
      "Worth AED 83,835.62 on a ten-year employee at a 10,000 basic. The payout " +
      "refuses without an explicit acknowledgement rather than asserting either answer.",
  );
});

/* ── 3. EC-05: no day of service is paid for twice ─────────────────────────── */

describe("resolveGratuityServiceStart (EC-05)", () => {
  it("is the joining date for someone who has never been settled", () => {
    expect(resolveGratuityServiceStart({ joinedOn: "2019-01-01" })).toBe("2019-01-01");
  });

  it("is the rehire date after a settlement, not the joining date", () => {
    expect(
      resolveGratuityServiceStart({
        joinedOn: "2019-01-01",
        serviceRestartedOn: "2025-03-01",
        lastSettledThrough: "2024-06-30",
      }),
    ).toBe("2025-03-01");
  });

  /**
   * The floor that survives a mistake.
   *
   * If nobody records the rehire, the settled period still bounds the clock, so
   * the worst a missing restart date can do is start accruing from the day
   * after the payout — never from the original joining date, which would pay
   * for the settled years a second time.
   */
  it("falls back to the day after the settled period when no rehire was recorded", () => {
    expect(
      resolveGratuityServiceStart({ joinedOn: "2019-01-01", lastSettledThrough: "2024-06-30" }),
    ).toBe("2024-07-01");
  });

  it("never returns a date inside a period that has already been paid for", () => {
    expect(
      resolveGratuityServiceStart({
        joinedOn: "2019-01-01",
        serviceRestartedOn: "2020-01-01", // wrong, and inside the settled period
        lastSettledThrough: "2024-06-30",
      }),
    ).toBe("2024-07-01");
  });
});

describe("rehire after a payout", () => {
  /**
   * The fixture, worth AED 50,339.20.
   *
   * Rashid joined 2019-01-01, was settled through 2024-06-30 and paid, and came
   * back on 2025-03-01. Valued at 2026-08-21:
   *
   *   from the original joining date  7.635616 yr  184.0685 days  AED 60,515.6690
   *   from the rehire date            1.473973 yr   30.9534 days  AED 10,176.4684
   *
   * The first figure is what the register showed before this change, for an
   * employee whose first five and a half years had already been bought.
   */
  it("restarts the clock at the rehire date instead of double-counting the settled years", async () => {
    const stub = stubTx({
      employee: {
        status: "resigned",
        joined_on: "2019-01-01",
        left_on: "2024-06-30",
        settled_through: "2024-06-30",
        settled_number: "EOS-SALON-00007",
      },
    });
    const result = await rehireEmployee(ctxFor(stub.tx), {
      employeeId: EMPLOYEE,
      rehiredOn: "2025-03-01",
    });

    expect(result.joinedOn).toBe("2019-01-01"); // untouched — it is evidence
    expect(result.serviceStart).toBe("2025-03-01");
    expect(result.previousSettlement).toBe("EOS-SALON-00007");

    const restarted = calculateGratuity({
      basicSalary: 10_000, totalSalary: 15_000,
      joinedOn: result.serviceStart, asOf: TODAY,
    });
    const doubleCounted = calculateGratuity({
      basicSalary: 10_000, totalSalary: 15_000,
      joinedOn: result.joinedOn, asOf: TODAY,
    });
    expect(restarted.amount).toBe(10_176.4684);
    expect(doubleCounted.amount).toBe(60_515.669);
    expect(M.toDb(M.sub(M.money(doubleCounted.amount), M.money(restarted.amount)))).toBe(
      "50339.2006",
    );
  });

  it("does not move the joining date, and starts the new clock at zero liability", async () => {
    const stub = stubTx({
      employee: {
        status: "terminated", joined_on: "2019-01-01", left_on: "2024-06-30",
        settled_through: "2024-06-30", settled_number: "EOS-SALON-00007",
        accrued: "39398.1585",
      },
    });
    await rehireEmployee(ctxFor(stub.tx), { employeeId: EMPLOYEE, rehiredOn: "2025-03-01" });

    const update = stub.employeeUpdate()!;
    expect(update.text).toMatch(/service_restarted_on = /);
    expect(update.text).toMatch(/gratuity_accrued = '0'/);
    expect(update.text).not.toMatch(/joined_on/);
    expect(update.params).toContain("2025-03-01");
  });

  it("refuses a rehire date inside a period that was already settled and paid", async () => {
    const stub = stubTx({
      employee: {
        status: "resigned", left_on: "2024-06-30",
        settled_through: "2024-06-30", settled_number: "EOS-SALON-00007",
      },
    });
    const err = await refusal(() =>
      rehireEmployee(ctxFor(stub.tx), { employeeId: EMPLOYEE, rehiredOn: "2024-05-01" }),
    );
    expect(err.message).toMatch(/EOS-SALON-00007/);
    expect(err.message).toMatch(/2024-07-01 or later/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses to rehire someone who has not left", async () => {
    const stub = stubTx({ employee: { status: "active" } });
    const err = await refusal(() =>
      rehireEmployee(ctxFor(stub.tx), { employeeId: EMPLOYEE, rehiredOn: "2025-03-01" }),
    );
    expect(err.code).toBe("conflict");
    expect(stub.writes()).toEqual([]);
  });

  it("refuses a future rehire date", async () => {
    const stub = stubTx({ employee: { status: "resigned", left_on: "2024-06-30" } });
    const err = await refusal(() =>
      rehireEmployee(ctxFor(stub.tx), { employeeId: EMPLOYEE, rehiredOn: "2026-12-01" }),
    );
    expect(err.message).toMatch(/in the future/);
    expect(stub.writes()).toEqual([]);
  });

  it("posts no journal — rehiring costs nothing", async () => {
    const stub = stubTx({
      employee: { status: "resigned", left_on: "2024-06-30", settled_through: "2024-06-30" },
    });
    await rehireEmployee(ctxFor(stub.tx), { employeeId: EMPLOYEE, rehiredOn: "2025-03-01" });
    expect(stub.legs).toHaveLength(0);
    expect(stub.writes().some((w) => /INSERT INTO journals/i.test(w))).toBe(false);
  });
});

describe("settling a rehired employee", () => {
  /**
   * The second settlement pays for the second period only. Without the derived
   * clock it would pay for 2019 onwards again, on top of the AED 39,398 already
   * paid in 2024.
   */
  it("values the second period from the rehire date", async () => {
    const stub = stubTx({
      employee: {
        joined_on: "2019-01-01",
        service_restarted_on: "2025-03-01",
        settled_through: "2024-06-30",
        settled_number: "EOS-SALON-00007",
        accrued: "0.0000",
      },
    });
    const result = await settleGratuity(ctxFor(stub.tx), {
      employeeId: EMPLOYEE,
      reason: "resignation",
      lastWorkingDay: TODAY,
    });
    expect(result.serviceStart).toBe("2025-03-01");
    expect(result.gratuityAmount).toBe(10_176.4684);
    // The whole entitlement is a shortfall here because nothing was accrued for
    // the new period — which is the honest answer, not a hidden one.
    expect(result.expenseShortfall).toBe(10_176.4684);
    expect(legFor(stub.legs, "GRATUITY_EXPENSE", "debit")?.debit).toBe("10176.4684");
  });

  it("refuses a last working day inside an already-settled period", async () => {
    const stub = stubTx({
      employee: {
        joined_on: "2019-01-01",
        settled_through: "2024-06-30",
        settled_number: "EOS-SALON-00007",
        accrued: "1000.0000",
      },
    });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), {
        employeeId: EMPLOYEE, reason: "termination", lastWorkingDay: "2024-03-01",
      }),
    );
    expect(err.message).toMatch(/already been paid/);
    expect(err.message).toMatch(/EOS-SALON-00007/);
    expect(stub.writes()).toEqual([]);
  });
});

/* ── 4. Guards ─────────────────────────────────────────────────────────────── */

describe("guards", () => {
  it("refuses without payroll:pay, and writes nothing", async () => {
    const stub = stubTx({ employee: { accrued: "30000.0000" } });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx, { permissions: new Set(["payroll:read"]) }), settle),
    );
    expect(err.code).toBe("forbidden");
    // Not even the employee row was read: the permission gate is above it.
    expect(stub.statements).toHaveLength(0);
  });

  it("refuses to settle a last working day in the future", async () => {
    const stub = stubTx({ employee: { accrued: "30000.0000" } });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), { ...settle, lastWorkingDay: "2026-12-31" }),
    );
    expect(err.message).toMatch(/in the future/);
    expect(stub.writes()).toEqual([]);
  });

  /**
   * Over-recovery is refused exactly, never clamped — the rule payments and
   * purchasing already enforce. `GREATEST(0, …)` here would write off the
   * difference silently.
   */
  it("refuses to recover more advance than is outstanding", async () => {
    const stub = stubTx({
      employee: { accrued: "30000.0000" },
      advances: [{ id: ADVANCE_A, outstanding: "2000.0000", issued_on: "2023-11-01" }],
    });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), { ...settle, advanceRecovery: 2_500 }),
    );
    expect(err.message).toMatch(/only 2,?000\.00 is outstanding/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses a settlement that would leave the employee owing money", async () => {
    const stub = stubTx({
      // Under a year: no entitlement, but a provision was carried and an
      // advance is outstanding for more than the settlement is worth.
      employee: { joined_on: "2026-01-01", accrued: "500.0000" },
      advances: [{ id: ADVANCE_A, outstanding: "9000.0000", issued_on: "2026-02-01" }],
    });
    const err = await refusal(() =>
      settleGratuity(ctxFor(stub.tx), { ...settle, lastWorkingDay: "2026-08-01" }),
    );
    expect(err.message).toMatch(/cannot pay a negative amount/);
    expect(stub.writes()).toEqual([]);
  });

  it("clears advances oldest first, exactly", async () => {
    const stub = stubTx({
      employee: { accrued: "34520.5479" },
      advances: [
        { id: ADVANCE_A, outstanding: "1500.0000", issued_on: "2023-01-15" },
        { id: ADVANCE_B, outstanding: "2500.0000", issued_on: "2023-09-01" },
      ],
    });
    const result = await settleGratuity(ctxFor(stub.tx), { ...settle, advanceRecovery: 2_000 });
    expect(result.advanceRecovered).toBe(2_000);

    const updates = stub.advanceUpdates();
    expect(updates).toHaveLength(2);
    // The older advance is cleared in full, the newer takes the remaining 500.
    expect(updates[0]!.params).toContain("0.0000");
    expect(updates[0]!.params).toContain(ADVANCE_A);
    expect(updates[1]!.params).toContain("2000.0000");
    expect(updates[1]!.params).toContain(ADVANCE_B);
  });

  it("closes the employment and zeroes the rollup column the payout discharged", async () => {
    const stub = stubTx({ employee: { accrued: "30000.0000" } });
    await settleGratuity(ctxFor(stub.tx), { ...settle, reason: "resignation" });
    const update = stub.employeeUpdate()!;
    expect(update.text).toMatch(/gratuity_accrued = '0'/);
    expect(update.params).toContain("resigned");
    expect(update.params).toContain("2024-01-01"); // left_on = last working day
    expect(update.text).not.toMatch(/joined_on/);
  });

  it("replays a repeated submission instead of paying twice", async () => {
    const prior = { settlementNumber: "EOS-SALON-00007", netPayable: 34_520.5479 };
    const stub = stubTx({ employee: { accrued: "30000.0000" }, priorResult: prior });
    const result = await settleGratuity(ctxFor(stub.tx), {
      ...settle,
      idempotencyKey: "0123456789abcdef",
    });
    expect(result).toEqual(prior);
    expect(stub.legs).toHaveLength(0);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses an employee that does not exist", async () => {
    const stub = stubTx({ employeeMissing: true });
    const err = await refusal(() => settleGratuity(ctxFor(stub.tx), settle));
    expect(err.code).toBe("not_found");
    expect(stub.writes()).toEqual([]);
  });
});

/* ── 5. The register ───────────────────────────────────────────────────────── */

describe("the register", () => {
  it("values a rehired employee from the restarted clock, and shows both dates", async () => {
    const stub = stubTx({
      employee: {
        joined_on: "2019-01-01",
        service_restarted_on: "2025-03-01",
        settled_through: "2024-06-30",
      },
    });
    const [row] = await loadGratuityRegister(stub.tx, { asOf: TODAY });
    expect(row!.joinedOn).toBe("2019-01-01");
    expect(row!.serviceStart).toBe("2025-03-01");
    expect(row!.settledThrough).toBe("2024-06-30");
    expect(row!.gratuity.amount).toBe(10_176.4684);
    // The package is 10,000 + 3,000 + 1,500 + 500; gratuity uses the basic only.
    expect(row!.totalSalary).toBe(15_000);
    expect(row!.basicSalary).toBe(10_000);
  });

  it("leaves leavers out unless they are asked for", async () => {
    const stub = stubTx();
    await loadGratuityRegister(stub.tx, { asOf: TODAY });
    expect(stub.statements[0]!.text).not.toMatch(/'terminated'/);
    const stub2 = stubTx();
    await loadGratuityRegister(stub2.tx, { asOf: TODAY, includeLeavers: true });
    expect(stub2.statements[0]!.text).toMatch(/'terminated'/);
  });
});
