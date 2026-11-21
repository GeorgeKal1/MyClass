import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Universities & Departments                                          */
/* ------------------------------------------------------------------ */

export type AuthKind = "cas" | "native";

export interface University {
  id: string;
  name: string; // Greek name
  nameEn: string;
  eclassUrl: string; // base URL, no trailing slash
  auth: AuthKind;
  /** Connector maturity – lets the UI warn users. */
  status: "verified" | "beta" | "untested";
}

export interface DepartmentInfo {
  id: string;
  name: string;
  nameEn: string;
  portalLabel?: string;
}

/* ------------------------------------------------------------------ */
/* eClass domain                                                       */
/* ------------------------------------------------------------------ */

export interface Course {
  code: string;
  title: string;
  publicCode?: string;
  professor?: string;
  /** Numeric eClass course id (needed for unenroll). */
  numericId?: number;
  /** Official or user-assigned semester label (e.g. "Α' Εξάμηνο", "Ε' Εξάμηνο"). */
  semester?: string;
  /** Numeric semester index (1..8 for Α'–Η' Εξάμηνο, 9 general/other, 10 electives pool, 11 postgraduate). */
  semesterIndex?: number;
  /** Folder-safe semester label (e.g. "Α_εξάμηνο" .. "Η_Εξάμηνο"). */
  semesterFolder?: string;
  departmentId?: string;
  departmentName?: string;
  /** Source eClass portal host (e.g. "thales.cs.unipi.gr" or "eclass.unipi.gr"). */
  portal?: string;
  url?: string;
  enrolled?: boolean;
  locked?: boolean;
  /** Joining needs the course's registration code. */
  needsPassword?: boolean;
  archived?: boolean;
  color?: string;
}

export interface Announcement {
  id: string;
  courseCode: string;
  courseTitle?: string;
  title: string;
  contentHtml: string;
  contentText: string;
  date: string; // ISO
  url?: string;
}

export interface Attachment {
  name: string;
  url: string;
}

export interface Message {
  id: string;
  subject: string;
  sender: string;
  date: string; // ISO
  courseCode?: string;
  courseTitle?: string;
  read: boolean;
  preview?: string;
  bodyHtml?: string;
  attachments?: Attachment[];
}

export interface DocNode {
  /** Path inside the course document area, e.g. "/5f1a2b3c" */
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
  date?: string;
  downloadUrl?: string;
}

export interface Assignment {
  id: string;
  courseCode: string;
  courseTitle?: string;
  title: string;
  deadline?: string; // ISO
  submitted: boolean;
  /** False when the state is just not known: deadlines from the calendar feed carry no hand-in state. */
  submissionKnown?: boolean;
  grade?: string;
  url?: string;
}

/** A tool/module enabled in a course on eClass (documents, assignments, forum, quizzes, …). */
export interface CourseTool {
  id: string;
  name: string;
  /** Absolute URL of the tool on the eClass portal. */
  url: string;
  /** True when myClass shows this tool natively (the rest open on eClass). */
  native: boolean;
}

export interface AssignmentDetail {
  id: string;
  courseCode: string;
  title: string;
  descriptionHtml: string;
  deadline?: string;
  submitted: boolean;
  grade?: string;
  attachments: Attachment[];
  canSubmit: boolean;
  submissionType: "file" | "text" | "none";
  maxFiles: number;
  existingSubmission?: string;
  url?: string;
}

export interface SubmissionResult {
  ok: boolean;
  message: string;
}

export interface DocumentSummary {
  path: string;
  name: string;
  summary: string;
  createdAt: string;
  cached?: boolean;
}

/** Non-fatal problems while loading data from one eClass portal (shown instead of a silent empty list). */
export interface PortalWarning {
  portal: string;
  message: string;
}

