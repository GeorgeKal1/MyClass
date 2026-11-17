import type { CatalogCourse, ChatMessage, ChatStreamEvent, PendingAction } from "@myclass/shared";
import { decrypt, encrypt, randomId } from "./crypto.js";
import { getConnectorForUser } from "./eclass/connector.js";
import { getUniversity } from "./eclass/universities.js";
import { getCurrentAcademicYearBounds, hasPastAcademicYearTag, SEMESTERS } from "./eclass/unipi-curriculum.js";
import { prepareDocumentForAi } from "./doctext.js";
import { env } from "./env.js";
import { oauthStates, users, type UserRecord } from "./store.js";

/* ------------------------------------------------------------------ */
/* Google OAuth 2.0 helper (for "Connect Google account" in Settings)  */
/* ------------------------------------------------------------------ */

export function buildGoogleOAuthUrl(userId: string): string | null {
  if (!env.google.clientId || !env.google.clientSecret) return null;
  const state = randomId(18);
  oauthStates.put(state, userId);
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: `${env.google.scopes} openid email`,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleGoogleOAuthCallback(code: string, state: string): Promise<string | null> {
  const userId = oauthStates.take(state);
  if (!userId) return null;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed (${tokenRes.status})`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  let email: string | undefined;
  try {
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { email?: string };
      email = info.email;
    }
  } catch {
    /* optional */
  }

  users.update(userId, (u) => {
    u.ai.google = {
      encRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : u.ai.google?.encRefreshToken,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3500) * 1000,
      email: email ?? u.ai.google?.email,
    };
    u.settings.ai.mode = "google";
  });

  return userId;
}

async function getValidGoogleAccessToken(user: UserRecord): Promise<string | null> {
  const g = user.ai.google;
  if (!g) return null;
  if (g.accessToken && g.expiresAt && g.expiresAt > Date.now() + 30_000) {
    return g.accessToken;
  }
  if (!g.encRefreshToken || !env.google.clientId || !env.google.clientSecret) return null;

  const refreshToken = decrypt(g.encRefreshToken);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  users.update(user.id, (u) => {
    if (u.ai.google) {
      u.ai.google.accessToken = data.access_token;
      u.ai.google.expiresAt = Date.now() + (data.expires_in ?? 3500) * 1000;
    }
  });
  return data.access_token;
}

/* ------------------------------------------------------------------ */
/* Tool definitions for Gemini Interactions API                        */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: "function",
    name: "list_courses",
    description:
      "Lists the student's currently enrolled eClass courses (with code, title, professor, semester, semesterFolder, and archive status).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "search_catalog",
    description:
      "Lists or searches all subjects across all university semesters (Α' Εξάμηνο through Η' Εξάμηνο, i.e. semesters 1..8) with course code, title, professor name, semester, and enrollment status.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional search keyword, course title, course code, or professor name",
        },
        semester: {
          type: "number",
          description: "Optional semester number (1 to 8 for Α'–Η' Εξάμηνο, or 9 for Thesis/Other)",
        },
        departmentId: {
          type: "string",
          description: "Optional department ID (defaults to 'cs-ug' for Informatics Undergraduate)",
        },
      },
    },
  },
  {
    type: "function",
    name: "list_documents",
    description:
      "Lists uploaded files and folders in ANY course's Documents section on eClass (works for both enrolled courses and any subject in the catalog).",
    parameters: {
      type: "object",
      properties: {
        courseCode: { type: "string", description: "Course code (e.g. TMC106, TMA117, ODE180)" },
        dir: { type: "string", description: "Optional directory path, defaults to '/'" },
      },
      required: ["courseCode"],
    },
  },
  {
    type: "function",
    name: "get_announcements",
    description: "Fetches the latest eClass announcements, optionally filtered by courseCode.",
    parameters: {
      type: "object",
      properties: {
        courseCode: { type: "string", description: "Optional course code (e.g. TMC106, TMG100)" },
      },
    },
  },
  {
    type: "function",
    name: "get_messages",
    description: "Lists the student's recent inbox messages on eClass.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_deadlines",
    description: "Lists assignments and upcoming submission deadlines across courses.",
    parameters: {
      type: "object",
      properties: {
        courseCode: { type: "string", description: "Optional course code" },
      },
    },
  },
  {
    type: "function",
    name: "read_document",
    description:
      "Reads one file from a course's Documents (PDF, slides, Word, text, code) and returns its relevant content. Use it to answer questions about what a lecture, exercise sheet or project brief says. Get the path from list_documents first.",
    parameters: {
      type: "object",
      properties: {
        courseCode: { type: "string", description: "Course code" },
        path: { type: "string", description: "The file's `path` exactly as returned by list_documents" },
        question: {
          type: "string",
          description: "What the student wants to know about the file (used to focus the reading)",
        },
      },
      required: ["courseCode", "path"],
    },
  },
  {
    type: "function",
    name: "get_assignment_details",
    description:
      "Gets the full description, attached files, submission status and whether submission is open for ONE assignment. Use the assignment `id` from get_deadlines.",
    parameters: {
      type: "object",
      properties: {
        courseCode: { type: "string", description: "Course code" },
        assignmentId: { type: "string", description: "Assignment id from get_deadlines (e.g. TMC106:12)" },
      },
      required: ["courseCode", "assignmentId"],
    },
  },
  {
    type: "function",
    name: "read_message",
    description: "Reads the full body of one inbox message (id from get_messages).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Message id" } },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "enroll_course",
    description:
      "Registers/joins a new course on eClass. Requires student confirmation before executing.",
    parameters: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course code, numeric ID, or title to join" },
      },
      required: ["course"],
    },
  },
  {
    type: "function",
    name: "unenroll_course",
    description:
      "Removes/unenrolls a course from eClass (for example when a semester is over). Requires student confirmation.",
    parameters: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course code, numeric ID, or title to remove" },
      },
      required: ["course"],
    },
  },
  {
    type: "function",
    name: "archive_semester",
    description:
      "Archives or unenrolls all courses belonging to a finished semester. Requires student confirmation.",
    parameters: {
      type: "object",
      properties: {
        semester: { type: "string", description: "Semester label, e.g. \"Α' Εξάμηνο\" or \"Ε' Εξάμηνο\"" },
        unenrollFromEclass: {
          type: "boolean",
          description: "If true, also unenrolls those courses on eClass; otherwise archives them in myClass",
        },
      },
      required: ["semester"],
    },
  },
];

const MUTATING_TOOLS = new Set(["enroll_course", "unenroll_course", "archive_semester"]);

function describePendingAction(tool: string, args: Record<string, unknown>, lang: "el" | "en"): string {
  if (tool === "enroll_course") {
    return lang === "el"
      ? `Εγγραφή στο μάθημα «${String(args.course ?? "")}» στο eClass`
      : `Join course "${String(args.course ?? "")}" on eClass`;
  }
  if (tool === "unenroll_course") {
    return lang === "el"
      ? `Απεγγραφή από το μάθημα «${String(args.course ?? "")}» στο eClass`
      : `Remove course "${String(args.course ?? "")}" from eClass`;
  }
  if (tool === "archive_semester") {
    const sem = String(args.semester ?? "");
    const unreg = Boolean(args.unenrollFromEclass);
    return lang === "el"
      ? `${unreg ? "Απεγγραφή από eClass" : "Αρχειοθέτηση"} μαθημάτων του εξαμήνου «${sem}»`
      : `${unreg ? "Unenroll on eClass" : "Archive"} courses from semester "${sem}"`;
  }
  return `${tool}(${JSON.stringify(args)})`;
}

async function runReadOnlyTool(
  user: UserRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const connector = getConnectorForUser(user);
  switch (name) {
    case "list_courses": {
      const list = await connector.listCourses();
      return list.map((c) => ({
        ...c,
        semester: user.courseMeta[c.code]?.semester ?? c.semester,
        archived: user.courseMeta[c.code]?.archived ?? false,
      }));
    }
    case "search_catalog": {
      const query = typeof args.query === "string" && args.query ? args.query : undefined;
      const departmentId =
        typeof args.departmentId === "string" && args.departmentId ? args.departmentId : undefined;
      let list = await connector.listCatalog(query, departmentId);
      if (typeof args.semester === "number" && args.semester >= 1 && args.semester <= 9) {
        list = list.filter((c) => c.semesterIndex === args.semester);
      }
      return list;
    }
    case "list_documents": {
      const courseCode = String(args.courseCode ?? "");
      const dir = typeof args.dir === "string" && args.dir ? args.dir : "/";
      return connector.listDocuments(courseCode, dir);
    }
    case "get_announcements": {
      const list = await connector.getAnnouncements(
        typeof args.courseCode === "string" && args.courseCode ? args.courseCode : undefined,
      );
      return list.slice(0, 15).map((a) => ({
        courseCode: a.courseCode,
        courseTitle: a.courseTitle,
        title: a.title,
        text: a.contentText,
        date: a.date,
      }));
    }
    case "get_messages": {
      const list = await connector.getMessages();
      return list.slice(0, 20).map((m) => ({
        id: m.id,
        subject: m.subject,
        sender: m.sender,
        date: m.date,
        course: m.courseTitle,
        read: m.read,
      }));
    }
    case "read_message": {
      const msg = await connector.getMessage(String(args.id ?? ""));
      if (!msg) return { error: "Message not found" };
      return {
        subject: msg.subject,
        sender: msg.sender,
        date: msg.date,
        course: msg.courseTitle,
        body: stripTags(msg.bodyHtml ?? "").slice(0, 6000),
        attachments: msg.attachments?.map((a) => a.name),
      };
    }
    case "get_deadlines": {
      const list = await connector.getAssignments(
        typeof args.courseCode === "string" && args.courseCode ? args.courseCode : undefined,
      );
      const now = Date.now();
      return list
        .map((a) => ({
          id: a.id,
          courseCode: a.courseCode,
          course: a.courseTitle,
          title: a.title,
          deadline: a.deadline ? formatAthens(a.deadline) : "no deadline",
          daysLeft: a.deadline ? Math.ceil((new Date(a.deadline).getTime() - now) / 86_400_000) : null,
          submitted: a.submitted,
          grade: a.grade,
        }))
        .sort((x, y) => (x.daysLeft ?? 9999) - (y.daysLeft ?? 9999));
    }
    case "get_assignment_details": {
      const d = await connector.getAssignmentDetail(String(args.courseCode ?? ""), String(args.assignmentId ?? ""));
      return {
        title: d.title,
        description: stripTags(d.descriptionHtml).slice(0, 6000),
        deadline: d.deadline ? formatAthens(d.deadline) : undefined,
        submitted: d.submitted,
        grade: d.grade,
        submissionOpen: d.canSubmit,
        submissionType: d.submissionType,
        maxFiles: d.maxFiles,
        attachedFiles: d.attachments.map((a) => a.name),
        existingSubmission: d.existingSubmission,
      };
    }
    case "read_document": {
      const courseCode = String(args.courseCode ?? "");
      const path = String(args.path ?? "");
      if (!courseCode || !path) return { error: "courseCode and path are required" };
      const question = typeof args.question === "string" ? args.question : undefined;
      const res = await summarizeCourseDocument(user, courseCode, path, { question });
      return { file: res.name, content: res.summary };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function executeConfirmedAction(
  user: UserRecord,
  action: PendingAction,
): Promise<string> {
  const connector = getConnectorForUser(user);
  const lang = user.settings.language;

  if (action.tool === "enroll_course") {
    const course = await connector.enrollCourse(String(action.args.course ?? ""));
    return lang === "el"
      ? `Έγινε εγγραφή στο μάθημα **${course.title}** (${course.publicCode ?? course.code}).`
      : `Successfully enrolled in **${course.title}** (${course.publicCode ?? course.code}).`;
  }

  if (action.tool === "unenroll_course") {
    const course = await connector.unenrollCourse(String(action.args.course ?? ""));
    return lang === "el"
      ? `Έγινε απεγγραφή από το μάθημα **${course.title}** (${course.publicCode ?? course.code}).`
      : `Removed **${course.title}** (${course.publicCode ?? course.code}) from your courses.`;
  }

  if (action.tool === "archive_semester") {
    const sem = String(action.args.semester ?? "").trim().toLowerCase();
    if (sem.length < 2) {
      throw new Error(lang === "el" ? "Δεν δόθηκε έγκυρο εξάμηνο." : "No valid semester was given.");
    }
    const unreg = Boolean(action.args.unenrollFromEclass);
    const all = await connector.listCourses();
    const matched = all.filter((c) => {
      const s = (user.courseMeta[c.code]?.semester ?? c.semester ?? "").toLowerCase();
      const sf = (c.semesterFolder ?? "").toLowerCase();
      return s.includes(sem) || sf.includes(sem);
    });
    for (const c of matched) {
      if (unreg) {
        await connector.unenrollCourse(c.code);
      } else {
        users.update(user.id, (u) => {
          u.courseMeta[c.code] = { ...u.courseMeta[c.code], archived: true };
        });
      }
    }
    return lang === "el"
      ? `Ολοκληρώθηκε για ${matched.length} μαθήματα (${matched.map((m) => m.title).join(", ") || "κανένα"}).`
      : `Completed for ${matched.length} courses (${matched.map((m) => m.title).join(", ") || "none"}).`;
  }

  throw new Error(`Unsupported action ${action.tool}`);
}

/* ------------------------------------------------------------------ */
/* Gemini Interactions API client (v1beta/interactions)                */
/* ------------------------------------------------------------------ */

interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface InteractionResponse {
  id?: string;
  steps?: InteractionStep[];
  output_text?: string;
}

async function resolveGeminiAuth(
  user: UserRecord,
): Promise<{ headers: Record<string, string>; model: string } | null> {
  const model = user.settings.ai.model || env.gemini.model || "gemini-3.8-flash";

  if (user.settings.ai.mode === "apiKey" && user.ai.encApiKey) {
    return { headers: { "x-goog-api-key": decrypt(user.ai.encApiKey) }, model };
  }
  if (user.settings.ai.mode === "google" && user.ai.google) {
    if (user.ai.google.accessToken === "aistudio-key" && user.ai.encApiKey) {
      return { headers: { "x-goog-api-key": decrypt(user.ai.encApiKey) }, model };
    }
    const token = await getValidGoogleAccessToken(user);
    if (token) return { headers: { Authorization: `Bearer ${token}` }, model };
  }
  if (user.ai.encApiKey) {
    return { headers: { "x-goog-api-key": decrypt(user.ai.encApiKey) }, model };
  }
  if (env.gemini.apiKey) {
    return { headers: { "x-goog-api-key": env.gemini.apiKey }, model };
  }
  return null;
}

async function callGeminiInteractions(
  authHeaders: Record<string, string>,
  model: string,
  history: unknown[],
  systemInstruction: string,
  withTools = true,
): Promise<InteractionResponse> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      model,
      store: false,
      system_instruction: systemInstruction,
      input: history,
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API (${res.status}): ${errText.slice(0, 240)}`);
  }
  return (await res.json()) as InteractionResponse;
}

