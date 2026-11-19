import * as cheerio from "cheerio";
import type {
  Announcement,
  Assignment,
  CatalogCourse,
  Course,
  DocNode,
  Message,
} from "@myclass/shared";

/**
 * Pure HTML / XML / JSON parsers for Open eClass 4.x (verified against 4.2.1 on
 * eclass.unipi.gr and 4.4.3 on thales.cs.unipi.gr).
 *
 * Kept pure (string/JSON in -> domain objects out) so every parser can be unit
 * tested against saved fixtures without network access.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function absUrl(base: string, href?: string | null): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim().replace(/&amp;/g, "&");
  if (!trimmed || trimmed.startsWith("javascript:")) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

export function stripHtml(html: string): string {
  const $ = cheerio.load(`<div>${html}</div>`);
  return $("div").text().replace(/\s+/g, " ").trim();
}

const GREEK_MONTHS: Record<string, number> = {
  ιαν: 0,
  φεβ: 1,
  μαρ: 2,
  απρ: 3,
  μαι: 4,
  μαϊ: 4,
  ιουν: 5,
  ιουλ: 6,
  αυγ: 7,
  σεπ: 8,
  οκτ: 9,
  νοε: 10,
  δεκ: 11,
};

function applyGreekMeridiem(hour: number, lower: string): number {
  const isPm = lower.includes("μ.μ") || lower.includes("μμ") || /\bpm\b/.test(lower);
  const isAm = lower.includes("π.μ") || lower.includes("πμ") || /\bam\b/.test(lower);
  if (isPm && hour < 12) return hour + 12;
  if (isAm && hour === 12) return 0;
  return hour;
}

/**
 * Parses dates formatted by Open eClass `format_locale_date()`:
 * - Relative Greek dates: "σήμερα - 1:14 μ.μ.", "χθες - 7:47 μ.μ.", "προχθές - 10:00 π.μ."
 * - Numeric dates (4-digit or 2-digit year): "13-11-2026 14:30", "29/10/12, 10:19 π.μ.", "25/11/25"
 * - Greek month names: "13 Νοεμβρίου 2026, 2:30 μ.μ."
 * - ISO / RFC-2822 strings
 */
export function parseEclassDate(raw?: string | null): string {
  if (!raw) return new Date().toISOString();
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return new Date().toISOString();
  const lower = s.toLowerCase();

  // 1. Relative Greek dates ("σήμερα", "χθες", "προχθές")
  if (lower.includes("σήμερα") || lower.includes("χθες") || lower.includes("προχθές")) {
    const now = new Date();
    const offsetDays = lower.includes("προχθές") ? 2 : lower.includes("χθες") ? 1 : 0;
    const timeMatch = lower.match(/(\d{1,2}):(\d{2})/);
    const hh = timeMatch ? applyGreekMeridiem(Number(timeMatch[1]), lower) : 12;
    const mm = timeMatch ? Number(timeMatch[2]) : 0;
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays, hh, mm, 0);
    return dt.toISOString();
  }

  // 2. DD-MM-YYYY or DD/MM/YYYY or DD/MM/YY [optional time + π.μ./μ.μ.]
  const dmy = s.match(
    /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[\s,+-]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (dmy) {
    const [, d, m, yRaw, hh = "0", mm = "0", ss = "0"] = dmy;
    let year = Number(yRaw);
    if (yRaw.length === 2) {
      year += year >= 70 ? 1900 : 2000;
    }
    const hour = applyGreekMeridiem(Number(hh), lower);
    const dt = new Date(year, Number(m) - 1, Number(d), hour, Number(mm), Number(ss));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  // 3. Greek month name, e.g. "13 Νοεμβρίου 2026, 2:30 μ.μ."
  for (const [prefix, monthIdx] of Object.entries(GREEK_MONTHS)) {
    if (lower.includes(prefix)) {
      const nums = lower.match(/(\d{1,2})[^\d]+(\d{4})(?:.*?(\d{1,2}):(\d{2}))?/);
      if (nums) {
        const [, d, y, hh = "12", mm = "0"] = nums;
        const hour = applyGreekMeridiem(Number(hh), lower);
        const dt = new Date(Number(y), monthIdx, Number(d), hour, Number(mm));
        if (!Number.isNaN(dt.getTime())) return dt.toISOString();
      }
    }
  }

  const native = new Date(s);
  if (!Number.isNaN(native.getTime())) return native.toISOString();
  return new Date().toISOString();
}

export function parseFileSize(raw?: string | null): number | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/([\d.,]+)\s*(B|KB|MB|GB)/i);
  if (!m) return undefined;
  const val = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(val)) return undefined;
  const unit = m[2].toUpperCase();
  const mult = unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : unit === "KB" ? 1e3 : 1;
  return Math.round(val * mult);
}

/* ------------------------------------------------------------------ */
/* CAS login form                                                      */
/* ------------------------------------------------------------------ */

