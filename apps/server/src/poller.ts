import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { NotificationItem } from "@myclass/shared";
import { randomId } from "./crypto.js";
import { getConnectorForUser } from "./eclass/connector.js";
import { DATA_DIR, env } from "./env.js";
import { users, type UserRecord } from "./store.js";

/* ------------------------------------------------------------------ */
/* VAPID setup (auto-generates dev keys in .data/vapid.json)           */
/* ------------------------------------------------------------------ */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

function loadOrCreateVapid(): VapidKeys {
  if (env.vapid.publicKey && env.vapid.privateKey) {
    return { publicKey: env.vapid.publicKey, privateKey: env.vapid.privateKey };
  }
  const file = path.join(DATA_DIR, "vapid.json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as VapidKeys;
  }
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(generated, null, 2), { mode: 0o600 });
  return generated;
}

export const vapidKeys = loadOrCreateVapid();
webpush.setVapidDetails(env.vapid.subject, vapidKeys.publicKey, vapidKeys.privateKey);

/* ------------------------------------------------------------------ */
/* SSE listeners for live connected tabs                               */
/* ------------------------------------------------------------------ */

type Listener = (n: NotificationItem) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribeNotifications(userId: string, fn: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

export async function emitNotification(user: UserRecord, item: NotificationItem) {
  users.update(user.id, (u) => {
    u.notifications.unshift(item);
    if (u.notifications.length > 100) u.notifications.length = 100;
  });

  // Notify open browser tabs via SSE
  const subs = listeners.get(user.id);
  if (subs) {
    for (const fn of subs) {
      try {
        fn(item);
      } catch {
        /* ignore */
      }
    }
  }

  // Send Web Push if enabled
  if (user.settings.notify.push && user.pushSubscriptions.length > 0) {
    const payload = JSON.stringify({
      title: item.title,
      body: item.body,
      route: item.route ?? "/",
    });
    const deadEndpoints: string[] = [];
    await Promise.all(
      user.pushSubscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) deadEndpoints.push(sub.endpoint);
        }
      }),
    );
    if (deadEndpoints.length > 0) {
      users.update(user.id, (u) => {
        u.pushSubscriptions = u.pushSubscriptions.filter((s) => !deadEndpoints.includes(s.endpoint));
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Polling diff logic                                                  */
/* ------------------------------------------------------------------ */

export async function pollUserNow(user: UserRecord): Promise<NotificationItem[]> {
  const connector = getConnectorForUser(user);
  const muted = new Set(user.settings.mutedCourses);
  const created: NotificationItem[] = [];

  try {
    const [announcements, messages, assignments] = await Promise.all([
      user.settings.notify.announcements ? connector.getAnnouncements() : Promise.resolve([]),
      user.settings.notify.messages ? connector.getMessages() : Promise.resolve([]),
      user.settings.notify.assignments ? connector.getAssignments() : Promise.resolve([]),
    ]);

    const seenAnn = new Set(user.seen.announcements);
    const seenMsg = new Set(user.seen.messages);
    const seenAsg = new Set(user.seen.assignments);
    const isFirstSync = !user.seen.initialized;

    for (const a of announcements) {
      if (!seenAnn.has(a.id)) {
        seenAnn.add(a.id);
        if (!isFirstSync && !muted.has(a.courseCode)) {
          created.push({
            id: randomId(8),
            kind: "announcement",
            title: a.courseTitle ? `${a.courseTitle}: ${a.title}` : a.title,
            body: a.contentText.slice(0, 180),
            courseCode: a.courseCode,
            courseTitle: a.courseTitle,
            date: a.date,
            read: false,
            route: `/courses/${encodeURIComponent(a.courseCode)}?tab=announcements`,
          });
        }
      }
    }

    for (const m of messages) {
      if (!seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        if (!isFirstSync && (!m.courseCode || !muted.has(m.courseCode))) {
          created.push({
            id: randomId(8),
            kind: "message",
            title: `${m.sender}: ${m.subject}`,
            body: m.courseTitle ?? "Νέο μήνυμα στο eClass",
            courseCode: m.courseCode,
            courseTitle: m.courseTitle,
            date: m.date,
            read: false,
            route: "/inbox",
          });
        }
      }
    }

    for (const asg of assignments) {
      if (!seenAsg.has(asg.id)) {
        seenAsg.add(asg.id);
        if (!isFirstSync && !muted.has(asg.courseCode)) {
          created.push({
            id: randomId(8),
            kind: "assignment",
            title: `${asg.courseTitle ?? asg.courseCode}: ${asg.title}`,
            body: asg.deadline ? `Προθεσμία: ${new Date(asg.deadline).toLocaleDateString("el-GR")}` : "Νέα εργασία",
            courseCode: asg.courseCode,
            courseTitle: asg.courseTitle,
            date: new Date().toISOString(),
            read: false,
            route: `/courses/${encodeURIComponent(asg.courseCode)}?tab=assignments`,
          });
        }
      }
    }

    users.update(user.id, (u) => {
      u.seen = {
        announcements: [...seenAnn].slice(-500),
        messages: [...seenMsg].slice(-500),
        assignments: [...seenAsg].slice(-500),
        initialized: true,
      };
      u.lastPollAt = new Date().toISOString();
      u.lastPollError = undefined;
    });

    for (const item of created) {
      await emitNotification(user, item);
    }
  } catch (err) {
    users.update(user.id, (u) => {
      u.lastPollAt = new Date().toISOString();
      u.lastPollError = (err as Error).message;
    });
  }

  return created;
}

export function startBackgroundPoller() {
  // Tick every 60s and check which users are due according to their pollIntervalMin
  setInterval(() => {
    const now = Date.now();
    for (const u of users.all()) {
      if (!u.remember) continue;
      const intervalMs = Math.max(5, u.settings.pollIntervalMin || 15) * 60_000;
      const last = u.lastPollAt ? new Date(u.lastPollAt).getTime() : 0;
      if (now - last >= intervalMs) {
        void pollUserNow(u);
      }
    }
  }, 60_000).unref();
}
