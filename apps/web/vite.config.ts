import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Browser tests (e2e/) run the app against their own database, kept apart
 * from the one used in development, with a fixed test secret.
 */
export default defineConfig(({ command }) => {
  // Only for the dev server: a build never carries the test secret.
  const e2eState = command === "serve" ? process.env.E2E_STATE : undefined;
  return {
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
  };
});
