/**
 * THE SERIALISER BOUNDARY.
 *
 * FR-C07's second acceptance criterion, and the one that is cheap today and
 * expensive in 2027: *documents pass through a serialiser boundary rather than
 * rendering directly*. The point is not the XML. The point is that by the time
 * a real PINT AE serialiser exists, there is exactly one place that turns an
 * internal document into an outward-facing one, and every caller already goes
 * through it. Retrofitting that seam into a codebase where each surface
 * formats an invoice its own way is the rebuild ADR-007 is trying to avoid.
 *
 * WHAT A SERIALISER IS HERE. A pure function from `EInvoiceDocumentSource` —
 * a flat, already-loaded snapshot of one document — to a `SerialisedDocument`.
 * No transaction, no permission check, no clock. The caller has already done
 * the reading and the authorising; this layer only maps. That keeps it
 * testable against fixtures and keeps a legally consequential mapping out of
 * reach of an accidental extra query.
 *
 * WHAT IS DELIBERATELY MISSING. There is no PINT AE payload. The final
 * mandatory field list is open question Q-4 and the penalty schedule is Q-3.
 * `pintae/serialise.ts` exists, is registered, and returns a document with a
 * NULL payload and a stated reason. That is a placeholder that reports itself
 * as a placeholder — which is the difference between a known gap and a
 * plausible-looking XML file that nobody discovers is wrong until the FTA
 * rejects it.
 */

import type { TaxTreatment } from "./scope.ts";

/** The supplier side: the registered company issuing the document. */
export interface EInvoiceSupplier {
  legalEntityId: string | null;
  legalName: string;
  /** UAE: the 15-digit TRN. NULL where the entity is not registered, or where
   *  nobody has recorded it — the readiness screen distinguishes the two. */
  tin: string | null;
  emirate: string | null;
  countryCode: string;
}

/** The buyer side. `tin` NULL means the buyer gave no tax number, which for a
 *  business customer is itself a compliance gap and for a consumer is normal. */
export interface EInvoiceBuyer {
  partyId: string | null;
  name: string;
  isOrganisation: boolean;
  tin: string | null;
  countryCode: string | null;
}

export interface EInvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxTreatment: TaxTreatment;
  taxRate: string;
  taxAmount: string;
}

/**
 * One document, flattened.
 *
 * Money arrives as strings and stays as strings. `packages/core/src/money` is
 * exact decimal and `check-money.mjs` fails the build on `Number(` inside
 * `services/` and `uae/`; a serialiser that parsed a total to float to
 * re-format it would reintroduce the exact defect that guard exists to stop,
 * one layer further out. Nothing here does arithmetic — it is a mapping, and a
 * mapping has no reason to touch the values it carries.
 */
export interface EInvoiceDocumentSource {
  documentId: string;
  documentType: "invoice" | "credit_note";
  documentNumber: string;
  issueDate: string;
  currency: string;
  supplier: EInvoiceSupplier;
  buyer: EInvoiceBuyer;
  lines: EInvoiceLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  /** The invoice this credit note reverses. Mandatory on a credit note under
   *  every invoicing standard that has ever existed, ours included. */
  correctsDocumentNumber?: string | null;
}

export type EInvoiceFormat = "pint_ae" | "local_tax_invoice";

export interface SerialisedDocument {
  format: EInvoiceFormat;
  documentId: string;
  documentType: EInvoiceDocumentSource["documentType"];
  documentNumber: string;
  supplierTin: string | null;
  buyerTin: string | null;
  /**
   * The serialised bytes, or NULL when this serialiser cannot produce them.
   *
   * NULL is a legitimate outcome, not an error state to be swallowed. It says
   * "the boundary was crossed and nothing came out", and `reason` says why.
   * A serialiser that threw instead would force every caller to decide between
   * failing the invoice and ignoring the exception, and in practice callers
   * pick the second.
   */
  payload: string | null;
  reason?: string;
  /** Non-blocking observations. A warning never stops a document. */
  warnings: string[];
}

