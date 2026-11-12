/*
 * Web push: phone and browser notifications, sent straight to the push
 * service a browser chose (Google, Apple, Mozilla, Microsoft). Free, and
 * built on standards only, using the platform's Web Crypto:
 *
 * - VAPID (RFC 8292): a signed token tells the push service who is sending.
 * - Message encryption (RFC 8291, aes128gcm): only the browser that
 *   subscribed can read the message; the push service can't.
 */

export interface PushSubscription {
  endpoint: string;
  /** The browser's public key (base64url, uncompressed P-256 point). */
  p256dh: string;
  /** The browser's auth secret (base64url, 16 bytes). */
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** A path on this site to open when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag?: string;
}

export type PushResult =
  | { ok: true }
  /** The subscription is gone (unsubscribed, or the app was removed): forget it. */
  | { ok: false; gone: true; status: number }
  | { ok: false; gone: false; status: number; error: string };

export interface PushSender {
  send(subscription: PushSubscription, message: PushMessage): Promise<PushResult>;
}

export interface VapidKeys {
  /** base64url, uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** base64url, P-256 private key (32 bytes). */
  privateKey: string;
  /** Who to contact about these messages: "mailto:..." or an https address. */
  subject: string;
}

/** Push services browsers use. Messages only ever go to these hosts. */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/** True for an https address at a known push service (never anywhere else). */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const encoder = new TextEncoder();
/** Text as bytes, in a plain ArrayBuffer (what Web Crypto wants). */
const bytes = (text: string) => new Uint8Array(encoder.encode(text));

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/** The signed VAPID header value for one push service. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, now = Date.now()) {
  const publicKey = base64UrlDecode(keys.publicKey);
  const signing = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: base64UrlEncode(publicKey.slice(1, 33)),
      y: base64UrlEncode(publicKey.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const part = (value: object) => base64UrlEncode(bytes(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: keys.subject,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing, bytes(unsigned)),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** Encrypts a message for one browser (RFC 8291, a single aes128gcm record). */
export async function encryptPayload(
  subscription: PushSubscription,
  plaintext: Uint8Array<ArrayBuffer>,
) {
  const browserKey = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  const ours = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ourPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ours.publicKey)) as ArrayBuffer,
  );
  const theirs = await crypto.subtle.importKey(
    "raw",
    browserKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Standard Web Crypto: the field is `public`. (Cloudflare's type file
      // calls it `$public`; the runtime itself takes `public`.)
      { name: "ECDH", public: theirs } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0],
      ours.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(bytes("WebPush: info\0"), browserKey, ourPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, bytes("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, bytes("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the message, then the "last record" delimiter.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const recordSize = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([ourPublic.length]), ourPublic, sealed);
}

/** Sends web push messages with the site's VAPID keys. */
export class WebPushSender implements PushSender {
  private readonly keys: VapidKeys;
  private readonly fetchImpl: typeof fetch;

  constructor(keys: VapidKeys, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.keys = keys;
    this.fetchImpl = fetchImpl;
  }

  async send(subscription: PushSubscription, message: PushMessage): Promise<PushResult> {
    if (!isPushEndpoint(subscription.endpoint)) {
      return { ok: false, gone: true, status: 0 };
    }
    const body = await encryptPayload(subscription, bytes(JSON.stringify(message)));
    let res: Response;
    try {
      res = await this.fetchImpl(subscription.endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidAuthorization(this.keys, subscription.endpoint),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          // Worth delivering for a day; reminders are about a due date.
          TTL: "86400",
          Urgency: "normal",
          ...(message.tag
            ? { Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) }
            : {}),
        },
        body,
        redirect: "manual",
      });
    } catch (error) {
      return { ok: false, gone: false, status: 0, error: String(error).slice(0, 100) };
    }
    if (res.status === 201 || res.status === 200 || res.status === 202) return { ok: true };
    if (res.status === 404 || res.status === 410)
      return { ok: false, gone: true, status: res.status };
    return { ok: false, gone: false, status: res.status, error: `HTTP ${res.status}` };
  }
}

/** Makes a new pair of VAPID keys (run once per site, then keep them as secrets). */
export async function generateVapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return { publicKey: base64UrlEncode(publicKey), privateKey: jwk.d ?? "" };
}
