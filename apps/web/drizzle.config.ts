import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from src/worker/db/schema.ts into /migrations, where
// `wrangler d1 migrations apply` picks them up. Run `npm run db:generate`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/schema.ts",
  out: "../../migrations",
});
