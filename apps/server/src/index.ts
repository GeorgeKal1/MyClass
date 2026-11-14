import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { stream, streamSSE } from "hono/streaming";
import archiver from "archiver";
import { PassThrough } from "node:stream";
import {
  ActionDecision,
  ChatRequest,
  CourseMetaPatch,
  LoginRequest,
  SettingsPatch,
  type ChatMessage,
  type Me,
} from "@myclass/shared";
import {
  buildGoogleOAuthUrl,
  executeConfirmedAction,
  handleGoogleOAuthCallback,
  runAssistantTurn,
} from "./ai.js";
import { encrypt, randomId, sha256 } from "./crypto.js";
import {
  getConnectorForUser,
  performEclassLogin,
  setTransientCredentials,
} from "./eclass/connector.js";
import {
  detectUniPiDepartmentFromUsername,
  detectUniversityFromUsername,
  hasPastAcademicYearTag,
  SEMESTERS,
  UNIPI_DEPARTMENTS,
} from "./eclass/unipi-curriculum.js";
import { getUniversity, UNIVERSITIES } from "./eclass/universities.js";
import { env } from "./env.js";
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

// Security headers for all API responses
app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
});

app.use(
  "/api/*",
  cors({
    origin: (origin) => origin || env.webOrigin,
    credentials: true,
  }),
);

// Brute-force rate limiter for login attempts (max 10 failed attempts per 5 minutes per account)
const failedLoginMap = new Map<string, { count: number; resetAt: number }>();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toMe(u: UserRecord): Me {
  const uni = getUniversity(u.universityId);
  const deptId = u.universityId === "unipi" ? detectUniPiDepartmentFromUsername(u.username) : "default";
  const dept = UNIPI_DEPARTMENTS.find((d) => d.id === deptId);
  return {
    id: u.id,
    universityId: u.universityId,
    universityName: uni?.name ?? u.universityId,
    departmentId: dept?.id ?? deptId,
    departmentName: dept?.name,
    username: u.username,
    displayName: u.displayName || u.username,
    rememberCredentials: u.remember,
    settings: u.settings,
    ai: {
      hasApiKey: Boolean(u.ai.encApiKey),
      googleConnected: Boolean(
        u.ai.google?.encRefreshToken ||
          u.ai.google?.accessToken ||
          (u.settings.ai.mode === "google" && u.ai.encApiKey),
      ),
      googleEmail: u.ai.google?.email,
      googleAvailable: Boolean(env.google.clientId && env.google.clientSecret),
      serverKeyAvailable: Boolean(env.gemini.apiKey),
    },
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
  console.error("[api error]", err);
  return c.json({ error: err.message || "Internal server error" }, 500);
});

/* ------------------------------------------------------------------ */
/* Public / Auth routes                                                */
/* ------------------------------------------------------------------ */

app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/universities", (c) => c.json({ universities: UNIVERSITIES }));

