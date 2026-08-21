import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_QUERY_LENGTH, search, SEARCH_GROUPS, type SearchGroup } from "./search.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import { blindIndex, resetKeyring } from "../security/pii.ts";
import type { Principal } from "../rbac.ts";

/**
 * GLOBAL SEARCH TESTS.
 *
 * The property under test is not "does it find things" — a database proves that
 * and the report quotes the run. It is the property a database cannot prove
 * cheaply on every commit: THAT THE SQL THE SERVICE BUILDS IS ALREADY SCOPED
 * BEFORE IT REACHES POSTGRES.
 *
 * That distinction matters here more than anywhere else in the write layer.
 * Every other screen is reached through a nav entry the shell already
 * permission-filtered; search is reached by typing, so it is the one surface
 * where a scoped user can name a record they were never shown. A test that
 * asserted only on returned rows would pass against a stub that returns nothing
 * — which is exactly what a broken scope filter looks like from the outside on
 * a small dataset.
 *
 * So these tests intercept the statement. They assert on its text and its bound
 * parameters: that a denied group is not merely filtered out of the result but
 * NEVER COMPILED, that every arm carries a business-unit predicate, that an
 * empty scope array becomes FALSE rather than nothing, and that no `_enc` or
 * `_hint` column is ever named in a projection.
 *
 * The three-line stub below replaces the transaction. It runs in `test:unit` on
 * every commit; the same service is exercised against the seeded database by
 * the verification script quoted in the report.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-9222-222222222222";
const SALON = "33333333-3333-4333-a333-333333333333";
const PARKING = "44444444-4444-4444-b444-444444444444";

/**
 * A deterministic keyring, so the blind index a test computes is the same one
 * the service computes. Without this the identity assertions would depend on
 * whatever `AUTH_SECRET` happened to be in the shell.
 */
const KEY_ENV = {
  AUTH_SECRET: "search-test-auth-secret-not-a-real-one",
  PII_INDEX_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(KEY_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  resetKeyring();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeyring();
});

/**
 * Flatten a drizzle `sql` template into its literal text and its parameters.
 *
 * Same shape as the helper in `periods.test.ts`; recursive because the search
 * statement is a `sql.join` of seven arms, each of which nests further
 * fragments for its scope predicate and its identity branch.
 */
function decompose(node: unknown, text: string[] = [], params: unknown[] = []) {
  if (node === null || node === undefined || typeof node !== "object") {
    params.push(node);
    text.push("?");
    return { text, params };
  }
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) decompose(chunk, text, params);
  } else if (Array.isArray(n.value)) {
    text.push(n.value.join(" "));
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

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    tenantId: TENANT,
    membershipId: "55555555-5555-4555-8555-555555555555",
    roleKey: "owner",
    roleLevel: 90,
    scope: "tenant",
    businessUnitIds: null,
    locationIds: null,
    // Every group permission, so a test that changes the SCOPE changes only the
    // scope. Tests that care about permissions override this explicitly.
    permissions: new Set([
      "party:read", "document:read", "unit:read", "lease:read", "job:read", "employee:read",
    ]),
    isPlatformAdmin: false,
    ...over,
  };
}

interface Capture {
  ctx: ServiceContext;
  statements: { sql: string; params: unknown[] }[];
}

/** A transaction that records the statement and answers with `rows`. */
function capture(p: Principal, rows: Record<string, unknown>[] = []): Capture {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (query: unknown) => {
      statements.push(flatten(query));
      return rows;
    },
  } as unknown as ServiceContext["tx"];
  return {
    ctx: { tx, tenantId: TENANT, principal: p, today: "2026-08-06", baseCurrency: "AED" },
    statements,
  };
}

/** Every table an arm reads FROM, keyed by group. */
const GROUP_TABLE: Record<SearchGroup, string> = {
  parties: "FROM parties p",
  documents: "FROM documents d",
  units: "FROM units u",
  leases: "FROM leases l",
  jobs: "FROM jobs j",
  cheques: "FROM cheques c",
  employees: "FROM employees e",
};

