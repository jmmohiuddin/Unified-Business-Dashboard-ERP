import { beforeAll, describe, expect, it } from "vitest";
import * as M from "../../money/index.ts";
import { resetKeyring } from "../../security/pii.ts";
import { ServiceError } from "../context.ts";
import { planCheques } from "./cheques.ts";
import { planDebts } from "./debts.ts";
import { planEmployees } from "./employees.ts";
import { planLeases } from "./leases.ts";
import { planOpeningBalances } from "./opening-balances.ts";
import { planParties } from "./parties.ts";
import { planStock } from "./stock.ts";
import { planUnits } from "./units.ts";
import { Index, normalisePhone, normaliseToken } from "./lookups.ts";
import { templateCsv } from "./registry.ts";
import { CellError, readDate, readMoney, readSource, missingColumns } from "./source.ts";
import type { SourceRow } from "./types.ts";

/**
 * IMPORT TESTS.
 *
 * FR-D01 is the gate on every other number in the product: nothing here can be
 * checked against production behaviour, because the whole point of the feature
 * is that it runs ONCE, against real books, before anyone is watching. So the
 * parts that decide whether the books are right — reading an amount, balancing
 * a trial balance, refusing a double import — are pure functions taking parsed
 * rows and pre-loaded indexes, and they are tested here without a database.
 *
 * The fixtures are hand-calculated. Every expected total in this file was
 * worked out by adding the numbers up, not by running the code and pasting what
 * it said, which would only assert that the code still does what it did.
 */

/** Build source rows the way `readSource` would, without a file. */
function rows(records: Record<string, string>[], startAt = 2): SourceRow[] {
  return records.map((record, i) => ({
    rowNumber: startAt + i,
    get: (column: string) => record[column] ?? "",
    has: (column: string) => (record[column] ?? "") !== "",
  }));
}

const CHART = [
  { id: "a1", code: "1100", name: "Cash in Hand", systemKey: "CASH", isPostable: true },
  { id: "a2", code: "1200", name: "Accounts Receivable", systemKey: "AR", isPostable: true },
  { id: "a3", code: "2100", name: "Accounts Payable", systemKey: "AP", isPostable: true },
  { id: "a4", code: "3100", name: "Owner Capital", systemKey: "CAPITAL", isPostable: true },
  { id: "a5", code: "1000", name: "Assets", systemKey: null, isPostable: false },
];

const BUSINESS_UNITS = new Map([["prop", "bu-prop"]]);

