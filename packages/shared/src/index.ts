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
  universityId: z.string().optional().default("auto"),
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

export const CourseMetaPatch = z.object({
  semester: z.string().max(60).optional(),
  archived: z.boolean().optional(),
});
