import { describe, expect, it } from "vitest";
import {
  closePeriod,
  displayPeriod,
  monthOf,
  periodBounds,
  reopenPeriod,
  shiftMonth,
} from "./periods.ts";
import { ServiceError, postJournal, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * PERIOD LOCK TESTS.
 *
 * The property under test is the one FR-C01 exists for and that no test in the
 * repository could previously state: that `assertPeriodOpen` — called by
 * `postJournal` on every posting since the beginning, reading a table nothing
 * ever wrote to — now refuses a posting, and stops refusing when the period is
 * reopened. Everything else here supports that sentence.
 *
 * These run against a stub transaction rather than Postgres, and deliberately
 * so: the sequence being proved is close -> refuse -> reopen -> allow, and
 * proving it needs a `fiscal_periods` table that answers reads consistently
 * with the writes the service just made, not a real one. `stubLedger` below is
 * that table, in a Map. It runs in `test:unit`, on every commit, rather than
 * only where a seeded database exists — and the same sequence is exercised
 * against the real database by the write-layer script quoted in the report.
 *
 * The other half of what is asserted is that a REFUSAL REFUSED. Every negative
 * case checks `writes` is empty: a permission gate that throws after the UPDATE
 * has landed is not a gate, and this is the file where that distinction is the
 * whole feature.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-9222-222222222222";
const PERIOD_ID = "33333333-3333-4333-a333-333333333333";
const JOURNAL_ID = "44444444-4444-4444-b444-444444444444";

/**
 * Flatten a drizzle `sql` template into its literal text and its parameters.
 *
 * `users.test.ts` matches on the literals alone, which is enough there. Here
 * the stub has to answer "is the date in this posting inside a closed period?",
 * so the values matter as much as the shape. Recursive because nested `sql`
 * fragments — the shared `now(), <user>` chunk in the cascade, the `sql.join`
 * inside `postJournal`'s account lookup — are themselves chunk lists.
 */
function decompose(node: unknown, text: string[] = [], params: unknown[] = []) {
  // A plain interpolated value arrives as a primitive, not as a wrapper object —
  // `sql\`… ${label} …\`` puts the string itself in the chunk list.
  if (node === null || node === undefined || typeof node !== "object") {
    params.push(node);
    text.push("?");
    return { text, params };
  }
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) decompose(chunk, text, params);
  } else if (Array.isArray(n.value)) {
    text.push(n.value.join(" ")); // StringChunk: the literal SQL either side of a hole
  } else if ("value" in n) {
    params.push(n.value);
    text.push("?");
  }
  return { text, params };
}

const flatten = (query: unknown) => {
  const { text, params } = decompose(query);
  return { sql: text.join(" ").replace(/\s+/g, " ").trim(), params };
};

interface StubPeriod {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "soft_closed" | "closed";
}

interface StubOptions {
  /** Checklist counts, keyed the way the service reads them. Default: clean. */
  counts?: Partial<{
    unbalanced: number;
    openSessions: number;
    intercoResidual: string;
    unallocated: number;
    drafts: number;
    bank: number;
    variance: number;
    cheques: number;
  }>;
}

/**
 * A `fiscal_periods` table, a `journals` table and enough of the posting path
 * for `postJournal` to reach its INSERTs.
 *
 * `postJournal` throws on the first line when the period is closed, so the
 * posting branches below only ever run on the paths that are supposed to
 * succeed — which is exactly what makes "it succeeded" a meaningful assertion
 * rather than "it failed somewhere else this time".
 */
