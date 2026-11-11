import { describe, expect, it } from "vitest";
import { isLibrarySlug, RESERVED_SLUGS, SITE_PAGES, slugify } from "./slugs.ts";

describe("library slugs", () => {
  it("make readable, safe slugs from names", () => {
    expect(slugify("Little Owls Daycare")).toBe("little-owls-daycare");
    expect(slugify("Crèche Éclair")).toBe("creche-eclair");
    expect(slugify("  !!! ")).toBe("library");
  });

  it("never produce a reserved slug", () => {
    expect(slugify("Admin")).toBe("admin-library");
    expect(slugify("Sign in")).toBe("sign-in");
    for (const word of RESERVED_SLUGS) expect(isLibrarySlug(slugify(word))).toBe(true);
  });

  it("refuse site pages and malformed slugs", () => {
    for (const page of SITE_PAGES) expect(isLibrarySlug(page)).toBe(false);
    expect(isLibrarySlug("api")).toBe(false);
    expect(isLibrarySlug("little-owls")).toBe(true);
    expect(isLibrarySlug("-owls")).toBe(false);
    expect(isLibrarySlug("Owls")).toBe(false);
    expect(isLibrarySlug("a".repeat(49))).toBe(false);
  });
});
