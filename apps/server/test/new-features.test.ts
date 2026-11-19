import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The store and env read these at import time: use a throwaway data folder and a small limit
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "myclass-test-"));
process.env.AI_HOURLY_LIMIT = "3";

type Store = typeof import("../src/store.js");
type Quota = typeof import("../src/quota.js");
type Deadlines = typeof import("../src/deadlines.js");
type Ai = typeof import("../src/ai.js");
let store: Store;
let quota: Quota;
let deadlines: Deadlines;
let ai: Ai;

beforeAll(async () => {
  store = await import("../src/store.js");
  quota = await import("../src/quota.js");
  deadlines = await import("../src/deadlines.js");
  ai = await import("../src/ai.js");
});

function makeUser(id: string) {
  const u = store.newUser(id, "unipi", id);
  store.users.upsert(u);
  return store.users.get(id)!;
}

describe("AI quota on the shared key", () => {
  it("allows the hourly limit, then refuses until the oldest request is an hour old", () => {
    const u = makeUser("quota-a");
    const t0 = Date.UTC(2026, 10, 19, 10, 0);
    quota.consumeAiQuota(u, t0);
    quota.consumeAiQuota(u, t0 + 1000);
    quota.consumeAiQuota(u, t0 + 2000);
    expect(quota.quotaFor(u, t0 + 3000)).toMatchObject({ limit: 3, used: 3 });
    expect(() => quota.consumeAiQuota(u, t0 + 3000)).toThrow(quota.AiQuotaError);
    // An hour after the first request one slot is free again
    expect(() => quota.consumeAiQuota(u, t0 + 3_600_000 + 1)).not.toThrow();
  });

  it("gives back a refunded request", () => {
    const u = makeUser("quota-b");
    const t0 = Date.UTC(2026, 10, 19, 10, 0);
    const stamp = quota.consumeAiQuota(u, t0);
    quota.refundAiQuota(u, stamp);
    expect(quota.quotaFor(u, t0 + 1)?.used).toBe(0);
  });

  it("never limits a student who uses their own key", () => {
    const u = makeUser("quota-c");
    store.users.update(u.id, (r) => {
      r.ai.encApiKey = "x";
      r.settings.ai.mode = "apiKey";
    });
    expect(quota.quotaFor(u)).toBeNull();
    for (let i = 0; i < 10; i++) expect(quota.consumeAiQuota(u)).toBeNull();
  });
});