function stubLedger(seed: StubPeriod[] = [], opts: StubOptions = {}) {
  const periods = new Map(seed.map((p) => [p.label, { ...p }]));
  const writes: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const postedLines: { debit: unknown; credit: unknown }[] = [];
  const c = opts.counts ?? {};

  const execute = async (query: unknown) => {
    const { sql: text, params } = flatten(query);
    const p = (i: number) => String(params[i] ?? "");

    // ── fiscal_periods reads ────────────────────────────────────────────────

    // assertPeriodOpen, in context.ts. The one read this feature exists to feed.
    if (/FROM fiscal_periods WHERE \? ::date BETWEEN starts_on AND ends_on/.test(text)) {
      const on = p(0);
      const hit = [...periods.values()].find((r) => r.startsOn <= on && on <= r.endsOn);
      return hit ? [{ status: hit.status, label: hit.label }] : [];
    }
    if (/FOR UPDATE OF p/.test(text)) {
      const row = periods.get(p(0));
      return row ? [{ id: row.id, status: row.status, closed_by: "Sumon", closed_on: "05 Sep 2026" }] : [];
    }
    if (/starts_on::text/.test(text)) {
      const row = periods.get(p(0));
      return row
        ? [{ id: row.id, status: row.status, starts_on: row.startsOn }]
        : [];
    }
    if (/SELECT label FROM fiscal_periods WHERE status = 'closed' AND starts_on >/.test(text)) {
      const after = p(0);
      const newer = [...periods.values()]
        .filter((r) => r.status === "closed" && r.startsOn > after)
        .sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
      return newer ? [{ label: newer.label }] : [];
    }

    // ── fiscal_periods writes ───────────────────────────────────────────────

    if (/INSERT INTO fiscal_periods/.test(text) && /VALUES \(gen_random_uuid\(\)/.test(text)) {
      writes.push("INSERT fiscal_periods");
      const label = p(1);
      if (!periods.has(label)) {
        periods.set(label, { id: PERIOD_ID, label, startsOn: p(2), endsOn: p(3), status: "open" });
      }
      return [];
    }
    if (/AS first_month/.test(text)) {
      // The ledger's first month, which anchors the pre-history row.
      return [{ first_month: "2026-07" }];
    }
    if (/AS earliest/.test(text)) return [{ earliest: "2026-07", months: 0 }];
    if (/INSERT INTO fiscal_periods/.test(text)) {
      // The cascade and the pre-history row. Their population is a database
      // computation (generate_series over the ledger's first posting), so the
      // stub reports "nothing to backfill" and leaves that to the live proof.
      writes.push("INSERT fiscal_periods (cascade)");
      return [];
    }
    if (/UPDATE fiscal_periods SET status = 'closed'.*WHERE id =/.test(text)) {
      writes.push("UPDATE fiscal_periods -> closed");
      const row = [...periods.values()].find((r) => r.id === p(1));
      if (row) row.status = "closed";
      return [];
    }
    if (/UPDATE fiscal_periods SET status = 'closed'/.test(text)) {
      writes.push("UPDATE fiscal_periods (cascade)");
      return [];
    }
    if (/SET status = 'open'/.test(text)) {
      writes.push("UPDATE fiscal_periods -> open");
      const row = [...periods.values()].find((r) => r.id === p(0));
      if (row) row.status = "open";
      return [];
    }
    if (/UPDATE journals j SET fiscal_period_id/.test(text)) {
      writes.push("UPDATE journals.fiscal_period_id");
      return [{ id: JOURNAL_ID }];
    }

    // ── checklist ───────────────────────────────────────────────────────────

    if (/unbalanced_journals/.test(text)) return [{ n: c.unbalanced ?? 0, amount: null }];
    if (/FROM cash_register_sessions WHERE closed_at IS NULL/.test(text)) {
      return [{ n: c.openSessions ?? 0, amount: "0.0000" }];
    }
    if (/INTERCO_DUE_FROM/.test(text)) {
      return [{ due_from: c.intercoResidual ?? "0", due_to: "0" }];
    }
    if (/FROM payments/.test(text)) return [{ n: c.unallocated ?? 0, amount: "3400.0000" }];
    if (/FROM documents WHERE status = 'draft'/.test(text)) {
      return [{ n: c.drafts ?? 0, amount: "0.0000" }];
    }
    if (/FROM bank_transactions/.test(text)) return [{ n: c.bank ?? 0, amount: "0.0000" }];
    if (/FROM cash_register_sessions/.test(text)) {
      return [{ n: c.variance ?? 0, amount: "0.0000" }];
    }
    if (/FROM cheques/.test(text)) {
      return [{ n: c.cheques ?? 0, amount: "0.0000", stale: 0 }];
    }

    // ── journals ────────────────────────────────────────────────────────────

    if (/FROM journals WHERE posting_date BETWEEN/.test(text)) return [{ n: 7 }];

    // ── the rest of postJournal ─────────────────────────────────────────────

    if (/FROM accounts WHERE system_key = ANY/.test(text)) {
      return params.map((key, i) => ({
        system_key: String(key),
        id: `55555555-5555-4555-8555-00000000000${i}`,
      }));
    }
    if (/UPDATE number_series/.test(text)) return [{ next_value: 12_001 }];
    if (/INSERT INTO journals/.test(text)) {
      writes.push("INSERT journals");
      return [{ id: JOURNAL_ID }];
    }
    if (/INSERT INTO journal_lines/.test(text)) {
      writes.push("INSERT journal_lines");
      postedLines.push({ debit: params[5], credit: params[6] });
      return [];
    }
    if (/INSERT INTO audit_log/.test(text)) {
      audits.push({ action: params[4], diff: params[7] });
      return [];
    }

    throw new Error(`stubLedger has no branch for: ${text.slice(0, 120)}`);
  };

  return {
    periods,
    writes,
    audits,
    postedLines,
    tx: { execute } as unknown as ServiceContext["tx"],
  };
}

function ctxFor(
  tx: ServiceContext["tx"],
  over: { permissions?: string[]; roleLevel?: number; roleKey?: string } = {},
): ServiceContext {
  const principal: Principal = {
    userId: OWNER,
    tenantId: TENANT,
    membershipId: "66666666-6666-4666-8666-666666666666",
    roleKey: over.roleKey ?? "owner",
    roleLevel: over.roleLevel ?? 90,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    permissions: new Set(over.permissions ?? ["period:close", "period:reopen", "report:read"]),
    isPlatformAdmin: false,
  };
  return { tx, tenantId: TENANT, principal, today: "2026-09-03", baseCurrency: "AED" };
}

const JULY: StubPeriod = {
  id: PERIOD_ID,
  label: "2026-07",
  startsOn: "2026-07-01",
  endsOn: "2026-07-31",
  status: "open",
};

/** A balanced two-leg entry dated inside July. */
const julyEntry = {
  postingDate: "2026-07-15",
  source: "manual",
  sourceTable: "journals",
  sourceId: "77777777-7777-4777-8777-777777777777",
  narration: "Backdated adjustment",
  legs: [
    { accountKey: "CASH", debit: 500 },
    { accountKey: "REV_SERVICE", credit: 500 },
  ],
};

/** Run and report, so a refusal can be inspected instead of failing the test.
 *  Not a discriminated union: every case here asserts on both `ok` and the
 *  error, and narrowing one from the other adds noise to twenty call sites. */
const attempt = async <T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; value?: T; error?: unknown }> =>
  fn().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

