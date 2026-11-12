import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so unit tests run in plain Node without
// starting the Cloudflare plugin's local runtime.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each worker test runs a real local database and many requests: a few take
    // 4-9 seconds on a laptop and more on CI runners, past the 5-second default.
    testTimeout: 30_000,
  },
});
