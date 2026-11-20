import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * End to end, with a fake Open eClass behind the HTTP layer (undici's fetch is replaced; nothing
 * leaves the machine): the poller, the app's Home/Inbox/Courses/Stats routes, sign-in, every other
 * route and every assistant tool run without the student asking for a course page, and must never
 * send a request eClass would count as a course visit. The student's own actions send exactly one.
 */

const fake = vi.hoisted(() => {
  const sent: Array<{ url: string; method: string }> = [];
  const mode = { announcementsAnswerHtml: false };

  const html = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  const MY_COURSES = `
    <div class='col cardCourse1'><div class='card h-100'>
      <div class='card-header'><a href='https://thales.cs.unipi.gr/courses/TMC106/'>ΚΡΥΠΤΟΓΡΑΦΙΑ</a></div>
      <div class='card-body'><div class='card-text'><p>Κωδικός:</p><p>TMC106</p></div></div>
      <div class='card-footer'><button data-bs-toggle='modal' data-bs-target='#exampleModal34'>Απεγγραφή</button></div>
    </div></div>
    <div class='modal fade' id='exampleModal34'><form method='post' action='/main/unregcours.php?u=7651&amp;cid=34'></form></div>`;
  const DOCS = `
    <div><a href="/modules/document/index.php?course=TMC106&amp;download=ROOTREF"><i class="fa-download"></i></a></div>
    <table id="document_table"><tbody>
      <tr class="visible">
        <td class="checkbox_td"><input type="checkbox" isDir="0" filepath="/Guide.pdf" cbid="2"/></td>
        <td class="fileURL-th">
          <input type="hidden" value="/modules/document/index.php?course=TMC106&amp;download=FILEREF"/>
          <a class="fileModal" href="/modules/document/file.php/TMC106/Guide.pdf">Guide.pdf</a>
        </td>
        <td>420 KB</td><td>12-11-2026</td><td></td>
      </tr>
    </tbody></table>`;
  const ASSIGNMENTS = `
    <table id="assignment_table_TMC106"><tbody><tr>
      <td><a href="/modules/work/index.php?course=TMC106&amp;id=7">RSA Implementation</a></td>
      <td>27-11-2026 23:55</td><td></td><td>-</td>
    </tr></tbody></table>`;
  const CATALOG = `
    <ul><li class="list-group-item element">
      <input type="checkbox" name="selectCourse[]" value="329"/>
      <span class="TextBold">ΑΞΙΟΛΟΓΗΣΗ ΠΡΟΓΡΑΜΜΑΤΩΝ</span><small>(ΠΛΑ01)</small>
      <a href="/modules/auth/info_course.php?c=TMC134">Info</a>
    </li></ul>`;

  function respond(u: URL, method: string): Response {
    const p = u.pathname;
    const q = u.searchParams;
    if (p === "/modules/mobile/midentity.php") return html("not here", 404);
    if (p === "/modules/auth/cas.php") return redirect("/main/portfolio.php");
    if (p === "/main/portfolio.php") return html(`<h4 class="username-text">ΔΟΚΙΜΑΣΤΙΚΟΣ ΦΟΙΤΗΤΗΣ</h4>`);
    if (p === "/main/my_courses.php") {
      // A hit-free page that redirects to a counted one (to test that redirects are checked too)
      if (q.get("bounce") === "1") return redirect("/modules/work/index.php?course=TMC106");
      return html(MY_COURSES);
    }
    if (p === "/main/calendar_data.php") {
      return json({
        success: 1,
        result: [
          {
            id: "7",
            title: "ΚΡΥΠΤΟΓΡΑΦΙΑ: RSA Implementation",
            start: Date.now() + 5 * 86_400_000,
            event_type: "assignment",
            event_group: "deadline",
            course: "TMC106",
          },
        ],
      });
    }
    if (p === "/modules/announcements/myannouncements.php") {
      return json({
        aaData: [
          {
            "0": `<div class='table_td'><div class='table_td_header'>
                <a href='/modules/announcements/index.php?course=TMC106&an_id=901'>Διάλεξη</a></div>
                <small class='text-grey'>ΚΡΥΠΤΟΓΡΑΦΙΑ</small>
                <div class='table_td_body' data-id='901' data-course-code='TMC106'><p>Κανονικά</p></div></div>`,
            "1": "χθες - 7:47 μ.μ.",
          },
        ],
      });
    }
    if (p === "/modules/message/ajax_handler.php") {
      return json({
        aaData: [
          {
            DT_RowId: 43035,
            "0": `<strong><a href='inbox.php?mid=43035'>Ερωτηματολόγιο</a></strong>`,
            "1": `<a href='index.php?course=TMC106'>ΚΡΥΠΤΟΓΡΑΦΙΑ</a>`,
            "2": `<a href="/main/display_profile.php?id=99">ΔΙΔΑΣΚΩΝ</a>`,
            "3": `17-11-2026`,
          },
        ],
      });
    }
    if (p === "/modules/message/inbox.php") return html(`<div id="msg_area"><div class="card-body"><div>Γεια</div></div></div>`);
    if (p === "/modules/auth/courses.php") return html(CATALOG);
    if (p === "/modules/auth/course_submit.php") return html("registered");
    if (p === "/modules/usage/index.php") return html(`<script>var user = 7651;</script>`);
    if (p === "/modules/usage/results.php") return json([["2026-11-16", "ΚΡΥΠΤΟΓΡΑΦΙΑ", "Εργασίες", "2", "1800"]]);
    // Course pages (counted by eClass)
    if (p === "/modules/document/index.php") return html(DOCS);
    if (p.startsWith("/modules/document/file.php/")) {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Guide.pdf"' },
      });
    }
    if (p === "/modules/work/index.php") return html(q.get("id") ? `<div class="description">Υλοποίηση RSA</div>` : ASSIGNMENTS);
    if (p === "/modules/announcements/rss.php") {
      return new Response(`<?xml version="1.0"?><rss><channel></channel></rss>`, { headers: { "content-type": "application/xml" } });
    }
    if (p === "/modules/announcements/index.php" && method === "POST") {
      return mode.announcementsAnswerHtml ? html(`<html><body>Ανακοινώσεις</body></html>`) : json({ aaData: [] });
    }
    if (p === "/courses/TMC106/") return html(`<a href="/modules/document/index.php?course=TMC106">Έγγραφα</a>`);
    return html("Not found", 404);
  }

  return { sent, mode, respond };
});

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (input: string | URL, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fake.sent.push({ url, method });
      return fake.respond(new URL(url), method);
    },
  };
});

