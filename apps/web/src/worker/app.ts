import {
  type EmailSender,
  GoogleBooksProvider,
  type MetadataProvider,
  OpenLibraryProvider,
  type PushSender,
  platformFetch,
} from "@community-library/adapters";
import { isEmail } from "@community-library/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isPlatformOwner } from "./access.ts";
import { type Auth, createAuth } from "./auth.ts";
import { authSecret, pushSender, secrets } from "./config.ts";
import { type AppEnv, fail } from "./context.ts";
import { createDb } from "./db/client.ts";
import { configuredSenders } from "./email.ts";
import { LIBRARY_HEADER, libraryForRequest } from "./library.ts";
import { clientIp, consume } from "./limiter.ts";
import { QuotaMailer } from "./mailer.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes, nudgeRoutes } from "./routes/admin.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { exportRoutes } from "./routes/export.ts";
import { familyRoutes } from "./routes/families.ts";
import { kioskRoutes } from "./routes/kiosk.ts";
import { loanRoutes } from "./routes/loans.ts";
import { logoRoutes } from "./routes/logo.ts";
import { ownerRoutes } from "./routes/owner.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

export type { AppEnv } from "./context.ts";

export interface AppOptions {
  /** Replaces the configured email providers, for tests. */
  email?: (env: Env) => EmailSender;
  /** Replaces the book lookup services, for tests. */
  metadata?: MetadataProvider[];
  /** Replaces fetch for webhooks, for tests. */
  fetch?: typeof fetch;
  /** Replaces the web push sender, for tests. */
  push?: (env: Env) => PushSender | null;
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
  // Every API answer: never cached (some carry personal details), never
  // framed, and the same security headers the pages get (public/_headers).
  app.use(async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Frame-Options", "DENY");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  });

  /** Public liveness check: says only whether the site and its database answer. */
  app.get("/health", async (c) => {
    let database: "ok" | "error" = "ok";
    try {
      await c.env.DB.prepare("select 1").first();
    } catch {
      database = "error";
    }
    const ok = database === "ok";
    return c.json({ ok, database }, ok ? 200 : 503);
  });

  // Per-request services: database, email, auth, and the signed-in user.
  app.use(async (c, next) => {
    const db = createDb(c.env.DB);
    c.set("db", db);
    const library = await libraryForRequest(db, c.req.path, c.req.header(LIBRARY_HEADER));
    c.set("library", library);
    const libraryName = library?.name ?? c.env.LIBRARY_NAME;
    // APP_URL pins the site's address (passkeys are tied to it). Without it, the
    // address the request came in on is used, which suits local development.
    const origin = c.env.APP_URL ? new URL(c.env.APP_URL).origin : new URL(c.req.url).origin;
    c.set("origin", origin);
    const email =
      options.email?.(c.env) ??
      new QuotaMailer(c.env.DB, configuredSenders(c.env, libraryName, new URL(origin).hostname));
    c.set("email", email);
    c.set("push", options.push ? options.push(c.env) : pushSender(c.env));
    c.set("fetch", options.fetch ?? platformFetch);
    c.set(
      "metadata",
      options.metadata ?? [
        new OpenLibraryProvider(),
        new GoogleBooksProvider(undefined, secrets(c.env).GOOGLE_BOOKS_API_KEY),
      ],
    );

    const waitUntil = options.waitUntil ?? ((p: Promise<unknown>) => c.executionCtx.waitUntil(p));
    c.set("waitUntil", waitUntil);

    let auth: Auth | undefined;
    const getAuth = () => {
      auth ??= createAuth({
        db,
        env: c.env,
        origin,
        libraryName,
        email,
        waitUntil,
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
      // Per address and network: a stranger can't lock someone out by failing
      // on purpose, and nonsense addresses don't fill the limits table.
      if (typeof body?.email === "string" && isEmail(body.email)) {
        const limit = await consume(
          c.env.DB,
          authSecret(c.env),
          `otp-verify:${body.email.trim().toLowerCase()}:${clientIp(c.req.raw.headers)}`,
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
  // A paused library can be looked at but not changed, except by the site's
  // owner. Account actions (deleting your own account) stay open.
  app.use(async (c, next) => {
    const library = c.get("library");
    const reading = c.req.method === "GET" || c.req.method === "HEAD";
    if (
      library?.status === "paused" &&
      !reading &&
      !c.req.path.startsWith("/api/account/") &&
      !(await isPlatformOwner(c))
    ) {
      fail(
        403,
        "library_paused",
        "This library is paused, so nothing can be changed right now. Please ask the library staff.",
      );
    }
    await next();
  });

  app.route("/", accountRoutes);
  app.route("/owner", ownerRoutes);
  app.route("/catalog", catalogRoutes);
  app.route("/", loanRoutes);
  app.route("/admin", adminRoutes);
  app.route("/", nudgeRoutes);
  app.route("/", familyRoutes);
  app.route("/", kioskRoutes);
  app.route("/", exportRoutes);
  app.route("/", webhookRoutes);
  app.route("/", logoRoutes);

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
