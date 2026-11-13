import { describe, expect, it } from "vitest";
import { secrets } from "./config.ts";

describe("secrets", () => {
  it("drop the spaces and line breaks a pasted key brings along", () => {
    const env = {
      RESEND_API_KEY: "  re_123\n",
      MAILJET_API_KEY: " \n ",
      MAILJET_API_SECRET: "",
      BETTER_AUTH_SECRET: " exactly as set ",
    } as unknown as Env;
    expect(secrets(env)).toEqual({
      RESEND_API_KEY: "re_123",
      // Changing it would sign everyone out: it's used as is.
      BETTER_AUTH_SECRET: " exactly as set ",
    });
  });
});
