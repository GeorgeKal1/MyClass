import { users, type EclassHitLedger, type UserRecord } from "../store.js";
import type { BackgroundHit } from "../stats.js";
import { currentOrigin, eclassHitFor, type RequestOrigin } from "./request-origin.js";

/**
 * Keeps count of what myClass' own automatic requests add to the student's eClass usage log,
 * so the My stats page can take it out again.
 *
 * How Open eClass records usage (include/action.php, same in 4.2.1, 4.3.3 and 4.4.3):
 * - Each request to a course page that calls `action->record($module_id)` (see `eclassHitFor`)
 *   adds 1 hit to the `actions_daily` row (user, module, course, day) and, provisionally,
 *   DEFAULT_MAX_DURATION = 900 seconds of duration.
 * - Before that, eClass takes the most recently updated row of the same user, course and day
 *   and, when the gap since its last hit is under 900 s, lowers its duration by (900 - gap).
 *   So each hit is worth min(gap to the next hit in the same course that day, 900) seconds,
 *   and the last hit of a day keeps the full 900.
 * - `day` is the PHP `date('Y-m-d')` of the eClass server (Greek time).
 *
 * Hits: exact. Every request myClass sends goes through here, so the number of background
 * hits per day, course and tool is known exactly (as long as eClass behaves as its source says).
 *
 * Seconds: an estimate. The same rule is replayed over the hits myClass itself sends
 * (background and interactive), comparing eClass' duration with the duration it would have
 * recorded without the background hits. The difference is stored per row: positive on the
 * background rows (time to take away), negative on rows of the student's own visits whose
 * time a background hit cut short (time to give back). What it cannot see: visits the student
 * makes directly on the eClass website (they also cut background hits short, so slightly too
 * much may be taken away), and the gaps across a server restart (the timeline lives in memory).
 */

