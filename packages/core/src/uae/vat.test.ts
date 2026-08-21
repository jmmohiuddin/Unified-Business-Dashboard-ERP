import { describe, expect, it } from "vitest";
import {
  APPORTIONMENT_BASIS_IN_USE,
  VOLUNTARY_DISCLOSURE_THRESHOLD,
  calculateAnnualWashup,
  calculateVatReturn,
  resolveApportionmentMethod,
} from "./tax.ts";

/**
 * VAT201: apportionment, reverse charge, and the annual wash-up.
 *
 * A sibling of `uae.test.ts` rather than an extension of it. That file's VAT
 * block covers the apportionment arithmetic that already existed and was
 * already right; this one covers what wave 2 added — the reverse charge that
 * used to be accepted and ignored, the tenant-configurable method, the box
 * numbering, and the annual actual-use adjustment.
 *
 * Same rule as next door: **every expected value is hand-calculated in the
 * comment above it**, from the statute or from the audit's worked example, so a
 * reviewer can check the arithmetic without running anything. A fixture
 * produced by calling the function it tests proves only that the function is
 * deterministic.
 *
 * And the same rule about what is NOT asserted. The apportionment *basis* — the
 * question of whether the FTA's standard method divides supply values or input
 * tax amounts — is a `it.todo` at the bottom, not a fixture. The two readings
 * are AED 6,667 apart on one quarter of this portfolio's own numbers, and
 * nobody on this project has read Cabinet Decision 52/2017 Article 55. Writing
 * a fixture in either direction would give a guess the authority of a passing
 * test.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A fully taxable quarter, for tests that vary one thing about it. */
const TAXABLE_ONLY = {
  standardRatedSupplies: 100_000,
  outputVat: 5_000,
  zeroRatedSupplies: 0,
  exemptSupplies: 0,
  reverseChargeSupplies: 0,
  directlyAttributableInput: 0,
  residualInput: 0,
  exemptAttributableInput: 0,
};