export interface CasFormSpec {
  actionUrl: string;
  fields: Record<string, string>;
  /** Name of the username input (`username`, `j_username`, `uname`, …). */
  userField?: string;
  /** Name of the password input; undefined when the form has no password field. */
  passField?: string;
}

/**
 * Detects an auto-submitting SSO hand-off form (SAML `SAMLResponse`/`RelayState`, Shibboleth
 * "proceed" pages, `<body onload="document.forms[0].submit()">`), which browsers post via JavaScript.
 */
export function parseAutoPostForm(html: string, pageUrl: string): CasFormSpec | null {
  const $ = cheerio.load(html);
  let found: CasFormSpec | null = null;
  $("form").each((_, el) => {
    if (found) return;
    const form = $(el);
    if (form.find("input[type='password']").length) return;
    const fields: Record<string, string> = {};
    form.find("input").each((__, inp) => {
      const name = $(inp).attr("name");
      const type = ($(inp).attr("type") || "text").toLowerCase();
      if (name && (type === "hidden" || type === "submit")) fields[name] = $(inp).attr("value") ?? "";
    });
    const isSaml = "SAMLResponse" in fields || "SAMLRequest" in fields || "RelayState" in fields;
    const autoSubmits = /\.submit\(\)/.test(html) || /onload=["'][^"']*submit/i.test(html);
    if (!isSaml && !(autoSubmits && Object.keys(fields).length > 0)) return;
    const actionUrl = absUrl(pageUrl, form.attr("action") || pageUrl) ?? pageUrl;
    found = { actionUrl, fields };
  });
  return found;
}

/**
 * Extracts the `<form>` action and hidden fields (`execution`, `lt`, `_eventId`,
 * `geolocation`, etc.) from an Apereo CAS / custom SSO login page.
 */
export function parseCasLoginForm(html: string, pageUrl: string): CasFormSpec | null {
  const $ = cheerio.load(html);
  const form = $("form#fm1, form[action*='login'], form:has(input[type='password'])").first();
  if (!form.length) return null;

  const actionAttr = form.attr("action") || pageUrl;
  const actionUrl = absUrl(pageUrl, actionAttr) ?? pageUrl;

  const fields: Record<string, string> = {};
  let userField: string | undefined;
  let passField: string | undefined;
  form.find("input").each((_, el) => {
    const inp = $(el);
    const name = inp.attr("name");
    const type = (inp.attr("type") || "text").toLowerCase();
    if (!name) return;
    if (type === "hidden" || type === "submit") {
      fields[name] = inp.attr("value") ?? "";
    } else if (type === "password" && !passField) {
      passField = name;
    } else if ((type === "text" || type === "email") && !userField) {
      userField = name;
    }
  });
  if (!("_eventId" in fields)) fields._eventId = "submit";
  return { actionUrl, fields, userField, passField };
}

/* ------------------------------------------------------------------ */
/* Mobile API XML (`midentity.php`, `mcourses.php`, `mportfolio.php`)  */
/* ------------------------------------------------------------------ */

export function parseIdentityXml(xml: string, baseUrl: string): { casUrl?: string; version?: string } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const version = $("platform").attr("version") ?? undefined;
  const casAuth = $("auth")
    .filter((_, el) => /cas/i.test($(el).attr("title") || "") || /cas\.php/i.test($(el).attr("url") || ""))
    .first();
  const rawUrl = casAuth.attr("url");
  return {
    version,
    casUrl: rawUrl ? absUrl(baseUrl, rawUrl) : undefined,
  };
}

