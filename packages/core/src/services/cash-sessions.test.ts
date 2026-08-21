import { describe, expect, it } from "vitest";
import {
  acknowledgeCashVariance,
  assertBlind,
  loadCashBoard,
  openCashSession,
  resolveCashVarianceThreshold,
  submitCashCount,
} from "./cash-sessions.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * BLIND DAY CLOSE — the properties that stop this being theatre.
 *
 * These run against a stub transaction rather than Postgres, deliberately and
 * for the same reason `users.test.ts` does: the properties under test are about
 * WHAT SQL IS ISSUED AND IN WHAT ORDER, which is decided entirely in TypeScript
 * before a connection is touched. That makes them cheap enough to run on every
 * commit in `test:unit`, which is where a control that "quietly regresses"
 * actually needs to be watched. The end-to-end behaviour — that the variance
 * journal balances and lands in the ledger — is exercised separately against
 * the seeded database.
 *
 * The most important tests in this file are the ones asserting a NEGATIVE: that
 * `loadCashBoard` does not return the expected figure, and that the SQL it runs
 * for an open session contains no SUM. A leak is not a wrong number on a screen
 * — it is a correct number reaching a payload it should never have been in, and
 * nothing else in the suite would notice.
 */

/* ── Reading drizzle's `sql` template without a database ───────────────────── */

/** The literal fragments of a drizzle `sql` template, parameters elided. */
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

/**
 * The bound parameters, in order.
 *
 * Drizzle boxes an interpolated primitive (`new String("5.0000")`) rather than
 * wrapping it in a `Param`, so a chunk is one of three things: a `StringChunk`
 * whose `.value` is an array of literals, a nested `SQL`, or a boxed primitive
 * that answers to `valueOf()`. Reading the parameters is what lets these tests
 * assert on the AMOUNTS a journal posted rather than only on the shape of the
 * statement — the difference between "a journal was written" and "the drawer
 * was credited five dirhams".
 */
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object") {
      out.push(chunk);
      continue;
    }
    if ("queryChunks" in chunk) {
      out.push(...sqlParams(chunk));
      continue;
    }
    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value)) continue; // StringChunk — literal SQL, not a parameter.
    out.push(value !== undefined ? value : chunk.valueOf());
  }
  return out;
}

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const TENANT = "11111111-1111-4111-8111-111111111111";
const CASHIER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const REGISTER = "55555555-5555-4555-8555-555555555555";
const BU = "66666666-6666-4666-8666-666666666666";
const CASH_ACCOUNT = "77777777-7777-4777-8777-777777777777";
const OVER_SHORT_ACCOUNT = "88888888-8888-4888-8888-888888888888";

const ACCOUNT_IDS: Record<string, string> = {
  CASH: CASH_ACCOUNT,
  CASH_OVER_SHORT: OVER_SHORT_ACCOUNT,
};
const KEY_BY_ACCOUNT_ID = new Map(Object.entries(ACCOUNT_IDS).map(([k, v]) => [v, k]));

const ALL_CASH_PERMISSIONS = ["pos:open_drawer", "pos:read", "payment:void", "settings:update"];

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: over.userId ?? CASHIER,
    tenantId: TENANT,
    membershipId: "99999999-9999-4999-8999-999999999999",
    roleKey: over.roleKey ?? "sales_staff",
    roleLevel: over.roleLevel ?? 30,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: over.permissions ?? new Set(["pos:open_drawer", "pos:read"]),
    isPlatformAdmin: false,
  };
}

interface SessionState {
  opened_by_user_id?: string | null;
  opening_float?: string;
  closed_at?: string | null;
  counted_cash?: string | null;
  expected_cash?: string | null;
  variance?: string | null;
  variance_note?: string | null;
  account_key?: string | null;
}

interface JournalLeg {
  accountKey: string;
  debit: string;
  credit: string;
}

/**
 * A transaction that answers the reads `cash-sessions.ts` makes and records
 * every statement.
 *
 * `statements` is what proves a refusal refused — a guard that throws after the
 * UPDATE has landed is not a guard — and it is also how the blind-count tests
 * inspect the SQL the read path actually ran.
 */
