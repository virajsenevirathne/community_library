# Adapters and webhooks

Reading Joey talks to the outside world through small adapters, so a
library or contributor can swap or add one without touching the rest. They
live in `packages/adapters/src` and have no Cloudflare-specific code.

| Adapter             | Interface                                | Built in                                    | File                             |
| ------------------- | ---------------------------------------- | ------------------------------------------- | -------------------------------- |
| Email               | `EmailSender.send(message)`              | Resend, Mailjet (fallback), console (local) | `email.ts`, `email-providers.ts` |
| Phone notifications | `PushSender.send(subscription, message)` | Web push (VAPID)                            | `push.ts`                        |
| Book details        | `MetadataProvider.lookup(isbn)`          | Open Library, Google Books                  | `metadata.ts`                    |
| Label sheets        | `LabelTemplate`                          | A4 and Letter label sizes                   | `labels.ts`                      |

Family directories come in three ways, all built in: staff add families by
hand, families join with the sign-up link or QR poster, or staff import a
spreadsheet (CSV) of family names and parents' emails.

## Adding a notification channel (SMS, WhatsApp, …)

A channel is anything with the shape of `EmailSender`:

```ts
import type { EmailMessage, EmailSender, SendResult } from "@community-library/adapters";

export class SmsSender implements EmailSender {
  async send(message: EmailMessage): Promise<SendResult> {
    // Send message.text to the person's number, then:
    return { ok: true, provider: "sms", id: "the-provider-message-id" };
    // or { ok: false, provider: "sms", retryable: true, error: "short code only" }
  }
}
```

1. Add it in `packages/adapters/src`, export it from `index.ts`, and add tests
   next to it (see `push.test.ts` for a sender tested without the network).
2. Choose it in `apps/web/src/worker/email.ts` (`configuredSenders`) when its
   secrets are set, the way Resend and Mailjet are.
3. Never put a family's details in logs or error messages: `SendResult.error`
   is stored, so keep it to a short code.

## Adding a book lookup

Implement `MetadataProvider` (`name`, and `lookup(isbn)` returning book
details, `null` for "not found", or `"unavailable"` when the service is
down). Add it to the list in `apps/web/src/worker/app.ts`; providers are asked
in order and the first answer wins. Cover images are only shown from hosts in
`COVER_HOSTS`.

## Webhooks

An admin can give a library one webhook in **Settings › Connect your own
system**: an https address that's told about loans as they happen. Messages
never hold names or email addresses. The secret code is shown once, when it's
made (or replaced); keep it in your system's settings. Webhooks pause while a
library is paused.

Events and their `data`:

| Event             | `data`                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `loan.created`    | `loanId`, `book` (`title`, `code`), `dueOn`, `via` (`phone` or `kiosk`)                            |
| `loan.returned`   | `loanId`, `book`, `outcome` (`returned`, `lost` or `damaged`), `via` (`phone`, `kiosk` or `staff`) |
| `loan.overdue`    | `loanId`, `book`, `dueOn` (sent once per loan)                                                     |
| `account.deleted` | `familyRemoved`, and `byStaff: true` when staff removed the family                                 |
| `ping`            | nothing (`{}`): the Send a test button, tried once                                                 |

Each message is a `POST` with a JSON body:

```json
{
  "id": "0f3c…",
  "type": "loan.created",
  "createdAt": "2026-11-13T09:30:00.000Z",
  "library": "little-owls",
  "data": {
    "loanId": "8a1d…",
    "book": { "title": "Owl Babies", "code": "K7R2" },
    "dueOn": "2026-11-27",
    "via": "phone"
  }
}
```

Headers: `Reading-Joey-Event`, `Reading-Joey-Delivery` (the message id; a
retry repeats it, so ignore ids you've seen), `Reading-Joey-Signature`, and
`User-Agent: ReadingJoey-Webhook/1`. After retries, messages can arrive out
of order: use `createdAt`.

### Checking the signature

`Reading-Joey-Signature: t=<unix seconds>,v1=<hex>`, where `<hex>` is the
HMAC-SHA256 of `<t>.<raw body>` with the library's secret code (the whole
string, `whsec_` included). Use the body exactly as received, before parsing
it. Check it, and refuse messages more than five minutes old:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function genuine(rawBody, header, secret) {
  if (!header) return false;
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!t || !v1) return false;
  // Also false for a time that isn't a number.
  if (!(Math.abs(Date.now() / 1000 - Number(t)) <= 300)) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"),
  );
  const given = Buffer.from(v1);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Answer with any 2xx status within five seconds. Redirects aren't followed.
Anything else, or no answer, is retried with the hourly job (after 1, 2, 4, 8 and 16 hours), then given
up. The admin's Settings page lists the latest messages and how they went.
