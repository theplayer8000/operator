/*
  Operator's service worker. Push only — deliberately not a cache.

  ## Why there is no offline caching here

  A service worker that caches assets is how a PWA serves a stale build, and
  this project already has three builds that can disagree (`CLAUDE.md` has a
  table for it). Adding a fourth layer that answers from last week's `dist/`
  would make "rebuild the app" stop meaning what that table says it means, and
  the failure looks like a bug in code you already fixed.

  The app also cannot do anything useful offline: every screen reads the store
  over `/api/`. Caching the shell would produce a page that loads and then shows
  nothing, which is worse than a browser saying it cannot reach the server.

  So this file exists for exactly one reason — iOS will not deliver Web Push
  without one.

  ## No versioning, no skipWaiting dance

  Nothing is cached, so there is nothing to invalidate. `skipWaiting` plus
  `clients.claim` means a new worker takes over on the next load rather than
  waiting for every tab to close.
*/

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  /*
    Never let a malformed payload swallow the notification.

    iOS is strict: a `push` handler that does not call `showNotification` can
    have the subscription revoked for "silent push". So a payload that fails to
    parse still shows something rather than returning quietly.
  */
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Operator", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Operator", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Same tag replaces the previous notification instead of stacking. Job
      // updates about one job should be one line on the lock screen, not six.
      tag: data.tag || undefined,
      // A question waiting on him should not be dismissed by a glance.
      requireInteraction: Boolean(data.urgent),
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";

  /*
    Focus the window that is already open rather than opening another.

    Tapping a notification three times should not leave three Operators, and on
    iOS a second window loses the microphone permission state of the first.
  */
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          if ("navigate" in client && target !== "/") client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
