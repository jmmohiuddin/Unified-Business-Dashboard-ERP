import { describe, expect, it } from "vitest";
import {
  EINVOICE_ASP_APPOINTMENT_DEADLINE,
  EINVOICE_GO_LIVE_DEADLINE,
  eInvoiceCountdown,
} from "./deadline.ts";
import { documentInScope } from "./scope.ts";
import { noopEInvoiceProvider, resolveEInvoiceProvider } from "./provider.ts";
import {
  localTaxInvoiceSerialiser,
  serialiseDocument,
  type EInvoiceDocumentSource,
} from "./serialise.ts";
import { preflight, blockingGaps } from "./validate.ts";
import { pintAeSerialiser } from "./pintae/serialise.ts";
import { quarterOf } from "./readiness.ts";

/**
 * E-INVOICING PLACEHOLDER — FR-C07.
 *
 * These tests assert the properties of a *placeholder*, which is an unusual
 * thing to test and the reason for this note. The value of the placeholder is
 * entirely in its refusals: it must not transmit, it must not claim to have
 * produced a document it did not produce, and it must not decide that a
 * consumer's invoice belongs on a government network. Each of those is
 * asserted below. None of them will change when the real serialiser arrives —
 * they are the contract the real one inherits.
 *
 * Nothing here asserts a PINT AE field, a penalty, or a rate. Q-3 (penalty
 * schedule) and Q-4 (mandatory field list) are open, and the project's
 * convention for an open legal question is `it.todo` naming the question
 * rather than a fixture that makes a guess look settled.
 */

const source: EInvoiceDocumentSource = {
  documentId: "doc-1",
  documentType: "invoice",
  documentNumber: "INV-PROP-2026-0042",
  issueDate: "2026-08-06",
  currency: "AED",
  supplier: {
    legalEntityId: "le-1",
    legalName: "Sumon Properties",
    tin: "100191672061767",
    emirate: "Dubai",
    countryCode: "AE",
  },
  buyer: {
    partyId: "party-1",
    name: "Khan Trading LLC",
    isOrganisation: true,
    tin: "100123456789012",
    countryCode: "AE",
  },
  lines: [
    {
      description: "Office 1204 — quarterly rent",
      quantity: "1",
      unitPrice: "45000.0000",
      lineTotal: "45000.0000",
      taxTreatment: "standard",
      taxRate: "5",
      taxAmount: "2250.0000",
    },
  ],
  subtotal: "45000.0000",
  taxTotal: "2250.0000",
  total: "47250.0000",
};

describe("the statutory countdown", () => {
  it("counts to the appointment deadline, not to go-live", () => {
    // 2026-08-13 → 2027-03-31 is 230 days; the wireframe's worked example is
    // 231 days, which is the day before. Both are inside the planning window.
    const c = eInvoiceCountdown("2026-08-13");
    expect(c.appointBy).toBe(EINVOICE_ASP_APPOINTMENT_DEADLINE);
    expect(c.liveBy).toBe(EINVOICE_GO_LIVE_DEADLINE);
    expect(c.daysToAppoint).toBe(230);
    expect(c.daysToGoLive).toBe(322);
    expect(c.urgency).toBe("planning");
  });

  it("escalates inside the last four months and again once the date passes", () => {
    expect(eInvoiceCountdown("2027-01-01").urgency).toBe("urgent");
    expect(eInvoiceCountdown("2027-04-01").urgency).toBe("overdue");
    expect(eInvoiceCountdown("2027-04-01").daysToAppoint).toBe(-1);
  });

  it("stops counting once a provider is appointed", () => {
    // The fact recorded on the entity wins over the calendar. An appointment
    // made early must take the group out of the countdown immediately —
    // otherwise the screen keeps nagging about work already done.
    expect(eInvoiceCountdown("2026-08-13", true).urgency).toBe("live");
  });

  it("clamps the progress bar at both ends", () => {
    expect(eInvoiceCountdown("2020-01-01").elapsedFraction).toBe(0);
    expect(eInvoiceCountdown("2030-01-01").elapsedFraction).toBe(1);
  });
});

describe("scope — who transmits and who does not", () => {
  it("holds a consumer sale out of the mandate", () => {
    const d = documentInScope({
      documentType: "invoice",
      buyerIsOrganisation: false,
      buyerTin: null,
      isIntraGroup: false,
    });
    expect(d.inScope).toBe(false);
    expect(d.reason).toContain("local tax invoice");
  });

  it("keeps a business customer in scope even with no tax number on file", () => {
    // The conservative direction on purpose: a missing TRN is a gap to chase,
    // not a reason to quietly drop the document out of the mandate.
    const d = documentInScope({
      documentType: "invoice",
      buyerIsOrganisation: true,
      buyerTin: null,
      isIntraGroup: false,
    });
    expect(d.inScope).toBe(true);
    expect(d.reason).toContain("no tax number");
  });

  it("never transmits a quotation", () => {
    expect(
      documentInScope({
        documentType: "quotation",
        buyerIsOrganisation: true,
        buyerTin: "100123456789012",
        isIntraGroup: false,
      }).inScope,
    ).toBe(false);
  });

  it("keeps an intra-group recharge in scope and says the relief is unconfirmed", () => {
    const d = documentInScope({
      documentType: "invoice",
      buyerIsOrganisation: true,
      buyerTin: null,
      isIntraGroup: true,
    });
    expect(d.inScope).toBe(true);
    expect(d.reason).toContain("subject to confirmation");
  });
});