export const ECLASS_MAX_DURATION = 900;
export const ECLASS_TIMEZONE = "Europe/Athens";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ECLASS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The eClass `day` (YYYY-MM-DD, Greek time) a request at `at` is logged under. */
export function eclassDay(at: Date): string {
  const parts = Object.fromEntries(dayFormat.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The known hits of one course on one eClass day, as eClass' duration rule needs them. */
export interface CourseDayTimeline {
  day: string;
  /** The last hit eClass saw (any origin). */
  last?: { at: number; moduleId: number };
  /** The last hit eClass would have seen without myClass' background requests. */
  lastOwn?: { at: number; moduleId: number };
}

export interface HitDelta {
  moduleId: number;
  /** Background hits to remove from this row. */
  hits: number;
  /** Seconds to remove from this row; negative means give time back. */
  seconds: number;
}

/**
 * Applies one hit to a course-day timeline and returns what it changes in the difference
 * "eClass' log minus the student's own use", per tool row.
 */
export function stepTimeline(
  prev: CourseDayTimeline | undefined,
  hit: { day: string; at: number; moduleId: number; automated: boolean },
): { state: CourseDayTimeline; deltas: HitDelta[] } {
  const state: CourseDayTimeline = prev && prev.day === hit.day ? { ...prev } : { day: hit.day };
  const byModule = new Map<number, HitDelta>();
  const add = (moduleId: number, hits: number, seconds: number) => {
    const d = byModule.get(moduleId) ?? { moduleId, hits: 0, seconds: 0 };
    d.hits += hits;
    d.seconds += seconds;
    byModule.set(moduleId, d);
  };
  const shortfall = (from: number) => {
    const gap = Math.max(0, Math.floor((hit.at - from) / 1000));
    return gap < ECLASS_MAX_DURATION ? ECLASS_MAX_DURATION - gap : 0;
  };

  // What eClass does: cut the previous hit short, then credit this one 900 s
  if (state.last) add(state.last.moduleId, 0, -shortfall(state.last.at));
  add(hit.moduleId, hit.automated ? 1 : 0, ECLASS_MAX_DURATION);

  // What eClass would have done without background hits (subtracted, so the difference remains)
  if (!hit.automated) {
    if (state.lastOwn) add(state.lastOwn.moduleId, 0, shortfall(state.lastOwn.at));
    add(hit.moduleId, 0, -ECLASS_MAX_DURATION);
    state.lastOwn = { at: hit.at, moduleId: hit.moduleId };
  }
  state.last = { at: hit.at, moduleId: hit.moduleId };

  return { state, deltas: [...byModule.values()].filter((d) => d.hits !== 0 || d.seconds !== 0) };
}

/* ------------------------------------------------------------------ */
/* Per-user ledger (persisted aggregates)                              */
/* ------------------------------------------------------------------ */

/** Days kept: the stats window is twelve calendar months, plus a little slack. */
const KEEP_DAYS = 400;
const timelines = new Map<string, CourseDayTimeline>();

/** Starts the ledger for users who signed up before it existed. Older eClass days stay as they are. */
export function ensureHitLedger(user: UserRecord): EclassHitLedger {
  if (!user.eclassHits) {
    const ledger: EclassHitLedger = { since: new Date().toISOString(), portals: {} };
    user.eclassHits = ledger;
    users.update(user.id, (u) => {
      u.eclassHits ??= ledger;
    });
  }
  return user.eclassHits;
}

/** Inside `users.update`: the record's ledger, started now if missing. */
const ledgerOf = (u: UserRecord) => (u.eclassHits ??= { since: new Date().toISOString(), portals: {} });
const portalOf = (ledger: EclassHitLedger, host: string) => (ledger.portals[host] ??= { titles: {}, days: {} });

/** Remembers eClass' course titles so recorded hits can be matched to usage rows (which carry titles, not codes). */
export function rememberCourseTitles(user: UserRecord, host: string, courses: Array<{ code: string; title: string }>) {
  const known = user.eclassHits?.portals[host]?.titles ?? {};
  const changed = courses.filter((c) => c.title && known[c.code.toUpperCase()] !== c.title);
  if (changed.length === 0) return;
  users.update(user.id, (u) => {
    const titles = portalOf(ledgerOf(u), host).titles;
    for (const c of changed) titles[c.code.toUpperCase()] = c.title;
  });
}

/**
 * Called for every successful eClass response (after redirects, with an active session).
 * Requests outside the student's own actions ("background", and "login"/"stats" should they
 * ever reach a course page) are counted as not the student's use.
 */
export function noteEclassResponse(
  user: UserRecord,
  host: string,
  finalUrl: string,
  origin: RequestOrigin = currentOrigin(),
  at = new Date(),
) {
  const hit = eclassHitFor(finalUrl);
  if (!hit) return;
  const code = hit.courseCode.toUpperCase();
  const key = `${user.id}|${host}|${code}`;
  const day = eclassDay(at);
  const { state, deltas } = stepTimeline(timelines.get(key), {
    day,
    at: at.getTime(),
    moduleId: hit.moduleId,
    automated: origin !== "interactive",
  });
  timelines.set(key, state);
  if (deltas.length === 0) return;

  users.update(user.id, (u) => {
    const portal = portalOf(ledgerOf(u), host);
    const rows = (portal.days[day] ??= {});
    for (const d of deltas) {
      const k = `${code}|${d.moduleId}`;
      const cur = rows[k] ?? [0, 0];
      cur[0] += d.hits;
      cur[1] += d.seconds;
      if (cur[0] === 0 && cur[1] === 0) delete rows[k];
      else rows[k] = cur;
    }
    if (Object.keys(rows).length === 0) delete portal.days[day];
    pruneOldDays(portal.days, at);
  });
}

function pruneOldDays(days: Record<string, unknown>, now: Date) {
  const oldest = eclassDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  for (const day of Object.keys(days)) if (day < oldest) delete days[day];
}

/** The recorded background hits of one portal between two eClass days (inclusive), ready for `subtractBackground`. */
export function backgroundHitsFor(user: UserRecord, host: string, from: string, to: string): BackgroundHit[] {
  const portal = user.eclassHits?.portals[host];
  if (!portal) return [];
  const out: BackgroundHit[] = [];
  for (const [day, rows] of Object.entries(portal.days)) {
    if (day < from || day > to) continue;
    for (const [k, [hits, seconds]] of Object.entries(rows)) {
      const [code, moduleId] = k.split("|");
      out.push({ day, course: portal.titles[code], moduleId: Number(moduleId), hits, seconds });
    }
  }
  return out;
}

/** Only for tests: forget the in-memory timelines. */
export function resetTimelinesForTests() {
  timelines.clear();
}
