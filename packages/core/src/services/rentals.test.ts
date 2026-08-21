import { describe, expect, it } from "vitest";
import * as M from "../money/index.ts";
import { prorate, taxSplitForRent, previewRentRun, commitRentRun } from "./rentals.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * RENT RUN AND LEASE ARITHMETIC.
 *
 * Three properties are tested here, and each of them is a thing that would cost
 * real money to get wrong in the pilot business:
 *
 *  1. THE VAT SPLIT. PRD FR-R01's last acceptance criterion asks in so many
 *     words for a regression test that residential and parking leases, which
 *     share one model, carry distinct treatment. It is the highest-risk
 *     calculation in the portfolio: charging 5% on exempt residential rent is
 *     an FTA problem, and not charging it on a standard-rated bay is a
 *     different FTA problem.
 *  2. THE PRORATION RULE. Divisions are where fils go missing, and a
 *     part-month is the only place the rent run divides at all.
 *  3. THE DUPLICATE REFUSAL. "Re-running the same month is idempotent and
 *     creates nothing" is FR-R02's third acceptance criterion. The property
 *     that proves it is not that a second run returns zero — it is that a
 *     second run ISSUES NO INSERT, which a stub transaction can see and a
 *     return value cannot.
 *
 * Everything runs against a stub transaction rather than Postgres, so it runs
 * in `test:unit` on every commit rather than only where a seeded database
 * exists. The end-to-end behaviour against the real schema is covered by the
 * write-layer harness.
 */

// ── Money arithmetic ────────────────────────────────────────────────────────

describe("taxSplitForRent — residential and parking share a model, not a rate", () => {
  const EXEMPT = M.money(0);
  const VAT5 = M.money("0.05");

  it("charges no VAT on residential rent", () => {
    const split = taxSplitForRent(M.money(5083), EXEMPT, false);
    expect(M.toDisplay(split.net)).toBe("5083.00");
    expect(M.toDisplay(split.vat)).toBe("0.00");
    expect(M.toDisplay(split.gross)).toBe("5083.00");
    // The tenant is billed the contract rent and nothing else.
    expect(M.toDisplay(split.linePrice)).toBe("5083.00");
  });

  it("charges 5% on a standard-rated bay, on top of the contractual rent", () => {
    const split = taxSplitForRent(M.money(639), VAT5, true);
    // The lease says 639. That is the revenue, not 639 with the VAT dug out of
    // it — the failure this test exists to catch would recognise 608.57 and
    // hand the landlord 4.76% less than the contract on every bay, every month.
    expect(M.toDisplay(split.net)).toBe("639.00");
    expect(M.toDisplay(split.vat)).toBe("31.95");
    expect(M.toDisplay(split.gross)).toBe("670.95");
  });

  it("handles an exclusive standard rate identically at the totals", () => {
    const inclusive = taxSplitForRent(M.money(639), VAT5, true);
    const exclusive = taxSplitForRent(M.money(639), VAT5, false);
    expect(M.toDisplay(exclusive.net)).toBe(M.toDisplay(inclusive.net));
    expect(M.toDisplay(exclusive.vat)).toBe(M.toDisplay(inclusive.vat));
    expect(M.toDisplay(exclusive.gross)).toBe(M.toDisplay(inclusive.gross));
  });

  it("keeps net + VAT exactly equal to gross at every rent in the portfolio", () => {
    // 1/1.05 does not terminate in binary or in decimal. Taking the tax as the
    // REMAINDER rather than as its own rounded product is what makes the
    // printed invoice add up; this asserts it over the real rent range.
    for (let rent = 400; rent <= 12_000; rent += 7) {
      const split = taxSplitForRent(M.money(rent), VAT5, true);
      expect(M.eq(M.add(split.net, split.vat), split.gross)).toBe(true);
      expect(M.toDisplay(split.net)).toBe(rent.toFixed(2));
    }
  });

  it("zero-rated is not exempt at the totals, and both charge nothing", () => {
    const zero = taxSplitForRent(M.money(1000), M.money(0), false);
    expect(M.toDisplay(zero.vat)).toBe("0.00");
    expect(M.toDisplay(zero.gross)).toBe("1000.00");
  });
});

