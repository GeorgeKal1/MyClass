import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why myClass is talking to eClass right now. eClass cannot tell these apart (every request
 * carries the student's own session), so the server keeps track itself:
 * - "interactive": the student did something in the app (opened a course, a page, asked the assistant)
 * - "background": the notification poller (`pollUserNow`), which runs on a timer
 * - "login": signing in / re-authenticating a portal
 * - "stats": fetching the usage statistics themselves
 */
export type RequestOrigin = "interactive" | "background" | "login" | "stats";

const originStore = new AsyncLocalStorage<RequestOrigin>();

/** Runs `fn` (and every request it starts, including awaited async work) under `origin`. */
export function withOrigin<T>(origin: RequestOrigin, fn: () => T): T {
  return originStore.run(origin, fn);
}

/** The origin of the current async context; anything not marked otherwise was started by the student. */
export function currentOrigin(): RequestOrigin {
  return originStore.getStore() ?? "interactive";
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

const MODULE_BY_DIR: Record<string, number> = { document: 3, work: 5, announcements: 7 };

/**
 * The `actions_daily` hit a successful request to `url` makes eClass write, if any.
 *
 * Only course pages that call `action->record()` count: modules/work/index.php (5),
 * modules/announcements/index.php (7, also its AJAX POSTs), modules/document/index.php and
 * modules/document/file.php (3), and the course home /courses/CODE/ (27). Pages without a
 * course (portfolio, my_courses, myannouncements, the message inbox, usage, login/CAS,
 * mobile API) never write a hit, because `action::record()` returns early without `$course_id`.
 */
export function eclassHitFor(url: string): { courseCode: string; moduleId: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const moduleIndex = path.match(/\/modules\/(work|announcements|document)\/index\.php$/);
  if (moduleIndex) {
    const course = u.searchParams.get("course");
    return course ? { courseCode: course, moduleId: MODULE_BY_DIR[moduleIndex[1]] } : null;
  }
  const docFile = path.match(/\/modules\/document\/file\.php\/([^/]+)\//);
  if (docFile) return { courseCode: decode(docFile[1]), moduleId: 3 };
  const courseHome = path.match(/\/courses\/([^/]+)\/(?:index\.php)?$/);
  if (courseHome) return { courseCode: decode(courseHome[1]), moduleId: 27 };
  return null;
}
