import { describe, expect, it } from "vitest";
import {
  curriculumSemester,
  ELECTIVES_INDEX,
  isPostgraduatePath,
  normalizeCourseTitle,
} from "../src/eclass/unipi-curricula.js";

// Real titles from the eclass.unipi.gr catalog (2026-11-19), which has no semester folders for these departments
describe("department curricula", () => {
  it("normalizes case, accents and Greek/Latin roman numerals", () => {
    expect(normalizeCourseTitle("ΜΑΘΗΜΑΤΙΚΑ II")).toBe(normalizeCourseTitle("Μαθηματικά ΙΙ"));
    expect(normalizeCourseTitle("Ναυτιλία & Μεταφορές")).toBe("ναυτιλια και μεταφορεσ");
  });

  it("places Maritime Studies courses from the study guide", () => {
    const sem = (title: string, publicCode?: string) => curriculumSemester("nas", { code: "NAS000", publicCode, title });
    expect(sem("Ναυτικό Δίκαιο")).toBe(2);
    expect(sem("Συστήματα Πλοίου (Ακαδημαϊκό έτος 2026-2027)")).toBe(3);
    expect(sem("Οργάνωση και Διοίκηση Ναυτιλιακών Επιχειρήσεων Ακαδημαϊκό Έτος 2025-2026")).toBe(4);
    expect(sem("Shipping Pollution / Ναυτιλιακή Ρύπανση")).toBe(8);
    expect(sem("ΝΑ 409 Διαχείριση Λειτουργιών Λιμενικών και Τερματικών Εγκαταστάσεων")).toBe(4);
    expect(sem("Commodity Trading 2026 - 2027")).toBe(5);
    expect(sem("ΜΗΤΡΩΑ Ν22 (ΝΑΥ)")).toBeUndefined();
  });

  it("keeps numbered courses apart (Ι vs ΙΙ)", () => {
    expect(curriculumSemester("econ", { code: "OEP1", title: "ΜΑΘΗΜΑΤΙΚΑ I" })).toBe(1);
    expect(curriculumSemester("econ", { code: "OEP2", title: "ΜΑΘΗΜΑΤΙΚΑ II" })).toBe(2);
    expect(curriculumSemester("econ", { code: "OEP3", title: "Μικροοικονομική Θεωρία Ι - ΤΜΗΜΑ Α'" })).toBe(3);
  });

  it("uses curriculum codes where the department publishes them", () => {
    expect(curriculumSemester("stat", { code: "SAE261", publicCode: "ΣΑΣΤΑ47-17", title: "Ανάλυση Χρονοσειρών (εξεταστέα ύλη)" })).toBe(6);
    expect(curriculumSemester("tou", { code: "TOY102", title: "Οικονομική Επιστήμη" })).toBe(1);
    expect(curriculumSemester("tou", { code: "ΤΣΚ802", title: "Μελέτες Σκοπιμότητας" })).toBe(8);
    expect(curriculumSemester("tou", { code: "TOY254", publicCode: "ΤΣΚ623", title: "Εξόρυξη Δεδομένων (Επ.)" })).toBe(ELECTIVES_INDEX);
  });

  it("marks elective pools and leaves unknown departments alone", () => {
    expect(curriculumSemester("fin", { code: "XTD1", title: "Θεωρία Παιγνίων" })).toBe(ELECTIVES_INDEX);
    expect(curriculumSemester("cs", { code: "TMA101", title: "Μαθηματικά Ι" })).toBeUndefined();
  });

  it("recognizes postgraduate programme folders", () => {
    expect(isPostgraduatePath(["Τμήμα Ναυτιλιακών Σπουδών", "ΠΜΣ στη Ναυτιλία"])).toBe(true);
    expect(isPostgraduatePath(["Τμήμα Ναυτιλιακών Σπουδών", "M.Sc. Shipping Management"])).toBe(true);
    expect(isPostgraduatePath(["Τμήμα Οικονομικής Επιστήμης", "Μεταπτυχιακό"])).toBe(true);
    expect(isPostgraduatePath(["Τμήμα Ναυτιλιακών Σπουδών", "Προπτυχιακό"])).toBe(false);
  });
});
