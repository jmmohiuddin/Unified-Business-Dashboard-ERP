import { describe, expect, it } from "vitest";
import * as M from "../money/index.ts";
import {
  chargeInternalJob,
  interBusinessTransfer,
  settleInterBusiness,
} from "./interco.ts";
import { ServiceError, type ServiceContext } from "./context.ts";
import type { Principal } from "../rbac.ts";

/**
 * INTER-BUSINESS POSTING — THE RECIPROCAL INVARIANT.
 *
 * PRD-02 FR-M06 and TRD-03 ADR-006 both state the same non-negotiable: for
 * every ordered pair (A, B), `due_from(A→B) === due_to(B→A)`, always, and both
 * legs are created in one transaction or neither is. EC-16 ("inter-business
 * balances do not net") asks for that as a check that fails CI.
 *
 * These tests assert it at the CONSTRUCTION SITE — the exact amounts this code
 * hands to `postJournal` — rather than after a round trip through Postgres.
 * That is deliberate and it is the strong form of the check:
 *
 *   · A database assertion can only see what was actually written, so it needs
 *     a seeded database and it only fails AFTER a bad posting exists. This
 *     fails on the arithmetic, in `npm run test:unit`, on every commit, with no
 *     database at all.
 *   · The property is a comparison between two exact decimals decided before
 *     any SQL is issued. Proving it needs no Postgres, and requiring one would
 *     mean the invariant is only checked where a database happens to exist.
 *
 * The complementary ledger-wide check — "is the invariant still true across
 * every journal that has ever touched 1700/2700, including ones this file did
 * not write" — is `interBusinessReconciliation`, which does need a database.
 * See the note at the bottom of this file about where that belongs.
 *
 * The transaction is a stub that records every statement and its parameters.
 * `writes` is what proves a refusal refused: a guard that throws after the
 * INSERT has landed is not a guard.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-9222-222222222222";
const TECH = "33333333-3333-4333-a333-333333333333";
const PROP = "44444444-4444-4444-b444-444444444444";
const SALON = "55555555-5555-4555-8555-555555555555";
const JOB = "66666666-6666-4666-9666-666666666666";
const TAX_CODE = "77777777-7777-4777-a777-777777777777";

const TODAY = "2026-08-06";

interface UnitSpec {
  code: string;
  name: string;
  kind: string;
  separate: boolean;
}

const UNITS: Record<string, UnitSpec> = {
  [TECH]: {
    code: "TECH",
    name: "Sumon Technical Services LLC",
    kind: "field_service",
    separate: true,
  },
  [PROP]: { code: "PROP", name: "Sumon Properties", kind: "rental", separate: true },
  // Not a separate legal entity: a division of the same taxable person, so a
  // transfer to it is not a supply and carries no VAT.
  [SALON]: { code: "SALON", name: "Royal Cuts Gents Salon", kind: "salon", separate: false },
};

/** A deterministic fake account id per system key, reversible in assertions. */
const accountId = (key: string) => `acct:${key}`;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: ACTOR,
    tenantId: TENANT,
    membershipId: "88888888-8888-4888-b888-888888888888",
    roleKey: over.roleKey ?? "owner",
    roleLevel: 90,
    scope: over.scope ?? "tenant",
    businessUnitIds: over.businessUnitIds ?? null,
    locationIds: null,
    permissions: over.permissions ?? new Set(["journal:post", "job:complete", "report:read"]),
    isPlatformAdmin: false,
  };
}

/**
 * Flatten a drizzle `sql` template into its literal text and its parameters.
 *
 * Nested `sql` fragments (`postJournal` builds one for the account lookup) are
 * walked recursively, so a parameter cannot hide inside a sub-fragment and
 * silently drop out of an assertion.
 */
function flatten(query: unknown, text: string[], params: unknown[]): void {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      flatten(chunk, text, params);
      continue;
    }
    const value = chunk && typeof chunk === "object" ? (chunk as { value?: unknown }).value : null;
    if (Array.isArray(value)) {
      text.push(value.join(" "));
      continue;
    }
    params.push(chunk);
  }
}

