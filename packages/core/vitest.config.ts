import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only: no database, no HTTP server. The existing 227 checks
    // cover integration; this layer exists precisely so the pure functions that
    // produce legally consequential numbers can be tested in isolation.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
