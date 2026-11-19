import type { MyStats } from "@myclass/shared";
import { splitCourseTitle } from "./eclass/unipi-curriculum.js";

/** One row of Open eClass' personal usage details (`modules/usage/results.php?t=ud`). */
export interface UsageRow {
  /** YYYY-MM-DD */
  day: string;
  course: string;
  tool: string;
  visits: number;
  seconds: number;
}

/**
 * Parses the JSON of `results.php?t=ud`: `[[day, courseTitle, toolTitle, hits, durationSeconds], …]`.
 * Anything that does not look like that row shape is skipped.
 */
export function parseUsageDetails(json: unknown): UsageRow[] {
  if (!Array.isArray(json)) return [];
  const out: UsageRow[] = [];
  for (const r of json) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const day = String(r[0]).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({
      day,
      course: String(r[1] ?? "").replace(/\s+/g, " ").trim(),
      tool: String(r[2] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
      visits: Math.max(0, Number(r[3]) || 0),
      seconds: Math.max(0, Number(r[4]) || 0),
    });
  }
  return out;
}

/** What myClass' background requests added to one usage row (from eclass/hit-ledger.ts). */
export interface BackgroundHit {
  /** YYYY-MM-DD, eClass' own day. */
  day: string;
  /** Course title as eClass lists it; undefined when the course was never listed. */
  course: string | undefined;
  /** Open eClass module id (5 = Assignments, …); see ECLASS_MODULES. */
  moduleId: number;
  /** Exact number of background hits. */
  hits: number;
  /** Estimated seconds they added; negative when they cut the student's own visits short. */
  seconds: number;
}

/** The key courses are grouped by: the title without semester / curriculum code decorations. */
export function courseKey(title: string): string {
  return splitCourseTitle(title.replace(/\s+/g, " ").trim()).title.toLocaleLowerCase("el");
}

const toolKey = (t: string) => t.replace(/\s+/g, " ").trim().toLocaleLowerCase("el");

/**
 * Takes myClass' background hits out of eClass' usage rows (one portal at a time).
 * A hit matches the row of the same day, course (by `courseKey`) and tool (by title, Greek or
 * English). Visits never drop below zero; seconds never drop below zero either, and a negative
 * `seconds` gives time back to the student's own row. Background hits without a matching row
 * (unknown course title, tool or day) are left alone and reported as `unmatchedVisits`.
 */
export function subtractBackground(
  rows: UsageRow[],
  hits: BackgroundHit[],
  toolTitles: Record<number, string[]>,
): { rows: UsageRow[]; removedVisits: number; removedSeconds: number; unmatchedVisits: number } {
  const out = rows.map((r) => ({ ...r }));
  const index = new Map<string, UsageRow[]>();
  for (const r of out) {
    const k = `${r.day}|${courseKey(r.course)}|${toolKey(r.tool)}`;
    const list = index.get(k);
    if (list) list.push(r);
    else index.set(k, [r]);
  }

  let removedVisits = 0;
  let removedSeconds = 0;
  let unmatchedVisits = 0;
  for (const h of hits) {
    const titles = toolTitles[h.moduleId] ?? [];
    const candidates =
      h.course === undefined
        ? []
        : titles.flatMap((t) => index.get(`${h.day}|${courseKey(h.course!)}|${toolKey(t)}`) ?? []);
    if (candidates.length === 0) {
      unmatchedVisits += Math.max(0, h.hits);
      continue;
    }
    let visitsLeft = Math.max(0, h.hits);
    let secondsLeft = h.seconds;
    for (const r of candidates) {
      const v = Math.min(r.visits, visitsLeft);
      r.visits -= v;
      visitsLeft -= v;
      removedVisits += v;
      // Positive: take away, at most what the row has. Negative: give back to this row.
      const s = secondsLeft > 0 ? Math.min(r.seconds, secondsLeft) : secondsLeft;
      r.seconds -= s;
      secondsLeft -= s;
      removedSeconds += s;
      if (visitsLeft === 0 && secondsLeft <= 0) break;
    }
    unmatchedVisits += visitsLeft;
  }
  return {
    rows: out.filter((r) => r.visits > 0 || r.seconds > 0),
    removedVisits,
    removedSeconds,
    unmatchedVisits,
  };
}

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Open eClass wants `Y-n-j` dates (no zero padding) in its stats requests. */
export const eclassStatsDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** The twelve-month window ending today (the default range of eClass' own stats page). */
export function statsWindow(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  return { start, end };
}

/** Merges usage rows (from every portal) into the numbers the My stats page shows. */
export function aggregateUsage(rows: UsageRow[], now = new Date()): Omit<MyStats, "warnings" | "adjustment"> {
  const { start, end } = statsWindow(now);
  const from = ymd(start);
  const to = ymd(end);
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);

  const months: MyStats["months"] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    months.push({ month: ymd(d).slice(0, 7), visits: 0, seconds: 0 });
  }
  const monthIndex = new Map(months.map((m, i) => [m.month, i]));

  const courses = new Map<string, { title: string; code?: string; visits: number; seconds: number; lastDay: string }>();
  const tools = new Map<string, { name: string; visits: number; seconds: number }>();
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const days = new Set<string>();

  const dayMs = 86_400_000;
  const todayMs = end.getTime();
  const recent = { visits: 0, seconds: 0, prevVisits: 0, prevSeconds: 0 };

  let visits = 0;
  let seconds = 0;
  for (const r of inRange) {
    visits += r.visits;
    seconds += r.seconds;
    if (r.visits > 0 || r.seconds > 0) days.add(r.day);

    const mi = monthIndex.get(r.day.slice(0, 7));
    if (mi !== undefined) {
      months[mi].visits += r.visits;
      months[mi].seconds += r.seconds;
    }

    const [y, m, d] = r.day.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    weekdays[(date.getDay() + 6) % 7] += r.visits;

    const age = Math.round((todayMs - date.getTime()) / dayMs);
    if (age >= 0 && age < 30) {
      recent.visits += r.visits;
      recent.seconds += r.seconds;
    } else if (age >= 30 && age < 60) {
      recent.prevVisits += r.visits;
      recent.prevSeconds += r.seconds;
    }

    if (r.course) {
      const split = splitCourseTitle(r.course);
      const key = split.title.toLocaleLowerCase("el");
      const c = courses.get(key) ?? { title: split.title, code: split.curriculumCode, visits: 0, seconds: 0, lastDay: r.day };
      c.visits += r.visits;
      c.seconds += r.seconds;
      if (r.day > c.lastDay) c.lastDay = r.day;
      courses.set(key, c);
    }
    if (r.tool) {
      const t = tools.get(r.tool) ?? { name: r.tool, visits: 0, seconds: 0 };
      t.visits += r.visits;
      t.seconds += r.seconds;
      tools.set(r.tool, t);
    }
  }

  const courseList = [...courses.values()].sort((a, b) => b.seconds - a.seconds || b.visits - a.visits);
  return {
    from,
    to,
    totals: { visits, seconds, activeDays: days.size, courses: courseList.length },
    recent,
    months,
    courses: courseList,
    tools: [...tools.values()].sort((a, b) => b.visits - a.visits),
    weekdays,
  };
}