const codeOf = (error: unknown) =>
  error instanceof ServiceError ? error.code : `not a ServiceError: ${String(error)}`;

// ── The point of the whole feature ──────────────────────────────────────────

describe("the period lock reaches postJournal", () => {
  it("refuses a posting into a closed period, and allows it again after reopen", async () => {
    const db = stubLedger([{ ...JULY }]);
    const ctx = ctxFor(db.tx);

    // 1. July is open. The posting goes through — proving the refusal later is
    //    the lock and not some unrelated failure in the stub.
    const before = await attempt(() => postJournal(ctx, julyEntry));
    expect(before.ok).toBe(true);
    expect(db.writes).toContain("INSERT journals");

    // 2. Close July.
    const closed = await attempt(() => closePeriod(ctx, { label: "2026-07" }));
    expect(closed.ok).toBe(true);
    expect(db.periods.get("2026-07")!.status).toBe("closed");

    // 3. The same entry is now refused, by `assertPeriodOpen`, with the code the
    //    ServiceError union reserves for it — the code path that had never once
    //    executed in the life of this repository.
    const during = await attempt(() => postJournal(ctx, julyEntry));
    expect(during.ok).toBe(false);
    expect(codeOf(during.error)).toBe("period_closed");
    expect((during.error as ServiceError).message).toContain("2026-07");

    // 4. Reopen, and it posts again.
    const reopened = await attempt(() =>
      reopenPeriod(ctx, {
        label: "2026-07",
        confirmLabel: "2026-07",
        reason: "Supplier credit note arrived after the close; owner approved the restatement.",
      }),
    );
    expect(reopened.ok).toBe(true);
    expect(db.periods.get("2026-07")!.status).toBe("open");

    const after = await attempt(() => postJournal(ctx, julyEntry));
    expect(after.ok).toBe(true);
  });

  it("leaves other months alone — the lock is on the period, not the ledger", async () => {
    const db = stubLedger([{ ...JULY, status: "closed" }]);
    const ctx = ctxFor(db.tx);

    const august = await attempt(() =>
      postJournal(ctx, { ...julyEntry, postingDate: "2026-08-15" }),
    );
    expect(august.ok).toBe(true);
  });

  it("stamps journals with the period id the posting path never sets", async () => {
    const db = stubLedger([{ ...JULY }]);
    const result = await closePeriod(ctxFor(db.tx), { label: "2026-07" });
    expect(db.writes).toContain("UPDATE journals.fiscal_period_id");
    expect(result.journalsStamped).toBe(1);
  });
});

