import { describe, expect, it } from "vitest";
import * as M from "../money/index.ts";
import {
  CT_RATE,
  CT_THRESHOLD,
  SBR_AVAILABLE_UNTIL,
  SBR_REVENUE_CAP,
  calculateCorporateTax,
} from "./tax.ts";

/**
 * CORPORATE TAX — Federal Decree-Law 47/2022.
 *
 * This function's output is a number the owner budgets against and the
 * accountant starts a filing from, and until this file existed it had zero
 * coverage of any kind: no unit test, no e2e reference, nothing. A formula that
 * is wrong on day one and never asserted is wrong for the life of the product.
 *
 * Every expected value below is hand-calculated from the statute and written
 * out in the comment above it, so a reviewer can check the arithmetic on paper
 * without running anything. Nothing here was produced by calling the function
 * and pasting what came back — that proves determinism, not correctness.
 *
 * Boundaries are asserted from *both* sides. Three of the four defects this
 * file was written against (the unreachable expiry note, the missing
 * prior-period revenue test, the float arithmetic) are invisible to a fixture
 * that only samples the middle of a range.
 */

describe("corporate tax — the AED 375,000 nil band", () => {
  it("charges nothing at exactly the threshold", () => {
    // Taxable income 375,000 = the whole nil band. Slice above it: 0.
    const r = calculateCorporateTax({
      accountingProfit: CT_THRESHOLD, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.taxableIncome).toBe(375_000);
    expect(r.exemptSlice).toBe(375_000);
    expect(r.taxableSlice).toBe(0);
    expect(r.taxDue).toBe(0);
    expect(r.effectiveRate).toBe(0);
  });

  it("charges nothing one fils below the threshold", () => {
    // 374,999.99 is entirely within the band.
    const r = calculateCorporateTax({
      accountingProfit: 374_999.99, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.exemptSlice).toBe(374_999.99);
    expect(r.taxableSlice).toBe(0);
    expect(r.taxDue).toBe(0);
  });

  it("charges 9% on the first dirham above the threshold", () => {
    // 375,001 - 375,000 = 1 AED x 9% = 0.09.
    const r = calculateCorporateTax({
      accountingProfit: 375_001, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.exemptSlice).toBe(375_000);
    expect(r.taxableSlice).toBe(1);
    expect(r.taxDue).toBe(0.09);
  });

  it("caps the exempt slice at the band and never above it", () => {
    // 1,000,000: exempt 375,000, taxable 625,000 x 9% = 56,250.
    const r = calculateCorporateTax({
      accountingProfit: 1_000_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.exemptSlice).toBe(CT_THRESHOLD);
    expect(r.taxableSlice).toBe(625_000);
    expect(r.taxDue).toBe(56_250);
  });

  it("reports the effective rate over the whole taxable income, not the slice", () => {
    // 750,000: taxable slice 375,000 x 9% = 33,750.
    // Effective rate = 33,750 / 750,000 = 0.045 — half the headline 9%,
    // which is the number that tells the owner the band is working.
    const r = calculateCorporateTax({
      accountingProfit: 750_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.taxDue).toBe(33_750);
    expect(r.effectiveRate).toBe(0.045);
  });

  it("charges nothing on a loss and reports a zero effective rate", () => {
    // A loss is not negative tax, and 0/0 is not NaN on a dashboard.
    const r = calculateCorporateTax({
      accountingProfit: -100_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.taxableIncome).toBe(0);
    expect(r.taxDue).toBe(0);
    expect(r.effectiveRate).toBe(0);
  });

  it("uses the statutory constants", () => {
    expect(CT_RATE).toBe(0.09);
    expect(CT_THRESHOLD).toBe(375_000);
    expect(SBR_REVENUE_CAP).toBe(3_000_000);
    expect(SBR_AVAILABLE_UNTIL).toBe("2026-12-31");
  });
});

describe("corporate tax — exact decimal arithmetic", () => {
  it("does not carry IEEE-754 drift into the taxable slice", () => {
    // 375,000.10 + 0.20 = 375,000.30 exactly, so the slice above the band is
    // 0.30 and the tax is 0.027.
    //
    // In doubles it is not: 375000.1 + 0.2 - 375000 evaluates to
    // 0.29999999998835847, and x 0.09 to 0.02699999999895226. Both round to
    // the same fils, which is why this never showed up as a wrong number — but
    // the returned figures were unstorable and did not compare equal to
    // anything, and the same shape at larger scale is the drift the money
    // module exists to remove. This fixture fails on the float implementation.
    const r = calculateCorporateTax({
      accountingProfit: 375_000.1, revenue: 5_000_000,
      periodEnd: "2027-12-31", disallowedExpenses: 0.2, electSbr: false,
    });
    expect(r.taxableIncome).toBe(375_000.3);
    expect(r.taxableSlice).toBe(0.3);
    expect(r.taxDue).toBe(0.027);
  });

  it("keeps exempt slice + taxable slice equal to taxable income exactly", () => {
    // The band split is a partition, not two independent roundings: an
    // accountant who adds the two lines on screen must get the third.
    //
    // The recombination goes through the money module deliberately. Adding the
    // two returned numbers with `+` gives 833,333.3300000001 even though both
    // parts are exact — which is the same float hazard one layer out, and a
    // reminder that `toNumber` is an exit, not a round trip.
    const r = calculateCorporateTax({
      accountingProfit: 833_333.33, revenue: 5_000_000,
      periodEnd: "2027-12-31", electSbr: false,
    });
    expect(r.taxableIncome).toBe(833_333.33);
    expect(r.exemptSlice).toBe(375_000);
    // 833,333.33 - 375,000 = 458,333.33 x 9% = 41,249.9997.
    expect(r.taxableSlice).toBe(458_333.33);
    expect(r.taxDue).toBe(41_249.9997);
    expect(
      M.eq(M.add(M.money(r.exemptSlice), M.money(r.taxableSlice)), M.money(r.taxableIncome)),
    ).toBe(true);
  });
});

describe("corporate tax — Small Business Relief eligibility", () => {
  it("elects relief at exactly the revenue cap", () => {
    // The cap is inclusive: revenue OF 3,000,000 qualifies.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: SBR_REVENUE_CAP,
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(true);
    expect(r.sbrApplied).toBe(true);
    expect(r.taxDue).toBe(0);
    expect(r.taxableIncome).toBe(0);
  });

  it("denies relief one fils above the cap", () => {
    // 3,000,000.01 revenue -> full computation:
    // 900,000 - 375,000 = 525,000 x 9% = 47,250.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 3_000_000.01,
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(false);
    expect(r.sbrApplied).toBe(false);
    expect(r.taxDue).toBe(47_250);
  });

  it("computes the tax normally when relief is available but not elected", () => {
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      periodEnd: "2026-12-31", electSbr: false,
    });
    expect(r.sbrEligible).toBe(true);
    expect(r.sbrApplied).toBe(false);
    expect(r.taxDue).toBe(47_250);
  });

  it("tells the accountant that electing relief is not free", () => {
    // The election forfeits the period's losses and disallowed net interest for
    // carry-forward, on a reading not yet confirmed by an adviser. The result
    // says so rather than silently returning lossesUtilised: 0.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      periodEnd: "2026-12-31", lossesBroughtForward: 500_000,
    });
    expect(r.sbrApplied).toBe(true);
    expect(r.lossesUtilised).toBe(0);
    expect(r.notes.some((n) => /carry-forward/i.test(n))).toBe(true);
  });
});

describe("corporate tax — SBR is tested against prior periods too (FR-C04)", () => {
  it("denies relief when an earlier period exceeded the cap", () => {
    // AED 4m in 2024, AED 2m in 2026. Eligibility is evaluated against the
    // current AND all prior periods, so 2026 does not qualify:
    // 900,000 - 375,000 = 525,000 x 9% = 47,250.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      priorPeriodRevenues: [4_000_000],
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(false);
    expect(r.sbrApplied).toBe(false);
    expect(r.taxDue).toBe(47_250);
  });

  it("explains that the failure was a prior period, not this one", () => {
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      priorPeriodRevenues: [4_000_000],
      periodEnd: "2026-12-31",
    });
    expect(r.notes.some((n) => /earlier/i.test(n) && /prior periods/i.test(n))).toBe(true);
    // and NOT the "your revenue exceeds the cap" note, which would be a lie.
    expect(r.notes.some((n) => /Revenue of 2,000,000 AED exceeds/.test(n))).toBe(false);
  });

  it("keeps relief when every prior period was within the cap", () => {
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      priorPeriodRevenues: [1_000_000, SBR_REVENUE_CAP, 2_999_999.99],
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(true);
    expect(r.sbrApplied).toBe(true);
    expect(r.taxDue).toBe(0);
  });

  it("treats an omitted history as a first tax period, not as a pass", () => {
    // Documented behaviour, asserted so it cannot drift into a silent default:
    // callers that have prior periods must pass them.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_000_000,
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(true);
  });
});

