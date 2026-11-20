import type { RequestOrigin } from "./request-origin.js";

/**
 * Every request myClass sends to eClass (and every one it refused), so the owner can check that
 * no automatic request ever reached a page eClass counts as a visit. In memory only, per server
 * process; it keeps the host, path and course code, never query strings (CAS tickets, tokens) or bodies.
 *
 * `GET /api/debug/eclass-requests` shows a signed-in student their own part of it.
 */

export interface EclassRequestEntry {
  at: string;
  /** The myClass user the session belongs to, when known. */
  owner?: string;
  origin: RequestOrigin;
  method: string;
  host: string;
  path: string;
  course?: string;
  /** eClass logs this page as a course visit (see `eclassHitFor`). */
  counted: boolean;
  /** Set when the request was refused before it left. */
  blocked?: string;
}

interface Totals {
  sent: number;
  counted: number;
  blocked: number;
}

const MAX_ENTRIES = 500;
const startedAt = new Date().toISOString();
const entries: EclassRequestEntry[] = [];
/** `${owner ?? ""}|${origin}` -> totals */
const totals = new Map<string, Totals>();

export function auditEclassRequest(entry: Omit<EclassRequestEntry, "at">): void {
  const e: EclassRequestEntry = { at: new Date().toISOString(), ...entry };
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  const key = `${e.owner ?? ""}|${e.origin}`;
  const t = totals.get(key) ?? { sent: 0, counted: 0, blocked: 0 };
  if (e.blocked) t.blocked++;
  else {
    t.sent++;
    if (e.counted) t.counted++;
  }
  totals.set(key, t);

  const where = `${e.host}${e.path}${e.course ? ` (course ${e.course})` : ""}`;
  if (e.blocked) {
    console.warn(`[eclass] refused ${e.origin} ${e.method} ${where}: ${e.blocked}`);
  } else if (e.counted) {
    // Only the student's own explicit actions get here; anything else is a bug worth shouting about
    const log = e.origin === "interactive" ? console.log : console.error;
    log(`[eclass] counted visit, origin ${e.origin}: ${e.method} ${where}`);
  }
}

/** Counters and recent entries, for one user (`owner`) or the whole process. */
export function eclassRequestAudit(owner?: string) {
  const byOrigin: Partial<Record<RequestOrigin, Totals>> = {};
  let countedNotByStudent = 0;
  for (const [key, t] of totals) {
    const [o, origin] = key.split("|") as [string, RequestOrigin];
    if (owner !== undefined && o !== owner) continue;
    const cur = (byOrigin[origin] ??= { sent: 0, counted: 0, blocked: 0 });
    cur.sent += t.sent;
    cur.counted += t.counted;
    cur.blocked += t.blocked;
    if (origin !== "interactive") countedNotByStudent += t.counted;
  }
  return {
    process: { pid: process.pid, startedAt },
    /** Must stay 0: counted eClass visits sent by anything other than the student's own action. */
    countedNotByStudent,
    byOrigin,
    recent: entries.filter((e) => owner === undefined || e.owner === owner).slice(-200).reverse(),
  };
}

/** Only for tests. */
export function resetEclassRequestAuditForTests() {
  entries.length = 0;
  totals.clear();
}
