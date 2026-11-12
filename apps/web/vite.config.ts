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
                  // Test-only web push keys: phone notifications show up in the pages.
                  VAPID_PUBLIC_KEY:
                    "BKWr0g9d1Sn0wqfkN18xhe_c1xLkkizw7aoWg2JdLf15ibpxTNXI2i-Gr71pMwcjDTnXiLkBYQsDIkmljB8JIAM",
                  VAPID_PRIVATE_KEY: "0Az4CpFPxczs_DSGZXeAgUW4g149a9KSXe5sYk0r-5Q",
                  APP_URL: "",
                },
              },
            }
          : {},
      ),
    ],
  };
});
