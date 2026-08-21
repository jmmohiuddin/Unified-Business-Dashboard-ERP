/**
 * IS THIS DOCUMENT IN SCOPE FOR TRANSMISSION?
 *
 * ADR-007's scope discipline, in one function. In scope: commercial leases,
 * corporate parking contracts, wholesale phone sales, B2B services, and
 * intra-group recharges. Out of scope: business-to-consumer — salon walk-ins,
 * retail counter sales, direct e-commerce orders — which "continue to produce
 * a compliant local tax invoice and are not transmitted".
 *
 * WHY THIS IS ITS OWN FILE. The decision is one boolean with real consequences
 * in both directions: transmitting a consumer's invoice sends a private
 * person's details onto a network for no compliance benefit, and failing to
 * transmit a business invoice is the thing the mandate penalises. A judgement
 * that consequential should be stated once, in a file that explains itself,
 * rather than inlined as `party.type === 'company'` at each call site where the
 * next reader cannot tell whether it was reasoned or convenient.
 *
 * WHAT THIS DOES NOT DECIDE. Whether the group's entities are above the
 * revenue thresholds that phase them in is Q-6 and needs the owner and the
 * accountant. This function answers "would this document be transmitted if the
 * issuing entity is in the mandate", which is a document-level question the
 * data can answer today. The entity-level question is separate and is
 * represented by `legal_entities.einvoice_live_from` being NULL.
 */

export type TaxTreatment =
  | "standard"
  | "zero_rated"
  | "exempt"
  | "reverse_charge"
  | "out_of_scope";

export interface ScopeInput {
  documentType: "invoice" | "credit_note" | string;
  /** The counterparty is a registered organisation, not a private individual. */
  buyerIsOrganisation: boolean;
  /** The counterparty's own tax number, where they have given one. */
  buyerTin: string | null;
  /** Another business unit in the same group — an intra-group recharge. */
  isIntraGroup: boolean;
}

export type ScopeDecision =
  | { inScope: true; reason: string }
  | { inScope: false; reason: string };

/**
 * The B2B/B2C line.
 *
 * Drawn at *the buyer is an organisation*, not at *the buyer supplied a TRN*.
 * That matters and it is the conservative direction. A business customer who
 * has not yet given its TRN is still a business customer; treating it as a
 * consumer because a field is empty would quietly drop it out of the mandate
 * and produce no evidence that anything was missed. Treating it as in scope
 * instead makes it a visible gap — a missing buyer TIN on a document that must
 * be transmitted — which is what the readiness screen counts and what an
 * accountant can act on.
 *
 * Intra-group recharges are held in scope, subject to the intra-group relief
 * noted in the June 2026 version 1.1 update (ADR-007, "subject to
 * confirmation"). Unconfirmed relief is not a reason to exclude a document;
 * it is a reason to say so, which the reason string does.
 */
export function documentInScope(input: ScopeInput): ScopeDecision {
  if (input.documentType !== "invoice" && input.documentType !== "credit_note") {
    return {
      inScope: false,
      reason: `${input.documentType} is not a tax document — only invoices and credit notes transmit`,
    };
  }
  if (input.isIntraGroup) {
    return {
      inScope: true,
      reason: "intra-group recharge — in scope, subject to confirmation of intra-group relief",
    };
  }
  if (!input.buyerIsOrganisation) {
    return {
      inScope: false,
      reason: "business-to-consumer — a local tax invoice is issued and nothing is transmitted",
    };
  }
  return input.buyerTin
    ? { inScope: true, reason: "business-to-business" }
    : {
        inScope: true,
        reason: "business-to-business — buyer has no tax number on file, which must be obtained",
      };
}
