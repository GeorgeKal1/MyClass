import { describe, expect, it } from "vitest";
import { portalsForUser } from "../src/eclass/connector.js";
import { UNIPI } from "../src/eclass/universities.js";
import { resolveUniPiPortalForCourse, splitCourseTitle, UNIPI_DEPARTMENTS } from "../src/eclass/unipi-curriculum.js";

describe("Digital Systems portals", () => {
  it("signs DS undergraduates in to Aristarchus first, then eclass.unipi.gr", () => {
    expect(portalsForUser(UNIPI, "e24098")).toEqual(["https://aristarchus.ds.unipi.gr", "https://eclass.unipi.gr"]);
  });

  it("adds Lefkippos when a DS student picks the MSc catalog", () => {
    expect(portalsForUser(UNIPI, "e24098", "ds-pg")).toEqual([
      "https://aristarchus.ds.unipi.gr",
      "https://eclass.unipi.gr",
      "https://lefkippos.ds.unipi.gr",
    ]);
  });

  it("keeps Informatics on Thales first and ignores other families", () => {
    expect(portalsForUser(UNIPI, "p24046", "ds")).toEqual(["https://thales.cs.unipi.gr", "https://eclass.unipi.gr"]);
    expect(portalsForUser(UNIPI, "o21001")).toEqual(["https://eclass.unipi.gr"]);
  });

  it("crawls Aristarchus for the DS catalog", () => {
    const ds = UNIPI_DEPARTMENTS.find((d) => d.id === "ds")!;
    expect(ds.sources.some((s) => s.portal === "aristarchus")).toBe(true);
    expect(resolveUniPiPortalForCourse("DS-COURSES-SEM103")).toBe("aristarchus");
    expect(resolveUniPiPortalForCourse("DSERV104")).toBe("lefkippos");
    expect(resolveUniPiPortalForCourse("TMA117")).toBe("thales");
  });

  it("splits DS course titles into title, curriculum code and semester", () => {
    expect(splitCourseTitle("[Α] - (ΨΣ-014) - Λογική και Λογικός Προγραμματισμός")).toEqual({
      title: "Λογική και Λογικός Προγραμματισμός",
      curriculumCode: "ΨΣ-014",
      semesterIndex: 1,
    });
    expect(splitCourseTitle("[ΣΤ] - (ΨΣ-304) - Ασύρματες Επικοινωνίες").semesterIndex).toBe(6);
    expect(splitCourseTitle("[E] - (ΨΣ-412) - Κβαντική Υπολογιστική").semesterIndex).toBe(5);
    expect(splitCourseTitle("[Α] - Εργαστήρια 1ου εξαμήνου")).toEqual({ title: "Εργαστήρια 1ου εξαμήνου", curriculumCode: undefined, semesterIndex: 1 });
    expect(splitCourseTitle("(Γ) - (ΨΣ-708-ΠΔΙ) - Εκπαιδευτική Ψυχολογία")).toEqual({ title: "Εκπαιδευτική Ψυχολογία", curriculumCode: "ΨΣ-708-ΠΔΙ", semesterIndex: 3 });
    expect(splitCourseTitle("[Α] - (ΨΣ-ΤΝ-131) Ευφυείς Πράκτορες").title).toBe("Ευφυείς Πράκτορες");
    expect(splitCourseTitle("(Lab) Something")).toEqual({ title: "(Lab) Something" });
    expect(splitCourseTitle("ΑΝΤΙΚΕΙΜΕΝΟΣΤΡΕΦΗΣ ΠΡΟΓΡΑΜΜΑΤΙΣΜΟΣ (JAVA)")).toEqual({ title: "ΑΝΤΙΚΕΙΜΕΝΟΣΤΡΕΦΗΣ ΠΡΟΓΡΑΜΜΑΤΙΣΜΟΣ (JAVA)" });
  });
});

import { isLoggedOutPage } from "../src/eclass/parsers.js";

describe("logged-out detection", () => {
  it("ignores hidden guest-access inputs on catalog pages", () => {
    const guest = `<form method='post' action='/'><input type='hidden' name='uname' value='guestODE138'><input type='hidden' name='pass' value=''></form>`;
    expect(isLoggedOutPage("https://eclass.unipi.gr/modules/auth/courses.php?fc=64", guest)).toBe(false);
    const login = `<form><input type="text" name="uname"><input type="password" name="pass"></form>`;
    expect(isLoggedOutPage("https://eclass.unipi.gr/", login)).toBe(true);
  });
});
