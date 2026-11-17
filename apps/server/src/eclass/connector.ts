import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import { FormData as UndiciFormData } from "undici";
import type {
  Announcement,
  Assignment,
  AssignmentDetail,
  CatalogCourse,
  Course,
  CourseTool,
  DepartmentInfo,
  DocNode,
  Message,
  PortalWarning,
  SubmissionResult,
  University,
} from "@myclass/shared";
import { decrypt, encrypt } from "../crypto.js";
import { users, type UserRecord } from "../store.js";
import { EclassHttp } from "./http.js";
import {
  parseAnnouncementsAjax,
  parseAnnouncementsRss,
  parseAssignmentDetailHtml,
  parseAssignmentsHtml,
  parseAutoPostForm,
  parseCasLoginForm,
  parseCatalogHtml,
  parseCourseTools,
  parseDocumentsHtml,
  parseIdentityXml,
  parseInboxAjax,
  parseMessageBodyHtml,
  parseMobileCoursesXml,
  parseMyCoursesHtml,
  parseUserDisplayName,
  isFirewallBlock,
  isLoggedOutPage,
  semesterFromText,
  type DataTablesResponse,
} from "./parsers.js";
import {
  CS_COURSE_SEMESTER,
  detectUniPiDepartmentFromUsername,
  EXCLUDED_COURSE_CODES,
  filterCurrentAcademicYearAnnouncements,
  filterCurrentAcademicYearAssignments,
  filterCurrentAcademicYearDocs,
  resolveSemesterForCourse,
  resolveUniPiPortalForCourse,
  SEMESTERS,
  THALES_BASE_URL,
  UNIPI_CENTRAL_BASE_URL,
  UNIPI_DEPARTMENTS,
} from "./unipi-curriculum.js";
import { getUniversity } from "./universities.js";

export interface SubmissionInput {
  files: Array<{ name: string; type: string; data: Buffer }>;
  text?: string;
  comments?: string;
}

export interface EclassConnector {
  verifyLogin(): Promise<{ displayName: string }>;
  listCourses(): Promise<Course[]>;
  /** Like listCourses, plus per-portal warnings so the UI can explain an empty list. */
  listCoursesDetailed(): Promise<{ courses: Course[]; warnings: PortalWarning[] }>;
  getAnnouncements(courseCode?: string): Promise<Announcement[]>;
  getMessages(): Promise<Message[]>;
  getMessage(id: string): Promise<Message | null>;
  listDocuments(courseCode: string, dir?: string): Promise<DocNode[]>;
  getAssignments(courseCode?: string): Promise<Assignment[]>;
  getAssignmentDetail(courseCode: string, assignmentId: string): Promise<AssignmentDetail>;
  submitAssignment(courseCode: string, assignmentId: string, input: SubmissionInput): Promise<SubmissionResult>;
  getCourseTools(courseCode: string): Promise<CourseTool[]>;
  listDepartments(): Promise<DepartmentInfo[]>;
  defaultDepartmentId(): string;
  listCatalog(query?: string, departmentId?: string): Promise<CatalogCourse[]>;
  enrollCourse(codeOrId: string): Promise<Course>;
  unenrollCourse(codeOrId: string): Promise<Course>;
  downloadFile(
    courseCode: string,
    filePathOrUrl: string,
  ): Promise<{ filename: string; contentType: string; body: Buffer | Readable }>;
  /** Downloads an absolute eClass URL (e.g. an assignment attachment) through the user's session. */
  downloadPortalUrl(courseCode: string, url: string): Promise<{ filename: string; contentType: string; body: Buffer }>;
  streamCourseZip(courseCode: string): Promise<{ filename: string; stream: Readable }>;
}

/* ------------------------------------------------------------------ */
/* Per-user shared state                                               */
/* ------------------------------------------------------------------ */

// Transient in-memory passwords for "session-only" logins (remember=false)
const sessionPasswords = new Map<string, string>();
/**
 * ONE live cookie jar per user, shared by every request. Previously each request deserialized
 * its own copy, so parallel requests re-authenticated independently and overwrote each other's
 * cookies; on portals with Open eClass' "double login lock" every new login also killed the
 * previous session, so users ended up permanently logged out (e.g. 0 courses on eclass.unipi.gr).
 */
const httpByUser = new Map<string, EclassHttp>();
/** In-flight re-authentication per `${userId}|${portal}` so concurrent requests wait for one login. */
const reauthInFlight = new Map<string, Promise<void>>();
/** Bumped after every successful re-authentication per `${userId}|${portal}`. */
const authGeneration = new Map<string, number>();
/** Which portal each course was found on (`${userId}|${CODE}` -> base URL). */
const coursePortalByUser = new Map<string, string>();
const persistTimers = new Map<string, NodeJS.Timeout>();

// Short-lived in-memory catalog/department caches per user
const catalogCache = new Map<string, { expiresAt: number; items: CatalogCourse[] }>();
const departmentCache = new Map<string, { expiresAt: number; items: DepartmentInfo[] }>();
const CATALOG_TTL_MS = 10 * 60 * 1000;

export function invalidateUserCatalogCache(userId: string) {
  for (const key of catalogCache.keys()) {
    if (key.startsWith(`${userId}:`)) catalogCache.delete(key);
  }
}

export function setTransientCredentials(userId: string, password?: string, serializedJar?: string) {
  if (password) sessionPasswords.set(userId, password);
  if (serializedJar) {
    try {
      httpByUser.set(userId, EclassHttp.fromSerialized(serializedJar));
    } catch {
      /* keep the previous jar */
    }
  }
  invalidateUserCatalogCache(userId);
}

export function forgetUserSession(userId: string) {
  sessionPasswords.delete(userId);
  httpByUser.delete(userId);
  invalidateUserCatalogCache(userId);
  departmentCache.delete(userId);
}