function stubTx(
  opts: {
    session?: SessionState;
    /** Net movement on the till's cash account over the session window. */
    net?: string;
    moves?: number;
    /** What `tenants.settings->>'cashVarianceThreshold'` holds. */
    threshold?: string | null;
    /** Simulate losing the race on the `counted_cash IS NULL` claim. */
    countClaimLost?: boolean;
    openSessions?: Record<string, unknown>[];
    closedSessions?: Record<string, unknown>[];
    registers?: Record<string, unknown>[];
    clash?: Record<string, unknown>[];
  } = {},
) {
  const statements: { text: string; params: unknown[] }[] = [];
  const legs: JournalLeg[] = [];

  const sessionRow = {
    session_id: SESSION,
    register_id: REGISTER,
    register_name: "Salon till",
    business_unit_id: BU,
    account_id: CASH_ACCOUNT,
    account_key: opts.session?.account_key === undefined ? "CASH" : opts.session.account_key,
    opened_by_user_id:
      opts.session?.opened_by_user_id === undefined ? CASHIER : opts.session.opened_by_user_id,
    opened_at: "2026-08-21T05:00:00.000Z",
    opening_float: opts.session?.opening_float ?? "500.0000",
    closed_at: opts.session?.closed_at ?? null,
    counted_cash: opts.session?.counted_cash ?? null,
    expected_cash: opts.session?.expected_cash ?? null,
    variance: opts.session?.variance ?? null,
    variance_note: opts.session?.variance_note ?? null,
  };

  const execute = async (query: unknown) => {
    const text = sqlText(query).replace(/\s+/g, " ").trim();
    const params = sqlParams(query);
    statements.push({ text, params });

    if (/FROM cash_register_sessions s JOIN cash_registers r/i.test(text) && /FOR UPDATE OF s/i.test(text)) {
      return [sessionRow];
    }
    if (/SELECT settings ->>/i.test(text)) {
      return [{ value: opts.threshold ?? null }];
    }
    if (/SUM\(jl\.debit - jl\.credit\)/i.test(text)) {
      return [{ net: opts.net ?? "0", moves: opts.moves ?? 0 }];
    }
    if (/UPDATE cash_register_sessions SET counted_cash/i.test(text)) {
      return opts.countClaimLost ? [] : [{ id: SESSION }];
    }
    if (/UPDATE cash_register_sessions SET closed_at/i.test(text)) {
      return [{ id: SESSION }];
    }
    if (/FROM fiscal_periods/i.test(text)) return [];
    if (/SELECT system_key, id FROM accounts/i.test(text)) {
      return Object.entries(ACCOUNT_IDS).map(([system_key, id]) => ({ system_key, id }));
    }
    if (/UPDATE number_series/i.test(text)) return [{ next_value: 4242 }];
    if (/INSERT INTO cash_register_sessions/i.test(text)) return [{ id: SESSION }];
    if (/INSERT INTO cash_registers/i.test(text)) return [{ id: REGISTER }];
    if (/INSERT INTO journals/i.test(text)) return [{ id: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd" }];
    if (/INSERT INTO journal_lines/i.test(text)) {
      const accountId = params.find((p) => typeof p === "string" && KEY_BY_ACCOUNT_ID.has(p));
      const amounts = params.filter(
        (p): p is string => typeof p === "string" && /^-?\d+\.\d{4}$/.test(p),
      );
      legs.push({
        accountKey: KEY_BY_ACCOUNT_ID.get(String(accountId)) ?? "?",
        debit: amounts[0] ?? "?",
        credit: amounts[1] ?? "?",
      });
      return [];
    }
    // Board queries.
    if (/FROM cash_registers r JOIN business_units b/i.test(text)) return opts.registers ?? [];
    if (/WHERE s\.closed_at IS NULL ORDER BY s\.opened_at/i.test(text)) return opts.openSessions ?? [];
    if (/WHERE s\.closed_at IS NOT NULL/i.test(text)) return opts.closedSessions ?? [];
    if (/FROM business_units WHERE id/i.test(text)) return [{ id: BU }];
    if (/FROM cash_registers r JOIN accounts a/i.test(text)) {
      return [
        {
          id: REGISTER, name: "Salon till", business_unit_id: BU,
          account_id: CASH_ACCOUNT, is_active: true, account_key: "CASH",
        },
      ];
    }
    if (/same_register/i.test(text)) return opts.clash ?? [];
    return [];
  };

  return {
    statements,
    legs,
    tx: { execute } as unknown as ServiceContext["tx"],
    /** Statements that changed something. A refusal must produce none. */
    writes: () =>
      statements.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.text)).map((s) => s.text.slice(0, 60)),
  };
}

