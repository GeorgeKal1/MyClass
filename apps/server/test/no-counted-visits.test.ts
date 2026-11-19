import { describe, expect, it } from "vitest";
import { CountedVisitBlockedError, EclassHttp } from "../src/eclass/http.js";
import { parseCalendarDeadlines } from "../src/eclass/parsers.js";
import { eclassHitFor, withOrigin } from "../src/eclass/request-origin.js";

// myClass must never add to a student's eClass usage log on its own (background checks)
describe("no counted visits in the background", () => {
  it("refuses background requests to pages eClass logs as course visits, before sending them", async () => {
    const http = new EclassHttp();
    for (const url of [
      "https://eclass.unipi.gr/modules/work/index.php?course=NAS131",
      "https://eclass.unipi.gr/modules/announcements/index.php?course=NAS131",
      "https://eclass.unipi.gr/modules/document/index.php?course=NAS131",
      "https://eclass.unipi.gr/modules/document/file.php/NAS131/a.pdf",
      "https://eclass.unipi.gr/courses/NAS131/",
    ]) {
      await expect(withOrigin("background", () => http.request(url))).rejects.toBeInstanceOf(CountedVisitBlockedError);
    }
  });

  it("uses only pages eClass does not log for background checks", () => {
    for (const url of [
      "https://eclass.unipi.gr/main/calendar_data.php?from=1&to=2",
      "https://eclass.unipi.gr/modules/announcements/myannouncements.php",
      "https://eclass.unipi.gr/modules/message/ajax_handler.php",
      "https://eclass.unipi.gr/main/my_courses.php?term=",
    ]) {
      expect(eclassHitFor(url)).toBeNull();
    }
  });

  it("reads assignment deadlines from the personal calendar feed", () => {
    const json = JSON.stringify({
      success: 1,
      result: [
        {
          id: "42",
          title: "ΠΠΣ: Τεχνολογία Πλοίου: 1η Εργασία &amp; παρουσίαση",
          start: Date.UTC(2026, 10, 26, 21, 59),
          event_type: "assignment",
          event_group: "deadline",
          course: "NAS126",
          url: "https://eclass.unipi.gr/modules/work/index.php?id=42&course=NAS126",
        },
        { id: "7", title: "Personal", start: 0, event_type: "personal", course: null },
      ],
      cid: null,
    });
    const list = parseCalendarDeadlines(json, "https://eclass.unipi.gr/main/calendar_data.php", {
      NAS126: ["ΠΠΣ: Τεχνολογία Πλοίου", "Τεχνολογία Πλοίου"],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "NAS126:42",
      courseCode: "NAS126",
      courseTitle: "Τεχνολογία Πλοίου",
      title: "1η Εργασία & παρουσίαση",
      deadline: "2026-11-26T21:59:00.000Z",
      submitted: false,
    });
  });
});