export interface RecordedLeg {
  accountKey: string;
  businessUnitId: string | null;
  debit: M.Money;
  credit: M.Money;
}

interface Recorder {
  ctx: ServiceContext;
  legs: RecordedLeg[];
  statements: string[];
  documents: { docNumber: string; subtotal: string; tax: string; total: string; meta: string }[];
  jobUpdates: string[];
}

/**
 * A transaction that answers every lookup `interco.ts` makes and records the
 * rest. It knows nothing about business rules — it is a tape recorder, so a
 * test that passes here cannot be passing because the stub agreed with the code.
 */
function recorder(
  options: {
    principal?: Principal;
    /** What `chargeInternalJob`'s job lookup should return. */
    job?: Record<string, unknown> | null;
    /** Movements the reciprocal-balance read should report, for settlement. */
    balance?: { creditor: string; debtor: string; on: string; dueFrom: string }[];
  } = {},
): Recorder {
  const legs: RecordedLeg[] = [];
  const statements: string[] = [];
  const documents: Recorder["documents"] = [];
  const jobUpdates: string[] = [];
  let lastAccountKeys: string[] = [];

  const execute = async (query: unknown) => {
    const textParts: string[] = [];
    const params: unknown[] = [];
    flatten(query, textParts, params);
    const text = textParts.join(" ").replace(/\s+/g, " ").trim();

    if (/FROM business_units WHERE id/i.test(text)) {
      const id = String(params[0]);
      const unit = UNITS[id];
      return unit
        ? [{
            id,
            code: unit.code,
            name: unit.name,
            kind: unit.kind,
            separate_legal_entity: unit.separate,
          }]
        : [];
    }

    if (/FROM tax_codes/i.test(text)) {
      return [{ id: TAX_CODE, rate: "0.050000" }];
    }

    if (/FROM fiscal_periods/i.test(text)) return [];

    if (/UPDATE number_series/i.test(text)) return [{ next_value: 1 }];

    if (/FROM jobs j/i.test(text)) {
      return options.job === undefined ? [] : options.job === null ? [] : [options.job];
    }

    if (/pg_advisory_xact_lock/i.test(text)) return [];

    // The reciprocal-balance read, for settlement.
    if (/FROM paired p JOIN business_units cb/i.test(text)) {
      return (options.balance ?? []).map((b) => ({
        creditor_id: b.creditor,
        creditor_code: UNITS[b.creditor]!.code,
        creditor_name: UNITS[b.creditor]!.name,
        creditor_color: "slate",
        debtor_id: b.debtor,
        debtor_code: UNITS[b.debtor]!.code,
        debtor_name: UNITS[b.debtor]!.name,
        debtor_color: "slate",
        posting_date: b.on,
        due_from: b.dueFrom,
        due_to: b.dueFrom,
        journals: 1,
      }));
    }

    if (/FROM accounts WHERE system_key/i.test(text)) {
      lastAccountKeys = params.filter((p): p is string => typeof p === "string");
      return lastAccountKeys.map((k) => ({ system_key: k, id: accountId(k) }));
    }

    if (/INSERT INTO journals /i.test(text)) {
      statements.push("INSERT journals");
      return [{ id: "journal-1" }];
    }

    if (/INSERT INTO journal_lines/i.test(text)) {
      // postJournal's leg insert, in declaration order:
      //   tenant, journal, line_no, account_id, business_unit_id,
      //   debit, credit, base_debit, base_credit, currency, party, memo
      const [, , , account, businessUnitId, debit, credit] = params as (string | null)[];
      const key = lastAccountKeys.find((k) => accountId(k) === account) ?? String(account);
      legs.push({
        accountKey: key,
        businessUnitId: businessUnitId ?? null,
        debit: M.fromDb(debit),
        credit: M.fromDb(credit),
      });
      return [];
    }

    if (/INSERT INTO documents/i.test(text)) {
      statements.push("INSERT documents");
      const strings = params.filter((p): p is string => typeof p === "string");
      documents.push({
        docNumber: strings.find((s) => s.startsWith("IC-")) ?? "",
        subtotal: String(params[params.length - 8] ?? ""),
        tax: String(params[params.length - 7] ?? ""),
        total: String(params[params.length - 6] ?? ""),
        meta: strings.find((s) => s.includes("interBusiness")) ?? "",
      });
      return [{ id: "document-1" }];
    }

    if (/UPDATE jobs SET invoiced_value/i.test(text)) {
      jobUpdates.push(String(params[0]));
      return [];
    }

    statements.push(text.split(/\s+/).slice(0, 3).join(" "));
    return [];
  };

  return {
    legs,
    statements,
    documents,
    jobUpdates,
    ctx: {
      tx: { execute } as unknown as ServiceContext["tx"],
      tenantId: TENANT,
      principal: options.principal ?? principal(),
      today: TODAY,
      baseCurrency: "AED",
    },
  };
}

