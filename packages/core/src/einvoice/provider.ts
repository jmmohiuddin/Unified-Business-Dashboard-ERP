/**
 * E-INVOICE TRANSMISSION PROVIDER.
 *
 * Deliberately shaped as a near-copy of `DeliveryProvider` in
 * `packages/core/src/services/outbox.ts`, because FR-C07 asks for exactly that
 * and because the pattern earned it: an interface, a no-op default that logs,
 * and a real implementation swapped in behind it. The property that matters is
 * the same in both places — **a misconfigured environment must not be able to
 * transmit**. There, the failure mode is messaging a customer who opted out.
 * Here it is filing a document with the Federal Tax Authority that the owner
 * has not agreed to file, through a network Nexus is not accredited to reach.
 *
 * WHAT NEXUS IS AND IS NOT. The UAE model is a decentralised five-corner
 * Peppol network: supplier → supplier's ASP → network → buyer's ASP → buyer,
 * with both ASPs reporting to the FTA. Nexus is corner one. It never connects
 * to the network; the accredited service provider relationship IS the
 * compliance mechanism (ADR-007). So this interface describes a conversation
 * with ONE vendor's API, not a protocol implementation, and that is why it
 * carries a `name` and an appointment rather than any Peppol vocabulary.
 *
 * WHY IT EXISTS NOW, WITH NOTHING BEHIND IT. Appointing the ASP is a
 * commercial act with a statutory deadline (31 Mar 2027, see `deadline.ts`).
 * The engineering that cannot start until the vendor is chosen is the adapter;
 * everything upstream of it — the entity TIN, the scope decision, the
 * serialiser boundary, the transmission state — can be built now and is
 * expensive to retrofit into a codebase that renders invoices directly.
 */

import type { SerialisedDocument } from "./serialise.ts";

/**
 * Message Level Status: what the network said about a document we sent.
 *
 * Peppol MLS is a response ABOUT a business document, not a business response
 * to it — "the buyer's access point accepted this XML", not "the buyer agrees
 * to pay". Conflating the two would let a rejected transmission look settled.
 *
 * `not_transmitted` is a first-class state, not an absence. A B2C invoice is
 * outside the mandate and is never sent; recording that as "no status" would
 * make it indistinguishable from one that failed to send.
 */
export type MessageLevelStatus =
  | "not_transmitted"
  | "queued"
  | "sent"
  | "acknowledged"
  | "rejected"
  | "failed";

export interface TransmissionResult {
  status: MessageLevelStatus;
  /** The ASP's own id for the transmission, for support conversations. */
  providerReference?: string;
  /** Populated on `rejected` — the reason the exception queue shows (EC-18). */
  reason?: string;
  /** Whether another attempt could plausibly succeed. A schema rejection is
   *  not retryable; a provider timeout is. Retrying the first is how a bounded
   *  retry budget gets burned on a document that will never be accepted. */
  retryable?: boolean;
}

/** A provider implementation. The chosen ASP's API goes behind this. */
export interface EInvoiceProvider {
  name: string;
  /**
   * False for anything that does not actually reach an ASP.
   *
   * Read this before counting a document as filed. The no-op returns a
   * plausible-looking `TransmissionResult`, so a caller that only inspects the
   * result cannot tell a logged document from a transmitted one — which is
   * precisely how a placeholder ends up believing it is compliant.
   */
  transmits: boolean;
  transmit(document: SerialisedDocument): Promise<TransmissionResult>;
  /** Poll for a status update on a document already handed over. */
  status?(providerReference: string): Promise<TransmissionResult>;
}

/**
 * The default provider: records, never transmits.
 *
 * Returns `not_transmitted` rather than `sent`. An optimistic no-op would let
 * the rest of the pipeline — and eventually a screen the owner reads — mark
 * documents as filed with the FTA when nothing left the building. "Nothing was
 * sent" must be visible in the data, not only in the logs.
 */
export const noopEInvoiceProvider: EInvoiceProvider = {
  name: "noop",
  transmits: false,
  async transmit(document) {
    console.log(
      `[einvoice:noop] would transmit ${document.documentType} ${document.documentNumber} ` +
        `for TIN ${document.supplierTin ?? "(none)"} — no provider is appointed`,
    );
    return {
      status: "not_transmitted",
      reason: "no accredited service provider is appointed",
      retryable: false,
    };
  },
};

/**
 * Choose the provider for an entity.
 *
 * Fail-safe by construction: an unknown key, an empty key, or no key at all
 * resolves to the no-op. There is no path through this function that transmits
 * because of a typo. When the ASP adapter is written it registers itself here
 * and `legal_entities.einvoice_provider_key` selects it — which is the whole
 * point of storing the appointment as a fact about the entity rather than as
 * an environment variable that a deploy can lose.
 */
export function resolveEInvoiceProvider(
  key: string | null | undefined,
  registry: Record<string, EInvoiceProvider> = EINVOICE_PROVIDERS,
): EInvoiceProvider {
  if (!key) return noopEInvoiceProvider;
  return registry[key] ?? noopEInvoiceProvider;
}

/** Every provider the build knows about. One entry until an ASP is appointed. */
export const EINVOICE_PROVIDERS: Record<string, EInvoiceProvider> = {
  noop: noopEInvoiceProvider,
};
