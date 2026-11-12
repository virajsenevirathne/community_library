import { hmacHex } from "./crypto.ts";
import { newId } from "./db/client.ts";
import type { WebhookEvent } from "./db/schema.ts";

/*
 * Webhooks: a library can have its own address told when loans happen
 * (a spreadsheet script, a school's system). Each message is JSON, signed
 * with the library's secret, and holds no names or email addresses: only
 * the book, dates and ids. Failed deliveries are retried by the hourly job
 * for about a day.
 *
 * Signature header, like Stripe's:
 *   Reading-Joey-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 */

/** Tries per delivery: right away, then with the hourly job for about a day. */
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 5000;

/**
 * An https address on the public internet, written by name: never an IP
 * address, a local name, another port, or one with a password in it.
 */
export function isWebhookUrl(value: string, ownHost?: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return false;
  // IPv4 and IPv6 literals.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return false;
  // Never this site itself (a request loop), nor Cloudflare's own app domains.
  if (ownHost && (host === ownHost || host.endsWith(`.${ownHost}`))) return false;
  if (/(^|\.)(workers\.dev|pages\.dev)$/.test(host)) return false;
  return !/(^|\.)(localhost|localdomain|local|internal|intranet|corp|lan|home|arpa|test|invalid|example)$/.test(
    host,
  );
}

interface Hook {
  url: string;
  secret: string;
  events: string;
}

async function hookFor(DB: D1Database, libraryId: string, event: WebhookEvent) {
  const hook = await DB.prepare(
    "select url, secret, events from library_webhooks where library_id = ?",
  )
    .bind(libraryId)
    .first<Hook>();
  if (!hook) return null;
  let events: unknown;
  try {
    events = JSON.parse(hook.events);
  } catch {
    events = [];
  }
  return Array.isArray(events) && events.includes(event) ? hook : null;
}

/** The signature header value for a body. */
export async function signature(secret: string, body: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** Sends one delivery and records the answer. True when the receiver took it. */
async function deliver(
  DB: D1Database,
  hook: Pick<Hook, "url" | "secret">,
  delivery: { id: string; event: string; body: string; attempts: number },
  fetchImpl: typeof fetch,
): Promise<boolean> {
  let status = 0;
  if (isWebhookUrl(hook.url)) {
    try {
      const res = await fetchImpl(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ReadingJoey-Webhook/1",
          "Reading-Joey-Event": delivery.event,
          "Reading-Joey-Delivery": delivery.id,
          "Reading-Joey-Signature": await signature(hook.secret, delivery.body),
        },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      status = 0;
    }
  }
  const ok = status >= 200 && status < 300;
  const attempts = delivery.attempts + 1;
  // Back off: 1, 2, 4, 8, 16 hours (the hourly job picks them up).
  const next = Date.now() + 2 ** (attempts - 1) * 3_600_000;
  await DB.prepare(
    `update webhook_deliveries set status = ?, attempts = ?, last_status = ?, next_attempt_at = ?
     where id = ?`,
  )
    .bind(
      ok ? "sent" : attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      attempts,
      status,
      ok ? null : next,
      delivery.id,
    )
    .run();
  return ok;
}

export interface WebhookDeps {
  DB: D1Database;
  /** Keeps the delivery running after the response has gone. */
  waitUntil?: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch | undefined;
}

/**
 * Tells the library's webhook about something, when it has one that wants
 * this event. The message is recorded first, so a failed send is retried.
 */
export async function emitWebhook(
  deps: WebhookDeps,
  library: { id: string; slug: string },
  event: WebhookEvent,
  data: Record<string, unknown>,
  /** Only record it; the hourly job's retry pass sends it. */
  queueOnly = false,
): Promise<void> {
  // Telling a library's system is never worth failing the borrow or return itself.
  try {
    await emit(deps, library, event, data, queueOnly);
  } catch (error) {
    console.error("Webhook not recorded:", error);
  }
}

async function emit(
  deps: WebhookDeps,
  library: { id: string; slug: string },
  event: WebhookEvent,
  data: Record<string, unknown>,
  queueOnly: boolean,
) {
  const hook = await hookFor(deps.DB, library.id, event);
  if (!hook) return;
  const id = newId();
  const body = JSON.stringify({
    id,
    type: event,
    createdAt: new Date().toISOString(),
    library: library.slug,
    data,
  });
  // Due again in 10 minutes, in case this Worker stops before sending: the
  // hourly job then picks it up. A queued one is due straight away.
  await deps.DB.prepare(
    "insert into webhook_deliveries (id, library_id, event, body, next_attempt_at) values (?, ?, ?, ?, ?)",
  )
    .bind(id, library.id, event, body, Date.now() + (queueOnly ? 0 : 10 * 60_000))
    .run();
  if (queueOnly) return;
  const send = deliver(deps.DB, hook, { id, event, body, attempts: 0 }, deps.fetch ?? fetch);
  if (deps.waitUntil) deps.waitUntil(send.catch((e) => console.error("Webhook failed:", e)));
  else await send;
}

/** Sends a test message now ("ping"), whatever events are chosen. */
export async function pingWebhook(
  deps: WebhookDeps,
  library: { id: string; slug: string },
): Promise<{ ok: boolean; status: number }> {
  const hook = await deps.DB.prepare(
    "select url, secret, events from library_webhooks where library_id = ?",
  )
    .bind(library.id)
    .first<Hook>();
  if (!hook) return { ok: false, status: 0 };
  const id = newId();
  const body = JSON.stringify({
    id,
    type: "ping",
    createdAt: new Date().toISOString(),
    library: library.slug,
    data: {},
  });
  await deps.DB.prepare(
    "insert into webhook_deliveries (id, library_id, event, body, attempts) values (?, ?, 'ping', ?, ?)",
  )
    // A test is tried once.
    .bind(id, library.id, body, MAX_ATTEMPTS - 1)
    .run();
  const ok = await deliver(
    deps.DB,
    hook,
    { id, event: "ping", body, attempts: MAX_ATTEMPTS - 1 },
    deps.fetch ?? fetch,
  );
  const row = await deps.DB.prepare(
    "select last_status as status from webhook_deliveries where id = ?",
  )
    .bind(id)
    .first<{ status: number }>();
  return { ok, status: row?.status ?? 0 };
}

/** The hourly job: tries again the deliveries that are due, oldest first. */
export async function retryWebhooks(deps: WebhookDeps, libraryId: string, limit = 50) {
  const hook = await deps.DB.prepare(
    "select url, secret, events from library_webhooks where library_id = ?",
  )
    .bind(libraryId)
    .first<Hook>();
  if (!hook) return 0;
  const { results } = await deps.DB.prepare(
    `select id, event, body, attempts from webhook_deliveries
     where library_id = ? and status = 'pending' and next_attempt_at is not null and next_attempt_at <= ?
     order by created_at limit ?`,
  )
    .bind(libraryId, Date.now(), limit)
    .all<{ id: string; event: string; body: string; attempts: number }>();
  let sent = 0;
  // Ten at a time, so a slow address can't hold up the whole hourly job.
  for (let i = 0; i < results.length; i += 10) {
    const batch = await Promise.all(
      results
        .slice(i, i + 10)
        .map((d) => deliver(deps.DB, hook, d, deps.fetch ?? fetch).catch(() => false)),
    );
    sent += batch.filter(Boolean).length;
  }
  return sent;
}
