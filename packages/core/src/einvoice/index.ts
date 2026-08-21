/**
 * UAE e-invoicing — the Phase 1 architectural placeholder (FR-C07, ADR-007).
 *
 * Three things exist here and one deliberately does not:
 *
 *   · `deadline.ts`  the two statutory dates and the countdown to them
 *   · `scope.ts`     the B2B/B2C decision that says whether a document sends
 *   · `serialise.ts` the boundary every outward-facing document crosses
 *   · `provider.ts`  the transmission interface, with a no-op default
 *   · `validate.ts`  the pre-flight gaps that hold under any field list
 *   · `readiness.ts` what /compliance/e-invoicing reads
 *
 * NOT here: a PINT AE payload. `pintae/serialise.ts` registers itself with the
 * boundary and refuses with a reason, because the mandatory field list (Q-4)
 * and the penalty schedule (Q-3) are open. See that file for what unblocks it.
 *
 * Importing this barrel is what registers the PINT AE stub with the serialiser
 * boundary — the side effect is intentional and lives here, so a consumer that
 * only wants the countdown does not have to know about registration order.
 */

import "./pintae/serialise.ts";

export * from "./deadline.ts";
export * from "./provider.ts";
export * from "./readiness.ts";
export * from "./scope.ts";
export * from "./serialise.ts";
export * from "./validate.ts";
export { pintAeSerialiser } from "./pintae/serialise.ts";
