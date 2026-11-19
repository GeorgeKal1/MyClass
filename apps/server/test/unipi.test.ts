import { describe, expect, it } from "vitest";
import { rankGeminiModels } from "../src/gemini-models.js";
import {
  detectUniPiDepartmentFromUsername,
  hasPastAcademicYearTag,
  isPastExamRoom,
  UNIPI_DEPARTMENTS,
} from "../src/eclass/unipi-curriculum.js";

describe("Gemini model ranking", () => {
  it("prefers the newest stable Flash-Lite, then Flash, then aliases", () => {
    const ranked = rankGeminiModels([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-2.5-flash-image",
      "gemini-flash-latest",
      "gemini-2.5-flash-preview-tts",
      "text-embedding-004",
    ]);
    expect(ranked.slice(0, 4)).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest"]);
    expect(ranked).not.toContain("gemini-2.5-pro");
    expect(ranked).not.toContain("gemini-2.5-flash-image");
    expect(ranked).not.toContain("gemini-2.5-flash-preview-tts");
  });
});

describe("University of Piraeus departments", () => {
  it("covers all eleven departments of eclass.unipi.gr", () => {
    const centralFcs = UNIPI_DEPARTMENTS.flatMap((d) => d.sources.filter((s) => s.portal === "central").map((s) => s.fc));
    for (const fc of [6, 7, 8, 9, 10, 11, 44, 14, 58]) expect(centralFcs).toContain(fc);
    expect(UNIPI_DEPARTMENTS.some((d) => d.id === "cs-ug")).toBe(true);
  });

  it.each([
    ["p24046", "cs-ug"],
    ["e21012", "ds"],
    ["P24046", "cs-ug"],
  ])("%s -> %s", (u, dept) => {
    expect(detectUniPiDepartmentFromUsername(u)).toBe(dept);
  });

  it("flags old exam rooms as past-year catalog entries", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(hasPastAcademicYearTag("(ΨΣ-501) - ΓΛΩΣΣΑ ΠΡΟΓΡΑΜΜΑΤΙΣΜΟΥ C - ΕΞΕΤΑΣΗ ΦΕΒΡ2024", now)).toBe(true);
    expect(hasPastAcademicYearTag("ΑΝΤΙΚΕΙΜΕΝΟΣΤΡΕΦΗΣ ΠΡΟΓΡΑΜΜΑΤΙΣΜΟΣ", now)).toBe(false);
    expect(isPastExamRoom("[ΨΣ-507]-ΤΕΧΝΟΛΟΓΙΑ ΛΟΓΙΣΜΙΚΟΥ - Εξετάσεις Φεβρ.24", now)).toBe(true);
    expect(isPastExamRoom("ΔΙΑΚΡΙΤΑ ΜΑΘΗΜΑΤΙΚΑ - ΕΜΒΟΛΙΜΗ ΕΞΕΤΑΣΗ [ΦΕΒ 2024]", now)).toBe(true);
    expect(isPastExamRoom("Εξετάσεις Φεβρ.27", now)).toBe(false);
    expect(isPastExamRoom("εξεταση γραμμικής άλγεβρας 4/3/2024 15,45", now)).toBe(true);
    expect(isPastExamRoom("ΑΝΤΙΚΕΙΜΕΝΟΣΤΡΕΦΗΣ ΠΡΟΓΡΑΜΜΑΤΙΣΜΟΣ", now)).toBe(false);
  });
});
