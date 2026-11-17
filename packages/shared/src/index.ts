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

/**
 * Best-effort university detection from a CAS username or institutional e-mail.
 * Returns `null` when the username does not clearly belong to one university,
 * so the user is asked to choose instead of being sent to the wrong eClass.
 * Shared by the login form (preview) and the server (login).
 */
const UNIVERSITY_EMAIL_DOMAINS: Array<[string, string[]]> = [
  ["unipi", ["unipi.gr"]],
  ["uoa", ["uoa.gr"]],
  ["ntua", ["ntua.gr"]],
  ["aueb", ["aueb.gr"]],
  ["uniwa", ["uniwa.gr"]],
  ["panteion", ["panteion.gr"]],
  ["hua", ["hua.gr"]],
  ["uom", ["uom.edu.gr", "uom.gr"]],
  ["upatras", ["upatras.gr", "upnet.gr"]],
  ["duth", ["duth.gr"]],
  ["uth", ["uth.gr"]],
  ["uowm", ["uowm.gr"]],
  ["uop", ["uop.gr"]],
  ["hmu", ["hmu.gr"]],
  ["aegean", ["aegean.gr"]],
  ["uoi", ["uoi.gr"]],
];

const UNIVERSITY_USERNAME_PATTERNS: Array<[string, RegExp]> = [
  ["uoa", /^sdi\d{5,}$/],
  // University of the Aegean department prefixes (e.g. icsd21001, dpsd20012)
  ["aegean", /^(icsd|dpsd)\d{4,}$/],
  ["uom", /^(iis|ics|dai|mai)\d{4,}$/],
  ["uniwa", /^(ice|eee|cs|bme|civ|mech)\d{4,}$/],
  ["ntua", /^(el|mc|cv|ch|ar|ge|na|mm)\d{5,}$/],
  // University of Piraeus student IDs: p24xxx (Informatics), e24xxx (Digital Systems), …
  ["unipi", /^(p|e|m|o|x|s|b|n|d|t|psp|mp|mpsp|mte|pms)\d{4,}$/],
];

export function detectUniversityId(rawUsername: string): string | null {
  const u = rawUsername.trim().toLowerCase();
  if (!u) return null;
  if (u.includes("@")) {
    const domain = u.split("@")[1] ?? "";
    for (const [id, domains] of UNIVERSITY_EMAIL_DOMAINS) {
      if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return id;
    }
  }
  const local = u.split("@")[0];
  for (const [id, re] of UNIVERSITY_USERNAME_PATTERNS) {
    if (re.test(local)) return id;
  }
  return null;
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
  /** Numeric semester index (1..8 for Α'–Η' Εξάμηνο, 9 for Thesis/Other). */
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

export interface CatalogCourse {
  code: string;
  publicCode?: string;
  title: string;
  professor?: string;
  numericId?: number;
  enrolled: boolean;
  /** Course requires a password or closed registration on eClass. */
  locked?: boolean;
  /** Official semester label (e.g. "Α' Εξάμηνο" .. "Η' Εξάμηνο"). */
  semester?: string;
  /** Numeric semester index (1..8 for Α'–Η' Εξάμηνο, 9 for Thesis/Other). */
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

export type NotificationKind = "announcement" | "message" | "assignment" | "system";

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
}

/* ------------------------------------------------------------------ */
/* User / settings                                                     */
/* ------------------------------------------------------------------ */

export type ThemePref = "light" | "dark" | "system";
export type Lang = "el" | "en";
export type AiMode = "server" | "apiKey" | "google";

export interface UserSettings {
  theme: ThemePref;
  language: Lang;
  pollIntervalMin: number;
  notify: {
    announcements: boolean;
    messages: boolean;
    assignments: boolean;
    push: boolean;
  };
  mutedCourses: string[];
  downloads: {
    /** How "download all courses" packages files. */
    allCoursesMode: "single-zip" | "zip-per-course";
  };
  ai: {
    mode: AiMode;
    model: string;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  language: "el",
  pollIntervalMin: 15,
  notify: { announcements: true, messages: true, assignments: true, push: false },
  mutedCourses: [],
  downloads: { allCoursesMode: "single-zip" },
  ai: { mode: "server", model: "gemini-3.8-flash" },
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
    googleConnected: boolean;
    googleEmail?: string;
    googleAvailable: boolean;
    serverKeyAvailable: boolean;
  };
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
  universityId: z.string().max(40).optional().default("auto"),
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
    notify: z.object({
      announcements: z.boolean(),
      messages: z.boolean(),
      assignments: z.boolean(),
      push: z.boolean(),
    }),
    mutedCourses: z.array(z.string()),
    downloads: z.object({ allCoursesMode: z.enum(["single-zip", "zip-per-course"]) }),
    ai: z.object({ mode: z.enum(["server", "apiKey", "google"]), model: z.string().min(1) }),
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