function extractTextFromSteps(resp: InteractionResponse): string {
  if (typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text;
  const parts: string[] = [];
  for (const step of resp.steps ?? []) {
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const c of step.content) {
        if (c.type === "text" && c.text) parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function stripTags(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function formatAthens(iso: string | Date, lang: "el" | "en" = "el"): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString(lang === "el" ? "el-GR" : "en-GB", {
    timeZone: "Europe/Athens",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateJson(value: unknown, max = 24_000): string {
  const json = JSON.stringify(value);
  if (json.length <= max) return json;
  return `${json.slice(0, max)}… [truncated ${json.length - max} chars – ask a narrower question or pass a courseCode]`;
}

/* ------------------------------------------------------------------ */
/* Document summaries (Gemini generateContent, multimodal)             */
/* ------------------------------------------------------------------ */

const summaryCache = new Map<string, { at: number; summary: string; name: string }>();
const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function callGeminiGenerate(
  auth: { headers: Record<string, string>; model: string },
  parts: unknown[],
  systemInstruction: string,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(auth.model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API (${res.status}): ${errText.slice(0, 240)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty answer");
  return text;
}

/**
 * Summarizes (or answers `question` about) one document of a course. Used by the
 * "AI summary" button in Documents and by the assistant's `read_document` tool.
 */
export async function summarizeCourseDocument(
  user: UserRecord,
  courseCode: string,
  path: string,
  opts: { question?: string; refresh?: boolean } = {},
): Promise<{ name: string; summary: string; cached: boolean }> {
  const lang = user.settings.language;
  const cacheKey = `${user.id}|${courseCode}|${path}|${lang}`;
  if (!opts.question && !opts.refresh) {
    const hit = summaryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return { name: hit.name, summary: hit.summary, cached: true };
  }

  const auth = await resolveGeminiAuth(user);
  if (!auth) {
    throw new Error(
      lang === "el"
        ? "Η σύνοψη με AI χρειάζεται σύνδεση με Gemini (Ρυθμίσεις → Βοηθός AI)."
        : "AI summaries need a Gemini connection (Settings → AI assistant).",
    );
  }

  const connector = getConnectorForUser(user);
  const file = await connector.downloadFile(courseCode, path);
  const data = Buffer.isBuffer(file.body) ? file.body : Buffer.from(await streamToBuffer(file.body));
  const prepared = prepareDocumentForAi(file.filename, file.contentType, data);
  if (prepared.kind === "unsupported") throw new Error(prepared.reason);

  const languageName = lang === "el" ? "Greek" : "English";
  const system = opts.question
    ? `You read university course material for a student and answer their question using ONLY the document. ` +
      `Quote exact numbers, dates, requirements and formulas from the document. If the document does not contain the answer, say so. ` +
      `Answer in ${languageName}, plain text, "• " bullets, **bold** only for key terms. No headings, no LaTeX.`
    : `You summarize university course material for a busy student. Write in ${languageName}. ` +
      `Structure: one sentence on what the document is; then "• " bullets with the key ideas/definitions/results ` +
      `(max 8, each one line); then, if present, a line starting with "${lang === "el" ? "Παραδοτέα & προθεσμίες" : "Deliverables & deadlines"}:" listing ` +
      `requirements, deadlines, submission format and grading weight exactly as written. Keep formulas readable in plain text (no LaTeX). ` +
      `No headings, no preamble, no closing remarks. Max ~250 words.`;

  const instruction = opts.question
    ? `Document: "${file.filename}". Question: ${opts.question}`
    : `Summarize the document "${file.filename}".`;

  const parts =
    prepared.kind === "inline"
      ? [{ inlineData: { mimeType: prepared.mimeType, data: prepared.data.toString("base64") } }, { text: instruction }]
      : [{ text: `${instruction}\n\n----- DOCUMENT TEXT -----\n${prepared.text || "(the file contains no extractable text)"}` }];

  const summary = cleanReadableAssistantText(await callGeminiGenerate(auth, parts, system));
  if (!opts.question) summaryCache.set(cacheKey, { at: Date.now(), summary, name: file.filename });
  return { name: file.filename, summary, cached: false };
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

async function buildSystemInstruction(user: UserRecord): Promise<string> {
  const acadYear = getCurrentAcademicYearBounds();
  const uni = getUniversity(user.universityId);
  const uniName = uni ? `${uni.nameEn} (${uni.name})` : "a Greek university";
  const now = formatAthens(new Date(), "en");

  let courseLines = "(could not load the course list – call list_courses)";
  try {
    const courses = await Promise.race([
      getConnectorForUser(user).listCourses(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    const active = courses.filter((c) => !user.courseMeta[c.code]?.archived);
    courseLines = active.length
      ? active
          .map(
            (c) =>
              `- ${c.code}${c.publicCode && c.publicCode !== c.code ? ` / ${c.publicCode}` : ""} — ${c.title}` +
              `${c.professor ? ` — ${c.professor}` : ""}${user.courseMeta[c.code]?.semester ?? c.semester ? ` — ${user.courseMeta[c.code]?.semester ?? c.semester}` : ""}`,
          )
          .join("\n")
      : "(none found on eClass – if the student says they have courses, suggest Refresh, or signing out and in again)";
  } catch {
    /* keep the fallback text */
  }

  return [
    `You are myClass, the study assistant inside an app that brings a student's Open eClass at ${uniName} into one place.`,
    "",
    "CONTEXT",
    `- Now: ${now} (Europe/Athens). Academic year ${acadYear.label}.`,
    `- Student: ${user.displayName} (username ${user.username}).`,
    "- Enrolled courses (code — title — professor — semester):",
    courseLines,
    "- The app has: Home (calendar with all deadlines), Courses (documents with an 'AI summary' button, announcements, assignments with file upload/submission, every other eClass tool), Messages, Assistant (you), Settings.",
    "",
    "HOW TO WORK",
    "- Get facts with tools. Never invent courses, dates, grades, files, rooms or professors. If a tool returns nothing or fails, say so in one sentence and suggest the next step.",
    "- Match course names loosely: Greek or English, with/without accents, abbreviations and nicknames (e.g. 'ΒΔ' = Βάσεις Δεδομένων, 'OOP' = Αντικειμενοστρεφής Προγραμματισμός). Prefer the enrolled list above; use search_catalog only for courses not in it.",
    "- Deadlines / 'what do I have this week': call get_deadlines (optionally with courseCode). Show upcoming, unsubmitted items first, sorted by date, with days left. Mention overdue or already-submitted items only if relevant.",
    "- Questions about what a file, lecture, exercise sheet or project brief says: call list_documents for the course (open sub-folders if needed), pick the best-matching file, then call read_document with the student's question. Answer from that content and name the file you used.",
    "- Assignment questions ('what does project 2 ask', 'can I still submit'): get_deadlines, then get_assignment_details.",
    "- Joining/leaving a course or archiving a semester: call enroll_course / unenroll_course / archive_semester directly; the app shows the student a confirmation card, so don't ask 'are you sure?' yourself.",
    "- Uploading/submitting work is done in the app (Courses → course → Assignments → Submit); you cannot attach files yourself, but you can check requirements and status.",
    "- If a request is ambiguous (e.g. two courses or files match), ask ONE short question that lists the options. If it's clear, act without asking.",
    "- Only use items from the current academic year unless the student explicitly asks about older ones.",
    "- For general study help (explain a concept, make a study plan, quiz me), answer directly from your knowledge; use course files when the student refers to their course material.",
    "",
    "STYLE",
    "- Reply in the student's language (Greek or English) and match their tone. Be concise: answer first, details after. No filler, no repeating the question.",
    "- Plain text, short paragraphs, '• ' bullets. Use **bold** only for key names, dates and numbers. No headings, tables, LaTeX or code blocks (unless the student asks for code).",
    "- Dates like 'Παρ 21 Νοε, 23:59' in Greek or 'Fri 21 Nov, 23:59' in English. Times are Europe/Athens.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main chat turn orchestrator                                         */
/* ------------------------------------------------------------------ */

export async function runAssistantTurn(
  user: UserRecord,
  userMessageText: string,
  emit: (ev: ChatStreamEvent) => void,
): Promise<ChatMessage> {
  const userMsg: ChatMessage = {
    id: randomId(8),
    role: "user",
    text: userMessageText,
    createdAt: new Date().toISOString(),
  };
  users.update(user.id, (u) => {
    u.chat.messages.push(userMsg);
  });

  const toolsUsed: string[] = [];
  let pendingAction: PendingAction | undefined;
  let finalText = "";

  const auth = await resolveGeminiAuth(user);
  const lang = user.settings.language;

  if (auth) {
    try {
      const systemInstruction = await buildSystemInstruction(user);

      // Persisted history holds ONLY plain text turns. Tool calls/results stay inside one turn:
      // replaying a function_result whose function_call was cut off by the history window made
      // Gemini reject the request, which silently dropped the chat to the keyword-only fallback.
      const priorTurns = (user.chat.history as Array<{ type?: string }>)
        .filter((s) => s && (s.type === "user_input" || s.type === "model_output"))
        .slice(-20);
      while (priorTurns.length && priorTurns[0].type !== "user_input") priorTurns.shift();

      const history: unknown[] = [
        ...priorTurns,
        { type: "user_input", content: [{ type: "text", text: userMessageText }] },
      ];

      const MAX_ROUNDS = 6;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const lastRound = round === MAX_ROUNDS - 1;
        const resp = await callGeminiInteractions(auth.headers, auth.model, history, systemInstruction, !lastRound);
        const steps = resp.steps ?? [];
        history.push(...steps);

        const fcSteps = steps.filter((s) => s.type === "function_call" && s.name);
        if (fcSteps.length === 0 || lastRound) {
          finalText = extractTextFromSteps(resp);
          break;
        }

        let hitMutating = false;
        for (const fc of fcSteps) {
          const toolName = fc.name!;
          const args = fc.arguments ?? {};
          toolsUsed.push(toolName);
          emit({ type: "tool", name: toolName });

          if (MUTATING_TOOLS.has(toolName)) {
            pendingAction = {
              id: randomId(8),
              tool: toolName,
              args,
              summary: describePendingAction(toolName, args, lang),
              status: "pending",
            };
            emit({ type: "action", action: pendingAction });
            users.update(user.id, (u) => {
              u.chat.pending[pendingAction!.id] = {
                action: pendingAction!,
                callId: fc.id ?? pendingAction!.id,
              };
            });
            hitMutating = true;
            break;
          }

          let toolResult: unknown;
          try {
            toolResult = await runReadOnlyTool(user, toolName, args);
          } catch (toolErr) {
            // Let the model explain the failure instead of aborting the whole answer
            toolResult = { error: (toolErr as Error).message || "Tool failed" };
          }
          history.push({
            type: "function_result",
            name: toolName,
            call_id: fc.id,
            result: [{ type: "text", text: truncateJson(toolResult) }],
          });
        }

        if (hitMutating) {
          finalText =
            extractTextFromSteps(resp) ||
            (lang === "el"
              ? `Ετοίμασα την ενέργεια: **${pendingAction?.summary}**. Πάτησε **Επιβεβαίωση** παρακάτω για να εκτελεστεί.`
              : `I prepared the action: **${pendingAction?.summary}**. Click **Confirm** below to run it.`);
          break;
        }
      }

      if (!finalText.trim() && !pendingAction) {
        finalText =
          lang === "el"
            ? "Δεν κατάφερα να ολοκληρώσω την απάντηση. Μπορείς να το ρωτήσεις λίγο πιο συγκεκριμένα (π.χ. με το όνομα του μαθήματος);"
            : "I couldn't complete that answer. Could you ask a bit more specifically (e.g. with the course name)?";
      }

      users.update(user.id, (u) => {
        u.chat.history = [
          ...priorTurns,
          { type: "user_input", content: [{ type: "text", text: userMessageText }] },
          { type: "model_output", content: [{ type: "text", text: finalText }] },
        ].slice(-20);
      });
    } catch (err) {
      console.warn("[assistant] Gemini failed, using offline assistant:", (err as Error).message);
      const fallback = await runLocalSmartAssistant(user, userMessageText, toolsUsed, emit);
      const note =
        lang === "el"
          ? "(Το Gemini δεν απάντησε αυτή τη φορά, οπότε απαντώ με τον απλό βοηθό χωρίς AI.)\n\n"
          : "(Gemini didn't respond this time, so this answer comes from the basic offline assistant.)\n\n";
      finalText = note + fallback.text;
      pendingAction = fallback.action;
    }
  } else {
    const fallback = await runLocalSmartAssistant(user, userMessageText, toolsUsed, emit);
    finalText = fallback.text;
    pendingAction = fallback.action;
  }

  finalText = cleanReadableAssistantText(finalText);
  emit({ type: "text", delta: finalText });

  const assistantMsg: ChatMessage = {
    id: randomId(8),
    role: "assistant",
    text: finalText,
    createdAt: new Date().toISOString(),
    action: pendingAction,
    toolsUsed: toolsUsed.length ? toolsUsed : undefined,
  };

  users.update(user.id, (u) => {
    u.chat.messages.push(assistantMsg);
  });

  emit({ type: "done", message: assistantMsg });
  return assistantMsg;
}

function cleanReadableAssistantText(raw: string): string {
  return raw
    // Strip LaTeX commands like \textbf{...}, \textit{...}, \texttt{...}, \underline{...}
    .replace(/\\text(?:bf|it|tt|rm)\{([^}]*)\}/g, "$1")
    .replace(/\\(?:underline|emph)\{([^}]*)\}/g, "$1")
    // Strip inline/display LaTeX math delimiters $...$ or $$...$$ when wrapping text/identifiers
    .replace(/\$\$([^$]+)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    // Convert markdown headings (### Title) into clean bold lines
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
    // Convert markdown bullet dashes at start of line into clean • bullets
    .replace(/^(\s*)-\s+/gm, "$1• ")
    // Strip italic underscores around phrases _(text)_ or _text_ (without touching filenames like Α_εξάμηνο)
    .replace(/(^|[\s(])_([^_\n]+)_([\s).,;:!?]|$)/g, "$1$2$3")
    // Strip backticks around course codes/filenames
    .replace(/`([^`\n]+)`/g, "$1")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Helpers for matching courses & semesters in natural language        */
/* ------------------------------------------------------------------ */

function normalizeGreek(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ς/g, "σ");
}

function detectSemesterIndexFromPrompt(q: string): number | null {
  const n = normalizeGreek(q);
  // Do not confuse "1st project" / "1η εργασία" with "1st semester"
  const mentionsSemesterContext = /(εξαμην|semester|\bsem\b)/i.test(n);
  if (/α_εξαμηνο|α'\s*εξαμην|α΄\s*εξαμην|α\s+εξαμην/.test(n)) return 1;
  if (/β_εξαμηνο|β'\s*εξαμην|β΄\s*εξαμην|β\s+εξαμην/.test(n)) return 2;
  if (/γ_εξαμηνο|γ'\s*εξαμην|γ΄\s*εξαμην|γ\s+εξαμην/.test(n)) return 3;
  if (/δ_εξαμηνο|δ'\s*εξαμην|δ΄\s*εξαμην|δ\s+εξαμην/.test(n)) return 4;
  if (/ε_εξαμηνο|ε'\s*εξαμην|ε΄\s*εξαμην|ε\s+εξαμην/.test(n)) return 5;
  if (/στ_εξαμηνο|στ'\s*εξαμην|στ΄\s*εξαμην|στ\s+εξαμην/.test(n)) return 6;
  if (/ζ_εξαμηνο|ζ'\s*εξαμην|ζ΄\s*εξαμην|ζ\s+εξαμην/.test(n)) return 7;
  if (/η_εξαμηνο|η'\s*εξαμην|η΄\s*εξαμην|η\s+εξαμην/.test(n)) return 8;

  if (!mentionsSemesterContext) return null;
  if (/\b(1ο|1ου|πρωτο|1st|sem\s*1|semester\s*1)\b/.test(n)) return 1;
  if (/\b(2ο|2ου|δευτερο|2nd|sem\s*2|semester\s*2)\b/.test(n)) return 2;
  if (/\b(3ο|3ου|τριτο|3rd|sem\s*3|semester\s*3)\b/.test(n)) return 3;
  if (/\b(4ο|4ου|τεταρτο|4th|sem\s*4|semester\s*4)\b/.test(n)) return 4;
  if (/\b(5ο|5ου|πεμπτο|5th|sem\s*5|semester\s*5)\b/.test(n)) return 5;
  if (/\b(6ο|6ου|εκτο|6th|sem\s*6|semester\s*6)\b/.test(n)) return 6;
  if (/\b(7ο|7ου|εβδομο|7th|sem\s*7|semester\s*7)\b/.test(n)) return 7;
  if (/\b(8ο|8ου|ογδοο|8th|sem\s*8|semester\s*8)\b/.test(n)) return 8;
  return null;
}

function detectProjectOrdinalFromPrompt(q: string): number | null {
  const n = normalizeGreek(q);
  if (
    /(?:^|[^a-zα-ω0-9])(1η|1ης|1ο|πρωτη|πρωτης|1st|first)(?:$|[^a-zα-ω0-9])/.test(n) ||
    /(εργασια|ergasia|project|assignment)\s*[_-]?1(?:$|[^0-9])/.test(n)
  ) {
    return 1;
  }
  if (
    /(?:^|[^a-zα-ω0-9])(2η|2ης|2ο|δευτερη|δευτερης|2nd|second)(?:$|[^a-zα-ω0-9])/.test(n) ||
    /(εργασια|ergasia|project|assignment)\s*[_-]?2(?:$|[^0-9])/.test(n)
  ) {
    return 2;
  }
  if (
    /(?:^|[^a-zα-ω0-9])(3η|3ης|3ο|τριτη|τριτης|3rd|third)(?:$|[^a-zα-ω0-9])/.test(n) ||
    /(εργασια|ergasia|project|assignment)\s*[_-]?3(?:$|[^0-9])/.test(n)
  ) {
    return 3;
  }
  if (
    /(?:^|[^a-zα-ω0-9])(4η|4ης|4ο|τεταρτη|4th|fourth)(?:$|[^a-zα-ω0-9])/.test(n) ||
    /(εργασια|ergasia|project|assignment)\s*[_-]?4(?:$|[^0-9])/.test(n)
  ) {
    return 4;
  }
  return null;
}

function matchesProjectOrdinal(text: string, ordinal: number | null, requireExplicit = false): boolean {
  if (ordinal === null) return true;
  const n = normalizeGreek(text);
  // Reject "πτυχιακές εργασίες" (bachelor thesis) or "ιεραρχική ανάλυση εργασιών" (lecture topic)
  if (/πτυχιακ|ιεραρχικ/i.test(n)) return false;

  for (let k = 1; k <= 5; k++) {
    if (k === ordinal) continue;
    const otherRe = new RegExp(
      `((?:^|[^a-zα-ω0-9])${k}(η|ης|ο)(?:$|[^a-zα-ω0-9])|(εργασια|ergasia|project|γε|ασκηση)\\s*[_-]?${k}(?:$|[^0-9]))`,
      "i",
    );
    if (otherRe.test(n)) return false;
  }

  if (requireExplicit) {
    const targetRe = new RegExp(
      `((?:^|[^a-zα-ω0-9])${ordinal}(η|ης|ο)(?:$|[^a-zα-ω0-9])|(εργασια|ergasia|project|γε|ασκηση)\\s*[_-]?${ordinal}(?:$|[^0-9])|smart_mars)`,
      "i",
    );
    return targetRe.test(n);
  }
  return true;
}

const STOPWORDS_FOR_COURSE_MATCH = new Set([
  "εργασια",
  "εργασιες",
  "εργασιας",
  "πρωτη",
  "δευτερη",
  "τριτη",
  "προθεσμια",
  "παραδοση",
  "μαθημα",
  "μαθηματα",
  "project",
  "projects",
  "assignment",
  "assignments",
  "first",
  "second",
  "deadline",
  "deadlines",
  "arxeia",
  "αρχεια",
  "εγγραφα",
]);

function findMatchingCatalogCourse(prompt: string, catalog: CatalogCourse[]): CatalogCourse | undefined {
  const qNorm = normalizeGreek(prompt);
  // 1. Exact code match
  for (const c of catalog) {
    const codeL = c.code.toLowerCase();
    const pubL = (c.publicCode ?? "").toLowerCase();
    if (
      qNorm.includes(codeL) ||
      (pubL && pubL.length >= 4 && qNorm.includes(normalizeGreek(pubL)))
    ) {
      return c;
    }
  }
  // 2. Best title word overlap (ignoring generic query words)
  let best: { course: CatalogCourse; score: number } | undefined;
  for (const c of catalog) {
    const words = normalizeGreek(c.title)
      .split(/[^a-zα-ω0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS_FOR_COURSE_MATCH.has(w));
    let score = 0;
    for (const w of words) {
      if (qNorm.includes(w.slice(0, Math.max(4, w.length - 2)))) {
        score += w.length;
      }
    }
    if (score >= 5 && score > (best?.score ?? 0)) {
      best = { course: c, score };
    }
  }
  return best?.course;
}

/* ------------------------------------------------------------------ */
/* Built-in local assistant (works before a Gemini key is configured)  */
/* ------------------------------------------------------------------ */

async function runLocalSmartAssistant(
  user: UserRecord,
  prompt: string,
  toolsUsed: string[],
  emit: (ev: ChatStreamEvent) => void,
): Promise<{ text: string; action?: PendingAction }> {
  const q = prompt.toLowerCase();
  const qNorm = normalizeGreek(prompt);
  const lang = user.settings.language;
  const connector = getConnectorForUser(user);

  // 1. Unenroll / remove a course
  if (/(απεγγραφ|διαγραφ|βγαλ|αφαιρεσ|unenroll|remove|drop|leave)/i.test(qNorm)) {
    toolsUsed.push("list_courses");
    emit({ type: "tool", name: "list_courses" });
    const courses = await connector.listCourses();
    const match =
      courses.find(
        (c) =>
          qNorm.includes(c.code.toLowerCase()) ||
          (c.publicCode && qNorm.includes(normalizeGreek(c.publicCode))) ||
          normalizeGreek(c.title)
            .split(/\s+/)
            .some((w) => w.length > 4 && qNorm.includes(w.slice(0, Math.max(4, w.length - 1)))),
      ) ?? courses[courses.length - 1];

    if (!match) {
      return {
        text:
          lang === "el"
            ? "Δεν βρέθηκε εγγεγραμμένο μάθημα προς απεγγραφή."
            : "No enrolled course found to unenroll.",
      };
    }

    const targetTitle = `${match.title} (${match.publicCode ?? match.code})`;
    const action: PendingAction = {
      id: randomId(8),
      tool: "unenroll_course",
      args: { course: match.code },
      summary: describePendingAction("unenroll_course", { course: targetTitle }, lang),
      status: "pending",
    };
    users.update(user.id, (u) => {
      u.chat.pending[action.id] = { action, callId: action.id };
    });
    emit({ type: "action", action });
    return {
      text:
        lang === "el"
          ? `Βρήκα το μάθημα **${targetTitle}** (${match.semester ?? ""}). Θέλεις να προχωρήσω σε απεγγραφή από το eClass; Επιβεβαίωσε παρακάτω:`
          : `I found **${targetTitle}** (${match.semester ?? ""}). Would you like me to remove it from your eClass courses? Please confirm below:`,
      action,
    };
  }

  // 2. Enroll / join a course
  if (/(εγγραφ|δηλωσ|προσθεσ|μπω|join|enroll|add\s+course|register)/i.test(qNorm)) {
    toolsUsed.push("search_catalog");
    emit({ type: "tool", name: "search_catalog" });
    const catalog = await connector.listCatalog();
    const available = catalog.filter((c) => !c.enrolled && !c.locked);
    const match = findMatchingCatalogCourse(prompt, available) ?? findMatchingCatalogCourse(prompt, catalog) ?? available[0];

    if (!match) {
      return {
        text:
          lang === "el"
            ? "Δεν βρέθηκε διαθέσιμο μάθημα για εγγραφή στον κατάλογο."
            : "No matching available course found in the catalog.",
      };
    }

    const action: PendingAction = {
      id: randomId(8),
      tool: "enroll_course",
      args: { course: match.code },
      summary: describePendingAction("enroll_course", { course: `${match.title} (${match.code})` }, lang),
      status: "pending",
    };
    users.update(user.id, (u) => {
      u.chat.pending[action.id] = { action, callId: action.id };
    });
    emit({ type: "action", action });
    return {
      text:
        lang === "el"
          ? `Βρήκα το μάθημα **${match.title}** (\`${match.code}\` · ${match.semester ?? ""} · Διδάσκων: ${match.professor ?? "—"}). Πάτησε **Επιβεβαίωση** για να ολοκληρωθεί η εγγραφή:`
          : `I found **${match.title}** (\`${match.code}\` · ${match.semester ?? ""} · Prof: ${match.professor ?? "—"}). Click **Confirm** below to complete registration:`,
      action,
    };
  }

  // 3. Projects / Assignments / Deadlines (Current Academic Year ONLY — filters out previous years!)
  if (/(εργασι|προθεσμι|παραδοσ|project|deadline|assignment|homework|due|παραδοτε)/i.test(qNorm)) {
    toolsUsed.push("get_deadlines", "get_announcements", "list_documents");
    emit({ type: "tool", name: "get_deadlines" });

    const acadYear = getCurrentAcademicYearBounds();
    const ordinal = detectProjectOrdinalFromPrompt(prompt);
    const catalog = await connector.listCatalog();
    const specificCourse = findMatchingCatalogCourse(prompt, catalog);

    const [rawAssignments, rawAnnouncements] = await Promise.all([
      connector.getAssignments(specificCourse?.code),
      connector.getAnnouncements(specificCourse?.code),
    ]);

    const assignments = rawAssignments.filter(
      (a) => !hasPastAcademicYearTag(a.title) && matchesProjectOrdinal(a.title, ordinal),
    );

    const projectAnnouncements = rawAnnouncements.filter((a) => {
      const text = `${a.title} ${a.contentText}`;
      if (hasPastAcademicYearTag(text)) return false;
      if (/πτυχιακ/i.test(normalizeGreek(a.title))) return false;
      if (!/(εργασι|project|παραδοσ|assignment)/i.test(normalizeGreek(text))) return false;
      return matchesProjectOrdinal(a.title, ordinal, ordinal !== null);
    });

    const targetCourseCodes = new Set<string>();
    if (specificCourse) {
      targetCourseCodes.add(specificCourse.code);
    } else {
      for (const a of assignments) targetCourseCodes.add(a.courseCode);
      for (const ann of projectAnnouncements) targetCourseCodes.add(ann.courseCode);
    }

    emit({ type: "tool", name: "list_documents" });
    const projectFilesByCourse = new Map<string, string[]>();
    await Promise.all(
      [...targetCourseCodes].slice(0, 5).map(async (code) => {
        try {
          const docs = await connector.listDocuments(code, "/");
          const matchingDocs = docs.filter((d) => {
            if (d.isDir || hasPastAcademicYearTag(d.name)) return false;
            const n = normalizeGreek(d.name);
            if (/ιεραρχικ|πτυχιακ|μαθημα_|διαλεξη/i.test(n)) return false;
            const isProjectDoc =
              /(ergasia|εργασι|project|εκφωνησ|θεμα|smart_mars|analysh1_ergasia)/i.test(n) ||
              d.name.includes(String(acadYear.startYear));
            return isProjectDoc && matchesProjectOrdinal(d.name, ordinal, ordinal !== null);
          });
          if (matchingDocs.length > 0) {
            projectFilesByCourse.set(
              code,
              matchingDocs.map((d) => d.name),
            );
          }
        } catch {
          /* ignore */
        }
      }),
    );

    const sections: string[] = [];

    if (assignments.length > 0) {
      const asgLines = assignments.map((a) => {
        const deadlineStr = a.deadline
          ? new Date(a.deadline).toLocaleDateString(lang === "el" ? "el-GR" : "en-US", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : lang === "el"
            ? "Ενεργή"
            : "Active";
        const files = projectFilesByCourse.get(a.courseCode);
        const filesNote =
          files && files.length > 0
            ? `\n  📄 _${lang === "el" ? "Αρχεία τρέχοντος έτους" : "Current-year files"}:_ ${files.map((f) => `\`${f}\``).join(", ")}`
            : "";
        return `- **${a.courseTitle ?? a.courseCode} (\`${a.courseCode}\`)** — **${a.title}**\n  ⏰ _${
          lang === "el" ? "Προθεσμία" : "Deadline"
        }:_ **${deadlineStr}** · ${
          a.submitted
            ? lang === "el"
              ? "✅ Παραδόθηκε"
              : "✅ Submitted"
            : lang === "el"
              ? "⏳ Εκκρεμεί"
              : "⏳ Pending"
        }${filesNote}`;
      });
      sections.push(asgLines.join("\n\n"));
    }

    if (projectAnnouncements.length > 0) {
      const annLines = projectAnnouncements.slice(0, 4).map((ann) => {
        const files = !assignments.some((a) => a.courseCode === ann.courseCode)
          ? projectFilesByCourse.get(ann.courseCode)
          : undefined;
        const filesNote =
          files && files.length > 0
            ? `\n  📄 _${lang === "el" ? "Αρχεία" : "Files"}:_ ${files.map((f) => `\`${f}\``).join(", ")}`
            : "";
        return `- **${ann.courseTitle ?? ann.courseCode} (\`${ann.courseCode}\`)** — **${ann.title}** _(${new Date(
          ann.date,
        ).toLocaleDateString(lang === "el" ? "el-GR" : "en-US")})_\n  ${ann.contentText.slice(0, 220)}${filesNote}`;
      });
      sections.push(
        (lang === "el"
          ? `### 📢 Σχετικές Ανακοινώσεις Εργασιών (${acadYear.label})\n`
          : `### 📢 Related Project Announcements (${acadYear.label})\n`) + annLines.join("\n\n"),
      );
    }

    if (sections.length === 0) {
      return {
        text:
          lang === "el"
            ? `Δεν βρέθηκαν ενεργές εργασίες για το ακαδημαϊκό έτος **${acadYear.label}** (έχουν φιλτραριστεί αυτόματα παλαιότερα έτη).`
            : `No active projects/assignments found for academic year **${acadYear.label}** (previous academic years have been filtered out automatically).`,
      };
    }

    const header =
      ordinal !== null
        ? lang === "el"
          ? `### 📌 ${ordinal}η Εργασία — Ακαδημαϊκό Έτος ${acadYear.label}\n_(Έχουν εξαιρεθεί αυτόματα εργασίες & αρχεία προηγούμενων ετών)_\n\n`
          : `### 📌 Project #${ordinal} — Academic Year ${acadYear.label}\n_(Projects & files from previous academic years are automatically excluded)_\n\n`
        : lang === "el"
          ? `### 📌 Ενεργές Εργασίες — Ακαδημαϊκό Έτος ${acadYear.label}\n\n`
          : `### 📌 Active Projects & Deadlines — Academic Year ${acadYear.label}\n\n`;

    return {
      text: header + sections.join("\n\n"),
    };
  }

  // 4. Inspect files / documents uploaded in a subject
  if (/(αρχει|εγγραφ|διαφανει|σημειωσ|φακελ|υλικο|document|file|slide|folder|pdf|zip)/i.test(qNorm)) {
    toolsUsed.push("search_catalog", "list_documents");
    emit({ type: "tool", name: "search_catalog" });
    const catalog = await connector.listCatalog();
    const targetCourse =
      findMatchingCatalogCourse(prompt, catalog) ??
      catalog.find((c) => c.enrolled) ??
      catalog[0];

    if (targetCourse) {
      emit({ type: "tool", name: "list_documents" });
      const nodes = await connector.listDocuments(targetCourse.code, "/");
      if (nodes.length === 0) {
        return {
          text:
            lang === "el"
              ? `Το μάθημα **${targetCourse.title}** (\`${targetCourse.code}\` · ${targetCourse.semester ?? ""}) δεν έχει αναρτημένα αρχεία στον αρχικό φάκελο αυτή τη στιγμή.`
              : `**${targetCourse.title}** (\`${targetCourse.code}\`) currently has no uploaded files in its root folder.`,
        };
      }
      const lines = nodes.slice(0, 20).map((n) =>
        n.isDir
          ? `- 📁 **${n.name}/** _(Φάκελος)_`
          : `- 📄 **${n.name}**${n.size ? ` (${Math.max(1, Math.round(n.size / 1024))} KB)` : ""}`,
      );
      return {
        text:
          lang === "el"
            ? `Στο μάθημα **${targetCourse.title}** (\`${targetCourse.code}\` · ${targetCourse.semester ?? ""} · Διδάσκων: _${targetCourse.professor ?? "—"}_) υπάρχουν **${nodes.length} στοιχεία** στα Έγγραφα:\n\n${lines.join("\n")}\n\nΜπορείς να το ανοίξεις στην καρτέλα **Μαθήματα → Έγγραφα** για προβολή ή λήψη \`.zip\`.`
            : `In **${targetCourse.title}** (\`${targetCourse.code}\` · ${targetCourse.semester ?? ""} · Prof: _${targetCourse.professor ?? "—"}_), there are **${nodes.length} items** in Documents:\n\n${lines.join("\n")}`,
      };
    }
  }

  // 5. Semester subjects / Professors / All University Subjects queries
  const semIdx = detectSemesterIndexFromPrompt(prompt);
  if (
    semIdx !== null ||
    /(εξαμην|μαθηματ|καθηγητ|διδασκ|προγραμμα σπουδων|καταλογ|semester|subject|professor|teacher|catalog|all courses)/i.test(
      qNorm,
    )
  ) {
    toolsUsed.push("search_catalog");
    emit({ type: "tool", name: "search_catalog" });
    const catalog = await connector.listCatalog();

    // 4a. Specific semester requested (e.g. "Α' εξάμηνο", "5ο εξάμηνο")
    if (semIdx !== null) {
      const semMeta = SEMESTERS[semIdx];
      const semCourses = catalog.filter((c) => c.semesterIndex === semIdx);
      const lines = semCourses.map(
        (c) =>
          `- **${c.title}** (\`${c.publicCode ?? c.code}\`) — 👤 _${c.professor ?? "—"}_${
            c.enrolled ? " · ✅ Εγγεγραμμένος" : ""
          }`,
      );
      return {
        text:
          lang === "el"
            ? `### 📚 ${semMeta.label} (\`${semMeta.folder}\`) — ${semCourses.length} Μαθήματα\n\n${lines.join("\n")}`
            : `### 📚 ${semMeta.labelEn} (\`${semMeta.folder}\`) — ${semCourses.length} Subjects\n\n${lines.join("\n")}`,
      };
    }

    // 4b. Specific course or professor question (e.g. "Ποιος διδάσκει Κρυπτογραφία;" or "Μαθήματα του Πατσάκη")
    const profMatches = catalog.filter((c) => {
      if (!c.professor) return false;
      const profWords = normalizeGreek(c.professor)
        .split(/[^a-zα-ω0-9]+/)
        .filter((w) => w.length >= 4);
      return profWords.some((pw) => qNorm.includes(pw.slice(0, Math.max(4, pw.length - 1))));
    });
    if (profMatches.length > 0 && profMatches.length <= 15) {
      const lines = profMatches.map(
        (c) =>
          `- **${c.title}** (\`${c.code}\` · ${c.semester ?? ""}) — 👤 _${c.professor}_${
            c.enrolled ? " · ✅ Εγγεγραμμένος" : ""
          }`,
      );
      return {
        text:
          lang === "el"
            ? `Βρήκα **${profMatches.length} μαθήματα** με αυτόν τον διδάσκοντα:\n\n${lines.join("\n")}`
            : `Found **${profMatches.length} courses** for that professor:\n\n${lines.join("\n")}`,
      };
    }

    const specificCourse = findMatchingCatalogCourse(prompt, catalog);
    if (specificCourse && /(ποιος|διδασκ|καθηγητ|κωδικ|εξαμην|who|teach|prof)/i.test(qNorm)) {
      return {
        text:
          lang === "el"
            ? `Το μάθημα **${specificCourse.title}** (\`${specificCourse.publicCode ?? specificCourse.code}\`) ανήκει στο **${specificCourse.semester}** (\`${specificCourse.semesterFolder}\`) και διδάσκεται από: **${specificCourse.professor ?? "—"}** (${specificCourse.enrolled ? "Είσαι εγγεγραμμένος" : "Διαθέσιμο στον κατάλογο"}).`
            : `**${specificCourse.title}** (\`${specificCourse.publicCode ?? specificCourse.code}\`) is in **${specificCourse.semester}** (\`${specificCourse.semesterFolder}\`) and is taught by **${specificCourse.professor ?? "—"}**.`,
      };
    }

    // 4c. Full overview across all 8 semesters (Α_εξάμηνο .. Η_Εξάμηνο)
    const sections: string[] = [];
    for (let s = 1; s <= 8; s++) {
      const semMeta = SEMESTERS[s];
      const list = catalog.filter((c) => c.semesterIndex === s);
      if (list.length === 0) continue;
      const preview = list
        .map((c) => `  - **${c.title}** (\`${c.code}\`) — _${c.professor ?? "—"}_${c.enrolled ? " ✅" : ""}`)
        .join("\n");
      sections.push(`**${semMeta.shortLabel} (\`${semMeta.folder}\` — ${list.length} μαθήματα):**\n${preview}`);
    }

    return {
      text:
        lang === "el"
          ? `Έχω πρόσβαση σε **όλα τα ${catalog.length} μαθήματα** του προγράμματος σπουδών (Α' έως Η' Εξάμηνο) με τους διδάσκοντες και τα αρχεία τους:\n\n${sections.join("\n\n")}`
          : `I have live access to **all ${catalog.length} university subjects** across Semesters 1–8 with their professors and uploaded files:\n\n${sections.join("\n\n")}`,
    };
  }

  // 6. Announcements / news
  if (/(ανακοινωσ|νεα|news|announcement|τι νεο)/i.test(qNorm)) {
    toolsUsed.push("get_announcements");
    emit({ type: "tool", name: "get_announcements" });
    const list = await connector.getAnnouncements();
    const top = list.slice(0, 6);
    const lines = top.map(
      (a) =>
        `- **[${a.courseTitle ?? a.courseCode}] ${a.title}** _(${new Date(a.date).toLocaleDateString("el-GR")})_: ${a.contentText.slice(0, 140)}`,
    );
    return {
      text:
        lang === "el"
          ? `Οι τελευταίες ανακοινώσεις σου από το eClass:\n\n${lines.join("\n")}`
          : `Here are your latest eClass announcements:\n\n${lines.join("\n")}`,
    };
  }

  // 7. Messages
  if (/(μηνυμ|inbox|message|mail)/i.test(qNorm)) {
    toolsUsed.push("get_messages");
    emit({ type: "tool", name: "get_messages" });
    const msgs = await connector.getMessages();
    const unread = msgs.filter((m) => !m.read);
    const lines = msgs.slice(0, 6).map(
      (m) => `- ${m.read ? "📩" : "🟣"} **${m.subject}** — _${m.sender}_ (${m.courseTitle ?? "eClass"})`,
    );
    return {
      text:
        lang === "el"
          ? `Έχεις **${unread.length} μη αναγνωσμένα** μηνύματα (σύνολο ${msgs.length}):\n\n${lines.join("\n")}`
          : `You have **${unread.length} unread** messages (${msgs.length} total):\n\n${lines.join("\n")}`,
    };
  }

  // Default: overview of enrolled courses + full catalog access
  toolsUsed.push("list_courses", "search_catalog", "get_announcements");
  emit({ type: "tool", name: "list_courses" });
  const [courses, catalog, announcements] = await Promise.all([
    connector.listCourses(),
    connector.listCatalog(),
    connector.getAnnouncements(),
  ]);

  const sample = courses[0]?.title ?? (lang === "el" ? "Βάσεις Δεδομένων" : "Databases");
  const sample2 = courses[1]?.title ?? sample;
  return {
    text:
      lang === "el"
        ? `Γεια σου **${user.displayName}**! Βλέπω **${courses.length} μαθήματα** στο eClass σου` +
          (catalog.length ? ` και **${catalog.length}** στον κατάλογο του τμήματος.` : ".") +
          (announcements[0] ? `

• Τελευταία ανακοίνωση: **${announcements[0].title}** (${announcements[0].courseTitle ?? ""})` : "") +
          `

Ρώτα με για παράδειγμα:
• «Τι προθεσμίες έχω αυτή την εβδομάδα;»
• «Τι αρχεία έχει το ${sample};»
• «Τι νέα ανακοίνωση έχει το ${sample2};»`
        : `Hi **${user.displayName}**! I can see **${courses.length} courses** on your eClass` +
          (catalog.length ? ` and **${catalog.length}** in your department's catalog.` : ".") +
          (announcements[0] ? `

• Latest announcement: **${announcements[0].title}** (${announcements[0].courseTitle ?? ""})` : "") +
          `

Try asking:
• "What deadlines do I have this week?"
• "What files does ${sample} have?"
• "Any new announcements in ${sample2}?"`,
  };
}
