/**
 * UAE corporate tax and VAT computation.
 *
 * Corporate tax: Federal Decree-Law No. 47 of 2022, effective for financial
 * years starting on or after 1 June 2023.
 *
 * VAT: Federal Decree-Law No. 8 of 2017, standard rate 5%.
 *
 * These are *estimates for management decision-making*, clearly labelled as
 * such. They are not a tax filing, and the system says so wherever it shows
 * them — a business owner acting on an ERP's tax number without their accountant
 * is a liability the product should not create.
 */

// ── Corporate tax ───────────────────────────────────────────────────────────

import * as M from "../money/index.ts";

export const CT_THRESHOLD = 375_000; // AED — taxable income taxed at 0% below this
export const CT_RATE = 0.09;
export const SBR_REVENUE_CAP = 3_000_000; // AED — Small Business Relief ceiling
/** Ministerial Decision 73 of 2023: SBR is available for tax periods ending on
 *  or before 31 December 2026. */
export const SBR_AVAILABLE_UNTIL = "2026-12-31";

export interface CorporateTaxInput {
  /** Accounting profit before tax for the period. */
  accountingProfit: number;
  /** Total revenue for the period — determines Small Business Relief. */
  revenue: number;
  /** Period end, ISO date. Determines whether SBR is still available. */
  periodEnd: string;
  /**
   * Expenses disallowed for corporate tax. The common ones for an
   * owner-operated group: entertainment is only 50% deductible, fines are not
   * deductible at all, and owner drawings are not an expense in the first place.
   */
  disallowedExpenses?: number;
  /** Losses carried forward from earlier periods (capped at 75% of income). */
  lossesBroughtForward?: number;
  /** Whether the business elects Small Business Relief where eligible. */
  electSbr?: boolean;
}

export interface CorporateTaxResult {
  accountingProfit: number;
  taxableIncome: number;
  lossesUtilised: number;
  sbrEligible: boolean;
  sbrApplied: boolean;
  /** Income taxed at 0% — the first AED 375,000. */
  exemptSlice: number;
  taxableSlice: number;
  taxDue: number;
  effectiveRate: number;
  notes: string[];
}

export function calculateCorporateTax(input: CorporateTaxInput): CorporateTaxResult {
  const {
    accountingProfit,
    revenue,
    periodEnd,
    disallowedExpenses = 0,
    lossesBroughtForward = 0,
    electSbr = true,
  } = input;

  const notes: string[] = [];

  const sbrStillOffered = periodEnd <= SBR_AVAILABLE_UNTIL;
  const sbrEligible = sbrStillOffered && revenue <= SBR_REVENUE_CAP;
  const sbrApplied = sbrEligible && electSbr;

  if (sbrEligible && !sbrStillOffered) {
    notes.push("Small Business Relief is no longer available after 31 Dec 2026.");
  }

  if (sbrApplied) {
    notes.push(
      `Small Business Relief elected: revenue of ${revenue.toLocaleString("en-AE")} AED is ` +
        `within the ${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED cap, so the business is ` +
        `treated as having no taxable income for this period.`,
    );
    return {
      accountingProfit,
      taxableIncome: 0,
      lossesUtilised: 0,
      sbrEligible,
      sbrApplied: true,
      exemptSlice: 0,
      taxableSlice: 0,
      taxDue: 0,
      effectiveRate: 0,
      notes,
    };
  }

  if (!sbrEligible && sbrStillOffered) {
    notes.push(
      `Revenue of ${revenue.toLocaleString("en-AE")} AED exceeds the ` +
        `${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED Small Business Relief cap.`,
    );
  }

  const adjustedProfit = accountingProfit + disallowedExpenses;
  if (disallowedExpenses > 0) {
    notes.push(
      `${disallowedExpenses.toLocaleString("en-AE")} AED of disallowed expenses added back.`,
    );
  }

  // Losses may offset at most 75% of taxable income in any period.
  const maxLossOffset = Math.max(0, adjustedProfit) * 0.75;
  const lossesUtilised = Math.min(lossesBroughtForward, maxLossOffset);
  if (lossesUtilised > 0) {
    notes.push(
      `${lossesUtilised.toLocaleString("en-AE")} AED of brought-forward losses used ` +
        `(capped at 75% of taxable income).`,
    );
  }

  const taxableIncome = Math.max(0, adjustedProfit - lossesUtilised);
  const exemptSlice = Math.min(taxableIncome, CT_THRESHOLD);
  const taxableSlice = Math.max(0, taxableIncome - CT_THRESHOLD);
  const taxDue = taxableSlice * CT_RATE;

  notes.push(
    `First ${CT_THRESHOLD.toLocaleString("en-AE")} AED at 0%; ` +
      `remainder at ${(CT_RATE * 100).toFixed(0)}%.`,
  );

  return {
    accountingProfit,
    taxableIncome,
    lossesUtilised,
    sbrEligible,
    sbrApplied: false,
    exemptSlice,
    taxableSlice,
    taxDue,
    effectiveRate: taxableIncome > 0 ? taxDue / taxableIncome : 0,
    notes,
  };
}

