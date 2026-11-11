import type { EmailMessage, SendResult } from "@community-library/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "../test/env.ts";
import { createLibrary } from "../test/fixtures.ts";
import { runHourlyJob } from "./reminders.ts";

let env: Env;
let dispose: () => Promise<void>;
let sent: EmailMessage[];
let failing: boolean;

const mailer = {
  async send(message: EmailMessage): Promise<SendResult> {
    if (failing) return { ok: false, provider: "quota", retryable: true, error: "deferred_quota" };
    sent.push(message);
    return { ok: true, provider: "memory", id: String(sent.length) };
  },
};

// Wednesday 11 November 2026, 10:00 UTC.
const WEDNESDAY = new Date("2026-11-11T10:00:00Z");
const run = (now = WEDNESDAY) =>
  runHourlyJob({ DB: env.DB, env, mailer, siteUrl: "https://library.example.org", now });

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  sent = [];
  failing = false;
  await createLibrary(env, { settings: { timezone: "UTC", reminderHour: 9, closedWeekdays: [] } });
  const statements = [
    "insert into users (id, name, email, updated_at) values ('u1', '', 'mum@example.com', 0), ('u2', '', 'dad@example.com', 0), ('u3', '', 'other@example.com', 0), ('s1', '', 'staff@example.com', 0)",
    "insert into families (id, library_id, name) values ('f1', 'lib-1', 'Nguyen'), ('f2', 'lib-1', 'Okafor')",
    "insert into memberships (id, library_id, user_id, role, family_id) values ('m1', 'lib-1', 'u1', 'member', 'f1'), ('m2', 'lib-1', 'u2', 'member', 'f1'), ('m3', 'lib-1', 'u3', 'member', 'f2'), ('m4', 'lib-1', 's1', 'staff', null)",
    "insert into titles (id, library_id, title) values ('t1', 'lib-1', 'Owl Babies'), ('t2', 'lib-1', 'The Gruffalo'), ('t3', 'lib-1', 'Room on the Broom')",
    "insert into copies (id, library_id, title_id, short_code) values ('c1', 'lib-1', 't1', 'AAAA'), ('c2', 'lib-1', 't2', 'BBBB'), ('c3', 'lib-1', 't3', 'CCCC')",
    // Family 1: one due tomorrow, one a day late. Family 2: due in 10 days (nothing to send).
    "insert into loans (id, library_id, copy_id, family_id, borrowed_at, due_on) values ('l1', 'lib-1', 'c1', 'f1', 0, '2026-11-12'), ('l2', 'lib-1', 'c2', 'f1', 0, '2026-11-10'), ('l3', 'lib-1', 'c3', 'f2', 0, '2026-11-21')",
  ];
  await env.DB.batch(statements.map((q) => env.DB.prepare(q)));
});
afterEach(() => dispose());

describe("hourly reminder job", () => {
  it("sends each parent one email listing every book that needs attention", async () => {
    await run();
    expect(sent.map((m) => m.to).sort()).toEqual(["dad@example.com", "mum@example.com"]);
    const email = sent[0];
    expect(email?.subject).toBe("Reminder: 2 library books to bring back");
    expect(email?.subject).not.toContain("Gruffalo");
    expect(email?.text).toContain("Owl Babies: due");
    expect(email?.text).toContain("The Gruffalo: was due");
    expect(email?.text).toContain("https://library.example.org/reminders-off?f=f1&t=");
  });

  it("never sends the same reminder twice, even when run again", async () => {
    await run();
    await run(new Date("2026-11-11T11:00:00Z"));
    expect(sent).toHaveLength(2);
  });

  it("waits for the library's reminder hour in its own timezone", async () => {
    await run(new Date("2026-11-11T08:00:00Z"));
    expect(sent).toHaveLength(0);
    // 10:00 UTC is 21:00 in Sydney: too late is fine (still same local day), but a
    // library in Sydney at 06:00 local must wait.
    await env.DB.prepare(
      "update libraries set settings = json_set(settings, '$.timezone', 'Australia/Sydney')",
    ).run();
    await run(new Date("2026-11-11T19:00:00Z")); // 06:00 on 12 Nov in Sydney
    expect(sent).toHaveLength(0);
  });

  it("sends nothing on a closed day, and catches up on the next open day", async () => {
    await env.DB.prepare(
      "update libraries set settings = json_set(settings, '$.closedDates', json('[\"2026-11-11\"]'))",
    ).run();
    await run();
    expect(sent).toHaveLength(0);
    await run(new Date("2026-11-12T10:00:00Z"));
    expect(sent.length).toBeGreaterThan(0);
  });

  it("respects a family's choice to turn reminders off", async () => {
    await env.DB.prepare("update families set nudges_off = 1 where id = 'f1'").run();
    await run();
    expect(sent).toHaveLength(0);
  });

  it("tries again next hour when email could not be sent", async () => {
    failing = true;
    await run();
    expect(sent).toHaveLength(0);
    failing = false;
    await run(new Date("2026-11-11T11:00:00Z"));
    expect(sent).toHaveLength(2);
  });

  it("moves to the next stage as a loan gets later, without repeating old ones", async () => {
    await run();
    sent = [];
    // A week later: Owl Babies is now 6 days late (stage 1), The Gruffalo 8 days late (stage 7).
    await run(new Date("2026-11-18T10:00:00Z"));
    const text = sent.map((m) => m.text).join("\n");
    expect(text).toContain("Owl Babies");
    expect(text).toContain("The Gruffalo");
    sent = [];
    // A day later Owl Babies reaches its 7-day stage: one more email, about it only.
    await run(new Date("2026-11-19T10:00:00Z"));
    // (The other family's book also comes into its "due soon" window today.)
    const family1 = sent.filter((m) => m.to !== "other@example.com");
    expect(family1).toHaveLength(2);
    expect(
      family1.every((m) => m.text.includes("Owl Babies") && !m.text.includes("Gruffalo")),
    ).toBe(true);
    sent = [];
    await run(new Date("2026-11-19T12:00:00Z"));
    expect(sent).toHaveLength(0);
  });

  it("sends staff a weekly summary on Mondays, once", async () => {
    const monday = new Date("2026-11-16T10:00:00Z");
    await run(monday);
    await run(new Date("2026-11-16T11:00:00Z"));
    const digests = sent.filter((m) => m.to === "staff@example.com");
    expect(digests).toHaveLength(1);
    expect(digests[0]?.subject).toContain("weekly summary");
  });

  it("forgets who borrowed old loans, keeping the count", async () => {
    await env.DB.prepare(
      "insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on, returned_at, outcome) values ('old', 'lib-1', 'c1', 'f1', 'u1', 0, '2024-01-01', ?, 'returned')",
    )
      .bind(new Date("2025-06-01T00:00:00Z").getTime())
      .run();
    await run();
    const old = await env.DB.prepare(
      "select family_id, borrowed_by from loans where id = 'old'",
    ).first();
    expect(old).toEqual({ family_id: null, borrowed_by: null });
  });

  it("records each run for the dashboard", async () => {
    await run();
    const job = await env.DB.prepare(
      "select finished_at, error from job_runs where name = 'hourly'",
    ).first();
    expect(job).toMatchObject({ error: null });
    expect(job?.finished_at).toBeGreaterThan(0);
  });
});

