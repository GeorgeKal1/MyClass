import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type NotificationItem,
  type PendingAction,
  type UserSettings,
} from "@myclass/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256 } from "./crypto.js";
import { DATA_DIR, env, supabaseConfigured } from "./env.js";
import {
  deleteRows,
  describeError,
  loadAll,
  supabaseClient,
  upsertSessions,
  upsertUsers,
  type RemoteSessionRow,
} from "./store-remote.js";

/**
 * Persistence for users and sessions: db.json in development, Supabase in production.
 *
 * The rest of the server only talks to the synchronous functions exported here.
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
  /** The hand-in state was seen on the course page or set by an upload (the calendar feed has none). */
  submissionKnown?: boolean;
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

/**
 * Two backends behind the same synchronous API:
 * - file (default, dev and tests): db.json is loaded at import and rewritten 250 ms after a change.
 * - Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): a write-through cache. initStore() loads
 *   everything before the server listens; persist() sends only the users and sessions whose JSON
 *   changed since the last successful write. Session rows are keyed by sha256(cookie value).
 */
const remote = supabaseConfigured ? supabaseClient(env.supabase.url, env.supabase.serviceRoleKey) : null;

/** Name of the active backend, for the startup log. */
export const storeBackend: "supabase" | "file" = remote ? "supabase" : "file";

function load(): DbShape {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as Partial<DbShape>;
    return { users: raw.users ?? {}, sessions: raw.sessions ?? {} };
  } catch {
    return { users: {}, sessions: {} };
  }
}

const db: DbShape = remote ? { users: {}, sessions: {} } : load();
let writeTimer: NodeJS.Timeout | null = null;

/** Key of a session in `db.sessions`: the raw cookie value in db.json, its hash in Supabase. */
function sessionKey(sid: string): string {
  return remote ? sha256(sid) : sid;
}

/* ---- Supabase write-through state ---- */

let remoteReady = false;
/** JSON last written (or loaded) per user id / session key: what Supabase holds. */
const savedUsers = new Map<string, string>();
const savedSessions = new Map<string, string>();
let remoteFlush: Promise<void> = Promise.resolve();

/**
 * A server-wide value kept in Supabase's kv table: read it, or store `create()` the first time.
 * Null without Supabase (the caller keeps its file in DATA_DIR then). Never log the value.
 */
export async function remoteSetting<T>(key: string, create: () => T): Promise<T | null> {
  if (!remote) return null;
  const { data, error } = await remote.from("kv").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`kv ${key}: ${error.code ?? ""} ${error.message}`);
  if (data?.value) return data.value as T;
  const value = create();
  // ignoreDuplicates: if another instance stored one first, read that instead of overwriting it
  const ins = await remote.from("kv").upsert({ key, value }, { onConflict: "key", ignoreDuplicates: true });
  if (ins.error) throw new Error(`kv ${key}: ${ins.error.code ?? ""} ${ins.error.message}`);
  const again = await remote.from("kv").select("value").eq("key", key).maybeSingle();
  return ((again.data?.value as T | undefined) ?? value);
}

/** Loads all users and live sessions from Supabase. Must finish before the server listens. */
export async function initStore(): Promise<void> {
  if (!remote || remoteReady) return;
  const { users: userRows, sessions: sessionRows } = await loadAll(remote);
  for (const row of userRows) {
    db.users[row.id] = row.data as UserRecord;
    savedUsers.set(row.id, JSON.stringify(row.data));
  }
  for (const row of sessionRows) {
    const rec: SessionRecord = {
      userId: row.user_id,
      createdAt: Number(row.data?.createdAt) || Date.now(),
      expiresAt: Date.parse(row.expires_at),
    };
    db.sessions[row.token_hash] = rec;
    savedSessions.set(row.token_hash, JSON.stringify(rec));
  }
  remoteReady = true;
  console.log(`[store] loaded ${userRows.length} users and ${sessionRows.length} sessions from Supabase`);
}

async function flushRemote(client: SupabaseClient) {
  if (!remoteReady) return;
  const userRows: { id: string; data: unknown; json: string }[] = [];
  for (const [id, u] of Object.entries(db.users)) {
    const json = JSON.stringify(u);
    if (savedUsers.get(id) !== json) userRows.push({ id, data: JSON.parse(json), json });
  }
  const sessionRows: { row: RemoteSessionRow; json: string }[] = [];
  for (const [key, s] of Object.entries(db.sessions)) {
    const json = JSON.stringify(s);
    if (savedSessions.get(key) !== json) {
      sessionRows.push({
        json,
        row: {
          token_hash: key,
          user_id: s.userId,
          expires_at: new Date(s.expiresAt).toISOString(),
          data: { createdAt: s.createdAt },
        },
      });
    }
  }
  const goneSessions = [...savedSessions.keys()].filter((k) => !(k in db.sessions));
  const goneUsers = [...savedUsers.keys()].filter((id) => !(id in db.users));
  if (!userRows.length && !sessionRows.length && !goneSessions.length && !goneUsers.length) return;

  // Users before sessions (foreign key); session deletes before user deletes
  if (userRows.length) {
    await upsertUsers(client, userRows.map(({ id, data }) => ({ id, data })));
    for (const r of userRows) savedUsers.set(r.id, r.json);
  }
  if (sessionRows.length) {
    await upsertSessions(client, sessionRows.map((r) => r.row));
    for (const r of sessionRows) savedSessions.set(r.row.token_hash, r.json);
  }
  if (goneSessions.length) {
    await deleteRows(client, "sessions", goneSessions);
    for (const k of goneSessions) savedSessions.delete(k);
  }
  if (goneUsers.length) {
    await deleteRows(client, "users", goneUsers);
    for (const id of goneUsers) savedUsers.delete(id);
  }
}

let retryTimer: NodeJS.Timeout | null = null;

/** Queues a Supabase write after any in-flight one. Unsaved changes stay unsaved and are retried. */
function queueRemoteFlush(client: SupabaseClient): Promise<void> {
  remoteFlush = remoteFlush.then(() =>
    flushRemote(client).catch((e) => {
      console.error(`[store] failed to persist to Supabase: ${describeError(e)}`);
      // Retry in 5 s even if nothing else changes
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          persist();
        }, 5000);
      }
    }),
  );
  return remoteFlush;
}

function flushNow() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

export function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (remote) {
      void queueRemoteFlush(remote);
      return;
    }
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

/** Writes everything still unsaved to Supabase and waits for it. */
async function flushRemoteNow(client: SupabaseClient) {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await queueRemoteFlush(client);
}

if (!remote) process.on("exit", flushPending);

// Hosts stop the process with SIGTERM on redeploy and sleep; Ctrl+C sends SIGINT. Neither runs
// the "exit" handler by default, so flush pending writes before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (remote) {
      // Render allows 30 s after SIGTERM; give up after 20 s rather than be killed mid-write
      const giveUp = setTimeout(() => {
        console.error("[store] Supabase flush on shutdown timed out");
        process.exit(1);
      }, 20_000);
      flushRemoteNow(remote)
        .catch((e) => console.error(`[store] failed to persist on shutdown: ${describeError(e)}`))
        .finally(() => {
          clearTimeout(giveUp);
          process.exit(0);
        });
      return;
    }
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
    db.sessions[sessionKey(sid)] = { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
    persist();
  },
  get(sid: string): SessionRecord | undefined {
    const key = sessionKey(sid);
    const s = db.sessions[key];
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      delete db.sessions[key];
      persist();
      return undefined;
    }
    return s;
  },
  delete(sid: string) {
    delete db.sessions[sessionKey(sid)];
    persist();
  },
};
