import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so unit tests run in plain Node without
// starting the Cloudflare plugin's local runtime.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
