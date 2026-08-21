/**
 * PINT AE — REGISTERED, NOT IMPLEMENTED.
 *
 * This file exists so the seam is real. It occupies the slot ADR-007 reserves
 * for `pintae/serialise.ts`, it registers itself with the boundary, and it
 * refuses, in data, with a reason.
 *
 * IT DOES NOT PRODUCE XML, AND THAT IS THE DECISION, NOT AN OMISSION.
 * The final PINT AE mandatory field list is open question Q-4 (MOF data
 * dictionary), and the penalty schedule for getting it wrong is Q-3. The
 * project convention for an unresolved legal question is to park it visibly
 * rather than to encode a guess — `uae.test.ts:132-138` parks the resignation
 * gratuity question exactly this way, and the audit's criticism of the
 * gross-misconduct forfeiture is that the sibling question was NOT parked but
 * asserted, with a passing test to make the assertion look settled.
 *
 * A speculative serialiser would be that failure at a larger scale: XML that
 * validates against nothing, produced by code that reports success, for
 * documents filed with the Federal Tax Authority. The internal document model
 * is already rich enough for the mapping — `documents` and `document_lines`
 * carry party, TRN, line tax code and treatment — so this is mapping work
 * waiting on a field list, not modelling work waiting on a design.
 *
 * WHAT WHOEVER IMPLEMENTS THIS NEEDS FIRST:
 *   1. Q-4 resolved — the MOF data dictionary, versioned, cited in this file.
 *   2. Q-6 resolved — which legal entities are in the mandate and from when.
 *   3. An appointed ASP, so the output can be validated against something that
 *      will actually reject it. See `../provider.ts`.
 */

import {
  registerSerialiser,
  type EInvoiceSerialiser,
  type SerialisedDocument,
} from "../serialise.ts";
import { preflight } from "../validate.ts";

const UNAVAILABLE =
  "PINT AE serialisation is not implemented — the mandatory field list (Q-4) is unresolved";

export const pintAeSerialiser: EInvoiceSerialiser = {
  format: "pint_ae",
  produces: false,
  serialise(source): SerialisedDocument {
    /**
     * The preflight runs anyway.
     *
     * The gaps it finds — no supplier TIN, no buyer TIN on a B2B document, a
     * credit note with nothing to correct — are true regardless of what Q-4
     * says, because no invoicing standard has ever made the issuer optional.
     * Running it now means the readiness screen can report real, actionable
     * gaps today instead of waiting for a serialiser that cannot be written
     * yet, and it means this stub is exercised rather than dead.
     */
    const gaps = preflight(source);
    return {
      format: "pint_ae",
      documentId: source.documentId,
      documentType: source.documentType,
      documentNumber: source.documentNumber,
      supplierTin: source.supplier.tin,
      buyerTin: source.buyer.tin,
      payload: null,
      reason: UNAVAILABLE,
      warnings: gaps.map((g) => g.message),
    };
  },
};

registerSerialiser(pintAeSerialiser);