// ── VAT ─────────────────────────────────────────────────────────────────────

export const VAT_RATE = 0.05;

export interface VatReturnInput {
  /** Standard-rated supplies, net of VAT (VAT201 box 1). */
  standardRatedSupplies: number;
  outputVat: number;
  /** Zero-rated supplies (box 4) — 0% but input VAT IS recoverable. */
  zeroRatedSupplies: number;
  /** Exempt supplies (box 5) — residential rent. Input VAT NOT recoverable. */
  exemptSupplies: number;
  /** Reverse-charge supplies (box 3). */
  reverseChargeSupplies: number;
  /** Input VAT on purchases directly attributable to taxable supplies. */
  directlyAttributableInput: number;
  /** Input VAT on overheads used for both taxable and exempt supplies. */
  residualInput: number;
  /** Input VAT directly attributable to exempt supplies — never recoverable. */
  exemptAttributableInput: number;
}

export interface VatReturnResult {
  boxes: Record<string, number>;
  /** Share of residual input VAT that may be recovered. */
  recoveryRatio: number;
  recoverableResidual: number;
  totalRecoverableInput: number;
  irrecoverableInput: number;
  netVatDue: number;
  isRefund: boolean;
  notes: string[];
}

/**
 * VAT return position with **input apportionment**.
 *
 * This is the part almost every SMB gets wrong, and it is specifically wrong for
 * this portfolio because the residential flats make exempt supplies. Overheads
 * used across both the taxable businesses and the exempt rentals cannot be
 * reclaimed in full: only the taxable proportion is recoverable, computed using
 * the FTA's standard input-tax apportionment method
 * (taxable supplies ÷ total supplies).
 *
 * Reclaiming 100% of overhead input VAT while renting out residential property
 * is a straightforward assessment risk. Modelling it correctly is worth more
 * than any dashboard widget in this system.
 */
export function calculateVatReturn(input: VatReturnInput): VatReturnResult {
  const {
    standardRatedSupplies,
    outputVat,
    zeroRatedSupplies,
    exemptSupplies,
    reverseChargeSupplies,
    directlyAttributableInput,
    residualInput,
    exemptAttributableInput,
  } = input;

  const notes: string[] = [];

  // Zero-rated supplies count as taxable for apportionment; exempt do not.
  // Exact decimal throughout. The recovery ratio is a division that almost
  // never terminates, and it multiplies the residual input VAT that goes on the
  // return — an error here is a misstated reclaim to the FTA, where a
  // difference above AED 10,000 triggers a mandatory voluntary disclosure.
  //
  // The irrecoverable portion is taken as the REMAINDER of the residual rather
  // than recomputed from (1 - ratio), so recoverable + irrecoverable always
  // equals the residual exactly and the return's own boxes reconcile.
  const taxable = M.add(M.money(standardRatedSupplies), M.money(zeroRatedSupplies));
  const exempt = M.money(exemptSupplies);
  const totalSup = M.add(taxable, exempt);
  const residual = M.money(residualInput);

  const ratio = M.gt(totalSup, M.ZERO) ? M.div(taxable, totalSup) : M.money(1);
  const recoverableResidualM = M.quantize(M.mul(residual, ratio));
  const totalRecoverableInputM = M.add(M.money(directlyAttributableInput), recoverableResidualM);
  const irrecoverableInputM = M.add(
    M.money(exemptAttributableInput),
    M.sub(residual, recoverableResidualM),
  );

  const taxableSupplies = M.toNumber(taxable);
  const totalSupplies = M.toNumber(totalSup);
  const recoveryRatio = M.toNumber(ratio);
  const recoverableResidual = M.toNumber(recoverableResidualM);
  const totalRecoverableInput = M.toNumber(totalRecoverableInputM);
  const irrecoverableInput = M.toNumber(irrecoverableInputM);

  if (exemptSupplies > 0) {
    notes.push(
      `Exempt (residential) supplies are ${((exemptSupplies / totalSupplies) * 100).toFixed(1)}% ` +
        `of turnover, so only ${(recoveryRatio * 100).toFixed(1)}% of residual input VAT is ` +
        `recoverable. ${M.toDisplay(irrecoverableInputM)} AED is a cost, not a reclaim.`,
    );
  }

  const netVatDue = M.toNumber(M.sub(M.money(outputVat), totalRecoverableInputM));

  return {
    boxes: {
      "1_standard_rated_supplies": standardRatedSupplies,
      "1_output_vat": outputVat,
      "3_reverse_charge": reverseChargeSupplies,
      "4_zero_rated": zeroRatedSupplies,
      "5_exempt": exemptSupplies,
      "9_recoverable_input": totalRecoverableInput,
    },
    recoveryRatio,
    recoverableResidual,
    totalRecoverableInput,
    irrecoverableInput,
    netVatDue,
    isRefund: netVatDue < 0,
    notes,
  };
}
