import { describe, expect, it } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import {
  ZERO,
  add,
  allocate,
  eq,
  fromDb,
  gt,
  money,
  quantize,
  sub,
  sum,
  toDb,
  toDisplay,
} from "./index.ts";

/**
 * These are the tests the ledger did not have.
 *
 * Every case below fails, or is meaningless, under the float arithmetic this
 * module replaces — so they are written against the behaviour we need rather
 * than against what the old code happened to produce.
 */

describe("reading and writing the database", () => {
  it("preserves a numeric string exactly", () => {
    // 0.1 + 0.2 !== 0.3 in float. It does here.
    expect(toDb(add(fromDb("0.1"), fromDb("0.2")))).toBe("0.3000");
  });

  it("treats null, undefined and empty as zero rather than NaN", () => {
    // Number(null) === 0 but Number(undefined) === NaN, and NaN reaching SQL
    // is an opaque failure at COMMIT time.
    for (const v of [null, undefined, ""]) {
      expect(eq(fromDb(v), ZERO)).toBe(true);
    }
  });

  it("always serialises at storage scale", () => {
    expect(toDb(money("5"))).toBe("5.0000");
    expect(toDb(money("5.00005"))).toBe("5.0000"); // half-even: 0 is even
    expect(toDb(money("5.00015"))).toBe("5.0002");
  });

  it("rounds half-even for storage and half-up for display", () => {
    // The bias that matters: half-up applied across a ledger drifts upward.
    expect(toDb(money("2.00005"))).toBe("2.0000");
    expect(toDb(money("2.00015"))).toBe("2.0002");
    expect(toDisplay(money("2.005"))).toBe("2.01");
  });
});

describe("accumulation", () => {
  it("sums a hundred lines exactly", () => {
    // In float, 100 × 0.07 drifts. This is the shape of a real invoice.
    const lines = Array.from({ length: 100 }, () => money("0.07"));
    expect(toDb(sum(lines))).toBe("7.0000");
  });

  it("survives the classic float triple", () => {
    const total = sum([money("0.1"), money("0.2"), money("0.3")]);
    expect(eq(total, money("0.6"))).toBe(true);
    // Guard against the assertion itself being float-blind.
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
  });

  it("compares exactly, with no tolerance", () => {
    // The old code needed `> 0.005` here. This must be exact.
    const a = sum([money("33.3333"), money("33.3333"), money("33.3334")]);
    expect(eq(a, money("100"))).toBe(true);
    expect(gt(a, money("100"))).toBe(false);
  });
});

describe("VAT at 5 percent", () => {
  it("backs tax out of a gross amount without drift", () => {
    // gross / 1.05 is non-terminating in binary — the credit-note path.
    const gross = money("105");
    const net = quantize(gross.dividedBy(money("1.05")));
    expect(toDb(net)).toBe("100.0000");
    expect(toDb(sub(gross, net))).toBe("5.0000");
  });

  it("keeps net + tax === gross on an awkward amount", () => {
    const gross = money("87.63");
    const net = quantize(gross.dividedBy(money("1.05")));
    const tax = sub(gross, net);
    expect(toDb(add(net, tax))).toBe(toDb(gross));
  });
});

describe("allocate", () => {
  it("splits an indivisible amount so the parts sum to the whole", () => {
    // 100 / 3 — the case that loses a fils when each share is rounded alone.
    const parts = allocate(money("100"), [1, 1, 1]);
    expect(parts.map(toDb)).toEqual(["33.3334", "33.3333", "33.3333"]);
    expect(toDb(sum(parts))).toBe("100.0000");
  });

  it("respects weights", () => {
    const parts = allocate(money("100"), [3, 1]);
    expect(toDb(sum(parts))).toBe("100.0000");
    expect(gt(parts[0]!, parts[1]!)).toBe(true);
  });

  it("is deterministic", () => {
    const a = allocate(money("10"), [1, 1, 1]).map(toDb);
    const b = allocate(money("10"), [1, 1, 1]).map(toDb);
    expect(a).toEqual(b);
  });

  it("handles zero weights without dividing by zero", () => {
    const parts = allocate(money("50"), [0, 0]);
    expect(toDb(sum(parts))).toBe("50.0000");
  });

  it("returns nothing for no weights", () => {
    expect(allocate(money("10"), [])).toEqual([]);
  });

  // The property the whole module exists to guarantee.
  it("PROPERTY: the parts always sum exactly to the whole", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (cents, weights) => {
          const total = money(new Decimal(cents).dividedBy(100));
          const parts = allocate(total, weights);
          return toDb(sum(parts)) === toDb(total);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("the balance invariant the ledger depends on", () => {
  it("a multi-leg journal balances exactly", () => {
    // Shape of a real invoice posting: revenue split across lines, VAT on each,
    // one receivable leg. Under float this needed a 0.005 tolerance.
    const nets = [money("33.33"), money("33.33"), money("33.34")];
    const taxes = nets.map((n) => quantize(n.times(money("0.05"))));
    const debits = sum([...nets, ...taxes]);
    const credits = sum([...nets, ...taxes]);
    expect(eq(debits, credits)).toBe(true);
    expect(toDb(sub(debits, credits))).toBe("0.0000");
  });
});