const leg = (legs: RecordedLeg[], accountKey: string, businessUnitId: string) =>
  legs.find((l) => l.accountKey === accountKey && l.businessUnitId === businessUnitId);

const totalDebits = (legs: RecordedLeg[]) => M.sum(legs.map((l) => l.debit));
const totalCredits = (legs: RecordedLeg[]) => M.sum(legs.map((l) => l.credit));

// ── The invariant ───────────────────────────────────────────────────────────

describe("interBusinessTransfer — both legs, one journal", () => {
  it("posts due-from on the payer and due-to on the benefiter for the same gross", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });

    const dueFrom = leg(r.legs, "INTERCO_DUE_FROM", TECH);
    const dueTo = leg(r.legs, "INTERCO_DUE_TO", PROP);
    expect(dueFrom).toBeDefined();
    expect(dueTo).toBeDefined();

    // THE invariant, at the fils. Not `toBeCloseTo` — a tolerance here would
    // reopen exactly the class of bug the money module exists to close.
    expect(M.eq(dueFrom!.debit, dueTo!.credit)).toBe(true);
    expect(M.toDb(dueFrom!.debit)).toBe(result.gross);
    expect(M.toDb(dueTo!.credit)).toBe(result.gross);
  });

  it("balances exactly, in decimal", async () => {
    const r = recorder();
    await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      // Chosen so 5% VAT lands on a third of a fils: 33.33 × 0.05 = 1.6665.
      // Any float path or any per-leg independent rounding shows up here.
      amount: 33.33,
      nature: "service_performed",
      transferDate: TODAY,
    });

    expect(M.eq(totalDebits(r.legs), totalCredits(r.legs))).toBe(true);
    expect(M.toDb(totalDebits(r.legs))).toBe("69.9930");
  });

  it.each([
    ["cash_advance" as const, 500],
    ["shared_cost" as const, 750.55],
    ["service_performed" as const, 1200],
  ])("balances for nature %s", async (nature, amount) => {
    const r = recorder();
    await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount,
      nature,
      transferDate: TODAY,
      ...(nature === "shared_cost" ? { fundedFrom: "expense" as const, costAccountKey: "REPAIRS" } : {}),
    });
    expect(M.eq(totalDebits(r.legs), totalCredits(r.legs))).toBe(true);
    const dueFrom = leg(r.legs, "INTERCO_DUE_FROM", TECH)!;
    const dueTo = leg(r.legs, "INTERCO_DUE_TO", PROP)!;
    expect(M.eq(dueFrom.debit, dueTo.credit)).toBe(true);
  });

  it("writes NOTHING when the caller lacks journal:post", async () => {
    const r = recorder({ principal: principal({ permissions: new Set(["job:read"]) }) });
    await expect(
      interBusinessTransfer(r.ctx, {
        payingBusinessUnitId: TECH,
        benefitingBusinessUnitId: PROP,
        amount: 1200,
        nature: "service_performed",
        transferDate: TODAY,
      }),
    ).rejects.toBeInstanceOf(ServiceError);
    // The refusal has to come before the first write, not after it.
    expect(r.statements).toEqual([]);
    expect(r.legs).toEqual([]);
  });

  it("refuses a business transferring to itself", async () => {
    const r = recorder();
    await expect(
      interBusinessTransfer(r.ctx, {
        payingBusinessUnitId: TECH,
        benefitingBusinessUnitId: TECH,
        amount: 100,
        nature: "cash_advance",
        transferDate: TODAY,
      }),
    ).rejects.toThrow(/cannot transfer to itself/i);
    expect(r.legs).toEqual([]);
  });
});