// A throwaway data folder, no AI key, and no other network at all (Gemini, push)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "myclass-visits-test-"));
process.env.GEMINI_API_KEY = "";
vi.stubGlobal("fetch", async (u: unknown) => {
  throw new Error(`network is off in tests (${String(u)})`);
});

type Index = typeof import("../src/index.js");
type Store = typeof import("../src/store.js");
type Poller = typeof import("../src/poller.js");
type Ai = typeof import("../src/ai.js");
type Connector = typeof import("../src/eclass/connector.js");
type Http = typeof import("../src/eclass/http.js");
type Origin = typeof import("../src/eclass/request-origin.js");
type Audit = typeof import("../src/eclass/request-audit.js");
let app: Index["app"];
let store: Store;
let poller: Poller;
let ai: Ai;
let connector: Connector;
let http: Http;
let origin: Origin;
let audit: Audit;

const USER_ID = "visits-test-user";
const SID = "visits-test-session";

beforeAll(async () => {
  ({ app } = await import("../src/index.js"));
  store = await import("../src/store.js");
  poller = await import("../src/poller.js");
  ai = await import("../src/ai.js");
  connector = await import("../src/eclass/connector.js");
  http = await import("../src/eclass/http.js");
  origin = await import("../src/eclass/request-origin.js");
  audit = await import("../src/eclass/request-audit.js");

  const u = store.newUser(USER_ID, "unipi", "p22999");
  store.users.upsert(u);
  store.sessions.create(SID, USER_ID);
  connector.setTransientCredentials(USER_ID, "not-a-real-password");
});

beforeEach(() => {
  fake.sent.length = 0;
  fake.mode.announcementsAnswerHtml = false;
});