describe("corporate tax — Small Business Relief expiry", () => {
  it("still offers relief for a period ending on 31 Dec 2026", () => {
    // Ministerial Decision 73/2023: available for periods ending on or before
    // 31 December 2026. The boundary date itself qualifies.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_500_000,
      periodEnd: "2026-12-31",
    });
    expect(r.sbrEligible).toBe(true);
    expect(r.taxDue).toBe(0);
  });

  it("withdraws relief one day later", () => {
    // 2027-01-01: 900,000 - 375,000 = 525,000 x 9% = 47,250.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_500_000,
      periodEnd: "2027-01-01",
    });
    expect(r.sbrEligible).toBe(false);
    expect(r.sbrApplied).toBe(false);
    expect(r.taxDue).toBe(47_250);
  });

  it("warns the under-cap business that the relief itself expired", () => {
    // The whole point of the note: this business was paying nil last period and
    // AED 47,250 on this one, and nothing about its own revenue changed. The
    // old guard was `sbrEligible && !sbrStillOffered`, which is identically
    // false because sbrEligible already required sbrStillOffered — so the note
    // could never fire and the owner got no explanation.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_500_000,
      periodEnd: "2027-12-31",
    });
    expect(r.notes.some((n) => /no longer available/i.test(n))).toBe(true);
  });

  it("does not blame the expiry when the business was over the cap anyway", () => {
    // Revenue 5m in 2027 was never getting relief; saying "the relief expired"
    // would send the accountant looking for something that was not there.
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 5_000_000,
      periodEnd: "2027-12-31",
    });
    expect(r.notes.some((n) => /no longer available/i.test(n))).toBe(false);
  });

  it("does not warn about expiry while the relief is still available", () => {
    const r = calculateCorporateTax({
      accountingProfit: 900_000, revenue: 2_500_000,
      periodEnd: "2026-06-30",
    });
    expect(r.notes.some((n) => /no longer available/i.test(n))).toBe(false);
  });
});

