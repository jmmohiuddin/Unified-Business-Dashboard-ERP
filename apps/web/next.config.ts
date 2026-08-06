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
  env: {
    DATABASE_URL: process.env.DATABASE_URL!,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL!,
    NEXUS_DEMO_TODAY: process.env.NEXUS_DEMO_TODAY ?? "",
    NEXUS_DEMO_MODE: process.env.NEXUS_DEMO_MODE ?? "",
  },
  logging: { fetches: { fullUrl: false } },
};

export default config;
