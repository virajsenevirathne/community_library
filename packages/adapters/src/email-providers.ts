import type { EmailMessage, EmailSender, SendResult } from "./email.ts";

export interface FromAddress {
  email: string;
  name: string;
}

/** Statuses worth retrying with the same or another provider. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A short error code that never includes the recipient or message text. */
function errorCode(status: number): string {
  return `http_${status}`;
}

/** Resend (https://resend.com). Primary provider: 100 emails a day on the free plan. */
export class ResendSender implements EmailSender {
  readonly name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: FromAddress,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const res = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: `${this.from.name} <${this.from.email}>`,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          provider: this.name,
          retryable: retryableStatus(res.status),
          error: errorCode(res.status),
        };
      }
      const body = (await res.json()) as { id?: string };
      return { ok: true, provider: this.name, id: body.id ?? "" };
    } catch {
      return { ok: false, provider: this.name, retryable: true, error: "network" };
    }
  }
}

/** Mailjet (https://mailjet.com). Fallback provider when Resend is out of quota or down. */
export class MailjetSender implements EmailSender {
  readonly name = "mailjet";
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly from: FromAddress,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const res = await this.fetcher("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.apiKey}:${this.apiSecret}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          Messages: [
            {
              From: { Email: this.from.email, Name: this.from.name },
              To: [{ Email: message.to }],
              Subject: message.subject,
              TextPart: message.text,
              ...(message.html ? { HTMLPart: message.html } : {}),
              ...(message.idempotencyKey ? { CustomID: message.idempotencyKey.slice(0, 255) } : {}),
            },
          ],
        }),
      });
      if (!res.ok) {
        return {
          ok: false,
          provider: this.name,
          retryable: retryableStatus(res.status),
          error: errorCode(res.status),
        };
      }
      const body = (await res.json()) as { Messages?: { To?: { MessageUUID?: string }[] }[] };
      return { ok: true, provider: this.name, id: body.Messages?.[0]?.To?.[0]?.MessageUUID ?? "" };
    } catch {
      return { ok: false, provider: this.name, retryable: true, error: "network" };
    }
  }
}

/**
 * Prints emails to the log instead of sending them. Used in local development
 * when no provider keys are set, so sign-in codes appear in the terminal.
 */
export class ConsoleSender implements EmailSender {
  readonly name = "console";
  async send(message: EmailMessage): Promise<SendResult> {
    console.log(`\n✉️  To: ${message.to}\n   Subject: ${message.subject}\n\n${message.text}\n`);
    return { ok: true, provider: this.name, id: crypto.randomUUID() };
  }
}

/** Keeps emails in memory, for tests. */
export class MemorySender implements EmailSender {
  readonly name = "memory";
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, provider: this.name, id: String(this.sent.length) };
  }
  /** The latest message sent to `to`, if any. */
  last(to: string): EmailMessage | undefined {
    return this.sent.findLast((m) => m.to === to);
  }
}