// ── VAT, and what it does to the group ──────────────────────────────────────

describe("VAT posture follows the taxable person, not a preference", () => {
  it("charges VAT between two separate legal entities and makes it irrecoverable for a rental", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });

    expect(result.vat).toBe("standard_rated");
    expect(result.tax).toBe("60.0000");
    expect(result.gross).toBe("1260.0000");
    // Residential rent is exempt, so the property company cannot reclaim it.
    // Booking this to VAT_INPUT would be an FTA assessment risk.
    expect(result.inputVat).toBe("irrecoverable");
    expect(leg(r.legs, "VAT_OUTPUT", TECH)).toBeDefined();
    expect(leg(r.legs, "VAT_IRRECOVERABLE", PROP)).toBeDefined();
    expect(leg(r.legs, "VAT_INPUT", PROP)).toBeUndefined();
  });

  it("charges no VAT when the two sides are the same taxable person", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: SALON,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });

    expect(result.vat).toBe("out_of_scope");
    expect(result.tax).toBe("0.0000");
    expect(result.gross).toBe("1200.0000");
    expect(r.legs.filter((l) => l.accountKey.startsWith("VAT_"))).toEqual([]);
  });

  it("never charges VAT on a cash advance — an advance is not a supply", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 5000,
      nature: "cash_advance",
      transferDate: TODAY,
    });
    expect(result.vat).toBe("out_of_scope");
    expect(result.tax).toBe("0.0000");
    // Money moved, nothing was earned or spent: no income or expense leg at all.
    expect(leg(r.legs, "BANK", TECH)!.credit.toString()).toBe("5000");
    expect(leg(r.legs, "BANK", PROP)!.debit.toString()).toBe("5000");
  });

  it("leaves group profit unchanged when the transfer is out of scope", async () => {
    const r = recorder();
    await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: SALON,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });

    // Profit contribution is (credit − debit) on income AND expense lines alike.
    const INCOME = ["REV_SERVICE"];
    const EXPENSE = ["REPAIRS", "VAT_IRRECOVERABLE"];
    const profit = M.sum(
      r.legs
        .filter((l) => INCOME.includes(l.accountKey) || EXPENSE.includes(l.accountKey))
        .map((l) => M.sub(l.credit, l.debit)),
    );
    expect(M.isZero(profit)).toBe(true);
  });

  it("moves group profit by EXACTLY the irrecoverable VAT, and by nothing else", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });

    const INCOME = ["REV_SERVICE"];
    const EXPENSE = ["REPAIRS", "VAT_IRRECOVERABLE"];
    const profit = M.sum(
      r.legs
        .filter((l) => INCOME.includes(l.accountKey) || EXPENSE.includes(l.accountKey))
        .map((l) => M.sub(l.credit, l.debit)),
    );

    // This is the honest version of "group profit is unchanged": the revenue and
    // the cost cancel exactly, and the ONLY residue is the 5% that leaves the
    // group permanently for the FTA because the receiving side makes exempt
    // supplies. That residue is real money and must not be eliminated away — it
    // is the owner's strongest argument for VAT-grouping the entities.
    expect(M.toDb(M.neg(profit))).toBe(result.tax);
  });
});

