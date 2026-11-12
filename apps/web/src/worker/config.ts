import { type PushSender, WebPushSender } from "@community-library/adapters";

/**
 * Secrets are set with `wrangler secret put` (or .dev.vars locally), so they are
 * not part of the generated Env type. Read them here, in one place.
 */
export interface Secrets {
  BETTER_AUTH_SECRET?: string;
  SETUP_CODE?: string;
  RESEND_API_KEY?: string;
  MAILJET_API_KEY?: string;
  MAILJET_API_SECRET?: string;
  GOOGLE_BOOKS_API_KEY?: string;
  /** Web push keys (npm run vapid-keys). Without them, phone notifications are off. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

export function secrets(env: Env): Secrets {
  const raw = env as unknown as Record<string, unknown>;
  const read = (key: keyof Secrets) => {
    const value = raw[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const result: Secrets = {};
  for (const key of [
    "BETTER_AUTH_SECRET",
    "SETUP_CODE",
    "RESEND_API_KEY",
    "MAILJET_API_KEY",
    "MAILJET_API_SECRET",
    "GOOGLE_BOOKS_API_KEY",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
  ] as const) {
    const value = read(key);
    if (value) result[key] = value;
  }
  return result;
}

/**
 * The phone-notification sender, when the site has VAPID keys. Push services
 * are told who sends (the site's from-address) in case of problems.
 */
export function pushSender(env: Env): PushSender | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = secrets(env);
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  return new WebPushSender({
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: `mailto:${env.EMAIL_FROM}`,
  });
}

/** True for local development hosts, where a missing SETUP_CODE is allowed. */
export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The secret used for sessions, rate-limit keys and signed links. Never falls
 * back to an empty string: without it, signed links could be forged.
 */
export function authSecret(env: Env): string {
  const secret = secrets(env).BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("BETTER_AUTH_SECRET is missing or too short. See apps/web/.dev.vars.example.");
  }
  return secret;
}
