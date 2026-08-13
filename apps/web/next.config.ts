import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Monorepo env loading.
 *
 * Next only reads `.env` from the app directory, but this is a workspace where
 * the database URL is shared with the db package, the seed script and the
 * worker. Loading the root `.env` here keeps one source of truth in
 * development. In production nothing reads a file — the platform injects real
 * environment variables and these calls are no-ops.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env") });
loadEnv({ path: resolve(here, "../../.env.example") });

const config: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework. It is not a vulnerability by itself, but it
  // tells an attacker which CVE list to work through first.
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next compiles them in-place so
  // there is no build step between editing a metric and seeing it on screen.
  transpilePackages: ["@nexus/db", "@nexus/core"],
  serverExternalPackages: ["postgres"],
  /**
   * There is deliberately no `env:` block.
   *
   * Next's `env` key does not pass variables through — it INLINES them into the
   * bundle as string literals at build time. That had two consequences, one of
   * which reached production:
   *
   *   1. NEXUS_DEMO_MODE was baked in at build time while the boot gate checks
   *      it at runtime, so the two could disagree — and did. The deployed
   *      sign-in page rendered working credentials for every seeded account
   *      while `assertConfiguration`, reading the real runtime environment, saw
   *      the flag unset and reported the configuration healthy. A security gate
   *      that inspects a different value from the code it is guarding cannot
   *      guard it.
   *
   *   2. DATABASE_URL and APP_DATABASE_URL were inlined too. Nothing referenced
   *      them from a client component, so no credential actually shipped — but
   *      the moment one did, the connection string would have gone into the
   *      browser bundle with no warning.
   *
   * Server components and route handlers read `process.env` directly at runtime
   * on the server, so none of this was buying anything.
   */
  logging: { fetches: { fullUrl: false } },
};

export default config;