// ── Transfer pricing, Q-12 ──────────────────────────────────────────────────

describe("pricing basis is recorded, and arm's length must be justified", () => {
  it("defaults to at_cost and records it on the document", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 1200,
      nature: "service_performed",
      transferDate: TODAY,
    });
    expect(result.pricingBasis).toBe("at_cost");
    const meta = JSON.parse(r.documents[0]!.meta) as {
      interBusiness: { pricingBasis: string; connectedPersons: boolean };
    };
    expect(meta.interBusiness.pricingBasis).toBe("at_cost");
    // Both sides separate taxable persons → connected persons under UAE CT.
    expect(meta.interBusiness.connectedPersons).toBe(true);
  });

  it("refuses an arm's-length price with no recorded basis, before writing anything", async () => {
    const r = recorder();
    await expect(
      interBusinessTransfer(r.ctx, {
        payingBusinessUnitId: TECH,
        benefitingBusinessUnitId: PROP,
        amount: 1200,
        nature: "service_performed",
        pricingBasis: "arms_length",
        transferDate: TODAY,
      }),
    ).rejects.toThrow(/basis recorded/i);
    expect(r.statements).toEqual([]);
  });

  it("accepts an arm's-length price and stores the justification", async () => {
    const r = recorder();
    const result = await interBusinessTransfer(r.ctx, {
      payingBusinessUnitId: TECH,
      benefitingBusinessUnitId: PROP,
      amount: 1200,
      costAmount: 430,
      nature: "service_performed",
      pricingBasis: "arms_length",
      pricingBasisNote: "Published AC service price list, same rate charged to third parties.",
      transferDate: TODAY,
    });
    expect(result.pricingBasis).toBe("arms_length");
    const meta = JSON.parse(r.documents[0]!.meta) as {
      interBusiness: { pricingBasisNote: string; armsLengthAmount: string; costAmount: string };
    };
    expect(meta.interBusiness.pricingBasisNote).toMatch(/price list/);
    expect(meta.interBusiness.armsLengthAmount).toBe("1200.0000");
    // The cost is kept alongside the price so the margin is evidenced, not implied.
    expect(meta.interBusiness.costAmount).toBe("430.0000");
  });

  /**
   * OPEN QUESTION Q-12 — inter-business services at cost or at arm's length.
   *
   * Both paths are built and both are tested above. What is NOT decided is
   * which one the owner's tax adviser says must be the default, and that answer
   * is worth real money: at cost the AC company earns nothing on internal work
   * and the FTA may impute a margin under the connected-person rules; at arm's
   * length the margin is real and needs benchmarking evidence per transfer.
   *
   * Nothing here should be filled in by guessing. When the answer lands, change
   * `pricingBasis`'s default in `interco.ts` and back-fill by re-pricing the
   * documents whose metadata records the superseded basis.
   */
  it.todo("Q-12: default basis confirmed by the owner's tax adviser");

  /**
   * OPEN QUESTION Q-1 — standalone parking VAT.
   *
   * `defaultInputVat` keys on `business_units.kind`, and parking is `rental`
   * exactly like the residential flats, so input VAT on a transfer INTO the
   * parking business is currently treated as irrecoverable. If standalone
   * parking is a standard-rated supply, that is wrong and over-costs parking by
   * 5% on every internal charge. The override exists (`inputVat: "recoverable"`)
   * but the DEFAULT must not be changed on a guess.
   */
  it.todo("Q-1: input VAT recoverability for the standalone parking business");
});

// ── The job hook ────────────────────────────────────────────────────────────

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  job_number: "JOB-000311",
  title: "AC not cooling",
  business_unit_id: TECH,
  unit_business_unit_id: PROP,
  unit_name: "Marina Flat 1204",
  labor_cost: "77.0000",
  material_cost: "106.0000",
  quoted_value: "220.0000",
  already_charged: null,
  ...over,
});

