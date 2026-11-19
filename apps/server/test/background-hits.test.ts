import { describe, expect, it } from "vitest";
import { eclassDay, stepTimeline, type CourseDayTimeline, type HitDelta } from "../src/eclass/hit-ledger.js";
import { currentOrigin, ECLASS_MODULES, eclassHitFor, withOrigin } from "../src/eclass/request-origin.js";
import { aggregateUsage, parseUsageDetails, subtractBackground, type BackgroundHit } from "../src/stats.js";

const LOGIC = "[Α] - (ΨΣ-014) - Λογική";
const DB = "Βάσεις Δεδομένων";

/** Rows exactly as `results.php?t=ud` returns them: [day, courseTitle, toolTitle, hits, durationSeconds]. */
const usage = parseUsageDetails([
  ["2026-11-16", LOGIC, "Εργασίες", "40", "36000"],
  ["2026-11-16", LOGIC, "Έγγραφα", "3", "600"],
  ["2026-11-16", DB, "Εργασίες", "2", "1800"],
  ["2026-11-17", LOGIC, "Εργασίες", "5", "4500"],
]);

const hit = (h: Partial<BackgroundHit>): BackgroundHit => ({
  day: "2026-11-16",
  course: LOGIC,
  moduleId: 5,
  hits: 0,
  seconds: 0,
  ...h,
});

