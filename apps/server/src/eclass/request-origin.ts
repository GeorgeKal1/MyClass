import { AsyncLocalStorage } from "node:async_hooks";
import { PORTAL_BASE_URL } from "./unipi-curriculum.js";

/**
 * Why myClass is talking to eClass right now. eClass cannot tell these apart (every request
 * carries the student's own session), so the server keeps track itself:
 * - "interactive": the student asked for exactly this page in the app (opened a course's
 *   documents, an assignment, a file). Set explicitly by the routes that do it; never a default.
 * - "agent": the AI assistant's tool calls. Not the student, even when the student asked a question.
 * - "background": the notification poller (`pollUserNow`), which runs on a timer
 * - "login": signing in / re-authenticating a portal
 * - "stats": fetching the usage statistics themselves
 * - "unknown": nothing said why. Treated like "background" (fail closed).
 */
export type RequestOrigin = "interactive" | "agent" | "background" | "login" | "stats" | "unknown";

const originStore = new AsyncLocalStorage<RequestOrigin>();

/** Runs `fn` (and every request it starts, including awaited async work) under `origin`. */
export function withOrigin<T>(origin: RequestOrigin, fn: () => T): T {
  return originStore.run(origin, fn);
}

/**
 * The origin of the current async context. Anything not marked otherwise is "unknown", which
 * the HTTP client treats like a background request: only the student's own explicit actions
 * (wrapped in `withOrigin("interactive", …)`) may open a page eClass counts as a visit.
 */
export function currentOrigin(): RequestOrigin {
  return originStore.getStore() ?? "unknown";
}

/**
 * Open eClass module ids (include/constants.php, identical in 4.2.1, 4.3.3 and 4.4.3) for the
 * pages that write a hit into `actions_daily`, with the tool title `which_module()` prints for
 * them in Greek and English (lang/el, lang/en `$langDoc`, `$langWorks`, `$langAnnouncements`,
 * `$langUnits`). The usage rows carry the title, not the id.
 */
export const ECLASS_MODULES: Record<number, string[]> = {
  3: ["Έγγραφα", "Documents"],
  5: ["Εργασίες", "Assignments"],
  7: ["Ανακοινώσεις", "Announcements"],
  27: ["Θεματικές Ενότητες", "Units"],
};

/** Course tools myClass reads, by module directory; any other course tool is 0 ("another tool"). */
const MODULE_BY_DIR: Record<string, number> = { document: 3, work: 5, announcements: 7, units: 27, course_home: 27 };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The path as Apache resolves it: percent-decoded, repeated slashes merged. */
const normalizedPath = (u: URL) => decode(u.pathname).replace(/\/{2,}/g, "/");

/**
 * The `course` query parameter as PHP would read it (`course`, `course[]`), also when an HTML
 * entity slipped into the URL (`&amp;course=`). Case-insensitive on purpose: failing closed is cheap.
 */
function courseParam(params: URLSearchParams): string | undefined {
  for (const [k, v] of params) if (/^(?:amp;)?course(?:\[\])?$/i.test(k)) return v;
  return undefined;
}

/**
 * The `actions_daily` hit a successful request to `url` makes eClass write, if any.
 *
 * Course pages call `action->record()`: every course tool under modules/ opened with `?course=`
 * (work 5, announcements 7 also for AJAX POSTs, document 3, units 27, forum, …),
 * modules/document/file.php and play.php (3; course code as the first path segment, also in the
 * `file.php?/CODE/…` form file.php rewrites, and `CODE,groupId`), and the course home /courses/CODE/
 * (27). Pages without a course (portfolio, my_courses, myannouncements, the message inbox, the
 * calendar feed, usage, login/CAS, mobile API, the announcements RSS) never write a hit, because
 * `action::record()` returns early without `$course_id`.
 *
 * It leans to "counted" where Apache would still run the same script: a directory index
 * (`/modules/work/?course=`), PATH_INFO (`index.php/x`), encoded or doubled slashes, any casing.
 */