describe("reverse charge on imported services (FR-C03)", () => {
  it("reproduces the audit's worked example (CALC-4) exactly", () => {
    // Standard supplies 600,000 -> output VAT 30,000. Exempt 400,000.
    // Ratio = 600,000 / 1,000,000 = 0.6.
    // Imported consultancy 100,000 under RCM, serving the group as a whole:
    //   self-accounted output VAT = 100,000 x 5%          =  5,000
    //   reclaimed at the recovery position 5,000 x 0.6    =  3,000
    //   irrecoverable, and therefore a real cost          =  2,000
    // Residual input VAT 20,000 x 0.6                     = 12,000 recoverable,
    //                                                        8,000 a cost.
    // Total output VAT   = 30,000 + 5,000                 = 35,000
    // Total recoverable  = 0 + 12,000 + 3,000             = 15,000
    // Net VAT due        = 35,000 - 15,000                = 20,000
    //
    // The old code returned 18,000 here: it echoed the 100,000 into box 3 and
    // raised no VAT on it at all.
    const r = calculateVatReturn({
      standardRatedSupplies: 600_000,
      outputVat: 30_000,
      zeroRatedSupplies: 0,
      exemptSupplies: 400_000,
      reverseChargeSupplies: 100_000,
      directlyAttributableInput: 0,
      residualInput: 20_000,
      exemptAttributableInput: 0,
    });

    expect(r.recoveryRatio).toBe(0.6);
    expect(r.reverseChargeOutputVat).toBe(5_000);
    expect(r.reverseChargeRecoverableInput).toBe(3_000);
    expect(r.recoverableResidual).toBe(12_000);
    expect(r.totalOutputVat).toBe(35_000);
    expect(r.totalRecoverableInput).toBe(15_000);
    expect(r.netVatDue).toBe(20_000);
    // 8,000 of residual + 2,000 of reverse charge, both expensed to 5720.
    expect(r.irrecoverableInput).toBe(10_000);
  });

  it("nets to nil for a fully taxable business", () => {
    // The reason the omission went unnoticed. Ratio = 1, so the 5,000 of output
    // VAT and the 5,000 reclaimed cancel and net VAT due is unchanged at 5,000.
    const r = calculateVatReturn({ ...TAXABLE_ONLY, reverseChargeSupplies: 100_000 });
    expect(r.reverseChargeOutputVat).toBe(5_000);
    expect(r.reverseChargeRecoverableInput).toBe(5_000);
    expect(r.netVatDue).toBe(5_000);
    expect(r.irrecoverableInput).toBe(0);
  });

  it("denies recovery where the imported service supports exempt supplies", () => {
    // FR-C03: "Recovery is denied where the supply supports exempt supplies."
    // A property-management retainer bought from a non-resident firm that works
    // only on the residential block: 50,000 x 5% = 2,500 of output VAT due, and
    // none of it comes back, even though the group is 60% taxable overall.
    const r = calculateVatReturn({
      standardRatedSupplies: 600_000,
      outputVat: 30_000,
      zeroRatedSupplies: 0,
      exemptSupplies: 400_000,
      reverseChargeSupplies: 50_000,
      reverseChargeExemptAttributed: 50_000,
      directlyAttributableInput: 0,
      residualInput: 0,
      exemptAttributableInput: 0,
    });
    expect(r.reverseChargeOutputVat).toBe(2_500);
    expect(r.reverseChargeRecoverableInput).toBe(0);
    expect(r.irrecoverableInput).toBe(2_500);
    expect(r.netVatDue).toBe(32_500);
  });

  it("splits a mixed reverse-charge period three ways and re-adds to box 3", () => {
    // 100,000 imported: 40,000 serves the taxable trades, 20,000 serves the
    // residential block, the remaining 40,000 is a shared overhead.
    //   output VAT      = 100,000 x 5%                       = 5,000
    //   taxable leg     =  40,000 x 5%                       = 2,000 reclaimed
    //   exempt leg      =  20,000 x 5% = 1,000               =     0 reclaimed
    //   residual leg    =  40,000 x 5% = 2,000, x 0.6        = 1,200 reclaimed
    //   reclaimed total                                      = 3,200
    //   irrecoverable   = 5,000 - 3,200                      = 1,800
    const r = calculateVatReturn({
      standardRatedSupplies: 600_000,
      outputVat: 30_000,
      zeroRatedSupplies: 0,
      exemptSupplies: 400_000,
      reverseChargeSupplies: 100_000,
      reverseChargeTaxableAttributed: 40_000,
      reverseChargeExemptAttributed: 20_000,
      directlyAttributableInput: 0,
      residualInput: 0,
      exemptAttributableInput: 0,
    });
    expect(r.boxes["3_reverse_charge"]).toBe(100_000);
    expect(r.reverseChargeOutputVat).toBe(5_000);
    expect(r.reverseChargeRecoverableInput).toBe(3_200);
    expect(r.irrecoverableInput).toBe(1_800);
  });

  it("refuses an over-attributed reverse charge rather than clamping it", () => {
    // Clamping would silently move the excess into the residual bucket and
    // change the tax due. The house rule is that over-allocation is refused
    // exactly — the same rule payments and purchasing follow.
    expect(() =>
      calculateVatReturn({
        ...TAXABLE_ONLY,
        reverseChargeSupplies: 100_000,
        reverseChargeTaxableAttributed: 80_000,
        reverseChargeExemptAttributed: 40_000,
      }),
    ).toThrow(/exceeds reverse-charge supplies/);
  });
});

describe("VAT201 box numbering (CALC-5)", () => {
  it("marks the boxes the seeded tax codes evidence as confirmed", () => {
    // packages/db/src/seed/reference.ts maps VAT5/PARKING -> VAT201-Box1,
    // RCM -> Box3, VAT0 -> Box4, EXEMPT -> Box5. Those four are facts in this
    // repository, so they are asserted.
    const r = calculateVatReturn(TAXABLE_ONLY);
    const confirmed = r.lines.filter((l) => l.numberConfirmed).map((l) => l.no);
    expect(confirmed).toEqual(["1", "3", "4", "5"]);
  });

  it("flags the recoverable-input box number as unconfirmed", () => {
    // Nothing in the repo maps recoverable input tax to a box. The FTA form is
    // understood to use box 9 for standard-rated expenses and box 13 for total
    // recoverable tax, and WF-05 §10.2 sketches box 9 as "Standard purch." —
    // which agrees. The number is carried forward unchanged and flagged rather
    // than renumbered, because renumbering on a recollection is the same error
    // in the other direction.
    const r = calculateVatReturn(TAXABLE_ONLY);
    const line = r.lines.find((l) => l.key === "9_recoverable_input");
    expect(line?.no).toBe("9");
    expect(line?.numberConfirmed).toBe(false);
  });

  it("names the emirate on box 1 and says why there is only one", () => {
    const r = calculateVatReturn({ ...TAXABLE_ONLY, emirate: "Dubai" });
    const box1 = r.lines.find((l) => l.key === "1_standard_rated_supplies");
    expect(box1?.note).toContain("Dubai");
    expect(box1?.note).toContain("1a–1g");
  });
});