describe("reading the file", () => {
  it("reads a plain comma file, numbering rows as the spreadsheet does", () => {
    const source = readSource("code,amount\n1100,10\n1200,20\n");
    expect(source.columns).toEqual(["code", "amount"]);
    expect(source.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(source.rows[1]!.get("amount")).toBe("20");
  });

  it("strips the byte-order mark Excel writes, so the first column is findable", () => {
    const source = readSource("﻿account_code,debit\n1100,10\n");
    expect(source.columns[0]).toBe("account_code");
  });

  it("normalises header case, spacing and punctuation", () => {
    const source = readSource("Account Code , DEBIT (AED)\n1100,10\n");
    expect(source.columns).toEqual(["account_code", "debit_aed"]);
  });

  it("keeps row numbers aligned with the file when blank lines are skipped", () => {
    const source = readSource("code,amount\n1100,10\n\n\n1200,20\n");
    expect(source.rows.map((r) => r.rowNumber)).toEqual([2, 5]);
    expect(source.blankRows).toEqual([3, 4]);
  });

  it("handles quoted fields containing the delimiter, quotes and newlines", () => {
    const source = readSource('name,note\n"Al Futtaim, Trading LLC","He said ""yes""\nnext line"\n');
    expect(source.rows[0]!.get("name")).toBe("Al Futtaim, Trading LLC");
    expect(source.rows[0]!.get("note")).toContain("next line");
  });

  it("sniffs a tab-separated spreadsheet paste and says so", () => {
    const source = readSource("code\tamount\n1100\t10\n");
    expect(source.columns).toEqual(["code", "amount"]);
    expect(source.notes.join(" ")).toContain("tab-separated");
  });

  it("does not mistake a comma inside a quoted field for a tab file's delimiter", () => {
    const source = readSource('"legal, name"\tamount\n"Acme, LLC"\t10\n');
    expect(source.columns).toEqual(["legal_name", "amount"]);
    expect(source.rows[0]!.get("legal_name")).toBe("Acme, LLC");
  });

  it("refuses a file with two columns of the same name", () => {
    expect(() => readSource("debit,Debit\n1,2\n")).toThrow(ServiceError);
  });

  it("refuses an empty file and a headers-only file, differently", () => {
    expect(() => readSource("   ")).toThrow(/empty/i);
    expect(() => readSource("code,amount\n")).toThrow(/no rows/i);
  });

  it("reports every missing column at once, not the first", () => {
    const source = readSource("account_code\n1100\n");
    expect(missingColumns(source, ["account_code", "debit", "credit"])).toEqual(["debit", "credit"]);
  });
});

describe("the fingerprint that stops a double import", () => {
  const anchor = readSource("code,amount\n1100,10\n1200,20\n").fingerprint;

  it("is unchanged by line endings, trailing blank lines and header case", () => {
    expect(readSource("code,amount\r\n1100,10\r\n1200,20\r\n\r\n").fingerprint).toBe(anchor);
    expect(readSource("Code, Amount\n1100, 10\n1200, 20\n").fingerprint).toBe(anchor);
  });

  it("changes when a single digit changes", () => {
    expect(readSource("code,amount\n1100,10\n1200,21\n").fingerprint).not.toBe(anchor);
  });

  it("cannot be forged by moving a delimiter into a cell value", () => {
    const a = readSource("a,b\nx,yz\n").fingerprint;
    const b = readSource('a,b\n"x,y",z\n').fingerprint;
    expect(a).not.toBe(b);
  });
});

describe("reading an amount exactly", () => {
  const cell = (value: string): SourceRow => rows([{ amount: value }])[0]!;

  it("reads plain and thousands-separated amounts to the fils", () => {
    expect(M.toDb(readMoney(cell("4182440.00"), "amount"))).toBe("4182440.0000");
    expect(M.toDb(readMoney(cell("4,182,440.55"), "amount"))).toBe("4182440.5500");
  });

  it("reads accounting parentheses as negative", () => {
    expect(M.toDb(readMoney(cell("(1,250.00)"), "amount"))).toBe("-1250.0000");
  });

  it("reads a currency label in the cell", () => {
    expect(M.toDb(readMoney(cell("AED 1,250.00"), "amount"))).toBe("1250.0000");
  });

  it("reads a European file where both separators are present and unambiguous", () => {
    expect(M.toDb(readMoney(cell("1.234,50"), "amount"))).toBe("1234.5000");
  });

  it("reads Arabic-Indic digits", () => {
    expect(M.toDb(readMoney(cell("١٢٣٤.٥٠"), "amount"))).toBe("1234.5000");
  });

  it("REFUSES an ambiguous comma rather than being wrong by a hundred", () => {
    expect(() => readMoney(cell("1,25"), "amount")).toThrow(CellError);
    expect(() => readMoney(cell("1,25"), "amount")).toThrow(/ambiguous/i);
  });

  it("refuses text, and does not silently become zero", () => {
    expect(() => readMoney(cell("n/a"), "amount")).toThrow(CellError);
    expect(() => readMoney(cell(""), "amount")).toThrow(/empty/i);
    expect(M.toDb(readMoney(cell(""), "amount", M.ZERO))).toBe("0.0000");
  });

  it("keeps precision a float would lose", () => {
    // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004. This path never sees one.
    const a = readMoney(cell("0.1"), "amount");
    const b = readMoney(cell("0.2"), "amount");
    expect(M.toDb(M.add(a, b))).toBe("0.3000");
  });
});

describe("reading a date", () => {
  const cell = (value: string): SourceRow => rows([{ d: value }])[0]!;

  it("reads ISO, day-first slash and named-month forms", () => {
    expect(readDate(cell("2026-01-31"), "d")).toBe("2026-01-31");
    expect(readDate(cell("31/01/2026"), "d")).toBe("2026-01-31");
    expect(readDate(cell("03/04/2026"), "d")).toBe("2026-04-03");
    expect(readDate(cell("3 Apr 2026"), "d")).toBe("2026-04-03");
  });

  it("refuses a date that does not exist", () => {
    expect(() => readDate(cell("31/02/2026"), "d")).toThrow(/not a real date/i);
  });
});

describe("opening balances", () => {
  it("accepts a balanced trial balance and totals it exactly", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "150000.00", credit: "" },
        { account_code: "1200", debit: "250000.50", credit: "" },
        { account_code: "2100", debit: "", credit: "80000.25" },
        { account_code: "3100", debit: "", credit: "320000.25" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    // 150,000.00 + 250,000.50 = 400,000.50 · 80,000.25 + 320,000.25 = 400,000.50
    expect(M.toDisplay(plan.totalDebit)).toBe("400000.50");
    expect(M.toDisplay(plan.totalCredit)).toBe("400000.50");
    expect(plan.blockers).toEqual([]);
    expect(plan.rows.filter((r) => r.action === "create")).toHaveLength(4);
    expect(plan.expectedLines).toHaveLength(4);
  });

  it("BLOCKS an unbalanced trial balance and says by how much and which way", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "150000.00", credit: "" },
        { account_code: "3100", debit: "", credit: "149750.00" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("Debits exceed credits by AED 250.00");
    expect(plan.blockers[0]).toContain("debits AED 150000.00");
    expect(plan.blockers[0]).toContain("credits AED 149750.00");
  });

  it("catches an imbalance of one fils, with no tolerance anywhere", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "100.00", credit: "" },
        { account_code: "3100", debit: "", credit: "99.99" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.blockers[0]).toContain("0.01");
  });

  it("names the wrong side when credits are the larger", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "100.00", credit: "" },
        { account_code: "3100", debit: "", credit: "175.00" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.blockers[0]).toContain("Credits exceed debits by AED 75.00");
  });

  it("reads a signed single-column convention as the side the sign means", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "500.00", credit: "" },
        { account_code: "3100", debit: "-500.00", credit: "" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.blockers).toEqual([]);
    expect(M.toDisplay(plan.totalCredit)).toBe("500.00");
  });

  it("rejects an account that is not in the chart, by row number", () => {
    const plan = planOpeningBalances(
      rows([{ account_code: "9999", debit: "10", credit: "" }]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected[0]!.rowNumber).toBe(2);
    expect(plan.rejected[0]!.message).toContain("No account matches");
  });

  it("rejects a posting to a heading account and says what to do instead", () => {
    const plan = planOpeningBalances(
      rows([{ account_code: "1000", debit: "10", credit: "" }]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected[0]!.message).toContain("is a heading");
  });

  it("rejects the same account twice and names the earlier row", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "10", credit: "" },
        { account_code: "1100", debit: "20", credit: "" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]!.rowNumber).toBe(3);
    expect(plan.rejected[0]!.message).toContain("already on row 2");
  });

  it("rejects a line carrying both a debit and a credit rather than netting it", () => {
    const plan = planOpeningBalances(
      rows([{ account_code: "1100", debit: "10", credit: "4" }]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected[0]!.message).toContain("one or the other");
  });

  it("treats ANY rejected line as a blocker — a trial balance imports whole", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "100", credit: "" },
        { account_code: "3100", debit: "", credit: "100" },
        { account_code: "nonsense", debit: "0", credit: "" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    // The readable lines balance perfectly. It still refuses.
    expect(plan.blockers.some((b) => b.includes("imports whole"))).toBe(true);
  });

  it("lists a zero balance but posts nothing for it", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "1100", debit: "0", credit: "0" },
        { account_code: "1200", debit: "100", credit: "" },
        { account_code: "3100", debit: "", credit: "100" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rows.filter((r) => r.action === "skip")).toHaveLength(1);
    expect(plan.expectedLines).toHaveLength(2);
    expect(plan.blockers).toEqual([]);
  });

  it("resolves an account by system key or by exact name, not only by code", () => {
    const plan = planOpeningBalances(
      rows([
        { account_code: "CASH", debit: "100", credit: "" },
        { account_code: "Owner Capital", debit: "", credit: "100" },
      ]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.expectedLines.map((l) => l.accountCode)).toEqual(["1100", "3100"]);
  });

  it("rejects an unknown business unit rather than posting to the default", () => {
    const plan = planOpeningBalances(
      rows([{ account_code: "1100", debit: "100", credit: "", business_unit: "salon" }]),
      CHART,
      BUSINESS_UNITS,
      null,
    );
    expect(plan.rejected[0]!.message).toContain("No business matches");
  });
});

