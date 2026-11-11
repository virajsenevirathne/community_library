import { isAllowedCoverUrl, type LookupResult, lookupIsbn } from "@community-library/adapters";
import { normalizeIsbn, randomShortCode } from "@community-library/core";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { z } from "zod";
import { type Actor, requirePermission, scope } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { type Db, newId, schema } from "../db/client.ts";
import { COPY_STATUSES } from "../db/schema.ts";
import { consume } from "../limiter.ts";
import { name } from "./account.ts";

const MAX_COPIES_AT_ONCE = 20;
const MAX_LABEL_IDS = 500;
/**
 * D1 allows at most 100 values in one SQL statement, so long id lists and
 * multi-row inserts are split into chunks.
 */
const IDS_PER_QUERY = 50;
const COPY_ROWS_PER_INSERT = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const isbnField = z
  .string()
  .trim()
  .max(20)
  .transform((value, ctx) => {
    if (value === "") return null;
    const isbn = normalizeIsbn(value);
    if (!isbn) {
      ctx.addIssue({
        code: "custom",
        message: "That ISBN does not look right. It is the 10 or 13 digits under the barcode.",
      });
      return z.NEVER;
    }
    return isbn;
  });

const coverField = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === "" || isAllowedCoverUrl(v),
    "Cover images can only come from Open Library or Google Books.",
  )
  .transform((v) => v || null);

const authorsField = z.string().trim().max(300, "Authors must be 300 characters or fewer.");

const copyCount = z
  .number({ error: "Enter how many copies." })
  .int("Enter a whole number of copies.")
  .min(1, "Add at least one copy.")
  .max(MAX_COPIES_AT_ONCE, `Add at most ${MAX_COPIES_AT_ONCE} copies at once.`);

const newTitleBody = z.object({
  isbn: isbnField.optional(),
  title: name("Title", 200),
  authors: authorsField.default(""),
  coverUrl: coverField.optional(),
  copies: copyCount.default(1),
});

const editTitleBody = z.object({
  title: name("Title", 200).optional(),
  authors: authorsField.optional(),
  coverUrl: coverField.optional(),
});

const editCopyBody = z.object({
  status: z.enum(COPY_STATUSES, { error: "Choose a status from the list." }).optional(),
  shelf: z.string().trim().max(60, "Shelf must be 60 characters or fewer.").optional(),
  note: z.string().trim().max(300, "Note must be 300 characters or fewer.").optional(),
  /** The sticker is damaged or missing: put the copy back on the "needs a label" list. */
  needsLabel: z.literal(true).optional(),
});

const idList = z.array(z.string().max(64)).min(1).max(MAX_LABEL_IDS);

function isShortCodeClash(error: unknown): boolean {
  return /UNIQUE/.test(String(error)) && /short_code/.test(String(error));
}

function isIsbnClash(error: unknown): boolean {
  return /UNIQUE/.test(String(error)) && /isbn/.test(String(error));
}

/** Insert statements for `count` new copies, in chunks D1 accepts. */
function copyInserts(db: Db, actor: Actor, titleId: string, count: number) {
  const s = scope(actor);
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomShortCode());
  const rows = [...codes].map((shortCode) => s.values({ id: newId(), titleId, shortCode }));
  const statements = chunk(rows, COPY_ROWS_PER_INSERT).map((part) =>
    db.insert(schema.copies).values(part),
  );
  return { rows, statements };
}

function eventInsert(db: Db, actor: Actor, type: string, payload: Record<string, unknown>) {
  return db.insert(schema.events).values(
    scope(actor).values({
      id: newId(),
      actorUserId: actor.userId,
      type,
      payload: JSON.stringify(payload),
    }),
  );
}

/**
 * Runs statements in one D1 batch (all or nothing). The batch is rebuilt on
 * a short-code clash, so new codes are drawn; that is very rare.
 */
async function withFreshCodes<T>(
  build: () => { result: T; statements: BatchItem<"sqlite">[] },
  db: Db,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { result, statements } = build();
    try {
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      return result;
    } catch (error) {
      if (!isShortCodeClash(error)) throw error;
    }
  }
  fail(409, "code_clash", "Could not create unique codes. Please try again.");
}

/** "On loan" is worked out from the open loan, never stored. */
function copyState(status: string, onLoan: boolean) {
  if (onLoan && status === "available") return "on_loan";
  return status;
}

