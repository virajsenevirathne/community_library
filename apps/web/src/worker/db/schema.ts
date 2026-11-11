import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/*
 * Two groups of tables share the database:
 *
 * - Sign-in tables (users, sessions, accounts, verifications, passkeys), in the
 *   shape Better Auth expects. JS keys are camelCase because Better Auth looks
 *   columns up by those names.
 * - Library tables. Everything a library owns carries library_id, and the
 *   access layer (src/worker/access.ts) adds that filter to every query,
 *   because D1 has no row-level security.
 *
 * Rows that point at another library-owned row use a composite foreign key
 * (id, library_id), so the database itself refuses a loan in library A for a
 * copy in library B. Loan history is never deleted with a copy or family: the
 * deletion code anonymises it first, and the foreign keys use NO ACTION so a
 * forgotten step fails loudly instead of silently removing history.
 *
 * Times are stored as Unix milliseconds. Due dates are calendar dates in the
 * library's timezone (YYYY-MM-DD), since "due Friday" means Friday at the centre.
 */

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

// ---------------------------------------------------------------- sign-in

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("passkeys_user_idx").on(t.userId),
    uniqueIndex("passkeys_credential_idx").on(t.credentialID),
  ],
);

// ---------------------------------------------------------------- library

const LOCAL_DATE_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";

/** SQL "column in ('a', 'b')" for a CHECK constraint on an enum column. */
function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);
}

export const libraries = sqliteTable(
  "libraries",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** JSON, see LibrarySettings in @community-library/core. */
    settings: text("settings").notNull().default("{}"),
    /** SHA-256 of the current sign-up link token. Replacing it kills old links. */
    joinTokenHash: text("join_token_hash"),
    createdAt: createdAt(),
  },
  () => [check("libraries_settings_json", sql`json_valid(settings)`)],
);

export const ROLES = ["admin", "staff", "member"] as const;
export type Role = (typeof ROLES)[number];

export const FAMILY_STATUSES = ["active", "pending", "deactivated"] as const;
export type FamilyStatus = (typeof FAMILY_STATUSES)[number];

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    /** What staff call the family, e.g. "Nguyen". Nothing about children is stored. */
    name: text("name").notNull(),
    /**
     * Kiosk PIN (kiosk mode is a later phase). Must be a salted slow hash
     * (PBKDF2 or scrypt) with attempt limits, because a 4-digit PIN is easy to
     * brute-force from a fast hash.
     */
    kioskPinHash: text("kiosk_pin_hash"),
    status: text("status", { enum: FAMILY_STATUSES }).notNull().default("active"),
    /** Set when a parent turns off reminder nudges. Checkout confirmations still go out. */
    nudgesOff: integer("nudges_off", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("families_library_idx").on(t.libraryId),
    uniqueIndex("families_id_library_idx").on(t.id, t.libraryId),
    check("families_status_check", oneOf("status", FAMILY_STATUSES)),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    /** Set for members; staff and admins may also belong to a family. */
    familyId: text("family_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memberships_library_user_idx").on(t.libraryId, t.userId),
    index("memberships_user_idx").on(t.userId),
    index("memberships_family_idx").on(t.familyId),
    foreignKey({
      name: "memberships_family_fk",
      columns: [t.familyId, t.libraryId],
      foreignColumns: [families.id, families.libraryId],
    }),
    check("memberships_role_check", oneOf("role", ROLES)),
  ],
);

export const titles = sqliteTable(
  "titles",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    isbn: text("isbn"),
    title: text("title").notNull(),
    authors: text("authors").notNull().default(""),
    coverUrl: text("cover_url"),
    createdAt: createdAt(),
  },
  (t) => [
    index("titles_library_idx").on(t.libraryId),
    // One title per ISBN in a library; more copies are added to it.
    uniqueIndex("titles_library_isbn_idx").on(t.libraryId, t.isbn).where(sql`isbn is not null`),
    uniqueIndex("titles_id_library_idx").on(t.id, t.libraryId),
  ],
);

export const COPY_STATUSES = ["available", "lost", "damaged", "retired"] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

export const copies = sqliteTable(
  "copies",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    titleId: text("title_id").notNull(),
    /** Printed under the QR code and used in its link (/c/K7R2). Unique across all libraries. */
    shortCode: text("short_code").notNull().unique(),
    /** "On loan" is not a status: it is worked out from the open loan. Retire, never delete. */
    status: text("status", { enum: COPY_STATUSES }).notNull().default("available"),
    shelf: text("shelf"),
    /** Staff note about this copy, such as "torn cover". */
    note: text("note"),
    /** Someone tapped "Found it" on a copy that was on loan. Staff confirm it. */
    foundAt: integer("found_at", { mode: "timestamp_ms" }),
    foundBy: text("found_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("copies_library_idx").on(t.libraryId),
    index("copies_title_idx").on(t.titleId),
    index("copies_found_by_idx").on(t.foundBy),
    uniqueIndex("copies_id_library_idx").on(t.id, t.libraryId),
    foreignKey({
      name: "copies_title_fk",
      columns: [t.titleId, t.libraryId],
      foreignColumns: [titles.id, titles.libraryId],
    }),
    check("copies_status_check", oneOf("status", COPY_STATUSES)),
  ],
);

