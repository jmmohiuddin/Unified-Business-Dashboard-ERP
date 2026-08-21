import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as M from "../money/index.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";
import {
  assertPeriodOpenNamed,
  postManualJournal,
  recordCashPayment,
  recordOwnerDrawing,
  reverseEntry,
  splitVatInclusive,
} from "./manual-entry.ts";

/**
 * MANUAL-ENTRY GUARD TESTS.
 *
 * What is proved here is everything the module refuses, plus the one piece of
 * arithmetic it does before any database is involved. The journal SHAPES — that
 * a drawing debits 3200 and credits cash, that an exempt cash repair reclaims
 * nothing — are proved against the seeded ledger, because a stub that returns
 * the accounts the test expects proves only that the stub agrees with itself.
 *
 * These run against a stub transaction so they belong in `test:unit`, which
 * runs on every commit whether or not a Postgres is reachable. The refusals are
 * the part that has to be checked on every commit: each one is a control, and a
 * control that stops firing fails silently by definition — a cash module whose
 * EC-13 check quietly stopped working looks exactly like one where nobody
 * happened to overdraw a till.
 *
 * `writes` is what proves a refusal refused. A guard that throws after the
 * INSERT has landed is not a guard.
 */

const TENANT = "dddddddd-4444-4444-b444-444444444444";
const ACTOR = "aaaaaaaa-1111-4111-8111-111111111111";
const BU = "bbbbbbbb-2222-4222-9222-222222222222";
const JOURNAL = "cccccccc-3333-4333-a333-333333333333";

/** The literal fragments of a drizzle `sql` template, parameters elided. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = c && typeof c === "object" ? (c as { value?: unknown }).value : undefined;
      return Array.isArray(v) ? v.join(" ") : "";
    })
    .join(" ");
}

interface StubOptions {
  /** `tenants.settings -> manualEntry`. */
  settings?: Record<string, unknown>;
  /** Ledger balance the cash-floor check will read. */
  cashBalance?: string;
  /** The fiscal period covering the posting date, if any. */
  period?: { label: string; status: string; closed_by: string | null; closed_on: string | null };
  /** The journal `reverseEntry` will find. */
  journal?: Record<string, unknown>;
}

