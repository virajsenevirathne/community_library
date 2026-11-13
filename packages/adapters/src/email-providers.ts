import type { EmailMessage, EmailSender, SendResult } from "./email.ts";
import { platformFetch } from "./fetch.ts";

export interface FromAddress {
  email: string;
  name: string;
}

/** Statuses worth retrying with the same or another provider. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Error bodies read for a reason: a big error page isn't worth buffering. */
const MAX_ERROR_BODY = 4096;

/**
 * A short error for the log: the status and the provider's own reason (such as
 * "domain not verified"). Addresses, long numbers (a sign-in code) and
 * token-like strings in it are hidden, so it can't carry the message's contents.
 */
async function errorCode(res: Response): Promise<string> {
  let reason = "";
  try {
    const body = JSON.parse((await res.text()).slice(0, MAX_ERROR_BODY)) as {
      message?: unknown;
      ErrorMessage?: unknown;
      Messages?: { Errors?: { ErrorMessage?: unknown }[] }[];
    };
    const found = [
      body.message,
      body.ErrorMessage,
      body.Messages?.[0]?.Errors?.[0]?.ErrorMessage,
    ].find((x) => typeof x === "string");
    if (typeof found === "string") reason = found;
  } catch {
    // Not JSON, or cut short: the status says enough.
  }
  reason = reason
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\S+\s*@\s*\S+/g, "<address>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<token>")
    .replace(/\d{4,}/g, "<number>")
    .trim()
    .slice(0, 150);
  return reason ? `http_${res.status}: ${reason}` : `http_${res.status}`;
}

/** Characters no API key has: spaces, line breaks, curly quotes and the like. */
function hasStrayCharacters(...keys: string[]): boolean {
  return keys.some((key) => /[^\x21-\x7e]/.test(key));
}

const STRAY_KEY = "bad_key: the API key has a space, line break or curly quote in it";

/** The request couldn't be made, or its answer couldn't be read. */
function requestError(error: unknown): string {
  return `request_failed: ${error instanceof Error ? error.name : "Error"}`;
}

/** An accepted message's id, if the answer can be read: it was sent either way. */
async function sentId(res: Response, pick: (body: never) => string | undefined): Promise<string> {
  try {
    return pick((await res.json()) as never) ?? "";
  } catch {
    return "";
  }
}

/** Resend (https://resend.com). Primary provider: 100 emails a day on the free plan. */
export class ResendSender implements EmailSender {
  readonly name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: FromAddress,
    private readonly fetcher: typeof fetch = platformFetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    // Checked first: a key like that can't be sent, and would only say "failed".
    if (hasStrayCharacters(this.apiKey)) {
      return { ok: false, provider: this.name, retryable: false, error: STRAY_KEY };
    }
    let res: Response;
    try {
      res = await this.fetcher("https://api.resend.com/emails", {
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
    } catch (error) {
      return { ok: false, provider: this.name, retryable: true, error: requestError(error) };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.name,
        retryable: retryableStatus(res.status),
        error: await errorCode(res),
      };
    }
    const id = await sentId(res, (body: { id?: string }) => body.id);
    return { ok: true, provider: this.name, id };
  }
}

/** Mailjet (https://mailjet.com). Fallback provider when Resend is out of quota or down. */
export class MailjetSender implements EmailSender {
  readonly name = "mailjet";
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly from: FromAddress,
    private readonly fetcher: typeof fetch = platformFetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    if (hasStrayCharacters(this.apiKey, this.apiSecret)) {
      return { ok: false, provider: this.name, retryable: false, error: STRAY_KEY };
    }
    let res: Response;
    try {
      res = await this.fetcher("https://api.mailjet.com/v3.1/send", {
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
    } catch (error) {
      return { ok: false, provider: this.name, retryable: true, error: requestError(error) };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.name,
        retryable: retryableStatus(res.status),
        error: await errorCode(res),
      };
    }
    const id = await sentId(
      res,
      (body: { Messages?: { To?: { MessageUUID?: string }[] }[] }) =>
        body.Messages?.[0]?.To?.[0]?.MessageUUID,
    );
    return { ok: true, provider: this.name, id };
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
