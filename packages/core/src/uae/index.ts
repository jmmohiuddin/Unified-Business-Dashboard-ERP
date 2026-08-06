/**
 * UAE localisation pack.
 *
 * Everything jurisdiction-specific lives behind this boundary so a second
 * country is a sibling directory rather than a rewrite. Nothing outside
 * `uae/` should hard-code a VAT rate, a gratuity formula or a filing format.
 */
export * from "./gratuity.ts";
export * from "./wps.ts";
export * from "./tax.ts";

/** Emirates, in the order the FTA lists them on the VAT201 return. */
export const EMIRATES = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Umm Al Quwain",
  "Ras Al Khaimah",
  "Fujairah",
] as const;

export type Emirate = (typeof EMIRATES)[number];

/** Cheque counts a Dubai tenancy is normally negotiated in. Fewer cheques
 *  usually buys a lower annual rent; twelve carries a premium. */
export const CHEQUE_OPTIONS = [1, 2, 3, 4, 6, 12] as const;

/**
 * Dubai security-deposit convention: 5% of annual rent for unfurnished,
 * 10% furnished. Not statute, but universal practice and what a tenant expects.
 */
export function standardDepositRate(furnished: boolean): number {
  return furnished ? 0.1 : 0.05;
}

/** Emirates ID format: 784-YYYY-NNNNNNN-C */
export function isValidEmiratesId(value: string): boolean {
  return /^784-\d{4}-\d{7}-\d$/.test(value.trim());
}

/** UAE IBAN: AE + 2 check digits + 3-digit bank code + 16-digit account. */
export function isValidUaeIban(value: string): boolean {
  return /^AE\d{21}$/.test(value.replace(/\s/g, ""));
}

/** UAE VAT TRN is 15 digits. */
export function isValidTrn(value: string): boolean {
  return /^\d{15}$/.test(value.replace(/\s/g, ""));
}