async function titleWithCopies(db: Db, actor: Actor, titleId: string) {
  const s = scope(actor);
  const title = await db.query.titles.findFirst({
    where: s.where(schema.titles, eq(schema.titles.id, titleId)),
  });
  if (!title) fail(404, "not_found", "That book is not in the catalog.");
  const copies = await db
    .select({
      id: schema.copies.id,
      shortCode: schema.copies.shortCode,
      status: schema.copies.status,
      shelf: schema.copies.shelf,
      note: schema.copies.note,
      labelPrintedAt: schema.copies.labelPrintedAt,
      foundAt: schema.copies.foundAt,
      loanId: schema.loans.id,
      dueOn: schema.loans.dueOn,
    })
    .from(schema.copies)
    .leftJoin(
      schema.loans,
      and(
        eq(schema.loans.copyId, schema.copies.id),
        eq(schema.loans.libraryId, schema.copies.libraryId),
        isNull(schema.loans.returnedAt),
      ),
    )
    .where(s.where(schema.copies, eq(schema.copies.titleId, titleId)))
    .orderBy(asc(schema.copies.createdAt))
    .all();
  return {
    id: title.id,
    isbn: title.isbn,
    title: title.title,
    authors: title.authors,
    coverUrl: title.coverUrl,
    copies: copies.map((copy) => ({
      id: copy.id,
      shortCode: copy.shortCode,
      status: copyState(copy.status, copy.loanId !== null),
      onLoan: copy.loanId !== null,
      shelf: copy.shelf,
      note: copy.note,
      dueOn: copy.dueOn,
      labelPrinted: copy.labelPrintedAt !== null,
      found: copy.foundAt !== null,
    })),
  };
}

/**
 * Looks an ISBN up online, at most 60 times a minute per person. A found book
 * is kept for a day and a definite "not found" for six hours, so repeat scans
 * are instant. A lookup that failed (a service down or rate-limited) is never
 * kept, so the next scan tries again.
 */
async function lookupOnline(c: AppContext, actor: Actor, isbn: string): Promise<LookupResult> {
  const cacheKey = new Request(`https://isbn-cache.internal/v2/${isbn}`);
  const cache =
    typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) return (await cached.json()) as LookupResult;

  const limit = await consume(c.env.DB, authSecret(c.env), `isbn-lookup:${actor.userId}`, {
    window: 60,
    max: 60,
  });
  if (!limit.allowed)
    fail(429, "too_many_lookups", "That's a lot of lookups. Please wait a minute.");

  const result = await lookupIsbn(c.get("metadata"), isbn);
  if (!result.unavailable) {
    const maxAge = result.book ? 86_400 : 6 * 3600;
    await cache
      ?.put(
        cacheKey,
        new Response(JSON.stringify(result), {
          headers: { "Cache-Control": `max-age=${maxAge}` },
        }),
      )
      .catch(() => undefined);
  }
  return result;
}

