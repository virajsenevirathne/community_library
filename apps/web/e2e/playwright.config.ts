import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SERVER_LOG, STATE } from "./paths.ts";

/*
 * Browser tests: the real app (Worker and pages) in Chrome, against its own
 * local database (see prepare.mjs). Sign-in codes are read from the server's
 * output, since without email keys the app prints emails instead of sending.
 *
 *   npm run e2e -w @community-library/web
 */
const PORT = 5174;
const state = STATE;

export default defineConfig({
  testDir: ".",
  // One database for every test, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "sign-in", testMatch: /auth\.setup\.ts/ },
    {
      name: "chrome",
      dependencies: ["sign-in"],
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${resolve(state, "book-qr.y4m")}`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `node e2e/prepare.mjs && vite --port ${PORT} --strictPort > ${SERVER_LOG} 2>&1`,
    cwd: resolve(import.meta.dirname, ".."),
    url: `http://localhost:${PORT}/api/health`,
    env: { E2E_STATE: state, E2E_ORIGIN: `http://localhost:${PORT}` },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
