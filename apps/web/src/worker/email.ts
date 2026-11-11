import {
  ConsoleSender,
  type EmailMessage,
  type EmailSender,
  MailjetSender,
  ResendSender,
  type SendResult,
} from "@community-library/adapters";
import { isLocalHost, secrets } from "./config.ts";

/** Used when no provider is configured on a real deployment: fails loudly, never logs the email. */
class NotConfiguredSender implements EmailSender {
  readonly name = "none";
  async send(): Promise<SendResult> {
    console.error(
      "Email not sent: set RESEND_API_KEY (and MAILJET_API_KEY/SECRET) on this deployment.",
    );
    return { ok: false, provider: this.name, retryable: false, error: "not_configured" };
  }
}

/**
 * The providers configured for this deployment, in the order to try them:
 * Resend first, Mailjet second. With no keys set, emails are printed to the
 * terminal, but only on a local development host, because they hold sign-in codes.
 */
export function configuredSenders(env: Env, fromName: string, hostname: string): EmailSender[] {
  const s = secrets(env);
  const from = { email: env.EMAIL_FROM, name: cleanHeader(fromName) };
  const senders: EmailSender[] = [];
  if (s.RESEND_API_KEY) senders.push(new ResendSender(s.RESEND_API_KEY, from));
  if (s.MAILJET_API_KEY && s.MAILJET_API_SECRET) {
    senders.push(new MailjetSender(s.MAILJET_API_KEY, s.MAILJET_API_SECRET, from));
  }
  if (senders.length === 0) {
    senders.push(isLocalHost(hostname) ? new ConsoleSender() : new NotConfiguredSender());
  }
  return senders;
}

/** Whether real email can go out; shown by /api/health so setup problems are visible. */
export function emailStatus(env: Env): "ok" | "no_provider" | "placeholder_sender" {
  const s = secrets(env);
  if (!s.RESEND_API_KEY && !(s.MAILJET_API_KEY && s.MAILJET_API_SECRET)) return "no_provider";
  if (!env.EMAIL_FROM || env.EMAIL_FROM.endsWith("@example.com")) return "placeholder_sender";
  return "ok";
}

/** Tries each sender in turn until one accepts the message. */
export class FallbackSender implements EmailSender {
  readonly name = "fallback";
  constructor(private readonly senders: EmailSender[]) {}
  async send(message: EmailMessage): Promise<SendResult> {
    let last: SendResult = { ok: false, provider: "none", retryable: false, error: "no_provider" };
    for (const sender of this.senders) {
      last = await sender.send(message);
      if (last.ok) return last;
    }
    return last;
  }
}

/** Removes line breaks and control characters, which must never reach an email header. */
export function cleanHeader(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Escapes text for use inside the HTML version of an email. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A plain, accessible HTML wrapper so every email looks the same. */
export function htmlEmail(
  libraryName: string,
  options: { title: string; preheader: string; paragraphs: string[] },
): string {
  const name = escapeHtml(libraryName);
  const body = options.paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><title>${escapeHtml(options.title)}</title></head><body style="margin:0;padding:24px;background:#f7f5f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2522;font-size:16px;line-height:1.5"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(options.preheader)}</div><div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px"><p style="margin:0 0 16px;font-weight:600;color:#1f6f5c">${name}</p>${body}</div></body></html>`;
}

export function signInCodeEmail(
  libraryName: string,
  to: string,
  code: string,
  hostname: string,
): EmailMessage {
  const library = cleanHeader(libraryName);
  return {
    to,
    subject: `${code} is your ${library} sign-in code`,
    text: [
      `Your ${library} sign-in code is:`,
      "",
      `    ${code}`,
      "",
      "Type these 6 digits on the sign-in page. The code works for 10 minutes.",
      "Never share this code. Library staff will never ask you for it.",
      "If you did not try to sign in, you can ignore this email.",
      "",
      // Lets iPhones and Chrome offer the code automatically, only on this site.
      `@${hostname} #${code}`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Your sign-in code",
      preheader: `Your code is ${code}. It works for 10 minutes.`,
      paragraphs: [
        "Your sign-in code is:",
        `<strong style="font-size:32px;letter-spacing:6px">${escapeHtml(code)}</strong>`,
        "Type these 6 digits on the sign-in page. The code works for 10 minutes.",
        "Never share this code. Library staff will never ask you for it. If you did not try to sign in, you can ignore this email.",
      ],
    }),
  };
}

const DUE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** "Friday 21 November" for a YYYY-MM-DD due date. */
export function formatDueDate(date: string): string {
  return DUE_FORMAT.format(new Date(`${date}T12:00:00Z`));
}

/** Sent to every parent in the family when a book is borrowed. Always sent, even with nudges off. */
export function checkoutEmail(options: {
  libraryName: string;
  to: string;
  siteUrl: string;
  borrowed: { title: string; dueOn: string };
  booksOut: { title: string; dueOn: string }[];
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const due = formatDueDate(options.borrowed.dueOn);
  const list = options.booksOut.map((b) => `- ${b.title} (due ${formatDueDate(b.dueOn)})`);
  return {
    to: options.to,
    subject: `You borrowed ${cleanHeader(options.borrowed.title).slice(0, 80)}, due ${due}`,
    text: [
      `You borrowed "${options.borrowed.title}" from ${library}. Please bring it back by ${due}.`,
      "",
      `Your family has ${options.booksOut.length} ${options.booksOut.length === 1 ? "book" : "books"} out:`,
      ...list,
      "",
      `See your books: ${options.siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "You borrowed a book",
      preheader: `Due ${due}`,
      paragraphs: [
        `You borrowed <strong>${escapeHtml(options.borrowed.title)}</strong>. Please bring it back by <strong>${escapeHtml(due)}</strong>.`,
        `Your family has ${options.booksOut.length} ${options.booksOut.length === 1 ? "book" : "books"} out:`,
        `<ul style="margin:0;padding-left:20px">${options.booksOut
          .map((b) => `<li>${escapeHtml(b.title)}, due ${escapeHtml(formatDueDate(b.dueOn))}</li>`)
          .join("")}</ul>`,
        `<a href="${escapeHtml(options.siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">See your books</a>`,
      ],
    }),
  };
}

/** Tells a family that someone found a book they have out. */
export function foundEmail(options: {
  libraryName: string;
  to: string;
  title: string;
  dueOn: string;
  siteUrl: string;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const due = formatDueDate(options.dueOn);
  return {
    to: options.to,
    subject: `Someone found "${cleanHeader(options.title).slice(0, 80)}" at the library`,
    text: [
      `No action needed, unless you still have "${options.title}" at home.`,
      "",
      `Another parent found this book at ${library}. It's on your family's account (due ${due}).`,
      "Staff will check it in when it's back on the shelf, and it will leave your list then.",
      "If you do still have it at home, please let the library staff know.",
      "",
      `See your books: ${options.siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Someone found your book",
      preheader: "No action needed unless you still have it at home.",
      paragraphs: [
        `<strong>No action needed</strong>, unless you still have <strong>${escapeHtml(options.title)}</strong> at home.`,
        `Another parent found this book at the library. It's on your family's account (due ${escapeHtml(due)}). Staff will check it in when it's back on the shelf.`,
        "If you do still have it at home, please let the library staff know.",
        `<a href="${escapeHtml(options.siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">See your books</a>`,
      ],
    }),
  };
}
