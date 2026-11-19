self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ------------------------------------------------------------------ */
/* Push: announcements, messages, assignments, deadline reminders       */
/* ------------------------------------------------------------------ */

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

  const work = [
    self.registration.showNotification(payload.title || "myClass", {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One tag per item: a new announcement does not replace the previous one
      tag: payload.id || "myclass-push",
      renotify: true,
      requireInteraction: payload.kind === "deadline",
      vibrate: [150, 70, 150],
      data: { route: payload.route || "/" },
    }),
  ];
  // Deadlines may have changed: refresh the home-screen widget too
  if (payload.kind === "deadline" || payload.kind === "assignment") work.push(refreshAllWidgets());
  event.waitUntil(Promise.all(work));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || "/";
  event.waitUntil(openApp(route));
});

function openApp(route) {
  // `open=1` tells the app this page was asked for (otherwise a fresh start opens Home)
  const target = route + (route.includes("?") ? "&" : "?") + "open=1";
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
    for (const client of windowClients) {
      if ("focus" in client) {
        if ("navigate" in client) {
          client.navigate(target);
        }
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  });
}

/* ------------------------------------------------------------------ */
/* Home-screen widget (Windows Widgets board, installed PWA)            */
/* The template is an Adaptive Card; the data comes from the API with   */
/* the signed-in session cookie.                                        */
/* ------------------------------------------------------------------ */

async function updateWidget(widget) {
  const def = widget.definition;
  const [template, data] = await Promise.all([
    fetch(def.msAcTemplate).then((r) => r.text()),
    fetch(def.data, { credentials: "include" }).then((r) => r.text()),
  ]);
  await self.widgets.updateByTag(def.tag, { template, data });
}

async function refreshAllWidgets() {
  if (!self.widgets) return;
  try {
    const widget = await self.widgets.getByTag("deadlines");
    if (widget) await updateWidget(widget);
  } catch {
    // widget host not available
  }
}

self.addEventListener("widgetinstall", (event) => {
  event.waitUntil(
    (async () => {
      const def = event.widget.definition;
      if (self.registration.periodicSync && def.update) {
        try {
          const tags = await self.registration.periodicSync.getTags();
          if (!tags.includes(def.tag)) {
            await self.registration.periodicSync.register(def.tag, { minInterval: def.update * 1000 });
          }
        } catch {
          // periodic sync not permitted: the widget still refreshes on resume and on push
        }
      }
      await updateWidget(event.widget);
    })(),
  );
});

self.addEventListener("widgetresume", (event) => {
  event.waitUntil(updateWidget(event.widget));
});

self.addEventListener("widgetuninstall", (event) => {
  event.waitUntil(
    (async () => {
      if (event.widget.instances.length <= 1 && self.registration.periodicSync) {
        await self.registration.periodicSync.unregister(event.widget.definition.tag);
      }
    })(),
  );
});

self.addEventListener("widgetclick", (event) => {
  if (event.action === "open") event.waitUntil(openApp("/"));
  if (event.action === "refresh") event.waitUntil(updateWidget(event.widget));
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "deadlines") event.waitUntil(refreshAllWidgets());
});
