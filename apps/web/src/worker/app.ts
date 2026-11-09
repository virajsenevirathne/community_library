import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  // Health check: confirms the Worker runs and D1 answers a query.
  app.get("/health", async (c) => {
    let database: "ok" | "error" = "ok";
    try {
      await c.env.DB.prepare("select 1").first();
    } catch {
      database = "error";
    }
    const ok = database === "ok";
    return c.json({ ok, library: c.env.LIBRARY_NAME, database }, ok ? 200 : 503);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