// ── Reopening is strictly harder than closing ───────────────────────────────

describe("reopen is harder than close", () => {
  it("closes with period:close but will not reopen with it", async () => {
    const db = stubLedger([{ ...JULY }]);
    const accountant = ctxFor(db.tx, {
      permissions: ["period:close", "report:read"],
      roleLevel: 70,
      roleKey: "accountant",
    });

    expect((await attempt(() => closePeriod(accountant, { label: "2026-07" }))).ok).toBe(true);

    const writesBefore = db.writes.length;
    const reopen = await attempt(() =>
      reopenPeriod(accountant, {
        label: "2026-07",
        confirmLabel: "2026-07",
        reason: "The accountant would like this month back, please and thank you.",
      }),
    );
    expect(reopen.ok).toBe(false);
    expect(codeOf(reopen.error)).toBe("forbidden");
    expect(db.periods.get("2026-07")!.status).toBe("closed");
    expect(db.writes.length).toBe(writesBefore);
  });

  it("refuses the rank even when the permission has been granted directly", async () => {
    // The `permission_overrides.grant` case: the key without the role.
    const db = stubLedger([{ ...JULY, status: "closed" }]);
    const granted = ctxFor(db.tx, {
      permissions: ["period:reopen"],
      roleLevel: 30,
      roleKey: "receptionist",
    });

    const reopen = await attempt(() =>
      reopenPeriod(granted, {
        label: "2026-07",
        confirmLabel: "2026-07",
        reason: "An override handed out the key without handing out the rank.",
      }),
    );
    expect(reopen.ok).toBe(false);
    expect(codeOf(reopen.error)).toBe("forbidden");
    expect(db.writes).toEqual([]);
  });

  it("refuses a mistyped confirmation and a reason too short to be one", async () => {
    const db = stubLedger([{ ...JULY, status: "closed" }]);
    const ctx = ctxFor(db.tx);

    const mistyped = await attempt(() =>
      reopenPeriod(ctx, {
        label: "2026-07",
        confirmLabel: "2026-06",
        reason: "Wrong month typed into the confirmation field entirely.",
      }),
    );
    expect(codeOf(mistyped.error)).toBe("invalid");

    const terse = await attempt(() =>
      reopenPeriod(ctx, { label: "2026-07", confirmLabel: "2026-07", reason: "fix" }),
    );
    expect(terse.ok).toBe(false);
    expect(terse.error).toBeInstanceOf(Error);

    expect(db.writes).toEqual([]);
    expect(db.periods.get("2026-07")!.status).toBe("closed");
  });

  it("refuses to reopen a month that sits under a later closed one", async () => {
    const db = stubLedger([
      { ...JULY, status: "closed" },
      {
        id: "88888888-8888-4888-8888-888888888888",
        label: "2026-08",
        startsOn: "2026-08-01",
        endsOn: "2026-08-31",
        status: "closed",
      },
    ]);

    const reopen = await attempt(() =>
      reopenPeriod(ctxFor(db.tx), {
        label: "2026-07",
        confirmLabel: "2026-07",
        reason: "August is closed on top of July, so July is not the one to reopen.",
      }),
    );
    expect(reopen.ok).toBe(false);
    expect(codeOf(reopen.error)).toBe("conflict");
    expect((reopen.error as ServiceError).message).toContain("August 2026");
    expect(db.writes).toEqual([]);
  });

  it("records the reason on the audit log, because the row does not keep it", async () => {
    const db = stubLedger([{ ...JULY, status: "closed" }]);
    const reason = "Supplier credit note arrived after the close; owner approved the restatement.";
    await reopenPeriod(ctxFor(db.tx), {
      label: "2026-07",
      confirmLabel: "2026-07",
      reason,
    });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]!.action).toBe("period.reopen");
    expect(String(db.audits[0]!.diff)).toContain(reason);
  });
});

