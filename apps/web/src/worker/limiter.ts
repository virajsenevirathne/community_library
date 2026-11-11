import { sha256Hex } from "./crypto.ts";

export interface LimitResult {
  allowed: boolean;
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
  const hashed = await sha256Hex(`${secret}\u0000${key}`);
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
  if (!row || row.count <= rule.max) return { allowed: true, retryAfter: null };
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((row.last_request + rule.window * 1000 - now) / 1000)),
  };
}

/** The client's IP on Cloudflare, or a fixed value in local development and tests. */
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? "local";
}
