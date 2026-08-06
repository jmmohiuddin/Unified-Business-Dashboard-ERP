/**
 * Presentation helpers.
 *
 * Formatting lives in shared code, not in components, because "how much money
 * is this" must look identical on the dashboard, in a PDF tax invoice, in a
 * WhatsApp reminder and in an AI answer. Divergent formatting is how users lose
 * trust in a number that is actually correct.
 */

const CURRENCY_SYMBOL: Record<string, string> = {
  AED: "AED ",
  USD: "$",
  SAR: "SAR ",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  BDT: "৳",
  PKR: "Rs ",
};

/**
 * Currencies that use the South Asian lakh/crore scale rather than K/M/B.
 *
 * AED is deliberately NOT in this list. Dubai is full of South Asian business
 * owners, but AED is quoted in thousands and millions in every contract, bank
 * statement and Ejari certificate here — writing "AED 12 L" would look wrong to
 * the same people who read "১২ লাখ" naturally in BDT.
 */
const SOUTH_ASIAN_SCALE = new Set(["BDT", "INR", "PKR", "NPR", "LKR"]);

/** Compact money for dashboard tiles. */
export function formatMoneyCompact(value: number, currency = "AED"): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (SOUTH_ASIAN_SCALE.has(currency)) {
    if (abs >= 1e7) return `${sign}${sym}${trim(abs / 1e7)} Cr`;
    if (abs >= 1e5) return `${sign}${sym}${trim(abs / 1e5)} L`;
    if (abs >= 1e3) return `${sign}${sym}${trim(abs / 1e3)}k`;
  } else {
    if (abs >= 1e9) return `${sign}${sym}${trim(abs / 1e9)}B`;
    if (abs >= 1e6) return `${sign}${sym}${trim(abs / 1e6)}M`;
    if (abs >= 1e4) return `${sign}${sym}${trim(abs / 1e3)}k`;
  }
  // Below 10k, show the exact figure — at AED scale these are amounts an owner
  // recognises individually (a haircut, a service call, a month's parking).
  return `${sign}${sym}${Math.round(abs).toLocaleString("en-AE")}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

/** Full precision. AED is quoted to 2 decimals on every tax invoice. */
export function formatMoney(value: number, currency = "AED", dp = 2): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${value < 0 ? "-" : ""}${sym}${Math.abs(value).toLocaleString("en-AE", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function formatPercent(ratio: number | null | undefined, dp = 1): string {
  if (ratio === null || ratio === undefined) return "—";
  return `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(dp)}%`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-AE");
}

export function formatMetricValue(
  value: number,
  unit: string,
  currency = "AED",
  compact = true,
): string {
  switch (unit) {
    case "currency":
      return compact ? formatMoneyCompact(value, currency) : formatMoney(value, currency);
    case "percent":
      return `${value.toFixed(1)}%`;
    case "score":
      return String(Math.round(value));
    case "days":
      return `${Math.round(value)}d`;
    case "ratio":
      return value.toFixed(2);
    default:
      return formatCount(value);
  }
}

export function relativeDay(iso: string, today: string): string {
  const diff = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff < 0) return `${-diff} days ago`;
  return `in ${diff} days`;
}

/** Days until a date — negative means already expired. Used by the compliance
 *  watchlist for trade licences, visas and Ejari renewals. */
export function daysUntil(iso: string, today: string): number {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}
