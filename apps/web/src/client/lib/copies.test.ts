import { describe, expect, it } from "vitest";
import { parseCopyCode } from "./copies.ts";

describe("parseCopyCode", () => {
  it("reads a typed code", () => {
    expect(parseCopyCode(" k7r2 ")).toBe("K7R2");
  });
  it("reads the link from a QR sticker", () => {
    expect(parseCopyCode("https://library.example/c/K7R2")).toBe("K7R2");
  });
  it("reads the link after the code box upper-cases it (USB barcode scanners)", () => {
    expect(parseCopyCode("HTTPS://LIBRARY.EXAMPLE/C/K7R2")).toBe("K7R2");
    expect(parseCopyCode("https://library.example/c/K7R2/\n")).toBe("K7R2");
  });
  it("rejects anything else", () => {
    expect(parseCopyCode("hello world")).toBeNull();
  });
});