describe("chargeInternalJob — the wedge, fired automatically", () => {
  it("charges the unit's owner at cost: labour plus materials", async () => {
    const r = recorder({ job: jobRow() });
    const charge = await chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY });

    expect(charge).not.toBeNull();
    expect(charge!.net).toBe("183.0000");
    expect(charge!.benefitingBusinessName).toBe("Sumon Properties");
    // Not the quoted 220 — that is a market price, and choosing it would be
    // this code answering Q-12 by itself.
    expect(charge!.pricingBasis).toBe("at_cost");
    expect(M.eq(totalDebits(r.legs), totalCredits(r.legs))).toBe(true);
    expect(M.eq(
      leg(r.legs, "INTERCO_DUE_FROM", TECH)!.debit,
      leg(r.legs, "INTERCO_DUE_TO", PROP)!.credit,
    )).toBe(true);
  });

  it("uses the quote when the caller explicitly asks for arm's length", async () => {
    const r = recorder({ job: jobRow() });
    const charge = await chargeInternalJob(r.ctx, {
      jobId: JOB,
      chargedOn: TODAY,
      pricingBasis: "arms_length",
      pricingBasisNote: "Quoted at the same rate as an external customer.",
    });
    expect(charge!.net).toBe("220.0000");
  });

  it("does NOTHING when the unit belongs to the business that did the work", async () => {
    // The old `internal: Boolean(job.unit_id)` called this inter-company. It is
    // not: there is no counterparty, and charging it would inflate both sides of
    // one business's P&L against an account that must mirror another business.
    const r = recorder({ job: jobRow({ unit_business_unit_id: TECH }) });
    expect(await chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY })).toBeNull();
    expect(r.legs).toEqual([]);
  });

  it("does nothing for a job with no unit at all", async () => {
    const r = recorder({ job: jobRow({ unit_business_unit_id: null, unit_name: null }) });
    expect(await chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY })).toBeNull();
    expect(r.legs).toEqual([]);
  });

  it("refuses to charge the same job twice", async () => {
    const r = recorder({ job: jobRow({ already_charged: "document-existing" }) });
    await expect(
      chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY }),
    ).rejects.toThrow(/already been charged/i);
    expect(r.legs).toEqual([]);
  });

  it("posts nothing rather than a zero transfer when the job cost nothing", async () => {
    const r = recorder({ job: jobRow({ labor_cost: "0", material_cost: "0" }) });
    expect(await chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY })).toBeNull();
    expect(r.legs).toEqual([]);
  });

  it("fires for a technician who holds job:complete but NOT journal:post", async () => {
    // The whole point of WF-05 §16.1: the charge is recorded by the person who
    // did the work. Requiring `journal:post` here would mean it never fires for
    // the only role that is ever standing in the flat.
    const r = recorder({
      job: jobRow(),
      principal: principal({
        roleKey: "maintenance_staff",
        permissions: new Set(["job:read", "job:update", "job:complete"]),
      }),
    });
    const charge = await chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY });
    expect(charge).not.toBeNull();
    expect(charge!.gross).toBe("192.1500");
  });

  it("refuses a caller with neither permission", async () => {
    const r = recorder({
      job: jobRow(),
      principal: principal({ permissions: new Set(["job:read"]) }),
    });
    await expect(
      chargeInternalJob(r.ctx, { jobId: JOB, chargedOn: TODAY }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(r.statements).toEqual([]);
  });
});

// ── Settlement ──────────────────────────────────────────────────────────────

