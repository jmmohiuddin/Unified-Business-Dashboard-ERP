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

// Money-module forms of the statutory constants, derived from the exported
// numbers above so the two can never drift apart. `String(CT_RATE)` rather than
// `CT_RATE` because a rate that arrives as a literal should be parsed as the
// decimal it is written as, not as the nearest double to it.
const CT_THRESHOLD_M = M.money(CT_THRESHOLD);
const CT_RATE_M = M.money(String(CT_RATE));
const SBR_REVENUE_CAP_M = M.money(SBR_REVENUE_CAP);
/** Article 37(2): brought-forward losses may offset at most 75% of taxable
 *  income in any one period. */
const LOSS_OFFSET_CAP_M = M.money("0.75");

export interface CorporateTaxInput {
  /** Accounting profit before tax for the period. */
  accountingProfit: number;
  /** Total revenue for the period — determines Small Business Relief. */
  revenue: number;
  /** Period end, ISO date. Determines whether SBR is still available. */
  periodEnd: string;
  /**
   * Revenue for every earlier tax period of the same taxable person.
   *
   * Relief is not a fresh test each year: FR-C04 requires eligibility to be
   * evaluated against revenue in the current **and all prior** periods, so a
   * business that turned over AED 4m in 2024 and AED 2m in 2026 is not eligible
   * in 2026. Omitting this is a claim that there are no prior periods — a first
   * tax period — not a claim that they were all under the cap.
   */
  priorPeriodRevenues?: number[];
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

/**
 * Corporate tax for one taxable person and one tax period.
 *
 * Exact decimal throughout, via the `Money` module. Nothing here needs 34
 * significant digits to come out right at AED magnitudes — the reason is that
 * this function's output is quoted to a regulator, and a money path that is
 * *usually* fine under IEEE-754 is exactly the shape of the drift the money
 * module exists to remove. `calculateVatReturn` below and `calculateGratuity`
 * next door already work this way; a single float island in the middle of them
 * is the thing that grows back.
 *
 * **Small Business Relief is not free.** Electing relief means the taxable
 * person is treated as having no taxable income for the period, which is worth
 * nothing to a business that made a loss — and, on my reading, the period's tax
 * losses and disallowed net interest are forfeited rather than carried forward,
 * so a loss-making year spent under relief cannot later shelter a profitable
 * one. That reading is NOT confirmed against Ministerial Decision 73 of 2023 or
 * Article 37 and is not stated in any document in this repo, so the election
 * carries a note telling the accountant to confirm it rather than a computation
 * that assumes it. This is why `lossesUtilised` is 0 on the relief path: no
 * losses are used, and the caller should not read that as "no losses were lost".
 *
 * An estimate for planning. The filing position is the accountant's.
 */
export function calculateCorporateTax(input: CorporateTaxInput): CorporateTaxResult {
  const {
    accountingProfit,
    revenue,
    periodEnd,
    priorPeriodRevenues = [],
    disallowedExpenses = 0,
    lossesBroughtForward = 0,
    electSbr = true,
  } = input;

  const notes: string[] = [];

  // Eligibility is two independent tests, and they are kept apart because the
  // note each failure produces is different: a business over the cap needs to
  // be told it is too big, a business under the cap in 2027 needs to be told
  // the relief itself has gone. Folding them into one boolean is how the
  // expiry note came to be unreachable.
  const overCapPeriods = [revenue, ...priorPeriodRevenues].filter(
    (r) => M.gt(M.money(r), SBR_REVENUE_CAP_M),
  );
  const withinRevenueCap = overCapPeriods.length === 0;
  const sbrStillOffered = periodEnd <= SBR_AVAILABLE_UNTIL;
  const sbrEligible = sbrStillOffered && withinRevenueCap;
  const sbrApplied = sbrEligible && electSbr;

  if (!sbrStillOffered && withinRevenueCap) {
    notes.push(
      `Small Business Relief is no longer available for tax periods ending after ` +
        `${SBR_AVAILABLE_UNTIL}. Revenue is within the cap, but the relief has expired — ` +
        `this is why a business that paid nothing last period pays tax on this one.`,
    );
  }

  if (sbrApplied) {
    notes.push(
      `Small Business Relief elected: revenue of ${revenue.toLocaleString("en-AE")} AED is ` +
        `within the ${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED cap, so the business is ` +
        `treated as having no taxable income for this period.`,
    );
    notes.push(
      `Electing relief may forfeit this period's tax losses and disallowed net interest for ` +
        `carry-forward. Confirm with your tax adviser before electing in a loss-making or ` +
        `heavily geared period — the election is not free.`,
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

  if (!withinRevenueCap && sbrStillOffered) {
    const currentOverCap = M.gt(M.money(revenue), SBR_REVENUE_CAP_M);
    notes.push(
      currentOverCap
        ? `Revenue of ${revenue.toLocaleString("en-AE")} AED exceeds the ` +
            `${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED Small Business Relief cap.`
        : `Revenue this period is within the cap, but ${overCapPeriods.length} earlier ` +
            `period(s) exceeded ${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED. Relief is ` +
            `tested against the current and all prior periods, so it is not available.`,
    );
  }

  const adjusted = M.add(M.money(accountingProfit), M.money(disallowedExpenses));
  if (disallowedExpenses > 0) {
    notes.push(
      `${disallowedExpenses.toLocaleString("en-AE")} AED of disallowed expenses added back.`,
    );
  }

  // Losses may offset at most 75% of taxable income in any period. Quantized
  // here so the cap itself is a storable amount rather than a repeating
  // fraction that then decides how much loss is used.
  const maxLossOffset = M.quantize(M.mul(M.max(M.ZERO, adjusted), LOSS_OFFSET_CAP_M));
  const lossesUtilisedM = M.min(M.money(lossesBroughtForward), maxLossOffset);
  if (M.gt(lossesUtilisedM, M.ZERO)) {
    notes.push(
      `${M.toNumber(lossesUtilisedM).toLocaleString("en-AE")} AED of brought-forward losses ` +
        `used (capped at 75% of taxable income).`,
    );
  }

  const taxableIncomeM = M.max(M.ZERO, M.sub(adjusted, lossesUtilisedM));
  const exemptSliceM = M.min(taxableIncomeM, CT_THRESHOLD_M);
  const taxableSliceM = M.max(M.ZERO, M.sub(taxableIncomeM, CT_THRESHOLD_M));
  const taxDueM = M.quantize(M.mul(taxableSliceM, CT_RATE_M));

  notes.push(
    `First ${CT_THRESHOLD.toLocaleString("en-AE")} AED at 0%; ` +
      `remainder at ${(CT_RATE * 100).toFixed(0)}%.`,
  );

  return {
    accountingProfit,
    taxableIncome: M.toNumber(taxableIncomeM),
    lossesUtilised: M.toNumber(lossesUtilisedM),
    sbrEligible,
    sbrApplied: false,
    exemptSlice: M.toNumber(exemptSliceM),
    taxableSlice: M.toNumber(taxableSliceM),
    taxDue: M.toNumber(taxDueM),
    effectiveRate: M.gt(taxableIncomeM, M.ZERO) ? M.toNumber(M.div(taxDueM, taxableIncomeM)) : 0,
    notes,
  };
}

// ── VAT ─────────────────────────────────────────────────────────────────────

export const VAT_RATE = 0.05;

/** Money-module form of the statutory rate, derived so the two cannot drift. */
const VAT_RATE_M = M.money(String(VAT_RATE));

/**
 * Voluntary-disclosure threshold, AED (PRD-02 §2.3).
 *
 * An error above this on a filed return must be disclosed and costs 1% per
 * month before an audit. It is not used to compute anything — it decides
 * whether the wash-up below tells the accountant to file a disclosure.
 */
export const VOLUNTARY_DISCLOSURE_THRESHOLD = 10_000;

/**
 * WHICH NUMBER THE RECOVERY RATIO IS COMPUTED FROM. **Unconfirmed. Do not change
 * this on a guess — it is worth AED 6,667 a quarter on the portfolio's own
 * numbers.**
 *
 * The ratio in `calculateVatReturn` is `taxable supplies ÷ total supplies`, i.e.
 * turnover, and the code and the VAT screen have both called that "the FTA's
 * standard method" without evidence. There is a reading of the Executive
 * Regulation (Cabinet Decision 52/2017) Article 55 under which the standard
 * method instead works from *input tax amounts*: input tax wholly attributable
 * to taxable supplies ÷ (that plus input tax wholly attributable to exempt
 * supplies). Turnover is the UK partial-exemption standard method, which is
 * where the current formula most likely came from.
 *
 * On directly-attributable input of 50,000 taxable / 10,000 exempt, residual
 * 20,000 and supplies split 1m taxable / 1m exempt:
 *
 *   supplies basis    ratio 50.0%  → residual recovery 10,000
 *   input-tax basis   ratio 83.3%  → residual recovery 16,667
 *
 * AED 6,667 apart in one quarter, past the AED 10,000 voluntary-disclosure
 * threshold within two. Both inputs the alternative needs are already on
 * `VatReturnInput`, so switching is a small change; deciding which is right is
 * not, and nobody on this project has read the regulation text.
 *
 * This constant exists so the basis is *stated* rather than implied — it is
 * surfaced on the VAT screen and written onto every persisted return, so a
 * return filed today can be re-read later knowing which basis produced it.
 * It is deliberately NOT a parameter: a switch would invite someone to flip it
 * without the adviser's answer. Registered for the tax adviser alongside Q-1.
 */
export const APPORTIONMENT_BASIS_IN_USE = "supplies_value" as const;

export type ApportionmentBasis = "supplies_value" | "input_tax_value" | "floorspace";

/**
 * How residual input VAT is apportioned, per FR-C02.
 *
 * A discriminated union rather than a bare string because the two options do not
 * carry the same information. The standard method computes its own ratio from
 * the period's supplies. A special method does not: the FTA approves both the
 * method *and* the basis before it may be used, so a `floorspace` setting that
 * cannot produce an approval reference is not a configuration, it is a claim
 * nobody has authorised. Making the reference part of the type is what stops
 * that state existing — see `resolveApportionmentMethod`.
 *
 * Q-1 (whether to apply for the floorspace method at all) is open. This models
 * the mechanism; it does not decide the question.
 */
export type ApportionmentMethod =
  | { kind: "standard" }
  | {
      kind: "floorspace";
      /** The recovery percentage agreed with the FTA, as a fraction. */
      recoveryRatio: number;
      /** The FTA's written approval for the special method. Required. */
      ftaApprovalReference: string;
    };

export const STANDARD_APPORTIONMENT: ApportionmentMethod = { kind: "standard" };

export interface VatReturnInput {
  /** Standard-rated supplies, net of VAT (VAT201 box 1). */
  standardRatedSupplies: number;
  /**
   * Output VAT on the business's OWN supplies only.
   *
   * Reverse-charge output VAT is computed here from `reverseChargeSupplies`
   * rather than passed in — it is 5% of a net figure by construction, and a
   * caller that adds it to this field would have it counted twice.
   */
  outputVat: number;
  /** Zero-rated supplies (box 4) — 0% but input VAT IS recoverable. */
  zeroRatedSupplies: number;
  /** Exempt supplies (box 5) — residential rent. Input VAT NOT recoverable. */
  exemptSupplies: number;
  /**
   * Imported services under the reverse charge (box 3), NET of VAT.
   *
   * The recipient self-accounts output VAT on this at 5% and reclaims it
   * subject to its own recovery position. For a fully taxable business the two
   * legs net to nil; for this partly-exempt portfolio they do not, which is the
   * whole reason the field is computed rather than echoed.
   */
  reverseChargeSupplies: number;
  /**
   * Of `reverseChargeSupplies`, the part serving taxable supplies only — the
   * self-accounted input VAT on it is recovered in full.
   */
  reverseChargeTaxableAttributed?: number;
  /**
   * Of `reverseChargeSupplies`, the part serving exempt supplies only. FR-C03:
   * "recovery is denied where the supply supports exempt supplies" — output VAT
   * is still due on it, and none of it comes back.
   */
  reverseChargeExemptAttributed?: number;
  /** Input VAT on purchases directly attributable to taxable supplies. */
  directlyAttributableInput: number;
  /** Input VAT on overheads used for both taxable and exempt supplies. */
  residualInput: number;
  /** Input VAT directly attributable to exempt supplies — never recoverable. */
  exemptAttributableInput: number;
  /** Apportionment method in force for the period. Defaults to standard. */
  method?: ApportionmentMethod;
  /**
   * The emirate the supplies are reported under. Box 1 of the real VAT201 is
   * split by emirate; this system reports one, because no supply in the data
   * model carries an emirate of its own. Recorded so the return says which.
   */
  emirate?: string;
}

/**
 * One line of the return as the accountant will transcribe it into EmaraTax.
 *
 * `numberConfirmed` is the load-bearing field. The AMOUNTS here are computed
 * identically either way; what the flag records is whether the FTA box *number*
 * the accountant is about to type this figure into is evidenced by anything in
 * this repository. A wrong amount is a wrong return. A right amount in the
 * wrong box is also a wrong return, and it is the failure mode nobody checks
 * for, because the figure on screen looks correct.
 */
export interface VatReturnLine {
  /** Box number on the FTA VAT201. Empty string for a derived total. */
  no: string;
  key: string;
  label: string;
  net: number;
  vat: number;
  note: string;
  /** True only where a seeded `tax_codes.reporting_code` evidences the number. */
  numberConfirmed: boolean;
  /** Which rows the figure is built from, for box-level drill-through. */
  source: "supplies" | "input_tax" | "reverse_charge" | "derived";
}

export interface VatApportionment {
  method: ApportionmentMethod["kind"];
  basis: ApportionmentBasis;
  ftaApprovalReference: string | null;
  taxableSupplies: number;
  exemptSupplies: number;
  totalSupplies: number;
  ratio: number;
}

export interface VatReturnResult {
  boxes: Record<string, number>;
  /** The same figures, ordered and labelled for the screen and the export. */
  lines: VatReturnLine[];
  apportionment: VatApportionment;
  /**
   * Share of residual input VAT that may be recovered.
   *
   * A 4-decimal VIEW of the ratio, not the ratio the amounts were computed
   * with. `recoverableResidual` below multiplies the full-precision quotient
   * and quantizes once, so re-deriving it as `residualInput x recoveryRatio`
   * can land a fil or two away. That is not a discrepancy in the return — it is
   * why `apportionment` carries the exact numerator and denominator, which are
   * the two figures an FTA officer would ask to see anyway.
   */
  recoveryRatio: number;
  recoverableResidual: number;
  /** 5% self-accounted on imported services. Owed AND (partly) reclaimable. */
  reverseChargeOutputVat: number;
  /** The share of that which comes back, at this period's recovery position. */
  reverseChargeRecoverableInput: number;
  /** Own supplies plus reverse charge — what actually goes out to the FTA. */
  totalOutputVat: number;
  totalRecoverableInput: number;
  irrecoverableInput: number;
  netVatDue: number;
  isRefund: boolean;
  notes: string[];
}

/**
 * Read the tenant's apportionment setting, refusing states that are not
 * authorised rather than falling into them.
 *
 * FR-C02 makes the method a tenant setting with two options. The failure mode
 * this guards is the quiet one: somebody sets `floorspace` because it recovers
 * more, leaves the approval reference blank because the FTA has not answered
 * yet, and the return silently starts claiming on an unapproved special method.
 * That is an assessment finding with a penalty attached, produced by a config
 * screen. So an incomplete floorspace setting falls back to the standard method
 * and says so in a note that reaches the screen — it does not half-apply.
 *
 * Shape, on `tenants.settings`:
 *
 *   { "vat": { "apportionmentMethod": "standard" } }
 *   { "vat": { "apportionmentMethod": "floorspace",
 *              "recoveryRatio": "0.62",
 *              "ftaApprovalReference": "FTA-SM-2026-00017" } }
 *
 * The ratio is read as a decimal string through the money module because it
 * multiplies money; `0.62` arriving as a JSON double and then multiplying a
 * six-figure residual is exactly the drift that module exists to remove.
 */
export function resolveApportionmentMethod(raw: unknown): {
  method: ApportionmentMethod;
  notes: string[];
} {
  const notes: string[] = [];
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const kind = typeof cfg.apportionmentMethod === "string" ? cfg.apportionmentMethod : "standard";

  if (kind === "standard") return { method: STANDARD_APPORTIONMENT, notes };

  if (kind !== "floorspace") {
    notes.push(
      `Unknown apportionment method "${kind}" configured. Using the standard ` +
        `output-based method. Valid values are "standard" and "floorspace".`,
    );
    return { method: STANDARD_APPORTIONMENT, notes };
  }

  const reference =
    typeof cfg.ftaApprovalReference === "string" ? cfg.ftaApprovalReference.trim() : "";
  const rawRatio = cfg.recoveryRatio;
  const ratioText =
    typeof rawRatio === "string" || typeof rawRatio === "number" ? String(rawRatio) : "";

  if (reference === "" || ratioText === "") {
    notes.push(
      `The floorspace method is selected but ${reference === "" ? "no FTA approval reference" : "no agreed recovery ratio"} ` +
        `is recorded. A special apportionment method may only be used once the FTA has approved ` +
        `it in writing, so this return has been prepared on the standard output-based method. ` +
        `Open dependency Q-1.`,
    );
    return { method: STANDARD_APPORTIONMENT, notes };
  }

  let ratio: M.Money;
  try {
    ratio = M.money(ratioText);
  } catch {
    notes.push(
      `The floorspace recovery ratio "${ratioText}" is not a number. Using the standard method.`,
    );
    return { method: STANDARD_APPORTIONMENT, notes };
  }
  if (M.lt(ratio, M.ZERO) || M.gt(ratio, M.money(1))) {
    notes.push(
      `The floorspace recovery ratio "${ratioText}" is not a fraction between 0 and 1. ` +
        `Using the standard method.`,
    );
    return { method: STANDARD_APPORTIONMENT, notes };
  }

  return {
    method: {
      kind: "floorspace",
      recoveryRatio: M.toNumber(ratio),
      ftaApprovalReference: reference,
    },
    notes,
  };
}

/**
 * VAT return position with **input apportionment** and **reverse charge**.
 *
 * This is the part almost every SMB gets wrong, and it is specifically wrong for
 * this portfolio because the residential flats make exempt supplies. Overheads
 * used across both the taxable businesses and the exempt rentals cannot be
 * reclaimed in full: only the taxable proportion is recoverable.
 *
 * Reclaiming 100% of overhead input VAT while renting out residential property
 * is a straightforward assessment risk. Modelling it correctly is worth more
 * than any dashboard widget in this system.
 *
 * **The basis in use is supplies value, and it is not confirmed** — see
 * `APPORTIONMENT_BASIS_IN_USE` above, which is the single place that fact is
 * stated and the value that is written onto every persisted return.
 *
 * **Reverse charge is computed, not echoed.** The field used to be accepted,
 * written to a box, and otherwise ignored: no output VAT was raised on it and no
 * input recovery was computed. For a fully taxable business those two legs net
 * to nil so the omission was presentational; for a partly exempt one they do
 * not, and the return understated VAT due by the irrecoverable share. On
 * AED 100,000 of imported consultancy at a 60% recovery position that is
 * AED 2,000 of tax under-declared and AED 2,000 of cost missing from the P&L.
 */
export function calculateVatReturn(input: VatReturnInput): VatReturnResult {
  const {
    standardRatedSupplies,
    outputVat,
    zeroRatedSupplies,
    exemptSupplies,
    reverseChargeSupplies,
    reverseChargeTaxableAttributed = 0,
    reverseChargeExemptAttributed = 0,
    directlyAttributableInput,
    residualInput,
    exemptAttributableInput,
    method = STANDARD_APPORTIONMENT,
    emirate,
  } = input;

  const notes: string[] = [];

  // Zero-rated supplies count as taxable for apportionment; exempt do not.
  // Exact decimal throughout. The recovery ratio is a division that almost
  // never terminates, and it multiplies the residual input VAT that goes on the
  // return — an error here is a misstated reclaim to the FTA, where a
  // difference above AED 10,000 triggers a mandatory voluntary disclosure.
  const taxable = M.add(M.money(standardRatedSupplies), M.money(zeroRatedSupplies));
  const exempt = M.money(exemptSupplies);
  const totalSup = M.add(taxable, exempt);
  const residual = M.money(residualInput);

  // A no-supplies period recovers in full: there is nothing exempt to restrict.
  const suppliesRatio = M.gt(totalSup, M.ZERO) ? M.div(taxable, totalSup) : M.money(1);
  const ratio = method.kind === "floorspace" ? M.money(method.recoveryRatio) : suppliesRatio;
  const basis: ApportionmentBasis =
    method.kind === "floorspace" ? "floorspace" : APPORTIONMENT_BASIS_IN_USE;

  if (method.kind === "floorspace") {
    notes.push(
      `Apportioned on the floorspace special method at ${M.toDisplay(M.mul(ratio, 100))}%, ` +
        `under FTA approval ${method.ftaApprovalReference}. The period's supplies split would ` +
        `have given ${M.toDisplay(M.mul(suppliesRatio, 100))}%.`,
    );
  }

  // The irrecoverable portion is taken as the REMAINDER of the residual rather
  // than recomputed from (1 - ratio), so recoverable + irrecoverable always
  // equals the residual exactly and the return's own boxes reconcile.
  const recoverableResidualM = M.quantize(M.mul(residual, ratio));
  const irrecoverableResidualM = M.sub(residual, recoverableResidualM);

  // ── Reverse charge ────────────────────────────────────────────────────────
  //
  // Output VAT is due on the whole of box 3 regardless of what the service
  // serves; only the RECOVERY is restricted. Splitting the net value three ways
  // mirrors the input-VAT triple above, and the residual remainder is taken by
  // subtraction so the three parts always re-add to box 3 exactly.
  const rcTotal = M.money(reverseChargeSupplies);
  const rcTaxable = M.money(reverseChargeTaxableAttributed);
  const rcExempt = M.money(reverseChargeExemptAttributed);
  const rcAttributed = M.add(rcTaxable, rcExempt);
  if (M.gt(rcAttributed, rcTotal)) {
    // Refused exactly, never clamped: a clamp here would silently move the
    // difference into the residual bucket and change the tax due.
    throw new Error(
      `Reverse-charge attribution (${M.toDisplay(rcAttributed)}) exceeds reverse-charge ` +
        `supplies (${M.toDisplay(rcTotal)}).`,
    );
  }
  const rcResidual = M.sub(rcTotal, rcAttributed);

  const rcOutputVatM = M.quantize(M.mul(rcTotal, VAT_RATE_M));
  const rcRecoverableM = M.add(
    M.quantize(M.mul(rcTaxable, VAT_RATE_M)),
    M.quantize(M.mul(M.quantize(M.mul(rcResidual, VAT_RATE_M)), ratio)),
  );
  const rcIrrecoverableM = M.sub(rcOutputVatM, rcRecoverableM);

  const totalRecoverableInputM = M.add(
    M.add(M.money(directlyAttributableInput), recoverableResidualM),
    rcRecoverableM,
  );
  const irrecoverableInputM = M.add(
    M.add(M.money(exemptAttributableInput), irrecoverableResidualM),
    rcIrrecoverableM,
  );

  const totalOutputVatM = M.add(M.money(outputVat), rcOutputVatM);
  const netVatDueM = M.sub(totalOutputVatM, totalRecoverableInputM);

  const recoveryRatio = M.toNumber(ratio);
  const recoverableResidual = M.toNumber(recoverableResidualM);
  const totalRecoverableInput = M.toNumber(totalRecoverableInputM);
  const irrecoverableInput = M.toNumber(irrecoverableInputM);
  const reverseChargeOutputVat = M.toNumber(rcOutputVatM);
  const reverseChargeRecoverableInput = M.toNumber(rcRecoverableM);
  const totalOutputVat = M.toNumber(totalOutputVatM);
  const netVatDue = M.toNumber(netVatDueM);

  if (M.gt(exempt, M.ZERO)) {
    notes.push(
      `Exempt (residential) supplies are ` +
        `${M.toDisplay(M.mul(M.div(exempt, totalSup), 100))}% of turnover, so only ` +
        `${M.toDisplay(M.mul(ratio, 100))}% of residual input VAT is recoverable. ` +
        `${M.toDisplay(irrecoverableInputM)} AED is a cost, not a reclaim.`,
    );
  }
  if (M.gt(rcOutputVatM, M.ZERO)) {
    notes.push(
      `${M.toDisplay(rcOutputVatM)} AED of VAT is self-accounted on imported services and ` +
        `${M.toDisplay(rcRecoverableM)} AED of it is reclaimed, leaving ` +
        `${M.toDisplay(rcIrrecoverableM)} AED as a real cost. The two legs only cancel for a ` +
        `fully taxable business.`,
    );
  }

  // Box numbering. Boxes 1, 3, 4 and 5 are evidenced: the seeded tax codes
  // carry `reporting_code` values of VAT201-Box1 / Box3 / Box4 / Box5
  // (packages/db/src/seed/reference.ts), so the mapping from a treatment to a
  // box is a fact in this repository rather than a recollection.
  //
  // Box 9 is NOT evidenced. Nothing in the repo maps recoverable input tax to a
  // box; the FTA form is understood to use box 9 for standard-rated *expenses*
  // and box 13 for total recoverable tax, and WF-05 §10.2 sketches box 9 as
  // "Standard purch." — which agrees. The figure below is right and its box
  // number is a guess inherited from the previous implementation, so it is
  // carried forward unchanged (renumbering on a guess is the same error in the
  // other direction) and flagged instead. Boxes 2, 6–8, 10–12 and 14 are absent
  // entirely and there is nothing in the data model to build them from.
  const emirateNote = emirate
    ? `Reported under the emirate of ${emirate}. The FTA splits box 1 by emirate (1a–1g); ` +
      `no supply in this data model carries an emirate of its own, so the whole box is ` +
      `attributed to the tenant's registered emirate.`
    : "Standard-rated at 5%";

  const lines: VatReturnLine[] = [
    {
      no: "1",
      key: "1_standard_rated_supplies",
      label: "Standard-rated supplies",
      net: standardRatedSupplies,
      vat: outputVat,
      note: emirateNote,
      numberConfirmed: true,
      source: "supplies",
    },
    {
      no: "3",
      key: "3_reverse_charge",
      label: "Supplies subject to the reverse-charge provisions",
      net: reverseChargeSupplies,
      vat: reverseChargeOutputVat,
      note: "Imported services — VAT self-accounted at 5% and reclaimed at the recovery ratio",
      numberConfirmed: true,
      source: "reverse_charge",
    },
    {
      no: "4",
      key: "4_zero_rated",
      label: "Zero-rated supplies",
      net: zeroRatedSupplies,
      vat: 0,
      note: "0% output VAT, but input VAT IS recoverable",
      numberConfirmed: true,
      source: "supplies",
    },
    {
      no: "5",
      key: "5_exempt",
      label: "Exempt supplies",
      net: exemptSupplies,
      vat: 0,
      note: "Residential rent — input VAT NOT recoverable",
      numberConfirmed: true,
      source: "supplies",
    },
    {
      no: "9",
      key: "9_recoverable_input",
      label: "Recoverable input VAT",
      net: 0,
      vat: -totalRecoverableInput,
      note: "After apportionment — box number UNCONFIRMED, see the footnote",
      numberConfirmed: false,
      source: "input_tax",
    },
    {
      no: "",
      key: "total_output_vat",
      label: "Total output VAT due",
      net: 0,
      vat: totalOutputVat,
      note: "Own supplies plus reverse charge",
      numberConfirmed: false,
      source: "derived",
    },
    {
      no: "",
      key: "net_vat_due",
      label: netVatDue < 0 ? "Net VAT refundable" : "Net VAT payable",
      net: 0,
      vat: netVatDue,
      note: "Total output VAT less recoverable input VAT",
      numberConfirmed: false,
      source: "derived",
    },
  ];

  return {
    // Kept as a flat record as well as `lines` because the metric layer, the
    // snapshot tests and the persisted return all index it by key.
    boxes: {
      "1_standard_rated_supplies": standardRatedSupplies,
      "1_output_vat": outputVat,
      "3_reverse_charge": reverseChargeSupplies,
      "3_reverse_charge_output_vat": reverseChargeOutputVat,
      "4_zero_rated": zeroRatedSupplies,
      "5_exempt": exemptSupplies,
      "9_recoverable_input": totalRecoverableInput,
      total_output_vat: totalOutputVat,
      net_vat_due: netVatDue,
    },
    lines,
    apportionment: {
      method: method.kind,
      basis,
      ftaApprovalReference: method.kind === "floorspace" ? method.ftaApprovalReference : null,
      taxableSupplies: M.toNumber(taxable),
      exemptSupplies: M.toNumber(exempt),
      totalSupplies: M.toNumber(totalSup),
      ratio: recoveryRatio,
    },
    recoveryRatio,
    recoverableResidual,
    reverseChargeOutputVat,
    reverseChargeRecoverableInput,
    totalOutputVat,
    totalRecoverableInput,
    irrecoverableInput,
    netVatDue,
    isRefund: netVatDue < 0,
    notes,
  };
}

// ── Annual actual-use wash-up (FR-C02) ──────────────────────────────────────

/** One filed quarter's provisional apportionment, as it went to the FTA. */
export interface QuarterlyProvisional {
  /** Period label as filed, e.g. "2026-Q1". */
  label: string;
  /** The quarter's residual (shared-overhead) input VAT pool. */
  residualInput: number;
  /** What was provisionally recovered out of that pool. */
  recoverableResidual: number;
}

export interface AnnualWashupInput {
  /** Tax year the adjustment belongs to, e.g. "2026". */
  taxYear: string;
  /** Every filed quarter of that year. Fewer than four is a part year. */
  quarters: QuarterlyProvisional[];
  /** Taxable (standard + zero-rated) supplies for the WHOLE year. */
  annualTaxableSupplies: number;
  /** Exempt supplies for the whole year. */
  annualExemptSupplies: number;
  /** Method in force for the adjustment. Defaults to standard. */
  method?: ApportionmentMethod;
}

/** A journal the caller must post; this module computes, it does not post. */
export interface WashupPosting {
  description: string;
  legs: { side: "debit" | "credit"; accountKey: string; amount: number }[];
}

export interface AnnualWashupResult {
  taxYear: string;
  quartersIncluded: string[];
  totalResidualInput: number;
  provisionallyRecovered: number;
  annualRecoveryRatio: number;
  annualRecoverable: number;
  /** Positive = more may be reclaimed. Negative = repayable to the FTA. */
  adjustment: number;
  direction: "additional_recovery" | "repayment" | "nil";
  exceedsVoluntaryDisclosureThreshold: boolean;
  posting: WashupPosting | null;
  notes: string[];
}

/**
 * The annual actual-use adjustment (FR-C02).
 *
 * Each quarter is apportioned provisionally, on that quarter's own supply mix.
 * A portfolio whose exempt rent is steady but whose taxable trade is seasonal
 * recovers too much in a quiet quarter and too little in a busy one; the annual
 * wash-up re-runs the same apportionment over the WHOLE year and adjusts for the
 * difference. It is not an optional refinement — it is how the provisional
 * figures become final.
 *
 * Two decisions worth stating:
 *
 *  1. The annual ratio is computed on the same basis as the quarters
 *     (`APPORTIONMENT_BASIS_IN_USE`). Washing a supplies-basis year up against
 *     an input-tax-basis annual ratio would produce an adjustment that is
 *     entirely an artefact of the change of basis. If that constant ever
 *     changes, the years either side of the change cannot be washed up against
 *     each other and this function is where that has to be handled.
 *
 *  2. The adjustment is the difference between what the year SHOULD have
 *     recovered and what the quarters DID recover — not a re-derivation from
 *     the ratios. Ratios are quantized per quarter; differencing the recovered
 *     amounts is the only form that reconciles to the ledger exactly.
 *
 * `posting` is an instruction, not a posting. Everything financial in this
 * system goes through `postJournal`, which is a service concern; this module is
 * pure and stays that way. The counterparty is account 5720: the provisionally
 * irrecoverable share was expensed there, so recovering more of it reduces that
 * expense and recovering less increases it.
 */
export function calculateAnnualWashup(input: AnnualWashupInput): AnnualWashupResult {
  const {
    taxYear,
    quarters,
    annualTaxableSupplies,
    annualExemptSupplies,
    method = STANDARD_APPORTIONMENT,
  } = input;

  const notes: string[] = [];

  const totalResidualM = M.sum(quarters.map((q) => M.money(q.residualInput)));
  const provisionalM = M.sum(quarters.map((q) => M.money(q.recoverableResidual)));

  const taxable = M.money(annualTaxableSupplies);
  const exempt = M.money(annualExemptSupplies);
  const total = M.add(taxable, exempt);
  const suppliesRatio = M.gt(total, M.ZERO) ? M.div(taxable, total) : M.money(1);
  const annualRatio = method.kind === "floorspace" ? M.money(method.recoveryRatio) : suppliesRatio;

  const annualRecoverableM = M.quantize(M.mul(totalResidualM, annualRatio));
  const adjustmentM = M.sub(annualRecoverableM, provisionalM);

  if (quarters.length === 0) {
    notes.push("No quarters are included for this tax year, so there is nothing to adjust.");
  } else if (quarters.length < 4) {
    notes.push(
      `Only ${quarters.length} of 4 quarters are included for ${taxYear}. The adjustment covers ` +
        `those quarters only and is not the year's final position.`,
    );
  }

  const direction = M.isZero(adjustmentM)
    ? "nil"
    : M.gt(adjustmentM, M.ZERO)
      ? "additional_recovery"
      : "repayment";

  if (direction === "additional_recovery") {
    notes.push(
      `The year's actual supply mix recovers ${M.toDisplay(M.mul(annualRatio, 100))}% of residual ` +
        `input VAT against ${M.toDisplay(annualRecoverableM)} AED, and the quarters recovered ` +
        `${M.toDisplay(provisionalM)} AED. ${M.toDisplay(adjustmentM)} AED may be additionally ` +
        `reclaimed.`,
    );
  } else if (direction === "repayment") {
    notes.push(
      `The quarters recovered ${M.toDisplay(provisionalM)} AED against an annual entitlement of ` +
        `${M.toDisplay(annualRecoverableM)} AED. ${M.toDisplay(M.abs(adjustmentM))} AED is ` +
        `repayable to the FTA.`,
    );
  }

  const exceeds = M.gt(M.abs(adjustmentM), M.money(VOLUNTARY_DISCLOSURE_THRESHOLD));
  if (exceeds) {
    notes.push(
      `The adjustment exceeds the AED ${VOLUNTARY_DISCLOSURE_THRESHOLD.toLocaleString("en-AE")} ` +
        `voluntary-disclosure threshold. Confirm with the accountant whether it goes on the next ` +
        `return or on a voluntary disclosure — the penalty for getting that wrong is 1% per month.`,
    );
  }

  const amount = M.toNumber(M.abs(adjustmentM));
  const posting: WashupPosting | null =
    direction === "nil"
      ? null
      : {
          description: `VAT input-tax annual wash-up ${taxYear} (actual-use adjustment)`,
          legs:
            direction === "additional_recovery"
              ? [
                  { side: "debit", accountKey: "VAT_INPUT", amount },
                  { side: "credit", accountKey: "VAT_IRRECOVERABLE", amount },
                ]
              : [
                  { side: "debit", accountKey: "VAT_IRRECOVERABLE", amount },
                  { side: "credit", accountKey: "VAT_INPUT", amount },
                ],
        };

  return {
    taxYear,
    quartersIncluded: quarters.map((q) => q.label),
    totalResidualInput: M.toNumber(totalResidualM),
    provisionallyRecovered: M.toNumber(provisionalM),
    annualRecoveryRatio: M.toNumber(annualRatio),
    annualRecoverable: M.toNumber(annualRecoverableM),
    adjustment: M.toNumber(adjustmentM),
    direction,
    exceedsVoluntaryDisclosureThreshold: exceeds,
    posting,
    notes,
  };
}