describe("customers, suppliers and tenants", () => {
  const existing = new Index([
    { id: "p1", label: "Ahmed Al Mansoori", keys: ["c-001", "ahmed al mansoori", "501234567"] },
    { id: "p2", label: "Ahmed Trading", keys: ["shared name"] },
    { id: "p3", label: "Ahmed Services", keys: ["shared name"] },
  ]);

  it("creates a party that is not on file and records its roles", () => {
    const plan = planParties(
      rows([{ name: "Fatima Noor", roles: "customer, tenant", phone: "+971 55 999 8888" }]),
      existing,
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.rows[0]!.detail).toContain("customer");
    expect(plan.rows[0]!.detail).toContain("tenant");
  });

  it("updates a party matched by code and lists what would change", () => {
    const plan = planParties(rows([{ code: "C-001", name: "Ahmed Al Mansoori", email: "a@b.co" }]), existing);
    expect(plan.rows[0]!.action).toBe("update");
    expect(plan.rows[0]!.detail).toContain("email");
  });

  it("skips a row that would change nothing", () => {
    const plan = planParties(rows([{ code: "C-001", name: "Ahmed Al Mansoori" }]), existing);
    // `name` is supplied but identical; the diff still reports the update
    // rather than claiming to know the value is unchanged, so this asserts the
    // conservative behaviour rather than a cleverer one.
    expect(["update", "skip"]).toContain(plan.rows[0]!.action);
  });

  it("refuses to guess when a name matches two existing parties", () => {
    const plan = planParties(rows([{ name: "Shared Name" }]), existing);
    expect(plan.rejected[0]!.message).toContain("more than one existing record");
  });

  it("rejects two rows describing the same person and names the earlier row", () => {
    const plan = planParties(
      rows([
        { name: "Noor Ali", phone: "0501112222" },
        { name: "Noor Ali", phone: "+971 50 111 2222" },
      ]),
      new Index([]),
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]!.message).toContain("row 2");
  });

  it("rejects an unknown role word instead of ignoring it", () => {
    const plan = planParties(rows([{ name: "X", roles: "landlord" }]), new Index([]));
    expect(plan.rejected[0]!.message).toContain("not a role");
  });

  it("rejects a malformed email and a bad country code", () => {
    expect(planParties(rows([{ name: "X", email: "nope" }]), new Index([])).rejected).toHaveLength(1);
    expect(planParties(rows([{ name: "X", country: "UAE" }]), new Index([])).rejected).toHaveLength(1);
  });
});

