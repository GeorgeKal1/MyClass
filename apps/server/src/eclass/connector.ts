import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import type {
  Announcement,
  Assignment,
  CatalogCourse,
  Course,
  DepartmentInfo,
  DocNode,
  Message,
  University,
} from "@myclass/shared";
import { decrypt, encrypt } from "../crypto.js";
import { users, type UserRecord } from "../store.js";
import { EclassHttp } from "./http.js";
import {
  parseAnnouncementsAjax,
  parseAnnouncementsRss,
  parseAssignmentsHtml,
  parseCasLoginForm,
  parseCatalogHtml,
  parseDocumentsHtml,
  parseIdentityXml,
  parseInboxAjax,
  parseMessageBodyHtml,
  parseMobileCoursesXml,
  parseMyCoursesHtml,
  parseUserDisplayName,
  type DataTablesResponse,
} from "./parsers.js";
import {
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

export interface EclassConnector {
  verifyLogin(): Promise<{ displayName: string }>;
  listCourses(): Promise<Course[]>;
  getAnnouncements(courseCode?: string): Promise<Announcement[]>;
  getMessages(): Promise<Message[]>;
  getMessage(id: string): Promise<Message | null>;
  listDocuments(courseCode: string, dir?: string): Promise<DocNode[]>;
  getAssignments(courseCode?: string): Promise<Assignment[]>;
  listDepartments(): DepartmentInfo[];
  listCatalog(query?: string, departmentId?: string): Promise<CatalogCourse[]>;
  enrollCourse(codeOrId: string): Promise<Course>;
  unenrollCourse(codeOrId: string): Promise<Course>;
  downloadFile(
    courseCode: string,
    filePathOrUrl: string,
  ): Promise<{ filename: string; contentType: string; body: Buffer | Readable }>;
  streamCourseZip(courseCode: string): Promise<{ filename: string; stream: Readable }>;
}

// Keep transient in-memory passwords & cookies for "session-only" logins (remember=false)
const sessionPasswords = new Map<string, string>();
const sessionCookies = new Map<string, string>();

// Short-lived in-memory catalog cache per `${userId}:${departmentId}`
const catalogCache = new Map<string, { expiresAt: number; items: CatalogCourse[] }>();
const CATALOG_TTL_MS = 3 * 60 * 1000;

export function invalidateUserCatalogCache(userId: string) {
  for (const key of catalogCache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      catalogCache.delete(key);
    }
  }
}

export function setTransientCredentials(userId: string, password?: string, serializedJar?: string) {
  if (password) sessionPasswords.set(userId, password);
  if (serializedJar) sessionCookies.set(userId, serializedJar);
}

/**
 * Authenticates a single Open eClass portal (`baseUrl`) into the provided `EclassHttp` cookie jar.
 */
export async function authenticatePortalSession(
  http: EclassHttp,
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ displayName?: string; mobileToken?: string }> {
  const base = baseUrl.replace(/\/$/, "");

  // Discover CAS start URL from midentity.php when available
  let casStartUrl = `${base}/modules/auth/cas.php?next=/modules/mobile/mtoken.php`;
  try {
    const idRes = await http.getText(`${base}/modules/mobile/midentity.php`);
    const parsed = parseIdentityXml(idRes.html, base);
    if (parsed.casUrl) casStartUrl = parsed.casUrl;
  } catch {
    /* ignore – use default cas.php */
  }

  // Step 1: GET CAS entry -> redirects to university SSO login form (or auto-logins via existing SSO TGC cookie)
  const casPage = await http.request(casStartUrl);
  let mobileToken: string | undefined;

  if (casPage.unfollowedLocation?.startsWith("eclass-token:")) {
    mobileToken = decodeURIComponent(casPage.unfollowedLocation).split("|")[1];
  } else {
    const loginHtml = await casPage.text();
    const formSpec = parseCasLoginForm(loginHtml, casPage.url);

    if (formSpec) {
      // Step 2: Submit credentials to CAS
      const postRes = await http.request(formSpec.actionUrl, {
        method: "POST",
        form: {
          ...formSpec.fields,
          username,
          password,
        },
        headers: {
          Referer: casPage.url,
          Origin: new URL(casPage.url).origin,
        },
      });

      if (postRes.unfollowedLocation?.startsWith("eclass-token:")) {
        mobileToken = decodeURIComponent(postRes.unfollowedLocation).split("|")[1];
      } else {
        const afterHtml = await postRes.text();
        if (postRes.url.includes("/login") && parseCasLoginForm(afterHtml, postRes.url) !== null) {
          throw new Error("Invalid CAS username or password (check your university SSO credentials)");
        }
      }
    } else if (isLoggedOutPage(casPage.url, loginHtml)) {
      // Fallback: native eClass login via mlogin.php
      const mlogin = await http.request(`${base}/modules/mobile/mlogin.php`, {
        method: "POST",
        form: { uname: username, pass: password },
      });
      const tokenText = (await mlogin.text()).trim();
      if (!tokenText || tokenText === "FAILED" || tokenText === "USERNOTACTIVE" || tokenText === "NOTENABLED") {
        throw new Error(`eClass login failed (${tokenText || "unknown error"})`);
      }
      mobileToken = tokenText;
    }
  }

  // Step 3: Ensure standard web session variables ($_SESSION['uid'], $_SESSION['courses']) are hydrated
  let portfolioRes = await http.getText(`${base}/main/portfolio.php`);
  if (isLoggedOutPage(portfolioRes.url, portfolioRes.html)) {
    if (mobileToken) {
      await http.request(
        `${base}/modules/mobile/mlogin.php?redirect=${encodeURIComponent(`${base}/main/portfolio.php`)}`,
        {
          method: "POST",
          form: { token: mobileToken },
        },
      );
      portfolioRes = await http.getText(`${base}/main/portfolio.php`);
    } else {
      throw new Error(`CAS authentication did not establish an active eClass session on ${base}`);
    }
  }

  const displayName = parseUserDisplayName(portfolioRes.html);
  return { displayName, mobileToken };
}