function ctxFor(tx: ServiceContext["tx"], over: Partial<Principal> = {}): ServiceContext {
  return {
    tx,
    tenantId: TENANT,
    principal: principal(over),
    today: "2026-08-21",
    baseCurrency: "AED",
  };
}

const manager = { userId: MANAGER, roleKey: "salon_manager", permissions: new Set(ALL_CASH_PERMISSIONS) };

async function refusal(fn: () => Promise<unknown>): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("Expected a ServiceError, but the call succeeded.");
}

/* ── 1. The blind count ────────────────────────────────────────────────────── */

describe("blind count", () => {
  /**
   * The assertion that outlives whoever wrote the SELECT.
   *
   * `loadCashBoard` cannot trip this today. It is here for the change that adds
   * `s.expected_cash` to the open-session query "just for a totals row", which
   * typechecks, renders nothing, and silently ends the control.
   */
  it("assertBlind rejects any key that names the expected figure, the count or the variance", () => {
    for (const key of [
      "expectedCash", "expected_cash", "tillExpected", "counted_cash",
      "countedCash", "variance", "varianceAmount", "netMovement", "takings",
    ]) {
      expect(() => assertBlind([{ [key]: 1 }], "test")).toThrow(/Blind count violated/);
    }
  });

  it("assertBlind allows the fields an open session legitimately shows", () => {
    const row = {
      sessionId: SESSION, registerName: "Salon till", openedBy: "Maya",
      openingFloat: 500, entryCount: 12, awaitingAck: false, colorToken: "amber",
    };
    expect(assertBlind([row], "test")).toEqual([row]);
  });

  it("loadCashBoard returns no expected, counted or variance field for an open session", async () => {
    const stub = stubTx({
      openSessions: [
        {
          session_id: SESSION, register_id: REGISTER, register_name: "Salon till",
          bu_name: "Royal Cuts", color_token: "amber",
          opened_at: "2026-08-21T05:00:00.000Z", opened_by: "Maya",
          opened_by_user_id: CASHIER, opening_float: "500.0000",
          entry_count: 12, awaiting_ack: false, close_note: null,
        },
      ],
    });

    const board = await loadCashBoard(stub.tx as never);

    expect(board.open).toHaveLength(1);
    const keys = Object.keys(board.open[0]!).map((k) => k.toLowerCase());
    for (const forbidden of ["expect", "counted", "variance", "takings"]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
    // The entry count is the one movement fact an open till may disclose.
    expect(board.open[0]!.entryCount).toBe(12);
  });

  /**
   * The structural half of the guarantee: an open session's SQL cannot produce
   * the expected figure even if someone reads the raw rows. `COUNT(*)` yes,
   * `SUM(...)` never.
   */
  it("the open-session query selects no monetary sum and no expected column", async () => {
    const stub = stubTx({ openSessions: [] });
    await loadCashBoard(stub.tx as never);

    const openQuery = stub.statements.find((s) =>
      /WHERE s\.closed_at IS NULL ORDER BY s\.opened_at/i.test(s.text),
    );
    expect(openQuery).toBeDefined();
    expect(openQuery!.text).not.toMatch(/SUM\s*\(/i);
    expect(openQuery!.text).not.toMatch(/s\.expected_cash/i);
    expect(openQuery!.text).not.toMatch(/s\.counted_cash\s*,/i);
    expect(openQuery!.text).not.toMatch(/s\.variance\b/i);
    // What it does select instead.
    expect(openQuery!.text).toMatch(/COUNT\(\*\)::int/i);
    expect(openQuery!.text).toMatch(/\(s\.counted_cash IS NOT NULL\) AS awaiting_ack/i);
  });

  /**
   * The expected figure is computed AFTER the count arrives, never before.
   *
   * Asserted on statement order rather than on a mock's call count, because the
   * order is the property: a summing query that ran before the UPDATE could
   * have had its result returned to a client that had not yet committed to a
   * number.
   */
  it("computes the expected figure only after the count has been received", async () => {
    const stub = stubTx({ net: "1340.0000" });
    await submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "1835" });

    const sumAt = stub.statements.findIndex((s) => /SUM\(jl\.debit - jl\.credit\)/i.test(s.text));
    const lockAt = stub.statements.findIndex((s) => /FOR UPDATE OF s/i.test(s.text));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(sumAt).toBeGreaterThan(lockAt);

    // Count and expected are written by ONE statement, so a row can never hold
    // an expected figure without the count that earned it.
    const claim = stub.statements.find((s) => /UPDATE cash_register_sessions SET counted_cash/i.test(s.text));
    expect(claim!.text).toMatch(/expected_cash =/);
    expect(claim!.text).toMatch(/variance =/);
    expect(claim!.text).toMatch(/AND counted_cash IS NULL/);
  });
});

