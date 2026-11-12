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
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
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
export async function turnOnPush(publicKey: string): Promise<"on" | "denied" | "failed"> {
  if (!pushSupported()) return "failed";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const registration = (await registerServiceWorker()) ?? null;
  if (!registration) return "failed";
  await navigator.serviceWorker.ready;
  try {
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      }));
    const json = subscription.toJSON();
    await api("/push/subscriptions", {
      body: { endpoint: json.endpoint, keys: json.keys },
    });
    return "on";
  } catch {
    return "failed";
  }
}

/** Stops notifications on this browser, here and on the server. */
export async function turnOffPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/push/subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe().catch(() => undefined);
}
