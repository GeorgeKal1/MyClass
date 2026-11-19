import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type NotificationItem,
  type PendingAction,
  type UserSettings,
} from "@myclass/shared";
import { DATA_DIR } from "./env.js";

/**
 * Minimal JSON-file persistence for development.
 *
 * The rest of the server only talks to the functions exported here, so this can
 * be swapped for SQLite/Postgres (e.g. via Drizzle) without touching routes.
 */

export interface CourseMeta {
  semester?: string;
  archived?: boolean;
  color?: string;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PendingToolCall {
  action: PendingAction;
  /** The raw function_call step id from Gemini. */
  callId: string;
}

/**
 * Aggregates only (no URLs or content): per portal host, per eClass day, per course and tool,
 * the hits and seconds that myClass' background requests added to the student's eClass usage log.
 */
export interface EclassHitLedger {
  /** ISO time recording started. eClass days before it cannot be separated. */
  since: string;
  portals: Record<
    string,
    {
      /** Course code (upper case) -> course title as eClass lists it, to match usage rows. */
      titles: Record<string, string>;
      /** "YYYY-MM-DD" -> "CODE|moduleId" -> [hits, seconds]. Seconds may be negative (see hit-ledger.ts). */
      days: Record<string, Record<string, [number, number]>>;
    }
  >;
}

/** Last known assignment deadlines (for reminders, the calendar feed and the widget). */
export interface KnownDeadline {
  id: string;
  courseCode: string;
  courseTitle?: string;
  title: string;
  deadline: string;
  submitted: boolean;
}

export interface UserRecord {
  id: string;
  /** Set once the account moved to the "reduce motion on" default. */
  reduceMotionDefaultOn?: boolean;
  universityId: string;
  username: string;
  displayName: string;
  createdAt: string;
  remember: boolean;
  /** AES-GCM encrypted eClass password (only when remember=true). */
  encPassword?: string;
  /** AES-GCM encrypted serialized cookie jar of the live eClass session. */
  encSession?: string;
  settings: UserSettings;
  ai: {
    /** AES-GCM encrypted personal Gemini API key (optional). */
    encApiKey?: string;
  };
  courseMeta: Record<string, CourseMeta>;
  seen: {
    announcements: string[];
    messages: string[];
    assignments: string[];
    initialized: boolean;
    /** Assignment ids have been seeded from the calendar feed (first pass notifies nothing). */
    deadlineFeed?: boolean;
  };
  lastPollAt?: string;
  lastPollError?: string;
  /** What myClass' own automatic requests added to eClass' usage log (see eclass/hit-ledger.ts). */
  eclassHits?: EclassHitLedger;
  notifications: NotificationItem[];
  pushSubscriptions: PushSub[];
  /** Times (ms) of AI requests on the shared key within the last hour (see quota.ts). */
  aiUsage?: number[];
  /** Announcement id -> triage result, so each announcement is classified once. */
  triage?: Record<string, { label: "action" | "fyi"; reason?: string; at: number }>;
  deadlines?: KnownDeadline[];
  /** "assignmentId|24h" / "assignmentId|1h" reminders already sent. */
  remindersSent?: string[];
  /** Secret for the private calendar feed URL (absent = feed off). */
  calendarToken?: string;
  chat: {
    messages: ChatMessage[];
    /** Raw Gemini interaction steps (stateless mode – we own the history). */
    history: unknown[];
    pending: Record<string, PendingToolCall>;
  };
}

interface SessionRecord {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface DbShape {
  users: Record<string, UserRecord>;
  sessions: Record<string, SessionRecord>;
}

const DB_FILE = path.join(DATA_DIR, "db.json");

function load(): DbShape {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as Partial<DbShape>;
    return { users: raw.users ?? {}, sessions: raw.sessions ?? {} };
  } catch {
    return { users: {}, sessions: {} };
  }
}

const db: DbShape = load();
let writeTimer: NodeJS.Timeout | null = null;

function flushNow() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

export function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      flushNow();
    } catch (e) {
      console.error("[store] failed to persist", e);
    }
  }, 250);
}

function flushPending() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  flushNow();
}

process.on("exit", flushPending);

// Hosts stop the process with SIGTERM on redeploy; Ctrl+C sends SIGINT. Neither runs
// the "exit" handler by default, so flush pending writes before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    try {
      flushPending();
    } catch (e) {
      console.error("[store] failed to persist on shutdown", e);
    }
    process.exit(0);
  });
}

/* ---------------------------- users ---------------------------- */

export function newUser(id: string, universityId: string, username: string): UserRecord {
  return {
    id,
    universityId,
    username,
    displayName: username,
    createdAt: new Date().toISOString(),
    remember: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    ai: {},
    courseMeta: {},
    seen: { announcements: [], messages: [], assignments: [], initialized: false },
    // A new user has no background checks in their past, so every day can be separated
    eclassHits: { since: new Date().toISOString(), portals: {} },
    notifications: [],
    pushSubscriptions: [],
    chat: { messages: [], history: [], pending: {} },
  };
}

export const users = {
  get(id: string): UserRecord | undefined {
    const u = db.users[id];
    if (u) {
      // forward-compatible defaults when the shape evolves
      const defaults = structuredClone(DEFAULT_SETTINGS);
      u.settings = {
        ...defaults,
        ...u.settings,
        notify: { ...defaults.notify, ...u.settings?.notify },
        accessibility: { ...defaults.accessibility, ...u.settings?.accessibility },
      };
      // "Reduce motion" became on by default (2026-11-19); accounts still on the old default follow once
      if (!u.reduceMotionDefaultOn) {
        if (u.settings.accessibility.reduceMotion === "system") u.settings.accessibility.reduceMotion = "on";
        u.reduceMotionDefaultOn = true;
      }
      // Older records: removed "google" AI mode and the old hard-coded model name
      const ai = u.settings.ai ?? DEFAULT_SETTINGS.ai;
      u.settings.ai = {
        mode: ai.mode === "apiKey" || (String(ai.mode) === "google" && u.ai?.encApiKey) ? "apiKey" : "server",
        model: /^gemini-3\.8-flash$/.test(ai.model ?? "") ? "" : (ai.model ?? ""),
      };
    }
    return u;
  },
  upsert(u: UserRecord) {
    db.users[u.id] = u;
    persist();
  },
  update(id: string, fn: (u: UserRecord) => void) {
    const u = db.users[id];
    if (!u) return;
    fn(u);
    persist();
  },
  delete(id: string) {
    delete db.users[id];
    for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === id) delete db.sessions[sid];
    persist();
  },
  all(): UserRecord[] {
    return Object.values(db.users);
  },
};

/* --------------------------- sessions -------------------------- */

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

export const sessions = {
  create(sid: string, userId: string) {
    db.sessions[sid] = { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
    persist();
  },
  get(sid: string): SessionRecord | undefined {
    const s = db.sessions[sid];
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      delete db.sessions[sid];
      persist();
      return undefined;
    }
    return s;
  },
  delete(sid: string) {
    delete db.sessions[sid];
    persist();
  },
};