describe("apportionment method as a tenant setting (FR-C02)", () => {
  it("defaults to the standard output-based method", () => {
    expect(resolveApportionmentMethod(undefined).method).toEqual({ kind: "standard" });
    expect(resolveApportionmentMethod({}).method).toEqual({ kind: "standard" });
  });

  it("applies an approved floorspace ratio in place of the supplies ratio", () => {
    // Supplies would give 600,000 / 1,000,000 = 60%. The approved floorspace
    // ratio is 72%, so the residual 20,000 recovers 14,400 rather than 12,000.
    const { method } = resolveApportionmentMethod({
      apportionmentMethod: "floorspace",
      recoveryRatio: "0.72",
      ftaApprovalReference: "FTA-SM-2026-00017",
    });
    const r = calculateVatReturn({
      standardRatedSupplies: 600_000,
      outputVat: 30_000,
      zeroRatedSupplies: 0,
      exemptSupplies: 400_000,
      reverseChargeSupplies: 0,
      directlyAttributableInput: 0,
      residualInput: 20_000,
      exemptAttributableInput: 0,
      method,
    });
    expect(r.recoveryRatio).toBe(0.72);
    expect(r.recoverableResidual).toBe(14_400);
    expect(r.apportionment.basis).toBe("floorspace");
    expect(r.apportionment.ftaApprovalReference).toBe("FTA-SM-2026-00017");
  });

  it("falls back to standard when the FTA approval reference is missing", () => {
    // The failure mode this exists to prevent: somebody selects the method that
    // recovers more, leaves the approval blank because the FTA has not answered,
    // and the return quietly claims on an unapproved special method.
    const { method, notes } = resolveApportionmentMethod({
      apportionmentMethod: "floorspace",
      recoveryRatio: "0.72",
    });
    expect(method).toEqual({ kind: "standard" });
    expect(notes.join(" ")).toContain("FTA approval reference");
    expect(notes.join(" ")).toContain("Q-1");
  });

  it("falls back to standard on a ratio that is not a fraction", () => {
    expect(
      resolveApportionmentMethod({
        apportionmentMethod: "floorspace",
        recoveryRatio: "72",
        ftaApprovalReference: "FTA-SM-2026-00017",
      }).method,
    ).toEqual({ kind: "standard" });
    expect(
      resolveApportionmentMethod({
        apportionmentMethod: "floorspace",
        recoveryRatio: "not-a-number",
        ftaApprovalReference: "FTA-SM-2026-00017",
      }).method,
    ).toEqual({ kind: "standard" });
  });

  it("records the basis actually used on every return", () => {
    // The point of the constant: a return filed today can be re-read years
    // later knowing which reading of Article 55 produced it.
    expect(APPORTIONMENT_BASIS_IN_USE).toBe("supplies_value");
    expect(calculateVatReturn(TAXABLE_ONLY).apportionment.basis).toBe("supplies_value");
  });
});

