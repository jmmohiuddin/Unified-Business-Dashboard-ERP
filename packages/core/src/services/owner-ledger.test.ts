import { describe, expect, it } from "vitest";
import type { Tx } from "@nexus/db";
import {
  UNALLOCATED_NAME,
  canViewOwnerLedger,
  countOwnerMovements,
  loadOwnerLedger,
  resolveOwnerLedgerThresholds,
} from "./owner-ledger.ts";

/**
 * THE OWNER LEDGER — the properties that stop it being a running total.
 *
 * Against a stub transaction rather than Postgres, for the reason
 * `cash-sessions.test.ts` gives: everything worth asserting here — the sign
 * conventions, the FIFO walk, the bucket boundaries, whether the group agrees
 * with its own breakdown — is decided in TypeScript from rows that have already
 * been read, so a database adds runtime and no coverage. What the database
 * decides (that the aggregate over `journal_lines` is correct) is exercised
 * against the seeded copy.
 *
 * The two most important tests in this file are negatives:
 *
 *   · `loadOwnerLedger` issues no write. FR-M05 is a read, and 3200 Owner
 *     Drawings is the one account where a stray write would be invisible —
 *     it never reaches the P&L.
 *   · A contribution into one business does NOT settle a drawing taken out of
 *     another. Netting across businesses before ageing is the single mistake
 *     that would make this screen worse than the spreadsheet it replaces,
 *     because it hides exactly the balance the owner needs shown.
 */

/* ── Reading a drizzle `sql` template without a database ──────────────────── */

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

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const PROP = "11111111-1111-4111-8111-111111111111";
const SHOP = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-08-21";

/** A day of owner movement for one business, in the shape the aggregate returns. */
function day(
  bu: { id: string | null; code: string | null; name: string | null; color?: string },
  on: string,
  amounts: { contributed?: string; drawn?: string; opening?: string; movements?: number },
) {
  return {
    bu_id: bu.id,
    code: bu.code,
    name: bu.name,
    color_token: bu.color ?? "indigo",
    on_date: on,
    contributed: amounts.contributed ?? "0",
    drawn: amounts.drawn ?? "0",
    opening: amounts.opening ?? "0",
    movements: amounts.movements ?? 1,
  };
}

const PROPERTIES = { id: PROP, code: "PROP", name: "Properties" };
const MOBILE = { id: SHOP, code: "SHOP", name: "Mobile shop", color: "amber" };

interface StubOptions {
  settings?: Record<string, unknown> | null;
  days?: ReturnType<typeof day>[];
  movements?: Record<string, unknown>[];
  movementCount?: number;
}

/** A transaction that answers the four reads `loadOwnerLedger` makes, and
 *  records every statement so a write would be impossible to miss. */
function stubTx(opts: StubOptions = {}) {
  const statements: string[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query).replace(/\s+/g, " ").trim();
    statements.push(text);

    if (/SELECT settings FROM tenants/i.test(text)) {
      return [{ settings: opts.settings === undefined ? {} : opts.settings }];
    }
    if (/COUNT\(\*\)::int AS n FROM \(/i.test(text)) {
      return [{ n: opts.movementCount ?? (opts.movements?.length ?? 0) }];
    }
    if (/COUNT\(DISTINCT j\.id\)/i.test(text)) {
      return opts.days ?? [];
    }
    if (/p\.payment_number/i.test(text)) {
      return opts.movements ?? [];
    }
    throw new Error(`unstubbed query: ${text}`);
  };

  return { tx: { execute } as unknown as Tx, statements };
}

const load = (opts: StubOptions = {}, args: Parameters<typeof loadOwnerLedger>[1] = { asOf: TODAY }) => {
  const { tx, statements } = stubTx(opts);
  return loadOwnerLedger(tx, args).then((ledger) => ({ ledger, statements }));
};

/* ── It posts nothing ─────────────────────────────────────────────────────── */

describe("loadOwnerLedger writes nothing", () => {
  it("issues no INSERT, UPDATE or DELETE", async () => {
    const { statements } = await load({
      days: [day(PROPERTIES, "2026-02-03", { drawn: "56027" })],
    });
    expect(statements.length).toBeGreaterThan(0);
    for (const text of statements) {
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/i);
    }
  });

  it("never reads or writes an account other than owner capital and drawings", async () => {
    const { statements } = await load({ days: [] });
    const ledgerReads = statements.filter((s) => /journal_lines/i.test(s));
    expect(ledgerReads.length).toBeGreaterThan(0);
    for (const text of ledgerReads) {
      expect(text).toMatch(/system_key IN \('CAPITAL', 'DRAWINGS'\)/);
    }
  });
});

