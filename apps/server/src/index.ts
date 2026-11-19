import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { stream, streamSSE } from "hono/streaming";
import archiver from "archiver";
import { PassThrough } from "node:stream";
import { ZodError } from "zod";
import {
  ActionDecision,
  ChatRequest,
  CourseMetaPatch,
  DocumentSummaryRequest,
  LoginRequest,
  SettingsPatch,
  StudyRequest,
  TriageRequest,
  type ChatMessage,
  type Me,
  type MyStats,
} from "@myclass/shared";
import {
  executeConfirmedAction,
  generateStudyMaterial,
  runAssistantTurn,
  summarizeCourseDocument,
  triageAnnouncements,
  checkServerGeminiKey,
} from "./ai.js";
import { buildDeadlinesIcs, markDeadlineSubmitted, rememberDeadlines, widgetData } from "./deadlines.js";
import { AiQuotaError, quotaFor } from "./quota.js";
import { encrypt, randomId, sha256 } from "./crypto.js";
import {
  CoursePasswordError,
  forgetUserSession,
  getConnectorForUser,
  performEclassLogin,
  setTransientCredentials,
  userDepartmentId,
} from "./eclass/connector.js";
import { hasPastAcademicYearTag, SEMESTERS, UNIPI_DEPARTMENTS } from "./eclass/unipi-curriculum.js";
import { UNIPI } from "./eclass/universities.js";
import { env, publicUrl } from "./env.js";
import {
  emitNotification,
  pollUserNow,
  startBackgroundPoller,
  subscribeNotifications,
  vapidKeys,
} from "./poller.js";
import { newUser, sessions, users, type PushSub, type UserRecord } from "./store.js";

const SESSION_COOKIE = "myclass_sid";

type Variables = {
  user: UserRecord;
};

const app = new Hono<{ Variables: Variables }>();

// Content Security Policy: scripts only from this origin, so injected HTML cannot run code.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Security headers for every response (API and web app)
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (env.secureCookies) {
    c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
});

// Only the app's own web origin may make credentialed cross-origin requests.
const allowedOrigins = new Set([env.webOrigin, publicUrl]);
app.use(
  "/api/*",
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
    credentials: true,
  }),
);

// Brute-force rate limiter for login attempts (max 10 failed attempts per 5 minutes per account)
const failedLoginMap = new Map<string, { count: number; resetAt: number }>();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toMe(u: UserRecord): Me {
  const deptId = userDepartmentId(u);
  const dept = UNIPI_DEPARTMENTS.find((d) => d.id === deptId);
  return {
    id: u.id,
    universityId: UNIPI.id,
    universityName: UNIPI.name,
    departmentId: dept?.id ?? deptId,
    departmentName: dept?.name,
    username: u.username,
    displayName: u.displayName || u.username,
    rememberCredentials: u.remember,
    settings: u.settings,
    ai: {
      hasApiKey: Boolean(u.ai.encApiKey),
      serverKeyAvailable: Boolean(env.gemini.apiKey),
      quota: quotaFor(u),
    },
    calendarFeedUrl: u.calendarToken ? `${publicUrl}/api/calendar/${u.calendarToken}.ics` : undefined,
  };
}

function getAuthedUser(c: Context): UserRecord | null {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess) return null;
  return users.get(sess.userId) ?? null;
}

function requireUser(c: Context): UserRecord {
  const u = getAuthedUser(c);
  if (!u) {
    throw new HttpError(401, "Unauthorized");
  }
  return u;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  if (err instanceof CoursePasswordError) {
    // The app asks for the course's registration code and tries again
    return c.json({ error: err.message, code: `password_${err.reason}` }, 409);
  }
  if (err instanceof AiQuotaError) {
    return c.json({ error: err.message, resetAt: err.resetAt }, 429);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "Invalid request" }, 400);
  }
  if (err instanceof SyntaxError) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  console.error("[api error]", err);
  return c.json({ error: err.message || "Internal server error" }, 500);
});