/** The student's own eClass usage ("Τα στατιστικά μου"), merged across their portals. */
export interface MyStats {
  /** Period covered, as YYYY-MM-DD (the last twelve months). */
  from: string;
  to: string;
  totals: {
    visits: number;
    seconds: number;
    activeDays: number;
    courses: number;
  };
  /** Last 30 days against the 30 days before them. */
  recent: { visits: number; seconds: number; prevVisits: number; prevSeconds: number };
  /** Twelve calendar months, oldest first, `month` as YYYY-MM (empty months included). */
  months: Array<{ month: string; visits: number; seconds: number }>;
  /** Courses by time spent, most first. */
  courses: Array<{ title: string; code?: string; visits: number; seconds: number; lastDay: string }>;
  /** eClass tools (Documents, Announcements, …) by visits, most first. */
  tools: Array<{ name: string; visits: number; seconds: number }>;
  /** Visits per weekday, Monday first. */
  weekdays: number[];
  warnings?: PortalWarning[];
  /**
   * Present when myClass' own background checks were taken out of eClass' log, or could not be.
   * `visits` is exact, `seconds` an estimate (net of time given back to the student's visits).
   */
  adjustment?: {
    visits: number;
    seconds: number;
    /** YYYY-MM-DD: days before this still include background checks (recorded before myClass kept count). */
    uncorrectedBefore?: string;
  };
}

export interface CatalogCourse {
  code: string;
  publicCode?: string;
  title: string;
  professor?: string;
  numericId?: number;
  enrolled: boolean;
  /** Registration is closed on eClass (no way to join from here). */
  locked?: boolean;
  /** Joining needs the course's registration code, given by the teacher. */
  needsPassword?: boolean;
  /** Official semester label (e.g. "Α' Εξάμηνο" .. "Η' Εξάμηνο"). */
  semester?: string;
  /** Numeric semester index (1..8 for Α'–Η' Εξάμηνο, 9 general/other, 10 electives pool, 11 postgraduate). */
  semesterIndex?: number;
  /** Folder-safe semester name (e.g. "Α_εξάμηνο", "Β_εξάμηνο", "Γ_εξάμηνο", "Δ_Εξάμηνο", "Ε_Εξάμηνο", etc.). */
  semesterFolder?: string;
  departmentId?: string;
  departmentName?: string;
  portal?: string;
  url?: string;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export type NotificationKind = "announcement" | "message" | "assignment" | "deadline" | "system";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  courseCode?: string;
  courseTitle?: string;
  date: string;
  read: boolean;
  /** Link inside myClass, e.g. /courses/ABC101?tab=announcements */
  route?: string;
  /** Announcements only: whether the student has to do something. */
  triage?: TriageLabel;
}

/* ------------------------------------------------------------------ */
/* Announcement triage                                                 */
/* ------------------------------------------------------------------ */

/** "action": the student has to do something (submit, register, show up, reply). "fyi": just information. */
export type TriageLabel = "action" | "fyi";

export interface AnnouncementTriage {
  label: TriageLabel;
  /** A few words on what to do, e.g. "Υποβολή έως 25/11" (action items only). */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Study material (generated from one course file)                     */
/* ------------------------------------------------------------------ */

export type StudyKind = "flashcards" | "quiz" | "exam";

export interface Flashcard {
  front: string;
  back: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  /** Index into `options`. */
  answer: number;
  explanation: string;
}

export interface ExamQuestion {
  question: string;
  /** Suggested marks out of 100 for the whole set. */
  points: number;
  modelAnswer: string;
}

export type StudyMaterial =
  | { kind: "flashcards"; name: string; cards: Flashcard[]; cached?: boolean }
  | { kind: "quiz"; name: string; questions: QuizQuestion[]; cached?: boolean }
  | { kind: "exam"; name: string; questions: ExamQuestion[]; cached?: boolean };

export const TriageRequest = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(200),
        courseCode: z.string().max(100),
        courseTitle: z.string().max(300).optional(),
        title: z.string().max(500),
        contentText: z.string().max(600),
        date: z.string().max(40),
      }),
    )
    .max(100),
});