export const LOAN_OUTCOMES = ["returned", "lost", "damaged", "found"] as const;
export type LoanOutcome = (typeof LOAN_OUTCOMES)[number];

export const loans = sqliteTable(
  "loans",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    copyId: text("copy_id").notNull(),
    /** Null once the family is deleted or history is anonymised; counts survive. */
    familyId: text("family_id"),
    borrowedBy: text("borrowed_by").references(() => users.id, { onDelete: "set null" }),
    borrowedAt: integer("borrowed_at", { mode: "timestamp_ms" }).notNull(),
    dueOn: text("due_on").notNull(),
    returnedAt: integer("returned_at", { mode: "timestamp_ms" }),
    returnedBy: text("returned_by").references(() => users.id, { onDelete: "set null" }),
    outcome: text("outcome", { enum: LOAN_OUTCOMES }),
    extendedCount: integer("extended_count").notNull().default(0),
  },
  (t) => [
    // At most one open loan per copy, enforced by the database.
    uniqueIndex("loans_one_open_per_copy_idx").on(t.copyId).where(sql`returned_at is null`),
    index("loans_copy_history_idx").on(t.copyId, t.borrowedAt),
    index("loans_family_open_idx").on(t.familyId, t.returnedAt),
    index("loans_library_open_idx").on(t.libraryId, t.returnedAt, t.dueOn),
    index("loans_borrowed_by_idx").on(t.borrowedBy),
    index("loans_returned_by_idx").on(t.returnedBy),
    foreignKey({
      name: "loans_copy_fk",
      columns: [t.copyId, t.libraryId],
      foreignColumns: [copies.id, copies.libraryId],
    }),
    foreignKey({
      name: "loans_family_fk",
      columns: [t.familyId, t.libraryId],
      foreignColumns: [families.id, families.libraryId],
    }),
    check("loans_outcome_check", sql`outcome is null or ${oneOf("outcome", LOAN_OUTCOMES)}`),
    check("loans_closed_check", sql`(returned_at is null) = (outcome is null)`),
    check("loans_due_on_check", sql.raw(`due_on glob '${LOCAL_DATE_GLOB}'`)),
    check("loans_extended_check", sql`extended_count >= 0`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    /** JSON. Never holds names or emails, so deletion only needs to clear actor ids. */
    payload: text("payload").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_library_idx").on(t.libraryId, t.createdAt),
    index("events_actor_idx").on(t.actorUserId),
    check("events_payload_json", sql`json_valid(payload)`),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    familyId: text("family_id").notNull(),
    /** Lowercased. Cleared when the invite is accepted or expires, so it is not kept. */
    email: text("email"),
    /** The API only lets staff invite members; only admins invite staff or admins. */
    role: text("role", { enum: ROLES }).notNull().default("member"),
    /** SHA-256 of the token in the invite link; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("invitations_library_idx").on(t.libraryId),
    index("invitations_email_idx").on(t.email),
    index("invitations_family_idx").on(t.familyId),
    foreignKey({
      name: "invitations_family_fk",
      columns: [t.familyId, t.libraryId],
      foreignColumns: [families.id, families.libraryId],
    }).onDelete("cascade"),
    check("invitations_role_check", oneOf("role", ROLES)),
  ],
);

export const NOTIFICATION_STATUSES = ["sent", "failed", "deferred"] as const;

/** One row per email the jobs send. The unique key stops a re-run sending twice. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    familyId: text("family_id").references(() => families.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: text("status", { enum: NOTIFICATION_STATUSES }).notNull(),
    provider: text("provider"),
    /** A short error code only, never the provider's message (it can contain the address). */
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_library_idx").on(t.libraryId, t.createdAt),
    index("notifications_family_idx").on(t.familyId),
    check("notifications_status_check", oneOf("status", NOTIFICATION_STATUSES)),
  ],
);

/** Emails sent per provider per UTC day, to stay inside free-plan limits. */
export const emailQuota = sqliteTable(
  "email_quota",
  {
    provider: text("provider").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.provider, t.day] })],
);

/** Last run of each scheduled job, so the dashboard can warn when one stops running. */
export const jobRuns = sqliteTable("job_runs", {
  name: text("name").primaryKey(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  error: text("error"),
});