describe("corporate tax — add-backs and brought-forward losses", () => {
  it("adds disallowed expenses back before the band is applied", () => {
    // (350,000 + 50,000) - 375,000 = 25,000 x 9% = 2,250.
    const r = calculateCorporateTax({
      accountingProfit: 350_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", disallowedExpenses: 50_000, electSbr: false,
    });
    expect(r.taxableIncome).toBe(400_000);
    expect(r.taxDue).toBe(2_250);
  });

  it("caps loss relief at 75% of income, so 25% is always taxed", () => {
    // Adjusted profit 500,000; losses available 1,000,000.
    // Cap = 500,000 x 75% = 375,000, so only 375,000 is used.
    // Taxable income = 500,000 - 375,000 = 125,000, inside the nil band.
    const r = calculateCorporateTax({
      accountingProfit: 500_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", lossesBroughtForward: 1_000_000, electSbr: false,
    });
    expect(r.lossesUtilised).toBe(375_000);
    expect(r.taxableIncome).toBe(125_000);
    expect(r.taxDue).toBe(0);
  });

  it("uses losses in full when they are under the 75% cap", () => {
    // Adjusted 1,000,000; cap 750,000; losses 100,000 -> all used.
    // Taxable 900,000 - 375,000 = 525,000 x 9% = 47,250.
    const r = calculateCorporateTax({
      accountingProfit: 1_000_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", lossesBroughtForward: 100_000, electSbr: false,
    });
    expect(r.lossesUtilised).toBe(100_000);
    expect(r.taxableIncome).toBe(900_000);
    expect(r.taxDue).toBe(47_250);
  });

  it("uses no losses against a loss-making period", () => {
    // 75% of a negative number is not an offset allowance.
    const r = calculateCorporateTax({
      accountingProfit: -200_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", lossesBroughtForward: 500_000, electSbr: false,
    });
    expect(r.lossesUtilised).toBe(0);
    expect(r.taxableIncome).toBe(0);
    expect(r.taxDue).toBe(0);
  });

  it("applies add-backs and losses in the statutory order", () => {
    // Add back first, then cap the loss offset on the ADJUSTED figure:
    // (600,000 + 100,000) = 700,000; cap 525,000; losses 600,000 -> 525,000 used;
    // taxable 175,000, inside the band -> nil.
    // Capping on the unadjusted 600,000 would allow only 450,000 and tax
    // 250,000 - 375,000 -> still nil here, but the lossesUtilised line differs.
    const r = calculateCorporateTax({
      accountingProfit: 600_000, revenue: 5_000_000,
      periodEnd: "2027-12-31", disallowedExpenses: 100_000,
      lossesBroughtForward: 600_000, electSbr: false,
    });
    expect(r.lossesUtilised).toBe(525_000);
    expect(r.taxableIncome).toBe(175_000);
    expect(r.taxDue).toBe(0);
  });
});
