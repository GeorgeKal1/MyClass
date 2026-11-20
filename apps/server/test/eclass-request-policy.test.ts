import { describe, expect, it } from "vitest";
import { eclassHitFor, eclassRequestPolicy, type RequestOrigin } from "../src/eclass/request-origin.js";

// The rules come from the Open eClass source (include/action.php, include/init.php, the modules):
// a page writes a hit into actions_daily only when it runs with a course context and calls
// action->record(). These tests pin how myClass recognises such pages and what it may send.

const HOSTS = [
  "https://eclass.unipi.gr",
  "https://thales.cs.unipi.gr",
  "https://aristarchus.ds.unipi.gr",
  "https://lefkippos.ds.unipi.gr",
  "https://eclass.upatras.gr",
  "https://eclass.uoa.gr",
  "https://ECLASS.UNIPI.GR:443",
  "http://eclass.unipi.gr:8080",
];

const NOT_STUDENT: RequestOrigin[] = ["background", "agent", "unknown", "login", "stats"];

describe("eclassHitFor: pages eClass logs as a course visit", () => {
  const counted: Array<[path: string, course: string, moduleId: number]> = [
    ["/modules/work/index.php?course=TMC106", "TMC106", 5],
    ["/modules/work/index.php?course=TMC106&id=7", "TMC106", 5],
    ["/modules/work/index.php?id=7&course=TMC106", "TMC106", 5],
    ["/modules/work/?course=TMC106", "TMC106", 5], // directory index serves index.php
    ["/modules/work/index.php/extra?course=TMC106", "TMC106", 5], // PATH_INFO
    ["//modules//work//index.php?course=TMC106", "TMC106", 5], // Apache merges slashes
    ["/modules/work/index%2Ephp?course=TMC106", "TMC106", 5], // decoded before matching
    ["/Modules/Work/index.php?course=TMC106", "TMC106", 5], // fail closed on casing
    ["/modules/work/index.php?COURSE=TMC106", "TMC106", 5],
    ["/modules/work/index.php?id=7&amp;course=TMC106", "TMC106", 5], // entity left in an href
    ["/modules/work/index.php?course[]=TMC106", "TMC106", 5],
    ["/modules/announcements/index.php?course=TMC106", "TMC106", 7],
    ["/modules/announcements/index.php?course=TMC106&an_id=901", "TMC106", 7],
    ["/modules/document/index.php?course=TMC106", "TMC106", 3],
    ["/modules/document/index.php?course=TMC106&openDir=/lectures", "TMC106", 3],
    ["/modules/document/index.php?course=TMC106&download=/x.pdf", "TMC106", 3],
    ["/modules/document/file.php/TMC106/Guide.pdf", "TMC106", 3],
    ["/modules/document/file.php/TMC106/a/b/c.pdf", "TMC106", 3],
    ["/modules/document/file.php/TMC106,12/group.pdf", "TMC106", 3], // group documents
    ["/modules/document/file.php?/TMC106/Guide.pdf", "TMC106", 3], // file.php rewrites "?" to "/"
    ["/modules/document/play.php/TMC106/video.mp4", "TMC106", 3],
    ["/modules/document/file.php/TMC%20106/x.pdf", "TMC 106", 3],
    ["/courses/TMC106/", "TMC106", 27],
    ["/courses/TMC106/index.php", "TMC106", 27],
    ["/courses/TMC106", "TMC106", 27],
    ["/modules/units/index.php?course=TMC106&id=3", "TMC106", 27],
    ["/modules/course_home/course_home.php?course=TMC106", "TMC106", 27],
    ["/modules/forum/index.php?course=TMC106", "TMC106", 0],
    ["/modules/exercise/index.php?course=TMC106", "TMC106", 0],
    ["/modules/message/index.php?course=TMC106", "TMC106", 0],
  ];

  it.each(counted)("%s", (path, course, moduleId) => {
    for (const host of HOSTS) expect(eclassHitFor(host + path)).toEqual({ courseCode: course, moduleId });
  });

  const notCounted = [
    "/",
    "/index.php",
    "/main/portfolio.php",
    "/main/my_courses.php?term=",
    "/main/calendar_data.php?from=1&to=2",
    "/main/calendar_data.php?course=TMC106&from=1&to=2", // main/ pages never record
    "/main/unregcours.php?u=1&cid=2",
    "/modules/announcements/myannouncements.php",
    "/modules/announcements/rss.php?c=TMC106", // RSS has no course context
    "/modules/message/ajax_handler.php?mbox_type=inbox",
    "/modules/message/inbox.php?mid=5",
    "/modules/usage/index.php?t=u",
    "/modules/usage/results.php?t=ud&u=1&s=2026-1-1&e=2026-11-19",
    "/modules/auth/cas.php?next=/modules/mobile/mtoken.php",
    "/modules/auth/courses.php?fc=19",
    "/modules/auth/course_submit.php",
    "/modules/mobile/midentity.php",
    "/modules/mobile/mcourses.php",
    "/modules/work/index.php", // no course in the URL (the policy refuses it anyway, see below)
    "/modules/document/file.php",
    "/courses/",
  ];

  it.each(notCounted)("%s is not counted", (path) => {
    for (const host of HOSTS) expect(eclassHitFor(host + path)).toBeNull();
  });

  it("ignores addresses that are not http(s) or not absolute", () => {
    expect(eclassHitFor("modules/work/index.php?course=TMC106")).toBeNull();
    expect(eclassHitFor("/modules/work/index.php?course=TMC106")).toBeNull();
    expect(eclassHitFor("eclass-token:abc|def")).toBeNull();
    expect(eclassHitFor("")).toBeNull();
  });
});