/* ── Q-10 · thresholds ────────────────────────────────────────────────────── */

describe("Q-10 thresholds", () => {
  it("falls back to the stated defaults and says they are not configured", async () => {
    const { tx } = stubTx({ settings: {} });
    const t = await resolveOwnerLedgerThresholds(tx);
    expect(t).toMatchObject({
      staleAfterDays: 90,
      materiality: 50000,
      configured: false,
      staleConfigured: false,
      materialityConfigured: false,
    });
  });

  it("uses the tenant's answer once it exists", async () => {
    const { tx } = stubTx({
      settings: { manualEntry: { ownerLedgerStaleDays: 30, ownerLedgerMaterialityAed: "10000" } },
    });
    const t = await resolveOwnerLedgerThresholds(tx);
    expect(t).toMatchObject({
      staleAfterDays: 30,
      materiality: 10000,
      configured: true,
    });
  });

  it("treats a malformed setting as unanswered rather than throwing", async () => {
    const { tx } = stubTx({
      settings: { manualEntry: { ownerLedgerStaleDays: -5, ownerLedgerMaterialityAed: "not a number" } },
    });
    const t = await resolveOwnerLedgerThresholds(tx);
    expect(t.staleAfterDays).toBe(90);
    expect(t.materiality).toBe(50000);
    expect(t.configured).toBe(false);
  });

  it.todo(
    "Q-10: replace the 90-day / AED 50,000 defaults once the owner and accountant answer",
  );
});

/* ── Sign conventions ─────────────────────────────────────────────────────── */

describe("what in and out mean", () => {
  it("a drawing leaves a NEGATIVE net position — the owner has taken money out", async () => {
    const { ledger } = await load({
      days: [day(PROPERTIES, "2026-08-03", { drawn: "44189" })],
    });
    const prop = ledger.businesses[0]!;
    expect(prop.drawn).toBe(44189);
    expect(prop.contributed).toBe(0);
    expect(prop.net).toBe(-44189);
  });

  it("a contribution leaves a POSITIVE net position — the owner is funding it", async () => {
    const { ledger } = await load({
      days: [day(MOBILE, "2026-08-03", { contributed: "34000" })],
    });
    expect(ledger.businesses[0]!.net).toBe(34000);
  });

  it("opening capital is not a contribution", async () => {
    const { ledger } = await load({
      days: [day(PROPERTIES, "2026-01-01", { opening: "4476121.8172", movements: 0 })],
    });
    const prop = ledger.businesses[0]!;
    expect(prop.openingCapital).toBeCloseTo(4476121.8172, 4);
    expect(prop.contributed).toBe(0);
    expect(prop.net).toBe(0);
    // And it does not start the clock either — a balance untouched since
    // go-live is exactly the case the stale flag exists for.
    expect(prop.lastMovementOn).toBeNull();
    expect(prop.daysSinceLastMovement).toBeNull();
  });
});

/* ── The group agrees with its own breakdown ──────────────────────────────── */

describe("the group is the sum of the rows under it", () => {
  it("reconciles across businesses", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-03-03", { drawn: "31847" }),
        day(MOBILE, "2026-04-03", { contributed: "12000" }),
        day(MOBILE, "2026-05-03", { drawn: "5000" }),
      ],
    });
    const sum = (pick: (b: (typeof ledger.businesses)[number]) => number) =>
      ledger.businesses.reduce((t, b) => t + pick(b), 0);

    expect(ledger.group.contributed).toBe(sum((b) => b.contributed));
    expect(ledger.group.drawn).toBe(sum((b) => b.drawn));
    expect(ledger.group.net).toBe(sum((b) => b.net));
    expect(ledger.group.net).toBe(-24847);
  });

  /**
   * The seeded books post owner drawings with `business_unit_id` NULL. Dropping
   * those rows would leave a by-business list totalling zero underneath a
   * headline saying AED 286,673 drawn, with nothing on screen explaining the
   * difference — a total that disagrees with its own breakdown.
   */
  it("keeps entries with no business as a visible bucket rather than dropping them", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-03-03", { drawn: "10000" }),
        day({ id: null, code: null, name: null }, "2026-04-03", { drawn: "286673" }),
      ],
    });
    const unallocated = ledger.businesses.find((b) => b.businessUnitId === null);
    expect(unallocated?.name).toBe(UNALLOCATED_NAME);
    expect(unallocated?.drawn).toBe(286673);
    expect(ledger.group.drawn).toBe(296673);
  });
});

/* ── FIFO ageing ──────────────────────────────────────────────────────────── */

