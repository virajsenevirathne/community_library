import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppEnv, fail, readBody } from "../context.ts";
import { randomToken } from "../crypto.ts";
import { WEBHOOK_EVENTS } from "../db/schema.ts";
import { consume } from "../limiter.ts";
import { isWebhookUrl, pingWebhook } from "../webhooks.ts";
import { event } from "./families.ts";

/*
 * Settings › Webhooks (admins): one address per library, the events it
 * wants, its signing secret, and the last deliveries.
 */

const webhookBody = z.object({
  url: z
    .string({ error: "Enter the address to send to." })
    .trim()
    .max(500)
    .refine(
      isWebhookUrl,
      "Use an https address on the internet, by name (not an IP address or a local name).",
    ),
  events: z
    .array(z.enum(WEBHOOK_EVENTS), { error: "Choose at least one event." })
    .min(1, "Choose at least one event.")
    .max(WEBHOOK_EVENTS.length),
});

export const webhookRoutes = new Hono<AppEnv>()
  /** The library's webhook, if any, and its 20 latest deliveries. */
  .get("/admin/webhook", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const DB = c.env.DB;
    const [hook, recent] = await Promise.all([
      DB.prepare("select url, secret, events from library_webhooks where library_id = ?")
        .bind(actor.library.id)
        .first<{ url: string; secret: string; events: string }>(),
      DB.prepare(
        `select id, event, status, attempts, last_status as lastStatus, created_at as createdAt
         from webhook_deliveries where library_id = ? order by created_at desc limit 20`,
      )
        .bind(actor.library.id)
        .all<{
          id: string;
          event: string;
          status: string;
          attempts: number;
          lastStatus: number | null;
          createdAt: number;
        }>(),
    ]);
    return c.json({
      events: WEBHOOK_EVENTS,
      webhook: hook
        ? {
            url: hook.url,
            // Only its ending, to recognise it: the whole secret is shown once, when made.
            secretHint: `whsec_…${hook.secret.slice(-4)}`,
            events: JSON.parse(hook.events) as string[],
          }
        : null,
      recent: recent.results,
    });
  })

  /** Set the address and events. A new webhook gets a new secret. */
  .put("/admin/webhook", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(c, webhookBody);
    if (!isWebhookUrl(body.url, new URL(c.get("origin")).hostname)) {
      fail(422, "invalid_input", "That's this site's own address. Use your system's address.");
    }
    const url = new URL(body.url);
    const DB = c.env.DB;
    const secret = `whsec_${randomToken()}`;
    const existed = await DB.prepare("select 1 from library_webhooks where library_id = ?")
      .bind(actor.library.id)
      .first();
    await DB.batch([
      DB.prepare(
        `insert into library_webhooks (library_id, url, secret, events) values (?, ?, ?, ?)
         on conflict (library_id) do update set url = excluded.url, events = excluded.events`,
      ).bind(actor.library.id, url.href, secret, JSON.stringify(body.events)),
      event(DB, actor.library.id, actor.userId, "webhook_saved", {
        host: url.hostname,
        events: body.events,
      }),
    ]);
    // The secret is shown once, when it's made.
    return c.json(existed ? { ok: true } : { ok: true, secret });
  })

  /** A new signing secret, when the old one may have leaked. The old one stops working. */
  .post("/admin/webhook/secret", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const DB = c.env.DB;
    const secret = `whsec_${randomToken()}`;
    const [result] = await DB.batch([
      DB.prepare("update library_webhooks set secret = ? where library_id = ?").bind(
        secret,
        actor.library.id,
      ),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type, payload)
         select lower(hex(randomblob(16))), ?, ?, 'webhook_secret_replaced', '{}' where changes() = 1`,
      ).bind(actor.library.id, actor.userId),
    ]);
    if (result?.meta.changes !== 1) fail(404, "not_found", "There's no webhook set up.");
    return c.json({ ok: true, secret });
  })

  /** Stop sending, and forget the deliveries. */
  .delete("/admin/webhook", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare("delete from library_webhooks where library_id = ?").bind(actor.library.id),
      DB.prepare("delete from webhook_deliveries where library_id = ?").bind(actor.library.id),
      event(DB, actor.library.id, actor.userId, "webhook_removed", {}),
    ]);
    return c.json({ ok: true });
  })

  /** Send a test message ("ping") now, and say what the address answered. */
  .post("/admin/webhook/test", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const limit = await consume(c.env.DB, authSecret(c.env), `webhook-test:${actor.library.id}`, {
      window: 3600,
      max: 20,
    });
    if (!limit.allowed) fail(429, "too_many_tests", "That's a lot of tests. Try again in an hour.");
    const result = await pingWebhook({ DB: c.env.DB, fetch: c.get("fetch") }, actor.library);
    return c.json(result);
  });
