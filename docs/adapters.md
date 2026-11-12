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

An admin can give a library one webhook in **Settings › Webhooks**: an https
address that's told about loans as they happen. Messages never hold names or
email addresses.

Events: `loan.created`, `loan.returned` (also lost or damaged, see
`data.outcome`), `loan.overdue` (once per loan), `account.deleted`, and `ping`
(the Send a test button).

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
retry repeats it, so ignore ids you've seen) and `Reading-Joey-Signature`.

### Checking the signature

`Reading-Joey-Signature: t=<unix seconds>,v1=<hex>`, where `<hex>` is the
HMAC-SHA256 of `<t>.<raw body>` with the library's signing secret. Check it,
and refuse messages more than five minutes old:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function genuine(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Answer with any 2xx status within five seconds. Anything else, or no answer,
is retried with the hourly job (after 1, 2, 4, 8 and 16 hours), then given
up. The admin's Settings page lists the latest messages and how they went.
