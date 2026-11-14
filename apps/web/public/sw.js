self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    id: "myclass-push",
    title: "myClass",
    body: "Νέα ενημέρωση από το eClass",
    route: "/",
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    }
  } catch {
    // ignore malformed push payload
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "myClass", {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.id || "myclass-push",
      renotify: true,
      vibrate: [150, 70, 150],
      data: { route: payload.route || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          if ("navigate" in client) {
            client.navigate(route);
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(route);
    }),
  );
});
