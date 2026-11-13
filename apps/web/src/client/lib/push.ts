import { api } from "./api.ts";

/*
 * Phone notifications (web push). The browser makes a subscription with the
 * site's public key, and the server sends reminders to it. On iPhone this
 * only works once the site is added to the Home Screen and opened from there.
 */

/** This browser can receive web push. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** An iPhone or iPad not running the site from the Home Screen, where push can't work yet. */
export function needsHomeScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !openedFromHomeScreen();
}

/** Opened as an app from the Home Screen, not in a browser tab. */
export function openedFromHomeScreen(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Starts the service worker that shows notifications. Safe to call more than once. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js").catch(() => null);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** This browser's current subscription, if notifications are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks to show notifications, subscribes, and tells the server. Returns why
 * not when it couldn't ("denied": the person said no, or blocked it before).
 */
export async function turnOnPush(
  publicKey: string,
): Promise<"on" | "denied" | "dismissed" | "failed"> {
  if (!pushSupported()) return "failed";
  const permission = await Notification.requestPermission();
  // "default": the question was closed without an answer; it can be asked again.
  if (permission === "default") return "dismissed";
  if (permission !== "granted") return "denied";
  const registration = (await registerServiceWorker()) ?? null;
  if (!registration) return "failed";
  await navigator.serviceWorker.ready;
  let made: PushSubscription | null = null;
  try {
    made =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      }));
    await saveSubscription(made);
    return "on";
  } catch {
    // Don't leave this browser subscribed when the library doesn't know it.
    await made?.unsubscribe().catch(() => undefined);
    return "failed";
  }
}

async function saveSubscription(subscription: PushSubscription) {
  const json = subscription.toJSON();
  await api("/push/subscriptions", { body: { endpoint: json.endpoint, keys: json.keys } });
}

/**
 * This browser has notifications on, but the library doesn't know it for the
 * person signed in now (a shared phone, or an earlier save failed): tell it.
 */
export async function claimThisDevice(): Promise<boolean> {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return false;
  try {
    await saveSubscription(subscription);
    return true;
  } catch {
    return false;
  }
}

/** Stops notifications on this browser, here and on the server. */
export async function turnOffPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/push/subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe().catch(() => undefined);
}