// ── Permission and timing gates on closing ──────────────────────────────────

describe("closePeriod gates", () => {
  it("refuses without period:close and writes nothing", async () => {
    const db = stubLedger([{ ...JULY }]);
    const ctx = ctxFor(db.tx, { permissions: ["report:read", "journal:post"], roleLevel: 70 });

    const result = await attempt(() => closePeriod(ctx, { label: "2026-07" }));
    expect(result.ok).toBe(false);
    expect(codeOf(result.error)).toBe("forbidden");
    expect(db.writes).toEqual([]);
    expect(db.periods.get("2026-07")!.status).toBe("open");
  });

  it("refuses to close a month that has not ended", async () => {
    const db = stubLedger();
    const ctx = ctxFor(db.tx); // today is 2026-09-03
    const result = await attempt(() => closePeriod(ctx, { label: "2026-09" }));
    expect(result.ok).toBe(false);
    expect(codeOf(result.error)).toBe("invalid");
    expect((result.error as ServiceError).message).toContain("2026-10-01");
    expect(db.writes).toEqual([]);
  });

  it("refuses to close twice and names who closed it", async () => {
    const db = stubLedger([{ ...JULY, status: "closed" }]);
    const result = await attempt(() => closePeriod(ctxFor(db.tx), { label: "2026-07" }));
    expect(codeOf(result.error)).toBe("conflict");
    expect((result.error as ServiceError).message).toContain("Sumon");
  });

  it("materialises a month that has no row at all rather than treating it as open", async () => {
    const db = stubLedger();
    const result = await closePeriod(ctxFor(db.tx), { label: "2026-07" });
    expect(result.label).toBe("2026-07");
    expect(db.periods.get("2026-07")!.status).toBe("closed");
    expect(db.writes).toContain("INSERT fiscal_periods");
    // The cascade and the pre-history floor both ran.
    expect(db.writes.filter((w) => w.includes("cascade")).length).toBeGreaterThan(0);
  });
});