describe("subtracting myClass' background hits from eClass usage rows", () => {
  it("leaves rows untouched with an empty history", () => {
    const res = subtractBackground(usage, [], ECLASS_MODULES);
    expect(res.rows).toEqual(usage);
    expect(res).toMatchObject({ removedVisits: 0, removedSeconds: 0, unmatchedVisits: 0 });
  });

  it("matches by day, course and tool only", () => {
    const res = subtractBackground(usage, [hit({ hits: 38, seconds: 34200 })], ECLASS_MODULES);
    expect(res.rows).toEqual([
      { day: "2026-11-16", course: LOGIC, tool: "Εργασίες", visits: 2, seconds: 1800 },
      // same day and course, other tool: untouched
      { day: "2026-11-16", course: LOGIC, tool: "Έγγραφα", visits: 3, seconds: 600 },
      // same day and tool, other course: untouched
      { day: "2026-11-16", course: DB, tool: "Εργασίες", visits: 2, seconds: 1800 },
      // same course and tool, other day: untouched
      { day: "2026-11-17", course: LOGIC, tool: "Εργασίες", visits: 5, seconds: 4500 },
    ]);
    expect(res.removedVisits).toBe(38);
    expect(res.removedSeconds).toBe(34200);
  });

  it("matches a decorated eClass title against the plain one, and English tool names", () => {
    const rows = parseUsageDetails([["2026-11-16", "Λογική", "Assignments", 4, 3600]]);
    const res = subtractBackground(rows, [hit({ course: LOGIC, hits: 4, seconds: 3600 })], ECLASS_MODULES);
    expect(res.rows).toEqual([]);
    expect(res.removedVisits).toBe(4);
  });

  it("never goes below zero and drops rows that end up empty", () => {
    const res = subtractBackground(usage, [hit({ hits: 99, seconds: 99_999 })], ECLASS_MODULES);
    expect(res.rows.find((r) => r.course === LOGIC && r.tool === "Εργασίες" && r.day === "2026-11-16")).toBeUndefined();
    expect(res.removedVisits).toBe(40);
    expect(res.removedSeconds).toBe(36000);
    expect(res.unmatchedVisits).toBe(59);
    for (const r of res.rows) {
      expect(r.visits).toBeGreaterThanOrEqual(0);
      expect(r.seconds).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives time back to the student's own row when a background hit cut it short", () => {
    const res = subtractBackground(usage, [hit({ moduleId: 3, hits: 0, seconds: -600 })], ECLASS_MODULES);
    expect(res.rows.find((r) => r.tool === "Έγγραφα")).toMatchObject({ visits: 3, seconds: 1200 });
    expect(res.removedSeconds).toBe(-600);
  });

  it("reports hits with no matching row instead of guessing", () => {
    const res = subtractBackground(
      usage,
      [
        hit({ day: "2026-11-01", hits: 2, seconds: 1800 }), // no row that day
        hit({ course: "Άγνωστο μάθημα", hits: 1, seconds: 900 }), // unknown course
        hit({ course: undefined, hits: 1, seconds: 900 }), // course never listed
        hit({ moduleId: 999, hits: 1, seconds: 900 }), // unknown tool
      ],
      ECLASS_MODULES,
    );
    expect(res.rows).toEqual(usage);
    expect(res).toMatchObject({ removedVisits: 0, removedSeconds: 0, unmatchedVisits: 5 });
  });

  it("feeds the corrected rows into the page numbers", () => {
    const { rows } = subtractBackground(usage, [hit({ hits: 40, seconds: 36000 })], ECLASS_MODULES);
    const stats = aggregateUsage(rows, new Date(2026, 10, 18));
    expect(stats.totals.visits).toBe(10);
    expect(stats.tools.find((t) => t.name === "Εργασίες")).toMatchObject({ visits: 7, seconds: 6300 });
  });
});

describe("replaying eClass' duration rule (include/action.php)", () => {
  const t0 = Date.UTC(2026, 10, 16, 8, 0, 0);
  const min = 60_000;
  const replay = (hits: Array<{ at: number; moduleId: number; automated: boolean }>) => {
    let state: CourseDayTimeline | undefined;
    const total = new Map<number, { hits: number; seconds: number }>();
    for (const h of hits) {
      const step = stepTimeline(state, { day: "2026-11-16", ...h });
      state = step.state;
      for (const d of step.deltas as HitDelta[]) {
        const cur = total.get(d.moduleId) ?? { hits: 0, seconds: 0 };
        total.set(d.moduleId, { hits: cur.hits + d.hits, seconds: cur.seconds + d.seconds });
      }
    }
    return Object.fromEntries(total);
  };

  it("counts each 15-minute background check as one hit and 900 s", () => {
    const checks = [0, 15, 30, 45].map((m) => ({ at: t0 + m * min + 5_000 * m, moduleId: 5, automated: true }));
    expect(replay(checks)).toEqual({ 5: { hits: 4, seconds: 3600 } });
  });

  it("checks 5 minutes apart only add the gap", () => {
    const checks = [0, 5, 10].map((m) => ({ at: t0 + m * min, moduleId: 5, automated: true }));
    // 300 + 300 + 900 (the last one of the day keeps the full 900)
    expect(replay(checks)).toEqual({ 5: { hits: 3, seconds: 1500 } });
  });

  it("gives back time a background check took from the student's own visit", () => {
    // Student opens Documents, a check lands 5 minutes later, the student comes back 30 minutes later
    const res = replay([
      { at: t0, moduleId: 3, automated: false },
      { at: t0 + 5 * min, moduleId: 5, automated: true },
      { at: t0 + 35 * min, moduleId: 3, automated: false },
    ]);
    // eClass: Documents 300 + 900, Assignments 900. Without the check: Documents 900 + 900.
    expect(res).toEqual({ 3: { hits: 0, seconds: -600 }, 5: { hits: 1, seconds: 900 } });
  });

  it("splits a gap correctly when the student returns quickly", () => {
    const res = replay([
      { at: t0, moduleId: 3, automated: false },
      { at: t0 + 5 * min, moduleId: 5, automated: true },
      { at: t0 + 10 * min, moduleId: 3, automated: false },
    ]);
    // eClass: Documents 300 (+900 for the return), Assignments 300. Without: Documents 600 (+900).
    expect(res).toEqual({ 3: { hits: 0, seconds: -300 }, 5: { hits: 1, seconds: 300 } });
  });

  it("changes nothing for the student's own visits alone", () => {
    const res = replay([
      { at: t0, moduleId: 3, automated: false },
      { at: t0 + 2 * min, moduleId: 7, automated: false },
      { at: t0 + 40 * min, moduleId: 3, automated: false },
    ]);
    expect(res).toEqual({});
  });

  it("starts over on a new eClass day", () => {
    const first = stepTimeline(undefined, { day: "2026-11-16", at: t0, moduleId: 5, automated: true });
    const next = stepTimeline(first.state, { day: "2026-11-17", at: t0 + 60_000, moduleId: 5, automated: true });
    expect(next.deltas).toEqual([{ moduleId: 5, hits: 1, seconds: 900 }]);
  });
});

describe("which requests eClass logs", () => {
  const base = "https://eclass.unipi.gr";
  it("recognises course pages that call action->record()", () => {
    expect(eclassHitFor(`${base}/modules/work/index.php?course=TMB101`)).toEqual({ courseCode: "TMB101", moduleId: 5 });
    expect(eclassHitFor(`${base}/modules/announcements/index.php?course=TMB101`)).toEqual({ courseCode: "TMB101", moduleId: 7 });
    expect(eclassHitFor(`${base}/modules/document/index.php?course=TMB101&openDir=/x`)).toEqual({ courseCode: "TMB101", moduleId: 3 });
    expect(eclassHitFor(`${base}/modules/document/file.php/TMB101/a/b.pdf`)).toEqual({ courseCode: "TMB101", moduleId: 3 });
    expect(eclassHitFor(`${base}/courses/TMB101/`)).toEqual({ courseCode: "TMB101", moduleId: 27 });
  });

  it("ignores pages without a course", () => {
    for (const path of [
      "/main/portfolio.php",
      "/main/my_courses.php?term=",
      "/modules/announcements/myannouncements.php",
      "/modules/announcements/rss.php?c=TMB101",
      "/modules/message/ajax_handler.php?mbox_type=inbox",
      "/modules/usage/results.php?t=ud&u=1",
      "/modules/auth/cas.php",
      "/modules/work/index.php",
    ]) {
      expect(eclassHitFor(base + path)).toBeNull();
    }
  });

  it("uses eClass' Greek calendar day", () => {
    // 23:30 UTC on 16 Nov is 01:30 on 17 Nov in Athens (UTC+2)
    expect(eclassDay(new Date(Date.UTC(2026, 10, 16, 23, 30)))).toBe("2026-11-17");
    expect(eclassDay(new Date(Date.UTC(2026, 10, 16, 12, 0)))).toBe("2026-11-16");
  });

  it("keeps the request origin across awaits and nests login inside a background check", async () => {
    expect(currentOrigin()).toBe("interactive");
    await withOrigin("background", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentOrigin()).toBe("background");
      await withOrigin("login", async () => {
        await Promise.resolve();
        expect(currentOrigin()).toBe("login");
      });
      expect(currentOrigin()).toBe("background");
    });
    expect(currentOrigin()).toBe("interactive");
  });
});
