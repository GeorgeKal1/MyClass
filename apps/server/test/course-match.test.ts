import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CatalogCourse, Course } from "@myclass/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { codeKey, courseTokens, rankCourseMatches, resolveCourse, textMatchesQuery } from "../src/eclass/course-match.js";

// ai.ts pulls in the store and env, which read these at import time
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "myclass-test-"));

type Ai = typeof import("../src/ai.js");
let ai: Ai;
beforeAll(async () => {
  ai = await import("../src/ai.js");
});

const course = (code: string, title: string, extra: Partial<CatalogCourse> = {}): CatalogCourse => ({
  code,
  publicCode: code,
  title,
  numericId: Number(code.replace(/\D/g, "")) || 1,
  enrolled: false,
  departmentId: "cs-ug",
  ...extra,
});

// Informatics first-year catalog as eClass titles it (capitals, Greek Ι for the numeral)
const CATALOG: CatalogCourse[] = [
  course("TMA117", "ΑΝΑΛΥΣΗ Ι"),
  course("TMA120", "ΑΝΑΛΥΣΗ ΙΙ"),
  course("TMC123", "Ανάλυση Δεδομένων"),
  course("TMA101", "Αριθμητική Ανάλυση"),
  course("TMC106", "Βάσεις Δεδομένων"),
  course("TMA102", "Γραμμική Άλγεβρα"),
];

describe("course name matching", () => {
  it("folds accents, final sigma and numerals so typed names meet eClass titles", () => {
    expect(courseTokens("ΑΝΑΛΥΣΗ Ι")).toEqual(["αναλυση", "1"]);
    expect(courseTokens("Ανάλυση 1")).toEqual(["αναλυση", "1"]);
    expect(courseTokens("ανάλυση ένα")).toEqual(["αναλυση", "1"]);
    expect(courseTokens("Analysis II")).toEqual(["analysis", "2"]);
    expect(courseTokens("Βάσεις")).toEqual(["βασεισ"]);
  });

  it("reads Greek capitals typed in a course code as the Latin letters eClass uses", () => {
    expect(codeKey("ΤΜΑ117")).toBe("TMA117");
    expect(codeKey("tma 117")).toBe("TMA117");
  });

  it("matches every word of the query, numerals exactly", () => {
    expect(textMatchesQuery("ΑΝΑΛΥΣΗ Ι", "ανάλυση 1")).toBe(true);
    expect(textMatchesQuery("ΑΝΑΛΥΣΗ ΙΙ", "ανάλυση 1")).toBe(false);
    expect(textMatchesQuery("Βάσεις Δεδομένων", "βασεις")).toBe(true);
    expect(textMatchesQuery("Βάσεις Δεδομένων", "μάθημα")).toBe(false);
  });
});

describe("resolving the course a student means", () => {
  it.each([
    ["Ανάλυση 1"],
    ["ανάλυση ένα"],
    ["αναλυση Ι"],
    ["ΑΝΑΛΥΣΗ Ι"],
    ["TMA117"],
    ["tma117"],
    ["ΤΜΑ117"],
  ])("%s → ΑΝΑΛΥΣΗ Ι (TMA117)", (query) => {
    const res = resolveCourse(CATALOG, query);
    expect(res.status).toBe("found");
    expect(res.status === "found" && res.course.code).toBe("TMA117");
  });

  it("asks which one when a name fits several courses", () => {
    const res = resolveCourse(CATALOG, "ανάλυση");
    expect(res.status).toBe("ambiguous");
    expect(res.status === "ambiguous" && res.candidates.map((c) => c.code)).toEqual(
      expect.arrayContaining(["TMA117", "TMA120", "TMC123", "TMA101"]),
    );
  });

  it("prefers the title that is exactly the query over longer ones", () => {
    const withLab = [...CATALOG, course("TMA118", "ΑΝΑΛΥΣΗ Ι - ΦΡΟΝΤΙΣΤΗΡΙΟ")];
    expect(rankCourseMatches(withLab, "ανάλυση 1")[0].code).toBe("TMA117");
    const res = resolveCourse(withLab, "ανάλυση 1");
    expect(res.status === "found" && res.course.code).toBe("TMA117");
  });

  it("says not found, with similar courses, instead of picking something", () => {
    const res = resolveCourse(CATALOG, "Ανάλυση 3");
    expect(res.status).toBe("not_found");
    expect(res.status === "not_found" && res.suggestions.length).toBeGreaterThan(0);
    expect(resolveCourse(CATALOG, "Κβαντική Φυσική")).toEqual({ status: "not_found", suggestions: [] });
  });
});

describe("assistant: checking a join before the confirmation card", () => {
  const lookup = (catalog: CatalogCourse[], enrolled: Course[] = []) => ({
    findCatalogCourse: async (q: string) => resolveCourse(catalog, q),
    listCourses: async () => enrolled,
  });

  it("turns the student's words into one resolved course for the card", async () => {
    const out = await ai.prepareMutatingAction(lookup(CATALOG), "enroll_course", { course: "ανάλυση ένα" });
    expect(out).toEqual({ args: { course: "TMA117", departmentId: "cs-ug", title: "ΑΝΑΛΥΣΗ Ι", code: "TMA117" } });
  });

  it("hands candidates back to the assistant instead of a card when the name is ambiguous", async () => {
    const out = await ai.prepareMutatingAction(lookup(CATALOG), "enroll_course", { course: "Ανάλυση" });
    expect("reply" in out && out.reply.candidates).toHaveLength(4);
  });

  it("tells the assistant, without a card, about a course that isn't there or can't be joined", async () => {
    const notFound = await ai.prepareMutatingAction(lookup(CATALOG), "enroll_course", { course: "Κβαντική Φυσική" });
    expect("reply" in notFound && String(notFound.reply.error)).toMatch(/No catalog course matches/);

    const closed = [course("TMA117", "ΑΝΑΛΥΣΗ Ι", { locked: true })];
    const locked = await ai.prepareMutatingAction(lookup(closed), "enroll_course", { course: "TMA117" });
    expect("reply" in locked && String(locked.reply.error)).toMatch(/closed/);

    const coded = [course("TMA117", "ΑΝΑΛΥΣΗ Ι", { needsPassword: true })];
    const password = await ai.prepareMutatingAction(lookup(coded), "enroll_course", { course: "TMA117" });
    expect("reply" in password && String(password.reply.error)).toMatch(/registration code/);

    const mine = [course("TMA117", "ΑΝΑΛΥΣΗ Ι", { enrolled: true })];
    const already = await ai.prepareMutatingAction(lookup(mine), "enroll_course", { course: "TMA117" });
    expect("reply" in already && String(already.reply.result)).toMatch(/already enrolled/);
  });

  it("resolves leaving a course against the enrolled list", async () => {
    const enrolled: Course[] = [{ code: "TMC106", title: "Βάσεις Δεδομένων", enrolled: true }];
    const ok = await ai.prepareMutatingAction(lookup(CATALOG, enrolled), "unenroll_course", { course: "βάσεις" });
    expect(ok).toEqual({ args: { course: "TMC106", title: "Βάσεις Δεδομένων", code: "TMC106" } });
    const missing = await ai.prepareMutatingAction(lookup(CATALOG, enrolled), "unenroll_course", { course: "Ανάλυση 1" });
    expect("reply" in missing).toBe(true);
  });
});
