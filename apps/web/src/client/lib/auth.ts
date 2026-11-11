import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [emailOTPClient(), passkeyClient()],
});

/** True when this browser can create and use passkeys. */
export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function";
}

/** True when the person closed the Face ID / fingerprint prompt themselves. Not an error. */
export function isPasskeyCancel(
  error: { code?: string | undefined; message?: string | undefined } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "AUTH_CANCELLED" || error.code === "ERROR_CEREMONY_ABORTED") return true;
  return /not allowed|timed out|cancel|abort/i.test(error.message ?? "");
}

// Small per-device hints, kept in localStorage. Losing them only changes which
// button is shown first, so failures are ignored.
const USED_PASSKEY_KEY = "usedPasskey";
const DECLINED_PASSKEY_KEY = "declinedPasskey";

function readLocal(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeLocal(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode.
  }
}

/** This device has signed in with a passkey before, so offer that first. */
export const passkeyHint = {
  used: () => readLocal(USED_PASSKEY_KEY),
  markUsed: () => writeLocal(USED_PASSKEY_KEY),
  declined: () => readLocal(DECLINED_PASSKEY_KEY),
  markDeclined: () => writeLocal(DECLINED_PASSKEY_KEY),
};

const JOIN_TOKEN_KEY = "joinToken";
const INVITE_TOKEN_KEY = "inviteToken";

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function rememberToken(kind: "join" | "invite", token: string): void {
  try {
    sessionStorage.setItem(kind === "join" ? JOIN_TOKEN_KEY : INVITE_TOKEN_KEY, token);
  } catch {
    // Private mode: the token is still in the URL for this visit.
  }
}

export function forgetTokens(): void {
  try {
    sessionStorage.removeItem(JOIN_TOKEN_KEY);
    sessionStorage.removeItem(INVITE_TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

/** Headers that let someone joining by link or invite receive their first code. */
export function joinHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const join = readStorage(JOIN_TOKEN_KEY);
  const invite = readStorage(INVITE_TOKEN_KEY);
  if (join) headers["x-join-token"] = join;
  if (invite) headers["x-invite-token"] = invite;
  return headers;
}