describe("deadline reminders", () => {
  const now = Date.UTC(2026, 10, 19, 12, 0);
  const asg = (id: string, hoursAhead: number, submitted = false) => ({
    id,
    courseCode: "CS101",
    courseTitle: "Λογική",
    title: `Εργασία ${id}`,
    deadline: new Date(now + hoursAhead * 3_600_000).toISOString(),
    submitted,
  });

  it("sends the 24 h reminder, then the 1 h one, each once, and skips submitted work", () => {
    const u = makeUser("rem-a");
    deadlines.rememberDeadlines(u, [asg("a", 20), asg("b", 30), asg("c", 5, true)]);
    const first = deadlines.dueReminders(store.users.get(u.id)!, now);
    expect(first.map((r) => r.key)).toEqual(["a|24h"]);
    expect(first[0].item.kind).toBe("deadline");
    store.users.update(u.id, (r) => (r.remindersSent = first.map((x) => x.key)));
    expect(deadlines.dueReminders(store.users.get(u.id)!, now + 60_000)).toEqual([]);
    const later = deadlines.dueReminders(store.users.get(u.id)!, now + 19.5 * 3_600_000);
    // "b" (30 h out at the start) has meanwhile come inside 24 h
    expect(later.map((r) => r.key)).toEqual(["a|1h", "b|24h"]);
  });

  it("only sends the 1 h reminder for a deadline first seen inside the last hour", () => {
    const u = makeUser("rem-b");
    deadlines.rememberDeadlines(u, [asg("d", 0.5)]);
    expect(deadlines.dueReminders(store.users.get(u.id)!, now).map((r) => r.key)).toEqual(["d|1h"]);
  });

  it("keeps other courses when one course's assignments are reloaded, and marks submissions", () => {
    const u = makeUser("rem-c");
    const later = Date.now() + 10 * 3_600_000;
    const soon = (id: string, courseCode = "CS101") => ({ ...asg(id, 0), courseCode, deadline: new Date(later).toISOString() });
    deadlines.rememberDeadlines(u, [soon("e"), soon("f", "CS202")]);
    // CS202 reloaded with a different list: its old entry goes, CS101 is untouched
    deadlines.rememberDeadlines(u, [soon("g", "CS202")], "CS202");
    expect(store.users.get(u.id)!.deadlines!.map((d) => d.id).sort()).toEqual(["e", "g"]);
    // A course page that came back empty (eClass failure looks the same) keeps its upcoming deadlines
    deadlines.rememberDeadlines(u, [soon("g", "CS202")]);
    expect(store.users.get(u.id)!.deadlines!.map((d) => d.id).sort()).toEqual(["e", "g"]);
    store.users.update(u.id, (r) => (r.deadlines = r.deadlines!.filter((d) => d.id === "e")));
    deadlines.markDeadlineSubmitted(u, "CS101", "e");
    expect(deadlines.upcomingDeadlines(store.users.get(u.id)!, now)).toEqual([]);
  });

  it("builds a valid iCalendar feed with folded lines", () => {
    const u = makeUser("rem-d");
    deadlines.rememberDeadlines(u, [{ ...asg("g", 48), title: "Πολύ μεγάλος τίτλος εργασίας, με κόμμα; και ερωτηματικό που ξεπερνά τα 75 bytes" }]);
    const ics = deadlines.buildDeadlinesIcs(store.users.get(u.id)!, "https://myclass.example", now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("TRIGGER:-PT24H");
    expect(ics).toContain("\\,");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});

describe("announcement triage keywords", () => {
  it("flags deadlines, registrations and cancelled classes as action needed", () => {
    expect(ai.heuristicTriage({ title: "Προθεσμία υποβολής εργασίας", contentText: "" }).label).toBe("action");
    expect(ai.heuristicTriage({ title: "Ακύρωση μαθήματος Τρίτης", contentText: "" }).label).toBe("action");
    expect(ai.heuristicTriage({ title: "Project 2", contentText: "Submission is due Friday" }).label).toBe("action");
    expect(ai.heuristicTriage({ title: "Ανέβηκαν οι διαφάνειες", contentText: "Καλή μελέτη" }).label).toBe("fyi");
  });
});

describe("files sent to the AI", () => {
  it("refuses locked PDFs, uploads big ones, inlines small ones", async () => {
    const { prepareDocumentForAi } = await import("../src/doctext.js");
    const locked = Buffer.from("%PDF-1.6\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>\n%%EOF", "latin1");
    expect(prepareDocumentForAi("a.pdf", "application/pdf", locked, "el")).toMatchObject({ kind: "unsupported" });
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(19 * 1024 * 1024)]);
    expect(prepareDocumentForAi("b.pdf", "application/pdf", big).kind).toBe("upload");
    expect(prepareDocumentForAi("c.pdf", "application/pdf", Buffer.from("%PDF-1.4\n")).kind).toBe("inline");
  });

  it("repairs Greek filenames that arrive as Latin-1 header text", async () => {
    const { fixHeaderUtf8 } = await import("../src/eclass/connector.js");
    const garbled = Buffer.from("Διάλεξη 1.pdf", "utf8").toString("latin1");
    expect(fixHeaderUtf8(garbled)).toBe("Διάλεξη 1.pdf");
    expect(fixHeaderUtf8("lecture.pdf")).toBe("lecture.pdf");
    expect(fixHeaderUtf8("Διάλεξη.pdf")).toBe("Διάλεξη.pdf");
  });
});

describe("study material parsing", () => {
  it("reads fenced JSON and drops invalid quiz questions", () => {
    const raw =
      '```json\n{"questions":[{"question":"2+2?","options":["3","4","5","6"],"answer":1,"explanation":"Arithmetic"},' +
      '{"question":"bad","options":["a"],"answer":3}]}\n```';
    const m = ai.normalizeStudyMaterial("quiz", "lec1.pdf", ai.parseJsonLoose(raw));
    expect(m.kind).toBe("quiz");
    if (m.kind === "quiz") {
      expect(m.questions).toHaveLength(1);
      expect(m.questions[0].answer).toBe(1);
    }
  });

  it("rejects an empty flashcard set", () => {
    expect(() => ai.normalizeStudyMaterial("flashcards", "x", { cards: [] })).toThrow();
  });
});