class FirewallError extends Error {
  constructor(host: string) {
    super(`The university firewall of ${host} blocked the request. Try again in a few minutes.`);
  }
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** University of Piraeus: Informatics uses thales.cs.unipi.gr (+ central); every other department only eclass.unipi.gr. */
function unipiUsesThales(username: string): boolean {
  const dept = detectUniPiDepartmentFromUsername(username);
  return dept === "cs-ug" || dept === "cs-pg";
}

/** Ordered list of eClass portals for a user; the first one must authenticate for login to succeed. */
export function portalsForUser(uni: University, username: string): string[] {
  const primary = uni.eclassUrl.replace(/\/$/, "");
  if (uni.id === "unipi") {
    return unipiUsesThales(username) ? [THALES_BASE_URL, UNIPI_CENTRAL_BASE_URL] : [UNIPI_CENTRAL_BASE_URL];
  }
  return [primary];
}

/**
 * Authenticates one Open eClass portal (`baseUrl`) into the provided cookie jar using the
 * university SSO (CAS, or Shibboleth/SAML), falling back to eClass' native login.
 * Throws unless the portal ends up with an active session.
 */
export async function authenticatePortalSession(
  http: EclassHttp,
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ displayName?: string; mobileToken?: string }> {
  const base = baseUrl.replace(/\/$/, "");
  const host = hostOf(base);

  // Discover the SSO start URL from midentity.php when available
  let ssoStartUrl = `${base}/modules/auth/cas.php?next=/modules/mobile/mtoken.php`;
  let hasSso = true;
  try {
    const idRes = await http.getText(`${base}/modules/mobile/midentity.php`);
    if (idRes.html.includes("<identity")) {
      const parsed = parseIdentityXml(idRes.html, base);
      if (parsed.casUrl) ssoStartUrl = parsed.casUrl;
      else hasSso = /<auth[^>]+url=/.test(idRes.html);
    }
  } catch {
    /* ignore – use default cas.php */
  }

  let mobileToken: string | undefined;
  const takeToken = (loc?: string) => {
    if (loc?.startsWith("eclass-token:")) {
      mobileToken = decodeURIComponent(loc).split("|")[1];
      return true;
    }
    return false;
  };

  if (hasSso) {
    let page = await http.request(ssoStartUrl);
    let html = takeToken(page.unfollowedLocation) ? "" : await page.text();
    let credentialsSent = false;

    // Walk the SSO flow: login form -> (optional SAML/proceed auto-post forms) -> back to eClass
    for (let hop = 0; hop < 8 && !mobileToken; hop++) {
      if (isFirewallBlock(page.status, html)) throw new FirewallError(hostOf(page.url));
      const loginForm = parseCasLoginForm(html, page.url);
      if (loginForm?.passField && !/\/modules\/|login_form\.php/.test(new URL(page.url).pathname)) {
        if (credentialsSent) {
          throw new Error("Invalid username or password (check your university SSO credentials)");
        }
        credentialsSent = true;
        page = await http.request(loginForm.actionUrl, {
          method: "POST",
          form: {
            ...loginForm.fields,
            [loginForm.userField ?? "username"]: username,
            [loginForm.passField]: password,
          },
          headers: { Referer: page.url, Origin: new URL(page.url).origin },
        });
        html = takeToken(page.unfollowedLocation) ? "" : await page.text();
        continue;
      }
      const autoForm = parseAutoPostForm(html, page.url);
      if (autoForm) {
        page = await http.request(autoForm.actionUrl, {
          method: "POST",
          form: autoForm.fields,
          headers: { Referer: page.url },
        });
        html = takeToken(page.unfollowedLocation) ? "" : await page.text();
        continue;
      }
      break;
    }
  }

  // Step 2: make sure the regular web session is active (needed for every HTML page we scrape)
  let portfolio = await http.getText(`${base}/main/portfolio.php`);
  if (isFirewallBlock(portfolio.status, portfolio.html)) throw new FirewallError(host);

  if (isLoggedOutPage(portfolio.url, portfolio.html) && mobileToken) {
    await http.request(
      `${base}/modules/mobile/mlogin.php?redirect=${encodeURIComponent(`${base}/main/portfolio.php`)}`,
      { method: "POST", form: { token: mobileToken } },
    );
    portfolio = await http.getText(`${base}/main/portfolio.php`);
  }

  if (isLoggedOutPage(portfolio.url, portfolio.html)) {
    // Native eClass account (no SSO, or SSO account linked to a local one)
    const mlogin = await http.request(`${base}/modules/mobile/mlogin.php`, {
      method: "POST",
      form: { uname: username, pass: password },
    });
    const tokenText = (await mlogin.text()).trim();
    if (tokenText && !/^(FAILED|USERNOTACTIVE|NOTENABLED|EXPIRED)$/.test(tokenText) && tokenText.length < 200) {
      mobileToken = tokenText;
      await http.request(
        `${base}/modules/mobile/mlogin.php?redirect=${encodeURIComponent(`${base}/main/portfolio.php`)}`,
        { method: "POST", form: { token: mobileToken } },
      );
      portfolio = await http.getText(`${base}/main/portfolio.php`);
    }
  }

  if (isLoggedOutPage(portfolio.url, portfolio.html)) {
    throw new Error(
      `Signed in to the university SSO, but ${host} did not open an eClass session. ` +
        `Log in once at https://${host} in a browser (to accept the terms / create your eClass account), then try again.`,
    );
  }

  if (mobileToken) http.tokens[base] = mobileToken;
  return { displayName: parseUserDisplayName(portfolio.html), mobileToken };
}

/**
 * Performs a fresh login on every portal the student uses and returns the authenticated
 * cookie jar along with the student's real display name.
 */
export async function performEclassLogin(
  uni: University,
  username: string,
  password: string,
): Promise<{ http: EclassHttp; displayName: string; mobileToken?: string }> {
  const http = new EclassHttp();
  const [primaryBase, ...others] = portalsForUser(uni, username);
  const primary = await authenticatePortalSession(http, primaryBase, username, password);
  let displayName = primary.displayName;

  for (const base of others) {
    try {
      const res = await authenticatePortalSession(http, base, username, password);
      if (!displayName && res.displayName) displayName = res.displayName;
    } catch (err) {
      console.warn(`[login] secondary portal ${hostOf(base)} failed: ${(err as Error).message}`);
    }
  }

  return { http, displayName: displayName || username, mobileToken: primary.mobileToken };
}

export function getConnectorForUser(user: UserRecord, passwordOverride?: string): EclassConnector {
  const uni = getUniversity(user.universityId) ?? getUniversity("unipi")!;
  return createLiveConnector(user, uni, passwordOverride);
}

/* ------------------------------------------------------------------ */
/* Connector                                                           */
/* ------------------------------------------------------------------ */

function createLiveConnector(user: UserRecord, uni: University, passwordOverride?: string): EclassConnector {
  const isUniPi = uni.id === "unipi";
  const portals = portalsForUser(uni, user.username);
  const primaryBase = portals[0];
  const uidByBase = new Map<string, number>();
  const csrfTokenByBase = new Map<string, string>();
  const downloadUrlCache = new Map<string, string>();
  const messagePortalMap = new Map<string, string>();

  /** Semester grouping: curated UniPi Informatics curriculum, otherwise title / faculty-name hints. */
  const semesterFor = (code: string, title: string, hints: string[] = [], defaultYear?: number) => {
    if (isUniPi && (resolveUniPiPortalForCourse(code) === "thales" || CS_COURSE_SEMESTER[code.toUpperCase()])) {
      const sem = resolveSemesterForCourse(code, title, defaultYear);
      return { semester: sem.shortLabel, semesterIndex: sem.index, semesterFolder: sem.folder };
    }
    const idx = [title, ...hints].map(semesterFromText).find((n) => n !== undefined);
    const sem = idx !== undefined ? SEMESTERS[Math.min(idx, 9)] : undefined;
    return sem
      ? { semester: sem.shortLabel, semesterIndex: sem.index, semesterFolder: sem.folder }
      : { semester: undefined, semesterIndex: undefined, semesterFolder: undefined };
  };

  const resolvePortalBase = (courseCode?: string): string => {
    if (!courseCode) return primaryBase;
    const known = coursePortalByUser.get(`${user.id}|${courseCode.toUpperCase()}`);
    if (known) return known;
    if (!isUniPi) return primaryBase;
    return resolveUniPiPortalForCourse(courseCode) === "thales" ? THALES_BASE_URL : UNIPI_CENTRAL_BASE_URL;
  };

  const getHttp = (): EclassHttp => {
    let http = httpByUser.get(user.id);
    if (!http) {
      http = new EclassHttp();
      if (user.encSession) {
        try {
          http = EclassHttp.fromSerialized(decrypt(user.encSession));
        } catch {
          /* start fresh */
        }
      }
      httpByUser.set(user.id, http);
    }
    return http;
  };

  /** Persist the shared jar (debounced – the JSON store rewrites the whole file on every update). */
  const persistSoon = () => {
    if (!user.remember) return;
    if (persistTimers.has(user.id)) return;
    persistTimers.set(
      user.id,
      setTimeout(() => {
        persistTimers.delete(user.id);
        const http = httpByUser.get(user.id);
        if (!http) return;
        users.update(user.id, (u) => {
          u.encSession = encrypt(http.serialize());
        });
      }, 2000),
    );
  };

  const getPassword = (): string | undefined => {
    if (passwordOverride) return passwordOverride;
    const mem = sessionPasswords.get(user.id);
    if (mem) return mem;
    if (user.encPassword) {
      try {
        return decrypt(user.encPassword);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /** Re-login to one portal; concurrent callers share the same attempt. */
  const reauth = (portalBase: string): Promise<void> => {
    const key = `${user.id}|${portalBase}`;
    const inflight = reauthInFlight.get(key);
    if (inflight) return inflight;
    const attempt = (async () => {
      const pw = getPassword();
      if (!pw) throw new Error("eClass session expired. Please sign in again.");
      const { displayName } = await authenticatePortalSession(getHttp(), portalBase, user.username, pw);
      authGeneration.set(key, (authGeneration.get(key) ?? 0) + 1);
      persistSoon();
      if (displayName && displayName !== user.displayName && !/^(Το προφίλ μου|My profile)$/i.test(displayName)) {
        user.displayName = displayName;
        users.update(user.id, (u) => {
          u.displayName = displayName;
        });
      }
    })().finally(() => reauthInFlight.delete(key));
    reauthInFlight.set(key, attempt);
    return attempt;
  };

  /** Runs `doRequest`; if the portal answers with a login page, re-authenticates once and retries. */
  const withSession = async <T extends { url: string; html: string; status: number }>(
    portalBase: string,
    doRequest: (http: EclassHttp) => Promise<T>,
    looksLoggedOut: (r: T) => boolean = (r) => isLoggedOutPage(r.url, r.html),
  ): Promise<T> => {
    const key = `${user.id}|${portalBase}`;
    const genBefore = authGeneration.get(key) ?? 0;
    let res = await doRequest(getHttp());
    if (isFirewallBlock(res.status, res.html)) throw new FirewallError(hostOf(portalBase));
    if (looksLoggedOut(res)) {
      // Someone else may have already re-logged-in while this request was in flight
      if ((authGeneration.get(key) ?? 0) === genBefore) await reauth(portalBase);
      else await reauthInFlight.get(key);
      res = await doRequest(getHttp());
      if (isFirewallBlock(res.status, res.html)) throw new FirewallError(hostOf(portalBase));
      if (looksLoggedOut(res)) {
        throw new Error(`Could not open an eClass session on ${hostOf(portalBase)}. Please sign out and sign in again.`);
      }
    }
    persistSoon();
    return res;
  };

  const authedGet = (portalBase: string, url: string) =>
    withSession(portalBase, (http) => http.getText(url));

  const authedAjaxPost = async (
    portalBase: string,
    url: string,
    form: Record<string, string>,
  ): Promise<DataTablesResponse> => {
    const res = await withSession(
      portalBase,
      async (http) => {
        const r = await http.request(url, {
          method: "POST",
          form,
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        return { url: r.url, html: await r.text(), status: r.status };
      },
      (r) => isLoggedOutPage(r.url, r.html) || !r.html.trim().startsWith("{"),
    );
    try {
      return JSON.parse(res.html) as DataTablesResponse;
    } catch {
      return { aaData: [] };
    }
  };

  const decorateCourse = (c: Course, portalBase: string): Course => {
    coursePortalByUser.set(`${user.id}|${c.code.toUpperCase()}`, portalBase);
    return {
      ...c,
      ...semesterFor(c.code, c.title),
      portal: hostOf(portalBase),
      url: c.url ?? `${portalBase}/courses/${encodeURIComponent(c.code)}/`,
      enrolled: true,
    };
  };

  /**
   * Enrolled courses of one portal, trying (1) the "My courses" page, (2) the official mobile
   * API, (3) the portfolio page – different Open eClass versions/themes break different ones.
   */
  const listPortalCourses = async (portalBase: string): Promise<Course[]> => {
    const host = hostOf(portalBase);
    const { html } = await authedGet(portalBase, `${portalBase}/main/my_courses.php?term=`);
    const parsed = parseMyCoursesHtml(html);
    if (parsed.uid) uidByBase.set(portalBase, parsed.uid);
    if (parsed.courses.length > 0) {
      console.log(`[courses] ${host}: ${parsed.courses.length} via my_courses`);
      return parsed.courses.map((c) => decorateCourse(c, portalBase));
    }

    // Mobile API (same data source as the official eClass app)
    const http = getHttp();
    const cookies = await http.jar.getCookies(portalBase);
    const tokens = [
      http.tokens[portalBase],
      ...cookies.filter((c) => /^PHPSESSID$|sess/i.test(c.key)).map((c) => c.value),
    ].filter((t, i, arr): t is string => Boolean(t) && arr.indexOf(t) === i);
    for (const token of tokens) {
      try {
        const mRes = await http.request(`${portalBase}/modules/mobile/mcourses.php`, {
          method: "POST",
          form: { token },
        });
        const xml = await mRes.text();
        if (xml.includes("<courses")) {
          const list = parseMobileCoursesXml(xml);
          console.log(`[courses] ${host}: ${list.length} via mobile API`);
          if (list.length > 0) return list.map((c) => decorateCourse(c, portalBase));
        }
      } catch {
        /* try the next strategy */
      }
    }

    // Portfolio page links (older themes)
    const portfolio = await authedGet(portalBase, `${portalBase}/main/portfolio.php`);
    const fromPortfolio = parseMyCoursesHtml(portfolio.html).courses;
    console.log(`[courses] ${host}: ${fromPortfolio.length} via portfolio`);
    return fromPortfolio.map((c) => decorateCourse(c, portalBase));
  };

  const listCoursesDetailed = async (): Promise<{ courses: Course[]; warnings: PortalWarning[] }> => {
    const warnings: PortalWarning[] = [];
    const lists = await Promise.all(
      portals.map(async (p) => {
        try {
          return await listPortalCourses(p);
        } catch (err) {
          const message = (err as Error).message || "Unknown error";
          console.warn(`[courses] ${hostOf(p)} failed: ${message}`);
          warnings.push({ portal: hostOf(p), message });
          return [];
        }
      }),
    );
    const byCode = new Map<string, Course>();
    for (const c of lists.flat()) {
      if (EXCLUDED_COURSE_CODES.has(c.code)) continue;
      if (!byCode.has(c.code)) byCode.set(c.code, c);
    }
    const courses = [...byCode.values()].sort(
      (a, b) => (a.semesterIndex ?? 99) - (b.semesterIndex ?? 99) || a.title.localeCompare(b.title, "el"),
    );
    return { courses, warnings };
  };

  const listCourses = async () => (await listCoursesDetailed()).courses;

  const listDocuments = async (courseCode: string, dir = "/"): Promise<DocNode[]> => {
    const portalBase = resolvePortalBase(courseCode);
    const dirParam = dir && dir !== "/" ? `&openDir=${encodeURIComponent(dir)}` : "";
    const pageUrl = `${portalBase}/modules/document/index.php?course=${encodeURIComponent(courseCode)}${dirParam}`;
    const { html, url } = await authedGet(portalBase, pageUrl);
    const { nodes, dirZipUrl } = parseDocumentsHtml(html, url);
    const currentYearNodes = filterCurrentAcademicYearDocs(nodes);
    if (dirZipUrl && (dir === "/" || !dir)) {
      downloadUrlCache.set(`${courseCode}:__ROOT_ZIP__`, dirZipUrl);
    }
    for (const n of currentYearNodes) {
      if (n.downloadUrl) downloadUrlCache.set(`${courseCode}:${n.path}`, n.downloadUrl);
    }
    return currentYearNodes.map((n) => ({
      ...n,
      downloadUrl: `/api/courses/${encodeURIComponent(courseCode)}/documents/file?path=${encodeURIComponent(n.path)}`,
    }));
  };

  /* -------------------------- Catalog ----------------------------- */

  /**
   * Crawls a faculty subtree of `/modules/auth/courses.php` (department -> programme ->
   * semester folders, …). Ancestors from the breadcrumb are never visited, so the crawl
   * cannot climb up to the whole university.
   */
  const crawlFaculty = async (
    portalBase: string,
    rootFc: number | undefined,
    opts: { maxDepth: number; maxPages: number },
  ): Promise<Array<CatalogCourse & { facultyPath: string[] }>> => {
    const visited = new Set<number>();
    const out: Array<CatalogCourse & { facultyPath: string[] }> = [];
    let level: Array<{ fc?: number; path: string[] }> = [{ fc: rootFc, path: [] }];
    let pages = 0;

    for (let depth = 0; depth <= opts.maxDepth && level.length && pages < opts.maxPages; depth++) {
      const next: Array<{ fc?: number; path: string[] }> = [];
      const batch = level.filter((n) => n.fc === undefined || !visited.has(n.fc)).slice(0, opts.maxPages - pages);
      for (const n of batch) if (n.fc !== undefined) visited.add(n.fc);
      pages += batch.length;

      for (let i = 0; i < batch.length; i += 6) {
        const results = await Promise.all(
          batch.slice(i, i + 6).map(async (node) => {
            const url =
              node.fc !== undefined
                ? `${portalBase}/modules/auth/courses.php?fc=${node.fc}`
                : `${portalBase}/modules/auth/courses.php`;
            try {
              const { html } = await authedGet(portalBase, url);
              return { node, parsed: parseCatalogHtml(html) };
            } catch {
              return null;
            }
          }),
        );
        for (const r of results) {
          if (!r) continue;
          const { node, parsed } = r;
          if (parsed.csrfToken) csrfTokenByBase.set(portalBase, parsed.csrfToken);
          for (const a of parsed.ancestorFaculties) visited.add(a.fc);
          const path = node.path.length ? node.path : parsed.currentFacultyName ? [parsed.currentFacultyName] : [];
          for (const c of parsed.courses) out.push({ ...c, facultyPath: path });
          for (const child of parsed.childFaculties) {
            if (!visited.has(child.fc)) next.push({ fc: child.fc, path: [...path, child.name] });
          }
        }
      }
      level = next;
    }
    return out;
  };

  /** Generic departments: the user's own faculty ("auto") + the top-level faculties of the portal. */
  const listGenericDepartments = async (): Promise<DepartmentInfo[]> => {
    const cached = departmentCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const items: DepartmentInfo[] = [];
    try {
      const { html } = await authedGet(primaryBase, `${primaryBase}/modules/auth/courses.php`);
      const landing = parseCatalogHtml(html);
      items.push({
        id: "auto",
        name: landing.currentFacultyName ?? "Το τμήμα μου",
        nameEn: landing.currentFacultyName ?? "My department",
        portalLabel: hostOf(primaryBase),
      });
      let top = landing.childFaculties;
      if (landing.ancestorFaculties.length > 0) {
        const root = await authedGet(
          primaryBase,
          `${primaryBase}/modules/auth/courses.php?fc=${landing.ancestorFaculties[0].fc}`,
        );
        top = parseCatalogHtml(root.html).childFaculties;
      }
      for (const f of top.slice(0, 60)) {
        items.push({ id: `fc:${f.fc}`, name: f.name, nameEn: f.name, portalLabel: hostOf(primaryBase) });
      }
    } catch {
      if (items.length === 0) {
        items.push({ id: "auto", name: uni.name, nameEn: uni.nameEn, portalLabel: hostOf(primaryBase) });
      }
    }
    departmentCache.set(user.id, { expiresAt: Date.now() + 30 * 60 * 1000, items });
    return items;
  };

  const defaultDepartmentId = () => (isUniPi ? detectUniPiDepartmentFromUsername(user.username) : "auto");

  const fetchCatalog = async (departmentId: string): Promise<CatalogCourse[]> => {
    const fromCrawl = (rows: Array<CatalogCourse & { facultyPath: string[] }>, portalBase: string, deptName?: string) =>
      rows
        .filter((c) => !EXCLUDED_COURSE_CODES.has(c.code.toUpperCase()))
        .map(({ facultyPath, ...c }) => {
          coursePortalByUser.set(`${user.id}|${c.code.toUpperCase()}`, portalBase);
          return {
            ...c,
            ...semesterFor(c.code, c.title, [...facultyPath].reverse()),
            departmentId,
            departmentName: deptName ?? facultyPath[0],
            portal: hostOf(portalBase),
            url: `${portalBase}/courses/${encodeURIComponent(c.code)}/`,
          } satisfies CatalogCourse;
        });

    if (isUniPi) {
      const dept = UNIPI_DEPARTMENTS.find((d) => d.id === departmentId) ?? UNIPI_DEPARTMENTS[0];
      const batches = await Promise.all(
        dept.sources.map(async (src) => {
          const portalBase = src.portal === "thales" ? THALES_BASE_URL : UNIPI_CENTRAL_BASE_URL;
          const rows = await crawlFaculty(portalBase, src.fc, { maxDepth: src.portal === "thales" ? 0 : 2, maxPages: 25 });
          return rows.map(({ facultyPath, ...c }) => {
            coursePortalByUser.set(`${user.id}|${c.code.toUpperCase()}`, portalBase);
            const sem =
              src.portal === "thales"
                ? (() => {
                    const s = resolveSemesterForCourse(c.code, c.title, src.defaultYear);
                    return { semester: s.shortLabel, semesterIndex: s.index, semesterFolder: s.folder };
                  })()
                : semesterFor(c.code, c.title, [...facultyPath].reverse());
            return {
              ...c,
              ...sem,
              departmentId: dept.id,
              departmentName: dept.name,
              portal: hostOf(portalBase),
              url: `${portalBase}/courses/${encodeURIComponent(c.code)}/`,
            } satisfies CatalogCourse;
          });
        }),
      );
      let items: CatalogCourse[] = batches.flat().filter((c) => !EXCLUDED_COURSE_CODES.has(c.code.toUpperCase()));

      for (const extra of dept.extraCentralCourses ?? []) {
        if (items.some((c) => c.code.toUpperCase() === extra.code.toUpperCase())) continue;
        const sem = SEMESTERS[extra.semesterIndex] ?? SEMESTERS[1];
        items.push({
          code: extra.code,
          publicCode: extra.publicCode,
          title: extra.title,
          professor: extra.professor,
          numericId: extra.numericId,
          enrolled: false,
          locked: false,
          semester: sem.shortLabel,
          semesterIndex: sem.index,
          semesterFolder: sem.folder,
          departmentId: dept.id,
          departmentName: dept.name,
          portal: hostOf(UNIPI_CENTRAL_BASE_URL),
        });
      }

      // The curated faculty ids can drift; fall back to the student's own faculty page
      if (items.length === 0 && dept.sources.every((s) => s.portal === "central")) {
        items = fromCrawl(
          await crawlFaculty(UNIPI_CENTRAL_BASE_URL, undefined, { maxDepth: 2, maxPages: 25 }),
          UNIPI_CENTRAL_BASE_URL,
          dept.name,
        );
      }
      return items;
    }

    const fc = departmentId.startsWith("fc:") ? Number(departmentId.slice(3)) : undefined;
    const rows = await crawlFaculty(primaryBase, Number.isFinite(fc) ? fc : undefined, { maxDepth: 2, maxPages: 30 });
    return fromCrawl(rows, primaryBase);
  };

  const listCatalog = async (query?: string, departmentId?: string): Promise<CatalogCourse[]> => {
    const deptId = departmentId || defaultDepartmentId();
    const cacheKey = `${user.id}:${deptId}`;
    const now = Date.now();
    let items: CatalogCourse[];

    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      items = cached.items;
    } else {
      const [raw, enrolledCourses] = await Promise.all([fetchCatalog(deptId), listCourses().catch(() => [])]);
      const enrolledSet = new Set(enrolledCourses.map((c) => c.code.toUpperCase()));
      const byCode = new Map<string, CatalogCourse>();
      for (const c of raw) {
        const key = c.code.toUpperCase();
        if (!byCode.has(key)) byCode.set(key, { ...c, enrolled: c.enrolled || enrolledSet.has(key) });
      }
      items = [...byCode.values()].sort(
        (a, b) => (a.semesterIndex ?? 99) - (b.semesterIndex ?? 99) || a.title.localeCompare(b.title, "el"),
      );
      catalogCache.set(cacheKey, { expiresAt: now + CATALOG_TTL_MS, items });
    }

    const q = query?.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        (c.publicCode?.toLowerCase().includes(q) ?? false) ||
        (c.professor?.toLowerCase().includes(q) ?? false) ||
        (c.semester?.toLowerCase().includes(q) ?? false) ||
        (c.semesterFolder?.toLowerCase().includes(q) ?? false),
    );
  };

  /* --------------------- Enrollment helpers ------------------------ */

  /** Open eClass 4.x AJAX registration: POST `course_submit.php` with `{ cid, state, token }`. */
  const fetchPortalCsrfToken = async (portalBase: string): Promise<string | undefined> => {
    const fcUrl =
      portalBase === THALES_BASE_URL
        ? `${portalBase}/modules/auth/courses.php?fc=19`
        : `${portalBase}/modules/auth/courses.php`;
    const { html } = await authedGet(portalBase, fcUrl);
    const { csrfToken } = parseCatalogHtml(html);
    if (csrfToken) csrfTokenByBase.set(portalBase, csrfToken);
    return csrfToken;
  };

  const submitCourseToggle = async (
    portalBase: string,
    numericId: number,
    state: "true" | "false",
  ): Promise<string> => {
    let token = csrfTokenByBase.get(portalBase) ?? (await fetchPortalCsrfToken(portalBase));
    const doSubmit = async (csrf: string | undefined) => {
      const http = getHttp();
      const res = await http.request(`${portalBase}/modules/auth/course_submit.php`, {
        method: "POST",
        form: { cid: String(numericId), state, ...(csrf ? { token: csrf } : {}) },
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${portalBase}/modules/auth/courses.php`,
        },
      });
      persistSoon();
      return (await res.text()).trim();
    };

    let statusText = await doSubmit(token);
    if (statusText !== "registered" && statusText !== "unregistered") {
      // Refresh CSRF token (re-login happens inside authedGet if needed) and retry once
      token = await fetchPortalCsrfToken(portalBase);
      statusText = await doSubmit(token);
    }
    return statusText;
  };

  const downloadFromPortal = async (portalBase: string, targetUrl: string, fallbackName: string) => {
    const http = getHttp();
    let res = await http.request(targetUrl);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      // Could be a login page – re-auth once and retry
      const html = await res.text();
      if (isLoggedOutPage(res.url, html)) {
        await reauth(portalBase);
        res = await getHttp().request(targetUrl);
      } else {
        persistSoon();
        return { filename: fallbackName, contentType: ct, body: Buffer.from(html, "utf8") };
      }
    }
    persistSoon();
    const disp = res.headers.get("content-disposition") || "";
    const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    let filename = fallbackName;
    if (fnMatch) {
      try {
        filename = decodeURIComponent(fnMatch[1]);
      } catch {
        filename = fnMatch[1];
      }
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const arrayBuf = await res.raw.arrayBuffer();
    return { filename, contentType, body: Buffer.from(arrayBuf) };
  };

  const assignmentPageUrl = (courseCode: string, numericId: string) => {
    const portalBase = resolvePortalBase(courseCode);
    return {
      portalBase,
      url: `${portalBase}/modules/work/index.php?course=${encodeURIComponent(courseCode)}&id=${encodeURIComponent(numericId)}`,
    };
  };

  const numericAssignmentId = (assignmentId: string) => {
    const id = assignmentId.includes(":") ? assignmentId.split(":").pop()! : assignmentId;
    if (!/^\d+$/.test(id)) throw new Error("Invalid assignment id");
    return id;
  };

  return {
    async verifyLogin() {
      const pw = getPassword();
      if (!pw) throw new Error("Password is required to verify login");
      const { http, displayName } = await performEclassLogin(uni, user.username, pw);
      httpByUser.set(user.id, http);
      persistSoon();
      return { displayName };
    },
    listCourses,
    listCoursesDetailed,
    async getAnnouncements(courseCode?: string): Promise<Announcement[]> {
      if (courseCode) {
        const portalBase = resolvePortalBase(courseCode);
        const json = await authedAjaxPost(
          portalBase,
          `${portalBase}/modules/announcements/index.php?course=${encodeURIComponent(courseCode)}`,
          { start: "0", length: "50", "search[value]": "" },
        );
        const list = parseAnnouncementsAjax(json, portalBase, { code: courseCode });
        if (list.length > 0) return filterCurrentAcademicYearAnnouncements(list);

        const rss = await authedGet(
          portalBase,
          `${portalBase}/modules/announcements/rss.php?c=${encodeURIComponent(courseCode)}`,
        );
        return filterCurrentAcademicYearAnnouncements(parseAnnouncementsRss(rss.html, courseCode));
      }

      const results = await Promise.all(
        portals.map(async (portalBase) => {
          try {
            const json = await authedAjaxPost(portalBase, `${portalBase}/modules/announcements/myannouncements.php`, {
              start: "0",
              length: "50",
              "search[value]": "",
            });
            return parseAnnouncementsAjax(json, portalBase);
          } catch {
            return [];
          }
        }),
      );
      const merged = filterCurrentAcademicYearAnnouncements(results.flat());
      return merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    },
    async getMessages(): Promise<Message[]> {
      const results = await Promise.all(
        portals.map(async (portalBase) => {
          try {
            const json = await authedAjaxPost(
              portalBase,
              `${portalBase}/modules/message/ajax_handler.php?mbox_type=inbox`,
              { start: "0", length: "50", "search[value]": "" },
            );
            const list = parseInboxAjax(json, portalBase);
            for (const m of list) messagePortalMap.set(m.id, portalBase);
            return list;
          } catch {
            return [];
          }
        }),
      );
      return results.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    },
    async getMessage(id: string): Promise<Message | null> {
      const list = await this.getMessages();
      const summary = list.find((m) => m.id === id);
      const portalBase =
        messagePortalMap.get(id) ?? (summary?.courseCode ? resolvePortalBase(summary.courseCode) : primaryBase);
      const { html } = await authedGet(portalBase, `${portalBase}/modules/message/inbox.php?mid=${encodeURIComponent(id)}`);
      const detail = parseMessageBodyHtml(html, portalBase);
      return {
        id,
        subject: summary?.subject ?? `Μήνυμα #${id}`,
        sender: summary?.sender ?? "eClass",
        date: summary?.date ?? new Date().toISOString(),
        courseCode: summary?.courseCode,
        courseTitle: summary?.courseTitle,
        read: true,
        bodyHtml: detail.bodyHtml,
        attachments: detail.attachments.length ? detail.attachments : summary?.attachments,
      };
    },
    listDocuments,
    async getAssignments(courseCode?: string): Promise<Assignment[]> {
      const targetCourses = courseCode
        ? [{ code: courseCode, title: undefined as string | undefined }]
        : (await listCourses()).map((c) => ({ code: c.code, title: c.title as string | undefined }));

      const results: Assignment[][] = [];
      // Bounded concurrency: dozens of parallel requests trip university rate limits / WAFs
      for (let i = 0; i < targetCourses.length; i += 5) {
        results.push(
          ...(await Promise.all(
            targetCourses.slice(i, i + 5).map(async (c) => {
              try {
                const portalBase = resolvePortalBase(c.code);
                const pageUrl = `${portalBase}/modules/work/index.php?course=${encodeURIComponent(c.code)}`;
                const { html, url } = await authedGet(portalBase, pageUrl);
                return parseAssignmentsHtml(html, url, c.code, c.title);
              } catch {
                return [];
              }
            }),
          )),
        );
      }
      return filterCurrentAcademicYearAssignments(results.flat());
    },
    async getAssignmentDetail(courseCode: string, assignmentId: string): Promise<AssignmentDetail> {
      const id = numericAssignmentId(assignmentId);
      const { portalBase, url } = assignmentPageUrl(courseCode, id);
      const [{ html, url: finalUrl }, list] = await Promise.all([
        authedGet(portalBase, url),
        this.getAssignments(courseCode).catch(() => [] as Assignment[]),
      ]);
      const parsed = parseAssignmentDetailHtml(html, finalUrl);
      const summary = list.find((a) => a.id === `${courseCode}:${id}`);
      return {
        id: `${courseCode}:${id}`,
        courseCode,
        title: summary?.title ?? parsed.title ?? `#${id}`,
        descriptionHtml: parsed.descriptionHtml,
        deadline: summary?.deadline,
        submitted: summary?.submitted ?? Boolean(parsed.existingSubmission),
        grade: summary?.grade,
        attachments: parsed.attachments.map((a) => ({
          name: a.name,
          url: `/api/courses/${encodeURIComponent(courseCode)}/proxy?url=${encodeURIComponent(a.url)}`,
        })),
        canSubmit: parsed.canSubmit,
        submissionType: parsed.submissionType,
        maxFiles: parsed.maxFiles,
        existingSubmission: parsed.existingSubmission,
        url,
      };
    },
    async submitAssignment(courseCode: string, assignmentId: string, input: SubmissionInput): Promise<SubmissionResult> {
      const id = numericAssignmentId(assignmentId);
      const { portalBase, url } = assignmentPageUrl(courseCode, id);
      const page = await authedGet(portalBase, url);
      const form = parseAssignmentDetailHtml(page.html, page.url);
      if (!form.canSubmit || !form.formAction) {
        throw new Error("This assignment does not accept submissions right now (closed, not started, or you are not enrolled).");
      }
      if (form.submissionType === "file" && input.files.length === 0) {
        throw new Error("Please attach at least one file.");
      }
      if (form.submissionType === "text" && !input.text?.trim()) {
        throw new Error("Please write your answer before submitting.");
      }
      if (input.files.length > form.maxFiles) {
        throw new Error(`This assignment accepts at most ${form.maxFiles} file(s).`);
      }
      // The submission must go back to the same eClass host we scraped the form from
      if (new URL(form.formAction).host !== hostOf(portalBase)) {
        throw new Error("Unexpected submission address on the eClass page.");
      }

      const fd = new UndiciFormData();
      for (const [k, v] of Object.entries(form.hiddenFields)) fd.append(k, v);
      if (!("id" in form.hiddenFields)) fd.append("id", id);
      if (form.submissionType === "text") fd.append("submission_text", input.text ?? "");
      for (const f of input.files) {
        fd.append("userfile[]", new Blob([new Uint8Array(f.data)], { type: f.type || "application/octet-stream" }), f.name);
      }
      fd.append("stud_comments", input.comments ?? "");
      fd.append("work_submit", "true");

      const http = getHttp();
      const res = await http.request(form.formAction, {
        method: "POST",
        multipart: fd,
        headers: { Referer: page.url, Origin: new URL(page.url).origin },
      });
      const html = await res.text();
      persistSoon();
      if (isFirewallBlock(res.status, html)) throw new FirewallError(hostOf(portalBase));
      if (isLoggedOutPage(res.url, html)) throw new Error("Your eClass session expired during the upload. Please try again.");

      const after = parseAssignmentDetailHtml(html, res.url);
      if (after.flashMessage?.kind === "error") return { ok: false, message: after.flashMessage.text };
      // Confirm by re-reading the assignment list (submitted ✓)
      const list = await this.getAssignments(courseCode).catch(() => [] as Assignment[]);
      const confirmed = list.find((a) => a.id === `${courseCode}:${id}`)?.submitted;
      if (confirmed || after.flashMessage?.kind === "success") {
        return { ok: true, message: after.flashMessage?.text || "Submitted to eClass." };
      }
      return {
        ok: res.status < 400,
        message:
          after.flashMessage?.text ||
          (res.status < 400
            ? "Sent to eClass. Open the assignment on eClass to double-check the submission."
            : `eClass answered with HTTP ${res.status}.`),
      };
    },
    async getCourseTools(courseCode: string): Promise<CourseTool[]> {
      const portalBase = resolvePortalBase(courseCode);
      const { html, url } = await authedGet(portalBase, `${portalBase}/courses/${encodeURIComponent(courseCode)}/`);
      const native = new Set(["announcements", "document", "work", "message"]);
      return parseCourseTools(html, url, courseCode).map((t) => ({ ...t, native: native.has(t.id) }));
    },
    async listDepartments(): Promise<DepartmentInfo[]> {
      if (!isUniPi) return listGenericDepartments();
      return UNIPI_DEPARTMENTS.map(({ id, name, nameEn, portalLabel }) => ({ id, name, nameEn, portalLabel }));
    },
    defaultDepartmentId,
    listCatalog,
    async enrollCourse(codeOrId: string): Promise<Course> {
      const catalog = await listCatalog();
      const q = codeOrId.trim().toLowerCase();
      const match =
        catalog.find(
          (c) => c.code.toLowerCase() === q || c.publicCode?.toLowerCase() === q || String(c.numericId) === q,
        ) ?? catalog.find((c) => c.title.toLowerCase().includes(q));

      if (!match || !match.numericId) {
        throw new Error(`Course "${codeOrId}" was not found in the university catalog`);
      }
      if (match.locked) {
        throw new Error(`Course "${match.title}" requires a password or has closed registration on eClass`);
      }

      const portalBase = resolvePortalBase(match.code);
      const statusText = await submitCourseToggle(portalBase, match.numericId, "true");
      if (statusText !== "registered") {
        throw new Error(`eClass could not register "${match.title}" (response: ${statusText || "unknown"})`);
      }
      invalidateUserCatalogCache(user.id);

      return {
        code: match.code,
        publicCode: match.publicCode ?? match.code,
        title: match.title,
        professor: match.professor,
        numericId: match.numericId,
        semester: match.semester,
        semesterIndex: match.semesterIndex,
        semesterFolder: match.semesterFolder,
        portal: match.portal,
        enrolled: true,
      };
    },
    async unenrollCourse(codeOrId: string): Promise<Course> {
      const allCourses = await listCourses();
      const q = codeOrId.trim().toLowerCase();
      let target =
        allCourses.find(
          (c) => c.code.toLowerCase() === q || c.publicCode?.toLowerCase() === q || String(c.numericId) === q,
        ) ?? allCourses.find((c) => c.title.toLowerCase().includes(q));

      if (!target) {
        const catalog = await listCatalog();
        const catMatch =
          catalog.find(
            (c) => c.code.toLowerCase() === q || c.publicCode?.toLowerCase() === q || String(c.numericId) === q,
          ) ?? catalog.find((c) => c.title.toLowerCase().includes(q));
        if (catMatch) target = { ...catMatch, enrolled: false };
      }
      if (!target) throw new Error(`Course "${codeOrId}" is not in your enrolled courses`);

      const portalBase = resolvePortalBase(target.code);
      if (!target.numericId) {
        const catalog = await listCatalog();
        const catMatch = catalog.find((c) => c.code.toUpperCase() === target!.code.toUpperCase());
        if (catMatch?.numericId) target.numericId = catMatch.numericId;
      }
      if (!uidByBase.get(portalBase) || !target.numericId) {
        const { html } = await authedGet(portalBase, `${portalBase}/main/my_courses.php?term=`);
        const parsed = parseMyCoursesHtml(html);
        if (parsed.uid) uidByBase.set(portalBase, parsed.uid);
        const refreshed = parsed.courses.find((c) => c.code === target!.code);
        if (refreshed?.numericId) target.numericId = refreshed.numericId;
      }
      if (!target.numericId) throw new Error(`Could not resolve numeric course ID for "${codeOrId}" to unenroll`);

      const statusText = await submitCourseToggle(portalBase, target.numericId, "false");
      if (statusText !== "unregistered") {
        const uid = uidByBase.get(portalBase);
        if (uid) {
          await getHttp().request(`${portalBase}/main/unregcours.php?u=${uid}&cid=${target.numericId}`, {
            method: "POST",
            form: { doit: "1", fromMyCoursesPage: "1" },
          });
          persistSoon();
        }
      }
      invalidateUserCatalogCache(user.id);
      return { ...target, enrolled: false };
    },
    async downloadFile(courseCode: string, filePath: string) {
      const portalBase = resolvePortalBase(courseCode);
      let targetUrl = downloadUrlCache.get(`${courseCode}:${filePath}`);
      if (!targetUrl) {
        const parentDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) || "/" : "/";
        await listDocuments(courseCode, parentDir);
        targetUrl = downloadUrlCache.get(`${courseCode}:${filePath}`);
      }
      if (!targetUrl) {
        targetUrl = `${portalBase}/modules/document/file.php/${encodeURIComponent(courseCode)}${filePath}`;
      }
      return downloadFromPortal(portalBase, targetUrl, filePath.split("/").pop() || "download");
    },
    async downloadPortalUrl(courseCode: string, url: string) {
      const portalBase = resolvePortalBase(courseCode);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Invalid file address");
      }
      // Only ever fetch files from the course's own eClass portal over https (no open proxy)
      if (parsed.protocol !== "https:" || parsed.host !== hostOf(portalBase)) {
        throw new Error("This file is not on your eClass portal");
      }
      return downloadFromPortal(portalBase, parsed.toString(), decodeURIComponent(parsed.pathname.split("/").pop() || "download"));
    },
    async streamCourseZip(courseCode: string) {
      const portalBase = resolvePortalBase(courseCode);
      const rootNodes = await listDocuments(courseCode, "/");
      const nativeZipUrl = downloadUrlCache.get(`${courseCode}:__ROOT_ZIP__`);

      if (nativeZipUrl) {
        const res = await getHttp().request(nativeZipUrl);
        persistSoon();
        const ct = res.headers.get("content-type") || "";
        if (res.status === 200 && (ct.includes("zip") || ct.includes("octet-stream")) && res.raw.body) {
          return {
            filename: `${courseCode}-documents.zip`,
            stream: Readable.fromWeb(res.raw.body as unknown as import("node:stream/web").ReadableStream),
          };
        }
        await res.raw.body?.cancel();
      }

      // Fallback: recursively fetch files and stream a zip via archiver
      const archive = archiver("zip", { zlib: { level: 6 } });
      const stream = new PassThrough();
      archive.pipe(stream);

      const walk = async (nodes: DocNode[], prefix: string) => {
        for (const node of nodes) {
          if (node.isDir) {
            const children = await listDocuments(courseCode, node.path);
            await walk(children, `${prefix}${node.name}/`);
          } else {
            try {
              const file = await this.downloadFile(courseCode, node.path);
              archive.append(file.body as Buffer, { name: `${prefix}${node.name}` });
            } catch {
              /* skip unreadable file */
            }
          }
        }
      };

      void (async () => {
        try {
          await walk(rootNodes, "");
          await archive.finalize();
        } catch (err) {
          stream.destroy(err as Error);
        }
      })();

      return { filename: `${courseCode}-documents.zip`, stream };
    },
  };
}