/* ── 2. Counting and closing ───────────────────────────────────────────────── */

describe("submitCashCount", () => {
  it("closes immediately and posts the variance when it is within the threshold", async () => {
    // Float 500 + 1,340 of takings = 1,840 expected. Counted 1,835 → short 5,
    // which is the WF-05 §4.2 worked example and is under the AED 20 default.
    const stub = stubTx({ net: "1340.0000" });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "1835",
    });

    expect(result.expectedCash).toBe(1840);
    expect(result.countedCash).toBe(1835);
    expect(result.variance).toBe(-5);
    expect(result.threshold).toBe(20);
    expect(result.requiresAcknowledgement).toBe(false);
    expect(result.state).toBe("closed");
    expect(result.journalId).not.toBeNull();

    // Short: the drawer holds less than the books, so cash comes down and the
    // loss is an expense.
    expect(stub.legs).toEqual([
      { accountKey: "CASH_OVER_SHORT", debit: "5.0000", credit: "0.0000" },
      { accountKey: "CASH", debit: "0.0000", credit: "5.0000" },
    ]);
  });

  it("posts the mirror image when the drawer is over", async () => {
    const stub = stubTx({ net: "1340.0000" });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "1852.50",
    });

    expect(result.variance).toBe(12.5);
    expect(stub.legs).toEqual([
      { accountKey: "CASH", debit: "12.5000", credit: "0.0000" },
      { accountKey: "CASH_OVER_SHORT", debit: "0.0000", credit: "12.5000" },
    ]);
  });

  it("posts nothing when the count is exact", async () => {
    const stub = stubTx({ net: "1340.0000" });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "1840",
    });

    expect(result.variance).toBe(0);
    expect(result.state).toBe("closed");
    expect(result.journalId).toBeNull();
    expect(stub.legs).toHaveLength(0);
    expect(stub.statements.some((s) => /INSERT INTO journals/i.test(s.text))).toBe(false);
  });

  /**
   * Money stays exact across the boundary.
   *
   * 0.1 + 0.2 in a float is 0.30000000000000004, and a till counted in fils is
   * where that would first show up. The count, the expectation and the variance
   * all go through Decimal, so a three-fils short is three fils.
   */
  it("keeps fils exact rather than accumulating float drift", async () => {
    const stub = stubTx({ net: "0.2000", session: { opening_float: "0.1000" } });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "0.30",
    });

    expect(result.expectedCash).toBe(0.3);
    expect(result.variance).toBe(0);
    expect(stub.legs).toHaveLength(0);
  });

  it("holds the session open when the variance is above the threshold", async () => {
    // The WF-05 §4.3 example: expected 1,840, counted 1,720, short 120.
    const stub = stubTx({ net: "1340.0000" });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "1720",
    });

    expect(result.variance).toBe(-120);
    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.state).toBe("counted");
    expect(result.journalId).toBeNull();
    // Not closed, and nothing in the ledger yet — that is the manager's to do.
    expect(stub.statements.some((s) => /UPDATE cash_register_sessions SET closed_at/i.test(s.text))).toBe(false);
    expect(stub.legs).toHaveLength(0);
  });

  it("treats a variance exactly on the threshold as within tolerance", async () => {
    const stub = stubTx({ net: "1340.0000" });
    const result = await submitCashCount(ctxFor(stub.tx), {
      sessionId: SESSION,
      countedCash: "1820",
    });
    expect(result.variance).toBe(-20);
    expect(result.requiresAcknowledgement).toBe(false);
    expect(result.state).toBe("closed");
  });

  /* ── The abuse paths ─────────────────────────────────────────────────────── */

  it("refuses a second count on the same session, and writes nothing", async () => {
    const stub = stubTx({ session: { counted_cash: "1720.0000", variance: "-120.0000" } });
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "1840" }),
    );

    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/cannot be counted twice/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses to count a session that is already closed", async () => {
    const stub = stubTx({
      session: { closed_at: "2026-08-20T18:00:00.000Z", counted_cash: "1840.0000" },
    });
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "1840" }),
    );

    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/already been closed/);
    expect(stub.writes()).toEqual([]);
  });

  /**
   * The race the single-statement claim exists to lose safely.
   *
   * Two tablets submitting a count in the same millisecond both pass the
   * read-time check. The `counted_cash IS NULL` predicate on the UPDATE is what
   * makes exactly one of them win; the loser must be told, not silently
   * overwrite the winner's number.
   */
  it("refuses when another submit won the claim first", async () => {
    const stub = stubTx({ net: "1340.0000", countClaimLost: true });
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "1835" }),
    );

    expect(err.code).toBe("conflict");
    expect(stub.legs).toHaveLength(0);
  });

  it("refuses a count from someone who does not handle cash, and writes nothing", async () => {
    const stub = stubTx();
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx, { permissions: new Set(["pos:read"]) }), {
        sessionId: SESSION,
        countedCash: "1835",
      }),
    );

    expect(err.code).toBe("forbidden");
    // The permission gate runs before any read, so not even the session was
    // looked up.
    expect(stub.statements).toEqual([]);
  });

  it("refuses a count on somebody else's till unless the counter supervises cash", async () => {
    const stub = stubTx({ session: { opened_by_user_id: MANAGER } });
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "1835" }),
    );

    expect(err.code).toBe("forbidden");
    expect(err.message).toMatch(/opened by someone else/);
    expect(stub.writes()).toEqual([]);

    // A manager closing a cashier's abandoned till is the case this must allow.
    const asManager = stubTx({ session: { opened_by_user_id: CASHIER }, net: "1340.0000" });
    const ok = await submitCashCount(ctxFor(asManager.tx, manager), {
      sessionId: SESSION,
      countedCash: "1835",
    });
    expect(ok.state).toBe("closed");
  });

  it("refuses a negative count", async () => {
    const stub = stubTx();
    const err = await refusal(() =>
      submitCashCount(ctxFor(stub.tx), { sessionId: SESSION, countedCash: "-100" }),
    );
    expect(err.code).toBe("invalid");
    expect(stub.statements).toEqual([]);
  });
});