describe("prorate — the rule stated once, applied everywhere", () => {
  it("returns the contract rent untouched for a whole period", () => {
    expect(M.toDisplay(prorate(M.money(5083), 31, 31))).toBe("5083.00");
    expect(M.toDisplay(prorate(M.money(5083), 28, 28))).toBe("5083.00");
  });

  it("apportions on the ACTUAL length of the period, not a notional 30 days", () => {
    // Ten days of February is a bigger share of the month than ten days of
    // March. A 30-day convention would bill both the same and over-charge
    // February by 7%.
    const feb = prorate(M.money(3000), 10, 28);
    const mar = prorate(M.money(3000), 10, 31);
    expect(M.toDisplay(feb)).toBe("1071.43");
    expect(M.toDisplay(mar)).toBe("967.74");
    expect(M.gt(feb, mar)).toBe(true);
  });

  it("never bills for days outside the term", () => {
    expect(M.toDisplay(prorate(M.money(5000), 0, 30))).toBe("0.00");
    expect(M.toDisplay(prorate(M.money(5000), -3, 30))).toBe("0.00");
  });

  it("caps at the full rent when the day count overruns the period", () => {
    expect(M.toDisplay(prorate(M.money(5000), 45, 30))).toBe("5000.00");
  });

  it("is exact at storage precision, with no accumulated drift", () => {
    // Every day of a 31-day month, summed, must return the month's rent to
    // within the rounding of a single day — not drift a fils per day.
    const rent = M.money(5083);
    let sum = M.ZERO;
    for (let d = 0; d < 31; d++) sum = M.add(sum, prorate(rent, 1, 31));
    // 31 × round(5083/31) can differ from 5083 by at most 31 × 0.00005.
    expect(M.lte(M.abs(M.sub(sum, rent)), M.money("0.0016"))).toBe(true);
  });
});

// ── The duplicate refusal ───────────────────────────────────────────────────

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const USER = "bbbbbbbb-2222-4222-9222-222222222222";
const LEASE = "cccccccc-3333-4333-a333-333333333333";

function principal(permissions: string[]): Principal {
  return {
    userId: USER,
    tenantId: TENANT,
    membershipId: "dddddddd-4444-4444-b444-444444444444",
    roleKey: "property_manager",
    roleLevel: 55,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: new Set(permissions),
    isPlatformAdmin: false,
  };
}

/**
 * The literal fragments of a drizzle `sql` template, parameters elided.
 *
 * Recursive, unlike the copy in `users.test.ts`, because these queries are
 * COMPOSED: the shared `LEASE_SELECT` fragment is embedded in the outer
 * template as a nested query object, and a flat scan sees an empty string where
 * the whole SELECT should be — which makes every stub answer "no rows" and
 * every assertion fail for a reason that has nothing to do with the code.
 */
function sqlText(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const node = query as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(sqlText).join(" ");
  return Array.isArray(node.value) ? node.value.join(" ") : "";
}

/**
 * A transaction that answers the rent run's reads and records its writes.
 *
 * `billed` decides whether the one lease in the portfolio already has a rent
 * line for the period — which is the only difference between the two cases
 * this section tests.
 */
function stubTx(opts: { billed: boolean }) {
  const writes: string[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);

    if (/pg_advisory_xact_lock/.test(text)) return [];

    if (/FROM leases l/.test(text)) {
      return [{
        id: LEASE,
        lease_number: "LSE-PROP-0001",
        business_unit_id: "eeeeeeee-5555-4555-8555-555555555555",
        bu_code: "PROP",
        bu_name: "Al Waseem Residence",
        unit_id: "ffffffff-6666-4666-9666-666666666666",
        unit_code: "10A",
        unit_kind: "apartment",
        party_id: "99999999-7777-4777-a777-777777777777",
        party_name: "Al Fahim",
        status: "active",
        starts_on: "2026-01-01",
        ends_on: "2027-12-31",
        notice_period_days: 90,
        rent_amount: "5083.0000",
        annual_rent: "60996.0000",
        billing_day: 1,
        grace_days: 5,
        frequency: "monthly",
        collection_method: "bank_transfer",
        cheque_count: null,
        ejari_number: "EJ-1",
        escalation_rate: "0.000000",
        deposit_amount: "5083.0000",
        deposit_held: "5083.0000",
        charge_id: "11111111-8888-4888-b888-888888888888",
        charge_amount: "5083.0000",
        charge_label: "Residential Rent",
        item_id: "22222222-9999-4999-8999-999999999999",
        item_name: "Residential Rent",
        tax_code_id: "33333333-aaaa-4aaa-9aaa-aaaaaaaaaaaa",
        tax_code: "EXEMPT",
        tax_rate: "0.000000",
        tax_treatment: "exempt",
        tax_inclusive: false,
      }];
    }

    if (/FROM document_lines dl/.test(text) && /doc_number/.test(text)) {
      return opts.billed ? [{ doc_number: "INV-PROP-00007" }] : [];
    }

    // Anything else is a write. A rent run that refuses must issue none.
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
    today: "2026-09-20",
    baseCurrency: "AED",
  };
}