const user = () => store.users.get(USER_ID)!;
const call = (p: string, init: RequestInit = {}) =>
  app.request(p, { ...init, headers: { Cookie: `myclass_sid=${SID}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const counted = () => fake.sent.filter((r) => origin.eclassHitFor(r.url));
const blockedSince = (before: number) => audit.eclassRequestAudit().recent.filter((e) => e.blocked).length - before;
const blockedNow = () => audit.eclassRequestAudit().recent.filter((e) => e.blocked).length;

describe("nothing but the student opens a page eClass counts", () => {
  it("the background check reads only hit-free pages, and none of them is refused", async () => {
    const before = blockedNow();
    await poller.pollUserNow(user());
    expect(fake.sent.length).toBeGreaterThan(0);
    expect(counted()).toEqual([]);
    expect(blockedSince(before)).toBe(0);
    expect(user().lastPollError).toBeUndefined();
    // the calendar feed, never a course's assignment page
    expect(fake.sent.some((r) => r.url.includes("/main/calendar_data.php"))).toBe(true);
  });

  it("overlapping checks share one run", async () => {
    const a = poller.pollUserNow(user());
    const b = poller.pollUserNow(user());
    expect(a).toBe(b);
    await a;
  });

  it("signing in, opening the app (Home, Courses, Inbox, Stats, catalog) and every other route", async () => {
    const before = blockedNow();
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "p22999", password: "not-a-real-password", remember: true }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("myclass_sid=");
    // login starts a background check: let it finish inside this test
    await poller.pollUserNow(user());

    const routes: Array<[string, RequestInit?]> = [
      ["/api/health"],
      ["/api/me"],
      ["/api/courses"],
      ["/api/announcements"],
      ["/api/messages"],
      ["/api/messages/43035"],
      ["/api/assignments"],
      ["/api/notifications"],
      ["/api/notifications/poll", { method: "POST" }],
      ["/api/catalog"],
      ["/api/catalog?department=ds"],
      ["/api/stats"],
      ["/api/stats?fresh=1"],
      ["/api/widget/deadlines"],
      ["/api/chat/history"],
      ["/api/debug/eclass-requests"],
      ["/api/settings", { method: "PATCH", body: JSON.stringify({ language: "el" }) }],
      ["/api/courses/TMC106/meta", { method: "PATCH", body: JSON.stringify({ archived: false }) }],
      ["/api/courses/enroll", { method: "POST", body: JSON.stringify({ course: "TMC134" }) }],
      ["/api/calendar/feed", { method: "POST" }],
    ];
    for (const [p, init] of routes) {
      const res = await call(p, init);
      expect(res.status, p).toBeLessThan(500);
    }
    expect(counted()).toEqual([]);
    expect(blockedSince(before)).toBe(0);
  });

  it("the assistant's tools never open a course page", async () => {
    const tools: Array<[string, Record<string, unknown>]> = [
      ["list_courses", {}],
      ["search_catalog", { query: "ΑΞΙΟΛΟΓΗΣΗ" }],
      ["get_announcements", {}],
      ["get_announcements", { courseCode: "TMC106" }],
      ["get_messages", {}],
      ["read_message", { id: "43035" }],
      ["get_deadlines", {}],
      ["get_deadlines", { courseCode: "TMC106" }],
      ["list_documents", { courseCode: "TMC999" }],
      ["read_document", { courseCode: "TMC999", path: "/x.pdf", question: "τι λέει;" }],
      ["get_assignment_details", { courseCode: "TMC999", assignmentId: "TMC999:3" }],
    ];
    for (const [name, args] of tools) {
      await ai.runReadOnlyTool(user(), name, args).catch((err: Error) => ({ error: err.message }));
    }
    expect(fake.sent.length).toBeGreaterThan(0);
    expect(counted()).toEqual([]);

    // Course pages the student never opened are refused before any request, with a message the model can relay
    const docs = await ai.runReadOnlyTool(user(), "list_documents", { courseCode: "TMC999" }).catch((e: Error) => e);
    expect(String(docs)).toMatch(/not been opened in myClass/);
    const asg = await ai
      .runReadOnlyTool(user(), "get_assignment_details", { courseCode: "TMC999", assignmentId: "3" })
      .catch((e: Error) => e);
    expect(String(asg)).toMatch(/not been opened in myClass/);
    await expect(
      origin.withOrigin("agent", () => connector.getConnectorForUser(user()).downloadFile("TMC999", "/x.pdf")),
    ).rejects.toBeInstanceOf(connector.NotOpenedByStudentError);
  });

  it("refuses counted pages for every origin but the student's, also through redirects and POSTs", async () => {
    const client = new http.EclassHttp();
    // No origin at all: fail closed
    await expect(client.request("https://eclass.unipi.gr/modules/work/index.php?course=TMC106")).rejects.toBeInstanceOf(
      http.CountedVisitBlockedError,
    );
    for (const o of ["background", "agent", "unknown", "login", "stats"] as const) {
      await expect(
        origin.withOrigin(o, () => client.request("https://thales.cs.unipi.gr/main/my_courses.php?bounce=1")),
      ).rejects.toBeInstanceOf(http.CountedVisitBlockedError);
      await expect(
        origin.withOrigin(o, () =>
          client.request("https://thales.cs.unipi.gr/modules/announcements/index.php?course=TMC106", {
            method: "POST",
            form: { start: "0" },
          }),
        ),
      ).rejects.toBeInstanceOf(http.CountedVisitBlockedError);
      await expect(
        origin.withOrigin(o, () => client.request("https://lefkippos.ds.unipi.gr/modules/document/file.php/X1/a.pdf")),
      ).rejects.toBeInstanceOf(http.CountedVisitBlockedError);
    }
    // Only the hit-free first hop of each redirect ever left
    expect(counted()).toEqual([]);
    expect(fake.sent.every((r) => r.url.endsWith("/main/my_courses.php?bounce=1"))).toBe(true);
  });

  it("the student's own actions cost one counted visit each, and the assistant reuses them", async () => {
    const one = async (p: string, expected: RegExp) => {
      fake.sent.length = 0;
      const res = await call(p);
      expect(res.status, p).toBe(200);
      await res.arrayBuffer();
      expect(counted().map((r) => r.url), p).toHaveLength(1);
      expect(counted()[0].url, p).toMatch(expected);
    };

    await one("/api/courses/TMC106/documents", /\/modules\/document\/index\.php\?course=TMC106/);
    // The download uses the address from that listing: the file itself, no second Documents page
    await one(
      `/api/courses/TMC106/documents/file?path=${encodeURIComponent("/Guide.pdf")}`,
      /\/modules\/document\/(?:index\.php\?course=TMC106&download=FILEREF|file\.php\/TMC106\/)/,
    );
    // One assignment page, not the assignment list as well
    await one("/api/assignments/TMC106/7", /\/modules\/work\/index\.php\?course=TMC106&id=7/);
    await one("/api/assignments?course=TMC106", /\/modules\/work\/index\.php\?course=TMC106$/);
    await one("/api/courses/TMC106/tools", /\/courses\/TMC106\/$/);
    // The RSS feed is hit-free; it is empty here, so the announcements page is read once
    await one("/api/announcements?course=TMC106", /\/modules\/announcements\/index\.php\?course=TMC106/);

    // The assistant now sees what the student opened, without asking eClass again
    fake.sent.length = 0;
    const listing = (await ai.runReadOnlyTool(user(), "list_documents", { courseCode: "TMC106" })) as Array<{ name: string }>;
    expect(listing.map((n) => n.name)).toEqual(["Guide.pdf"]);
    const detail = (await ai.runReadOnlyTool(user(), "get_assignment_details", {
      courseCode: "TMC106",
      assignmentId: "TMC106:7",
    })) as { title: string };
    expect(detail.title).toBe("RSA Implementation");
    const file = await origin.withOrigin("agent", () =>
      connector.getConnectorForUser(user()).downloadFile("TMC106", "/Guide.pdf"),
    );
    expect(file.filename).toBe("Guide.pdf");
    expect(fake.sent).toEqual([]);
  });

  it("does not retry a counted page that answers with HTML", async () => {
    fake.mode.announcementsAnswerHtml = true;
    const res = await call("/api/announcements?course=TMC106");
    await res.arrayBuffer();
    expect(counted()).toHaveLength(1);
    // no re-login either
    expect(fake.sent.some((r) => r.url.includes("/modules/auth/cas.php"))).toBe(false);
  });

  it("the audit shows the student's counted visits only, and zero from anything else", async () => {
    const res = await call("/api/debug/eclass-requests");
    const body = (await res.json()) as ReturnType<Audit["eclassRequestAudit"]>;
    expect(body.countedNotByStudent).toBe(0);
    expect(body.byOrigin.interactive?.counted).toBeGreaterThan(0);
    expect(body.byOrigin.background?.counted ?? 0).toBe(0);
    expect(body.byOrigin.agent?.counted ?? 0).toBe(0);
    expect(body.byOrigin.unknown?.counted ?? 0).toBe(0);
    expect(body.recent.every((e) => e.owner === USER_ID)).toBe(true);
    // never a query string (CAS tickets, tokens)
    expect(body.recent.every((e) => !e.path.includes("?"))).toBe(true);
    expect(audit.eclassRequestAudit().countedNotByStudent).toBe(0);
  });
});