app.post("/api/auth/login", async (c) => {
  const body = LoginRequest.parse(await c.req.json());
  const rateKey = body.username.trim().toLowerCase();
  const now = Date.now();
  const attempt = failedLoginMap.get(rateKey);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    throw new HttpError(429, "Too many failed login attempts. Please wait 5 minutes and try again.");
  }

  console.log(`[login attempt] username=${body.username} universityId=${body.universityId}`);
  const resolvedUniId =
    !body.universityId || body.universityId === "auto"
      ? detectUniversityFromUsername(body.username)
      : body.universityId;
  const uni = getUniversity(resolvedUniId) ?? getUniversity("unipi");
  console.log(`[login attempt] resolved to uni=${uni?.id}`);
  if (!uni) throw new HttpError(400, "Unknown university");

  const userId = sha256(`${uni.id}:${body.username.trim().toLowerCase()}`).slice(0, 24);
  const existing = users.get(userId) ?? newUser(userId, uni.id, body.username.trim());
  existing.universityId = uni.id;
  existing.username = body.username.trim();
  existing.remember = body.remember;

  try {
    const { http, displayName } = await performEclassLogin(uni, existing.username, body.password);
    failedLoginMap.delete(rateKey);
    console.log(`[login success] username=${existing.username} displayName=${displayName}`);
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

  const sid = randomId(24);
  sessions.create(sid, userId);
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.isProd,
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
  users.update(u.id, (rec) => {
    rec.settings = {
      ...rec.settings,
      ...patch,
      notify: { ...rec.settings.notify, ...(patch.notify ?? {}) },
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
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

app.get("/api/ai/google/start", (c) => {
  const u = requireUser(c);
  const url = buildGoogleOAuthUrl(u.id);
  if (url) {
    return c.json({ mode: "oauth" as const, url });
  }
  return c.json({
    mode: "aistudio" as const,
    url: "https://aistudio.google.com/app/apikey",
  });
});

app.post("/api/ai/google/connect", async (c) => {
  const u = requireUser(c);
  const { apiKey, email } = (await c.req.json()) as { apiKey?: string; email?: string };
  if (!apiKey || apiKey.trim().length < 10) {
    throw new HttpError(400, "Please paste your Google Gemini key from Google AI Studio");
  }
  users.update(u.id, (rec) => {
    rec.ai.encApiKey = encrypt(apiKey.trim());
    rec.ai.google = {
      email: email?.trim() || `${rec.username}@google`,
      accessToken: "aistudio-key",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    };
    rec.settings.ai.mode = "google";
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

app.get("/api/ai/google/callback", async (c) => {
  const code = c.req.query("code") || "";
  const state = c.req.query("state") || "";
  if (!code || !state) return c.redirect(`${env.webOrigin}/settings?google=error`);
  await handleGoogleOAuthCallback(code, state);
  return c.redirect(`${env.webOrigin}/settings?google=connected`);
});

app.post("/api/ai/google/disconnect", (c) => {
  const u = requireUser(c);
  users.update(u.id, (rec) => {
    rec.ai.google = undefined;
    if (rec.settings.ai.mode === "google") rec.settings.ai.mode = "server";
  });
  return c.json({ me: toMe(users.get(u.id)!) });
});

/* ------------------------------------------------------------------ */
/* Courses, Catalog, Announcements, Messages, Assignments              */
/* ------------------------------------------------------------------ */

app.get("/api/courses", async (c) => {
  const u = requireUser(c);
  const connector = getConnectorForUser(u);
  const list = await connector.listCourses();
  const enriched = list.map((course) => ({
    ...course,
    semester: u.courseMeta[course.code]?.semester ?? course.semester ?? "Ε' Εξάμηνο",
    archived: u.courseMeta[course.code]?.archived ?? false,
  }));
  return c.json({ courses: enriched });
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

app.get("/api/catalog", async (c) => {
  const u = requireUser(c);
  const q = c.req.query("q") || undefined;
  const department = c.req.query("department") || undefined;
  const connector = getConnectorForUser(u);
  const departments = connector.listDepartments();
  const autoDept = u.universityId === "unipi" ? detectUniPiDepartmentFromUsername(u.username) : departments[0]?.id || "default";
  const activeDepartment = department || autoDept;
  const catalog = await connector.listCatalog(q, activeDepartment);
  return c.json({ catalog, departments, activeDepartment });
});

app.post("/api/courses/enroll", async (c) => {
  const u = requireUser(c);
  const { course } = (await c.req.json()) as { course: string };
  const connector = getConnectorForUser(u);
  const enrolled = await connector.enrollCourse(course);
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
  return c.json({ assignments });
});

/* ------------------------------------------------------------------ */
/* Documents & Bulk ZIP Downloads                                      */
/* ------------------------------------------------------------------ */

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
    title:
      u.settings.language === "el"
        ? "Κρυπτογραφία (TMC106): Έλεγχος Ειδοποιήσεων eClass"
        : "Cryptography (TMC106): eClass Notification Check",
    body:
      u.settings.language === "el"
        ? "Δοκιμαστική ειδοποίηση από το myClass — οι ειδοποιήσεις σε πραγματικό χρόνο λειτουργούν κανονικά!"
        : "Test notification from myClass — real-time alerts are working!",
    courseCode: "TMC106",
    courseTitle: "ΚΡΥΠΤΟΓΡΑΦΙΑ",
    date: new Date().toISOString(),
    read: false,
    route: "/courses/TMC106?tab=announcements",
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
/* Start server + background poller                                    */
/* ------------------------------------------------------------------ */

startBackgroundPoller();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`✓ myClass server listening on http://localhost:${info.port}`);
});
