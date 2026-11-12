import {
  defaultSettings,
  isLibrarySlug,
  isValidTimezone,
  mergeSettings,
  slugify,
} from "@community-library/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireOwner } from "../access.ts";
import { isLocalHost, secrets } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { newId } from "../db/client.ts";
import { emailStatus } from "../email.ts";
import { libraryById } from "../library.ts";
import type { QuotaMailer } from "../mailer.ts";
import { name } from "./account.ts";
import { assertInviteBudget, emailField, event, sendInvite } from "./families.ts";

/*
 * The owner area: the person who runs the site creates libraries, invites
 * each one's first admin, renames and pauses them. Nobody else can create a
 * library.
 */

const createBody = z.object({
  name: name("Library name", 80),
  /** Optional: made from the name when left out. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isLibrarySlug, "Use lowercase letters, numbers and dashes, like little-owls.")
    .optional(),
  timezone: z.string().refine(isValidTimezone, "Choose a timezone from the list."),
  adminEmail: emailField,
});

const updateBody = z.object({
  name: name("Library name", 80).optional(),
  status: z.enum(["active", "paused"], { error: "Choose active or paused." }).optional(),
});

/** A free slug: the one asked for, or the name's, with -2, -3… added if taken. */
async function freeSlug(c: AppContext, wanted: string | undefined, libraryName: string) {
  const base = wanted ?? slugify(libraryName);
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 44)}-${n}`;
    const taken = await c.env.DB.prepare("select 1 from libraries where slug = ?")
      .bind(slug)
      .first();
    if (!taken) return slug;
    if (wanted) fail(409, "slug_taken", "That address is already used by another library.");
  }
  fail(409, "slug_taken", "Choose a different address for this library.");
}

/** Creates an admin invite for a library and emails it. */
async function inviteAdmin(c: AppContext, libraryId: string, email: string, ownerId: string) {
  const library = await libraryById(c.get("db"), libraryId);
  if (!library) fail(404, "not_found", "That library was not found.");
  await assertInviteBudget(c, library.id, ownerId);
  const DB = c.env.DB;
  const id = newId();
  await DB.batch([
    DB.prepare(
      "insert into invitations (id, library_id, family_id, email, role, token_hash, expires_at) values (?, ?, null, ?, 'admin', ?, 0)",
    ).bind(id, library.id, email, `unsent:${id}`),
    event(DB, library.id, ownerId, "invite_created", { role: "admin", byOwner: true }),
  ]);
  return sendInvite(
    { env: c.env, email: c.get("email") as QuotaMailer, origin: c.get("origin") },
    { id, email, role: "admin", familyName: null, firstAdmin: !library.setUp },
    library,
    "urgent",
  );
}

/**
 * What the site still needs, for its owner: each item is a setting that only
 * whoever runs the deployment can change (secrets and wrangler.jsonc). Says
 * only whether each is set, never a value.
 */
function siteChecklist(env: Env, requestUrl: string) {
  const s = secrets(env);
  const appUrl = env.APP_URL?.trim() ?? "";
  const host = new URL(requestUrl).hostname;
  return [
    {
      id: "email",
      done: Boolean(s.RESEND_API_KEY || (s.MAILJET_API_KEY && s.MAILJET_API_SECRET)),
      label: "Email can be sent",
      fix: "Set RESEND_API_KEY (and optionally MAILJET_API_KEY and MAILJET_API_SECRET as a backup).",
    },
    {
      id: "both-email",
      done: Boolean(s.RESEND_API_KEY && s.MAILJET_API_KEY && s.MAILJET_API_SECRET),
      label: "A second email service, in case the first is down",
      fix: "Set MAILJET_API_KEY and MAILJET_API_SECRET.",
      optional: true,
    },
    {
      id: "app-url",
      // Local development uses whatever address it's opened on.
      done:
        isLocalHost(host) || (appUrl.startsWith("https://") && new URL(appUrl).hostname === host),
      label: "The site's address is set (passkeys depend on it)",
      fix: `Set APP_URL in wrangler.jsonc to https://${host}.`,
    },
    {
      id: "push",
      done: Boolean(s.VAPID_PUBLIC_KEY && s.VAPID_PRIVATE_KEY),
      label: "Phone notifications",
      fix: "Run npm run vapid-keys, then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.",
      optional: true,
    },
    {
      id: "contact",
      done: Boolean(env.CONTACT_EMAIL?.trim()),
      label: "A contact address on the front page",
      fix: "Set CONTACT_EMAIL in wrangler.jsonc.",
      optional: true,
    },
  ];
}

