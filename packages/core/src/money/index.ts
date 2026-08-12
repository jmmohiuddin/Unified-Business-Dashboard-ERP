import Decimal from "decimal.js";

/**
 * MONEY.
 *
 * The database has always been right: `numeric(18,4)`, with a comment saying
 * "never float". The application then threw that away — it read every amount
 * with `Number()`, summed in IEEE-754 doubles, and wrote the result back with
 * `.toFixed(4)` straight into SQL. 53 `Number()` sites and 121 `.toFixed()`
 * calls across the service layer.
 *
 * The tell was the epsilons. Twelve of them, hand-rolled, at three different
 * tolerances on the same money flow — `> 0.005`, `> 0.01`, `> 0.0001`. Nobody
 * writes `alreadyCredited + total > Number(inv.total) + 0.01` from first
 * principles; you write it after float drift has bitten you and you patched
 * around the symptom. The worst of them guarded the double-entry ledger itself:
 * a journal whose float error stayed under half a fils posted *unbalanced*.
 *
 * So money never exists as a `number` between reading it from the database and
 * writing it back.
 *
 * Storage is 4 dp because unit prices, FX rates and percentage commission all
 * round badly at 2; presentation rounds to 2 only at the edge.
 */

// 34 significant digits — comfortably beyond numeric(18,4) for intermediate
// products such as quantity × unit price × (1 + tax rate).
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

export type Money = Decimal;

/** Storage precision, matching `numeric(18,4)`. */
export const SCALE = 4;
/** Presentation precision — currency units. */
export const DISPLAY_SCALE = 2;

/**
 * Banker's rounding for storage.
 *
 * ROUND_HALF_EVEN rather than HALF_UP because half-up is biased upward, and a
 * bias applied a few hundred thousand times across a ledger is a number the
 * accountant cannot reconcile. Presentation uses HALF_UP, which is what a human
 * expects to see on an invoice.
 */
const STORE_ROUNDING = Decimal.ROUND_HALF_EVEN;
const DISPLAY_ROUNDING = Decimal.ROUND_HALF_UP;

export const ZERO: Money = new Decimal(0);

/** Construct from a literal. Use `fromDb` for values that came out of Postgres. */
export function money(value: string | number | Decimal): Money {
  return new Decimal(value);
}

/**
 * Read a `numeric` column.
 *
 * postgres-js returns `numeric` as a *string* precisely so no precision is lost
 * in transit. Passing that string to Decimal preserves it; passing it through
 * `Number()` first is where the loss happened.
 */
export function fromDb(value: string | number | null | undefined): Money {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Decimal(value);
}

/** Serialise for SQL. Always 4 dp, always a string — never interpolate a float. */
export function toDb(value: Money): string {
  return value.toDecimalPlaces(SCALE, STORE_ROUNDING).toFixed(SCALE);
}

/** Round to currency units for display. */
export function toDisplay(value: Money): string {
  return value.toDecimalPlaces(DISPLAY_SCALE, DISPLAY_ROUNDING).toFixed(DISPLAY_SCALE);
}

/** Escape hatch for arithmetic-free consumers (charts, JSON). Never feed this back in. */
export function toNumber(value: Money): number {
  return value.toDecimalPlaces(SCALE, STORE_ROUNDING).toNumber();
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

export const add = (a: Money, b: Money): Money => a.plus(b);
export const sub = (a: Money, b: Money): Money => a.minus(b);
export const mul = (a: Money, b: Money | number): Money => a.times(b);
export const div = (a: Money, b: Money | number): Money => a.dividedBy(b);
export const neg = (a: Money): Money => a.negated();
export const abs = (a: Money): Money => a.absoluteValue();

export const sum = (values: Money[]): Money =>
  values.reduce<Money>((total, v) => total.plus(v), ZERO);

/** Round to storage precision without serialising. */
export const quantize = (a: Money): Money => a.toDecimalPlaces(SCALE, STORE_ROUNDING);

// ── Comparison ──────────────────────────────────────────────────────────────
//
// Exact. There are no tolerances in this module, and adding one would reopen
// exactly the class of bug it exists to close. If two amounts must compare
// equal after rounding, `quantize` them first — explicitly, at the call site.

export const eq = (a: Money, b: Money): boolean => a.equals(b);
export const gt = (a: Money, b: Money): boolean => a.greaterThan(b);
export const gte = (a: Money, b: Money): boolean => a.greaterThanOrEqualTo(b);
export const lt = (a: Money, b: Money): boolean => a.lessThan(b);
export const lte = (a: Money, b: Money): boolean => a.lessThanOrEqualTo(b);
export const isZero = (a: Money): boolean => a.isZero();
export const isNegative = (a: Money): boolean => a.isNegative();
export const cmp = (a: Money, b: Money): number => a.comparedTo(b);
export const min = (a: Money, b: Money): Money => (a.lessThan(b) ? a : b);
export const max = (a: Money, b: Money): Money => (a.greaterThan(b) ? a : b);

/**
 * Split an amount across weights so the parts sum EXACTLY to the whole.
 *
 * The single most common source of one-fils discrepancies in an ERP: VAT
 * apportionment, payment allocation across invoices, inter-business cost
 * sharing. Rounding each share independently loses or invents the remainder —
 * AED 100 split three ways becomes 33.33 × 3 = 99.99, and the missing fils
 * surfaces later as an unbalanced journal nobody can explain.
 *
 * Largest-remainder: floor every share to storage precision, then hand the
 * leftover units out one at a time, largest fractional part first. Ties go to
 * the earlier index, so the result is deterministic — which matters, because a
 * reproducible allocation is testable and a random one is not.
 *
 * Guarantee: `sum(allocate(total, w)) === total`, for any weights.
 */
export function allocate(total: Money, weights: (Money | number)[]): Money[] {
  if (weights.length === 0) return [];

  const ws = weights.map((w) => (w instanceof Decimal ? w : new Decimal(w)));
  const weightTotal = ws.reduce<Money>((t, w) => t.plus(w), ZERO);

  // No weight to distribute by: give everything to the first share rather than
  // dividing by zero or silently returning zeros that do not sum to the whole.
  if (weightTotal.isZero()) {
    return ws.map((_, i) => (i === 0 ? quantize(total) : ZERO));
  }

  const exact = ws.map((w) => total.times(w).dividedBy(weightTotal));
  const floored = exact.map((v) => v.toDecimalPlaces(SCALE, Decimal.ROUND_FLOOR));

  const target = quantize(total);
  const unit = new Decimal(1).dividedBy(new Decimal(10).pow(SCALE));
  let remaining = target.minus(floored.reduce<Money>((t, v) => t.plus(v), ZERO));

  // Order by the fractional part that was discarded, descending.
  const order = exact
    .map((v, i) => ({ i, frac: v.minus(floored[i]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);

  const out = [...floored];
  let k = 0;
  while (remaining.greaterThanOrEqualTo(unit) && order.length > 0) {
    const idx = order[k % order.length]!.i;
    out[idx] = out[idx]!.plus(unit);
    remaining = remaining.minus(unit);
    k++;
  }

  return out;
}