/* ------------------------------------------------------------------ */
/* Public / Auth routes                                                */
/* ------------------------------------------------------------------ */

app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/auth/login", async (c) => {
  const body = LoginRequest.parse(await c.req.json());
  const rateKey = body.username.trim().toLowerCase();
  const now = Date.now();
  const attempt = failedLoginMap.get(rateKey);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    throw new HttpError(429, "Too many failed login attempts. Please wait 5 minutes and try again.");
  }

  const uni = UNIPI;

  const userId = sha256(`${uni.id}:${body.username.trim().toLowerCase()}`).slice(0, 24);
  const existing = users.get(userId) ?? newUser(userId, uni.id, body.username.trim());
  existing.universityId = uni.id;
  existing.username = body.username.trim();
  existing.remember = body.remember;

  try {
    const { http, displayName } = await performEclassLogin(uni, existing.username, body.password);
    failedLoginMap.delete(rateKey);
    existing.displayName = displayName || existing.username;
    const serialized = http.serialize();
    setTransientCredentials(userId, body.password, serialized);
    if (body.remember) {
      existing.encPassword = encrypt(body.password);
      existing.encSession = encrypt(serialized);
    } else {
      existing.encPassword = undefined;
      existing.encSession = undefined;
    }
  } catch (err) {
    const prev = failedLoginMap.get(rateKey);
    const count = prev && prev.resetAt > now ? prev.count + 1 : 1;
    failedLoginMap.set(rateKey, { count, resetAt: now + 5 * 60 * 1000 });
    console.error(`[login error]`, (err as Error).message || err);
    throw new HttpError(401, (err as Error).message || "Authentication failed");
  }

  users.upsert(existing);
  // A new eClass session (and possibly other portals): recount the stats on the next visit
  statsCache.delete(userId);

  const sid = randomId(24);
  sessions.create(sid, userId);
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.secureCookies,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  // Prime initial notification state in the background
  void pollUserNow(existing);

  return c.json({ me: toMe(existing) });
});

