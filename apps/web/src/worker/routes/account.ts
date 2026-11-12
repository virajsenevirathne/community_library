import { isPushEndpoint } from "@community-library/adapters";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorFor, isPlatformOwner } from "../access.ts";
import { authSecret, isLocalHost, secrets } from "../config.ts";
import { type AppEnv, fail, readBody, requireUser } from "../context.ts";
import { sha256Hex, timingSafeEqual } from "../crypto.ts";
import { newId, schema } from "../db/client.ts";
import { clientIp, consume } from "../limiter.ts";

/** A short name typed by a person: trimmed, not empty, no line breaks or control characters. */
export const name = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      (v) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v),
      `${label} must be on one line.`,
    )
    // Invisible and text-direction characters could make one name look like another.
    .refine(
      (v) => !/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(v),
      `${label} has a character that can't be used.`,
    );

/** A person's first name: how staff and the rest of the family know them. */
export const firstNameField = name("First name", 40);

/** True when a browser's push key is a real P-256 point (else every send would fail). */
async function validBrowserKey(p256dh: string) {
  try {
    const raw = Uint8Array.from(atob(p256dh.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) =>
      ch.charCodeAt(0),
    );
    await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

/** Shortest SETUP_CODE accepted on a real deployment, so it cannot be guessed. */
const MIN_SETUP_CODE = 16;

const setupBody = z.object({
  setupCode: z.string().max(200).optional(),
});

export const accountRoutes = new Hono<AppEnv>()
  /**
   * Who is signed in, the libraries they belong to, their role in the library
   * this page belongs to (if any), and whether the site still needs setting up.
   */
  .get("/me", async (c) => {
    const db = c.get("db");
    const library = c.get("library");
    const user = c.get("user");
    // Setup is open while the site has no owner: to anyone on an empty site,
    // and only to an existing library's admin on a site that predates owners.
    const site = await c.env.DB.prepare(
      `select (select count(*) from platform_admins) as owners,
              (select count(*) from libraries) as libraries,
              (select count(*) from memberships where user_id = ? and role = 'admin') as adminOf`,
    )
      .bind(c.get("user")?.id ?? "")
      .first<{ owners: number; libraries: number; adminOf: number }>();
    const setupNeeded =
      (site?.owners ?? 0) === 0 && ((site?.libraries ?? 0) === 0 || (site?.adminOf ?? 0) > 0);
    // A library's name is shown only to its members, so addresses can't be
    // tried one by one to list the centres on the site.
    const siteName = c.env.LIBRARY_NAME;
    const contactEmail =
      (c.env as unknown as { CONTACT_EMAIL?: string }).CONTACT_EMAIL?.trim() || null;
    if (!user) {
      return c.json({
        user: null,
        library: null,
        libraries: [],
        setupNeeded,
        siteName,
        contactEmail,
      });
    }
    const [actor, passkeyCount, libraries, isOwner, notify] = await Promise.all([
      actorFor(c),
      db.$count(schema.passkeys, eq(schema.passkeys.userId, user.id)),
      c.env.DB.prepare(
        `select l.slug as slug, l.name as name, m.role as role
         from memberships m join libraries l on l.id = m.library_id
         where m.user_id = ? order by l.name`,
      )
        .bind(user.id)
        .all<{ slug: string; name: string; role: "admin" | "staff" | "member" }>(),
      isPlatformOwner(c),
      c.env.DB.prepare(
        `select notify_by as notifyBy,
                (select count(*) from push_subscriptions where user_id = users.id) as devices
         from users where id = ?`,
      )
        .bind(user.id)
        .first<{ notifyBy: "email" | "push" | "both"; devices: number }>(),
    ]);
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        hasPasskey: passkeyCount > 0,
        notifyBy: notify?.notifyBy ?? "email",
        pushDevices: notify?.devices ?? 0,
      },
      /** The site's web push key, or null when phone notifications are off. */
      pushKey: secrets(c.env).VAPID_PUBLIC_KEY ?? null,
      library:
        actor && library
          ? {
              name: library.name,
              slug: library.slug,
              status: library.status,
              setUp: library.setUp,
              support: actor.support === true,
              theme: library.settings.theme,
            }
          : null,
      libraries: libraries.results,
      owner: isOwner,
      siteName,
      contactEmail,
      setupNeeded,
      // Only matters before setup: whether the setup form must ask for the code.
      setupCodeRequired: setupNeeded && Boolean(secrets(c.env).SETUP_CODE),
      membership: actor ? { role: actor.role, family: actor.family } : null,
    });
  })

  /** Change your first name. It's shown to your family and your library's staff. */
  .put("/account/name", async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, z.object({ firstName: firstNameField }));
    await c.env.DB.prepare("update users set name = ?, updated_at = ? where id = ?")
      .bind(body.firstName, Date.now(), user.id)
      .run();
    return c.json({ firstName: body.firstName });
  })

  /** How you get reminders: email, phone notifications, or both. */
  .put("/account/notify-by", async (c) => {
    const user = requireUser(c);
    const body = await readBody(
      c,
      z.object({
        notifyBy: z.enum(["email", "push", "both"], { error: "Choose how to be reminded." }),
      }),
    );
    if (body.notifyBy !== "email") {
      const devices = await c.env.DB.prepare(
        "select count(*) as n from push_subscriptions where user_id = ?",
      )
        .bind(user.id)
        .first<number>("n");
      if (!devices) {
        fail(409, "no_device", "Turn on notifications on your phone first, then choose this.");
      }
    }
    await c.env.DB.prepare("update users set notify_by = ?, updated_at = ? where id = ?")
      .bind(body.notifyBy, Date.now(), user.id)
      .run();
    return c.json({ notifyBy: body.notifyBy });
  })

  /**
   * This browser may show your reminders (web push). Only addresses at the
   * known push services are accepted: the server sends messages there.
   */
  .post("/push/subscriptions", async (c) => {
    const user = requireUser(c);
    if (!c.get("push")) fail(503, "push_off", "Phone notifications aren't set up on this site.");
    const body = await readBody(
      c,
      z.object({
        endpoint: z.string().max(1000).refine(isPushEndpoint, "That isn't a push service address."),
        keys: z.object({
          // A P-256 public key (65 bytes) and a 16-byte secret, base64url.
          p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/, "That browser key isn't valid."),
          auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/, "That browser key isn't valid."),
        }),
      }),
    );
    const limit = await consume(c.env.DB, authSecret(c.env), `push-subscribe:${user.id}`, {
      window: 86_400,
      max: 20,
    });
    if (!limit.allowed) fail(429, "too_many_attempts", "Please try again tomorrow.");
    if (!(await validBrowserKey(body.keys.p256dh))) {
      fail(422, "invalid_input", "That browser key isn't valid.");
    }
    const DB = c.env.DB;
    const previous = await DB.prepare(
      "select user_id as userId from push_subscriptions where endpoint = ?",
    )
      .bind(body.endpoint)
      .first<{ userId: string }>();
    await DB.batch([
      // The same browser again (or now for someone else on a shared device): it's this person's now.
      DB.prepare(
        `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values (?, ?, ?, ?, ?)
         on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth`,
      ).bind(newId(), user.id, body.endpoint, body.keys.p256dh, body.keys.auth),
      // At most 10 devices each: the oldest go.
      DB.prepare(
        `delete from push_subscriptions where user_id = ?1 and id not in
           (select id from push_subscriptions where user_id = ?1 order by created_at desc limit 10)`,
      ).bind(user.id),
      // Turning notifications on means wanting them: email stays too, until changed.
      DB.prepare(
        "update users set notify_by = 'both', updated_at = ? where id = ? and notify_by = 'email'",
      ).bind(Date.now(), user.id),
      // The device was someone else's (a shared phone): with none left, their reminders go by email.
      DB.prepare(
        `update users set notify_by = 'email', updated_at = ? where id = ? and id != ?
           and not exists (select 1 from push_subscriptions where user_id = users.id)`,
      ).bind(Date.now(), previous?.userId ?? "", user.id),
    ]);
    return c.json({ ok: true }, 201);
  })

  /** This browser no longer shows your reminders. */
  .delete("/push/subscriptions", async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, z.object({ endpoint: z.string().max(1000) }));
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare("delete from push_subscriptions where user_id = ? and endpoint = ?").bind(
        user.id,
        body.endpoint,
      ),
      // No device left: reminders go by email.
      DB.prepare(
        `update users set notify_by = 'email', updated_at = ? where id = ?
           and not exists (select 1 from push_subscriptions where user_id = users.id)`,
      ).bind(Date.now(), user.id),
    ]);
    return c.json({ ok: true });
  })

  /** First run: the first person to sign in creates the library and becomes its admin. */
  .post("/setup", async (c) => {
    const user = requireUser(c);
    const secret = authSecret(c.env);
    const { SETUP_CODE } = secrets(c.env);
    // Few guesses per person and per network, so the setup code cannot be brute-forced.
    for (const key of [`setup:user:${user.id}`, `setup:ip:${clientIp(c.req.raw.headers)}`]) {
      const limit = await consume(c.env.DB, secret, key, { window: 3600, max: 10 });
      if (!limit.allowed) fail(429, "too_many_attempts", "Too many tries. Please wait an hour.");
    }
    const body = await readBody(c, setupBody);

    const expected = SETUP_CODE?.trim();
    const local = isLocalHost(new URL(c.req.url).hostname);
    if (expected && expected.length < MIN_SETUP_CODE && !local) {
      fail(
        503,
        "setup_code_too_short",
        `SETUP_CODE must be at least ${MIN_SETUP_CODE} characters.`,
      );
    }
    if (expected) {
      const [given, wanted] = await Promise.all([
        sha256Hex(body.setupCode?.trim() ?? ""),
        sha256Hex(expected),
      ]);
      if (!timingSafeEqual(given, wanted)) {
        fail(
          403,
          "wrong_setup_code",
          "That setup code is not right. It is in the deployment's settings.",
        );
      }
    } else if (!local) {
      fail(
        503,
        "setup_code_missing",
        "Set a SETUP_CODE secret on this deployment before setting up the library.",
      );
    }

    // The first person through becomes the site's owner. Libraries are then
    // created from the owner area, each with an invited admin.
    // On a site that already has libraries (set up before there were owners),
    // only one of their admins may take the owner's seat: the setup code alone
    // must not hand a stranger every library.
    const created = await c.env.DB.prepare(
      `insert into platform_admins (user_id)
       select ?1 where not exists (select 1 from platform_admins)
         and (not exists (select 1 from libraries)
              or exists (select 1 from memberships where user_id = ?1 and role = 'admin'))`,
    )
      .bind(user.id)
      .run();
    if (created.meta.changes !== 1) {
      fail(409, "already_set_up", "This site has already been set up.");
    }
    return c.json({ ok: true }, 201);
  });
