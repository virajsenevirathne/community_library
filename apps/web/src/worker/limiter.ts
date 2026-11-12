import { sha256Hex } from "./crypto.ts";

export interface LimitResult {
  allowed: boolean;
  /** Attempts in the current window, this one included. */
  count: number;
  /** Seconds until the window frees up, when not allowed. */
  retryAfter: number | null;
}

/**
 * Records one attempt against `key` and says whether it is within `max` per
 * `windowSeconds`. One SQL statement, so simultaneous requests cannot all slip
 * through. Keys are stored as a keyed hash, so the table never holds IP
 * addresses or email addresses.
 */
export async function consume(
  DB: D1Database,
  secret: string,
  key: string,
  rule: { window: number; max: number },
  now = Date.now(),
): Promise<LimitResult> {
  const hashed = await hashKey(secret, key);
  const windowStart = now - rule.window * 1000;
  const row = await DB.prepare(
    `insert into rate_limits (id, key, count, last_request) values (?1, ?1, 1, ?2)
     on conflict(key) do update set
       count = case when last_request <= ?3 then 1 else count + 1 end,
       last_request = case when last_request <= ?3 then ?2 else last_request end
     returning count, last_request`,
  )
    .bind(hashed, now, windowStart)
    .first<{ count: number; last_request: number }>();
  if (!row || row.count <= rule.max)
    return { allowed: true, count: row?.count ?? 1, retryAfter: null };
  return {
    allowed: false,
    count: row.count,
    retryAfter: Math.max(1, Math.ceil((row.last_request + rule.window * 1000 - now) / 1000)),
  };
}

/** The client's IP on Cloudflare, or a fixed value in local development and tests. */
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? "local";
}

const hashKey = (secret: string, key: string) => sha256Hex(`${secret}\u0000${key}`);

/** Gives back one attempt recorded by `consume` (for example, a code that turned out right). */
export async function refund(DB: D1Database, secret: string, key: string): Promise<void> {
  await DB.prepare("update rate_limits set count = count - 1 where key = ? and count > 0")
    .bind(await hashKey(secret, key))
    .run();
}

/** Starts (or restarts) a lock on `key` from `now`. See `lockedFor`. */
export async function lock(DB: D1Database, secret: string, key: string, now = Date.now()) {
  const hashed = await hashKey(secret, key);
  await DB.prepare(
    `insert into rate_limits (id, key, count, last_request) values (?1, ?1, 1, ?2)
     on conflict(key) do update set count = 1, last_request = ?2`,
  )
    .bind(hashed, now)
    .run();
}

/** Seconds left on a lock started by `lock` that lasts `seconds`, or null when not locked. */
export async function lockedFor(
  DB: D1Database,
  secret: string,
  key: string,
  seconds: number,
  now = Date.now(),
): Promise<number | null> {
  const row = await DB.prepare("select last_request from rate_limits where key = ?")
    .bind(await hashKey(secret, key))
    .first<{ last_request: number }>();
  const ends = row ? row.last_request + seconds * 1000 : 0;
  return ends > now ? Math.max(1, Math.ceil((ends - now) / 1000)) : null;
}

/** Clears `key` altogether: its count and any lock. */
export async function reset(DB: D1Database, secret: string, key: string): Promise<void> {
  await DB.prepare("delete from rate_limits where key = ?")
    .bind(await hashKey(secret, key))
    .run();
}
