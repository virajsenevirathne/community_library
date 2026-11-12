import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";

const migrationsDir = resolve(import.meta.dirname, "../../../../../migrations");
const configPath = resolve(import.meta.dirname, "../../../wrangler.jsonc");

/** Background work (emails, webhooks) started by test apps, per test database. */
const background = new WeakMap<Env, Promise<unknown>[][]>();

/** Lets a test app's background work finish before its database is closed. */
export function trackBackground(env: Env, pending: Promise<unknown>[]) {
  const lists = background.get(env) ?? [];
  lists.push(pending);
  background.set(env, lists);
}

async function finishBackground(env: Env) {
  for (const pending of background.get(env) ?? []) {
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
  }
}

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
  // Closing the database while emails or webhooks are still being recorded
  // makes them fail with "poisoned stub" errors, so let them finish first.
  const dispose = async () => {
    await finishBackground(env);
    await proxy.dispose();
  };
  return { env, dispose };
}
