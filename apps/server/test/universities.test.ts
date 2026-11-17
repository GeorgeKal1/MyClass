import { describe, expect, it } from "vitest";
import { detectUniversityId } from "@myclass/shared";
import { getUniversity, UNIVERSITIES } from "../src/eclass/universities.js";

describe("detectUniversityId", () => {
  it.each([
    ["p24046", "unipi"],
    ["e21012", "unipi"],
    ["P24046", "unipi"],
    ["sdi2100123", "uoa"],
    ["icsd21001", "aegean"],
    ["dpsd20012", "aegean"],
    ["iis21001", "uom"],
    ["student@aegean.gr", "aegean"],
    ["someone@icsd.aegean.gr", "aegean"],
    ["someone@uoi.gr", "uoi"],
    ["x@unipi.gr", "unipi"],
  ])("%s -> %s", (username, expected) => {
    expect(detectUniversityId(username)).toBe(expected);
  });

  it.each(["", "john", "abc123", "someone@gmail.com", "someone@auth.gr"])(
    "returns null for ambiguous username %j",
    (username) => {
      expect(detectUniversityId(username)).toBeNull();
    },
  );

  it("only returns universities that exist in the registry", () => {
    const samples = ["p24046", "sdi2100123", "icsd21001", "iis21001", "ice12345", "el12345", "a@uoi.gr", "a@hmu.gr"];
    for (const u of samples) {
      const id = detectUniversityId(u);
      expect(id && getUniversity(id), `${u} -> ${id}`).toBeTruthy();
    }
  });
});

describe("university registry", () => {
  it("includes the University of the Aegean", () => {
    expect(getUniversity("aegean")?.eclassUrl).toBe("https://eclass.aegean.gr");
  });

  it("has unique ids and https eClass URLs without trailing slash", () => {
    const ids = UNIVERSITIES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const u of UNIVERSITIES) {
      expect(u.eclassUrl).toMatch(/^https:\/\/[^/]+$/);
    }
  });
});
