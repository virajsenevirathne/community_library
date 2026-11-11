import type { EmailSender, MetadataProvider } from "@community-library/adapters";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/client.ts";
import type { LibraryInfo } from "./library.ts";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    /** Created on first use; most API calls only need the session. */
    auth: () => Auth;
    email: EmailSender;
    user: SessionUser | null;
    /** Keeps work (such as sending email) running after the response is sent. */
    waitUntil: (promise: Promise<unknown>) => void;
    /** The site's public address, such as https://library.example.org. Used in QR links. */
    origin: string;
    /** Book lookup services, in the order to ask them. */
    metadata: MetadataProvider[];
    /** The library this deployment serves, loaded once per request. Null before setup. */
    library: LibraryInfo | null;
  };
};

export type AppContext = Context<AppEnv>;

/** Throws a JSON error response with a stable code and a message people can read. */
export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503,
  code: string,
  message: string,
): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error: code, message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

/** Parses and validates a JSON body, failing with 422 and the first problem found. */
export async function readBody<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, "invalid_json", "The request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(422, "invalid_input", issue?.message ?? "Some details are missing or wrong.");
  }
  return parsed.data;
}

export function requireUser(c: AppContext): SessionUser {
  const user = c.get("user");
  if (!user) fail(401, "signed_out", "Please sign in first.");
  return user;
}
