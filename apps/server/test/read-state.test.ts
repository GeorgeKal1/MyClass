import type { NotificationItem } from "@myclass/shared";
import { describe, expect, it } from "vitest";
import { markMessageRead } from "../src/read-state.js";
import type { UserRecord } from "../src/store.js";

const notif = (id: string, extra: Partial<NotificationItem>): NotificationItem => ({
  id,
  kind: "message",
  title: "",
  body: "",
  date: "2026-11-20T10:00:00.000Z",
  read: false,
  ...extra,
});

const user = (notifications: NotificationItem[], readMessages?: string[]) =>
  ({ notifications, readMessages }) as unknown as UserRecord;

describe("opening a message", () => {
  it("remembers it as read and clears its notification, leaving the others", () => {
    const rec = user([
      notif("a", { messageId: "101", title: "Καθ. Παπαδόπουλος: Εργασία 2" }),
      notif("b", { messageId: "102", title: "Γραμματεία: Εξεταστική" }),
      notif("c", { kind: "announcement", title: "ΑΝΑΛΥΣΗ Ι: Ανακοίνωση" }),
    ]);
    markMessageRead(rec, { id: "101", sender: "Καθ. Παπαδόπουλος", subject: "Εργασία 2" });
    expect(rec.readMessages).toEqual(["101"]);
    expect(rec.notifications.map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("clears notifications made before they carried a message id, by sender and subject", () => {
    const rec = user([notif("old", { title: "Γραμματεία: Εξεταστική" }), notif("other", { title: "Γραμματεία: Άλλο" })]);
    markMessageRead(rec, { id: "7", sender: "Γραμματεία", subject: "Εξεταστική" });
    expect(rec.notifications.map((n) => n.id)).toEqual(["other"]);
  });

  it("keeps each id once and only the newest 500", () => {
    const rec = user([], Array.from({ length: 500 }, (_, i) => String(i)));
    markMessageRead(rec, { id: "3", sender: "x", subject: "y" });
    expect(rec.readMessages).toHaveLength(500);
    expect(rec.readMessages!.at(-1)).toBe("3");
    markMessageRead(rec, { id: "new", sender: "x", subject: "y" });
    expect(rec.readMessages).toHaveLength(500);
    expect(rec.readMessages![0]).toBe("1");
  });
});
