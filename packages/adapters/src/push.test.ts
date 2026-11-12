import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPayload,
  generateVapidKeys,
  isPushEndpoint,
  vapidAuthorization,
  WebPushSender,
} from "./push.ts";

const encoder = new TextEncoder();

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/** A browser's side: its keys, and decrypting a message the way browsers do (RFC 8291). */
async function browser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    p256dh: base64UrlEncode(publicKey),
    auth: base64UrlEncode(auth),
  };
  const decrypt = async (body: Uint8Array) => {
    const salt = body.slice(0, 16);
    const idLength = body[20] ?? 0;
    const senderKey = body.slice(21, 21 + idLength);
    const sealed = body.slice(21 + idLength);
    const sender = await crypto.subtle.importKey(
      "raw",
      senderKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, pair.privateKey, 256),
    );
    const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...publicKey, ...senderKey]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed),
    );
    expect(plain.at(-1)).toBe(2); // the "last record" delimiter
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { subscription, decrypt };
}

describe("web push", () => {
  it("encrypts so that only the subscribed browser can read the message", async () => {
    const { subscription, decrypt } = await browser();
    const body = await encryptPayload(subscription, encoder.encode('{"title":"Hi"}'));
    expect(await decrypt(body)).toBe('{"title":"Hi"}');
    // A different browser's keys can't read it.
    const other = await browser();
    await expect(other.decrypt(body)).rejects.toThrow();
  });

  it("signs a VAPID token the push service can check", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
    const header = await vapidAuthorization(
      keys,
      "https://fcm.googleapis.com/fcm/send/abc",
      1_000_000,
    );
    const [, token = "", k = ""] = header.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    expect(k).toBe(keys.publicKey);
    const [head = "", claims = "", signature = ""] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(claims)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1000 + 12 * 3600,
      sub: "mailto:owner@example.com",
    });
    const verify = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verify,
        base64UrlDecode(signature),
        encoder.encode(`${head}.${claims}`),
      ),
    ).toBe(true);
  });

  it("sends only to known push services", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://db5p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://evilpush.apple.com.example/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
  });

  it("reports a subscription that is gone", async () => {
    const { subscription } = await browser();
    const keys = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
    const sent: RequestInit[] = [];
    const sender = new WebPushSender(keys, async (_url, init) => {
      sent.push(init ?? {});
      return new Response(null, { status: sent.length === 1 ? 201 : 410 });
    });
    expect(await sender.send(subscription, { title: "a", body: "b", url: "/" })).toEqual({
      ok: true,
    });
    expect(await sender.send(subscription, { title: "a", body: "b", url: "/" })).toEqual({
      ok: false,
      gone: true,
      status: 410,
    });
    expect((sent[0]?.headers as Record<string, string> | undefined)?.["Content-Encoding"]).toBe(
      "aes128gcm",
    );
  });
});