/**
 * Performs a fresh login (CAS SSO or native eClass) and returns the authenticated
 * `EclassHttp` instance along with the student's real display name.
 * For University of Piraeus (`unipi`), authenticates both `eclass.unipi.gr` and
 * `thales.cs.unipi.gr` into the same cookie jar.
 */
export async function performEclassLogin(
  uni: University,
  username: string,
  password: string,
): Promise<{ http: EclassHttp; displayName: string; mobileToken?: string }> {
  const http = new EclassHttp();
  const primary = await authenticatePortalSession(http, uni.eclassUrl, username, password);
  let displayName = primary.displayName;

  if (uni.id === "unipi") {
    try {
      const thales = await authenticatePortalSession(http, THALES_BASE_URL, username, password);
      if (!displayName && thales.displayName) {
        displayName = thales.displayName;
      }
    } catch {
      /* Thales is optional for non-CS students if unreachable, but normally succeeds via SSO */
    }
  }

  return {
    http,
    displayName: displayName || username,
    mobileToken: primary.mobileToken,
  };
}

function isLoggedOutPage(url: string, html: string): boolean {
  if (/login_form\.php|sso\.|\/cas\/login/i.test(url)) return true;
  if (html.includes("jumbotron-login") || (html.includes('name="uname"') && html.includes('name="pass"'))) {
    return true;
  }
  return false;
}

export function getConnectorForUser(user: UserRecord, passwordOverride?: string): EclassConnector {
  const uni = getUniversity(user.universityId) ?? getUniversity("unipi")!;
  return createLiveConnector(user, uni, passwordOverride);
}

