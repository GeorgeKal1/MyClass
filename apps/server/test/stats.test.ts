import { describe, expect, it } from "vitest";
import { aggregateUsage, eclassStatsDate, parseUsageDetails } from "../src/stats.js";

describe("My stats", () => {
  const now = new Date(2026, 10, 18); // 18 Nov 2026

  it("parses eClass usage detail rows and skips junk", () => {
    const rows = parseUsageDetails([
      ["2026-11-17", "[Α] - (ΨΣ-014) - Λογική", "<b>Έγγραφα</b>", "4", "620"],
      ["not a date", "x", "y", 1, 1],
      "garbage",
    ]);
    expect(rows).toEqual([{ day: "2026-11-17", course: "[Α] - (ΨΣ-014) - Λογική", tool: "Έγγραφα", visits: 4, seconds: 620 }]);
  });

  it("uses eClass' unpadded date format", () => {
    expect(eclassStatsDate(new Date(2026, 0, 5))).toBe("2026-1-5");
  });

  it("merges portals into months, courses, tools, weekdays and the last 30 days", () => {
    const stats = aggregateUsage(
      [
        { day: "2026-11-16", course: "[Α] - (ΨΣ-014) - Λογική", tool: "Έγγραφα", visits: 3, seconds: 600 }, // Monday
        { day: "2026-11-16", course: "Λογική", tool: "Ανακοινώσεις", visits: 1, seconds: 60 },
        { day: "2026-10-01", course: "Βάσεις Δεδομένων", tool: "Έγγραφα", visits: 5, seconds: 1200 }, // 48 days ago
        { day: "2024-01-01", course: "Old", tool: "Έγγραφα", visits: 99, seconds: 9999 }, // outside the window
      ],
      now,
    );
    expect(stats.from).toBe("2025-12-01");
    expect(stats.to).toBe("2026-11-18");
    expect(stats.months).toHaveLength(12);
    expect(stats.months.at(-1)).toEqual({ month: "2026-11", visits: 4, seconds: 660 });
    expect(stats.totals).toEqual({ visits: 9, seconds: 1860, activeDays: 2, courses: 2 });
    expect(stats.courses[0]).toMatchObject({ title: "Βάσεις Δεδομένων", seconds: 1200 });
    expect(stats.courses[1]).toMatchObject({ title: "Λογική", code: "ΨΣ-014", visits: 4, seconds: 660, lastDay: "2026-11-16" });
    expect(stats.tools[0]).toMatchObject({ name: "Έγγραφα", visits: 8 });
    expect(stats.weekdays[0]).toBe(4);
    expect(stats.recent).toEqual({ visits: 4, seconds: 660, prevVisits: 5, prevSeconds: 1200 });
  });
});