describe("rent run — a period is billed once", () => {
  const ALL = ["document:read", "document:create"];

  it("previews the lease when the period is unbilled", async () => {
    const stub = stubTx({ billed: false });
    const preview = await previewRentRun(ctxFor(stub, ALL), { period: "2026-09" });

    expect(preview.totals.invoices).toBe(1);
    expect(preview.alreadyRun).toBe(false);
    expect(preview.byTreatment).toHaveLength(1);
    expect(preview.byTreatment[0]!.treatment).toBe("exempt");
    expect(preview.byTreatment[0]!.vat).toBe(0);
    expect(preview.totals.gross).toBe(5083);
    // Reading is not writing.
    expect(stub.writes).toEqual([]);
  });

  it("reports the period as already run when the rent line exists", async () => {
    const stub = stubTx({ billed: true });
    const preview = await previewRentRun(ctxFor(stub, ALL), { period: "2026-09" });

    expect(preview.totals.invoices).toBe(0);
    expect(preview.alreadyRun).toBe(true);
    expect(preview.alreadyBilled).toEqual([
      { leaseNumber: "LSE-PROP-0001", unitCode: "10A", docNumbers: ["INV-PROP-00007"] },
    ]);
  });

  it("REFUSES the second commit, and writes nothing before refusing", async () => {
    const stub = stubTx({ billed: true });
    await expect(
      commitRentRun(ctxFor(stub, ALL), { period: "2026-09" }),
    ).rejects.toMatchObject({ code: "duplicate" });

    // The whole point. A guard that throws after the INSERT is not a guard,
    // and a rent run that returns "0 created" having created 34 is a disaster
    // that reports itself as a success.
    expect(stub.writes).toEqual([]);
  });

  it("refuses a run with nothing due as invalid, not as a duplicate", async () => {
    const stub = stubTx({ billed: false });
    // 2020 predates the lease, so no period falls due.
    await expect(
      commitRentRun(ctxFor(stub, ALL), { period: "2020-01" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(stub.writes).toEqual([]);
  });

  it("refuses the preview without document:read, before reading anything", async () => {
    const stub = stubTx({ billed: false });
    await expect(
      previewRentRun(ctxFor(stub, []), { period: "2026-09" }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(stub.writes).toEqual([]);
  });

  it("refuses the commit to a principal who may preview but not create", async () => {
    const stub = stubTx({ billed: false });
    await expect(
      commitRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(stub.writes).toEqual([]);
  });

  it("rejects a malformed period rather than guessing at one", async () => {
    const stub = stubTx({ billed: false });
    await expect(
      previewRentRun(ctxFor(stub, ALL), { period: "September" }),
    ).rejects.toThrow();
    await expect(
      previewRentRun(ctxFor(stub, ALL), { period: "2026-13" }),
    ).rejects.toThrow();
  });
});

describe("rent run — treatment is read from the lease, never assumed", () => {
  /**
   * Q-1 IS OPEN. Whether a standalone parking bay is standard-rated, and
   * whether the group should apply for floorspace apportionment, is a question
   * for the tax adviser. What is testable today is that the answer is DATA: the
   * same code produces an exempt line or a 5% line depending on nothing but the
   * tax code hanging off the lease's charge item. When the adviser answers,
   * changing the answer must not require changing this file.
   */
  function parkingStub(tax: { code: string; rate: string; treatment: string; inclusive: boolean }) {
    const stub = stubTx({ billed: false });
    const inner = stub.tx.execute.bind(stub.tx) as (q: unknown) => Promise<unknown[]>;
    const tx = {
      execute: async (q: unknown) => {
        const rows = (await inner(q)) as Record<string, unknown>[];
        if (rows[0] && "lease_number" in rows[0]) {
          return [{
            ...rows[0],
            lease_number: "LSE-PARK-0022",
            unit_code: "P-09",
            unit_kind: "parking_bay",
            rent_amount: "639.0000",
            charge_amount: "639.0000",
            item_name: "Monthly Parking Bay",
            tax_code: tax.code,
            tax_rate: tax.rate,
            tax_treatment: tax.treatment,
            tax_inclusive: tax.inclusive,
          }];
        }
        return rows;
      },
    } as unknown as ServiceContext["tx"];
    return { writes: stub.writes, tx };
  }

  it("standard-rates a bay whose tax code says so", async () => {
    const stub = parkingStub({ code: "VAT5", rate: "0.050000", treatment: "standard", inclusive: true });
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });

    expect(preview.byTreatment[0]!.treatment).toBe("standard");
    expect(preview.totals.net).toBe(639);
    expect(preview.totals.vat).toBe(31.95);
    expect(preview.totals.gross).toBe(670.95);
    expect(preview.lines[0]!.taxCode).toBe("VAT5");
  });

  it("exempts the same bay when the tax code is changed — no code change", async () => {
    const stub = parkingStub({ code: "EXEMPT", rate: "0.000000", treatment: "exempt", inclusive: false });
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });

    expect(preview.byTreatment[0]!.treatment).toBe("exempt");
    expect(preview.totals.vat).toBe(0);
    expect(preview.totals.gross).toBe(639);
  });

  it("warns loudly when the unit kind and the treatment disagree", async () => {
    // A bay recorded as exempt is either the answer to Q-1 or a misconfigured
    // lease, and the accountant is the only one who can tell. WF-05 §9.2: the
    // preview exists so that judgement happens before 34 invoices, not after.
    const stub = parkingStub({ code: "EXEMPT", rate: "0.000000", treatment: "exempt", inclusive: false });
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });

    const mismatch = preview.warnings.find((w) => w.code === "treatment_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe("critical");
    expect(mismatch!.message).toContain("Q-1");
  });

  it("does not warn when a residential flat is exempt", async () => {
    const stub = stubTx({ billed: false });
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });
    expect(preview.warnings.find((w) => w.code === "treatment_mismatch")).toBeUndefined();
  });
});

