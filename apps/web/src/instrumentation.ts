/**
 * BOOT-TIME CONFIGURATION GATE.
 *
 * `assertConfiguration` has existed since the security batch and its docblock
 * claims "the app refuses to start". It did not: nothing ever called it. The
 * validator was exported from the core barrel and then never wired to anything,
 * so for the whole life of the project the fail-closed guarantee was a comment.
 * This file is what makes the claim true.
 *
 * Next calls `register()` exactly once per server instance, before the first
 * request is served — which is the only place a boot gate can live in an App
 * Router app.
 *
 * Node runtime only. The check reads `process.env` and throws; the edge runtime
 * neither has the full environment nor should take a hard dependency on the
 * domain package.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertConfiguration } = await import("@nexus/core");

  // Throws in production, prints loudly in development — a fresh clone must
  // still run. See packages/core/src/security/config.ts for the severity rules.
  assertConfiguration(process.env);
}
