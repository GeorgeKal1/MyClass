import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { NotificationItem } from "@myclass/shared";
import { triageAnnouncements } from "./ai.js";
import { randomId } from "./crypto.js";
import { rememberDeadlines, sendDeadlineReminders } from "./deadlines.js";
import { getConnectorForUser } from "./eclass/connector.js";
import { withOrigin } from "./eclass/request-origin.js";
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
    // A tag per item, so a new announcement does not replace the previous one on the lock screen
    const payload = JSON.stringify({
      id: item.id,
      kind: item.kind,
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

/**
 * Checks eClass for new announcements, messages and assignments. Every call (timer, after
 * login, after a submission, the refresh button) is a background check, not the student
 * reading eClass, so its requests are tagged "background" and kept out of My stats.
 */
/** How often background polling may load the per-course assignment pages (each one counts as a visit on eClass). */
const ASSIGNMENT_CHECK_EVERY_MS = 6 * 60 * 60_000;
const lastAssignmentCheck = new Map<string, number>();

export function pollUserNow(user: UserRecord): Promise<NotificationItem[]> {
  return withOrigin("background", () => pollUserNowInContext(user));
}

async function pollUserNowInContext(user: UserRecord): Promise<NotificationItem[]> {
  const connector = getConnectorForUser(user);
  const muted = new Set(user.settings.mutedCourses);
  const created: NotificationItem[] = [];

  try {
    // Announcements and messages come from account-wide endpoints that eClass does not count
    // as course visits. Assignments need one course page per course, and each of those is
    // logged as a visit in the student's usage stats, so that check runs rarely.
    const checkAssignments =
      user.settings.notify.assignments &&
      (!user.seen.initialized || Date.now() - (lastAssignmentCheck.get(user.id) ?? 0) >= ASSIGNMENT_CHECK_EVERY_MS);
    if (checkAssignments) lastAssignmentCheck.set(user.id, Date.now());

    const [announcements, messages, assignments] = await Promise.all([
      user.settings.notify.announcements ? connector.getAnnouncements() : Promise.resolve([]),
      user.settings.notify.messages ? connector.getMessages() : Promise.resolve([]),
      checkAssignments ? connector.getAssignments() : Promise.resolve([]),
    ]);

    const seenAnn = new Set(user.seen.announcements);
    const seenMsg = new Set(user.seen.messages);
    const seenAsg = new Set(user.seen.assignments);
    const isFirstSync = !user.seen.initialized;
    if (checkAssignments) rememberDeadlines(user, assignments);

    // Sort new announcements into "action needed" / "FYI" (one batched AI call, keywords as fallback)
    const newAnnouncements = isFirstSync ? [] : announcements.filter((a) => !seenAnn.has(a.id) && !muted.has(a.courseCode));
    const triage = newAnnouncements.length
      ? await triageAnnouncements(user, newAnnouncements).catch(() => ({}) as Record<string, never>)
      : {};
    const actionPrefix = user.settings.language === "el" ? "Χρειάζεται ενέργεια" : "Action needed";

    for (const a of announcements) {
      if (!seenAnn.has(a.id)) {
        seenAnn.add(a.id);
        if (!isFirstSync && !muted.has(a.courseCode)) {
          const t = triage[a.id];
          const action = t?.label === "action";
          created.push({
            id: randomId(8),
            kind: "announcement",
            title: `${action ? `${actionPrefix} · ` : ""}${a.courseTitle ? `${a.courseTitle}: ${a.title}` : a.title}`,
            body: action && t.reason ? `${t.reason} — ${a.contentText.slice(0, 150)}` : a.contentText.slice(0, 180),
            triage: t?.label,
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
  // Tick every 60s: deadline reminders, then the users due a check according to their pollIntervalMin
  setInterval(() => {
    const now = Date.now();
    void sendDeadlineReminders(emitNotification, now).catch((err) =>
      console.warn("[reminders] failed:", (err as Error).message),
    );
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
