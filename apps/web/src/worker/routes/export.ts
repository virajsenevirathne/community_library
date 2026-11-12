import { localParts, toCsv } from "@community-library/core";
import { Hono } from "hono";
import { requirePermission } from "../access.ts";
import { authSecret } from "../config.ts";
import { type AppEnv, fail } from "../context.ts";
import { consume } from "../limiter.ts";
import { event } from "./families.ts";

/*
 * The library's own data as spreadsheet files (CSV), so a library is never
 * locked in: the catalog, the families with their adults, and every loan
 * still on record. Admins only, since families' emails are in it; each
 * export is logged.
 */

const KINDS = ["catalog", "families", "loans"] as const;
type Kind = (typeof KINDS)[number];

export const exportRoutes = new Hono<AppEnv>().get("/admin/export/:kind", async (c) => {
  const actor = await requirePermission(c, "library:admin");
  const kind = c.req.param("kind") as Kind;
  if (!KINDS.includes(kind)) fail(404, "not_found", "There's no export by that name.");
  const DB = c.env.DB;
  const lib = actor.library.id;
  const limit = await consume(DB, authSecret(c.env), `export:${lib}`, { window: 3600, max: 30 });
  if (!limit.allowed) {
    fail(429, "too_many_exports", "That's a lot of downloads. Please try again in an hour.");
  }
  const tz = actor.library.settings.timezone;
  const day = (ms: number | null) => (ms === null ? "" : localParts(new Date(ms), tz).date);

  let rows: (string | number | null)[][];
  if (kind === "catalog") {
    const { results } = await DB.prepare(
      `select t.title as title, t.authors as authors, t.isbn as isbn, c.short_code as code,
              c.shelf as shelf, c.status as status, c.note as note, c.created_at as added
       from copies c join titles t on t.id = c.title_id and t.library_id = c.library_id
       where c.library_id = ? order by t.title collate nocase, c.short_code`,
    )
      .bind(lib)
      .all<{
        title: string;
        authors: string;
        isbn: string | null;
        code: string;
        shelf: string | null;
        status: string;
        note: string | null;
        added: number;
      }>();
    rows = [
      ["Title", "Authors", "ISBN", "Copy code", "Shelf", "Status", "Note", "Added"],
      ...results.map((r) => [
        r.title,
        r.authors,
        r.isbn,
        r.code,
        r.shelf,
        r.status,
        r.note,
        day(r.added),
      ]),
    ];
  } else if (kind === "families") {
    // One row per adult; adults without email are listed too. A family with
    // no adults left still gets a row.
    const { results } = await DB.prepare(
      `select f.name as family, f.status as status, f.created_at as joined,
              a.name as name, a.email as email, a.kiosk as kiosk
       from families f
       left join (
         select m.family_id as familyId, u.name as name, u.email as email,
                exists (select 1 from kiosk_people k where k.library_id = m.library_id
                        and k.user_id = u.id and k.code_hash is not null) as kiosk,
                m.created_at as at
         from memberships m join users u on u.id = m.user_id
         where m.library_id = ?1 and m.family_id is not null
         union all
         select k.family_id, k.first_name, null, k.code_hash is not null, k.created_at
         from kiosk_people k where k.library_id = ?1 and k.user_id is null
       ) a on a.familyId = f.id
       where f.library_id = ?1
       order by f.name collate nocase, f.id, a.at`,
    )
      .bind(lib)
      .all<{
        family: string;
        status: string;
        joined: number;
        name: string | null;
        email: string | null;
        kiosk: number | null;
      }>();
    rows = [
      ["Family", "Status", "Joined", "Adult", "Email", "Kiosk code"],
      ...results.map((r) => [
        r.family,
        r.status,
        day(r.joined),
        r.name,
        r.email,
        r.kiosk === null ? "" : r.kiosk ? "yes" : "no",
      ]),
    ];
  } else {
    const { results } = await DB.prepare(
      `select t.title as title, c.short_code as code, f.name as family,
              l.borrowed_at as borrowedAt, l.due_on as dueOn, l.returned_at as returnedAt,
              l.outcome as outcome, l.extended_count as extended,
              l.kiosk_device_id is not null as kiosk
       from loans l
       join copies c on c.id = l.copy_id and c.library_id = l.library_id
       join titles t on t.id = c.title_id and t.library_id = c.library_id
       left join families f on f.id = l.family_id and f.library_id = l.library_id
       where l.library_id = ? order by l.borrowed_at desc`,
    )
      .bind(lib)
      .all<{
        title: string;
        code: string;
        family: string | null;
        borrowedAt: number;
        dueOn: string;
        returnedAt: number | null;
        outcome: string | null;
        extended: number;
        kiosk: number;
      }>();
    rows = [
      [
        "Book",
        "Copy code",
        "Family",
        "Borrowed",
        "Due",
        "Returned",
        "Outcome",
        "Extended",
        "At the kiosk",
      ],
      ...results.map((r) => [
        r.title,
        r.code,
        // Forgotten after the library's history period, or a removed family.
        r.family ?? "",
        day(r.borrowedAt),
        r.dueOn,
        day(r.returnedAt),
        r.outcome ?? "out",
        r.extended,
        r.kiosk ? "yes" : "no",
      ]),
    ];
  }

  await event(DB, lib, actor.userId, "data_exported", { kind }).run();
  const stamp = localParts(new Date(), tz).date;
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${actor.library.slug}-${kind}-${stamp}.csv"`,
    },
  });
});
