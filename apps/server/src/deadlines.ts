import type { Assignment, NotificationItem } from "@myclass/shared";
import { randomId } from "./crypto.js";
import { users, type KnownDeadline, type UserRecord } from "./store.js";

/**
 * The last known assignment deadlines of each student. They come for free whenever assignments
 * are loaded (the app, background checks), so reminders, the calendar feed and the home-screen
 * widget never cost extra eClass visits.
 */

/** Stores assignments just loaded. `courseCode` set = only that course was loaded. */
export function rememberDeadlines(user: UserRecord, assignments: Assignment[], courseCode?: string): void {
  const loaded: KnownDeadline[] = assignments
    .filter((a) => a.deadline && !Number.isNaN(new Date(a.deadline).getTime()))
    .map((a) => ({
      id: a.id,
      courseCode: a.courseCode,
      courseTitle: a.courseTitle,
      title: a.title,
      deadline: a.deadline!,
      submitted: a.submitted,
    }));
  const now = Date.now();
  const loadedCourses = new Set(loaded.map((d) => d.courseCode));
  users.update(user.id, (u) => {
    // eClass answers a failed course page with an empty list, so a course that came back empty
    // keeps its upcoming deadlines: a stale reminder is better than a missed one
    const kept = (u.deadlines ?? []).filter((d) => {
      if (courseCode && d.courseCode !== courseCode) return true;
      return !loadedCourses.has(d.courseCode) && new Date(d.deadline).getTime() > now;
    });
    // Old deadlines are not needed (reminders and the feed look ahead; the feed keeps 60 days back)
    const cutoff = now - 60 * 86_400_000;
    u.deadlines = [...kept, ...loaded].filter((d) => new Date(d.deadline).getTime() >= cutoff);
    const ids = new Set(u.deadlines.map((d) => d.id));
    u.remindersSent = (u.remindersSent ?? []).filter((k) => ids.has(k.split("|")[0]));
  });
}

/**
 * Deadlines from the calendar feed carry no submission state. A hand-in is known only from the
 * course's own assignment page (opened by the student) or from an upload through myClass, so
 * keep whatever was last seen for each assignment.
 */
export function withKnownSubmission(user: UserRecord, list: Assignment[]): Assignment[] {
  const known = new Map((user.deadlines ?? []).map((d) => [d.id, d.submitted]));
  return list.map((a) => (known.get(a.id) ? { ...a, submitted: true } : a));
}

export function markDeadlineSubmitted(user: UserRecord, courseCode: string, assignmentId: string): void {
  users.update(user.id, (u) => {
    for (const d of u.deadlines ?? []) {
      if (d.courseCode === courseCode && (d.id === assignmentId || d.id.split(":").pop() === assignmentId)) d.submitted = true;
    }
  });
}

