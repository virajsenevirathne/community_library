import { defaultSettings, isValidTimezone, mergeSettings, slugify } from "@community-library/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorFor } from "../access.ts";
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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), `${label} must be on one line.`);

/** Shortest SETUP_CODE accepted on a real deployment, so it cannot be guessed. */
const MIN_SETUP_CODE = 16;

const setupBody = z.object({
  setupCode: z.string().max(200).optional(),
  libraryName: name("Library name", 80),
  timezone: z.string().refine(isValidTimezone, "Choose a timezone from the list."),
  familyName: name("Family name", 60).optional(),
  /** Asked at setup: should staff check returned books in? */
  returnsNeedCheckIn: z.boolean().optional(),
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
    const anyLibrary = await c.env.DB.prepare("select 1 from libraries limit 1").first();
    const setupNeeded = !anyLibrary;
    // A library's name is shown only to its members, so addresses can't be
    // tried one by one to list the centres on the site.
    if (!user) return c.json({ user: null, library: null, libraries: [], setupNeeded });
    const [actor, passkeyCount, libraries] = await Promise.all([
      actorFor(c),
      db.$count(schema.passkeys, eq(schema.passkeys.userId, user.id)),
      c.env.DB.prepare(
        `select l.slug as slug, l.name as name, m.role as role
         from memberships m join libraries l on l.id = m.library_id
         where m.user_id = ? order by l.name`,
      )
        .bind(user.id)
        .all<{ slug: string; name: string; role: "admin" | "staff" | "member" }>(),
    ]);
    return c.json({
      user: { id: user.id, email: user.email, name: user.name, hasPasskey: passkeyCount > 0 },
      library: actor && library ? { name: library.name, slug: library.slug } : null,
      libraries: libraries.results,
      setupNeeded,
      // Only matters before setup: whether the setup form must ask for the code.
      setupCodeRequired: setupNeeded && Boolean(secrets(c.env).SETUP_CODE),
      membership: actor ? { role: actor.role, family: actor.family } : null,
    });
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

    const merged = mergeSettings(defaultSettings(), {
      timezone: body.timezone,
      ...(body.returnsNeedCheckIn === undefined
        ? {}
        : { returnsNeedCheckIn: body.returnsNeedCheckIn }),
    });
    if (!merged.ok) fail(422, "invalid_input", merged.errors[0]?.message ?? "Invalid timezone.");

    const libraryId = newId();
    const slug = slugify(body.libraryName);
    const familyId = body.familyName ? newId() : null;
    const DB = c.env.DB;
    const libraryExists = "exists (select 1 from libraries where id = ?)";
    const statements = [
      DB.prepare(
        "insert into libraries (id, name, slug, settings) select ?, ?, ?, ? where not exists (select 1 from libraries)",
      ).bind(libraryId, body.libraryName, slug, JSON.stringify(merged.settings)),
    ];
    if (familyId && body.familyName) {
      statements.push(
        DB.prepare(
          `insert into families (id, library_id, name) select ?, ?, ? where ${libraryExists}`,
        ).bind(familyId, libraryId, body.familyName, libraryId),
      );
    }
    statements.push(
      DB.prepare(
        `insert into memberships (id, library_id, user_id, role, family_id) select ?, ?, ?, 'admin', ? where ${libraryExists}`,
      ).bind(newId(), libraryId, user.id, familyId, libraryId),
      DB.prepare(
        `insert into events (id, library_id, actor_user_id, type) select ?, ?, ?, 'library_created' where ${libraryExists}`,
      ).bind(newId(), libraryId, user.id, libraryId),
    );
    // One batch is one transaction in D1: either all of it happens or none.
    const [created] = await DB.batch(statements);
    if (created?.meta.changes !== 1) {
      fail(409, "already_set_up", "This library has already been set up.");
    }
    return c.json({ ok: true, slug }, 201);
  });