// ── The checklist decides whether the month may be frozen ───────────────────

describe("pre-close checklist", () => {
  it("blocks on an unbalanced journal", async () => {
    const db = stubLedger([{ ...JULY }], { counts: { unbalanced: 2 } });
    const result = await attempt(() => closePeriod(ctxFor(db.tx), { label: "2026-07" }));
    expect(result.ok).toBe(false);
    expect(codeOf(result.error)).toBe("invalid");
    expect((result.error as ServiceError).message).toContain("all journals balance (2)");
    expect(db.periods.get("2026-07")!.status).toBe("open");
  });

  it("blocks on an open cash drawer and on inter-business legs that do not net", async () => {
    const drawer = stubLedger([{ ...JULY }], { counts: { openSessions: 1 } });
    expect(
      codeOf((await attempt(() => closePeriod(ctxFor(drawer.tx), { label: "2026-07" }))).error),
    ).toBe("invalid");

    const interco = stubLedger([{ ...JULY }], { counts: { intercoResidual: "7400.0000" } });
    const result = await attempt(() => closePeriod(ctxFor(interco.tx), { label: "2026-07" }));
    expect((result.error as ServiceError).message).toContain("inter-business balances net to nil");
  });

  it("requires warnings to be acknowledged, then closes", async () => {
    const counts = { unallocated: 2, drafts: 1 };

    const unacknowledged = stubLedger([{ ...JULY }], { counts });
    const refused = await attempt(() =>
      closePeriod(ctxFor(unacknowledged.tx), { label: "2026-07" }),
    );
    expect(refused.ok).toBe(false);
    expect((refused.error as ServiceError).message).toContain("2 items on the checklist");
    expect(unacknowledged.periods.get("2026-07")!.status).toBe("open");

    const acknowledged = stubLedger([{ ...JULY }], { counts });
    const closed = await attempt(() =>
      closePeriod(ctxFor(acknowledged.tx), { label: "2026-07", acknowledgeWarnings: true }),
    );
    expect(closed.ok).toBe(true);
    expect(acknowledged.periods.get("2026-07")!.status).toBe("closed");
    // What was waved through is on the record, not just the fact that it was.
    expect(String(acknowledged.audits[0]!.diff)).toContain("unallocated_payments:2");
  });

  it("never blocks on cheques in flight — that is the normal state of the portfolio", async () => {
    const db = stubLedger([{ ...JULY }], { counts: { cheques: 4 } });
    expect((await attempt(() => closePeriod(ctxFor(db.tx), { label: "2026-07" }))).ok).toBe(true);
  });
});

// ── Month arithmetic ────────────────────────────────────────────────────────

describe("period labels", () => {
  it("derives bounds from the label and nothing else", () => {
    expect(periodBounds("2026-02")).toEqual({ startsOn: "2026-02-01", endsOn: "2026-02-28" });
    expect(periodBounds("2028-02")).toEqual({ startsOn: "2028-02-01", endsOn: "2028-02-29" });
    expect(periodBounds("2026-12")).toEqual({ startsOn: "2026-12-01", endsOn: "2026-12-31" });
  });

  it("crosses year boundaries in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-08", -12)).toBe("2025-08");
  });

  it("reads the month out of a posting date", () => {
    expect(monthOf("2026-08-06")).toBe("2026-08");
  });

  it("says the same thing in a message as on the screen", () => {
    expect(displayPeriod("2026-08")).toBe("August 2026");
    expect(displayPeriod("pre-2025-04")).toBe("everything before April 2025");
  });

  it("rejects anything that is not a month", async () => {
    const db = stubLedger();
    for (const label of ["2026-13", "2026", "Aug 2026", "2026-00"]) {
      const result = await attempt(() => closePeriod(ctxFor(db.tx), { label }));
      expect(result.ok, label).toBe(false);
    }
    expect(db.writes).toEqual([]);
  });
});
