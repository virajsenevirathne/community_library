import { passkey } from "@better-auth/passkey";
import type { EmailSender } from "@community-library/adapters";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { authSecret } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import type { Db } from "./db/client.ts";
import { schema } from "./db/client.ts";
import { signInCodeEmail } from "./email.ts";
import { consume } from "./limiter.ts";

export const JOIN_TOKEN_HEADER = "x-join-token";
export const INVITE_TOKEN_HEADER = "x-invite-token";

export interface AuthDeps {
  db: Db;
  env: Env;
  /** The site origin, such as https://library.example.org. Passkeys are tied to it. */
  origin: string;
  libraryName: string;
  email: EmailSender;
  /** Keeps background work (sending email) alive after the response. */
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Only people the library knows about get a sign-in code: existing users,
 * people with an open invite, people holding the current sign-up link, and
 * whoever signs in before the library exists (to set it up). Anyone else gets
 * the same "check your email" answer but no email, so the form cannot be used
 * to spam strangers or to find out who is a member.
 */
export async function mayReceiveCode(
  db: Db,
  email: string,
  headers: Headers | undefined,
  now = Date.now(),
  /** Whether the sign-up link may trigger another code (it is capped per hour). */
  allowJoinCode: (tokenHash: string) => Promise<boolean> = async () => true,
): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    columns: { id: true },
    where: eq(schema.users.email, address),
  });
  if (user) return true;

  const inviteToken = headers?.get(INVITE_TOKEN_HEADER);
  if (inviteToken) {
    const invite = await db.query.invitations.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.invitations.tokenHash, await sha256Hex(inviteToken)),
        eq(schema.invitations.email, address),
        isNull(schema.invitations.acceptedAt),
        gt(schema.invitations.expiresAt, new Date(now)),
      ),
    });
    if (invite) return true;
  }

  const joinToken = headers?.get(JOIN_TOKEN_HEADER);
  if (joinToken) {
    const library = await db.query.libraries.findFirst({
      columns: { id: true },
      where: eq(schema.libraries.joinTokenHash, await sha256Hex(joinToken)),
    });
    // A printed QR poster can be scanned by anyone, so cap how many codes the
    // link can trigger: 30 an hour across all addresses.
    if (library) return allowJoinCode(await sha256Hex(joinToken));
  }

  // On a brand-new site (no owner, no libraries) the first person may sign in to set it up.
  const [owners, libraries] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(schema.platformAdmins).get(),
    db.select({ n: sql<number>`count(*)` }).from(schema.libraries).get(),
  ]);
  return (owners?.n ?? 0) === 0 && (libraries?.n ?? 0) === 0;
}

export function createAuth(deps: AuthDeps) {
  const { db, env, origin, libraryName, email } = deps;
  const secret = authSecret(env);
  const url = new URL(origin);

  return betterAuth({
    appName: libraryName,
    baseURL: origin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "sqlite", usePlural: true, schema }),
    // Sign-in is by email code or passkey only.
    emailAndPassword: { enabled: false },
    session: {
      // Parents stay signed in on their phone for two months of use.
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      // Same table as our own limits; keys are hashed so no IP address is stored.
      customStorage: {
        consume: (key, rule) => consume(env.DB, secret, `auth:${key}`, rule),
      },
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 300, max: 5 },
        "/sign-in/email-otp": { window: 300, max: 10 },
        "/passkey/*": { window: 60, max: 20 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: url.protocol === "https:",
    },
    databaseHooks: {
      session: {
        create: {
          // Do not keep IP addresses or browser details with sessions.
          before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }),
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email: to, otp, type }, ctx) {
          if (type !== "sign-in") return;
          const headers = new Headers(ctx?.headers ?? undefined);
          // Everything after this point runs after the response is sent, so the
          // response time is the same for members and strangers.
          deps.waitUntil(
            (async () => {
              const allowJoinCode = async (tokenHash: string) =>
                (
                  await consume(env.DB, secret, `join-codes:${tokenHash}`, {
                    window: 3600,
                    max: 30,
                  })
                ).allowed;
              if (!(await mayReceiveCode(db, to, headers, Date.now(), allowJoinCode))) {
                console.log("Sign-in code not sent: address is not known to the library.");
                return;
              }
              // Per-address limit, so one inbox cannot be flooded from many IPs.
              const limit = await consume(env.DB, secret, `otp-send:${to.toLowerCase()}`, {
                window: 600,
                max: 3,
              });
              if (!limit.allowed) {
                console.log("Sign-in code not sent: too many codes for this address recently.");
                return;
              }
              const result = await email.send(signInCodeEmail(libraryName, to, otp, url.hostname));
              if (!result.ok) {
                console.error(`Sign-in code email failed via ${result.provider}: ${result.error}`);
              }
            })(),
          );
        },
      }),
      passkey({
        rpID: url.hostname,
        rpName: libraryName,
        origin,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