describe("annual actual-use wash-up (FR-C02)", () => {
  /**
   * A year whose exempt rent is steady and whose taxable trade is seasonal —
   * the exact shape the wash-up exists for. Residual pool 20,000 a quarter.
   *
   *   Q1  ratio 0.60 -> 12,000 recovered
   *   Q2  ratio 0.50 -> 10,000
   *   Q3  ratio 0.80 -> 16,000
   *   Q4  ratio 0.40 ->  8,000
   *   total residual 80,000, provisionally recovered 46,000
   */
  const QUARTERS = [
    { label: "2026-Q1", residualInput: 20_000, recoverableResidual: 12_000 },
    { label: "2026-Q2", residualInput: 20_000, recoverableResidual: 10_000 },
    { label: "2026-Q3", residualInput: 20_000, recoverableResidual: 16_000 },
    { label: "2026-Q4", residualInput: 20_000, recoverableResidual: 8_000 },
  ];

  it("computes an additional recovery when the quarters under-recovered", () => {
    // Annual actual use: taxable 1,200,000 / total 2,000,000 = 60%.
    // Annual entitlement = 80,000 x 0.60 = 48,000.
    // Adjustment = 48,000 - 46,000 = +2,000, reclaimable.
    // Below the AED 10,000 threshold, so no voluntary disclosure.
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: QUARTERS,
      annualTaxableSupplies: 1_200_000,
      annualExemptSupplies: 800_000,
    });
    expect(r.totalResidualInput).toBe(80_000);
    expect(r.provisionallyRecovered).toBe(46_000);
    expect(r.annualRecoveryRatio).toBe(0.6);
    expect(r.annualRecoverable).toBe(48_000);
    expect(r.adjustment).toBe(2_000);
    expect(r.direction).toBe("additional_recovery");
    expect(r.exceedsVoluntaryDisclosureThreshold).toBe(false);
    // Extra recovery reduces the expense the irrecoverable share was booked to.
    expect(r.posting).toEqual({
      description: "VAT input-tax annual wash-up 2026 (actual-use adjustment)",
      legs: [
        { side: "debit", accountKey: "VAT_INPUT", amount: 2_000 },
        { side: "credit", accountKey: "VAT_IRRECOVERABLE", amount: 2_000 },
      ],
    });
  });

  it("computes a repayment, and flags the voluntary-disclosure threshold", () => {
    // Same quarters, but the year's actual mix is far more exempt:
    // taxable 600,000 / total 2,000,000 = 30%.
    // Annual entitlement = 80,000 x 0.30 = 24,000.
    // Adjustment = 24,000 - 46,000 = -22,000, repayable — and 22,000 is over
    // the AED 10,000 threshold, so it cannot simply go on the next return.
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: QUARTERS,
      annualTaxableSupplies: 600_000,
      annualExemptSupplies: 1_400_000,
    });
    expect(r.annualRecoveryRatio).toBe(0.3);
    expect(r.annualRecoverable).toBe(24_000);
    expect(r.adjustment).toBe(-22_000);
    expect(r.direction).toBe("repayment");
    expect(r.exceedsVoluntaryDisclosureThreshold).toBe(true);
    expect(Math.abs(r.adjustment)).toBeGreaterThan(VOLUNTARY_DISCLOSURE_THRESHOLD);
    expect(r.posting?.legs).toEqual([
      { side: "debit", accountKey: "VAT_IRRECOVERABLE", amount: 22_000 },
      { side: "credit", accountKey: "VAT_INPUT", amount: 22_000 },
    ]);
  });

  it("produces no posting when the year washes up to nil", () => {
    // Provisional recovery of 46,000 against an entitlement of exactly 46,000:
    // 80,000 x 0.575 = 46,000, and 1,150,000 / 2,000,000 = 0.575.
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: QUARTERS,
      annualTaxableSupplies: 1_150_000,
      annualExemptSupplies: 850_000,
    });
    expect(r.annualRecoverable).toBe(46_000);
    expect(r.adjustment).toBe(0);
    expect(r.direction).toBe("nil");
    expect(r.posting).toBeNull();
  });

  it("says so when the year is not complete", () => {
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: QUARTERS.slice(0, 2),
      annualTaxableSupplies: 500_000,
      annualExemptSupplies: 500_000,
    });
    expect(r.quartersIncluded).toEqual(["2026-Q1", "2026-Q2"]);
    expect(r.notes.join(" ")).toContain("Only 2 of 4 quarters are included");
  });

  it("handles a tax year with nothing filed in it", () => {
    const r = calculateAnnualWashup({
      taxYear: "2027",
      quarters: [],
      annualTaxableSupplies: 0,
      annualExemptSupplies: 0,
    });
    expect(r.totalResidualInput).toBe(0);
    expect(r.adjustment).toBe(0);
    expect(r.posting).toBeNull();
    expect(r.notes.join(" ")).toContain("No quarters are included");
  });

  it("keeps a non-terminating annual ratio exact to storage precision", () => {
    // 100 / 300 does not terminate. Annual entitlement = 100 x 1/3, quantized
    // to the 4 dp everything in this system stores at, = 33.3333.
    // Adjustment = 33.3333 - 50 = -16.6667.
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: [{ label: "2026-Q1", residualInput: 100, recoverableResidual: 50 }],
      annualTaxableSupplies: 100,
      annualExemptSupplies: 200,
    });
    expect(r.annualRecoverable).toBe(33.3333);
    expect(r.adjustment).toBe(-16.6667);
  });

  it("uses an approved floorspace ratio for the wash-up as well", () => {
    // A special method applies to the annual adjustment too, otherwise the
    // wash-up would drag the year back onto the standard method by itself.
    // 80,000 x 0.72 = 57,600; 57,600 - 46,000 = +11,600.
    const r = calculateAnnualWashup({
      taxYear: "2026",
      quarters: QUARTERS,
      annualTaxableSupplies: 1_200_000,
      annualExemptSupplies: 800_000,
      method: {
        kind: "floorspace",
        recoveryRatio: 0.72,
        ftaApprovalReference: "FTA-SM-2026-00017",
      },
    });
    expect(r.annualRecoverable).toBe(57_600);
    expect(r.adjustment).toBe(11_600);
    expect(r.exceedsVoluntaryDisclosureThreshold).toBe(true);
  });
});

