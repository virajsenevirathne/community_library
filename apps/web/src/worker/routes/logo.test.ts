import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES } from "../db/schema.ts";
import { createTestApp } from "../test/client.ts";
import { createTestEnv } from "../test/env.ts";
import { createLibrary, person } from "../test/fixtures.ts";
import { sniffLogo } from "./logo.ts";

type Person = Awaited<ReturnType<typeof person>>;
let env: Env;
let dispose: () => Promise<void>;
let ctx: ReturnType<typeof createTestApp>;
let admin: Person;
let parent: Person;

/** A real 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const b64Of = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** Pictures are recognised by their first bytes; the rest isn't read. */
const JPEG = b64Of(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]));
const WEBP = btoa("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");

beforeEach(async () => {
  ({ env, dispose } = await createTestEnv());
  ctx = createTestApp(env);
  await createLibrary(env);
  admin = await person(ctx, { role: "admin" });
  parent = await person(ctx, { role: "member", familyName: "Lee" });
});
afterEach(() => dispose());

async function upload(image: string, who: Person = admin) {
  return who.json<{ logo: number; message?: string }>("/api/admin/logo", {
    method: "PUT",
    body: { image },
  });
}

const logoVersion = async (who: Person) =>
  (await who.json<{ library: { logo: number | null } | null }>("/api/me")).body.library?.logo;

describe("a library's logo", () => {
  it("is added by an admin, and shown to the library's members", async () => {
    expect(await logoVersion(parent)).toBeNull();
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    const version = res.body.logo;
    expect(await logoVersion(parent)).toBe(version);

    const image = await parent.request(`/api/logo/lib-1?v=${version}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytesOf(PNG));
    // Kept by the browser until the logo changes (its address changes too),
    // but only privately: it's for people signed in to this library.
    expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(image.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");

    // An old or missing version is checked again each time.
    const stale = await parent.request("/api/logo/lib-1?v=1");
    expect(stale.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("is hidden from anyone outside the library, like its name", async () => {
    await upload(PNG);
    await createLibrary(env, { id: "lib-2" });
    const elsewhere = await person(ctx, { role: "admin", libraryId: "lib-2" });
    const nobody = await person(ctx, { role: "none" });
    for (const who of [elsewhere, nobody]) {
      expect((await who.request("/api/logo/lib-1")).status).toBe(404);
    }
    // Signed out, and an address that doesn't exist: the same "not found".
    await parent.request("/api/auth/sign-out", { body: {} });
    expect((await parent.request("/api/logo/lib-1")).status).toBe(404);
    expect((await admin.request("/api/logo/no-such-library")).status).toBe(404);
  });

  it("is shown on the library's kiosk tablets", async () => {
    await upload(PNG);
    const tablet = await person(ctx, { role: "admin" });
    expect((await tablet.request("/api/admin/kiosks", { body: { name: "Desk" } })).status).toBe(
      201,
    );
    await tablet.request("/api/auth/sign-out", { body: {} });
    const kiosk = await tablet.json<{ library: { logo: number | null } }>("/api/kiosk");
    expect(kiosk.body.library.logo).toEqual(expect.any(Number));
    expect((await tablet.request("/api/logo/lib-1")).status).toBe(200);
  });

  it("can be a PNG, JPEG or WebP, but nothing else", async () => {
    expect((await upload(JPEG)).status).toBe(200);
    expect((await parent.request("/api/logo/lib-1")).headers.get("Content-Type")).toBe(
      "image/jpeg",
    );
    expect((await upload(WEBP)).status).toBe(200);
    expect((await parent.request("/api/logo/lib-1")).headers.get("Content-Type")).toBe(
      "image/webp",
    );

    const refused = {
      svg: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      gif: btoa("GIF89a\u0001\u0000\u0001\u0000"),
      html: btoa("<!doctype html><script>alert(1)</script>"),
    };
    for (const [kind, image] of Object.entries(refused)) {
      const res = await upload(image);
      expect(res.status, kind).toBe(422);
      expect(res.body.message).toBe("Use a PNG, JPEG or WebP picture.");
    }
    // Still the last good one.
    expect((await parent.request("/api/logo/lib-1")).headers.get("Content-Type")).toBe(
      "image/webp",
    );
  });

  it("refuses pictures that are too big or can't be read", async () => {
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set(bytesOf(PNG));
    let text = "";
    for (let i = 0; i < big.length; i += 8192) {
      text += String.fromCharCode(...big.subarray(i, i + 8192));
    }
    const tooBig = await upload(btoa(text));
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.message).toBe("That picture is too big. Try a smaller one.");

    for (const bad of ["", "not base64!", "data:image/png;base64,iVBORw0KGgo="]) {
      expect((await upload(bad)).status, bad).toBe(422);
    }
  });

  it("is only changed by admins", async () => {
    const staff = await person(ctx, { role: "staff" });
    expect((await upload(PNG, staff)).status).toBe(403);
    expect((await upload(PNG, parent)).status).toBe(403);
    expect((await staff.request("/api/admin/logo", { method: "DELETE" })).status).toBe(403);
  });

  it("can be replaced and removed", async () => {
    const first = (await upload(PNG)).body.logo;
    await new Promise((r) => setTimeout(r, 2));
    const second = (await upload(JPEG)).body.logo;
    expect(second).toBeGreaterThan(first);
    expect(await logoVersion(parent)).toBe(second);

    const removed = await admin.json<{ logo: null }>("/api/admin/logo", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await logoVersion(parent)).toBeNull();
    expect((await parent.request("/api/logo/lib-1")).status).toBe(404);
  });

  it("goes with its library", async () => {
    await upload(PNG);
    await env.DB.prepare("delete from libraries where id = 'lib-1'").run();
    const left = await env.DB.prepare("select count(*) as n from library_logos").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });
});

describe("sniffLogo", () => {
  it("knows pictures by their contents, not their name", () => {
    expect(sniffLogo(bytesOf(PNG))).toBe("image/png");
    expect(sniffLogo(bytesOf(JPEG))).toBe("image/jpeg");
    expect(sniffLogo(bytesOf(WEBP))).toBe("image/webp");
    expect(sniffLogo(new TextEncoder().encode("RIFF....WAVE"))).toBeNull();
    expect(sniffLogo(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffLogo(new Uint8Array())).toBeNull();
  });
});