describe("ageing", () => {
  it("a contribution settles the OLDEST drawing first", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-01-01", { drawn: "10000" }),
        day(PROPERTIES, "2026-08-01", { drawn: "10000" }),
        day(PROPERTIES, "2026-08-15", { contributed: "10000" }),
      ],
    });
    const prop = ledger.businesses[0]!;
    // The January drawing is gone; what is left is August's.
    expect(prop.oldestUnsettledOn).toBe("2026-08-01");
    expect(prop.ageDays).toBe(20);
    expect(prop.net).toBe(-10000);
  });

  it("money out and back in on the same day never starts a clock", async () => {
    const { ledger } = await load({
      days: [day(PROPERTIES, "2026-02-03", { drawn: "5000", contributed: "5000", movements: 2 })],
    });
    const prop = ledger.businesses[0]!;
    expect(prop.net).toBe(0);
    expect(prop.ageDays).toBeNull();
    expect(prop.oldestUnsettledOn).toBeNull();
    // It still counts as a movement — the clock is reset, not the history.
    expect(prop.lastMovementOn).toBe("2026-02-03");
  });

  it("a net contributed position ages nothing", async () => {
    const { ledger } = await load({
      days: [
        day(MOBILE, "2026-01-01", { drawn: "5000" }),
        day(MOBILE, "2026-02-01", { contributed: "20000" }),
      ],
    });
    const shop = ledger.businesses[0]!;
    expect(shop.net).toBe(15000);
    expect(shop.ageDays).toBeNull();
    expect(ledger.ageing.every((b) => b.amount === 0)).toBe(true);
  });

  /** The property that makes the whole screen worth building. */
  it("one business's new capital does not settle another's old drawing", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2025-01-01", { drawn: "47000" }),
        day(MOBILE, "2026-08-01", { contributed: "47000" }),
      ],
    });
    expect(ledger.group.net).toBe(0);
    const aged = ledger.ageing.find((b) => b.amount > 0);
    expect(aged?.key).toBe("aged3");
    expect(aged?.amount).toBe(47000);
    expect(ledger.businesses.find((b) => b.businessUnitId === PROP)!.ageDays).toBe(597);
  });

  it("the group headline age agrees with the table under it", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2025-01-01", { drawn: "47000" }),
        day(MOBILE, "2026-08-01", { contributed: "47000" }),
      ],
    });
    // Netted across businesses the group has nothing outstanding and nothing to
    // age; per business it has a 597-day-old drawing. The stat strip and the
    // ageing table must not tell the reader two different things.
    expect(ledger.group.oldestUnsettledOn).toBe("2025-01-01");
    expect(ledger.group.ageDays).toBe(597);
    expect(ledger.ageing.find((b) => b.amount > 0)?.key).toBe("aged3");
  });

  it("the buckets add up to what is still outstanding", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-08-01", { drawn: "1000" }),
        day(PROPERTIES, "2026-04-01", { drawn: "2000" }),
        day(MOBILE, "2025-06-01", { drawn: "4000" }),
      ],
    });
    const bucketed = ledger.ageing.reduce((t, b) => t + b.amount, 0);
    expect(bucketed).toBe(7000);
    expect(ledger.group.net).toBe(-7000);
  });

  it("bands are derived from the staleness threshold, so they move with Q-10", async () => {
    const { ledger } = await load({
      settings: { manualEntry: { ownerLedgerStaleDays: 30 } },
      days: [],
    });
    expect(ledger.ageing.map((b) => b.label)).toEqual([
      "Up to 30 days",
      "31 to 60 days",
      "61 to 120 days",
      "Over 120 days",
    ]);
  });
});

/* ── The two flags ────────────────────────────────────────────────────────── */

describe("flags", () => {
  it("flags a balance untouched for longer than the staleness threshold", async () => {
    const { ledger } = await load({
      days: [day(PROPERTIES, "2026-04-01", { drawn: "47000" })],
    });
    const prop = ledger.businesses[0]!;
    expect(prop.daysSinceLastMovement).toBe(142);
    expect(prop.isStale).toBe(true);
    expect(ledger.flagged).toHaveLength(1);
  });

  it("does not flag a settled business as stale, however long it has been quiet", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2025-01-01", { drawn: "10000" }),
        day(PROPERTIES, "2025-01-05", { contributed: "10000" }),
      ],
    });
    const prop = ledger.businesses[0]!;
    expect(prop.net).toBe(0);
    expect(prop.isStale).toBe(false);
    expect(ledger.flagged).toHaveLength(0);
  });

  it("materiality applies to money DRAWN, not to money put in", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-08-20", { drawn: "60000" }),
        day(MOBILE, "2026-08-20", { contributed: "60000" }),
      ],
    });
    expect(ledger.businesses.find((b) => b.businessUnitId === PROP)!.isMaterial).toBe(true);
    expect(ledger.businesses.find((b) => b.businessUnitId === SHOP)!.isMaterial).toBe(false);
  });

  it("the threshold is a strict bound — exactly at it is not material", async () => {
    const { ledger } = await load({
      days: [day(PROPERTIES, "2026-08-20", { drawn: "50000" })],
    });
    expect(ledger.businesses[0]!.isMaterial).toBe(false);
  });
});

