/**
 * The write layer.
 *
 * Every mutation in the product lives here, not in a React component and not in
 * a route handler. Two reasons that matter:
 *
 *  1. The mobile app and any future public API must be able to record a payment
 *     with identical validation, posting and audit behaviour. If the logic sat
 *     in a Server Action, that would be a reimplementation — and two
 *     implementations of "record a payment" is two sets of rounding bugs.
 *  2. It gives the security review one place to look for every permission
 *     check and every ledger posting.
 */
export * from "./context.ts";
export * from "./payments.ts";
export * from "./sales.ts";
export * from "./purchasing.ts";
export * from "./inventory.ts";
export * from "./credit-notes.ts";
export * from "./operations.ts";
export * from "./notifications.ts";
export * from "./outbox.ts";
export * from "./users.ts";

// Wave 2 — the capabilities the PRD called Must-have and the product did not
// have. Each is a write path that previously did not exist at all, so the
// pattern above holds: the service is the implementation, and the Server Action
// is a thin caller of it.
export * from "./periods.ts";
export * from "./manual-entry.ts";
export * from "./interco.ts";
export * from "./rentals.ts";
export * from "./cash-sessions.ts";
export * from "./import/index.ts";