app.post("/api/auth/logout", (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) sessions.delete(sid);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.delete("/api/auth/account", (c) => {
  const u = requireUser(c);
  forgetUserSession(u.id);
  statsCache.delete(u.id);
  users.delete(u.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const u = getAuthedUser(c);
  if (!u) return c.json({ me: null });
  return c.json({ me: toMe(u) });
});

/* ------------------------------------------------------------------ */
/* Settings & AI configuration                                         */
/* ------------------------------------------------------------------ */

app.patch("/api/settings", async (c) => {
  const u = requireUser(c);
  const patch = SettingsPatch.parse(await c.req.json());
  if (patch.departmentId && !UNIPI_DEPARTMENTS.some((d) => d.id === patch.departmentId)) {
    throw new HttpError(400, "Unknown department");
  }
  users.update(u.id, (rec) => {
    rec.settings = {
      ...rec.settings,
      ...patch,
      notify: { ...rec.settings.notify, ...(patch.notify ?? {}) },
      accessibility: { ...rec.settings.accessibility, ...(patch.accessibility ?? {}) },
      downloads: { ...rec.settings.downloads, ...(patch.downloads ?? {}) },
      ai: { ...rec.settings.ai, ...(patch.ai ?? {}) },
    };
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

app.post("/api/ai/apikey", async (c) => {
  const u = requireUser(c);
  const { apiKey } = (await c.req.json()) as { apiKey?: string };
  if (!apiKey || apiKey.trim().length < 10) {
    throw new HttpError(400, "Please provide a valid Gemini API key");
  }
  users.update(u.id, (rec) => {
    rec.ai.encApiKey = encrypt(apiKey.trim());
    rec.settings.ai.mode = "apiKey";
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

app.delete("/api/ai/apikey", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.ai.encApiKey = undefined;
    rec.settings.ai.mode = "server";
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

/* ------------------------------------------------------------------ */
/* Courses, Catalog, Announcements, Messages, Assignments              */
/* ------------------------------------------------------------------ */

app.get("/api/courses", async (c) => {
  const u = requireUser(c);
  const connector = getConnectorForUser(u);
  const { courses: list, warnings } = await connector.listCoursesDetailed();
  const enriched = list.map((course) => ({
    ...course,
    semester: u.courseMeta[course.code]?.semester ?? course.semester,
    archived: u.courseMeta[course.code]?.archived ?? false,
  }));
  return c.json({ courses: enriched, warnings });
});

app.patch("/api/courses/:code/meta", async (c) => {
  const u = requireUser(c);
  const code = c.req.param("code");
  const patch = CourseMetaPatch.parse(await c.req.json());
  users.update(u.id, (rec) => {
    rec.courseMeta[code] = { ...rec.courseMeta[code], ...patch };
  });
  return c.json({ ok: true, meta: users.get(u.id)!.courseMeta[code] });
});

/**
 * Usage stats change slowly and cost eClass a year-long query, so they are kept for 15 minutes.
 * Background checks keep landing in eClass' log and in the hit ledger together, so a cached
 * result stays consistent; it is dropped on login and account deletion, and `?fresh=1` skips it.
 */
const statsCache = new Map<string, { at: number; stats: MyStats }>();
const STATS_TTL_MS = 15 * 60 * 1000;

app.get("/api/stats", async (c) => {
  const u = requireUser(c);
  const cached = statsCache.get(u.id);
  if (cached && Date.now() - cached.at < STATS_TTL_MS && c.req.query("fresh") !== "1") {
    return c.json({ stats: cached.stats });
  }
  const stats = await getConnectorForUser(u).getMyStats();
  if (!stats.warnings) statsCache.set(u.id, { at: Date.now(), stats });
  return c.json({ stats });
});

app.get("/api/catalog", async (c) => {
  const u = requireUser(c);
  const q = c.req.query("q") || undefined;
  const department = c.req.query("department") || undefined;
  const connector = getConnectorForUser(u);
  const departments = await connector.listDepartments();
  const activeDepartment =
    department && UNIPI_DEPARTMENTS.some((d) => d.id === department) ? department : connector.defaultDepartmentId();
  const catalog = await connector.listCatalog(q, activeDepartment);
  return c.json({ catalog, departments, activeDepartment });
});

app.post("/api/courses/enroll", async (c) => {
  const u = requireUser(c);
  const { course, password } = (await c.req.json()) as { course: string; password?: string };
  const connector = getConnectorForUser(u);
  const enrolled = await connector.enrollCourse(course, typeof password === "string" ? password.slice(0, 200) : undefined);
  return c.json({ course: enrolled });
});

app.post("/api/courses/:code/unenroll", async (c) => {
  const u = requireUser(c);
  const code = c.req.param("code");
  const connector = getConnectorForUser(u);
  const removed = await connector.unenrollCourse(code);
  return c.json({ course: removed });
});

app.get("/api/announcements", async (c) => {
  const u = requireUser(c);
  const courseCode = c.req.query("course") || undefined;
  const connector = getConnectorForUser(u);
  const announcements = await connector.getAnnouncements(courseCode);
  return c.json({ announcements });
});

/** "Action needed" / "FYI" for the student's current announcements (cached per announcement). */
app.post("/api/announcements/triage", async (c) => {
  const u = requireUser(c);
  // The app sends the announcements it already loaded, so eClass is not asked twice
  const { items } = TriageRequest.parse(await c.req.json());
  const triage = await triageAnnouncements(
    u,
    items.map((a) => ({ ...a, contentHtml: "" })),
  );
  return c.json({ triage });
});

app.get("/api/messages", async (c) => {
  const u = requireUser(c);
  const connector = getConnectorForUser(u);
  const messages = await connector.getMessages();
  return c.json({ messages });
});

app.get("/api/messages/:id", async (c) => {
  const u = requireUser(c);
  const id = c.req.param("id");
  const connector = getConnectorForUser(u);
  const message = await connector.getMessage(id);
  if (!message) throw new HttpError(404, "Message not found");
  return c.json({ message });
});

app.get("/api/assignments", async (c) => {
  const u = requireUser(c);
  const courseCode = c.req.query("course") || undefined;
  const connector = getConnectorForUser(u);
  const assignments = await connector.getAssignments(courseCode);
  rememberDeadlines(u, assignments, courseCode);
  return c.json({ assignments });
});

app.get("/api/courses/:code/tools", async (c) => {
  const u = requireUser(c);
  const tools = await getConnectorForUser(u).getCourseTools(c.req.param("code"));
  return c.json({ tools });
});

app.get("/api/assignments/:code/:id", async (c) => {
  const u = requireUser(c);
  const detail = await getConnectorForUser(u).getAssignmentDetail(c.req.param("code"), c.req.param("id"));
  return c.json({ assignment: detail });
});

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

app.post(
  "/api/assignments/:code/:id/submit",
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 1024 * 1024,
    onError: (c) => c.json({ error: "The files are too large (max 50 MB in total)." }, 413),
  }),
  async (c) => {
    const u = requireUser(c);
    const body = await c.req.parseBody({ all: true });
    const rawFiles = ([] as unknown[]).concat(body["files"] ?? []);
    const files: Array<{ name: string; type: string; data: Buffer }> = [];
    let total = 0;
    for (const f of rawFiles) {
      if (typeof f === "string" || !f || typeof (f as File).arrayBuffer !== "function") continue;
      const file = f as File;
      const data = Buffer.from(await file.arrayBuffer());
      total += data.length;
      files.push({ name: file.name || "file", type: file.type, data });
    }
    if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, "The files are too large (max 50 MB in total).");
    const text = typeof body["text"] === "string" ? body["text"].slice(0, 100_000) : undefined;
    const comments = typeof body["comments"] === "string" ? body["comments"].slice(0, 5000) : undefined;
    const result = await getConnectorForUser(u).submitAssignment(c.req.param("code"), c.req.param("id"), {
      files,
      text,
      comments,
    });
    if (!result.ok) throw new HttpError(422, result.message);
    markDeadlineSubmitted(u, c.req.param("code"), c.req.param("id"));
    void pollUserNow(u);
    return c.json({ result });
  },
);

/** Streams a file from the course's own eClass portal (assignment attachments, etc.). */
app.get("/api/courses/:code/proxy", async (c) => {
  const u = requireUser(c);
  const url = c.req.query("url") || "";
  const file = await getConnectorForUser(u)
    .downloadPortalUrl(c.req.param("code"), url)
    .catch((err: Error) => {
      throw new HttpError(400, err.message);
    });
  c.header("Content-Type", file.contentType);
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  return c.body(new Uint8Array(file.body));
});

/* ------------------------------------------------------------------ */
/* Documents & Bulk ZIP Downloads                                      */
/* ------------------------------------------------------------------ */

app.post("/api/courses/:code/documents/summary", async (c) => {
  const u = requireUser(c);
  const { path: docPath, refresh } = DocumentSummaryRequest.parse(await c.req.json());
  try {
    const res = await summarizeCourseDocument(u, c.req.param("code"), docPath, { refresh, countQuota: true });
    return c.json({
      summary: {
        path: docPath,
        name: res.name,
        summary: res.summary,
        createdAt: new Date().toISOString(),
        cached: res.cached,
      },
    });
  } catch (err) {
    if (err instanceof AiQuotaError) throw err;
    throw new HttpError(422, (err as Error).message);
  }
});

app.post("/api/courses/:code/documents/study", async (c) => {
  const u = requireUser(c);
  const { path: docPath, kind, refresh } = StudyRequest.parse(await c.req.json());
  try {
    const material = await generateStudyMaterial(u, c.req.param("code"), docPath, kind, { refresh });
    return c.json({ material, me: toMe(users.get(u.id)!) });
  } catch (err) {
    if (err instanceof AiQuotaError) throw err;
    throw new HttpError(422, (err as Error).message);
  }
});

app.get("/api/courses/:code/documents", async (c) => {
  const u = requireUser(c);
  const code = c.req.param("code");
  const dir = c.req.query("dir") || "/";
  const connector = getConnectorForUser(u);
  const nodes = await connector.listDocuments(code, dir);
  return c.json({ nodes, dir });
});

app.get("/api/courses/:code/documents/file", async (c) => {
  const u = requireUser(c);
  const code = c.req.param("code");
  const filePath = c.req.query("path") || "/";
  const connector = getConnectorForUser(u);
  const file = await connector.downloadFile(code, filePath);

  c.header("Content-Type", file.contentType);
  c.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  );

  if (Buffer.isBuffer(file.body)) {
    return c.body(new Uint8Array(file.body));
  }
  return stream(c, async (s) => {
    for await (const chunk of file.body as AsyncIterable<Uint8Array>) {
      await s.write(chunk);
    }
  });
});

app.get("/api/courses/:code/documents/zip", async (c) => {
  const u = requireUser(c);
  const code = c.req.param("code");
  const connector = getConnectorForUser(u);
  const { filename, stream: zipStream } = await connector.streamCourseZip(code);

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return stream(c, async (s) => {
    for await (const chunk of zipStream as AsyncIterable<Uint8Array>) {
      await s.write(chunk);
    }
  });
});

/**
 * Bulk ZIP download endpoint:
 * - Default: downloads all enrolled courses grouped into semester folders (`Α_εξάμηνο/...`, `Ε_Εξάμηνο/...`)
 * - `?semester=1..8`: downloads all courses of that semester folder (`Α_εξάμηνο.zip`)
 */
app.get("/api/documents/zip-all", async (c) => {
  const u = requireUser(c);
  const semParam = c.req.query("semester");
  const scope = c.req.query("scope"); // "enrolled" (default) or "catalog"
  const connector = getConnectorForUser(u);

  const sourceList =
    scope === "catalog" || semParam
      ? await connector.listCatalog()
      : (await connector.listCourses()).filter((cr) => !u.courseMeta[cr.code]?.archived);

  const filtered = semParam
    ? sourceList.filter(
        (cr) =>
          String(cr.semesterIndex) === semParam ||
          cr.semesterFolder?.toLowerCase() === semParam.toLowerCase() ||
          cr.semester?.toLowerCase() === semParam.toLowerCase(),
      )
    : sourceList;

  const semMeta = semParam ? SEMESTERS[Number(semParam)] : undefined;
  const zipFilename = semMeta ? `${semMeta.folder}.zip` : "myClass-all-semesters.zip";

  const archive = archiver("zip", { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  void (async () => {
    try {
      for (const course of filtered) {
        const semFolder = (course.semesterFolder || "Εξάμηνο").replace(/[\\/:*?"<>|]/g, "_");
        const courseFolder = `${course.publicCode ?? course.code} - ${course.title}`.replace(
          /[\\/:*?"<>|]/g,
          "_",
        );
        try {
          const { stream: courseZip } = await connector.streamCourseZip(course.code);
          archive.append(courseZip, {
            name: `${semFolder}/${courseFolder}/${course.code}-documents.zip`,
          });
        } catch {
          /* skip courses with inaccessible document areas */
        }
      }
      await archive.finalize();
    } catch (err) {
      pass.destroy(err as Error);
    }
  })();

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipFilename)}`);
  return stream(c, async (s) => {
    for await (const chunk of pass as AsyncIterable<Uint8Array>) {
      await s.write(chunk);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Notifications + Web Push + SSE                                      */
/* ------------------------------------------------------------------ */

function isTestNotification(n: { id?: string; title?: string; body?: string }): boolean {
  if (n.id?.startsWith("test-")) return true;
  const text = `${n.title ?? ""} ${n.body ?? ""}`;
  return /δοκιμαστικ[ηή]\s+ειδοπο[ιί]ηση|έλεγχος\s+ειδοποι[ηή]σεων|test\s+notification|notification\s+check/i.test(
    text,
  );
}

app.get("/api/notifications", (c) => {
  const u = requireUser(c);
  // Automatically clean out legacy stuck test notifications, read test notifications, or past-year notifications
  const cleaned = u.notifications.filter((n) => {
    if (hasPastAcademicYearTag(`${n.title} ${n.body}`)) return false;
    if (isTestNotification(n) && (n.read || !n.id.startsWith("test-"))) return false;
    return true;
  });
  if (cleaned.length !== u.notifications.length) {
    users.update(u.id, (rec) => {
      rec.notifications = cleaned;
    });
  }
  return c.json({
    notifications: cleaned,
    lastPollAt: u.lastPollAt,
    lastPollError: u.lastPollError,
  });
});

app.post("/api/notifications/poll", async (c) => {
  const u = requireUser(c);
  const created = await pollUserNow(u);
  const fresh = users.get(u.id)!;
  return c.json({
    createdCount: created.length,
    notifications: fresh.notifications,
    lastPollAt: fresh.lastPollAt,
  });
});

app.post("/api/notifications/read-all", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.notifications = [];
  });
  return c.json({ ok: true, notifications: [] });
});

app.post("/api/notifications/:id/open", (c) => {
  const u = requireUser(c);
  const id = c.req.param("id");
  users.update(u.id, (rec) => {
    rec.notifications = rec.notifications.filter((n) => n.id !== id);
  });
  return c.json({ ok: true, notifications: users.get(u.id)!.notifications });
});

app.post("/api/notifications/test", async (c) => {
  const u = requireUser(c);
  const item = {
    id: `test-${randomId(6)}`,
    kind: "announcement" as const,
    title: u.settings.language === "el" ? "myClass: Δοκιμαστική ειδοποίηση" : "myClass: Test notification",
    body:
      u.settings.language === "el"
        ? "Οι ειδοποιήσεις σε αυτή τη συσκευή λειτουργούν."
        : "Notifications on this device are working.",
    date: new Date().toISOString(),
    read: false,
    route: "/",
  };
  await emitNotification(u, item);
  return c.json({ notification: item });
});

app.get("/api/notifications/vapid-public-key", (c) =>
  c.json({ publicKey: vapidKeys.publicKey }),
);

app.post("/api/notifications/subscribe", async (c) => {
  const u = requireUser(c);
  const sub = (await c.req.json()) as PushSub;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new HttpError(400, "Invalid push subscription");
  }
  users.update(u.id, (rec) => {
    if (!rec.pushSubscriptions.some((s) => s.endpoint === sub.endpoint)) {
      rec.pushSubscriptions.push(sub);
    }
    rec.settings.notify.push = true;
  });
  return c.json({ ok: true, me: toMe(users.get(u.id)!) });
});

/* ------------------------------------------------------------------ */
/* Calendar feed + home-screen widget                                  */
/* ------------------------------------------------------------------ */

/** Turns on (or renews: the old link stops working) the private deadlines feed. */
app.post("/api/calendar/feed", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.calendarToken = randomId(24);
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

app.delete("/api/calendar/feed", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.calendarToken = undefined;
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

/** Read by calendar apps without a cookie: the secret token in the path is the only key. */
app.get("/api/calendar/:file", (c) => {
  const token = c.req.param("file").replace(/\.ics$/, "");
  const owner = token.length >= 20 ? users.all().find((x) => x.calendarToken === token) : undefined;
  if (!owner) return c.text("Not found", 404);
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, max-age=900");
  return c.body(buildDeadlinesIcs(users.get(owner.id)!, publicUrl));
});

/** Data for the Windows Widgets board card (template in /widgets/deadlines.json). */
app.get("/api/widget/deadlines", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(widgetData(getAuthedUser(c)));
});

app.get("/api/notifications/stream", (c) => {
  const u = requireUser(c);
  return streamSSE(c, async (sse) => {
    const unsub = subscribeNotifications(u.id, (item) => {
      void sse.writeSSE({ event: "notification", data: JSON.stringify(item) });
    });
    await sse.writeSSE({ event: "ready", data: "ok" });
    try {
      while (true) {
        await sse.sleep(25_000);
        await sse.writeSSE({ event: "ping", data: String(Date.now()) });
      }
    } finally {
      unsub();
    }
  });
});

/* ------------------------------------------------------------------ */
/* AI Assistant chat + confirmation actions                            */
/* ------------------------------------------------------------------ */

app.get("/api/chat/history", (c) => {
  const u = requireUser(c);
  return c.json({ messages: u.chat.messages });
});

app.delete("/api/chat/history", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.chat.messages = [];
    rec.chat.history = [];
    rec.chat.pending = {};
  });
  return c.json({ ok: true });
});

app.post("/api/chat", async (c) => {
  const u = requireUser(c);
  const { message } = ChatRequest.parse(await c.req.json());

  return streamSSE(c, async (sse) => {
    let writeChain = Promise.resolve();
    try {
      await runAssistantTurn(u, message, (ev) => {
        writeChain = writeChain.then(() =>
          sse.writeSSE({ event: ev.type, data: JSON.stringify(ev) }),
        );
      });
      await writeChain;
    } catch (err) {
      await writeChain;
      await sse.writeSSE({
        event: "error",
        data: JSON.stringify({ type: "error", error: (err as Error).message }),
      });
    }
  });
});

app.post("/api/chat/action", async (c) => {
  const u = requireUser(c);
  const { actionId, decision } = ActionDecision.parse(await c.req.json());
  const pendingEntry = u.chat.pending[actionId];
  if (!pendingEntry) throw new HttpError(404, "Pending action not found or already resolved");

  const { action } = pendingEntry;
  if (decision === "cancel") {
    action.status = "cancelled";
    action.result =
      u.settings.language === "el" ? "Η ενέργεια ακυρώθηκε από τον χρήστη." : "Action cancelled by user.";
  } else {
    try {
      const resultText = await executeConfirmedAction(u, action);
      action.status = "done";
      action.result = resultText;
    } catch (err) {
      action.status = "failed";
      action.result = (err as Error).message;
    }
  }

  let updatedMsg: ChatMessage | undefined;
  users.update(u.id, (rec) => {
    delete rec.chat.pending[actionId];
    for (const m of rec.chat.messages) {
      if (m.action?.id === actionId) {
        m.action = { ...action };
        updatedMsg = m;
      }
    }
  });

  return c.json({ action, message: updatedMsg });
});

/* ------------------------------------------------------------------ */
/* Production static frontend serving                                 */
/* ------------------------------------------------------------------ */

// Unknown API routes are JSON 404s (not the web app's index.html)
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

const distCandidates = [
  path.resolve(process.cwd(), "apps/web/dist"),
  path.resolve(process.cwd(), "../web/dist"),
  path.resolve(process.cwd(), "dist"),
];
const clientDist = distCandidates.find((p) => fs.existsSync(p));

if (clientDist) {
  const relRoot = path.relative(process.cwd(), clientDist);
  app.use("/*", serveStatic({ root: relRoot }));
  app.get("*", (c) => {
    const indexPath = path.join(clientDist, "index.html");
    if (fs.existsSync(indexPath)) {
      return c.html(fs.readFileSync(indexPath, "utf8"));
    }
    return c.text("Not found", 404);
  });
}

/* ------------------------------------------------------------------ */
/* Start server + background poller                                    */
/* ------------------------------------------------------------------ */

startBackgroundPoller();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`myClass server listening on http://localhost:${info.port}`);
  void checkServerGeminiKey();
});