/** A format implementation. Pure: source in, document out. */
export interface EInvoiceSerialiser {
  format: EInvoiceFormat;
  /** False while the implementation is a placeholder. Callers that intend to
   *  transmit must check this rather than inspecting `payload` for null. */
  produces: boolean;
  serialise(source: EInvoiceDocumentSource): SerialisedDocument;
}

/**
 * The local tax invoice.
 *
 * Every document gets one of these, mandate or not. ADR-007's scope discipline
 * is explicit: business-to-consumer documents — salon walk-ins, counter sales,
 * direct e-commerce orders — "continue to produce a compliant local tax
 * invoice and are not transmitted". Routing them through the boundary anyway
 * is what makes the boundary universal; a seam that half the documents skip is
 * not a seam.
 *
 * It emits a stable JSON projection rather than a rendered PDF. The rendering
 * surfaces are Phase 2 and are not this module's business; what matters now is
 * that a single, versioned shape exists for them to render FROM.
 */
export const localTaxInvoiceSerialiser: EInvoiceSerialiser = {
  format: "local_tax_invoice",
  produces: true,
  serialise(source) {
    const warnings: string[] = [];
    if (!source.supplier.tin) {
      warnings.push("supplier has no Tax Identification Number recorded");
    }
    if (source.documentType === "credit_note" && !source.correctsDocumentNumber) {
      warnings.push("credit note does not reference the invoice it corrects");
    }
    return {
      format: "local_tax_invoice",
      documentId: source.documentId,
      documentType: source.documentType,
      documentNumber: source.documentNumber,
      supplierTin: source.supplier.tin,
      buyerTin: source.buyer.tin,
      payload: JSON.stringify({ version: 1, ...source }),
      warnings,
    };
  },
};

/**
 * Registered serialisers, by format.
 *
 * PARTIAL ON PURPOSE. `pint_ae` is absent until `pintae/serialise.ts` registers
 * itself. Pre-seeding it with the local serialiser as a stand-in would mean a
 * caller asking for PINT AE silently received a local JSON invoice and a
 * `produces: true` flag — the one shape of bug this module is built to prevent,
 * committed in the module that prevents it.
 */
const SERIALISERS: Partial<Record<EInvoiceFormat, EInvoiceSerialiser>> = {
  local_tax_invoice: localTaxInvoiceSerialiser,
};

/** Called once from each format implementation, so this file has no import
 *  edge into them and the graph stays acyclic. */
export function registerSerialiser(serialiser: EInvoiceSerialiser): void {
  SERIALISERS[serialiser.format] = serialiser;
}

export function serialiserFor(format: EInvoiceFormat): EInvoiceSerialiser | undefined {
  return SERIALISERS[format];
}

/**
 * Cross the boundary.
 *
 * The one function every outward-facing document goes through. Selecting the
 * format is the caller's decision — it follows from the scope rule in
 * `scope.ts`, which is where the B2B/B2C judgement is made and documented,
 * rather than being re-derived here from whatever fields happen to be handy.
 *
 * An unregistered format returns a refusal document rather than throwing. The
 * caller is a posting path or a batch job; an exception there aborts work that
 * has nothing to do with e-invoicing, whereas a NULL payload with a reason is
 * a row an exception queue can show.
 */
export function serialiseDocument(
  source: EInvoiceDocumentSource,
  format: EInvoiceFormat,
): SerialisedDocument {
  const serialiser = SERIALISERS[format];
  if (!serialiser) {
    return {
      format,
      documentId: source.documentId,
      documentType: source.documentType,
      documentNumber: source.documentNumber,
      supplierTin: source.supplier.tin,
      buyerTin: source.buyer.tin,
      payload: null,
      reason: `no serialiser is registered for format "${format}"`,
      warnings: [],
    };
  }
  return serialiser.serialise(source);
}
