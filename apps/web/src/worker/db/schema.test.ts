import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "../test/env.ts";

// Each test gets its own empty database, so tests do not depend on each other.
let env: Env;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
});
afterEach(() => dispose());

const run = (query: string, ...params: unknown[]) =>
  env.DB.prepare(query)
    .bind(...params)
    .run();

/** Two libraries, each with a title, a copy and a family, plus one user. */
async function seed() {
  await env.DB.batch(
    [
      "insert into libraries (id, name, slug) values ('libA', 'A', 'a'), ('libB', 'B', 'b')",
      "insert into titles (id, library_id, title) values ('tA', 'libA', 'Book A'), ('tB', 'libB', 'Book B')",
      "insert into copies (id, library_id, title_id, short_code) values ('cA', 'libA', 'tA', 'K7R2'), ('cB', 'libB', 'tB', 'M3P4')",
      "insert into families (id, library_id, name) values ('fA', 'libA', 'Family A'), ('fB', 'libB', 'Family B')",
      "insert into users (id, name, email, updated_at) values ('u1', 'Pat', 'pat@example.com', 0)",
    ].map((q) => env.DB.prepare(q)),
  );
}

const insertLoan = (
  id: string,
  opts: { lib?: string; copy?: string; family?: string | null; returned?: boolean } = {},
) =>
  run(
    "insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on, returned_at, outcome) values (?, ?, ?, ?, 'u1', 0, '2026-01-01', ?, ?)",
    id,
    opts.lib ?? "libA",
    opts.copy ?? "cA",
    opts.family === undefined ? "fA" : opts.family,
    opts.returned ? 1 : null,
    opts.returned ? "returned" : null,
  );

describe("migrations", () => {
  it("create every table", async () => {
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite%' order by name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "accounts",
      "copies",
      "email_quota",
      "events",
      "families",
      "holds",
      "invitations",
      "job_runs",
      "kiosk_devices",
      "kiosk_people",
      "libraries",
      "loans",
      "memberships",
      "notifications",
      "passkeys",
      "platform_admins",
      "rate_limits",
      "sessions",
      "titles",
      "users",
      "verifications",
    ]);
  });
});

describe("loans", () => {
  it("allow only one open loan per copy, but keep history", async () => {
    await seed();
    await insertLoan("closed-1", { returned: true });
    await insertLoan("closed-2", { returned: true });
    await insertLoan("open-1");
    await expect(insertLoan("open-2")).rejects.toThrow(/UNIQUE/);
  });

  it("cannot point at a copy or family in another library", async () => {
    await seed();
    await expect(insertLoan("x1", { copy: "cB" })).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertLoan("x2", { family: "fB" })).rejects.toThrow(/FOREIGN KEY/);
  });

  it("must have an outcome exactly when returned, and a real-looking due date", async () => {
    await seed();
    await expect(
      run(
        "insert into loans (id, library_id, copy_id, borrowed_at, due_on, returned_at) values ('x', 'libA', 'cA', 0, '2026-01-01', 5)",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        "insert into loans (id, library_id, copy_id, borrowed_at, due_on) values ('y', 'libA', 'cA', 0, 'friday')",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("survive when the borrowing user is deleted, losing only the link to them", async () => {
    await seed();
    await insertLoan("l1", { returned: true });
    await run("delete from users where id = 'u1'");
    const loan = await env.DB.prepare(
      "select family_id, borrowed_by from loans where id = 'l1'",
    ).first();
    expect(loan).toEqual({ family_id: "fA", borrowed_by: null });
  });

  it("block deleting a family or copy that still has history, until it is anonymised", async () => {
    await seed();
    await insertLoan("l1", { returned: true });
    await expect(run("delete from families where id = 'fA'")).rejects.toThrow(/FOREIGN KEY/);
    await expect(run("delete from copies where id = 'cA'")).rejects.toThrow(/FOREIGN KEY/);

    await run("update loans set family_id = null where family_id = 'fA'");
    await run("delete from families where id = 'fA'");
    expect(await env.DB.prepare("select count(*) as n from loans").first("n")).toBe(1);
  });

  it("are removed with the whole library", async () => {
    await seed();
    await insertLoan("l1", { returned: true });
    await run("delete from libraries where id = 'libA'");
    expect(await env.DB.prepare("select count(*) as n from loans").first("n")).toBe(0);
    expect(await env.DB.prepare("select count(*) as n from copies").first("n")).toBe(1);
  });
});

describe("other constraints", () => {
  it("refuse a short code used twice, even across libraries", async () => {
    await seed();
    await expect(
      run(
        "insert into copies (id, library_id, title_id, short_code) values ('c2', 'libB', 'tB', 'K7R2')",
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuse unknown roles and invalid settings JSON", async () => {
    await seed();
    await expect(
      run(
        "insert into memberships (id, library_id, user_id, role) values ('m1', 'libA', 'u1', 'root')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(run("update libraries set settings = 'nope' where id = 'libA'")).rejects.toThrow(
      /CHECK/,
    );
  });

  it("keep one title per ISBN in a library", async () => {
    await seed();
    await run(
      "insert into titles (id, library_id, isbn, title) values ('t1', 'libA', '9780140328721', 'X')",
    );
    await expect(
      run(
        "insert into titles (id, library_id, isbn, title) values ('t2', 'libA', '9780140328721', 'X')",
      ),
    ).rejects.toThrow(/UNIQUE/);
    await run(
      "insert into titles (id, library_id, isbn, title) values ('t3', 'libB', '9780140328721', 'X')",
    );
  });
});
