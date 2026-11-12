import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Browser tests (e2e/) run the app against their own database, kept apart
 * from the one used in development, with a fixed test secret.
 */
const e2eState = process.env.E2E_STATE;

export default defineConfig({
  plugins: [
    react(),
    cloudflare(
      e2eState
        ? {
            persistState: { path: e2eState },
            config: {
              vars: {
                BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123",
                APP_URL: "",
              },
            },
          }
        : {},
    ),
  ],
});