export const catalogRoutes = new Hono<AppEnv>()
  /** Book details for an ISBN: from this library's catalog if it is already there, else online. */
  .get("/lookup/:isbn", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const isbn = normalizeIsbn(c.req.param("isbn"));
    if (!isbn) {
      fail(
        422,
        "invalid_isbn",
        "That ISBN does not look right. It is the 10 or 13 digits under the barcode.",
      );
    }
    const db = c.get("db");
    const s = scope(actor);
    const existing = await db.query.titles.findFirst({
      columns: { id: true, title: true, authors: true, coverUrl: true },
      where: s.where(schema.titles, eq(schema.titles.isbn, isbn)),
    });
    if (existing) {
      const copies = await db.$count(
        schema.copies,
        s.where(schema.copies, eq(schema.copies.titleId, existing.id)),
      );
      return c.json({ isbn, found: true, existing: { ...existing, copies } });
    }
    const { book, unavailable } = await lookupOnline(c, actor, isbn);
    if (!book) return c.json({ isbn, found: false, unavailable });
    return c.json({
      isbn,
      found: true,
      title: book.title,
      authors: book.authors.join(", "),
      coverUrl: book.coverUrl,
      source: book.source,
    });
  })

  /** Titles in the catalog, with how many copies are in and out. Optional search. */
  .get("/titles", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const s = scope(actor);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const search = q
      ? or(
          sql`${schema.titles.title} like ${pattern} escape '\\'`,
          sql`${schema.titles.authors} like ${pattern} escape '\\'`,
          eq(schema.titles.isbn, normalizeIsbn(q) ?? q),
        )
      : undefined;
    const rows = await c
      .get("db")
      .select({
        id: schema.titles.id,
        title: schema.titles.title,
        authors: schema.titles.authors,
        coverUrl: schema.titles.coverUrl,
        copies: sql<number>`count(${schema.copies.id})`,
        onLoan: sql<number>`count(${schema.loans.id})`,
        needsLabel: sql<number>`coalesce(sum(case when ${schema.copies.id} is not null and ${schema.copies.labelPrintedAt} is null and ${schema.copies.status} != 'retired' then 1 else 0 end), 0)`,
      })
      .from(schema.titles)
      .leftJoin(
        schema.copies,
        and(
          eq(schema.copies.titleId, schema.titles.id),
          eq(schema.copies.libraryId, schema.titles.libraryId),
        ),
      )
      .leftJoin(
        schema.loans,
        and(
          eq(schema.loans.copyId, schema.copies.id),
          eq(schema.loans.libraryId, schema.copies.libraryId),
          isNull(schema.loans.returnedAt),
        ),
      )
      .where(s.where(schema.titles, search))
      .groupBy(schema.titles.id)
      .orderBy(desc(schema.titles.createdAt))
      .limit(200)
      .all();
    return c.json({ titles: rows });
  })

  /**
   * Add a book: a new title with its copies (saved together, all or nothing),
   * or more copies of the title with the same ISBN already in the catalog.
   */
  .post("/titles", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const body = await readBody(c, newTitleBody);
    const db = c.get("db");
    const s = scope(actor);
    const isbn = body.isbn ?? null;

    const existingId = async () =>
      isbn
        ? (
            await db.query.titles.findFirst({
              columns: { id: true },
              where: s.where(schema.titles, eq(schema.titles.isbn, isbn)),
            })
          )?.id
        : undefined;

    const addToExisting = async (titleId: string) => {
      await withFreshCodes(() => {
        const copies = copyInserts(db, actor, titleId, body.copies);
        return {
          result: copies.rows,
          statements: [
            ...copies.statements,
            eventInsert(db, actor, "copies_added", { titleId, copies: body.copies }),
          ],
        };
      }, db);
      return c.json({ title: await titleWithCopies(db, actor, titleId), added: false }, 201);
    };

    const found = await existingId();
    if (found) return addToExisting(found);

    const titleId = newId();
    try {
      await withFreshCodes(() => {
        const copies = copyInserts(db, actor, titleId, body.copies);
        return {
          result: copies.rows,
          statements: [
            db.insert(schema.titles).values(
              s.values({
                id: titleId,
                isbn,
                title: body.title,
                authors: body.authors,
                coverUrl: body.coverUrl ?? null,
              }),
            ),
            ...copies.statements,
            eventInsert(db, actor, "title_added", { titleId, copies: body.copies }),
          ],
        };
      }, db);
    } catch (error) {
      // Someone added the same ISBN a moment ago: add the copies to theirs.
      const raced = isIsbnClash(error) ? await existingId() : undefined;
      if (!raced) throw error;
      return addToExisting(raced);
    }
    return c.json({ title: await titleWithCopies(db, actor, titleId), added: true }, 201);
  })

  .get("/titles/:id", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    return c.json({ title: await titleWithCopies(c.get("db"), actor, c.req.param("id")) });
  })

  .patch("/titles/:id", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const body = await readBody(c, editTitleBody);
    const db = c.get("db");
    const s = scope(actor);
    const titleId = c.req.param("id");
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length > 0) {
      const [result] = await db.batch([
        db
          .update(schema.titles)
          .set(changes)
          .where(s.where(schema.titles, eq(schema.titles.id, titleId))),
        eventInsert(db, actor, "title_edited", { titleId, fields: Object.keys(changes) }),
      ]);
      if (result.meta.changes === 0) fail(404, "not_found", "That book is not in the catalog.");
    }
    return c.json({ title: await titleWithCopies(db, actor, titleId) });
  })

  .post("/titles/:id/copies", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const body = await readBody(c, z.object({ count: copyCount }));
    const db = c.get("db");
    const titleId = c.req.param("id");
    await titleWithCopies(db, actor, titleId); // 404 if not in this library
    await withFreshCodes(() => {
      const copies = copyInserts(db, actor, titleId, body.count);
      return {
        result: copies.rows,
        statements: [
          ...copies.statements,
          eventInsert(db, actor, "copies_added", { titleId, copies: body.count }),
        ],
      };
    }, db);
    return c.json({ title: await titleWithCopies(db, actor, titleId) }, 201);
  })

  /** Change a copy's status (lost, damaged, retired, available), shelf or note. */
  .patch("/copies/:id", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const body = await readBody(c, editCopyBody);
    const s = scope(actor);
    const db = c.get("db");
    const copy = await db.query.copies.findFirst({
      columns: { id: true, titleId: true, status: true },
      where: s.where(schema.copies, eq(schema.copies.id, c.req.param("id"))),
    });
    if (!copy) fail(404, "not_found", "That copy is not in the catalog.");

    if (body.status && body.status !== copy.status) {
      // A copy someone has borrowed is dealt with from its loan (returned, lost, damaged).
      const open = await db.$count(
        schema.loans,
        s.where(schema.loans, eq(schema.loans.copyId, copy.id), isNull(schema.loans.returnedAt)),
      );
      if (open > 0) {
        fail(
          409,
          "on_loan",
          "This copy is on loan. Return it first, or mark the loan lost or damaged from Loans.",
        );
      }
    }

    const changes = {
      ...(body.status ? { status: body.status } : {}),
      ...(body.shelf !== undefined ? { shelf: body.shelf || null } : {}),
      ...(body.note !== undefined ? { note: body.note || null } : {}),
      ...(body.needsLabel ? { labelPrintedAt: null } : {}),
    };
    if (Object.keys(changes).length > 0) {
      const [result] = await db.batch([
        db
          .update(schema.copies)
          .set(changes)
          // Only if nobody changed the status meanwhile, so the event's "from" is right.
          .where(
            s.where(
              schema.copies,
              eq(schema.copies.id, copy.id),
              eq(schema.copies.status, copy.status),
            ),
          ),
        eventInsert(db, actor, "copy_edited", {
          copyId: copy.id,
          fields: Object.keys(changes),
          ...(body.status && body.status !== copy.status
            ? { from: copy.status, to: body.status }
            : {}),
        }),
      ]);
      if (result.meta.changes === 0) {
        fail(
          409,
          "changed_meanwhile",
          "Someone else just changed this copy. Check it and try again.",
        );
      }
    }
    return c.json({ title: await titleWithCopies(db, actor, copy.titleId) });
  })

  /**
   * Copies to print labels for: the ones listed in `ids`, or every copy that
   * has never had a label printed.
   */
  .get("/labels", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const s = scope(actor);
    const db = c.get("db");
    const ids = [...new Set((c.req.query("ids") ?? "").split(",").filter(Boolean))].slice(
      0,
      MAX_LABEL_IDS,
    );
    const query = (filter: ReturnType<typeof isNull>) =>
      db
        .select({
          id: schema.copies.id,
          shortCode: schema.copies.shortCode,
          title: schema.titles.title,
        })
        .from(schema.copies)
        .innerJoin(
          schema.titles,
          and(
            eq(schema.titles.id, schema.copies.titleId),
            eq(schema.titles.libraryId, schema.copies.libraryId),
          ),
        )
        .where(s.where(schema.copies, filter, ne(schema.copies.status, "retired")))
        .orderBy(asc(schema.titles.title), asc(schema.copies.shortCode))
        .limit(MAX_LABEL_IDS)
        .all();
    const rows =
      ids.length > 0
        ? (
            await Promise.all(
              chunk(ids, IDS_PER_QUERY).map((part) => query(inArray(schema.copies.id, part))),
            )
          )
            .flat()
            .sort(
              (a, b) => a.title.localeCompare(b.title) || a.shortCode.localeCompare(b.shortCode),
            )
        : await query(isNull(schema.copies.labelPrintedAt));
    return c.json({ labels: rows, siteUrl: c.get("origin") });
  })

  /** Marks labels as printed, so they leave the "needs a label" list. */
  .post("/labels/printed", async (c) => {
    const actor = await requirePermission(c, "catalog:edit");
    const body = await readBody(c, z.object({ copyIds: idList }));
    const db = c.get("db");
    const now = new Date();
    const updates = chunk([...new Set(body.copyIds)], IDS_PER_QUERY).map((part) =>
      db
        .update(schema.copies)
        .set({ labelPrintedAt: now })
        .where(scope(actor).where(schema.copies, inArray(schema.copies.id, part))),
    );
    const results = await db.batch(
      updates as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
    );
    const marked = results.reduce(
      (sum, r) => sum + ((r as { meta?: { changes?: number } }).meta?.changes ?? 0),
      0,
    );
    if (marked > 0) await eventInsert(db, actor, "labels_printed", { count: marked }).run();
    return c.json({ marked });
  });