describe("eclassRequestPolicy: what myClass may send without the student asking", () => {
  const allowed = [
    "https://eclass.unipi.gr/",
    "https://eclass.unipi.gr/index.php",
    "https://eclass.unipi.gr/main/portfolio.php",
    "https://eclass.unipi.gr/main/my_courses.php?term=",
    "https://eclass.unipi.gr/main/calendar_data.php?from=1&to=2",
    "https://eclass.unipi.gr/main/unregcours.php?u=1&cid=2",
    "https://eclass.unipi.gr/main/login_form.php?next=%2Fmain%2Fportfolio.php",
    "https://thales.cs.unipi.gr/modules/mobile/midentity.php",
    "https://thales.cs.unipi.gr/modules/mobile/mlogin.php?redirect=x",
    "https://thales.cs.unipi.gr/modules/mobile/mtoken.php",
    "https://thales.cs.unipi.gr/modules/mobile/mcourses.php",
    "https://thales.cs.unipi.gr/modules/auth/cas.php?next=/modules/mobile/mtoken.php",
    "https://thales.cs.unipi.gr/modules/auth/courses.php?fc=19",
    "https://thales.cs.unipi.gr/modules/auth/course_submit.php",
    "https://aristarchus.ds.unipi.gr/modules/announcements/myannouncements.php",
    "https://lefkippos.ds.unipi.gr/modules/message/ajax_handler.php?mbox_type=inbox",
    "https://lefkippos.ds.unipi.gr/modules/message/inbox.php?mid=7",
    "https://eclass.unipi.gr/modules/usage/index.php?t=u",
    "https://eclass.unipi.gr/modules/usage/results.php?t=ud&u=5&s=2026-1-1&e=2026-11-19",
    "https://eclass.unipi.gr/secure/index.php",
    "https://eclass.unipi.gr/Shibboleth.sso/SAML2/POST",
    // The SSO server is not eClass: it cannot write eClass hits (logged-out redirects go there)
    "https://sso.unipi.gr/login?service=https%3A%2F%2Feclass.unipi.gr%2Fmodules%2Fauth%2Fcas.php",
    "https://idp.example.org/idp/profile/SAML2/Redirect/SSO",
  ];

  const refused = [
    // counted course pages
    "https://eclass.unipi.gr/modules/work/index.php?course=TMC106",
    "https://eclass.unipi.gr/modules/work/index.php?course=TMC106&id=7",
    "https://eclass.unipi.gr/modules/announcements/index.php?course=TMC106",
    "https://eclass.unipi.gr/modules/document/index.php?course=TMC106",
    "https://eclass.unipi.gr/modules/document/file.php/TMC106/a.pdf",
    "https://eclass.unipi.gr/modules/document/file.php?/TMC106/a.pdf",
    "https://eclass.unipi.gr/courses/TMC106/",
    "https://eclass.unipi.gr/courses/TMC106",
    // a course page without ?course= runs in the session's last course ($_SESSION['dbname'])
    "https://eclass.unipi.gr/modules/work/index.php",
    "https://eclass.unipi.gr/modules/document/index.php",
    "https://eclass.unipi.gr/modules/announcements/index.php",
    // anything else on eClass that is not on the list
    "https://eclass.unipi.gr/modules/announcements/rss.php?c=TMC106",
    "https://eclass.unipi.gr/modules/forum/index.php",
    "https://eclass.unipi.gr/main/profile/display_profile.php",
    "https://eclass.unipi.gr/foo.php",
    "https://unknown-host.example.org/modules/work/index.php",
    // a listed page carrying a course
    "https://eclass.unipi.gr/main/my_courses.php?course=TMC106",
    "https://eclass.unipi.gr/modules/message/ajax_handler.php?course=TMC106",
    "https://eclass.unipi.gr/main/calendar_data.php?course=TMC106&from=1&to=2",
    // listed scripts with a path after them
    "https://eclass.unipi.gr/main/portfolio.php/x",
    // not absolute / not http
    "/main/portfolio.php",
    "main/portfolio.php",
    "ftp://eclass.unipi.gr/main/portfolio.php",
  ];

  it.each(NOT_STUDENT)("origin %s: only the hit-free endpoints", (origin) => {
    for (const url of allowed) expect(eclassRequestPolicy(url, origin), url).toMatchObject({ allow: true, counted: null });
    for (const url of refused) expect(eclassRequestPolicy(url, origin).allow, url).toBe(false);
  });

  it("lets the student's own actions open any page, and still reports counted ones", () => {
    expect(eclassRequestPolicy("https://eclass.unipi.gr/modules/document/index.php?course=TMC106", "interactive")).toEqual({
      allow: true,
      counted: { courseCode: "TMC106", moduleId: 3 },
    });
    expect(eclassRequestPolicy("https://eclass.unipi.gr/main/portfolio.php", "interactive")).toEqual({
      allow: true,
      counted: null,
    });
  });

  it("never lets a counted page through for anyone but the student (random URL shapes)", () => {
    // Small deterministic PRNG so failures reproduce
    let seed = 20261119;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pick = <T,>(xs: T[]) => xs[rnd(xs.length)];
    const dirs = ["work", "announcements", "document", "forum", "units", "message", "usage", "auth", "mobile", "Work"];
    const scripts = ["index.php", "", "file.php", "play.php", "inbox.php", "ajax_handler.php", "myannouncements.php", "index.php/x"];
    const params = ["", "?course=TMC106", "?id=3&course=TMC106", "?COURSE=x", "?c=TMC106", "?course=", "?t=u", "?amp;course=Q"];
    const prefixes = ["/modules/", "//modules/", "/modules//", "/main/", "/courses/TMC106/", "/"];
    const tails = ["", "/TMC106/a.pdf", "?/TMC106/a.pdf"];
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const url = `${pick(HOSTS)}${pick(prefixes)}${pick(dirs)}/${pick(scripts)}${pick(tails)}${pick(params)}`;
      const hit = eclassHitFor(url);
      // An independent, cruder oracle: anything that looks like a course page must be refused
      const looksLikeCoursePage =
        /\/courses\/[^/?]+/i.test(url) ||
        /\/document\/(?:file|play)\.php/i.test(url) ||
        (/\/modules\//i.test(url) && /[?&](?:amp;)?course(?:\[\])?=/i.test(url));
      for (const origin of NOT_STUDENT) {
        const v = eclassRequestPolicy(url, origin);
        if (hit || looksLikeCoursePage) expect(v.allow, url).toBe(false);
        if (v.allow) expect(hit, url).toBeNull();
      }
      checked++;
    }
    expect(checked).toBe(5000);
  });
});
