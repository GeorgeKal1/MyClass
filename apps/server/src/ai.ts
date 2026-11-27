import type {
  Announcement,
  AnnouncementTriage,
  CatalogCourse,
  ChatMessage,
  ChatStreamEvent,
  ExamQuestion,
  Flashcard,
  PendingAction,
  QuizQuestion,
  StudyKind,
  StudyMaterial,
} from "@myclass/shared";
import crypto from "node:crypto";
import { decrypt, randomId, sha256 } from "./crypto.js";
import { withKnownSubmission } from "./deadlines.js";
import { getConnectorForUser, userDepartmentId, type EclassConnector } from "./eclass/connector.js";
import { resolveCourse } from "./eclass/course-match.js";
import { withOrigin } from "./eclass/request-origin.js";
import { getCurrentAcademicYearBounds, UNIPI_DEPARTMENTS } from "./eclass/unipi-curriculum.js";
import { prepareDocumentForAi } from "./doctext.js";
import { env } from "./env.js";
import { rankGeminiModels } from "./gemini-models.js";
import { AiQuotaError, consumeAiQuota, refundAiQuota } from "./quota.js";
import { users, type UserRecord } from "./store.js";

/* ------------------------------------------------------------------ */
/* Tool definitions (Gemini function calling)                          */
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
      "Lists or searches the course catalog of a University of Piraeus department (all semesters) with course code, title, professor, semester and enrollment status. Defaults to the student's own department.",
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
          description: `Optional department id, one of: ${UNIPI_DEPARTMENTS.map((d) => `${d.id} (${d.nameEn})`).join(", ")}. Defaults to the student's department.`,
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
        courseCode: { type: "string", description: "Course code from the enrolled list or search_catalog" },
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
      "Joins a course on eClass. The course is looked up in the catalog first: if the name matches several courses or none, you get the candidates back instead (then ask the student, or use search_catalog). When it resolves, the student gets a confirmation card.",
    parameters: {
      type: "object",
      properties: {
        course: {
          type: "string",
          description:
            "The course title as the student said it (e.g. 'Ανάλυση 1', 'βάσεις δεδομένων'), or an exact code taken from search_catalog. Never a guessed code.",
        },
        departmentId: {
          type: "string",
          description: "Only for a course of another department: its department id (as in search_catalog). Defaults to the student's department.",
        },
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

/** "Ανάλυση Ι (TMA117)" once the course is resolved, else what the assistant passed. */
function courseLabel(args: Record<string, unknown>): string {
  const title = typeof args.title === "string" ? args.title : "";
  const code = typeof args.code === "string" ? args.code : "";
  return title ? `${title}${code ? ` (${code})` : ""}` : String(args.course ?? "");
}

function describePendingAction(tool: string, args: Record<string, unknown>, lang: "el" | "en"): string {
  if (tool === "enroll_course") {
    return lang === "el" ? `Εγγραφή στο μάθημα «${courseLabel(args)}» στο eClass` : `Join "${courseLabel(args)}" on eClass`;
  }
  if (tool === "unenroll_course") {
    return lang === "el"
      ? `Απεγγραφή από το μάθημα «${courseLabel(args)}» στο eClass`
      : `Remove "${courseLabel(args)}" from eClass`;
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

type CourseLookup = Pick<EclassConnector, "findCatalogCourse" | "listCourses">;

/** One line for the assistant's step list: a count of what a tool found, or the course it settled on. */
export function summarizeToolResult(result: unknown): { ok: boolean; count?: number; item?: string } {
  if (Array.isArray(result)) return { ok: true, count: result.length };
  if (!result || typeof result !== "object") return { ok: true };
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return { ok: false };
  if (Array.isArray(r.candidates)) return { ok: true, count: r.candidates.length };
  if (typeof r.title === "string") return { ok: true, item: r.title.slice(0, 80) };
  const lists = Object.values(r).filter(Array.isArray);
  if (lists.length === 1) return { ok: true, count: lists[0].length };
  return { ok: true };
}

/**
 * What to do with a joining/leaving request before the student sees a confirmation card. The
 * course is looked up first, so a card only ever names one real course the student can join:
 * - `{ args }`: show the card; `args` carry the resolved code, department and title.
 * - `{ reply }`: no card; this goes back to the assistant as the tool's answer (several matches,
 *   no match, already enrolled, registration closed or needing the teacher's code), so it can ask
 *   the student or search instead of preparing an action that can only fail.
 */
export async function prepareMutatingAction(
  connector: CourseLookup,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ args: Record<string, unknown> } | { reply: Record<string, unknown> }> {
  const brief = (c: CatalogCourse) => ({
    code: c.code,
    ...(c.publicCode && c.publicCode !== c.code ? { publicCode: c.publicCode } : {}),
    title: c.title,
    ...(c.professor ? { professor: c.professor } : {}),
    ...(c.semester ? { semester: c.semester } : {}),
    ...(c.departmentId ? { departmentId: c.departmentId } : {}),
    enrolled: c.enrolled,
  });

  if (tool === "enroll_course") {
    const query = String(args.course ?? "").trim();
    if (!query) return { reply: { error: "No course given. Ask the student which course to join." } };
    const departmentId = typeof args.departmentId === "string" && args.departmentId ? args.departmentId : undefined;
    const found = await connector.findCatalogCourse(query, departmentId);
    if (found.status === "ambiguous") {
      return {
        reply: {
          error: `Several catalog courses match "${query}". Ask the student which one they mean (list them), then call enroll_course with that course's code.`,
          candidates: found.candidates.map(brief),
        },
      };
    }
    if (found.status === "not_found") {
      return {
        reply: {
          error: `No catalog course matches "${query}". Call search_catalog with a shorter keyword (or with departmentId for another department), or ask the student for the course's exact title. Do not guess course codes.`,
          ...(found.suggestions.length ? { similar: found.suggestions.map(brief) } : {}),
        },
      };
    }
    const c = found.course;
    const label = `${c.title} (${c.publicCode ?? c.code})`;
    if (c.enrolled) return { reply: { result: `The student is already enrolled in ${label}. Nothing to do.` } };
    if (c.locked) return { reply: { error: `Registration for ${label} is closed on eClass, so it can't be joined.` } };
    if (c.needsPassword) {
      return {
        reply: {
          error: `${label} asks for a registration code from the teacher, which only the student can type. Tell them to join it in myClass under Courses → All, where the app asks for the code.`,
        },
      };
    }
    if (!c.numericId) return { reply: { error: `eClass offers no way to join ${label} (no registration option in its catalog entry).` } };
    return {
      args: { course: c.code, departmentId: c.departmentId, title: c.title, code: c.publicCode ?? c.code },
    };
  }

  if (tool === "unenroll_course") {
    const query = String(args.course ?? "").trim();
    if (!query) return { reply: { error: "No course given. Ask the student which course to leave." } };
    const mine = await connector.listCourses();
    const found = resolveCourse(mine, query);
    if (found.status === "ambiguous") {
      return {
        reply: {
          error: `Several of the student's courses match "${query}". Ask which one they mean.`,
          candidates: found.candidates.map((c) => ({ code: c.code, title: c.title })),
        },
      };
    }
    if (found.status === "not_found") {
      return {
        reply: {
          error: `The student is not enrolled in a course matching "${query}". Check the enrolled list and ask if unsure.`,
        },
      };
    }
    const c = found.course;
    return { args: { course: c.code, title: c.title, code: c.publicCode ?? c.code } };
  }

  return { args };
}

/**
 * Runs one of the assistant's read-only tools. The assistant is not the student: its requests run
 * as "agent", so they only reach eClass pages that are never counted as a course visit, and course
 * pages (documents, files, assignment pages) only as the student last opened them in myClass.
 */
export function runReadOnlyTool(user: UserRecord, name: string, args: Record<string, unknown>): Promise<unknown> {
  return withOrigin("agent", () => runReadOnlyToolNow(user, name, args));
}

async function runReadOnlyToolNow(
  user: UserRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const connector = getConnectorForUser(user);
  /** Enrolled courses, but an eClass failure is reported instead of looking like "no courses". */
  const enrolledOrThrow = async () => {
    const { courses, warnings } = await connector.listCoursesDetailed();
    if (courses.length === 0 && warnings.length > 0) {
      throw new Error(`Could not read eClass: ${warnings.map((w) => `${w.portal}: ${w.message}`).join("; ")}`);
    }
    return courses;
  };
  switch (name) {
    case "list_courses": {
      const list = await enrolledOrThrow();
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
      if (!(typeof args.courseCode === "string" && args.courseCode)) await enrolledOrThrow();
      // Always the account-wide "my announcements" list, filtered here: a course's own announcements
      // page would count as a visit to that course in the student's eClass stats
      const wanted = typeof args.courseCode === "string" && args.courseCode ? args.courseCode.toUpperCase() : undefined;
      const list = (await connector.getAnnouncements()).filter((a) => !wanted || a.courseCode.toUpperCase() === wanted);
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
      if (!(typeof args.courseCode === "string" && args.courseCode)) await enrolledOrThrow();
      // The calendar feed: deadlines of every course without eClass logging a visit to any of them
      const wanted = typeof args.courseCode === "string" && args.courseCode ? args.courseCode.toUpperCase() : undefined;
      const list = withKnownSubmission(user, await connector.getDeadlines()).filter(
        (a) => !wanted || a.courseCode.toUpperCase() === wanted,
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
    const departmentId = typeof action.args.departmentId === "string" ? action.args.departmentId : undefined;
    const course = await connector.enrollCourse(String(action.args.course ?? ""), undefined, departmentId);
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
/* Gemini client (generateContent + function calling)                  */
/* ------------------------------------------------------------------ */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

interface GeminiAuth {
  /** "own" = the student's key, "server" = the shared myClass key. */
  source: "own" | "server";
  key: string;
}

type GeminiFailure = "no-key" | "bad-key" | "quota" | "empty" | "error";

class GeminiError extends Error {
  constructor(
    public reason: GeminiFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Keys to try, in order: the student's own key (when they chose it), then the shared server key. */
function geminiAuthCandidates(user: UserRecord): GeminiAuth[] {
  const out: GeminiAuth[] = [];
  if (user.settings.ai.mode === "apiKey" && user.ai.encApiKey) {
    try {
      out.push({ source: "own", key: decrypt(user.ai.encApiKey) });
    } catch {
      /* unreadable key – ignore */
    }
  }
  if (env.gemini.apiKey) out.push({ source: "server", key: env.gemini.apiKey });
  return out;
}

/** Usable models per key (keyed by a hash of the key), discovered with the ListModels API. */
const modelCache = new Map<string, { at: number; models: string[] }>();
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash"];
/** Models that just answered "overloaded" / "quota" are skipped for a while (a 503 can take ~30 s). */
const modelCooldown = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

const keyId = (auth: GeminiAuth) => sha256(auth.key).slice(0, 16);

async function modelsFor(auth: GeminiAuth, override?: string): Promise<string[]> {
  let entry = modelCache.get(keyId(auth));
  if (!entry || Date.now() - entry.at > MODEL_CACHE_TTL_MS) {
    let list = FALLBACK_MODELS;
    try {
      const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, {
        headers: { "x-goog-api-key": auth.key },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new GeminiError(
          "bad-key",
          `Gemini rejected the ${auth.source === "own" ? "personal" : "server"} API key (${res.status})`,
        );
      }
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
        };
        const ids = (data.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => String(m.name ?? "").replace(/^models\//, ""))
          .filter(Boolean);
        const ranked = rankGeminiModels(ids);
        if (ranked.length) list = ranked;
      }
    } catch (err) {
      if (err instanceof GeminiError) throw err;
      /* network problem – use the static fallbacks */
    }
    entry = { at: Date.now(), models: list };
    modelCache.set(keyId(auth), entry);
  }
  const preferred = override?.trim();
  return preferred ? [preferred, ...entry.models.filter((m) => m !== preferred)] : entry.models;
}

/**
 * Logs at startup whether the shared key works, so a missing or rejected GEMINI_API_KEY shows
 * in the host's logs instead of only as "AI isn't available" for students.
 */
export async function checkServerGeminiKey(): Promise<void> {
  if (!env.gemini.apiKey) {
    console.warn("[ai] GEMINI_API_KEY is not set: AI only works for students who add their own key");
    return;
  }
  try {
    const models = await modelsFor({ source: "server", key: env.gemini.apiKey });
    console.log(`[ai] shared Gemini key OK (first model: ${models[0] ?? "none"})`);
  } catch (err) {
    console.warn(`[ai] shared Gemini key does not work: ${(err as Error).message}`);
  }
}

function dropModel(auth: GeminiAuth, model: string) {
  const entry = modelCache.get(keyId(auth));
  if (entry) entry.models = entry.models.filter((m) => m !== model);
}

/** Within one assistant turn we stay on the key+model that answered first (thought signatures are model-bound). */
interface GeminiSession {
  auth?: GeminiAuth;
  model?: string;
}

/**
 * Calls generateContent, falling back across models (unknown model, quota, overload) and
 * keys (rejected personal key -> shared server key). Throws a GeminiError with the reason.
 */
async function geminiGenerate(
  user: UserRecord,
  bodyOrBuild: Record<string, unknown> | ((auth: GeminiAuth) => Promise<Record<string, unknown>>),
  session: GeminiSession = {},
): Promise<{ response: GeminiResponse; model: string }> {
  const auths = geminiAuthCandidates(user);
  if (auths.length === 0) throw new GeminiError("no-key", "No Gemini API key is configured");

  let lastReason: GeminiFailure = "error";
  let lastMessage = "Gemini did not answer";

  const current = session.auth;
  const ordered = current ? [current, ...auths.filter((a) => a.key !== current.key)] : auths;
  for (const auth of ordered) {
    let models: string[];
    try {
      models = await modelsFor(auth, user.settings.ai.model || env.gemini.model);
    } catch (err) {
      lastReason = err instanceof GeminiError ? err.reason : "error";
      lastMessage = (err as Error).message;
      continue;
    }
    if (session.model && current?.key === auth.key) {
      models = [session.model, ...models.filter((m) => m !== session.model)];
    }
    // A request with an uploaded file is built per key (Gemini files belong to the key that uploaded them)
    let body: Record<string, unknown>;
    try {
      body = typeof bodyOrBuild === "function" ? await bodyOrBuild(auth) : bodyOrBuild;
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      lastReason = err.reason;
      lastMessage = err.message;
      continue;
    }

    // Skip models that were overloaded a moment ago (unless every model is cooling down)
    const now = Date.now();
    const warm = models.filter((m) => (modelCooldown.get(`${keyId(auth)}|${m}`) ?? 0) <= now);
    for (const model of (warm.length ? warm : models).slice(0, 5)) {
      let res: Response;
      try {
        res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": auth.key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        modelCooldown.set(`${keyId(auth)}|${model}`, Date.now() + COOLDOWN_MS);
        lastReason = "error";
        lastMessage = `Gemini request failed: ${(err as Error).message}`;
        continue;
      }
      if (res.ok) {
        session.auth = auth;
        session.model = model;
        return { response: (await res.json()) as GeminiResponse, model };
      }

      const errText = (await res.text()).slice(0, 400);
      console.warn(`[gemini] ${model} (${auth.source} key) -> ${res.status}: ${errText.replace(/\s+/g, " ").slice(0, 200)}`);
      if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(errText)) {
        lastReason = "bad-key";
        lastMessage = `Gemini rejected the ${auth.source === "own" ? "personal" : "server"} API key`;
        break; // try the next key
      }
      if (res.status === 404 || /is not found|not supported for generateContent|is not available|no longer available/i.test(errText)) {
        dropModel(auth, model);
        lastReason = "error";
        lastMessage = `Model ${model} is not available`;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        modelCooldown.set(`${keyId(auth)}|${model}`, Date.now() + COOLDOWN_MS);
        lastReason = res.status === 429 ? "quota" : "error";
        lastMessage = `Gemini ${model} answered ${res.status}`;
        continue;
      }
      // Any other 400 is a problem with the request itself; another model would reject it too
      throw new GeminiError("error", `Gemini API (${res.status}): ${errText.slice(0, 240)}`);
    }
  }
  throw new GeminiError(lastReason, lastMessage);
}

function textOf(resp: GeminiResponse): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

function aiUnavailableText(lang: "el" | "en", reason: GeminiFailure, detail?: string): string {
  const el: Record<GeminiFailure, string> = {
    "no-key":
      "Το AI δεν είναι διαθέσιμο αυτή τη στιγμή. Μπορείς να βάλεις το δικό σου δωρεάν κλειδί Gemini στις Ρυθμίσεις.",
    "bad-key": /server/.test(detail ?? "")
      ? "Το AI δεν είναι διαθέσιμο αυτή τη στιγμή. Μπορείς να βάλεις το δικό σου δωρεάν κλειδί Gemini στις Ρυθμίσεις."
      : "Η Google δεν δέχτηκε το κλειδί Gemini. Έλεγξε το κλειδί στις Ρυθμίσεις.",
    quota: "Το όριο χρήσης του Gemini εξαντλήθηκε προσωρινά. Δοκίμασε ξανά σε λίγο.",
    empty: "Το Gemini δεν έδωσε απάντηση. Δοκίμασε να το διατυπώσεις λίγο διαφορετικά.",
    error: "Ο βοηθός AI δεν απάντησε αυτή τη φορά. Δοκίμασε ξανά σε λίγο.",
  };
  const en: Record<GeminiFailure, string> = {
    "no-key": "AI isn't available right now. You can add your own free Gemini key in Settings.",
    "bad-key": /server/.test(detail ?? "")
      ? "AI isn't available right now. You can add your own free Gemini key in Settings."
      : "Google did not accept the Gemini key. Check the key in Settings.",
    quota: "The Gemini usage limit was reached for now. Try again in a little while.",
    empty: "Gemini returned no answer. Try rephrasing the question.",
    error: "The AI assistant didn't answer this time. Try again shortly.",
  };
  const base = (lang === "el" ? el : en)[reason];
  return reason === "error" && detail ? `${base} (${detail})` : base;
}

/** Function declarations in the shape generateContent expects (no empty `properties`). */
const FUNCTION_DECLARATIONS = TOOLS.map(({ name, description, parameters }) =>
  Object.keys(parameters.properties).length ? { name, description, parameters } : { name, description },
);

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

/* Gemini file upload, for PDFs too big to send inline (18-50 MB) */

const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
/** Uploaded files live 48 h on Gemini's side; reuse them for a while per key and content. */
const uploadCache = new Map<string, { uri: string; at: number }>();
const UPLOAD_REUSE_MS = 36 * 60 * 60 * 1000;

async function uploadToGemini(auth: GeminiAuth, data: Buffer, mimeType: string, displayName: string): Promise<string> {
  const cacheKey = `${keyId(auth)}|${crypto.createHash("sha256").update(data).digest("hex")}`;
  const hit = uploadCache.get(cacheKey);
  if (hit && Date.now() - hit.at < UPLOAD_REUSE_MS) return hit.uri;

  const fail = (status: number, what: string): never => {
    throw new GeminiError(
      status === 401 || status === 403 ? "bad-key" : status === 429 ? "quota" : "error",
      `Gemini file upload ${what} (${status})`,
    );
  };
  const start = await fetch(UPLOAD_BASE, {
    method: "POST",
    headers: {
      "x-goog-api-key": auth.key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(data.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName.slice(0, 120) } }),
    signal: AbortSignal.timeout(30_000),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) fail(start.status, "could not start");
  const done = await fetch(uploadUrl!, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(180_000),
  });
  if (!done.ok) fail(done.status, "failed");
  let file = ((await done.json()) as { file?: { name?: string; uri?: string; state?: string } }).file;
  // PDFs are usually ready at once; wait up to a minute while Gemini processes larger ones
  for (let i = 0; file?.state === "PROCESSING" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${GEMINI_BASE}/${file.name}`, { headers: { "x-goog-api-key": auth.key } });
    if (res.ok) file = (await res.json()) as typeof file;
  }
  if (!file?.uri || file.state === "FAILED") throw new GeminiError("error", "Gemini could not process the uploaded file");
  uploadCache.set(cacheKey, { uri: file.uri, at: Date.now() });
  return file.uri;
}

/**
 * Downloads one course file and returns how to send it to Gemini: inline (PDF/image under
 * 18 MB), uploaded first (bigger PDFs), or as extracted text. Built per key because uploads are.
 */
async function documentParts(
  user: UserRecord,
  courseCode: string,
  path: string,
  instruction: (filename: string) => string,
): Promise<{ name: string; parts: (auth: GeminiAuth) => Promise<GeminiPart[]> }> {
  const connector = getConnectorForUser(user);
  // A copy the student fetched in the last hours will do: re-reading it on eClass would be one more visit
  const file = await connector.downloadFile(courseCode, path, { reuseOpened: true });
  const data = Buffer.isBuffer(file.body) ? file.body : Buffer.from(await streamToBuffer(file.body));
  const prepared = prepareDocumentForAi(file.filename, file.contentType, data, user.settings.language);
  if (prepared.kind === "unsupported") throw new Error(prepared.reason);
  const text = instruction(file.filename);
  if (prepared.kind === "upload") {
    return {
      name: file.filename,
      parts: async (auth) => [
        {
          fileData: {
            mimeType: prepared.mimeType,
            fileUri: await uploadToGemini(auth, prepared.data, prepared.mimeType, file.filename),
          },
        },
        { text },
      ],
    };
  }
  const parts: GeminiPart[] =
    prepared.kind === "inline"
      ? [{ inlineData: { mimeType: prepared.mimeType, data: prepared.data.toString("base64") } }, { text }]
      : [{ text: `${text}\n\n----- DOCUMENT TEXT -----\n${prepared.text || "(the file contains no extractable text)"}` }];
  return { name: file.filename, parts: async () => parts };
}

/** Gemini answered 400 about the request itself: for a file this means it could not read it. */
function documentErrorText(lang: "el" | "en", err: GeminiError): string {
  if (/token count exceeds/i.test(err.message)) {
    return lang === "el"
      ? "Το αρχείο είναι πολύ μεγάλο για το AI (πάρα πολλές σελίδες). Δοκίμασε ένα μικρότερο αρχείο του μαθήματος."
      : "The file is too long for the AI (too many pages). Try a smaller file from the course.";
  }
  if (err.reason === "error" && /\(400\)/.test(err.message)) {
    return lang === "el"
      ? "Το AI δεν μπόρεσε να διαβάσει αυτό το αρχείο (ίσως είναι κατεστραμμένο ή προστατευμένο)."
      : "The AI couldn't read this file (it may be damaged or protected).";
  }
  return aiUnavailableText(lang, err.reason, err.message);
}

/**
 * Summarizes (or answers `question` about) one document of a course. Used by the
 * "AI summary" button in Documents and by the assistant's `read_document` tool.
 * `countQuota` is set for the button; inside a chat turn the turn itself was counted.
 */
export async function summarizeCourseDocument(
  user: UserRecord,
  courseCode: string,
  path: string,
  opts: { question?: string; refresh?: boolean; countQuota?: boolean } = {},
): Promise<{ name: string; summary: string; cached: boolean }> {
  const lang = user.settings.language;
  const cacheKey = `${user.id}|${courseCode}|${path}|${lang}`;
  if (!opts.question && !opts.refresh) {
    const hit = summaryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return { name: hit.name, summary: hit.summary, cached: true };
  }

  if (geminiAuthCandidates(user).length === 0) throw new Error(aiUnavailableText(lang, "no-key"));
  const stamp = opts.countQuota ? consumeAiQuota(user) : null;

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

  let raw: string;
  let name: string;
  try {
    const doc = await documentParts(user, courseCode, path, (filename) =>
      opts.question ? `Document: "${filename}". Question: ${opts.question}` : `Summarize the document "${filename}".`,
    );
    name = doc.name;
    const { response } = await geminiGenerate(user, async (auth) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: await doc.parts(auth) }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }));
    raw = textOf(response);
  } catch (err) {
    refundAiQuota(user, stamp);
    if (!(err instanceof GeminiError)) throw err;
    throw new Error(documentErrorText(lang, err));
  }
  if (!raw) {
    refundAiQuota(user, stamp);
    throw new Error(aiUnavailableText(lang, "empty"));
  }
  const summary = cleanReadableAssistantText(raw);
  if (!opts.question) summaryCache.set(cacheKey, { at: Date.now(), summary, name });
  return { name, summary, cached: false };
}

/* ------------------------------------------------------------------ */
/* File search: which of a course's files match what the student asks  */
/* ------------------------------------------------------------------ */

export interface DocumentSearchHit {
  path: string;
  /** Why it matches, a few words in the student's language. */
  why: string;
}

/**
 * Ranks a course's files against a free-text question ("the lecture on usability", "lab 3
 * solutions"). The AI sees names, folders and dates, plus the AI summary of any file summarized
 * recently, never the files themselves, so a search costs one small AI request and no downloads.
 */
export async function searchCourseDocuments(
  user: UserRecord,
  courseCode: string,
  query: string,
  files: Array<{ path: string; name: string; folder: string; date?: string }>,
): Promise<DocumentSearchHit[]> {
  const lang = user.settings.language;
  if (files.length === 0) return [];
  if (geminiAuthCandidates(user).length === 0) throw new Error(aiUnavailableText(lang, "no-key"));
  const stamp = consumeAiQuota(user);

  const list = files.slice(0, 600).map((f, i) => {
    const summary = summaryCache.get(`${user.id}|${courseCode}|${f.path}|${lang}`);
    return {
      i,
      name: f.name,
      ...(f.folder ? { folder: f.folder } : {}),
      ...(f.date ? { date: f.date } : {}),
      ...(summary ? { summary: summary.summary.replace(/\s+/g, " ").slice(0, 400) } : {}),
    };
  });
  try {
    const { response } = await geminiGenerate(user, {
      systemInstruction: {
        parts: [
          {
            text:
              "You find files in a university course's document folder for a student. You get the files (name, folder, date, " +
              "sometimes a summary) and what the student is looking for. Match meaning, not just words: Greek and English, " +
              'abbreviations and numbering ("εργαστήριο 3" = "Lab3", "διάλεξη" = "lecture", "λύσεις" = "solutions"), topics a ' +
              "lecture title implies. Return only files that plausibly match, best first, at most 8; none if nothing fits. " +
              `For each give "why": max 8 words in ${lang === "el" ? "Greek" : "English"}, what in it matches. ` +
              'Answer with JSON only: {"results":[{"i":0,"why":"..."}]}.',
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ query, files: list }) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" },
    });
    const parsed = parseJsonLoose(textOf(response)) as { results?: Array<{ i?: number; why?: string }> };
    const seen = new Set<number>();
    const hits: DocumentSearchHit[] = [];
    for (const r of parsed.results ?? []) {
      if (typeof r.i !== "number" || !files[r.i] || seen.has(r.i)) continue;
      seen.add(r.i);
      hits.push({ path: files[r.i].path, why: typeof r.why === "string" ? r.why.trim().slice(0, 80) : "" });
      if (hits.length >= 8) break;
    }
    return hits;
  } catch (err) {
    refundAiQuota(user, stamp);
    if (err instanceof GeminiError) throw new Error(aiUnavailableText(lang, err.reason));
    throw new Error(
      lang === "el" ? "Η αναζήτηση δεν ολοκληρώθηκε. Δοκίμασε ξανά." : "The search didn't finish. Try again.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Study material: flashcards, quiz, exam-style questions              */
/* ------------------------------------------------------------------ */

const studyCache = new Map<string, { at: number; material: StudyMaterial }>();

/** Pulls the first JSON object/array out of a model answer (tolerates ```json fences and stray text). */
export function parseJsonLoose(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start < 0 || end <= start) throw new Error("No JSON in the answer");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validates and trims what the model returned into the shape the app renders. */
export function normalizeStudyMaterial(kind: StudyKind, name: string, data: unknown): StudyMaterial {
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const list = (key: string): Record<string, unknown>[] => {
    const v = Array.isArray(data) ? data : obj[key];
    return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  };
  if (kind === "flashcards") {
    const cards: Flashcard[] = list("cards")
      .map((c) => ({ front: clip(c.front, 300), back: clip(c.back, 800) }))
      .filter((c) => c.front && c.back)
      .slice(0, 20);
    if (!cards.length) throw new Error("No flashcards in the answer");
    return { kind, name, cards };
  }
  if (kind === "quiz") {
    const questions: QuizQuestion[] = list("questions")
      .map((q) => ({
        question: clip(q.question, 600),
        options: Array.isArray(q.options) ? q.options.map((o) => clip(o, 300)).filter(Boolean).slice(0, 5) : [],
        answer: Number(q.answer),
        explanation: clip(q.explanation, 600),
      }))
      .filter((q) => q.question && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
      .slice(0, 15);
    if (!questions.length) throw new Error("No quiz questions in the answer");
    return { kind, name, questions };
  }
  const questions: ExamQuestion[] = list("questions")
    .map((q) => ({
      question: clip(q.question, 1200),
      points: Math.max(0, Math.round(Number(q.points) || 0)),
      modelAnswer: clip(q.modelAnswer, 3000),
    }))
    .filter((q) => q.question && q.modelAnswer)
    .slice(0, 8);
  if (!questions.length) throw new Error("No exam questions in the answer");
  return { kind, name, questions };
}

const STUDY_PROMPTS: Record<StudyKind, string> = {
  flashcards:
    "Make 12 flashcards covering the most important definitions, concepts, formulas and results of the document. " +
    'Return JSON: {"cards":[{"front":"short question or term","back":"concise answer, max 2 sentences"}]}.',
  quiz:
    "Make an 8-question multiple-choice quiz that checks real understanding of the document (not trivia about the file). " +
    "Each question has 4 options, exactly one correct, with plausible distractors. Vary the position of the correct option. " +
    'Return JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"why the answer is right, 1-2 sentences"}]} ' +
    'where "answer" is the 0-based index of the correct option.',
  exam:
    "Make 5 exam-style practice questions like a university professor would set on this material: a mix of definitions/theory, " +
    "a worked problem or exercise if the material allows, and one question that connects ideas. Give each a point value so the set totals 100, " +
    "and a model answer a grader would accept (step by step for problems). " +
    'Return JSON: {"questions":[{"question":"...","points":20,"modelAnswer":"..."}]}.',
};

export async function generateStudyMaterial(
  user: UserRecord,
  courseCode: string,
  path: string,
  kind: StudyKind,
  opts: { refresh?: boolean } = {},
): Promise<StudyMaterial> {
  const lang = user.settings.language;
  const cacheKey = `${user.id}|${courseCode}|${path}|${kind}|${lang}`;
  if (!opts.refresh) {
    const hit = studyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return { ...hit.material, cached: true };
  }
  if (geminiAuthCandidates(user).length === 0) throw new Error(aiUnavailableText(lang, "no-key"));
  const stamp = consumeAiQuota(user);

  const system =
    `You create study material for a university student from their course file. Write all text in ${lang === "el" ? "Greek" : "English"} ` +
    "(keep technical terms, code and formulas as in the document). Use ONLY what the document teaches. " +
    "Formulas in readable plain text (no LaTeX). Answer with JSON only, no prose around it.";
  try {
    const doc = await documentParts(user, courseCode, path, (filename) => `Document: "${filename}". ${STUDY_PROMPTS[kind]}`);
    const { response } = await geminiGenerate(user, async (auth) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: await doc.parts(auth) }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: "application/json" },
    }));
    const raw = textOf(response);
    if (!raw) throw new GeminiError("empty", "Empty answer");
    const material = normalizeStudyMaterial(kind, doc.name, parseJsonLoose(raw));
    studyCache.set(cacheKey, { at: Date.now(), material });
    return material;
  } catch (err) {
    refundAiQuota(user, stamp);
    if (err instanceof GeminiError) throw new Error(documentErrorText(lang, err));
    if (err instanceof SyntaxError || /JSON|^No (flashcards|quiz|exam)/.test((err as Error).message)) {
      throw new Error(
        lang === "el"
          ? "Το AI δεν επέστρεψε σωστό σετ αυτή τη φορά. Δοκίμασε ξανά."
          : "The AI didn't return a usable set this time. Try again.",
      );
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Announcement triage: "action needed" vs "FYI"                       */
/* ------------------------------------------------------------------ */

const ACTION_PATTERNS = [
  /προθεσμ/i,
  /υποβολ|υποβάλ/i,
  /παράδοσ|παραδοτ/i,
  /δήλωσ|δηλώσ/i,
  /εγγραφ/i,
  /υποχρεωτικ/i,
  /να (?:φέρετε|στείλετε|συμπληρώσετε|δηλώσετε|ανεβάσετε|εγγραφείτε|παρουσιαστείτε)/i,
  /\bdeadline\b/i,
  /\bsubmi(?:t|ssion)\b/i,
  /\bdue\b/i,
  /\bregist(?:er|ration)\b/i,
  /\bmandatory\b/i,
  /\bsign[ -]?up\b/i,
  // Changes to when or where class happens
  /αλλαγ[ήη] (?:αίθουσας|ώρας|ημερομηνίας)/i,
  /ακύρωσ|ακυρών|ακυρώ/i,
  /αναβολ|αναβάλλ/i,
  /\bcancell?ed\b/i,
  /\brescheduled?\b/i,
  /\broom change\b/i,
];

/** Keyword fallback when the AI is unavailable: deadlines, submissions, registrations, or a class moved/cancelled. */
export function heuristicTriage(a: Pick<Announcement, "title" | "contentText">): AnnouncementTriage {
  const text = `${a.title}\n${a.contentText}`;
  return { label: ACTION_PATTERNS.some((r) => r.test(text)) ? "action" : "fyi" };
}

const TRIAGE_BATCH = 40;
const TRIAGE_KEEP = 600;
/** After a failed AI triage call, keywords answer for a while before Gemini is asked again. */
const TRIAGE_RETRY_MS = 10 * 60 * 1000;
const triageRetryAt = new Map<string, number>();
const triageInFlight = new Map<string, Promise<unknown>>();

/**
 * Classifies announcements once each (results are kept on the user record). New ones go to
 * Gemini in one batched call (title + the start of the text, ~150 tokens each); without a key,
 * or if the call fails, keywords decide for now and the AI gets another go later.
 * Background work: not counted against the student's hourly quota.
 */
export async function triageAnnouncements(
  user: UserRecord,
  announcements: Announcement[],
): Promise<Record<string, AnnouncementTriage>> {
  const known = user.triage ?? {};
  const out: Record<string, AnnouncementTriage> = {};
  const fresh: Announcement[] = [];
  for (const a of announcements) {
    const hit = known[a.id];
    if (hit) out[a.id] = hit.reason ? { label: hit.label, reason: hit.reason } : { label: hit.label };
    else fresh.push(a);
  }
  if (!fresh.length) return out;

  // One AI call per student at a time: a second caller waits, then reuses what the first stored
  const running = triageInFlight.get(user.id);
  if (running) {
    await running.catch(() => undefined);
    return triageAnnouncements(users.get(user.id) ?? user, announcements);
  }
  const job = triageFresh(user, fresh, out);
  triageInFlight.set(user.id, job);
  try {
    return await job;
  } finally {
    triageInFlight.delete(user.id);
  }
}

async function triageFresh(
  user: UserRecord,
  fresh: Announcement[],
  out: Record<string, AnnouncementTriage>,
): Promise<Record<string, AnnouncementTriage>> {
  // Newest first, so the ones on screen are classified by the AI
  const batch = [...fresh].sort((x, y) => y.date.localeCompare(x.date)).slice(0, TRIAGE_BATCH);
  const fromAi: Record<string, AnnouncementTriage> = {};
  if (geminiAuthCandidates(user).length > 0 && (triageRetryAt.get(user.id) ?? 0) <= Date.now()) {
    const lang = user.settings.language;
    const items = batch.map((a, i) => ({
      i,
      course: a.courseTitle ?? a.courseCode,
      date: a.date.slice(0, 10),
      title: a.title.slice(0, 200),
      text: a.contentText.replace(/\s+/g, " ").slice(0, 500),
    }));
    try {
      const { response } = await geminiGenerate(user, {
        systemInstruction: {
          parts: [
            {
              text:
                `You sort university course announcements for a student. Today is ${new Date().toISOString().slice(0, 10)}. ` +
                '"action" = the student must do something or change plans: submit or upload work, register or declare something, a deadline, ' +
                "bring or prepare something, attend a mandatory, moved or cancelled session, an exam date or room, reply to the professor. " +
                '"fyi" = information only: material uploaded, grades posted with nothing to do, general news, greetings. ' +
                `For "action" add "reason": what to do and by when, max 6 words, in ${lang === "el" ? "Greek" : "English"} ` +
                `(e.g. "${lang === "el" ? "Υποβολή εργασίας έως 25/11" : "Submit project by 25/11"}"). ` +
                'Answer with JSON only: {"items":[{"i":0,"label":"action","reason":"..."},{"i":1,"label":"fyi"}]}.',
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(items) }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json" },
      });
      const parsed = parseJsonLoose(textOf(response)) as { items?: Array<{ i?: number; label?: string; reason?: string }> };
      for (const r of parsed.items ?? []) {
        const a = typeof r.i === "number" ? batch[r.i] : undefined;
        if (!a || (r.label !== "action" && r.label !== "fyi")) continue;
        const reason = r.label === "action" && typeof r.reason === "string" ? r.reason.trim().slice(0, 60) : "";
        fromAi[a.id] = reason ? { label: r.label, reason } : { label: r.label };
      }
    } catch (err) {
      triageRetryAt.set(user.id, Date.now() + TRIAGE_RETRY_MS);
      console.warn("[triage] Gemini failed, using keywords for now:", (err as Error).message);
    }
  }

  users.update(user.id, (u) => {
    const map = (u.triage ??= {});
    const now = Date.now();
    for (const [id, t] of Object.entries(fromAi)) map[id] = { ...t, at: now };
    // Without any AI key the keywords are the final answer
    if (geminiAuthCandidates(user).length === 0) {
      for (const a of batch) map[a.id] ??= { ...heuristicTriage(a), at: now };
    }
    const ids = Object.keys(map);
    if (ids.length > TRIAGE_KEEP) {
      ids.sort((x, y) => map[x].at - map[y].at);
      for (const id of ids.slice(0, ids.length - TRIAGE_KEEP)) delete map[id];
    }
  });
  for (const a of fresh) out[a.id] = fromAi[a.id] ?? heuristicTriage(a);
  return out;
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
  const dept = UNIPI_DEPARTMENTS.find((d) => d.id === userDepartmentId(user));
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
    "You are myClass, the study assistant inside an app that brings a University of Piraeus (Πανεπιστήμιο Πειραιώς) student's Open eClass into one place.",
    "",
    "CONTEXT",
    `- Now: ${now} (Europe/Athens). Academic year ${acadYear.label}.`,
    `- Student: ${user.displayName} (username ${user.username})${dept ? `, ${dept.nameEn} / ${dept.name} (department id ${dept.id})` : ""}.`,
    "- eClass portals: eclass.unipi.gr (all departments), thales.cs.unipi.gr (Informatics), aristarchus.ds.unipi.gr (Digital Systems undergraduate) and lefkippos.ds.unipi.gr (Digital Systems MSc).",
    "- Enrolled courses (code — title — professor — semester):",
    courseLines,
    "- The app has: Home (calendar with all deadlines), Courses (documents with an 'AI summary' button, announcements, assignments with file upload/submission, every other eClass tool), Messages, Assistant (you), Settings.",
    "",
    "HOW TO WORK",
    "- Get facts with tools. Never invent courses, dates, grades, files, rooms or professors. If a tool returns nothing or fails, say so in one sentence and suggest the next step.",
    "- Match course names loosely: Greek or English, with/without accents, abbreviations and nicknames (e.g. 'ΒΔ' = Βάσεις Δεδομένων, 'OOP' = Αντικειμενοστρεφής Προγραμματισμός). Prefer the enrolled list above; use search_catalog only for courses not in it (pass departmentId for another department).",
    "- Deadlines / 'what do I have this week': call get_deadlines (optionally with courseCode). Show upcoming, unsubmitted items first, sorted by date, with days left. Mention overdue or already-submitted items only if relevant.",
    "- Questions about what a file, lecture, exercise sheet or project brief says: call list_documents for the course (open sub-folders if needed), pick the best-matching file, then call read_document with the student's question. Answer from that content and name the file you used.",
    "- Assignment questions ('what does project 2 ask', 'can I still submit'): get_deadlines, then get_assignment_details.",
    "- You never open course pages yourself: eClass would count each one as the student's visit. list_documents, read_document and get_assignment_details only see what the student opened in myClass in the last few hours (a course's Documents, a file's AI summary or download, an assignment). When a tool says something was not opened yet, tell the student exactly what to open in myClass (Courses → course → Documents / the file / the assignment) and to ask again; get_deadlines, get_announcements and get_messages always work.",
    "- Never guess a course code: use only codes from the enrolled list above or from a tool result.",
    "- Joining a course: call enroll_course with the course's title as the student said it (or a code from search_catalog); the server finds it in the catalog. If it answers with candidates, ask the student which one (list them); if nothing matches, try search_catalog with a shorter keyword or another departmentId before giving up. Leaving a course or archiving a semester: call unenroll_course / archive_semester. The app shows the student a confirmation card, so don't ask 'are you sure?' yourself.",
    "- Uploading/submitting work is done in the app (Courses → course → Assignments → Submit); you cannot attach files yourself, but you can check requirements and status.",
    "- If a request is ambiguous (e.g. two courses or files match), ask ONE short question that lists the options. If it's clear, act without asking.",
    "- Only use items from the current academic year unless the student explicitly asks about older ones.",
    "- Overviews ('what's new', 'what do I have today', 'summarize my week'): combine get_announcements, get_deadlines and get_messages as needed.",
    "- For general study help (explain a concept, make a study plan, quiz me), answer directly from your knowledge; use course files when the student refers to their course material.",
    "",
    "STYLE",
    "- Reply in the student's language (Greek or English) and match their tone. Be concise: answer first, details after. No filler, no repeating the question.",
    "- Plain text, short paragraphs, '• ' bullets. Use **bold** only for key names, dates and numbers. No headings, tables, emojis, LaTeX or code blocks (unless the student asks for code).",
    "- Dates like 'Παρ 21 Νοε, 23:59' in Greek or 'Fri 21 Nov, 23:59' in English. Times are Europe/Athens.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main chat turn orchestrator                                         */
/* ------------------------------------------------------------------ */

/** One chat turn. Everything it asks eClass for is the assistant's doing ("agent"), not the student's. */
export function runAssistantTurn(
  user: UserRecord,
  userMessageText: string,
  emit: (ev: ChatStreamEvent) => void,
): Promise<ChatMessage> {
  return withOrigin("agent", () => runAssistantTurnNow(user, userMessageText, emit));
}

async function runAssistantTurnNow(
  user: UserRecord,
  userMessageText: string,
  emit: (ev: ChatStreamEvent) => void,
): Promise<ChatMessage> {
  const lang = user.settings.language;
  // Earlier turns as plain text (tool calls/results stay inside the turn that made them).
  // The last five exchanges are enough context and keep every request's input small.
  const priorTurns: GeminiContent[] = user.chat.messages
    .filter((m) => m.text.trim())
    .slice(-10)
    .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] }));
  while (priorTurns.length && priorTurns[0].role !== "user") priorTurns.shift();

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
  let stamp: number | null = null;

  try {
    // Limit on the shared key; throws AiQuotaError (answered below without calling Gemini)
    stamp = consumeAiQuota(user);
    const systemInstruction = await buildSystemInstruction(user);
    const contents: GeminiContent[] = [...priorTurns, { role: "user", parts: [{ text: userMessageText }] }];
    const session: GeminiSession = {};

    const MAX_ROUNDS = 8;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const lastRound = round === MAX_ROUNDS - 1;
      const { response } = await geminiGenerate(
        user,
        {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: lastRound ? "NONE" : "AUTO" } },
          generationConfig: { temperature: 0.4 },
        },
        session,
      );

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall?.name);
      // Keep the model turn verbatim (it carries thought signatures the next call needs)
      if (parts.length) contents.push({ role: "model", parts });

      if (calls.length === 0) {
        finalText = textOf(response);
        break;
      }

      const results: GeminiPart[] = [];
      for (const part of calls) {
        const fc = part.functionCall!;
        const args = fc.args ?? {};
        toolsUsed.push(fc.name);
        emit({ type: "tool", name: fc.name });

        if (MUTATING_TOOLS.has(fc.name)) {
          let prepared: Awaited<ReturnType<typeof prepareMutatingAction>>;
          try {
            prepared = await prepareMutatingAction(getConnectorForUser(user), fc.name, args);
          } catch (prepErr) {
            prepared = { reply: { error: `Could not check the course on eClass: ${(prepErr as Error).message}` } };
          }
          emit({ type: "tool_done", name: fc.name, ...summarizeToolResult("reply" in prepared ? prepared.reply : prepared.args) });
          if ("reply" in prepared) {
            // No card for a course that can't be joined/left: the assistant gets the reason instead
            results.push({
              functionResponse: {
                ...(fc.id ? { id: fc.id } : {}),
                name: fc.name,
                response: { content: truncateJson(prepared.reply) },
              },
            });
            continue;
          }
          const action: PendingAction = {
            id: randomId(8),
            tool: fc.name,
            args: prepared.args,
            summary: describePendingAction(fc.name, prepared.args, lang),
            status: "pending",
          };
          pendingAction = action;
          emit({ type: "action", action });
          users.update(user.id, (u) => {
            u.chat.pending[action.id] = { action, callId: fc.id ?? action.id };
          });
          break;
        }

        let toolResult: unknown;
        try {
          toolResult = await runReadOnlyTool(user, fc.name, args);
        } catch (toolErr) {
          // Let the model explain the failure instead of aborting the whole answer
          toolResult = { error: (toolErr as Error).message || "Tool failed" };
        }
        emit({ type: "tool_done", name: fc.name, ...summarizeToolResult(toolResult) });
        results.push({
          functionResponse: {
            ...(fc.id ? { id: fc.id } : {}),
            name: fc.name,
            response: { content: truncateJson(toolResult) },
          },
        });
      }

      if (pendingAction) {
        finalText =
          textOf(response) ||
          (lang === "el"
            ? `Ετοίμασα την ενέργεια: **${pendingAction.summary}**. Πάτησε **Επιβεβαίωση** για να εκτελεστεί.`
            : `I prepared the action: **${pendingAction.summary}**. Click **Confirm** to run it.`);
        break;
      }
      contents.push({ role: "user", parts: results });
    }

    if (!finalText.trim() && !pendingAction) finalText = aiUnavailableText(lang, "empty");
  } catch (err) {
    if (err instanceof AiQuotaError) {
      finalText = err.message;
    } else {
      console.warn("[assistant] Gemini failed:", (err as Error).message);
      // A turn Gemini never answered does not count against the hour
      if (!toolsUsed.length) refundAiQuota(user, stamp);
      finalText = aiUnavailableText(lang, err instanceof GeminiError ? err.reason : "error", (err as Error).message);
    }
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
    u.chat.history = [];
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