/* ── 3. Manager acknowledgement ────────────────────────────────────────────── */

describe("acknowledgeCashVariance", () => {
  const counted = {
    counted_cash: "1720.0000",
    expected_cash: "1840.0000",
    variance: "-120.0000",
    variance_note: "Don't know",
  };

  it("closes the till and posts the variance once a manager signs it off", async () => {
    const stub = stubTx({ session: counted });
    const result = await acknowledgeCashVariance(ctxFor(stub.tx, manager), { sessionId: SESSION });

    expect(result.variance).toBe(-120);
    expect(result.journalId).not.toBeNull();
    expect(stub.legs).toEqual([
      { accountKey: "CASH_OVER_SHORT", debit: "120.0000", credit: "0.0000" },
      { accountKey: "CASH", debit: "0.0000", credit: "120.0000" },
    ]);
  });

  /**
   * The separation of duties this whole path exists for. A cashier who could
   * acknowledge their own variance is a cashier with no oversight at all, and
   * the acknowledgement would be a field in a database rather than a control.
   */
  it("refuses an acknowledgement from the cashier, and writes nothing", async () => {
    const stub = stubTx({ session: counted });
    const err = await refusal(() =>
      acknowledgeCashVariance(ctxFor(stub.tx), { sessionId: SESSION }),
    );

    expect(err.code).toBe("forbidden");
    expect(stub.statements).toEqual([]);
  });

  /** "Don't know" is acceptable (WF-05 §4.3). Blank is not. */
  it("refuses to acknowledge a variance with no recorded reason", async () => {
    const stub = stubTx({ session: { ...counted, variance_note: "   " } });
    const err = await refusal(() =>
      acknowledgeCashVariance(ctxFor(stub.tx, manager), { sessionId: SESSION }),
    );

    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/Don't know/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses to acknowledge a session that was never counted", async () => {
    const stub = stubTx({ session: { variance_note: "Recount" } });
    const err = await refusal(() =>
      acknowledgeCashVariance(ctxFor(stub.tx, manager), { sessionId: SESSION }),
    );

    expect(err.code).toBe("invalid");
    expect(err.message).toMatch(/not been counted/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses to acknowledge a session twice", async () => {
    const stub = stubTx({ session: { ...counted, closed_at: "2026-08-20T18:00:00.000Z" } });
    const err = await refusal(() =>
      acknowledgeCashVariance(ctxFor(stub.tx, manager), { sessionId: SESSION }),
    );

    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/already been closed/);
    expect(stub.writes()).toEqual([]);
  });
});