describe("delivery problems", () => {
  it("retries only the parent whose email failed", async () => {
    const original = mailer.send;
    mailer.send = async (message) => {
      if (message.to === "dad@example.com") {
        return { ok: false, provider: "resend", retryable: true, error: "http_500" };
      }
      return original(message);
    };
    await run();
    expect(sent.map((m) => m.to)).toEqual(["mum@example.com"]);
    mailer.send = original;
    sent = [];
    await run(new Date("2026-11-11T11:00:00Z"));
    expect(sent.map((m) => m.to)).toEqual(["dad@example.com"]);
  });

  it("takes over a claim left behind by a run that died", async () => {
    // A claim stuck as "pending" for 20 minutes.
    await env.DB.prepare(
      "insert into notifications (id, library_id, family_id, kind, dedupe_key, status, created_at) select 'n', 'lib-1', 'f1', 'overdue', 'loan:l2:overdue:1:to:u1', 'pending', ?",
    )
      .bind(Date.now() - 20 * 60 * 1000)
      .run();
    await run();
    expect(sent.find((m) => m.to === "mum@example.com")?.text).toContain("The Gruffalo");
  });

  it("does not take over a claim another run is still working on", async () => {
    await env.DB.prepare(
      "insert into notifications (id, library_id, family_id, kind, dedupe_key, status, created_at) select 'n', 'lib-1', 'f1', 'overdue', 'loan:l2:overdue:1:to:u1', 'pending', ?",
    )
      .bind(Date.now())
      .run();
    await run();
    expect(sent.find((m) => m.to === "mum@example.com")?.text ?? "").not.toContain("The Gruffalo");
  });

  it("still sends the Monday summary when Monday is a closed day", async () => {
    await env.DB.prepare(
      "update libraries set settings = json_set(settings, '$.closedWeekdays', json('[1]'))",
    ).run();
    await run(new Date("2026-11-16T10:00:00Z"));
    expect(sent.map((m) => m.to)).toEqual(["staff@example.com"]);
  });

  it("refuses to sign links without a proper secret", async () => {
    const { nudgesOffUrl } = await import("./reminders.ts");
    await expect(
      nudgesOffUrl({ ...env, BETTER_AUTH_SECRET: "" } as Env, "https://x", "f1"),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });

  it("keeps the day within the month when going back months", async () => {
    const { monthsBefore } = await import("./reminders.ts");
    expect(monthsBefore(new Date("2026-03-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe(
      "2026-02-28",
    );
    expect(monthsBefore(new Date("2026-11-15T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe(
      "2025-11-15",
    );
  });
});

describe("queued invites", () => {
  it("sends invites waiting from an import", async () => {
    await env.DB.prepare(
      "insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at) values ('i1', 'lib-1', 'f2', 'new@example.com', 'member', 'unsent:i1', 0)",
    ).run();
    await run(new Date("2026-11-11T05:00:00Z")); // before reminder time: invites still go
    expect(sent.map((m) => m.to)).toEqual(["new@example.com"]);
    expect(sent[0]?.text).toContain("https://library.example.org/invite/");
    sent = [];
    await run(new Date("2026-11-11T06:00:00Z"));
    expect(sent).toHaveLength(0);
  });
});