function stubTx(options: StubOptions = {}) {
  const writes: string[] = [];

  const execute = async (query: unknown) => {
    const text = sqlText(query);

    if (/FROM tenants/i.test(text)) {
      return [{ settings: options.settings ? { manualEntry: options.settings } : {} }];
    }
    if (/FROM fiscal_periods/i.test(text)) {
      return options.period ? [options.period] : [];
    }
    if (/SUM\(jl.base_debit - jl.base_credit\)/i.test(text)) {
      return [{ balance: options.cashBalance ?? "0" }];
    }
    if (/FROM business_units WHERE id/i.test(text)) {
      return [{ code: "SALON", name: "Royal Cuts Gents Salon" }];
    }
    if (/FROM journals WHERE id/i.test(text)) {
      return options.journal ? [options.journal] : [];
    }
    // Everything else is a write. Record the leading words so a refusal that
    // leaked an INSERT is visible in the assertion.
    writes.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return { writes, tx: { execute } as unknown as ServiceContext["tx"] };
}

function ctxWith(permissions: string[], tx: ServiceContext["tx"]): ServiceContext {
  const principal: Principal = {
    userId: ACTOR,
    tenantId: TENANT,
    membershipId: "eeeeeeee-5555-4555-8555-555555555555",
    roleKey: "branch_manager",
    roleLevel: 60,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: new Set(permissions),
    isPlatformAdmin: false,
  };
  return { tx, tenantId: TENANT, principal, today: "2026-08-21", baseCurrency: "AED" };
}

async function attempt<T>(fn: () => Promise<T>) {
  return fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

const asError = (r: { ok: false; error: unknown }) => r.error as ServiceError;

// ── FR-M08 · the manual journal's four refusals ─────────────────────────────

describe("postManualJournal", () => {
  const balanced = [
    { accountKey: "PROFESSIONAL", businessUnitId: BU, debit: 7500 },
    { accountKey: "AP", businessUnitId: BU, credit: 7500 },
  ];

  it("is refused outright without journal:post", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["payment:create"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "Accrue the audit fee",
        lines: balanced,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).code).toBe("forbidden");
    // The gate runs before anything is read, let alone written.
    expect(stub.writes).toEqual([]);
  });

  it("refuses an entry that does not balance, and says by how much", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["journal:post"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "Accrue the audit fee",
        lines: [
          { accountKey: "PROFESSIONAL", businessUnitId: BU, debit: 7500 },
          { accountKey: "AP", businessUnitId: BU, credit: 7000 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("difference of 500.00");
    expect(stub.writes).toEqual([]);
  });

  it("refuses a half-fils imbalance rather than absorbing it", async () => {
    // The defect this module must not reintroduce: `Math.abs(d - c) > 0.005`
    // let a journal post unbalanced and wrote the drift into the ledger.
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["journal:post"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "Rounding difference",
        lines: [
          { accountKey: "PROFESSIONAL", businessUnitId: BU, debit: 100.001 },
          { accountKey: "AP", businessUnitId: BU, credit: 100 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("does not balance");
    expect(stub.writes).toEqual([]);
  });

  it("refuses a blank narrative, including one made of whitespace", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["journal:post"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "   ",
        lines: balanced,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("blank narrative");
    expect(stub.writes).toEqual([]);
  });

  it("refuses a line carrying both a debit and a credit", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["journal:post"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "Both sides on one line",
        lines: [
          { accountKey: "PROFESSIONAL", businessUnitId: BU, debit: 100, credit: 40 },
          { accountKey: "AP", businessUnitId: BU, credit: 60 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("Split it into two lines");
    expect(stub.writes).toEqual([]);
  });

  it("refuses a line with no amount at all", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      postManualJournal(ctxWith(["journal:post"], stub.tx), {
        postingDate: "2026-08-21",
        narration: "Typo line",
        lines: [
          { accountKey: "PROFESSIONAL", businessUnitId: BU },
          { accountKey: "AP", businessUnitId: BU },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("Line 1 has no amount");
    expect(stub.writes).toEqual([]);
  });
});

// ── Period lock, with a message somebody can act on ─────────────────────────

describe("assertPeriodOpenNamed", () => {
  it("names the period and who closed it", async () => {
    const stub = stubTx({
      period: { label: "Jul 2026", status: "closed", closed_by: "Priya Nair", closed_on: "03 Aug 2026" },
    });
    const r = await attempt(() =>
      assertPeriodOpenNamed(ctxWith(["journal:post"], stub.tx), "2026-07-14"),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).code).toBe("period_closed");
    const message = r.ok === false ? asError(r).message : "";
    expect(message).toContain("Jul 2026 is closed");
    expect(message).toContain("Priya Nair closed it on 03 Aug 2026");
  });

  it("still refuses when nobody is recorded as having closed it", async () => {
    const stub = stubTx({
      period: { label: "Jul 2026", status: "closed", closed_by: null, closed_on: null },
    });
    await expect(
      assertPeriodOpenNamed(ctxWith(["journal:post"], stub.tx), "2026-07-14"),
    ).rejects.toThrow(/Jul 2026 is closed/);
  });

  it("passes when no period covers the date, rather than inventing one", async () => {
    // A tenant that has not set up fiscal periods must still be able to record
    // cash. `postJournal` re-checks, so this is not the only gate.
    const stub = stubTx();
    await expect(
      assertPeriodOpenNamed(ctxWith(["journal:post"], stub.tx), "2026-08-21"),
    ).resolves.toBeUndefined();
  });
});

// ── EC-13 · a cash point may not go negative ────────────────────────────────

describe("EC-13 cash floor", () => {
  const payment = {
    businessUnitId: BU,
    amount: 400,
    paidOn: "2026-08-21",
    category: "repairs" as const,
  };

  it("refuses the payment and states the balance, the shortfall and the way out", async () => {
    const stub = stubTx({ cashBalance: "150.0000" });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create"], stub.tx), payment),
    );
    expect(r.ok).toBe(false);
    const message = r.ok === false ? asError(r).message : "";
    expect(message).toContain("holds 150.00");
    expect(message).toContain("short by 250.00");
    expect(message).toContain("with a reason");
    expect(stub.writes).toEqual([]);
  });

  it("refuses an override from someone who cannot void a payment", async () => {
    const stub = stubTx({ cashBalance: "0" });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create"], stub.tx), {
        ...payment,
        overrideReason: "The morning float was never entered into the system.",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).code).toBe("forbidden");
    expect(r.ok === false && asError(r).message).toContain("Only a manager");
    expect(stub.writes).toEqual([]);
  });

  it("refuses an override whose reason is not a reason", async () => {
    const stub = stubTx({ cashBalance: "0" });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create", "payment:void"], stub.tx), {
        ...payment,
        overrideReason: "ok",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("Say what happened");
    expect(stub.writes).toEqual([]);
  });

  it("lets an exactly-zero balance through — the floor is a floor, not a margin", async () => {
    const stub = stubTx({ cashBalance: "400.0000" });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create"], stub.tx), payment),
    );
    // It gets past the floor check; the stub has no accounts table, so the
    // posting itself fails afterwards. What matters is that it was not refused
    // BY THE FLOOR.
    expect(r.ok === false && asError(r).message).not.toContain("below zero");
  });

  it("honours a configured floor above zero", async () => {
    const stub = stubTx({ cashBalance: "1000.0000", settings: { cashFloorAed: "800" } });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create"], stub.tx), payment),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("below its floor of 800.00");
    expect(stub.writes).toEqual([]);
  });

  it("falls back to the default floor when the setting is nonsense", async () => {
    const stub = stubTx({ cashBalance: "1000.0000", settings: { cashFloorAed: "eight hundred" } });
    const r = await attempt(() =>
      recordCashPayment(ctxWith(["payment:create"], stub.tx), payment),
    );
    // Default floor is zero, so 1000 - 400 is fine and the floor does not
    // refuse. A malformed setting must not make cash unrecordable.
    expect(r.ok === false && asError(r).message).not.toContain("below");
  });

  it("applies to an owner drawing taken out of a till, not just to expenses", async () => {
    const stub = stubTx({ cashBalance: "1000.0000" });
    const r = await attempt(() =>
      recordOwnerDrawing(ctxWith(["payment:create"], stub.tx), {
        businessUnitId: BU,
        amount: 5000,
        onDate: "2026-08-21",
        via: "cash",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("short by 4000.00");
    expect(stub.writes).toEqual([]);
  });
});

// ── FR-M09 · what may and may not be reversed ───────────────────────────────

describe("reverseEntry", () => {
  const base = {
    id: JOURNAL,
    journal_number: "JV-011957",
    source: "manual",
    source_table: "payments",
    source_id: "11111111-1111-4111-8111-111111111111",
    posting_date: "2026-08-21",
    narration: "Cash received",
    is_reversed: false,
    reverses_journal_id: null,
  };

  it("is refused without journal:reverse", async () => {
    const stub = stubTx({ journal: base });
    const r = await attempt(() =>
      reverseEntry(ctxWith(["payment:create"], stub.tx), {
        journalId: JOURNAL,
        reason: "Rang it up twice",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).code).toBe("forbidden");
    expect(stub.writes).toEqual([]);
  });

  it("refuses to reverse the same entry twice", async () => {
    const stub = stubTx({ journal: { ...base, is_reversed: true } });
    const r = await attempt(() =>
      reverseEntry(ctxWith(["journal:reverse"], stub.tx), {
        journalId: JOURNAL,
        reason: "Rang it up twice",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).code).toBe("conflict");
    expect(r.ok === false && asError(r).message).toContain("already been reversed");
    expect(stub.writes).toEqual([]);
  });

  it("refuses to reverse a reversal", async () => {
    const stub = stubTx({
      journal: { ...base, reverses_journal_id: "22222222-2222-4222-9222-222222222222" },
    });
    const r = await attempt(() =>
      reverseEntry(ctxWith(["journal:reverse"], stub.tx), {
        journalId: JOURNAL,
        reason: "Undo the undo",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("is itself a reversal");
    expect(stub.writes).toEqual([]);
  });

  it("names the right path instead of reversing an invoice's journal", async () => {
    // Reversing half of an event is worse than the error being corrected: the
    // document would still say paid while the ledger said the sale never
    // happened.
    const stub = stubTx({
      journal: { ...base, source: "invoice", source_table: "documents" },
    });
    const r = await attempt(() =>
      reverseEntry(ctxWith(["journal:reverse"], stub.tx), {
        journalId: JOURNAL,
        reason: "Wrong customer",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && asError(r).message).toContain("credit note");
    expect(stub.writes).toEqual([]);
  });

  it("names the right path for payroll too", async () => {
    const stub = stubTx({ journal: { ...base, source: "payroll" } });
    const r = await attempt(() =>
      reverseEntry(ctxWith(["journal:reverse"], stub.tx), {
        journalId: JOURNAL,
        reason: "Wrong month",
      }),
    );
    expect(r.ok === false && asError(r).message).toContain("payroll run");
    expect(stub.writes).toEqual([]);
  });

  it("refuses an entry that does not exist rather than posting a phantom", async () => {
    const stub = stubTx();
    const r = await attempt(() =>
      reverseEntry(ctxWith(["journal:reverse"], stub.tx), {
        journalId: JOURNAL,
        reason: "Whatever",
      }),
    );
    expect(r.ok === false && asError(r).code).toBe("not_found");
    expect(stub.writes).toEqual([]);
  });
});

// ── The one piece of arithmetic ─────────────────────────────────────────────

describe("splitVatInclusive", () => {
  it("takes the tax out of the cash rather than adding it on", () => {
    const { net, vat } = splitVatInclusive(M.money(210), M.money("0.05"));
    expect(M.toDisplay(net)).toBe("200.00");
    expect(M.toDisplay(vat)).toBe("10.00");
  });

  it("leaves an exempt receipt entirely as revenue", () => {
    const { net, vat } = splitVatInclusive(M.money(5000), M.ZERO);
    expect(M.toDisplay(net)).toBe("5000.00");
    expect(M.isZero(vat)).toBe(true);
  });

  it("always adds back up to the cash that changed hands", () => {
    // The property that matters: the journal has to balance against a cash leg
    // that is exact, so a fils lost to independent rounding is an unbalanced
    // entry, not a presentation nicety.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.constantFrom("0.05", "0.00"),
        (fils, rate) => {
          const gross = M.div(M.money(fils), 100);
          const { net, vat } = splitVatInclusive(gross, M.money(rate));
          return M.eq(M.quantize(M.add(net, vat)), M.quantize(gross));
        },
      ),
      { numRuns: 500 },
    );
  });
});