export function parseMobileCoursesXml(xml: string): Course[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: Course[] = [];
  $("course").each((_, el) => {
    const node = $(el);
    const code = node.attr("code")?.trim();
    const rawTitle = node.attr("title")?.trim() || code;
    if (!code || !rawTitle) return;
    // mcourses.php formats title as `Title - PUBLIC_CODE` when code !== public_code
    const parts = rawTitle.split(" - ");
    const publicCode = parts.length > 1 ? parts[parts.length - 1]?.trim() : code;
    const title = parts.length > 1 ? parts.slice(0, -1).join(" - ").trim() : rawTitle;
    out.push({ code, title, publicCode });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* My Courses HTML (`/main/my_courses.php?term=`)                      */
/* ------------------------------------------------------------------ */

export interface ParsedMyCourses {
  courses: Course[];
  uid?: number;
}

/**
 * Parses the HTML fragment returned by `GET /main/my_courses.php?term=` in
 * Open eClass 4.x. Also extracts the numeric `course_id` and user `uid` from
 * the unenroll modal `<form action=".../main/unregcours.php?u=UID&cid=CID">`.
 */
export function parseMyCoursesHtml(html: string): ParsedMyCourses {
  const $ = cheerio.load(html);
  const byCode = new Map<string, Course>();
  let uid: number | undefined;

  // Map modal id -> { cid, uid, title }
  const modalMap = new Map<string, { cid: number; title?: string }>();
  $("form[action*='unregcours.php']").each((_, el) => {
    const action = $(el).attr("action") || "";
    const uMatch = action.match(/[?&]u=(\d+)/);
    const cMatch = action.match(/[?&]cid=(\d+)/);
    if (uMatch) uid = Number(uMatch[1]);
    if (cMatch) {
      const cid = Number(cMatch[1]);
      const modalId = $(el).closest(".modal").attr("id") || `exampleModal${cid}`;
      const title = $(el).find(".modal-body strong").first().text().trim() || undefined;
      modalMap.set(`#${modalId}`, { cid, title });
    }
  });

  $(".card").each((_, cardEl) => {
    const card = $(cardEl);
    const link = card.find("a[href*='/courses/']").first();
    const href = link.attr("href") || "";
    const m = href.match(/\/courses\/([^/?#]+)/);
    if (!m) return;
    const code = decodeURIComponent(m[1]);
    const title = link.text().replace(/\s+/g, " ").trim() || code;

    const texts = card
      .find(".card-body .card-text")
      .map((__, t) => $(t).text().replace(/\s+/g, " ").trim())
      .get();
    const publicCode = texts[0]?.split(":").slice(1).join(":").trim() || code;
    const professor = texts[1]?.split(":").slice(1).join(":").trim() || undefined;

    const modalTarget = card.find("[data-bs-target]").attr("data-bs-target");
    const modalInfo = modalTarget ? modalMap.get(modalTarget) : undefined;

    byCode.set(code, {
      code,
      title,
      publicCode,
      professor,
      numericId: modalInfo?.cid,
      enrolled: true,
    });
  });

  // Fallback: any /courses/<CODE>/ link on portfolio/sidebar
  if (byCode.size === 0) {
    $("a[href*='/courses/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const m = href.match(/\/courses\/([^/?#]+)\/?$/);
      if (!m) return;
      const code = decodeURIComponent(m[1]);
      const title = $(a).text().replace(/\s+/g, " ").trim();
      if (!code || !title || title.length < 2 || byCode.has(code)) return;
      byCode.set(code, { code, title, publicCode: code, enrolled: true });
    });
  }

  return { courses: [...byCode.values()], uid };
}

/* ------------------------------------------------------------------ */
/* Announcements (DataTables AJAX + RSS)                               */
/* ------------------------------------------------------------------ */

export interface DataTablesResponse {
  aaData?: Array<Record<string, string | number>>;
}

/**
 * Parses the JSON returned by DataTables `POST /modules/announcements/myannouncements.php`
 * or `POST /modules/announcements/index.php?course=CODE` (with `X-Requested-With: XMLHttpRequest`).
 */
export function parseAnnouncementsAjax(
  json: DataTablesResponse,
  baseUrl: string,
  fallbackCourse?: { code: string; title?: string },
): Announcement[] {
  const rows = json.aaData ?? [];
  const out: Announcement[] = [];

  for (const row of rows) {
    // Student course view puts HTML in col '0' and date in '1'; editor view uses '1' and '2'.
    const cellHtml = String(row["0"] ?? "").includes("table_td") ? String(row["0"]) : String(row["1"] ?? "");
    const dateRaw = String(row["0"] ?? "").includes("table_td") ? String(row["1"] ?? "") : String(row["2"] ?? "");
    if (!cellHtml) continue;

    const $ = cheerio.load(cellHtml);
    const a = $(".table_td_header a").first();
    const title = a.text().replace(/\s+/g, " ").trim();
    const href = a.attr("href") || "";
    const url = absUrl(baseUrl, href);

    const body = $(".table_td_body").first();
    const idFromAttr = body.attr("data-id") || href.match(/[?&]an_id=(\d+)/)?.[1] || String(row.DT_RowId ?? "");
    const courseFromAttr =
      body.attr("data-course-code") || href.match(/[?&]course=([^&]+)/)?.[1] || fallbackCourse?.code || "SYSTEM";
    const courseTitle = $("small.text-grey").first().text().replace(/\s+/g, " ").trim() || fallbackCourse?.title;

    const contentHtml = body.html()?.trim() ?? "";
    const contentText = stripHtml(contentHtml);

    if (!title && !contentText) continue;
    out.push({
      id: `${courseFromAttr}:${idFromAttr || title}`,
      courseCode: courseFromAttr,
      courseTitle,
      title: title || "(Χωρίς τίτλο)",
      contentHtml,
      contentText,
      date: parseEclassDate(dateRaw),
      url,
    });
  }
  return out;
}

export function parseAnnouncementsRss(xml: string, courseCode: string, courseTitle?: string): Announcement[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: Announcement[] = [];
  $("item").each((_, el) => {
    const item = $(el);
    const title = item.find("title").first().text().trim();
    const link = item.find("link").first().text().trim();
    const descHtml = item.find("description").first().text().trim();
    const pubDate = item.find("pubDate").first().text().trim();
    const anId = link.match(/[?&]an_id=(\d+)/)?.[1] || item.find("guid").text().trim() || title;
    out.push({
      id: `${courseCode}:${anId}`,
      courseCode,
      courseTitle,
      title: title || "(Χωρίς τίτλο)",
      contentHtml: descHtml,
      contentText: stripHtml(descHtml),
      date: parseEclassDate(pubDate),
      url: link || undefined,
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Messages (`POST /modules/message/ajax_handler.php?mbox_type=inbox`) */
/* ------------------------------------------------------------------ */

export function parseInboxAjax(json: DataTablesResponse, baseUrl: string): Message[] {
  const rows = json.aaData ?? [];
  const out: Message[] = [];

  for (const row of rows) {
    const col0 = String(row["0"] ?? "");
    const col1 = String(row["1"] ?? "");
    const col2 = String(row["2"] ?? "");
    const col3 = String(row["3"] ?? "");
    const $0 = cheerio.load(col0);
    const subjLink = $0("a[href*='inbox.php']").first();
    const subject = subjLink.text().replace(/\s+/g, " ").trim();
    const href = subjLink.attr("href") || "";
    const mid = String(row.DT_RowId ?? (href.match(/[?&]mid=(\d+)/)?.[1] || ""));
    if (!mid && !subject) continue;

    const read = $0("i.fa-envelope-open").length > 0 || !col0.includes("<strong>");

    const $1 = cheerio.load(col1);
    const courseLink = $1("a[href*='course=']").first();
    const courseCode = courseLink.attr("href")?.match(/course=([^&]+)/)?.[1];
    const courseTitle = courseLink.text().replace(/\s+/g, " ").trim() || undefined;

    const $2 = cheerio.load(`<div>${col2}</div>`);
    const senderFromLink = $2("a").first().text().replace(/\s+/g, " ").trim();
    const sender = senderFromLink || stripHtml(col2) || "eClass";
    const date = parseEclassDate(stripHtml(col3));

    const attachHref = $0("a[href*='message_download.php']").attr("href");
    const attachments = attachHref
      ? [{ name: "attachment", url: absUrl(`${baseUrl}/modules/message/`, attachHref) ?? attachHref }]
      : undefined;

    out.push({
      id: mid,
      subject: subject || "(Χωρίς θέμα)",
      sender,
      date,
      courseCode,
      courseTitle,
      read,
      attachments,
    });
  }
  return out;
}

export function parseMessageBodyHtml(html: string, baseUrl: string): { bodyHtml: string; attachments: { name: string; url: string }[] } {
  const $ = cheerio.load(html);
  const cards = $("#msg_area .card-body");
  const bodyContainer = cards.length > 1 ? cards.eq(1) : cards.first();
  const bodyHtml = bodyContainer.find("div").first().html()?.trim() || bodyContainer.html()?.trim() || "";

  const attachments: { name: string; url: string }[] = [];
  $("#msg_area a[href*='message_download.php']").each((_, a) => {
    const href = $(a).attr("href");
    const url = absUrl(`${baseUrl}/modules/message/`, href);
    const name = $(a).text().replace(/\s+/g, " ").trim() || "attachment";
    if (url) attachments.push({ name, url });
  });

  return { bodyHtml, attachments };
}

/* ------------------------------------------------------------------ */
/* Documents (`/modules/document/index.php?course=CODE&openDir=/...`)  */
/* ------------------------------------------------------------------ */

export interface ParsedDocumentsPage {
  nodes: DocNode[];
  /** Native eClass "download whole folder as zip" URL, if present on the page. */
  dirZipUrl?: string;
}

export function parseDocumentsHtml(html: string, pageUrl: string): ParsedDocumentsPage {
  const $ = cheerio.load(html);
  const nodes: DocNode[] = [];

  // Native folder-zip link next to the breadcrumb
  let dirZipUrl: string | undefined;
  $("a[href*='download=']").each((_, a) => {
    if ($(a).closest("#document_table").length === 0) {
      dirZipUrl = absUrl(pageUrl, $(a).attr("href"));
      return false;
    }
    return undefined;
  });

  $("#document_table tbody tr").each((_, tr) => {
    const row = $(tr);
    if (row.find("td").length < 3) return;

    const cb = row.find("input[type='checkbox'][filepath]");
    const fileCell = row.find("td.fileURL-th").first();
    const link = (fileCell.length ? fileCell : row).find("a.fileURL-link, a.fileModal, a[href*='openDir='], a[href*='/file.php/']").first();
    if (!link.length) return;

    const name = link.text().replace(/\s+/g, " ").trim();
    if (!name) return;

    const href = link.attr("href") || "";
    const openDirMatch = href.match(/[?&]openDir=([^&#]+)/);
    const isDir =
      cb.attr("isdir") === "1" ||
      cb.attr("isDir") === "1" ||
      row.find(".fa-folder, .fa-folder-open").length > 0 ||
      Boolean(openDirMatch);

    const pathFromCb = cb.attr("filepath");
    const path = pathFromCb || (openDirMatch ? decodeURIComponent(openDirMatch[1]) : `/${name}`);

    const hiddenDownload = fileCell.find("input[type='hidden'][value*='download=']").attr("value");
    const cmdDownload = row.find("a[href*='download=']").attr("href");
    const downloadUrl = absUrl(pageUrl, hiddenDownload || cmdDownload || (!isDir ? href : undefined));

    const tds = row.find("td");
    const sizeText = tds.eq(tds.length - 3).text();
    const dateText = tds.eq(tds.length - 2).attr("title") || tds.eq(tds.length - 2).text();

    nodes.push({
      path,
      name,
      isDir,
      size: isDir ? undefined : parseFileSize(sizeText),
      date: dateText?.trim() ? parseEclassDate(dateText) : undefined,
      downloadUrl,
    });
  });

  return { nodes, dirZipUrl };
}

/* ------------------------------------------------------------------ */
/* Assignments (`/modules/work/index.php?course=CODE`)                 */
/* ------------------------------------------------------------------ */

export function parseAssignmentsHtml(
  html: string,
  pageUrl: string,
  courseCode: string,
  courseTitle?: string,
): Assignment[] {
  const $ = cheerio.load(html);
  const out: Assignment[] = [];

  $("table[id^='assignment_table'] tbody tr, table.table-default tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 4) return;

    const titleLink = tds.eq(0).find("a[href*='id=']").first();
    const title = (titleLink.text() || tds.eq(0).clone().children().remove().end().text()).replace(/\s+/g, " ").trim();
    if (!title) return;

    const href = titleLink.attr("href") || "";
    const id = href.match(/[?&]id=(\d+)/)?.[1] || `${courseCode}-${out.length + 1}`;
    const url = absUrl(pageUrl, href);

    const fullDeadlineCellText = tds.eq(1).text().replace(/\s+/g, " ").trim();
    const isExpired = /έχει λήξει|expired/i.test(fullDeadlineCellText);

    const deadlineCell = tds.eq(1).clone();
    deadlineCell.find("div, small").remove();
    const deadlineRaw = deadlineCell.text().replace(/\s+/g, " ").trim();
    const hasDeadline =
      Boolean(deadlineRaw) &&
      /\d/.test(deadlineRaw) &&
      !/χωρίς|no deadline|δεν υπάρχει|έχει λήξει/i.test(deadlineRaw);

    // Skip assignments that are marked expired without a valid date
    if (isExpired && !hasDeadline) return;

    const submitted = tds.eq(2).find(".fa-check, .fa-check-circle").length > 0;
    const gradeRaw = tds.eq(3).text().replace(/\s+/g, " ").trim();
    const grade = gradeRaw && gradeRaw !== "-" ? gradeRaw : undefined;

    out.push({
      id: `${courseCode}:${id}`,
      courseCode,
      courseTitle,
      title,
      deadline: hasDeadline ? parseEclassDate(deadlineRaw) : undefined,
      submitted,
      grade,
      url,
    });
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Course catalog (`/modules/auth/courses.php`)                        */
/* ------------------------------------------------------------------ */

export interface FacultyLink {
  fc: number;
  name: string;
}

export interface ParsedCatalogPage {
  courses: CatalogCourse[];
  facultyIds: number[];
  /** Sub-faculties listed on this page (departments, programmes, semesters, ...). */
  childFaculties: FacultyLink[];
  /** Breadcrumb ancestors of the current faculty (root first). */
  ancestorFaculties: FacultyLink[];
  /** Name of the faculty this page shows (last breadcrumb element), if any. */
  currentFacultyName?: string;
  csrfToken?: string;
}

export function parseCatalogHtml(html: string): ParsedCatalogPage {
  const $ = cheerio.load(html);
  const courses: CatalogCourse[] = [];
  const facultyIds = new Set<number>();

  const csrfToken = $("input[name='token']").first().attr("value") || undefined;

  // Extract Open eClass 4.x inline `var courses = {"151":["TMA117",2], ...};` map
  const jsCourseMap = new Map<number, { code: string; accessLevel: number }>();
  const jsMatch = html.match(/var\s+courses\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (jsMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsMatch[1]) as Record<string, [string, number]>;
      for (const [cidKey, tuple] of Object.entries(parsed)) {
        const cidNum = Number(cidKey);
        if (!Number.isNaN(cidNum) && Array.isArray(tuple) && typeof tuple[0] === "string") {
          jsCourseMap.set(cidNum, { code: tuple[0], accessLevel: Number(tuple[1] ?? 2) });
        }
      }
    } catch {
      /* ignore malformed inline script */
    }
  }

  const childFaculties: FacultyLink[] = [];
  const ancestorFaculties: FacultyLink[] = [];
  let currentFacultyName: string | undefined;
  const fcOf = (href?: string) => {
    const m = (href || "").match(/courses\.php\?(?:[^"'#]*&)?fc=(\d+)/);
    return m ? Number(m[1]) : undefined;
  };

  $("a[href*='courses.php?fc=']").each((_, a) => {
    const fc = fcOf($(a).attr("href"));
    if (fc !== undefined) facultyIds.add(fc);
  });

  // Breadcrumb: `<li class="list-group-item-action"><a fc=53>Uni</a> » <a fc=57>School</a> » Current</li>`
  const crumb = $("li.list-group-item-action, ol.breadcrumb, .breadcrumb")
    .filter((_, el) => $(el).find("a[href*='courses.php?fc=']").length > 0 && $(el).text().includes("»"))
    .first();
  if (crumb.length) {
    crumb.find("a[href*='courses.php?fc=']").each((_, a) => {
      const fc = fcOf($(a).attr("href"));
      const name = $(a).text().replace(/\s+/g, " ").trim();
      if (fc !== undefined && name) ancestorFaculties.push({ fc, name });
    });
    const tail = crumb.text().split("»").pop()?.replace(/\s+/g, " ").trim();
    if (tail && !ancestorFaculties.some((f) => f.name === tail)) currentFacultyName = tail;
  }
  const ancestorIds = new Set(ancestorFaculties.map((f) => f.fc));

  $("li.list-group-item.element").each((_, li) => {
    const item = $(li);
    // Sub-faculty rows look like course rows but link to `courses.php?fc=N`
    const facultyLink = item.find("a[href*='courses.php?fc=']").first();
    if (facultyLink.length && item.find("input[name='selectCourse[]'], a[href*='/courses/']").length === 0) {
      const fc = fcOf(facultyLink.attr("href"));
      const name = facultyLink.text().replace(/\s+/g, " ").trim();
      if (fc !== undefined && name && !ancestorIds.has(fc) && !childFaculties.some((f) => f.fc === fc)) {
        childFaculties.push({ fc, name });
      }
      return;
    }
    const cb = item.find("input[name='selectCourse[]']");
    const change = item.find("input[name='changeCourse[]']");
    const spanIdMatch = item.find("span[id^='cid']").attr("id")?.match(/^cid(\d+)$/);
    const cidStr = cb.attr("value") || change.attr("value") || spanIdMatch?.[1];
    const numericId = cidStr ? Number(cidStr) : undefined;

    const titleEl = item.find("a.TextBold, span.TextBold").first();
    const title = titleEl.text().replace(/\s+/g, " ").trim();
    if (!title) return;

    const href = titleEl.attr("href") || "";
    const codeFromHref = href.match(/\/courses\/([^/?#]+)/)?.[1];
    const infoHref = item.find("a[href*='info_course.php?c=']").attr("href") || "";
    const codeFromInfo = infoHref.match(/[?&]c=([^&#]+)/)?.[1];
    const metaHref = item.find("a[href*='showMetadata']").attr("href") || "";
    const codeFromMeta = metaHref.match(/showMetadata\(["']([^"']+)["']\)/)?.[1];
    const jsEntry = numericId !== undefined ? jsCourseMap.get(numericId) : undefined;

    const publicCodeText = titleEl.next("small").text().replace(/[()]/g, "").trim();

    const rawRealCode = jsEntry?.code || codeFromHref || codeFromInfo || codeFromMeta;
    const code = rawRealCode
      ? decodeURIComponent(rawRealCode)
      : publicCodeText || (numericId ? `CID${numericId}` : title);
    const publicCode = publicCodeText || code;

    const professor = item.find("small.vsmall-text").first().text().replace(/\s+/g, " ").trim() || undefined;
    const enrolled =
      cb.attr("checked") !== undefined ||
      item.find("i.fa-user, i.fa-check.Success-200-cl").length > 0;

    const hasPasswordInput =
      numericId !== undefined && item.find(`input[name='pass${numericId}']`).length > 0;
    const isRegClosed =
      cb.hasClass("reg_closed") ||
      jsEntry?.accessLevel === 0 ||
      (cb.length === 0 && !enrolled) ||
      (cb.attr("disabled") !== undefined && !enrolled && !hasPasswordInput);

    const locked = isRegClosed || hasPasswordInput || item.find(".fa-lock").length > 0;

    courses.push({
      code,
      publicCode,
      title,
      professor,
      numericId,
      enrolled,
      locked,
    });
  });

  // Older themes list sub-faculties as plain links outside `.element` rows
  if (childFaculties.length === 0) {
    $("#main a[href*='courses.php?fc='], .main-container a[href*='courses.php?fc=']").each((_, a) => {
      if (crumb.length && $(a).closest(crumb).length) return;
      const fc = fcOf($(a).attr("href"));
      const name = $(a).text().replace(/\s+/g, " ").trim();
      if (fc === undefined || !name || ancestorIds.has(fc) || childFaculties.some((f) => f.fc === fc)) return;
      childFaculties.push({ fc, name });
    });
  }

  return {
    courses,
    facultyIds: [...facultyIds],
    childFaculties,
    ancestorFaculties,
    currentFacultyName,
    csrfToken,
  };
}

/** Extracts user display name from a logged-in eClass page header/profile. */
export function parseUserDisplayName(html: string): string | undefined {
  const $ = cheerio.load(html);
  const candidates = [
    $("h4.username-text").first().text(),
    $(".user-name, .username, .profile-name, #dropdownMenuLink .text-truncate").first().text(),
    $("h3.text-center.mt-3").first().text(),
    $("a[href*='display_profile.php']").first().text(),
  ];
  for (const c of candidates) {
    const clean = c?.replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2 || clean.length > 80) continue;
    if (/^(το προφίλ μου|my profile|προφίλ|profile|αποσύνδεση|logout)$/i.test(clean)) continue;
    return clean;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Session state detection                                             */
/* ------------------------------------------------------------------ */

/** True when an eClass response is the login page / SSO form instead of the requested content. */
export function isLoggedOutPage(url: string, html: string): boolean {
  if (/login_form\.php|\/cas\/login|:\/\/sso\.|\/idp\/|\/Shibboleth\.sso/i.test(url)) return true;
  if (html.includes("jumbotron-login")) return true;
  // A visible username + password field. Catalog pages also carry hidden uname/pass inputs on
  // "guest access" buttons of courses that allow guests, which are not a login page.
  const visibleField = (name: string) =>
    (html.match(new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*>`, "gi")) ?? []).some(
      (tag) => !/\btype=["']?hidden/i.test(tag),
    );
  if (visibleField("uname") && visibleField("pass")) return true;
  // Mobile API answers for an expired/absent session
  const trimmed = html.trim();
  if (trimmed === "EXPIRED" || trimmed === "FAILED") return true;
  return false;
}

/** True when a university web application firewall blocked the request. */
export function isFirewallBlock(status: number, html: string): boolean {
  return (
    (status === 403 || status === 406 || status === 429) &&
    /web application firewall|request rejected|access denied|transfer is blocked/i.test(html)
  );
}

/* ------------------------------------------------------------------ */
/* Course home: available tools / modules                              */
/* ------------------------------------------------------------------ */

export interface CourseToolLink {
  /** Module id from the URL, e.g. "document", "work", "forum", "exercise", "gradebook". */
  id: string;
  name: string;
  url: string;
}

const SKIPPED_TOOL_IDS =
  /^(course_info|course_tools|usage|admin|course_home|create_course|user|course_metadata|course_description_edit|contact|help|auth|search|abuse_report|notifications|mobile)$/;

/** Extracts the course's enabled tools (left menu of `/courses/CODE/`). */
export function parseCourseTools(html: string, pageUrl: string, courseCode: string): CourseToolLink[] {
  const $ = cheerio.load(html);
  const out = new Map<string, CourseToolLink>();
  const enc = encodeURIComponent(courseCode);
  $("a[href*='/modules/']").each((_, a) => {
    const href = ($(a).attr("href") || "").replace(/&amp;/g, "&");
    if (!href.includes(`course=${courseCode}`) && !href.includes(`course=${enc}`)) return;
    const m = href.match(/\/modules\/([a-z_]+)\//i);
    if (!m) return;
    const id = m[1].toLowerCase();
    if (SKIPPED_TOOL_IDS.test(id)) return;
    // Per-item links (a single announcement, a folder, …) are not tool entry points
    if (/[?&](id|edit|delete|choice|an_id|mid|openDir|download|showQuota|eid|topic|forum)=/.test(href)) return;
    const name = ($(a).text().replace(/\s+/g, " ").trim() || $(a).attr("title")?.trim() || id).slice(0, 60);
    if (!name || out.has(id)) return;
    const url = absUrl(pageUrl, href);
    if (url) out.set(id, { id, name, url });
  });
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Assignment detail & submission                                      */
/* ------------------------------------------------------------------ */

export interface ParsedAssignmentDetail {
  title?: string;
  descriptionHtml: string;
  attachments: { name: string; url: string }[];
  canSubmit: boolean;
  submissionType: "file" | "text" | "none";
  maxFiles: number;
  formAction?: string;
  hiddenFields: Record<string, string>;
  /** Text describing the student's existing submission (file name, date, grade), if any. */
  existingSubmission?: string;
  /** Flash message rendered on the page (e.g. after a submission). */
  flashMessage?: { kind: "success" | "error" | "info"; text: string };
}

export function parseAssignmentDetailHtml(html: string, pageUrl: string): ParsedAssignmentDetail {
  const $ = cheerio.load(html);
  const form = $("form#submit_assignment_form, form[enctype='multipart/form-data']:has(input[name='work_submit'])").first();
  const hiddenFields: Record<string, string> = {};
  form.find("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    // `on_behalf_of` is teacher-only; `work_submit` is added explicitly on submit
    if (name && name !== "on_behalf_of" && name !== "work_submit") hiddenFields[name] = $(el).attr("value") ?? "";
  });

  const formHtml = form.html() ?? "";
  const hasTextEditor = form.find("textarea[name='submission_text'], #submission_text").length > 0;
  const hasFile = form.find("#uppy, input[type='file']").length > 0 || /userfile/.test(formHtml);
  const limitMatch = form.find("label[for='userfile']").text().match(/(\d+)\s*$/);
  const maxFiles = limitMatch ? Number(limitMatch[1]) : form.find("input[type='file'][multiple]").length ? 5 : 1;

  // Assignment description + teacher-provided files live in cards of the main column
  const main = $("#main, .main-container").first();
  const scope = main.length ? main : $("body");
  const descParts: string[] = [];
  scope.find(".card").each((_, card) => {
    const c = $(card);
    if (c.closest("form").length || c.find("form").length) return;
    if (c.parents(".card").length) return;
    const body = c.find(".card-body").first();
    const part = (body.length ? body : c).html()?.trim();
    if (part && stripHtml(part).length > 0) descParts.push(part);
  });

  const attachments: { name: string; url: string }[] = [];
  scope.find("a[href*='get=1'], a[href*='download='], a[href*='file.php'], a[href*='get_file']").each((_, a) => {
    if ($(a).closest("form").length) return;
    const url = absUrl(pageUrl, $(a).attr("href"));
    const name = $(a).text().replace(/\s+/g, " ").trim();
    if (url && name && !attachments.some((x) => x.url === url)) attachments.push({ name, url });
  });

  let existingSubmission: string | undefined;
  scope.find(".card, table").each((_, el) => {
    if (existingSubmission) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (/(έχετε ήδη υποβάλει|Υποβλήθηκε|Ημερομηνία αποστολής|Your submission|already submitted|Date of submission)/i.test(text)) {
      existingSubmission = text.slice(0, 400);
    }
  });

  const alertEl = scope.find(".alert-success, .alert-danger, .alert-warning, .alert-info").first();
  const flashText = alertEl.text().replace(/\s+/g, " ").trim();
  const flashMessage = flashText
    ? {
        kind: alertEl.hasClass("alert-success")
          ? ("success" as const)
          : alertEl.hasClass("alert-danger") || alertEl.hasClass("alert-warning")
            ? ("error" as const)
            : ("info" as const),
        text: flashText.slice(0, 400),
      }
    : undefined;

  return {
    title: $("h1, .action-bar-title, .page-title").first().text().replace(/\s+/g, " ").trim() || undefined,
    descriptionHtml: descParts.slice(0, 3).join("<hr/>"),
    attachments: attachments.slice(0, 20),
    canSubmit: form.length > 0,
    submissionType: form.length === 0 ? "none" : hasTextEditor && !hasFile ? "text" : "file",
    maxFiles: Math.max(1, Math.min(20, maxFiles || 1)),
    formAction: form.length ? absUrl(pageUrl, form.attr("action") || pageUrl) : undefined,
    hiddenFields,
    existingSubmission,
    flashMessage,
  };
}

/* ------------------------------------------------------------------ */
/* Semester inference from free text (faculty names, course titles)    */
/* ------------------------------------------------------------------ */

const GREEK_SEMESTER_LETTERS: Record<string, number> = {
  α: 1, β: 2, γ: 3, δ: 4, ε: 5, στ: 6, ζ: 7, η: 8, θ: 9, ι: 10,
};

/** Returns 1..10 when text clearly names a semester ("Α' Εξάμηνο", "5ο εξάμηνο", "Semester 3"). */
export function semesterFromText(text: string): number | undefined {
  const s = text.toLowerCase();
  const num =
    s.match(/(\d{1,2})\s*(?:ο|o|ου|th|st|nd|rd)?\s*(?:εξάμηνο|εξαμηνο|εξ\.|semester)/i) ||
    s.match(/semester\s*(\d{1,2})/i);
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= 10) return n;
  }
  const letter = s.match(/(?:^|[\s(])(στ|[αβγδεζηθι])\s*['΄’]?\s*(?:εξάμηνο|εξαμηνο)/i);
  if (letter) return GREEK_SEMESTER_LETTERS[letter[1].toLowerCase()];
  return undefined;
}