describe("the serialiser boundary", () => {
  it("produces a local tax invoice for every document", () => {
    const out = localTaxInvoiceSerialiser.serialise(source);
    expect(out.payload).not.toBeNull();
    expect(out.supplierTin).toBe("100191672061767");
    expect(out.warnings).toEqual([]);
  });

  it("warns when the supplier has no TIN, rather than failing the document", () => {
    const out = localTaxInvoiceSerialiser.serialise({
      ...source,
      supplier: { ...source.supplier, tin: null },
    });
    expect(out.payload).not.toBeNull();
    expect(out.warnings.join(" ")).toContain("no Tax Identification Number");
  });

  it("refuses PINT AE in data, with a reason, and never with a payload", () => {
    // The property that matters: a caller cannot mistake the stub for the real
    // thing. `produces` is false and `payload` is null — not an empty string,
    // not a plausible-looking envelope.
    const out = serialiseDocument(source, "pint_ae");
    expect(pintAeSerialiser.produces).toBe(false);
    expect(out.format).toBe("pint_ae");
    expect(out.payload).toBeNull();
    expect(out.reason).toContain("Q-4");
  });

  it("does not silently substitute the local serialiser for PINT AE", () => {
    // The registry is partial on purpose. If this ever passes by returning a
    // JSON payload under format "pint_ae", the placeholder has become a lie.
    const out = serialiseDocument(source, "pint_ae");
    expect(out.payload).toBeNull();
  });
});

describe("pre-flight gaps", () => {
  it("finds nothing wrong with a complete B2B invoice", () => {
    expect(preflight(source)).toEqual([]);
  });

  it("blocks a document whose business is not mapped to a legal entity", () => {
    const gaps = preflight({
      ...source,
      supplier: { ...source.supplier, legalEntityId: null, tin: null },
    });
    expect(gaps.map((g) => g.code)).toEqual([
      "supplier_entity_missing",
      "supplier_tin_missing",
    ]);
    expect(blockingGaps(gaps)).toHaveLength(2);
  });

  it("treats a missing buyer TIN as chaseable, not as a blocker", () => {
    const gaps = preflight({ ...source, buyer: { ...source.buyer, tin: null } });
    expect(gaps.map((g) => g.code)).toEqual(["buyer_tin_missing"]);
    expect(blockingGaps(gaps)).toHaveLength(0);
  });

  it("does not demand a buyer TIN on an out-of-scope consumer sale", () => {
    const gaps = preflight(
      { ...source, buyer: { ...source.buyer, isOrganisation: false, tin: null } },
      false,
    );
    expect(gaps).toEqual([]);
  });

  it("blocks a credit note that says nothing about what it corrects", () => {
    const gaps = preflight({ ...source, documentType: "credit_note" });
    expect(gaps.map((g) => g.code)).toContain("credit_note_unlinked");
  });
});

describe("the provider", () => {
  it("defaults to the no-op and reports that nothing was transmitted", async () => {
    const result = await noopEInvoiceProvider.transmit(
      localTaxInvoiceSerialiser.serialise(source),
    );
    // NOT "sent". An optimistic no-op is how a placeholder ends up believing
    // it is compliant.
    expect(result.status).toBe("not_transmitted");
    expect(noopEInvoiceProvider.transmits).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("resolves an unknown or absent provider key to the no-op", () => {
    // There is no path through resolution that transmits because of a typo.
    expect(resolveEInvoiceProvider(null).name).toBe("noop");
    expect(resolveEInvoiceProvider("").name).toBe("noop");
    expect(resolveEInvoiceProvider("some-asp-we-never-appointed").name).toBe("noop");
    expect(resolveEInvoiceProvider("some-asp-we-never-appointed").transmits).toBe(false);
  });
});

describe("readiness period", () => {
  it("derives the calendar quarter from today, including the year roll", () => {
    expect(quarterOf("2026-08-06")).toEqual({
      start: "2026-07-01",
      endExclusive: "2026-10-01",
      label: "Q3 2026",
    });
    expect(quarterOf("2026-11-30")).toEqual({
      start: "2026-10-01",
      endExclusive: "2027-01-01",
      label: "Q4 2026",
    });
    expect(quarterOf("2026-01-01").start).toBe("2026-01-01");
  });
});

/**
 * The two open questions, parked the way `uae.test.ts` parks Q-2.
 *
 * Writing either of these as a passing fixture would encode a guess about UAE
 * tax law into a green test suite, which is precisely the failure the audit
 * identified in the gratuity forfeiture case: a sibling question asserted as
 * fact while its twin was carefully parked.
 */
describe("open questions", () => {
  it.todo(
    "Q-4: serialises a tax invoice to PINT AE — blocked on the MOF data dictionary's final mandatory field list",
  );
  it.todo(
    "Q-3: surfaces the penalty exposure for a late or rejected document — blocked on the penalty schedule",
  );
  it.todo(
    "Q-6: assesses which legal entities are inside the mandate — blocked on entity revenue against the AED 50m and AED 3m thresholds",
  );
});