describe("invariants that make the return reconcile", () => {
  it("keeps recoverable + irrecoverable equal to residual plus reverse charge", () => {
    // The property `uae.test.ts` guards for the residual alone, extended to the
    // reverse charge: every dirham of self-accounted VAT is either reclaimed or
    // a cost, and nothing falls between the two.
    const r = calculateVatReturn({
      standardRatedSupplies: 100,
      outputVat: 5,
      zeroRatedSupplies: 0,
      exemptSupplies: 200,
      reverseChargeSupplies: 700,
      directlyAttributableInput: 0,
      residualInput: 100,
      exemptAttributableInput: 0,
    });
    // Ratio 100/300 = 1/3. Residual 100 -> 33.3333 recovered, 66.6667 a cost.
    // RCM 700 x 5% = 35 output VAT -> 35 x 1/3 = 11.6667 recovered, 23.3333 a cost.
    expect(r.recoverableResidual).toBe(33.3333);
    expect(r.reverseChargeOutputVat).toBe(35);
    expect(r.reverseChargeRecoverableInput).toBe(11.6667);
    expect(round2(r.totalRecoverableInput + r.irrecoverableInput)).toBe(round2(100 + 35));
  });

  it("does not change the pre-existing result when there is no reverse charge", () => {
    // The wave-1 mixed case, unchanged: ratio 0.6, 6,000 of 10,000 residual
    // recovered, 8,000 recoverable in total, 4,500 a cost.
    const r = calculateVatReturn({
      standardRatedSupplies: 60_000,
      outputVat: 3_000,
      zeroRatedSupplies: 0,
      exemptSupplies: 40_000,
      reverseChargeSupplies: 0,
      directlyAttributableInput: 2_000,
      residualInput: 10_000,
      exemptAttributableInput: 500,
    });
    expect(r.boxes["9_recoverable_input"]).toBe(8_000);
    expect(r.irrecoverableInput).toBe(4_500);
    expect(r.netVatDue).toBe(3_000 - 8_000);
    expect(r.isRefund).toBe(true);
  });
});

// ── Parked on the tax adviser ───────────────────────────────────────────────

it.todo(
  "apportionment BASIS: BLOCKED. The ratio is taxable supplies / total supplies " +
    "(turnover). Executive Regulation Cabinet Decision 52/2017 Art. 55 may " +
    "instead require the standard method to work from input tax amounts: input " +
    "tax attributable to taxable supplies / (that plus input tax attributable to " +
    "exempt supplies). On 50,000 taxable / 10,000 exempt directly-attributable " +
    "input, 20,000 residual and supplies split 1m/1m, the two bases recover " +
    "10,000 and 16,667 — AED 6,667 apart in one quarter, past the AED 10,000 " +
    "voluntary-disclosure threshold within two. Nobody here has read the " +
    "regulation text. Both inputs the alternative needs are already on " +
    "VatReturnInput, so the change is small once the answer is known.",
);

it.todo(
  "floorspace apportionment for the property portfolio: BLOCKED on Q-1. The " +
    "mechanism is built and tested above — an approved ratio and an FTA " +
    "reference replace the supplies ratio — but whether to apply for the method " +
    "at all, and what ratio to apply for, needs the adviser's written opinion.",
);

it.todo(
  "standalone parking VAT treatment: BLOCKED on Q-1. Parking is standard-rated " +
    "while residential rent is exempt, and the two share the units/leases model.",
);