/* ── 4. Opening ────────────────────────────────────────────────────────────── */

describe("openCashSession", () => {
  it("records the float and the person responsible", async () => {
    const stub = stubTx();
    const result = await openCashSession(ctxFor(stub.tx), {
      cashRegisterId: REGISTER,
      openingFloat: "500",
    });

    expect(result.registerName).toBe("Salon till");
    expect(result.openingFloat).toBe(500);
    const insert = stub.statements.find((s) => /INSERT INTO cash_register_sessions/i.test(s.text));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain(CASHIER);
    expect(insert!.params).toContain("500.0000");
    // Nothing is posted on opening. The cash was already in the account.
    expect(stub.legs).toHaveLength(0);
  });

  it("refuses to open a till that is already open", async () => {
    const stub = stubTx({ clash: [{ id: SESSION, name: "Salon till", same_register: true }] });
    const err = await refusal(() =>
      openCashSession(ctxFor(stub.tx), { cashRegisterId: REGISTER, openingFloat: "500" }),
    );

    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/already open/);
    expect(stub.writes()).toEqual([]);
  });

  /**
   * Two tills sharing one cash account would each count the other's takings as
   * their own, so both would close with a variance equal to the other's
   * turnover. Refusing at open time is the only place this is cheap to fix.
   */
  it("refuses to open a second till on the same cash account", async () => {
    const stub = stubTx({ clash: [{ id: SESSION, name: "Reception till", same_register: false }] });
    const err = await refusal(() =>
      openCashSession(ctxFor(stub.tx), { cashRegisterId: REGISTER, openingFloat: "500" }),
    );

    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/own cash account/);
    expect(stub.writes()).toEqual([]);
  });

  it("refuses without the till permission and reads nothing", async () => {
    const stub = stubTx();
    const err = await refusal(() =>
      openCashSession(ctxFor(stub.tx, { permissions: new Set(["pos:read"]) }), {
        cashRegisterId: REGISTER,
        openingFloat: "500",
      }),
    );

    expect(err.code).toBe("forbidden");
    expect(stub.statements).toEqual([]);
  });

  it("refuses a negative float", async () => {
    const stub = stubTx();
    const err = await refusal(() =>
      openCashSession(ctxFor(stub.tx), { cashRegisterId: REGISTER, openingFloat: "-1" }),
    );
    expect(err.code).toBe("invalid");
  });
});

/* ── 5. The threshold ──────────────────────────────────────────────────────── */

describe("cash variance threshold", () => {
  it("falls back to the documented placeholder when nothing is configured", async () => {
    const stub = stubTx({ threshold: null });
    expect((await resolveCashVarianceThreshold(stub.tx as never)).toString()).toBe("20");
  });

  it("honours a tenant override", async () => {
    const stub = stubTx({ threshold: "50.50" });
    expect((await resolveCashVarianceThreshold(stub.tx as never)).toString()).toBe("50.5");
  });

  /**
   * A malformed setting must not make every till in the group uncloseable.
   * Falling back is the lesser failure by a wide margin.
   */
  it("falls back rather than throwing on a malformed or negative setting", async () => {
    for (const bad of ["", "twenty", "-5", "NaN"]) {
      const stub = stubTx({ threshold: bad });
      expect((await resolveCashVarianceThreshold(stub.tx as never)).toString()).toBe("20");
    }
  });

  /**
   * Q-11 is open: the real threshold is the owner's policy decision, not ours.
   * The default above is the WF-05 figure standing in for it.
   */
  it.todo("uses the owner's answer to Q-11 as the default cash variance threshold");
});
