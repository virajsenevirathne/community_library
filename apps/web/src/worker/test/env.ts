import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";

const migrationsDir = resolve(import.meta.dirname, "../../../../../migrations");
const configPath = resolve(import.meta.dirname, "../../../wrangler.jsonc");

/**
 * A real local D1 database (the same engine as production) with every
 * migration applied. Nothing is written to disk, so each call starts empty.
 */
export async function createTestEnv(vars: Partial<Env> = {}) {
  const proxy = await getPlatformProxy<Env>({ configPath, persist: false });
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const statements = readFileSync(resolve(migrationsDir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await proxy.env.DB.batch(statements.map((s) => proxy.env.DB.prepare(s)));
  }
  const env = {
    ...proxy.env,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    ...vars,
  } as Env;
  return { env, dispose: () => proxy.dispose() };
}