describe("rent run — apportionment appears in the preview, not only in the invoice", () => {
  function endingStub(endsOn: string) {
    const stub = stubTx({ billed: false });
    const inner = stub.tx.execute.bind(stub.tx) as (q: unknown) => Promise<unknown[]>;
    return {
      writes: stub.writes,
      tx: {
        execute: async (q: unknown) => {
          const rows = (await inner(q)) as Record<string, unknown>[];
          if (rows[0] && "lease_number" in rows[0]) return [{ ...rows[0], ends_on: endsOn }];
          return rows;
        },
      } as unknown as ServiceContext["tx"],
    };
  }

  it("apportions a lease that ends mid-month and says so", async () => {
    // Billing day 1, so September's period is 1 Sept → 30 Sept inclusive.
    const stub = endingStub("2026-09-10");
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });

    const line = preview.lines[0]!;
    expect(line.prorated).toBe(true);
    expect(line.daysCharged).toBe(10);
    expect(line.daysInPeriod).toBe(30);
    // The service period on the line is the days actually charged, because
    // that is what attributes the supply to a VAT return period and what the
    // cheque register matches a cheque against.
    expect(line.periodStart).toBe("2026-09-01");
    expect(line.periodEnd).toBe("2026-09-10");
    expect(line.gross).toBe(1694.3333);

    const warning = preview.warnings.find((w) => w.code === "prorated");
    expect(warning?.message).toContain("10 of 30 days");
  });

  it("skips a term that ended before the period and names it for renewal", async () => {
    const stub = endingStub("2026-03-31");
    const preview = await previewRentRun(ctxFor(stub, ["document:read"]), { period: "2026-09" });

    expect(preview.totals.invoices).toBe(0);
    // Silence here is how an operator ends up unable to explain why 41 leases
    // produced 30 invoices.
    const warning = preview.warnings.find((w) => w.code === "not_billed");
    expect(warning?.message).toContain("Term ended 2026-03-31");
  });
});