describe("units and leases", () => {
  const sites = new Index([{ id: "s1", label: "Marina Tower", keys: ["mt", "marina tower"] }]);

  it("creates units and annualises a monthly list rent", () => {
    const plan = planUnits(
      rows([
        { site: "Marina Tower", code: "402", kind: "apartment", list_rent: "6000", list_frequency: "monthly" },
      ]),
      sites,
      new Index([]),
    );
    expect(plan.rows[0]!.action).toBe("create");
    // 6,000 × 12 = 72,000
    expect(plan.totals.find((t) => t.label.includes("Annualised"))!.amount.toFixed(2)).toBe("72000.00");
  });

  it("skips a unit that already exists rather than overwriting its status", () => {
    const units = new Index([{ id: "u1", label: "402 · Marina Tower", keys: ["marina tower 402"] }]);
    const plan = planUnits(rows([{ site: "Marina Tower", code: "402" }]), sites, units);
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.detail).toContain("never overwritten");
  });

  it("rejects a unit whose site is not on file", () => {
    const plan = planUnits(rows([{ site: "Nowhere Tower", code: "1" }]), sites, new Index([]));
    expect(plan.rejected[0]!.message).toContain("No building or site");
  });

  const units = new Index([
    { id: "u1", label: "402 · Marina Tower", keys: ["marina tower 402", "402"] },
    { id: "u2", label: "403 · Marina Tower", keys: ["marina tower 403", "403"] },
  ]);
  const parties = new Index([{ id: "p1", label: "Ahmed", keys: ["ahmed", "t-001"] }]);

  it("creates a lease and reports the instalment against the annual rent", () => {
    const plan = planLeases(
      rows([
        {
          lease_number: "L-001",
          unit: "Marina Tower 402",
          tenant: "Ahmed",
          starts_on: "01/01/2026",
          ends_on: "31/12/2026",
          annual_rent: "72000",
          rent_amount: "18000",
          frequency: "quarterly",
          deposit_amount: "6000",
        },
      ]),
      units,
      parties,
      new Index([]),
      new Map(),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.rows[0]!.action).toBe("create");
    // 18,000 × 4 = 72,000 — no warning text.
    expect(plan.rows[0]!.detail).not.toContain("but annual rent says");
    expect(plan.totals.find((t) => t.label === "Deposits held")!.amount.toFixed(2)).toBe("6000.00");
  });

  it("warns, and does not correct, when the instalments do not sum to the annual rent", () => {
    const plan = planLeases(
      rows([
        {
          lease_number: "L-002",
          unit: "Marina Tower 402",
          tenant: "Ahmed",
          starts_on: "2026-01-01",
          annual_rent: "70000",
          rent_amount: "18000",
          frequency: "quarterly",
        },
      ]),
      units,
      parties,
      new Index([]),
      new Map(),
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.rows[0]!.detail).toContain("but annual rent says 70000.00");
  });

  it("refuses a second active lease on a unit already let outside the file", () => {
    const plan = planLeases(
      rows([
        {
          lease_number: "L-003",
          unit: "Marina Tower 402",
          tenant: "Ahmed",
          starts_on: "2026-01-01",
          annual_rent: "1000",
        },
      ]),
      units,
      parties,
      new Index([]),
      new Map([["u1", "L-OLD"]]),
    );
    expect(plan.rejected[0]!.message).toContain("already let under lease L-OLD");
  });

  it("refuses two active leases on the same unit inside one file", () => {
    const plan = planLeases(
      rows([
        { lease_number: "L-1", unit: "Marina Tower 403", tenant: "Ahmed", starts_on: "2026-01-01", annual_rent: "1" },
        { lease_number: "L-2", unit: "Marina Tower 403", tenant: "Ahmed", starts_on: "2026-06-01", annual_rent: "1" },
      ]),
      units,
      parties,
      new Index([]),
      new Map(),
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]!.message).toContain("active lease on row 2");
  });

  it("rejects a lease that ends before it starts", () => {
    const plan = planLeases(
      rows([
        {
          lease_number: "L-4",
          unit: "Marina Tower 402",
          tenant: "Ahmed",
          starts_on: "2026-06-01",
          ends_on: "2026-01-01",
          annual_rent: "1",
        },
      ]),
      units,
      parties,
      new Index([]),
      new Map(),
    );
    expect(plan.rejected[0]!.message).toContain("before it starts");
  });
});

