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
  // Quotes and angle brackets in a library's name could fake sender text.
  const from = { email: env.EMAIL_FROM, name: cleanHeader(fromName).replace(/[<>"]/g, "") };
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
  /** Borrowed at the library's kiosk tablet, with this person's code. */
  kiosk?: { personName: string };
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const due = formatDueDate(options.borrowed.dueOn);
  const list = options.booksOut.map((b) => `- ${b.title} (due ${formatDueDate(b.dueOn)})`);
  const who = options.kiosk ? cleanHeader(options.kiosk.personName).slice(0, 40) : null;
  const notYou = "If nobody in your family borrowed it, please tell the library staff.";
  return {
    to: options.to,
    subject: who
      ? `${who} borrowed ${cleanHeader(options.borrowed.title).slice(0, 80)} at the kiosk, due ${due}`
      : `You borrowed ${cleanHeader(options.borrowed.title).slice(0, 80)}, due ${due}`,
    text: [
      who
        ? `${who} borrowed "${options.borrowed.title}" at the ${library} kiosk. Please bring it back by ${due}.`
        : `You borrowed "${options.borrowed.title}" from ${library}. Please bring it back by ${due}.`,
      ...(who ? ["", notYou] : []),
      "",
      `Your family has ${options.booksOut.length} ${options.booksOut.length === 1 ? "book" : "books"} out:`,
      ...list,
      "",
      `See your books: ${options.siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: who ? "Borrowed at the kiosk" : "You borrowed a book",
      preheader: `Due ${due}`,
      paragraphs: [
        who
          ? `${escapeHtml(who)} borrowed <strong>${escapeHtml(options.borrowed.title)}</strong> at the kiosk. Please bring it back by <strong>${escapeHtml(due)}</strong>.`
          : `You borrowed <strong>${escapeHtml(options.borrowed.title)}</strong>. Please bring it back by <strong>${escapeHtml(due)}</strong>.`,
        ...(who ? [escapeHtml(notYou)] : []),
        `Your family has ${options.booksOut.length} ${options.booksOut.length === 1 ? "book" : "books"} out:`,
        `<ul style="margin:0;padding-left:20px">${options.booksOut
          .map((b) => `<li>${escapeHtml(b.title)}, due ${escapeHtml(formatDueDate(b.dueOn))}</li>`)
          .join("")}</ul>`,
        `<a href="${escapeHtml(options.siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">See your books</a>`,
      ],
    }),
  };
}

/** Tells a family waiting for a book that a copy is back on the shelf. */
export function holdReadyEmail(options: {
  libraryName: string;
  to: string;
  title: string;
  lapseDays: number;
  siteUrl: string;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const keep = `It isn't kept aside, so borrow it soon. If someone else gets to it first, we'll tell you when the next copy is back. Your place lapses after ${options.lapseDays} days.`;
  return {
    to: options.to,
    subject: `"${cleanHeader(options.title).slice(0, 80)}" is back at the library`,
    text: [
      `Good news: "${options.title}" is back on the shelf at ${library}.`,
      "",
      `Scan its sticker to borrow it as usual. ${keep}`,
      "",
      `See your books: ${options.siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Your book is back",
      preheader: `${options.title} is back on the shelf.`,
      paragraphs: [
        `Good news: <strong>${escapeHtml(options.title)}</strong> is back on the shelf.`,
        `Scan its sticker to borrow it as usual. ${escapeHtml(keep)}`,
        `<a href="${escapeHtml(options.siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">See your books</a>`,
      ],
    }),
  };
}

/**
 * Tells a family a book of theirs was brought back at the kiosk tablet
 * (no code is needed to return), so a mistake or a prank is noticed.
 */
export function kioskReturnEmail(options: {
  libraryName: string;
  to: string;
  title: string;
  /** The library checks returns in: the book waits in the basket for staff. */
  handedBack: boolean;
  siteUrl: string;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const done = options.handedBack
    ? "It's in the returns basket, and staff will check it in."
    : "It's off your family's list now.";
  const notYou = "If it's still at home with you, please tell the library staff.";
  return {
    to: options.to,
    subject: `"${cleanHeader(options.title).slice(0, 80)}" was returned at the kiosk`,
    text: [
      `"${options.title}" was returned at the ${library} kiosk. ${done}`,
      "",
      notYou,
      "",
      `See your books: ${options.siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Returned at the kiosk",
      preheader: done,
      paragraphs: [
        `<strong>${escapeHtml(options.title)}</strong> was returned at the kiosk. ${escapeHtml(done)}`,
        escapeHtml(notYou),
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

export interface ReminderLine {
  title: string;
  dueOn: string;
  kind: "due_soon" | "overdue";
  overdueDays: number;
  /** One-tap "keep it longer", when the library allows it and nobody is waiting. */
  extendUrl?: string;
}

/** One email per parent per day, listing every book that needs attention. */
export function reminderEmail(options: {
  libraryName: string;
  to: string;
  siteUrl: string;
  lines: ReminderLine[];
  /** Link that turns these reminders off (checkout confirmations still go out). */
  nudgesOffUrl: string;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const overdue = options.lines.filter((l) => l.kind === "overdue");
  const count = options.lines.length;
  // Subjects never name the book: they show on lock screens.
  const subject =
    overdue.length > 0
      ? `Reminder: ${count === 1 ? "a library book" : `${count} library books`} to bring back`
      : `${count === 1 ? "A library book is" : `${count} library books are`} due back soon`;
  const reminderLine = (l: ReminderLine) =>
    l.kind === "overdue"
      ? `${l.title}: was due ${formatDueDate(l.dueOn)} (${l.overdueDays} ${l.overdueDays === 1 ? "day" : "days"} ago)`
      : `${l.title}: due ${formatDueDate(l.dueOn)}`;
  const intro =
    overdue.length > 0
      ? `Our records show ${count === 1 ? "this book is" : "these books are"} past the due date. If you've already brought ${count === 1 ? "it" : "them"} back, thank you, and sorry for the mix-up.`
      : `A friendly heads-up from ${library}: ${count === 1 ? "this book is" : "these books are"} due back soon.`;
  return {
    to: options.to,
    subject,
    text: [
      intro,
      "",
      ...options.lines.flatMap((l) => [
        `- ${reminderLine(l)}`,
        ...(l.extendUrl ? [`  Keep "${l.title}" longer:`, `  ${l.extendUrl}`] : []),
      ]),
      "",
      `See your books (and keep one longer, if allowed): ${options.siteUrl}/`,
      "",
      `Don't want these reminders? ${options.nudgesOffUrl}`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: subject,
      preheader: intro,
      paragraphs: [
        escapeHtml(intro),
        `<ul style="margin:0;padding-left:20px">${options.lines
          .map(
            (l) =>
              `<li>${escapeHtml(reminderLine(l))}${
                l.extendUrl
                  ? `<br><a href="${escapeHtml(l.extendUrl)}" style="display:inline-block;padding:8px 0;color:#1f6f5c;font-weight:600;text-decoration:underline">Keep ${escapeHtml(l.title)} longer</a>`
                  : ""
              }</li>`,
          )
          .join("")}</ul>`,
        `<a href="${escapeHtml(options.siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">See your books and keep one longer</a>`,
        `<span style="font-size:14px;color:#3d4743">Don't want these reminders? <a href="${escapeHtml(options.nudgesOffUrl)}" style="color:#3d4743;text-decoration:underline">Turn them off</a>. You'll still get an email when you borrow.</span>`,
      ],
    }),
  };
}

export interface DigestLine {
  title: string;
  familyName: string;
  dueOn: string;
  overdueDays: number;
}

/** Monday email to staff: what is overdue, what needs following up, what was added. */
export function digestEmail(options: {
  libraryName: string;
  to: string;
  siteUrl: string;
  overdue: DigestLine[];
  staffFlagDays: number;
  newTitles: number;
  pendingFamilies: number;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const flagged = options.overdue.filter((l) => l.overdueDays >= options.staffFlagDays);
  const MAX_LISTED = 15;
  const shown = flagged.slice(0, MAX_LISTED);
  const more = flagged.length - shown.length;
  const line = (l: DigestLine) =>
    `${l.title}: ${l.familyName}, ${l.overdueDays} ${l.overdueDays === 1 ? "day" : "days"} late`;
  const summary = [
    `${options.overdue.length} ${options.overdue.length === 1 ? "book is" : "books are"} overdue${flagged.length > 0 ? `, ${flagged.length} for ${options.staffFlagDays}+ days` : ""}.`,
    `${options.newTitles} new ${options.newTitles === 1 ? "book was" : "books were"} added this week.`,
    ...(options.pendingFamilies > 0
      ? [
          `${options.pendingFamilies} ${options.pendingFamilies === 1 ? "family is" : "families are"} waiting for approval.`,
        ]
      : []),
  ];
  return {
    to: options.to,
    subject: `${library} weekly summary: ${options.overdue.length === 0 ? "all clear" : `${options.overdue.length} overdue`}`,
    text: [
      ...summary,
      "",
      ...(flagged.length > 0
        ? ["Needs following up:", ...flagged.map((l) => `- ${line(l)}`), ""]
        : []),
      `Open the library: ${options.siteUrl}/admin`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Weekly summary",
      preheader: summary[0] ?? "",
      paragraphs: [
        ...summary.map(escapeHtml),
        ...(flagged.length > 0
          ? [
              "<strong>Needs following up:</strong>",
              `<ul style="margin:0;padding-left:20px">${shown.map((l) => `<li>${escapeHtml(line(l))}</li>`).join("")}${more > 0 ? `<li>and ${more} more</li>` : ""}</ul>`,
            ]
          : []),
        `<a href="${escapeHtml(options.siteUrl)}/admin" style="color:#1f6f5c;font-weight:600;text-decoration:underline">Open the library</a>`,
      ],
    }),
  };
}

/** Invitation to join the library (from a CSV import, or staff adding a parent). */
export function inviteEmail(options: {
  libraryName: string;
  to: string;
  url: string;
  familyName: string | null;
  role: "member" | "staff" | "admin";
  expiresOn: string;
  /** The library is new: add the steps to get it running. */
  firstAdmin?: boolean;
}): EmailMessage {
  const library = cleanHeader(options.libraryName);
  const steps = options.firstAdmin
    ? [
        "Open the link and sign in with the code we email you.",
        "Accept the terms, and choose how returns work (self-serve, or staff check them in).",
        "Add your books: scan each barcode, then print the QR stickers.",
        "Print the sign-up poster so families can join, and invite your staff.",
      ]
    : [];
  const what =
    options.role === "member"
      ? `borrow books from ${library}${options.familyName ? ` as the ${options.familyName} family` : ""}`
      : `help run ${library} as ${options.role === "admin" ? "an admin" : "staff"}`;
  return {
    to: options.to,
    subject: `You're invited to ${library}`,
    text: [
      `You're invited to ${what}.`,
      ...(options.firstAdmin
        ? [
            "",
            `${library} is new. Getting it ready takes about 15 minutes:`,
            ...steps.map((s, i) => `${i + 1}. ${s}`),
          ]
        : []),
      "",
      `Join here: ${options.url}`,
      "",
      "You'll sign in with a code sent to this email address. No password needed.",
      "This link is just for you, so please don't forward it.",
      `The invitation works until ${formatDueDate(options.expiresOn)}.`,
      "If you weren't expecting this, you can ignore it.",
    ].join("\n"),
    html: htmlEmail(library, {
      title: `You're invited to ${library}`,
      preheader: `You're invited to ${what}.`,
      paragraphs: [
        `You're invited to ${escapeHtml(what)}.`,
        ...(options.firstAdmin
          ? [
              `${escapeHtml(library)} is new. Getting it ready takes about 15 minutes:<br>${steps.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join("<br>")}`,
            ]
          : []),
        `<a href="${escapeHtml(options.url)}" style="display:inline-block;background:#1f6f5c;color:#ffffff;padding:12px 20px;border-radius:8px;font-weight:600;text-decoration:none">Join the library</a>`,
        "You'll sign in with a code sent to this email address. No password needed. This link is just for you, so please don't forward it.",
        `The invitation works until ${escapeHtml(formatDueDate(options.expiresOn))}. If you weren't expecting this, you can ignore it.`,
      ],
    }),
  };
}

/** The code that confirms deleting an account. */
export function deleteCodeEmail(libraryName: string, to: string, code: string): EmailMessage {
  const library = cleanHeader(libraryName);
  return {
    to,
    subject: `${code} is your code to delete your ${library} account`,
    text: [
      `Someone asked to delete your ${library} account. To confirm, enter this code:`,
      "",
      `    ${code}`,
      "",
      "It works for 10 minutes. Once deleted, your account can't be restored.",
      "If this wasn't you, ignore this email: nothing will be deleted.",
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Confirm deleting your account",
      preheader: "If this wasn't you, ignore this email.",
      paragraphs: [
        "Someone asked to delete your account. To confirm, enter this code:",
        `<strong style="font-size:32px;letter-spacing:6px">${escapeHtml(code)}</strong>`,
        "It works for 10 minutes. If this wasn't you, ignore this email: nothing will be deleted.",
      ],
    }),
  };
}

/** Confirms an account was deleted. Sent to the address that was just removed. */
export function goodbyeEmail(libraryName: string, to: string): EmailMessage {
  const library = cleanHeader(libraryName);
  return {
    to,
    subject: `Your ${library} account has been deleted`,
    text: [
      `Your ${library} account has been deleted, as you asked.`,
      "Your email address and sign-in details are gone, and you won't get any more emails from the library.",
      "Thank you for borrowing with us. You're welcome back any time: ask staff for the sign-up link.",
    ].join("\n"),
    html: htmlEmail(library, {
      title: "Account deleted",
      preheader: "Your account has been deleted.",
      paragraphs: [
        "Your account has been deleted, as you asked.",
        "Your email address and sign-in details are gone, and you won't get any more emails from the library.",
        "Thank you for borrowing with us. You're welcome back any time: ask staff for the sign-up link.",
      ],
    }),
  };
}

/** Tells parents that staff approved their family, so they can borrow. */
export function approvedEmail(libraryName: string, to: string, siteUrl: string): EmailMessage {
  const library = cleanHeader(libraryName);
  return {
    to,
    subject: `You can now borrow from ${library}`,
    text: [
      `Good news: the library staff have approved your family, so you can borrow books now.`,
      "Scan the QR sticker inside a book's cover to borrow it.",
      "",
      `Open the library: ${siteUrl}/`,
    ].join("\n"),
    html: htmlEmail(library, {
      title: "You can now borrow",
      preheader: "The library staff have approved your family.",
      paragraphs: [
        "Good news: the library staff have approved your family, so you can borrow books now.",
        "Scan the QR sticker inside a book's cover to borrow it.",
        `<a href="${escapeHtml(siteUrl)}/" style="color:#1f6f5c;font-weight:600;text-decoration:underline">Open the library</a>`,
      ],
    }),
  };
}
