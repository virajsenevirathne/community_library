import type { EmailMessage, EmailSender, SendResult } from "@community-library/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuotaMailer } from "./mailer.ts";
import { createTestEnv } from "./test/env.ts";

let env: Env;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
});
afterEach(() => dispose());

class FakeProvider implements EmailSender {
  sent: EmailMessage[] = [];
  constructor(
    readonly name: string,
    private readonly behaviour: "ok" | "fail" | "throw" = "ok",
  ) {}
  async send(message: EmailMessage): Promise<SendResult> {
    if (this.behaviour === "throw") throw new Error("boom");
    if (this.behaviour === "fail")
      return { ok: false, provider: this.name, retryable: true, error: "http_500" };
    this.sent.push(message);
    return { ok: true, provider: this.name, id: String(this.sent.length) };
  }
}

const msg = (to = "a@example.com"): EmailMessage => ({ to, subject: "Hi", text: "Hi" });
const limits = { resend: { day: 3, month: 100 }, mailjet: { day: 2, month: 100 } };

describe("email quota", () => {
  it("uses Resend until its daily limit, then Mailjet, then stops", async () => {
    const resend = new FakeProvider("resend");
    const mailjet = new FakeProvider("mailjet");
    const mailer = new QuotaMailer(
      env.DB,
      [resend, mailjet],
      () => new Date("2026-11-11T10:00:00Z"),
      limits,
    );
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await mailer.send(msg()));
    expect(results.map((r) => r.provider)).toEqual([
      "resend",
      "resend",
      "resend",
      "mailjet",
      "mailjet",
      "quota",
    ]);
    expect(resend.sent).toHaveLength(3);
    expect(mailjet.sent).toHaveLength(2);
  });

  it("starts again the next day", async () => {
    let now = new Date("2026-11-11T10:00:00Z");
    const resend = new FakeProvider("resend");
    const mailer = new QuotaMailer(env.DB, [resend], () => now, limits);
    for (let i = 0; i < 4; i++) await mailer.send(msg());
    now = new Date("2026-11-12T00:01:00Z");
    expect((await mailer.send(msg())).ok).toBe(true);
  });

  it("falls back when Resend fails or throws, without counting the failed send", async () => {
    const mailer = new QuotaMailer(
      env.DB,
      [new FakeProvider("resend", "throw"), new FakeProvider("mailjet")],
      () => new Date("2026-11-11T10:00:00Z"),
      limits,
    );
    const sent = await mailer.send(msg());
    expect(sent.provider).toBe("mailjet");
    // Two outgoing requests, so callers can stay under the Worker's limit.
    expect(sent.attempts).toBe(2);
    const row = await env.DB.prepare(
      "select count from email_quota where provider = 'resend'",
    ).first("count");
    expect(row).toBe(0);
  });

  it("holds routine reminders back so sign-in codes always have room", async () => {
    const mailer = new QuotaMailer(
      env.DB,
      [new FakeProvider("resend")],
      () => new Date("2026-11-11T10:00:00Z"),
      { resend: { day: 25, month: 1000 } },
    );
    // 25 a day with 20 kept back: 5 routine emails go, the 6th waits.
    const routine = [];
    for (let i = 0; i < 6; i++) routine.push((await mailer.send(msg(), "routine")).ok);
    expect(routine).toEqual([true, true, true, true, true, false]);
    // Held back without calling any provider.
    expect((await mailer.send(msg(), "routine")).attempts).toBe(0);
    expect((await mailer.send(msg(), "urgent")).ok).toBe(true);
  });
});