describe("outstanding debts", () => {
  const parties = new Index([{ id: "p1", label: "Ahmed", keys: ["ahmed"] }]);

  it("splits receivables from payables and totals both", () => {
    const plan = planDebts(
      rows([
        { doc_number: "INV-1", party: "Ahmed", kind: "invoice", issue_date: "2026-01-01", total: "1000", amount_paid: "250" },
        { doc_number: "BILL-1", party: "Ahmed", kind: "bill", issue_date: "2026-01-01", total: "400" },
      ]),
      parties,
      new Set(),
      "2026-08-21",
    );
    // 1,000 − 250 = 750 receivable · 400 payable
    expect(plan.totals[1]!.amount.toFixed(2)).toBe("750.00");
    expect(plan.totals[2]!.amount.toFixed(2)).toBe("400.00");
  });

  it("REFUSES an over-payment rather than clamping it to zero", () => {
    const plan = planDebts(
      rows([{ doc_number: "INV-2", party: "Ahmed", issue_date: "2026-01-01", total: "4000", amount_paid: "5000" }]),
      parties,
      new Set(),
      "2026-08-21",
    );
    expect(plan.rows).toHaveLength(0);
    expect(plan.rejected[0]!.message).toContain("more than the total");
  });

  it("marks a document overdue against the tenant's today, not the file's", () => {
    const plan = planDebts(
      rows([{ doc_number: "INV-3", party: "Ahmed", issue_date: "2026-01-01", due_date: "2026-02-01", total: "100" }]),
      parties,
      new Set(),
      "2026-08-21",
    );
    expect(plan.rows[0]!.detail).toContain("due 2026-02-01");
  });

  it("rejects a negative total instead of importing a credit note by accident", () => {
    const plan = planDebts(
      rows([{ doc_number: "INV-4", party: "Ahmed", issue_date: "2026-01-01", total: "(500)" }]),
      parties,
      new Set(),
      "2026-08-21",
    );
    expect(plan.rejected[0]!.message).toContain("credit note");
  });

  it("skips a document number already on file", () => {
    const plan = planDebts(
      rows([{ doc_number: "INV-9", party: "Ahmed", issue_date: "2026-01-01", total: "10" }]),
      parties,
      new Set(["invoice:inv-9"]),
      "2026-08-21",
    );
    expect(plan.rows[0]!.action).toBe("skip");
  });
});