function createLiveConnector(user: UserRecord, uni: University, passwordOverride?: string): EclassConnector {
  const isUniPi = uni.id === "unipi";
  const primaryBase = uni.eclassUrl.replace(/\/$/, "");
  const uidByBase = new Map<string, number>();
  const csrfTokenByBase = new Map<string, string>();
  const downloadUrlCache = new Map<string, string>();
  const messagePortalMap = new Map<string, string>();

  const resolvePortalBase = (courseCode?: string): string => {
    if (!isUniPi || !courseCode) return primaryBase;
    return resolveUniPiPortalForCourse(courseCode) === "thales"
      ? THALES_BASE_URL
      : UNIPI_CENTRAL_BASE_URL;
  };

  const getActivePortals = (): string[] => {
    if (isUniPi) return [THALES_BASE_URL, UNIPI_CENTRAL_BASE_URL];
    return [primaryBase];
  };

  const loadHttp = (): EclassHttp => {
    const encJar = user.encSession ?? sessionCookies.get(user.id);
    if (encJar) {
      try {
        const json = user.encSession ? decrypt(user.encSession) : encJar;
        return EclassHttp.fromSerialized(json);
      } catch {
        /* fall through */
      }
    }
    return new EclassHttp();
  };

  const saveHttp = (http: EclassHttp) => {
    const serialized = http.serialize();
    sessionCookies.set(user.id, serialized);
    if (user.remember) {
      users.update(user.id, (u) => {
        u.encSession = encrypt(serialized);
      });
    }
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

  const ensurePortalAuth = async (portalBase: string, forceRelogin = false): Promise<EclassHttp> => {
    const http = loadHttp();
    if (!forceRelogin) {
      return http;
    }
    const pw = getPassword();
    if (!pw) {
      throw new Error("eClass session expired. Please sign in again.");
    }
    const { displayName } = await authenticatePortalSession(http, portalBase, user.username, pw);
    saveHttp(http);
    if (displayName && displayName !== user.displayName && displayName !== "Το προφίλ μου") {
      users.update(user.id, (u) => {
        u.displayName = displayName;
      });
    }
    return http;
  };

  const authedGet = async (portalBase: string, url: string): Promise<{ url: string; html: string }> => {
    let http = await ensurePortalAuth(portalBase, false);
    let res = await http.getText(url);
    if (isLoggedOutPage(res.url, res.html)) {
      http = await ensurePortalAuth(portalBase, true);
      res = await http.getText(url);
    }
    // Opportunistically fix displayName if it was still set to username or "Το προφίλ μου"
    if (user.displayName === "Το προφίλ μου" || user.displayName === user.username) {
      const detected = parseUserDisplayName(res.html);
      if (detected && detected !== user.displayName) {
        user.displayName = detected;
        users.update(user.id, (u) => {
          u.displayName = detected;
        });
      }
    }
    saveHttp(http);
    return res;
  };

  const authedAjaxPost = async (
    portalBase: string,
    url: string,
    form: Record<string, string>,
  ): Promise<DataTablesResponse> => {
    let http = await ensurePortalAuth(portalBase, false);
    const doPost = async (h: EclassHttp) =>
      h.request(url, {
        method: "POST",
        form,
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });

    let res = await doPost(http);
    let text = await res.text();
    if (isLoggedOutPage(res.url, text) || !text.trim().startsWith("{")) {
      http = await ensurePortalAuth(portalBase, true);
      res = await doPost(http);
      text = await res.text();
    }
    saveHttp(http);
    try {
      return JSON.parse(text) as DataTablesResponse;
    } catch {
      return { aaData: [] };
    }
  };

  const listPortalCourses = async (portalBase: string): Promise<Course[]> => {
    try {
      const { html } = await authedGet(portalBase, `${portalBase}/main/my_courses.php?term=`);
      const parsed = parseMyCoursesHtml(html);
      if (parsed.uid) uidByBase.set(portalBase, parsed.uid);
      if (parsed.courses.length > 0) {
        return parsed.courses.map((c) => {
          const sem = resolveSemesterForCourse(c.code, c.title);
          return {
            ...c,
            semester: sem.shortLabel,
            semesterIndex: sem.index,
            semesterFolder: sem.folder,
            portal: new URL(portalBase).host,
            enrolled: true,
          };
        });
      }

      // Fallback: mobile API using PHPSESSID cookie value as token
      const http = await ensurePortalAuth(portalBase, false);
      const cookies = await http.jar.getCookies(portalBase);
      const sessCookie = cookies.find((c) => c.key === "PHPSESSID");
      if (sessCookie) {
        const mRes = await http.request(`${portalBase}/modules/mobile/mcourses.php`, {
          method: "POST",
          form: { token: sessCookie.value },
        });
        const xml = await mRes.text();
        if (xml.includes("<courses")) {
          return parseMobileCoursesXml(xml).map((c) => {
            const sem = resolveSemesterForCourse(c.code, c.title);
            return {
              ...c,
              semester: sem.shortLabel,
              semesterIndex: sem.index,
              semesterFolder: sem.folder,
              portal: new URL(portalBase).host,
              enrolled: true,
            };
          });
        }
      }
    } catch {
      /* ignore portal failure so the other portal still loads */
    }
    return [];
  };

  const listCourses = async (): Promise<Course[]> => {
    const portals = getActivePortals();
    const lists = await Promise.all(portals.map((p) => listPortalCourses(p)));
    const byCode = new Map<string, Course>();
    for (const c of lists.flat()) {
      if (EXCLUDED_COURSE_CODES.has(c.code)) continue;
      if (!byCode.has(c.code)) {
        byCode.set(c.code, c);
      }
    }
    return [...byCode.values()].sort(
      (a, b) => (a.semesterIndex ?? 99) - (b.semesterIndex ?? 99) || a.title.localeCompare(b.title, "el"),
    );
  };

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
      if (n.downloadUrl) {
        downloadUrlCache.set(`${courseCode}:${n.path}`, n.downloadUrl);
      }
    }
    return currentYearNodes.map((n) => ({
      ...n,
      downloadUrl: `/api/courses/${encodeURIComponent(courseCode)}/documents/file?path=${encodeURIComponent(n.path)}`,
    }));
  };

  /**
   * Open eClass 4.x AJAX course registration / unregistration endpoint:
   * POST `${portalBase}/modules/auth/course_submit.php` with `{ cid, state: "true"|"false", token }`
   */
  const fetchPortalCsrfToken = async (portalBase: string): Promise<string | undefined> => {
    const fcUrl =
      portalBase === THALES_BASE_URL
        ? `${portalBase}/modules/auth/courses.php?fc=19`
        : `${portalBase}/modules/auth/courses.php`;
    const { html } = await authedGet(portalBase, fcUrl);
    const { csrfToken } = parseCatalogHtml(html);
    if (csrfToken) {
      csrfTokenByBase.set(portalBase, csrfToken);
    }
    return csrfToken;
  };

  const submitCourseToggle = async (
    portalBase: string,
    numericId: number,
    state: "true" | "false",
  ): Promise<string> => {
    let token = csrfTokenByBase.get(portalBase) ?? (await fetchPortalCsrfToken(portalBase));
    const doSubmit = async (csrf: string | undefined) => {
      const http = await ensurePortalAuth(portalBase, false);
      const res = await http.request(`${portalBase}/modules/auth/course_submit.php`, {
        method: "POST",
        form: {
          cid: String(numericId),
          state,
          ...(csrf ? { token: csrf } : {}),
        },
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${portalBase}/modules/auth/courses.php`,
        },
      });
      saveHttp(http);
      return (await res.text()).trim();
    };

    let statusText = await doSubmit(token);
    if (
      statusText !== "registered" &&
      statusText !== "unregistered"
    ) {
      // Refresh CSRF token (or re-login if session expired) and retry once
      token = await fetchPortalCsrfToken(portalBase);
      statusText = await doSubmit(token);
    }
    return statusText;
  };

  return {
    async verifyLogin() {
      const pw = getPassword();
      if (!pw) throw new Error("Password is required to verify login");
      const { http, displayName } = await performEclassLogin(uni, user.username, pw);
      saveHttp(http);
      return { displayName };
    },
    listCourses,
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

        // Fallback to course RSS feed
        const rss = await authedGet(
          portalBase,
          `${portalBase}/modules/announcements/rss.php?c=${encodeURIComponent(courseCode)}`,
        );
        return filterCurrentAcademicYearAnnouncements(parseAnnouncementsRss(rss.html, courseCode));
      }

      const portals = getActivePortals();
      const results = await Promise.all(
        portals.map(async (portalBase) => {
          try {
            const json = await authedAjaxPost(
              portalBase,
              `${portalBase}/modules/announcements/myannouncements.php`,
              {
                start: "0",
                length: "50",
                "search[value]": "",
              },
            );
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
      const portals = getActivePortals();
      const results = await Promise.all(
        portals.map(async (portalBase) => {
          try {
            const json = await authedAjaxPost(
              portalBase,
              `${portalBase}/modules/message/ajax_handler.php?mbox_type=inbox`,
              {
                start: "0",
                length: "50",
                "search[value]": "",
              },
            );
            const list = parseInboxAjax(json, portalBase);
            for (const m of list) {
              messagePortalMap.set(m.id, portalBase);
            }
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
        messagePortalMap.get(id) ??
        (summary?.courseCode ? resolvePortalBase(summary.courseCode) : UNIPI_CENTRAL_BASE_URL);
      const { html } = await authedGet(
        portalBase,
        `${portalBase}/modules/message/inbox.php?mid=${encodeURIComponent(id)}`,
      );
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
        ? [{ code: courseCode, title: undefined }]
        : (await listCourses()).map((c) => ({ code: c.code, title: c.title }));

      const results = await Promise.all(
        targetCourses.map(async (c) => {
          try {
            const portalBase = resolvePortalBase(c.code);
            const pageUrl = `${portalBase}/modules/work/index.php?course=${encodeURIComponent(c.code)}`;
            const { html, url } = await authedGet(portalBase, pageUrl);
            return parseAssignmentsHtml(html, url, c.code, c.title);
          } catch {
            return [];
          }
        }),
      );
      return filterCurrentAcademicYearAssignments(results.flat());
    },
    listDepartments(): DepartmentInfo[] {
      if (!isUniPi) {
        return [
          {
            id: "default",
            name: uni.name,
            nameEn: uni.nameEn,
            portalLabel: new URL(primaryBase).host,
          },
        ];
      }
      return UNIPI_DEPARTMENTS.map(({ id, name, nameEn, portalLabel }) => ({
        id,
        name,
        nameEn,
        portalLabel,
      }));
    },
    async listCatalog(query?: string, departmentId?: string): Promise<CatalogCourse[]> {
      const deptId = isUniPi
        ? departmentId || detectUniPiDepartmentFromUsername(user.username)
        : "default";
      const cacheKey = `${user.id}:${deptId}`;
      const now = Date.now();
      let items: CatalogCourse[];

      const cached = catalogCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        items = cached.items;
      } else if (!isUniPi) {
        const { html } = await authedGet(primaryBase, `${primaryBase}/modules/auth/courses.php`);
        const { courses, csrfToken } = parseCatalogHtml(html);
        if (csrfToken) csrfTokenByBase.set(primaryBase, csrfToken);
        items = courses.map((c) => {
          const sem = resolveSemesterForCourse(c.code, c.title);
          return {
            ...c,
            semester: sem.shortLabel,
            semesterIndex: sem.index,
            semesterFolder: sem.folder,
            portal: new URL(primaryBase).host,
          };
        });
        catalogCache.set(cacheKey, { expiresAt: now + CATALOG_TTL_MS, items });
      } else {
        const dept = UNIPI_DEPARTMENTS.find((d) => d.id === deptId) ?? UNIPI_DEPARTMENTS[0];
        const enrolledCourses = await listCourses();
        const enrolledSet = new Set(enrolledCourses.map((c) => c.code.toUpperCase()));

        const fetchedBatches = await Promise.all(
          dept.sources.map(async (src) => {
            const portalBase = src.portal === "thales" ? THALES_BASE_URL : UNIPI_CENTRAL_BASE_URL;
            const portalHost = src.portal === "thales" ? "thales.cs.unipi.gr" : "eclass.unipi.gr";
            try {
              const { html } = await authedGet(
                portalBase,
                `${portalBase}/modules/auth/courses.php?fc=${src.fc}`,
              );
              const { courses, csrfToken } = parseCatalogHtml(html);
              if (csrfToken) csrfTokenByBase.set(portalBase, csrfToken);
              return courses
                .filter((c) => !EXCLUDED_COURSE_CODES.has(c.code.toUpperCase()))
                .map((c) => {
                  const sem = resolveSemesterForCourse(c.code, c.title, src.defaultYear);
                  return {
                    ...c,
                    enrolled: c.enrolled || enrolledSet.has(c.code.toUpperCase()),
                    semester: sem.shortLabel,
                    semesterIndex: sem.index,
                    semesterFolder: sem.folder,
                    departmentId: dept.id,
                    departmentName: dept.name,
                    portal: portalHost,
                  } satisfies CatalogCourse;
                });
            } catch {
              return [];
            }
          }),
        );

        const byCode = new Map<string, CatalogCourse>();
        for (const c of fetchedBatches.flat()) {
          const key = c.code.toUpperCase();
          if (!byCode.has(key)) {
            byCode.set(key, c);
          }
        }

        // Add cross-department courses (such as ODE180 on eclass.unipi.gr for Informatics students)
        if (dept.extraCentralCourses) {
          for (const extra of dept.extraCentralCourses) {
            const key = extra.code.toUpperCase();
            if (!byCode.has(key)) {
              const sem = SEMESTERS[extra.semesterIndex] ?? SEMESTERS[1];
              byCode.set(key, {
                code: extra.code,
                publicCode: extra.publicCode,
                title: extra.title,
                professor: extra.professor,
                numericId: extra.numericId,
                enrolled: enrolledSet.has(key),
                locked: false,
                semester: sem.shortLabel,
                semesterIndex: sem.index,
                semesterFolder: sem.folder,
                departmentId: dept.id,
                departmentName: dept.name,
                portal: "eclass.unipi.gr",
              });
            }
          }
        }

        items = [...byCode.values()].sort(
          (a, b) =>
            (a.semesterIndex ?? 99) - (b.semesterIndex ?? 99) ||
            a.title.localeCompare(b.title, "el"),
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
    },
    async enrollCourse(codeOrId: string): Promise<Course> {
      const catalog = await this.listCatalog();
      const q = codeOrId.trim().toLowerCase();
      const match =
        catalog.find(
          (c) =>
            c.code.toLowerCase() === q ||
            c.publicCode?.toLowerCase() === q ||
            String(c.numericId) === q,
        ) ??
        catalog.find((c) => c.title.toLowerCase().includes(q));

      if (!match || !match.numericId) {
        throw new Error(`Course "${codeOrId}" was not found in the university catalog`);
      }
      if (match.locked) {
        throw new Error(`Course "${match.title}" requires a password or has closed registration on eClass`);
      }

      const portalBase = resolvePortalBase(match.code);
      const statusText = await submitCourseToggle(portalBase, match.numericId, "true");
      if (statusText !== "registered") {
        throw new Error(
          `eClass could not register "${match.title}" (response: ${statusText || "unknown"})`,
        );
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
          (c) =>
            c.code.toLowerCase() === q ||
            c.publicCode?.toLowerCase() === q ||
            String(c.numericId) === q,
        ) ?? allCourses.find((c) => c.title.toLowerCase().includes(q));

      if (!target) {
        const catalog = await this.listCatalog();
        const catMatch =
          catalog.find(
            (c) =>
              c.code.toLowerCase() === q ||
              c.publicCode?.toLowerCase() === q ||
              String(c.numericId) === q,
          ) ?? catalog.find((c) => c.title.toLowerCase().includes(q));
        if (catMatch) {
          target = {
            code: catMatch.code,
            publicCode: catMatch.publicCode,
            title: catMatch.title,
            professor: catMatch.professor,
            numericId: catMatch.numericId,
            semester: catMatch.semester,
            semesterIndex: catMatch.semesterIndex,
            semesterFolder: catMatch.semesterFolder,
            portal: catMatch.portal,
            enrolled: false,
          };
        }
      }

      if (!target) {
        throw new Error(`Course "${codeOrId}" is not in your enrolled courses`);
      }

      const portalBase = resolvePortalBase(target.code);
      if (!target.numericId) {
        const catalog = await this.listCatalog();
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

      if (!target.numericId) {
        throw new Error(`Could not resolve numeric course ID for "${codeOrId}" to unenroll`);
      }

      const statusText = await submitCourseToggle(portalBase, target.numericId, "false");
      if (statusText !== "unregistered") {
        const uid = uidByBase.get(portalBase);
        if (uid) {
          const http = await ensurePortalAuth(portalBase, false);
          await http.request(`${portalBase}/main/unregcours.php?u=${uid}&cid=${target.numericId}`, {
            method: "POST",
            form: {
              doit: "1",
              fromMyCoursesPage: "1",
            },
          });
          saveHttp(http);
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

      const http = await ensurePortalAuth(portalBase, false);
      const res = await http.request(targetUrl);
      saveHttp(http);
      const disp = res.headers.get("content-disposition") || "";
      const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      const filename = fnMatch ? decodeURIComponent(fnMatch[1]) : filePath.split("/").pop() || "download";
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const arrayBuf = await res.raw.arrayBuffer();
      return {
        filename,
        contentType,
        body: Buffer.from(arrayBuf),
      };
    },
    async streamCourseZip(courseCode: string) {
      const portalBase = resolvePortalBase(courseCode);
      const rootNodes = await listDocuments(courseCode, "/");
      const nativeZipUrl = downloadUrlCache.get(`${courseCode}:__ROOT_ZIP__`);

      if (nativeZipUrl) {
        const http = await ensurePortalAuth(portalBase, false);
        const res = await http.request(nativeZipUrl);
        saveHttp(http);
        const ct = res.headers.get("content-type") || "";
        if (res.status === 200 && (ct.includes("zip") || ct.includes("octet-stream")) && res.raw.body) {
          return {
            filename: `${courseCode}-documents.zip`,
            stream: Readable.fromWeb(res.raw.body as unknown as import("node:stream/web").ReadableStream),
          };
        }
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
              archive.append(file.body, { name: `${prefix}${node.name}` });
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
