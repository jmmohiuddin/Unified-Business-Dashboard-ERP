/**
 * PRE-FLIGHT: the gaps that are gaps under any field list.
 *
 * Deliberately narrow. This does NOT validate against PINT AE — that list is
 * open question Q-4 and inventing it here would be the same guess the
 * serialiser stub refuses to make. What it checks is the small set of facts
 * that no invoicing standard has ever made optional: somebody issued this, to
 * somebody, for an amount, in a currency, and a credit note says what it
 * corrects.
 *
 * The value of checking them NOW, two years before the mandate, is that every
 * one of them is a data-collection problem with a long lead time. A missing
 * supplier TIN is a form to fill in; a missing buyer TIN across four hundred
 * customers is a quarter of phone calls. Discovering that in June 2027 is
 * discovering it too late, which is why these gaps drive the readiness screen
 * rather than sitting inside a transmission path that does not run yet.
 */

import type { EInvoiceDocumentSource } from "./serialise.ts";

export type GapCode =
  | "supplier_tin_missing"
  | "supplier_entity_missing"
  | "buyer_tin_missing"
  | "buyer_unidentified"
  | "credit_note_unlinked"
  | "no_lines"
  | "currency_missing";

export interface EInvoiceGap {
  code: GapCode;
  message: string;
  /** True where the document could not be transmitted at all. False where it
   *  would go but with a known defect the FTA or the buyer's ASP may reject —
   *  the difference between "cannot file" and "may be rejected", which the
   *  exception queue (EC-18) will need to rank by. */
  blocking: boolean;
}

/**
 * `inScope` changes what counts as a gap, not whether checking happens.
 *
 * A consumer sale has no buyer TIN and never will; reporting that as a gap on
 * every counter sale in the salon would bury the four commercial leases that
 * genuinely are missing one. Scope is decided in `scope.ts` and passed in
 * rather than re-derived, so the two files cannot disagree about which
 * documents are B2B.
 */
export function preflight(source: EInvoiceDocumentSource, inScope = true): EInvoiceGap[] {
  const gaps: EInvoiceGap[] = [];

  if (!source.supplier.legalEntityId) {
    gaps.push({
      code: "supplier_entity_missing",
      message: "the issuing business is not mapped to a legal entity",
      blocking: true,
    });
  }
  if (!source.supplier.tin) {
    gaps.push({
      code: "supplier_tin_missing",
      message: "the issuing entity has no Tax Identification Number recorded",
      blocking: true,
    });
  }
  if (!source.currency) {
    gaps.push({ code: "currency_missing", message: "no currency on the document", blocking: true });
  }
  if (source.lines.length === 0) {
    gaps.push({ code: "no_lines", message: "the document has no lines", blocking: true });
  }
  if (source.documentType === "credit_note" && !source.correctsDocumentNumber) {
    gaps.push({
      code: "credit_note_unlinked",
      message: "the credit note does not reference the invoice it corrects",
      blocking: true,
    });
  }

  if (inScope) {
    if (!source.buyer.partyId) {
      gaps.push({
        code: "buyer_unidentified",
        message: "the document has no counterparty on file",
        blocking: true,
      });
    } else if (!source.buyer.tin) {
      gaps.push({
        code: "buyer_tin_missing",
        message: `${source.buyer.name} has no tax number on file`,
        blocking: false,
      });
    }
  }

  return gaps;
}

export function blockingGaps(gaps: EInvoiceGap[]): EInvoiceGap[] {
  return gaps.filter((g) => g.blocking);
}