export function upcomingDeadlines(user: UserRecord, now = Date.now()): KnownDeadline[] {
  return (user.deadlines ?? [])
    .filter((d) => !d.submitted && new Date(d.deadline).getTime() > now)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/* ------------------------------------------------------------------ */
/* Reminders: 24 h and 1 h before an unsubmitted deadline              */
/* ------------------------------------------------------------------ */

const HOUR = 3_600_000;
const STAGES = [
  { key: "1h", before: HOUR },
  { key: "24h", before: 24 * HOUR },
] as const;

function formatDue(iso: string, lang: "el" | "en"): string {
  return new Date(iso).toLocaleString(lang === "el" ? "el-GR" : "en-GB", {
    timeZone: "Europe/Athens",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * Reminders that are due now. A deadline first seen inside the last hour only gets the 1 h
 * reminder (never both at once); one seen 2-24 h ahead gets the 24 h reminder with the real time left.
 */
export function dueReminders(user: UserRecord, now = Date.now()): Array<{ key: string; item: NotificationItem }> {
  const lang = user.settings.language;
  const sent = new Set(user.remindersSent ?? []);
  const muted = new Set(user.settings.mutedCourses);
  const out: Array<{ key: string; item: NotificationItem }> = [];
  for (const d of user.deadlines ?? []) {
    if (d.submitted || muted.has(d.courseCode)) continue;
    const left = new Date(d.deadline).getTime() - now;
    if (left <= 0) continue;
    const stage = STAGES.find((s) => left <= s.before);
    if (!stage) continue;
    const key = `${d.id}|${stage.key}`;
    // The 1 h reminder replaces a 24 h one not yet sent, never the other way round
    if (sent.has(key) || (stage.key === "24h" && sent.has(`${d.id}|1h`))) continue;
    const hours = Math.max(1, Math.round(left / HOUR));
    const minutes = Math.max(1, Math.round(left / 60_000));
    const leftText =
      stage.key === "1h"
        ? lang === "el" ? `σε ${minutes}′` : `in ${minutes} min`
        : lang === "el" ? `σε ${hours} ώρ${hours === 1 ? "α" : "ες"}` : `in ${hours} h`;
    out.push({
      key,
      item: {
        id: `deadline-${randomId(6)}`,
        kind: "deadline",
        title: `${lang === "el" ? "Λήγει" : "Due"} ${leftText}: ${d.title}`,
        body: `${d.courseTitle ?? d.courseCode} · ${formatDue(d.deadline, lang)}`,
        courseCode: d.courseCode,
        courseTitle: d.courseTitle,
        date: new Date(now).toISOString(),
        read: false,
        route: `/courses/${encodeURIComponent(d.courseCode)}?tab=assignments`,
      },
    });
  }
  return out;
}

export async function sendDeadlineReminders(
  emit: (user: UserRecord, item: NotificationItem) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  for (const raw of users.all()) {
    // users.get fills in settings added since the record was saved (notify.deadlines defaults on)
    const u = users.get(raw.id);
    if (!u?.settings.notify.deadlines) continue;
    const due = dueReminders(u, now);
    if (!due.length) continue;
    users.update(u.id, (rec) => {
      rec.remindersSent = [...(rec.remindersSent ?? []), ...due.map((d) => d.key)].slice(-500);
    });
    for (const { item } of due) await emit(u, item);
  }
}

/* ------------------------------------------------------------------ */
/* iCalendar feed (phone calendars and their home-screen widgets)      */
/* ------------------------------------------------------------------ */

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Lines longer than 75 octets are folded as RFC 5545 asks (UTF-8 aware). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildDeadlinesIcs(user: UserRecord, publicUrl: string, now = Date.now()): string {
  const lang = user.settings.language;
  const stamp = icsDate(new Date(now).toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//myClass//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(lang === "el" ? "myClass προθεσμίες" : "myClass deadlines")}`,
    "X-WR-TIMEZONE:Europe/Athens",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const d of user.deadlines ?? []) {
    const end = new Date(d.deadline).getTime();
    // A 30-minute block ending at the deadline, so the calendar shows it at the right time
    const start = new Date(end - 30 * 60_000).toISOString();
    const course = d.courseTitle ?? d.courseCode;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(`${d.courseCode}-${d.id}`)}@myclass`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(d.deadline)}`,
      `SUMMARY:${icsEscape(`${d.submitted ? (lang === "el" ? "[Υποβλήθηκε] " : "[Submitted] ") : ""}${d.title}`)}`,
      `DESCRIPTION:${icsEscape(course)}`,
      `URL:${publicUrl}/courses/${encodeURIComponent(d.courseCode)}?tab=assignments`,
      "TRANSP:TRANSPARENT",
    );
    if (!d.submitted) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(d.title)}`, "TRIGGER:-PT24H", "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------ */
/* Windows widget data (Adaptive Card template in /widgets)            */
/* ------------------------------------------------------------------ */

export function widgetData(user: UserRecord | null, now = Date.now()) {
  const lang = user?.settings.language ?? "el";
  const title = lang === "el" ? "Προθεσμίες" : "Deadlines";
  if (!user) {
    return { title, items: [], empty: lang === "el" ? "Άνοιξε το myClass για να συνδεθείς." : "Open myClass to sign in." };
  }
  const items = upcomingDeadlines(user, now)
    .slice(0, 5)
    .map((d) => ({ title: d.title, course: d.courseTitle ?? d.courseCode, due: formatDue(d.deadline, lang) }));
  return {
    title,
    items,
    empty: items.length ? "" : lang === "el" ? "Καμία προθεσμία μπροστά σου." : "Nothing due ahead.",
    open: lang === "el" ? "Άνοιγμα" : "Open",
  };
}
