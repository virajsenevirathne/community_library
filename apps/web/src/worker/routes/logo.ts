import { Hono } from "hono";
import { z } from "zod";
import { actorFor, requirePermission } from "../access.ts";
import { type AppContext, type AppEnv, fail, readBody } from "../context.ts";
import { LOGO_MAX_BYTES, type LogoType } from "../db/schema.ts";
import { libraryBySlug } from "../library.ts";
import { kioskLibraryId } from "./kiosk.ts";

/** The picture's type from its first bytes, whatever it claims to be. Null if not a PNG, JPEG or WebP. */
export function sniffLogo(bytes: Uint8Array): LogoType | null {
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Whoever may see this library's logo: its members and staff, the site owner, its kiosks. */
async function maySeeLogo(c: AppContext, libraryId: string): Promise<boolean> {
  if (await actorFor(c)) return true;
  return (await kioskLibraryId(c)) === libraryId;
}

// Base64 of the largest logo, with room for padding.
const MAX_BASE64 = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4;

export const logoRoutes = new Hono<AppEnv>()
  /**
   * The logo itself, for <img>. Only to those who may see the library: like its
   * name, a logo says which centre this is. Anyone else gets "not found", the
   * same as a library with no logo.
   */
  .get("/logo/:slug", async (c) => {
    const library = await libraryBySlug(c.get("db"), c.req.param("slug").toLowerCase());
    if (library) c.set("library", library);
    if (!library || !(await maySeeLogo(c, library.id))) {
      fail(404, "not_found", "Not found.");
    }
    const row = await c.env.DB.prepare(
      "select image, content_type as type, updated_at as v from library_logos where library_id = ?",
    )
      .bind(library.id)
      .first<{ image: ArrayBuffer | number[]; type: LogoType; v: number }>();
    if (!row) fail(404, "not_found", "Not found.");
    const body = row.image instanceof ArrayBuffer ? row.image : new Uint8Array(row.image).buffer;
    // The address carries the version, so a matching one can be kept for good.
    // Private: it's only for people signed in to this library.
    const current = c.req.query("v") === String(row.v);
    return new Response(body, {
      headers: {
        "Content-Type": row.type,
        "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": "inline",
      },
    });
  })

  /** Add or replace the logo: a PNG, JPEG or WebP, as base64, shrunk by the browser first. */
  .put("/admin/logo", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    const body = await readBody(
      c,
      z.object({
        image: z
          .string({ error: "Choose a picture." })
          .max(MAX_BASE64, "That picture is too big. Try a smaller one.")
          .regex(/^[A-Za-z0-9+/]+={0,2}$/, "That picture couldn't be read."),
      }),
    );
    const bytes = fromBase64(body.image);
    if (!bytes || bytes.length === 0) fail(422, "invalid_input", "That picture couldn't be read.");
    if (bytes.length > LOGO_MAX_BYTES) {
      fail(422, "invalid_input", "That picture is too big. Try a smaller one.");
    }
    const type = sniffLogo(bytes);
    if (!type) {
      fail(422, "invalid_input", "Use a PNG, JPEG or WebP picture.");
    }
    const now = Date.now();
    await c.env.DB.prepare(
      `insert into library_logos (library_id, image, content_type, updated_at) values (?, ?, ?, ?)
       on conflict (library_id) do update set
         image = excluded.image, content_type = excluded.content_type, updated_at = excluded.updated_at`,
    )
      .bind(actor.library.id, bytes, type, now)
      .run();
    return c.json({ logo: now });
  })

  /** Remove the logo: the header goes back to the joey. */
  .delete("/admin/logo", async (c) => {
    const actor = await requirePermission(c, "library:admin");
    await c.env.DB.prepare("delete from library_logos where library_id = ?")
      .bind(actor.library.id)
      .run();
    return c.json({ logo: null });
  });