export const ownerRoutes = new Hono<AppEnv>()
  /** Every library on the site, with enough to see how each is doing. */
  .get("/libraries", async (c) => {
    await requireOwner(c);
    const { results } = await c.env.DB.prepare(
      `select l.id as id, l.name as name, l.slug as slug, l.status as status, l.plan as plan,
              l.terms_accepted_at is not null as setUp,
              (select count(*) from families f where f.library_id = l.id) as families,
              (select count(*) from titles t where t.library_id = l.id) as titles,
              (select count(*) from loans o where o.library_id = l.id and o.returned_at is null) as loansOut,
              (select count(*) from memberships m where m.library_id = l.id and m.role = 'admin') as admins,
              (select i.email from invitations i
                 where i.library_id = l.id and i.role = 'admin' and i.accepted_at is null and i.email is not null
                 order by i.created_at desc limit 1) as pendingAdmin,
              (select max(e.created_at) from events e
                 where e.library_id = l.id and e.type != 'owner_access') as lastActivity
       from libraries l order by l.name collate nocase`,
    ).all<{
      id: string;
      name: string;
      slug: string;
      status: "active" | "paused";
      plan: string;
      setUp: number;
      families: number;
      titles: number;
      loansOut: number;
      admins: number;
      pendingAdmin: string | null;
      lastActivity: number | null;
    }>();
    return c.json({
      libraries: results.map((l) => ({ ...l, setUp: l.setUp === 1 })),
      // Shown to the owner only: whether the site can send email at all.
      email: emailStatus(c.env),
      checklist: siteChecklist(c.env, c.req.url),
    });
  })

  /** Create a library and invite its first admin, who finishes setting it up. */
  .post("/libraries", async (c) => {
    const { userId } = await requireOwner(c);
    const body = await readBody(c, createBody);
    const merged = mergeSettings(defaultSettings(), { timezone: body.timezone });
    if (!merged.ok) fail(422, "invalid_input", merged.errors[0]?.message ?? "Invalid timezone.");
    const slug = await freeSlug(c, body.slug, body.name);
    const id = newId();
    const DB = c.env.DB;
    try {
      await DB.batch([
        DB.prepare("insert into libraries (id, name, slug, settings) values (?, ?, ?, ?)").bind(
          id,
          body.name,
          slug,
          JSON.stringify(merged.settings),
        ),
        event(DB, id, userId, "library_created", { byOwner: true }),
      ]);
    } catch (error) {
      // Two owners creating the same address at once: the unique index decides.
      if (String(error).includes("UNIQUE")) {
        fail(409, "slug_taken", "That address is already used by another library.");
      }
      throw error;
    }
    const sent = await inviteAdmin(c, id, body.adminEmail, userId);
    return c.json({ library: { id, slug, name: body.name }, inviteSent: sent }, 201);
  })

  /** Rename, pause or reopen a library. Its address never changes, so printed links keep working. */
  .patch("/libraries/:id", async (c) => {
    const { userId } = await requireOwner(c);
    const body = await readBody(c, updateBody);
    const library = await libraryById(c.get("db"), c.req.param("id"));
    if (!library) fail(404, "not_found", "That library was not found.");
    const DB = c.env.DB;
    const statements: D1PreparedStatement[] = [];
    if (body.name !== undefined && body.name !== library.name) {
      statements.push(
        DB.prepare("update libraries set name = ? where id = ?").bind(body.name, library.id),
        event(DB, library.id, userId, "library_renamed", {}),
      );
    }
    if (body.status !== undefined && body.status !== library.status) {
      statements.push(
        DB.prepare("update libraries set status = ? where id = ?").bind(body.status, library.id),
        event(
          DB,
          library.id,
          userId,
          body.status === "paused" ? "library_paused" : "library_reopened",
          {},
        ),
      );
    }
    if (statements.length > 0) await DB.batch(statements);
    return c.json({ ok: true });
  })

  /** Invite an admin to a library: a replacement, or a resend for a new library. */
  .post("/libraries/:id/admin-invite", async (c) => {
    const { userId } = await requireOwner(c);
    const body = await readBody(c, z.object({ email: emailField }));
    const sent = await inviteAdmin(c, c.req.param("id"), body.email, userId);
    return c.json({ sent }, 201);
  });