export function eclassHitFor(url: string): { courseCode: string; moduleId: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = normalizedPath(u);

  const docFile = path.match(/\/modules\/document\/(?:file|play)\.php(\/.*)?$/i);
  if (docFile) {
    const rest = docFile[1] ?? (u.search.startsWith("?/") ? decode(u.search.slice(1).split("&")[0]) : "");
    const code = rest.split("/").find(Boolean)?.split(",")[0];
    if (code) return { courseCode: code, moduleId: 3 };
  }

  const courseHome = path.match(/\/courses\/([^/]+)(?:\/|$)/i);
  if (courseHome) return { courseCode: courseHome[1], moduleId: 27 };

  const course = courseParam(u.searchParams);
  const moduleDir = path.match(/\/modules\/([^/]+)\//i);
  if (course !== undefined && moduleDir) {
    return { courseCode: course, moduleId: MODULE_BY_DIR[moduleDir[1].toLowerCase()] ?? 0 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* What myClass may request on its own                                 */
/* ------------------------------------------------------------------ */

/**
 * The only eClass pages myClass requests without the student asking for that exact page
 * (background checks, the assistant, sign-in, statistics, anything of unknown origin). Each one
 * has no course context, so eClass never logs it as a visit (checked against the Open eClass
 * source: none of them calls `action->record()`). Every other eClass page is refused.
 */
export const HIT_FREE_ENDPOINTS: ReadonlyArray<readonly [name: string, path: RegExp]> = [
  ["eClass home / sign-in page", /^\/(?:index\.php)?$/],
  ["sign-in form", /^\/main\/login_form\.php$/],
  ["portfolio", /^\/main\/portfolio\.php$/],
  ["my courses", /^\/main\/my_courses\.php$/],
  ["personal calendar feed", /^\/main\/calendar_data\.php$/],
  ["leave a course", /^\/main\/unregcours\.php$/],
  ["mobile API sign-in and course list", /^\/modules\/mobile\/(?:midentity|mlogin|mtoken|mcourses)\.php$/],
  ["CAS sign-in, course catalog and registration", /^\/modules\/auth\/[\w-]+\.php$/],
  ["Shibboleth sign-in", /^\/(?:secure\/(?:[\w-]+\.php)?|Shibboleth\.sso\/[\w/-]*)$/],
  ["my announcements", /^\/modules\/announcements\/myannouncements\.php$/],
  ["message inbox", /^\/modules\/message\/(?:ajax_handler|inbox)\.php$/],
  ["my usage statistics", /^\/modules\/usage\/(?:index|results)\.php$/],
];

const PORTAL_HOSTS = new Set(Object.values(PORTAL_BASE_URL).map((b) => new URL(b).hostname));

/**
 * Whether `url` is (or may be) an Open eClass page: a known portal (the UniPi ones, any
 * `eclass.*` host) or an eClass-shaped path on any host. SSO servers (sso.unipi.gr, IdPs) are not:
 * eClass cannot log a visit for a request it never sees.
 */
function isEclassAddress(hostname: string, path: string): boolean {
  return PORTAL_HOSTS.has(hostname) || /^eclass\./i.test(hostname) || /\/(?:modules|courses|main)(?:\/|$)/i.test(path);
}

export type EclassRequestVerdict =
  | { allow: true; counted: { courseCode: string; moduleId: number } | null; endpoint?: string }
  | { allow: false; counted: { courseCode: string; moduleId: number } | null; reason: string };

/**
 * Decides whether a request (or a redirect hop) may be sent. "interactive" may open any page;
 * every other origin only the named hit-free endpoints of an eClass portal, without a course.
 */
export function eclassRequestPolicy(url: string, origin: RequestOrigin): EclassRequestVerdict {
  const counted = eclassHitFor(url);
  if (origin === "interactive") return { allow: true, counted };
  if (counted) return { allow: false, counted, reason: "eClass counts this page as a course visit" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, counted: null, reason: "not an absolute address" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allow: false, counted: null, reason: "not http(s)" };
  const path = normalizedPath(u);
  if (!isEclassAddress(u.hostname, path)) return { allow: true, counted: null };
  if (courseParam(u.searchParams) !== undefined) {
    return { allow: false, counted: null, reason: "carries a course, so eClass may count it" };
  }
  const endpoint = HIT_FREE_ENDPOINTS.find(([, re]) => re.test(path));
  return endpoint
    ? { allow: true, counted: null, endpoint: endpoint[0] }
    : { allow: false, counted: null, reason: "not on the list of eClass pages that are never counted" };
}