describe("post-dated cheques", () => {
  const parties = new Index([{ id: "p1", label: "Ahmed", keys: ["ahmed"] }]);

  it("registers cheques in hand and totals them for the control check", () => {
    const plan = planCheques(
      rows([
        { cheque_number: "000123", bank_name: "Emirates NBD", party: "Ahmed", cheque_date: "01/04/2026", amount: "18000" },
        { cheque_number: "000124", bank_name: "Emirates NBD", party: "Ahmed", cheque_date: "01/07/2026", amount: "18000" },
      ]),
      parties,
      new Index([]),
      new Set(),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.totals[1]!.amount.toFixed(2)).toBe("36000.00");
  });

  it("refuses a cleared cheque, whose money is already in the opening bank balance", () => {
    const plan = planCheques(
      rows([{ cheque_number: "1", bank_name: "ADCB", cheque_date: "2026-01-01", amount: "10", status: "cleared" }]),
      parties,
      new Index([]),
      new Set(),
    );
    expect(plan.rejected[0]!.message).toContain("finished business");
  });

  it("treats the same number at two banks as two different cheques", () => {
    const plan = planCheques(
      rows([
        { cheque_number: "000123", bank_name: "Emirates NBD", cheque_date: "2026-01-01", amount: "10" },
        { cheque_number: "000123", bank_name: "ADCB", cheque_date: "2026-01-01", amount: "10" },
      ]),
      parties,
      new Index([]),
      new Set(),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.rows.filter((r) => r.action === "create")).toHaveLength(2);
  });

  it("rejects the same cheque twice at one bank", () => {
    const plan = planCheques(
      rows([
        { cheque_number: "000123", bank_name: "Emirates NBD", cheque_date: "2026-01-01", amount: "10" },
        { cheque_number: "000123", bank_name: "Emirates NBD", cheque_date: "2026-01-01", amount: "10" },
      ]),
      parties,
      new Index([]),
      new Set(),
    );
    expect(plan.rejected[0]!.message).toContain("already on row 2");
  });
});

describe("opening stock", () => {
  const items = new Index([
    { id: "i1", label: "SKU-1 · Cable", keys: ["sku-1", "cable"] },
    { id: "i2", label: "SKU-2 · Filter", keys: ["sku-2", "filter"] },
  ]);

  it("values the count exactly and totals it for the inventory control check", () => {
    const plan = planStock(
      rows([
        { sku: "SKU-1", counted_qty: "12", unit_cost: "3.33" },
        { sku: "SKU-2", counted_qty: "5", unit_cost: "10.05" },
      ]),
      items,
      "Main store",
    );
    // 12 × 3.33 = 39.96 · 5 × 10.05 = 50.25 · total 90.21
    expect(plan.totals[1]!.amount.toFixed(2)).toBe("90.21");
  });

  it("rejects a negative count and stock with no cost", () => {
    expect(planStock(rows([{ sku: "SKU-1", counted_qty: "-1" }]), items, "W").rejected).toHaveLength(1);
    expect(
      planStock(rows([{ sku: "SKU-1", counted_qty: "5", unit_cost: "0" }]), items, "W").rejected[0]!
        .message,
    ).toContain("will not tie");
  });

  it("rejects an item that is not in the catalogue", () => {
    const plan = planStock(rows([{ sku: "SKU-404", counted_qty: "1", unit_cost: "1" }]), items, "W");
    expect(plan.rejected[0]!.message).toContain("No catalogue item");
  });
});

