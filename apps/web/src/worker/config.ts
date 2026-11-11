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
  ] as const) {
    const value = read(key);
    if (value) result[key] = value;
  }
  return result;
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
