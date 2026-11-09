import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

function fakeEnv(dbWorks: boolean): Env {
  const db = {
    prepare: () => ({
      first: async () => {
        if (!dbWorks) throw new Error("D1 unavailable");
        return { 1: 1 };
      },
    }),
  };
  return { DB: db, LIBRARY_NAME: "Test Library" } as unknown as Env;
}

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const res = await createApp().request("/api/health", {}, fakeEnv(true));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, library: "Test Library", database: "ok" });
  });

  it("returns 503 when the database fails", async () => {
    const res = await createApp().request("/api/health", {}, fakeEnv(false));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, database: "error" });
  });
});

describe("unknown API routes", () => {
  it("return a JSON 404", async () => {
    const res = await createApp().request("/api/nope", {}, fakeEnv(true));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