export const StudyRequest = z.object({
  path: z.string().min(1).max(2000),
  kind: z.enum(["flashcards", "quiz", "exam"]),
  refresh: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* User / settings                                                     */
/* ------------------------------------------------------------------ */

export type ThemePref = "light" | "dark" | "system";
export type Lang = "el" | "en";
/** "server": the shared myClass Gemini key; "apiKey": the student's own Gemini key. */
export type AiMode = "server" | "apiKey";

export interface UserSettings {
  theme: ThemePref;
  language: Lang;
  pollIntervalMin: number;
  notify: {
    announcements: boolean;
    messages: boolean;
    assignments: boolean;
    /** Push reminders 24 h and 1 h before an unsubmitted assignment is due. */
    deadlines: boolean;
    push: boolean;
  };
  accessibility: {
    /** Text size multiplier: 0.9, 1, 1.15 or 1.3. */
    fontScale: number;
    /** "system" follows the device's reduced-motion setting. */
    reduceMotion: "system" | "on" | "off";
  };
  mutedCourses: string[];
  /** Courses pinned to the top of the Courses list (course codes, in pin order). */
  pinnedCourses?: string[];
  downloads: {
    /** How "download all courses" packages files. */
    allCoursesMode: "single-zip" | "zip-per-course";
  };
  ai: {
    mode: AiMode;
    /** Optional Gemini model override; empty = the server picks the best available Flash model. */
    model: string;
  };
  /** University of Piraeus department whose catalog "All courses" shows (empty = detected from the username). */
  departmentId?: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  language: "el",
  pollIntervalMin: 15,
  notify: { announcements: true, messages: true, assignments: true, deadlines: true, push: false },
  accessibility: { fontScale: 1, reduceMotion: "on" },
  mutedCourses: [],
  downloads: { allCoursesMode: "single-zip" },
  ai: { mode: "server", model: "" },
};

export interface Me {
  id: string;
  universityId: string;
  universityName: string;
  departmentId?: string;
  departmentName?: string;
  username: string;
  displayName: string;
  rememberCredentials: boolean;
  settings: UserSettings;
  ai: {
    hasApiKey: boolean;
    serverKeyAvailable: boolean;
    /** Hourly limit on the shared key; null when the student uses their own key (no limit). */
    quota: AiQuota | null;
  };
  /** Private iCalendar feed of deadlines (for a phone calendar and its home-screen widget), when turned on. */
  calendarFeedUrl?: string;
}

export interface AiQuota {
  limit: number;
  used: number;
  /** ISO time the oldest counted request leaves the one-hour window (when used > 0). */
  resetAt?: string;
}

/* ------------------------------------------------------------------ */
/* Chat / AI                                                           */
/* ------------------------------------------------------------------ */

export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "done" | "failed";

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: PendingActionStatus;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  action?: PendingAction;
  /** Tools the assistant used to build this answer (for transparency). */
  toolsUsed?: string[];
}

/** Server-sent events from POST /api/chat */
export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "action"; action: PendingAction }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: string };

/* ------------------------------------------------------------------ */
/* API request schemas                                                 */
/* ------------------------------------------------------------------ */

export const LoginRequest = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  remember: z.boolean().default(true),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SettingsPatch = z
  .object({
    theme: z.enum(["light", "dark", "system"]),
    language: z.enum(["el", "en"]),
    pollIntervalMin: z.number().int().min(5).max(240),
    notify: z
      .object({
        announcements: z.boolean(),
        messages: z.boolean(),
        assignments: z.boolean(),
        deadlines: z.boolean(),
        push: z.boolean(),
      })
      .partial(),
    accessibility: z
      .object({
        fontScale: z.union([z.literal(0.9), z.literal(1), z.literal(1.15), z.literal(1.3)]),
        reduceMotion: z.enum(["system", "on", "off"]),
      })
      .partial(),
    mutedCourses: z.array(z.string()),
    pinnedCourses: z.array(z.string().max(60)).max(60),
    downloads: z.object({ allCoursesMode: z.enum(["single-zip", "zip-per-course"]) }),
    ai: z.object({ mode: z.enum(["server", "apiKey"]), model: z.string().max(80).optional().default("") }),
    departmentId: z.string().max(20),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const ChatRequest = z.object({
  message: z.string().min(1).max(4000),
});

export const ActionDecision = z.object({
  actionId: z.string(),
  decision: z.enum(["confirm", "cancel"]),
});

export const DocumentSummaryRequest = z.object({
  path: z.string().min(1).max(2000),
  refresh: z.boolean().optional(),
});

export const CourseMetaPatch = z.object({
  semester: z.string().max(60).optional(),
  archived: z.boolean().optional(),
});