/* ── Movements ────────────────────────────────────────────────────────────── */

describe("the movement list", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    journal_number: "JV-011817",
    on_date: "2026-02-03",
    narration: "Owner drawings",
    bu_id: PROP,
    bu_name: "Properties",
    color_token: "indigo",
    in_amount: "0",
    out_amount: "56027",
    payment_number: "DRAW-PROP-0001",
    ...over,
  });

  it("reads direction off the legs, not off the narration", async () => {
    const { ledger } = await load({
      movements: [row(), row({ id: "b", in_amount: "15000", out_amount: "0", narration: "x" })],
    });
    expect(ledger.movements[0]).toMatchObject({ direction: "out", amount: 56027 });
    expect(ledger.movements[1]).toMatchObject({ direction: "in", amount: 15000 });
  });

  it("carries the payment number when the entry came through the cash screen", async () => {
    const { ledger } = await load({ movements: [row()] });
    expect(ledger.movements[0]!.reference).toBe("DRAW-PROP-0001");
  });

  it("labels an entry with no business rather than showing a blank", async () => {
    const { ledger } = await load({
      movements: [row({ bu_id: null, bu_name: null, color_token: null })],
    });
    expect(ledger.movements[0]!.businessUnitName).toBe(UNALLOCATED_NAME);
  });

  it("filters the list to one business, and only the list", async () => {
    const { statements } = await load(
      { days: [day(PROPERTIES, "2026-03-03", { drawn: "1" })], movements: [] },
      { asOf: TODAY, businessUnitId: PROP },
    );
    // The by-business totals must NOT narrow with the list filter: the point of
    // the screen is the comparison, and a filtered headline would silently
    // become a different, smaller claim.
    const aggregate = statements.find((s) => /COUNT\(DISTINCT j\.id\)/.test(s))!;
    expect(aggregate).not.toMatch(/jl\.business_unit_id = /);
    expect(statements.filter((s) => /jl\.business_unit_id = /.test(s))).toHaveLength(1);
  });

  it("counts over exactly the same filter the list uses", async () => {
    const { tx, statements } = stubTx({ movementCount: 7 });
    await countOwnerMovements(tx, { asOf: TODAY, businessUnitId: "unallocated" });
    await loadOwnerLedger(tx, { asOf: TODAY, businessUnitId: "unallocated" });
    const filtered = statements.filter((s) => /jl\.business_unit_id IS NULL/.test(s));
    // The count and the page. A count taken over a wider set than the rows it
    // labels produces a pager promising pages that render empty.
    expect(filtered).toHaveLength(2);
  });
});

/* ── The conclusion line ──────────────────────────────────────────────────── */

describe("the sentence WF-05 §5 asks for", () => {
  it("names both sides when money moves both ways", async () => {
    const { ledger } = await load({
      days: [
        day(PROPERTIES, "2026-08-01", { drawn: "47000" }),
        day(MOBILE, "2026-08-02", { contributed: "34000" }),
      ],
    });
    expect(ledger.conclusion).toBe(
      "You take money out of Properties and put money into Mobile shop.",
    );
  });

  it("says nothing when there is nothing to say", async () => {
    const { ledger } = await load({ days: [] });
    expect(ledger.conclusion).toBeNull();
  });

  it("does not build a sentence out of the unallocated bucket", async () => {
    const { ledger } = await load({
      days: [
        day({ id: null, code: null, name: null }, "2026-08-01", { drawn: "47000" }),
        day(MOBILE, "2026-08-02", { contributed: "34000" }),
      ],
    });
    expect(ledger.conclusion).toBeNull();
  });
});

/* ── Access ───────────────────────────────────────────────────────────────── */

describe("who can see it", () => {
  it("needs report:read", () => {
    expect(canViewOwnerLedger(new Set(["report:read"]))).toBe(true);
    expect(canViewOwnerLedger(new Set(["payment:create"]))).toBe(false);
    expect(canViewOwnerLedger(new Set())).toBe(false);
  });
});