describe("settleInterBusiness", () => {
  const balance = [{ creditor: TECH, debtor: PROP, on: "2026-05-04", dueFrom: "12400.0000" }];

  it("reduces both sides by the same amount in one journal", async () => {
    const r = recorder({ balance });
    const result = await settleInterBusiness(r.ctx, {
      creditorBusinessUnitId: TECH,
      debtorBusinessUnitId: PROP,
      amount: 12400,
      settledOn: TODAY,
      method: "bank",
    });

    expect(result.settled).toBe("12400.0000");
    expect(result.remaining).toBe("0.0000");
    expect(M.eq(totalDebits(r.legs), totalCredits(r.legs))).toBe(true);
    // Symmetric: the receivable and the payable fall by the identical amount.
    expect(M.eq(
      leg(r.legs, "INTERCO_DUE_FROM", TECH)!.credit,
      leg(r.legs, "INTERCO_DUE_TO", PROP)!.debit,
    )).toBe(true);
  });

  it("refuses over-settlement exactly rather than clamping it", async () => {
    const r = recorder({ balance });
    await expect(
      settleInterBusiness(r.ctx, {
        creditorBusinessUnitId: TECH,
        debtorBusinessUnitId: PROP,
        // One fils more than is owed. `GREATEST(0, …)` would swallow this and
        // leave a phantom credit; the house rule says refuse exactly.
        amount: 12400.0001,
        settledOn: TODAY,
      }),
    ).rejects.toThrow(/cannot settle/i);
    expect(r.legs).toEqual([]);
  });

  it("refuses to settle a pair with no balance", async () => {
    const r = recorder({ balance: [] });
    await expect(
      settleInterBusiness(r.ctx, {
        creditorBusinessUnitId: TECH,
        debtorBusinessUnitId: PROP,
        amount: 1,
        settledOn: TODAY,
      }),
    ).rejects.toThrow(/cannot settle/i);
  });

  it("refuses a business settling with itself", async () => {
    const r = recorder({ balance });
    await expect(
      settleInterBusiness(r.ctx, {
        creditorBusinessUnitId: TECH,
        debtorBusinessUnitId: TECH,
        amount: 1,
        settledOn: TODAY,
      }),
    ).rejects.toThrow(/settle with itself/i);
  });
});

// ── EC-16, stated as a property ─────────────────────────────────────────────

describe("EC-16 — inter-business balances net, whatever the inputs", () => {
  /**
   * The reciprocal invariant does not depend on the amount, the nature, the VAT
   * posture or the direction. Rather than assert it once on a convenient
   * number, walk a spread that includes the values that break naive
   * implementations: a repeating third, an amount whose 5% falls below the
   * storage precision, and one at the top of the allowed range.
   *
   * A ledger-wide version of this — over every journal that has ever touched
   * 1700/2700, including ones this file did not write — is
   * `interBusinessReconciliation`, which needs a database and therefore belongs
   * in the write-layer suite rather than here.
   */
  const AMOUNTS = [0.0001, 0.03, 33.333, 1200, 99_999_999];
  const PAIRS: [string, string][] = [
    [TECH, PROP],
    [PROP, TECH],
    [TECH, SALON],
    [SALON, PROP],
  ];

  for (const amount of AMOUNTS) {
    for (const [payer, benefiter] of PAIRS) {
      it(`due_from === due_to for ${amount} from ${UNITS[payer]!.code} to ${UNITS[benefiter]!.code}`, async () => {
        const r = recorder();
        await interBusinessTransfer(r.ctx, {
          payingBusinessUnitId: payer,
          benefitingBusinessUnitId: benefiter,
          amount,
          nature: "service_performed",
          transferDate: TODAY,
        });

        const dueFrom = leg(r.legs, "INTERCO_DUE_FROM", payer)!;
        const dueTo = leg(r.legs, "INTERCO_DUE_TO", benefiter)!;
        expect(M.eq(dueFrom.debit, dueTo.credit)).toBe(true);
        expect(M.eq(totalDebits(r.legs), totalCredits(r.legs))).toBe(true);
        // And every leg is at storage precision, so nothing is lost on the way
        // into `numeric(18,4)`.
        for (const l of r.legs) {
          expect(M.eq(l.debit, M.quantize(l.debit))).toBe(true);
          expect(M.eq(l.credit, M.quantize(l.credit))).toBe(true);
        }
      });
    }
  }
});