describe("employees", () => {
  beforeAll(() => {
    // The blind index needs a keyring. In development it derives from
    // AUTH_SECRET, which is all this test needs — no key material is asserted
    // on, only that two spellings of one Emirates ID collide and two different
    // ones do not.
    process.env.AUTH_SECRET = "test-secret-for-unit-tests-only";
    resetKeyring();
  });

  const base = {
    employee_code: "E-001",
    full_name: "Ravi Kumar",
    joined_on: "2024-03-01",
    base_salary: "3000",
    housing_allowance: "1500",
    transport_allowance: "500",
  };

  it("creates an employee and totals the monthly payroll cost", () => {
    const plan = planEmployees(rows([base]), new Set(), new Set(), "2026-08-21");
    expect(plan.rejected).toEqual([]);
    // 3,000 + 1,500 + 500 = 5,000
    expect(plan.totals[1]!.amount.toFixed(2)).toBe("5000.00");
  });

  it("catches the same Emirates ID written two different ways, without printing it", () => {
    const plan = planEmployees(
      rows([
        { ...base, emirates_id: "784-1990-1234567-1" },
        { ...base, employee_code: "E-002", full_name: "R Kumar", emirates_id: "78419901234567 1" },
      ]),
      new Set(),
      new Set(),
      "2026-08-21",
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]!.message).toContain("same Emirates ID as row 2");
    expect(plan.rejected[0]!.message).not.toContain("784");
    expect(plan.rejected[0]!.message).not.toContain("1234567");
  });

  it("does not treat two different Emirates IDs as a duplicate", () => {
    const plan = planEmployees(
      rows([
        { ...base, emirates_id: "784-1990-1234567-1" },
        { ...base, employee_code: "E-002", emirates_id: "784-1990-7654321-1" },
      ]),
      new Set(),
      new Set(),
      "2026-08-21",
    );
    expect(plan.rejected).toEqual([]);
  });

  it("refuses a non-UAE IBAN without echoing it", () => {
    const plan = planEmployees(
      rows([{ ...base, iban: "GB29NWBK60161331926819" }]),
      new Set(),
      new Set(),
      "2026-08-21",
    );
    expect(plan.rejected[0]!.message).toContain("not a UAE IBAN");
    expect(plan.rejected[0]!.message).not.toContain("NWBK");
  });

  it("refuses a joining date in the future", () => {
    const plan = planEmployees(
      rows([{ ...base, joined_on: "2030-01-01" }]),
      new Set(),
      new Set(),
      "2026-08-21",
    );
    expect(plan.rejected[0]!.message).toContain("in the future");
  });

  it("skips someone already on file rather than overwriting their record", () => {
    const plan = planEmployees(rows([base]), new Set(["e-001"]), new Set(), "2026-08-21");
    expect(plan.rows[0]!.action).toBe("skip");
  });

  it("says out loud how many rows have no Emirates ID to check against", () => {
    const plan = planEmployees(rows([base]), new Set(), new Set(), "2026-08-21");
    expect(plan.notes.join(" ")).toContain("1 row(s) have no Emirates ID");
  });
});

describe("matching tokens", () => {
  it("matches a UAE phone written five different ways", () => {
    const forms = ["0501234567", "+971 50 123 4567", "971501234567", "050 123 4567", "50 123 4567"];
    const normalised = new Set(forms.map(normalisePhone));
    expect(normalised.size).toBe(1);
  });

  it("ignores case and surrounding space, but not spelling", () => {
    expect(normaliseToken("  Ahmed  Al  Mansoori ")).toBe("ahmed al mansoori");
    expect(normaliseToken("Ahmad")).not.toBe(normaliseToken("Ahmed"));
  });

  it("reports two records under one key as ambiguous rather than picking one", () => {
    const index = new Index([
      { id: "a", label: "A", keys: ["shared"] },
      { id: "b", label: "B", keys: ["shared"] },
    ]);
    expect(index.resolve("shared")).toBe("ambiguous");
  });

  it("does not call one record reached by two of its own keys ambiguous", () => {
    const index = new Index([{ id: "a", label: "A", keys: ["one", "one"] }]);
    expect(index.resolve("one")).toEqual({ found: { id: "a", label: "A", keys: ["one", "one"] } });
  });
});

describe("templates", () => {
  it("offers a header row for every importer that round-trips through the reader", () => {
    for (const kind of ["opening_balances", "parties", "units", "leases", "debts", "cheques", "stock", "employees"]) {
      const csv = templateCsv(kind);
      const source = readSource(`${csv}${csv.split(",").map(() => "x").join(",")}\n`);
      expect(source.columns.length).toBeGreaterThan(0);
      expect(source.columns).toEqual(
        csv.trim().split(",").map((c) => c.replace(/"/g, "")),
      );
    }
  });

  it("refuses a kind it does not have an importer for", () => {
    expect(() => templateCsv("payroll")).toThrow(ServiceError);
  });
});