function rawHit(over: Record<string, unknown> = {}) {
  return {
    grp: "documents",
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "INV-SALON-01669",
    subtitle: "Invoice · 01 Jul 2026",
    context: "Sarah Bennett",
    status: "paid",
    amount: "40.0000",
    currency: "AED",
    occurred_on: "2026-07-01",
    bu_id: SALON,
    bu_name: "Royal Cuts Gents Salon",
    bu_color: "violet",
    href: "/receivables",
    matched_on: "number",
    grp_total: "1",
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════

describe("permission gating decides which arms are compiled", () => {
  it("compiles every arm for a principal holding every read permission", async () => {
    const c = capture(principal());
    await search(c.ctx, "marina");
    expect(c.statements).toHaveLength(1);
    for (const g of SEARCH_GROUPS) {
      expect(c.statements[0]!.sql, `${g} arm missing`).toContain(GROUP_TABLE[g]);
    }
  });

  it("never names a table the principal cannot read", async () => {
    // A salon cashier: parties and documents only. The five other tables must
    // not appear in the statement AT ALL — not filtered out afterwards, not
    // counted and hidden. If `FROM cheques` is in the text, the row count is
    // already known to the query and the only thing between the user and the
    // register is application code.
    const c = capture(
      principal({ permissions: new Set(["party:read", "document:read"]) }),
    );
    const res = await search(c.ctx, "marina");
    const text = c.statements[0]!.sql;
    expect(text).toContain("FROM parties p");
    expect(text).toContain("FROM documents d");
    for (const g of ["units", "leases", "jobs", "cheques", "employees"] as const) {
      expect(text, `${g} arm leaked into the statement`).not.toContain(GROUP_TABLE[g]);
    }
    expect(res.denied).toEqual(["units", "leases", "jobs", "cheques", "employees"]);
  });

  it("refuses outright, without querying, when no group is readable", async () => {
    const c = capture(principal({ permissions: new Set(["dashboard:read"]) }));
    await expect(search(c.ctx, "marina")).rejects.toBeInstanceOf(ServiceError);
    await expect(search(c.ctx, "marina")).rejects.toMatchObject({ code: "forbidden" });
    // The refusal refused: a permission gate that throws after the query has
    // run is not a gate.
    expect(c.statements).toHaveLength(0);
  });

  it("gates cheques on lease:read, matching the nav entry for the register", async () => {
    // payment:read is held by counter staff who have no cheque register in
    // their navigation; search must not be the side door into it.
    const c = capture(
      principal({ permissions: new Set(["payment:read", "party:read"]) }),
    );
    await search(c.ctx, "447811");
    expect(c.statements[0]!.sql).not.toContain("FROM cheques c");
  });

  it("honours an explicit group restriction without widening it", async () => {
    const c = capture(principal());
    await search(c.ctx, "marina", { groups: ["parties"] });
    const text = c.statements[0]!.sql;
    expect(text).toContain("FROM parties p");
    expect(text).not.toContain("FROM documents d");
  });
});

describe("business-unit scope is in the query, not the caller", () => {
  it("adds no scope predicate for a tenant-scoped principal", async () => {
    const c = capture(principal({ scope: "tenant", businessUnitIds: null }));
    await search(c.ctx, "marina");
    expect(c.statements[0]!.params).not.toContain(SALON);
  });

  it("binds the granted businesses into every arm", async () => {
    const c = capture(
      principal({ scope: "business_unit", businessUnitIds: [SALON, PARKING] }),
    );
    await search(c.ctx, "marina");
    const { sql: text, params } = c.statements[0]!;

    // Six of the seven tables carry a business_unit_id and are filtered on it
    // directly. `parties` has none — it is tenant-level by design — so it is
    // scoped through the link table instead, and its absence from this list is
    // the thing the next assertion covers rather than an oversight.
    for (const column of [
      "d.business_unit_id = ANY",
      "u.business_unit_id = ANY",
      "l.business_unit_id = ANY",
      "j.business_unit_id = ANY",
      "c.business_unit_id = ANY",
      "e.primary_business_unit_id = ANY",
    ]) {
      expect(text, `${column} missing`).toContain(column);
    }
    // Once per arm that has the column, and once inside the parties EXISTS.
    expect(params.filter((p) => p === SALON)).toHaveLength(7);
    expect(params.filter((p) => p === PARKING)).toHaveLength(7);
  });

  it("scopes parties through party_business_units, since parties have no business unit", async () => {
    const c = capture(principal({ scope: "business_unit", businessUnitIds: [SALON] }));
    await search(c.ctx, "marina");
    const text = c.statements[0]!.sql;
    expect(text).toContain("EXISTS ( SELECT 1 FROM party_business_units pbu");
    expect(text).toContain("pbu.party_id = p.id");
    expect(text).toContain("pbu.business_unit_id = ANY");
  });

  it("compiles an EMPTY grant to FALSE, not to an absent filter", async () => {
    // The fail-open case, and the reason `businessUnitScope` handles the empty
    // array before building the ANY(): `ANY(ARRAY[])` is a syntax error, and
    // the obvious repair — skip the filter when the list is empty — turns a
    // membership granted nothing into a membership granted everything.
    const c = capture(principal({ scope: "business_unit", businessUnitIds: [] }));
    await search(c.ctx, "marina");
    const text = c.statements[0]!.sql;
    expect(text).toContain("FALSE");
    expect(text).not.toContain("= ANY");
  });

  it("treats scope 'location' and 'self' as scoped, not as tenant-wide", async () => {
    for (const scope of ["location", "self"] as const) {
      const c = capture(principal({ scope, businessUnitIds: [SALON] }));
      await search(c.ctx, "marina");
      expect(c.statements[0]!.sql, scope).toContain("d.business_unit_id = ANY");
    }
  });
});

describe("PII: identifiers are matched, never selected", () => {
  it("never names an encrypted or hint column in any projection", async () => {
    const c = capture(principal());
    await search(c.ctx, "784-1990-1234567-1");
    const text = c.statements[0]!.sql;
    for (const column of [
      "national_id_enc", "national_id_hint",
      "emirates_id_enc", "emirates_id_hint",
      "passport_number_enc", "passport_number_hint",
      "iban_enc", "iban_hint", "tax_id_enc", "visa_number_enc",
    ]) {
      expect(text, `${column} reached the projection`).not.toContain(column);
    }
  });

  it("compares the blind index computed in the application, not in SQL", async () => {
    const c = capture(principal());
    await search(c.ctx, "784-1990-1234567-1");
    const { sql: text, params } = c.statements[0]!;
    expect(text).toContain("p.national_id_bidx = ?");
    expect(text).toContain("e.emirates_id_bidx = ?");
    expect(text).toContain("e.passport_number_bidx = ?");
    // The value compared against a `_bidx` column is the HMAC, not the number.
    const expected = blindIndex("784-1990-1234567-1")!;
    expect(params).toContain(expected);
    expect(expected).not.toContain("784");
    expect(expected).toHaveLength(22);
    // The typed string is still bound — as an ILIKE pattern against PLAINTEXT
    // columns, because the same digits could be a cheque number and the service
    // cannot know which the user meant. What must never happen is the reverse:
    // the plaintext reaching an encrypted column, or a decrypt running in the
    // database so the ciphertext can be grepped.
    expect(params).toContain("%784-1990-1234567-1%");
    expect(text).not.toContain("pgp_sym_decrypt");
    expect(text).not.toContain("_enc ILIKE");
  });

  it("matches formatting variants of the same identifier", async () => {
    // `normalise` in pii.ts strips separators before hashing, so the owner may
    // type the number the way it is printed on the card or the way it is
    // printed on a visa. Both must reach the same row.
    expect(blindIndex("784-1990-1234567-1")).toBe(blindIndex("78419901234567 1"));
  });

  it("does not compute a blind index for an ordinary name", async () => {
    const c = capture(principal());
    await search(c.ctx, "chaudhry");
    const text = c.statements[0]!.sql;
    expect(text).not.toContain("national_id_bidx");
    expect(text).not.toContain("emirates_id_bidx");
  });

  it("reports an identity lookup that could not run rather than reporting no match", async () => {
    // A keyring that will not load makes exact ID lookup impossible. Returning
    // a confident "nothing found" would be the outbox defect in a new place: a
    // clean result for work that never happened.
    resetKeyring();
    const savedIndex = process.env.PII_INDEX_KEY;
    const savedSecret = process.env.AUTH_SECRET;
    delete process.env.PII_INDEX_KEY;
    delete process.env.AUTH_SECRET;
    try {
      const c = capture(principal());
      const res = await search(c.ctx, "784-1990-1234567-1");
      expect(res.identity).toBe("unavailable");
      // The rest of the search still runs — one broken subsystem does not take
      // the whole box down.
      expect(c.statements).toHaveLength(1);
      expect(c.statements[0]!.sql).not.toContain("national_id_bidx");
    } finally {
      process.env.PII_INDEX_KEY = savedIndex;
      process.env.AUTH_SECRET = savedSecret;
      resetKeyring();
    }
  });
});

describe("the query text itself", () => {
  it("does not run at all below the minimum length", async () => {
    const c = capture(principal());
    const res = await search(c.ctx, "m");
    expect(c.statements).toHaveLength(0);
    expect(res.groups).toEqual([]);
    expect(res.matched).toBe(0);
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it("collapses whitespace so 'Bay   Square ' is 'Bay Square'", async () => {
    const c = capture(principal());
    const res = await search(c.ctx, "  Bay   Square \n");
    expect(res.query).toBe("Bay Square");
    expect(c.statements[0]!.params).toContain("%Bay Square%");
  });

  it("escapes LIKE metacharacters so a typed % is a literal percent sign", async () => {
    const c = capture(principal());
    await search(c.ctx, "50%_off");
    expect(c.statements[0]!.params).toContain("%50\\%\\_off%");
  });

  it("binds the term as a parameter and never interpolates it", async () => {
    const c = capture(principal());
    await search(c.ctx, "o'connor");
    const { sql: text, params } = c.statements[0]!;
    expect(params).toContain("%o'connor%");
    expect(text).not.toContain("o'connor");
  });

  it("caps the per-group limit so a caller cannot ask for the whole table", async () => {
    const c = capture(principal());
    await search(c.ctx, "marina", { perGroup: 10_000 });
    expect(c.statements[0]!.params).toContain(25);
    expect(c.statements[0]!.params).not.toContain(10_000);
  });
});

describe("result assembly", () => {
  it("groups rows, carries the total from the window count and links to the rest", async () => {
    const c = capture(principal(), [
      rawHit({ grp_total: "59", id: "doc-1" }),
      rawHit({ grp_total: "59", id: "doc-2", title: "INV-SALON-01670" }),
      rawHit({ grp: "parties", grp_total: "8", id: "party-1", title: "Bilal Chaudhry 8",
               amount: null, bu_id: null, bu_name: null, bu_color: null, matched_on: "name" }),
    ]);
    const res = await search(c.ctx, "chaud");

    const docs = res.groups.find((g) => g.group === "documents")!;
    expect(docs.total).toBe(59);
    expect(docs.capped).toBe(false);
    expect(docs.hits).toHaveLength(2);
    expect(docs.hits[0]!.amount?.toString()).toBe("40");
    expect(docs.moreHref).toBe("/receivables");

    const parties = res.groups.find((g) => g.group === "parties")!;
    // The party link carries the party's own name, not the term typed, so the
    // customer list lands on the row that was clicked.
    expect(parties.hits[0]!.href).toBe("/crm?q=Bilal%20Chaudhry%208");
    expect(parties.hits[0]!.businessUnit).toBeNull();
    expect(parties.hits[0]!.amount).toBeNull();
    expect(res.matched).toBe(67);
  });

  it("says 'capped' rather than pretending the cap is the answer", async () => {
    const c = capture(principal(), [rawHit({ grp_total: "500" })]);
    const res = await search(c.ctx, "inv");
    expect(res.groups[0]!.total).toBe(500);
    expect(res.groups[0]!.capped).toBe(true);
  });

  it("offers no 'see all' when every match is already on screen", async () => {
    const c = capture(principal(), [rawHit({ grp_total: "1" })]);
    const res = await search(c.ctx, "INV-SALON-01669");
    expect(res.groups[0]!.moreHref).toBeNull();
  });

  it("puts the group holding the strongest match first", async () => {
    const c = capture(principal(), [
      rawHit({ grp: "jobs", grp_total: "3", id: "job-1", matched_on: "text" }),
      rawHit({ grp: "documents", grp_total: "1", id: "doc-1", matched_on: "number" }),
      rawHit({ grp: "employees", grp_total: "1", id: "emp-1", matched_on: "identity" }),
    ]);
    const res = await search(c.ctx, "784199012345671");
    expect(res.groups.map((g) => g.group)).toEqual(["employees", "documents", "jobs"]);
    expect(res.identity).toBe("matched");
  });

  it("reports the elapsed time it actually measured", async () => {
    const c = capture(principal(), [rawHit()]);
    const res = await search(c.ctx, "chaud");
    expect(res.tookMs).toBeGreaterThanOrEqual(0);
    expect(res.tookMs).toBeLessThan(5_000);
  });
});
