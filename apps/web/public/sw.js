// Reading Joey's service worker. It only shows reminder notifications (web
// push) and opens the library when one is tapped. It caches nothing, so the
// site always loads fresh.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" ? data.title : "Reading Joey";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      // Only a page on this site: "/path", never "//elsewhere".
      data: {
        url:
          typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")
            ? data.url
            : "/",
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // The window in front, if the site is open: show the page there.
      const open =
        windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === "visible");
      if (open) {
        try {
          await open.focus();
          if (new URL(open.url).pathname !== url.pathname) await open.navigate(url.href);
          return;
        } catch {
          // A window this worker can't steer: open a new one instead.
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
