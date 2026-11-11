import type { EmailSender } from "@community-library/adapters";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Auth, createAuth } from "./auth.ts";
import { secrets } from "./config.ts";
import type { AppEnv } from "./context.ts";
import { createDb } from "./db/client.ts";
import { configuredSenders, emailStatus, FallbackSender } from "./email.ts";
import { currentLibrary } from "./library.ts";
import { consume } from "./limiter.ts";
import { accountRoutes } from "./routes/account.ts";

export type { AppEnv } from "./context.ts";

export interface AppOptions {
  /** Replaces the configured email providers, for tests. */
  email?: (env: Env) => EmailSender;
  /** Replaces ExecutionContext.waitUntil, so tests can wait for background work. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The only Better Auth endpoints the app uses. Everything else under /api/auth is closed. */
const AUTH_PATHS = new Set([
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/list-user-passkeys",
  "/api/auth/passkey/delete-passkey",
  "/api/auth/passkey/update-passkey",
]);

/** Better Auth's session cookie, with or without the __Secure- prefix. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>().basePath("/api");

  // Health check: confirms the Worker runs and D1 answers a query. Runs before
  // the session middleware so it works even when the database does not.
  app.get("/health", async (c) => {
    let database: "ok" | "error" = "ok";
    try {
      await c.env.DB.prepare("select 1").first();
    } catch {
      database = "error";
    }
    const ok = database === "ok";
    return c.json(
      { ok, library: c.env.LIBRARY_NAME, database, email: emailStatus(c.env) },
      ok ? 200 : 503,
    );
  });

  // Per-request services: database, email, auth, and the signed-in user.
  app.use(async (c, next) => {
    const db = createDb(c.env.DB);
    c.set("db", db);
    const libraryName = (await currentLibrary(db))?.name ?? c.env.LIBRARY_NAME;
    // APP_URL pins the site's address (passkeys are tied to it). Without it, the
    // address the request came in on is used, which suits local development.
    const origin = c.env.APP_URL ? new URL(c.env.APP_URL).origin : new URL(c.req.url).origin;
    const email =
      options.email?.(c.env) ??
      new FallbackSender(configuredSenders(c.env, libraryName, new URL(origin).hostname));
    c.set("email", email);

    let auth: Auth | undefined;
    const getAuth = () => {
      auth ??= createAuth({
        db,
        env: c.env,
        origin,
        libraryName,
        email,
        waitUntil: options.waitUntil ?? ((p) => c.executionCtx.waitUntil(p)),
      });
      return auth;
    };
    c.set("auth", getAuth);

    // Better Auth's own routes read the session themselves.
    if (c.req.path.startsWith("/api/auth/")) {
      c.set("user", null);
      return next();
    }
    // No session cookie means signed out; skip building the auth instance.
    if (!SESSION_COOKIE.test(c.req.header("cookie") ?? "")) {
      c.set("user", null);
      return next();
    }
    const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
    c.set(
      "user",
      session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null,
    );
    await next();
  });

  app.on(["GET", "POST"], "/auth/*", async (c) => {
    if (!AUTH_PATHS.has(c.req.path)) {
      return c.json({ error: "not_found", message: "Not found." }, 404);
    }
    // Limit guesses per email address as well as per IP (Better Auth limits per IP).
    if (c.req.path === "/api/auth/sign-in/email-otp") {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => null)) as { email?: unknown } | null;
      if (typeof body?.email === "string") {
        const limit = await consume(
          c.env.DB,
          secrets(c.env).BETTER_AUTH_SECRET ?? "",
          `otp-verify:${body.email.trim().toLowerCase()}`,
          { window: 900, max: 10 },
        );
        if (!limit.allowed) {
          return c.json(
            {
              error: "too_many_attempts",
              message: "Too many tries. Please wait and ask for a new code.",
            },
            429,
          );
        }
      }
    }
    return c.get("auth")().handler(c.req.raw);
  });
  app.route("/", accountRoutes);

  app.notFound((c) => c.json({ error: "not_found", message: "Not found." }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json(
      { error: "server_error", message: "Something went wrong. Please try again." },
      500,
    );
  });

  return app;
}
