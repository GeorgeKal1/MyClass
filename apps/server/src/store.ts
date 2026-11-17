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

export interface UserRecord {
  id: string;
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
    encApiKey?: string;
    google?: { encRefreshToken?: string; accessToken?: string; expiresAt?: number; email?: string };
  };
  courseMeta: Record<string, CourseMeta>;
  seen: { announcements: string[]; messages: string[]; assignments: string[]; initialized: boolean };
  lastPollAt?: string;
  lastPollError?: string;
  notifications: NotificationItem[];
  pushSubscriptions: PushSub[];
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
  oauthStates: Record<string, { userId: string; expiresAt: number }>;
}

const DB_FILE = path.join(DATA_DIR, "db.json");

function load(): DbShape {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as Partial<DbShape>;
    return { users: raw.users ?? {}, sessions: raw.sessions ?? {}, oauthStates: raw.oauthStates ?? {} };
  } catch {
    return { users: {}, sessions: {}, oauthStates: {} };
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
      u.settings = { ...structuredClone(DEFAULT_SETTINGS), ...u.settings };
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

/* -------------------------- oauth state ------------------------ */

export const oauthStates = {
  put(state: string, userId: string) {
    db.oauthStates[state] = { userId, expiresAt: Date.now() + 10 * 60 * 1000 };
    persist();
  },
  take(state: string): string | undefined {
    const s = db.oauthStates[state];
    delete db.oauthStates[state];
    persist();
    return s && s.expiresAt > Date.now() ? s.userId : undefined;
  },
};
