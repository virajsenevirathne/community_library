import { defaultSettings, type LibrarySettings } from "@community-library/core";
import type { Role } from "../db/schema.ts";
import { type createTestApp, TestClient } from "./client.ts";

/** Creates a library row directly, as setup would. Returns its id. */
export async function createLibrary(
  env: Env,
  options: {
    id?: string;
    name?: string;
    settings?: Partial<LibrarySettings>;
    /** False for a new library whose first admin hasn't finished setting it up. */
    setUp?: boolean;
  } = {},
): Promise<string> {
  const id = options.id ?? "lib-1";
  const settings = { ...defaultSettings(), ...options.settings };
  await ensureOwner(env);
  await env.DB.prepare(
    "insert into libraries (id, name, slug, settings, terms_accepted_at) values (?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      options.name ?? "Test Library",
      id,
      JSON.stringify(settings),
      options.setUp === false ? null : 1,
    )
    .run();
  return id;
}

/**
 * A site with libraries has an owner (who created them). Without one, the
 * server treats the site as not set up yet and lets anyone get a sign-in code.
 */
export async function ensureOwner(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "insert into users (id, name, email, email_verified, updated_at) values ('site-owner', '', 'site-owner@example.com', 1, 0) on conflict do nothing",
    ),
    env.DB.prepare(
      "insert into platform_admins (user_id) select 'site-owner' where not exists (select 1 from platform_admins)",
    ),
  ]);
}

let counter = 0;

/**
 * A person with a role in a library, signed in and ready to make requests.
 * Members get their own family unless `familyId` is given (to share one).
 */
export async function person(
  ctx: ReturnType<typeof createTestApp>,
  options: {
    role: Role | "none";
    libraryId?: string;
    email?: string;
    familyId?: string | null;
    familyName?: string;
    familyStatus?: "active" | "pending" | "deactivated";
  },
): Promise<TestClient & { userId: string; familyId: string | null }> {
  counter += 1;
  const libraryId = options.libraryId ?? "lib-1";
  const email = options.email ?? `person${counter}@example.com`;
  const userId = `user-${counter}`;
  const { DB } = ctx.env;
  await DB.prepare(
    "insert into users (id, name, email, email_verified, updated_at) values (?, '', ?, 1, 0)",
  )
    .bind(userId, email)
    .run();

  let familyId: string | null = options.familyId === undefined ? null : options.familyId;
  if (options.role !== "none") {
    if (options.familyId === undefined && options.role === "member") {
      familyId = `family-${counter}`;
      await DB.prepare("insert into families (id, library_id, name, status) values (?, ?, ?, ?)")
        .bind(
          familyId,
          libraryId,
          options.familyName ?? `Family ${counter}`,
          options.familyStatus ?? "active",
        )
        .run();
    }
    await DB.prepare(
      "insert into memberships (id, library_id, user_id, role, family_id) values (?, ?, ?, ?, ?)",
    )
      .bind(`membership-${counter}`, libraryId, userId, options.role, familyId)
      .run();
  }

  const client = new TestClient(ctx, email);
  // Test libraries use their id as their slug, so the person browses their own library.
  client.library = libraryId;
  await client.signIn();
  return Object.assign(client, { userId, familyId });
}
