/**
 * Security primitives.
 *
 * Everything that protects data at rest, validates configuration, or records a
 * security-relevant event lives behind this boundary — so a review has one
 * surface to read rather than a hunt through the codebase.
 */
export * from "./pii.ts";
export * from "./config.ts";
export * from "./events.ts";
export * from "./erasure.ts";
export * from "./reporting.ts";
