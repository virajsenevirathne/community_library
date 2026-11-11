import type { EmailMessage, EmailSender, SendResult } from "@community-library/adapters";

/**
 * Free-plan sending limits per provider. Resend's free plan allows 100 emails
 * a day and 3,000 a month; Mailjet's about 200 a day and 6,000 a month.
 * Providers not listed (the local console) have no limit.
 */
export const PROVIDER_LIMITS: Record<string, { day: number; month: number }> = {
  resend: { day: 100, month: 3000 },
  mailjet: { day: 200, month: 6000 },
};

/**
 * Emails kept back each day for sign-in codes and checkout confirmations:
 * reminders wait for tomorrow rather than use these up.
 */
export const RESERVED_FOR_URGENT = 20;

export type Priority = "urgent" | "routine";

export const DEFERRED: SendResult = {
  ok: false,
  provider: "quota",
  retryable: true,
  error: "deferred_quota",
};

function utcDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

/**
 * Sends through the configured providers in order (Resend, then Mailjet),
 * counting each send against that provider's daily and monthly limit in D1.
 * When one is out of quota or fails, the next one is tried.
 */
export class QuotaMailer implements EmailSender {
  readonly name = "quota";
  constructor(
    private readonly DB: D1Database,
    private readonly senders: EmailSender[],
    private readonly now: () => Date = () => new Date(),
    private readonly limits: Record<string, { day: number; month: number }> = PROVIDER_LIMITS,
  ) {}

  /** Emails still allowed today across all providers (Infinity when one has no limit). */
  async remainingToday(): Promise<number> {
    let total = 0;
    for (const sender of this.senders) {
      const limit = this.limits[sender.name];
      if (!limit) return Number.POSITIVE_INFINITY;
      const { day, month } = await this.used(sender.name);
      total += Math.max(0, Math.min(limit.day - day, limit.month - month));
    }
    return total;
  }

  /** remainingToday, re-read at most once a minute (a reminder run sends many emails). */
  private cachedRemaining: { value: number; at: number } | null = null;

  private async remainingCached(): Promise<number> {
    const now = Date.now();
    if (!this.cachedRemaining || now - this.cachedRemaining.at > 60_000) {
      this.cachedRemaining = { value: await this.remainingToday(), at: now };
    }
    return this.cachedRemaining.value;
  }

  async send(message: EmailMessage, priority: Priority = "urgent"): Promise<SendResult> {
    if (priority === "routine" && (await this.remainingCached()) <= RESERVED_FOR_URGENT) {
      return DEFERRED;
    }
    let last: SendResult = DEFERRED;
    for (const sender of this.senders) {
      const day = await this.claim(sender.name);
      if (day === null) continue;
      try {
        last = await sender.send(message);
      } catch (error) {
        last = {
          ok: false,
          provider: sender.name,
          retryable: true,
          error: String(error).slice(0, 100),
        };
      }
      if (last.ok) {
        if (this.cachedRemaining) this.cachedRemaining.value -= 1;
        return last;
      }
      // Not accepted: give the slot back, on the day it was counted.
      await this.release(sender.name, day);
    }
    return last;
  }

  private async used(provider: string) {
    const now = this.now();
    const row = await this.DB.prepare(
      `select coalesce(sum(case when day = ?2 then count end), 0) as day,
              coalesce(sum(count), 0) as month
       from email_quota where provider = ?1 and day like ?3`,
    )
      .bind(provider, utcDay(now), `${utcDay(now).slice(0, 7)}%`)
      .first<{ day: number; month: number }>();
    return { day: row?.day ?? 0, month: row?.month ?? 0 };
  }

  /**
   * Counts one send if the provider still has room today and this month.
   * Returns the day it was counted on, or null when there is no room.
   */
  private async claim(provider: string): Promise<string | null> {
    const day = utcDay(this.now());
    const limit = this.limits[provider];
    if (!limit) return day;
    const { month } = await this.used(provider);
    if (month >= limit.month) return null;
    const row = await this.DB.prepare(
      `insert into email_quota (provider, day, count) values (?1, ?2, 1)
       on conflict (provider, day) do update set count = count + 1 where count < ?3
       returning count`,
    )
      .bind(provider, day, limit.day)
      .first();
    return row === null ? null : day;
  }

  /**
   * Gives back a counted send that the provider did not accept. (A send that
   * timed out but was in fact delivered is undercounted by one; that is fine.)
   */
  private async release(provider: string, day: string) {
    if (!this.limits[provider]) return;
    await this.DB.prepare(
      "update email_quota set count = max(count - 1, 0) where provider = ? and day = ?",
    )
      .bind(provider, day)
      .run();
  }
}
