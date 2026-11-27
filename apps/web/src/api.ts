import type {
  Announcement,
  AnnouncementTriage,
  StudyKind,
  StudyMaterial,
  Assignment,
  AssignmentDetail,
  CourseTool,
  DocumentSummary,
  PortalWarning,
  SubmissionResult,
  CatalogCourse,
  ChatMessage,
  ChatStreamEvent,
  Course,
  DepartmentInfo,
  DocNode,
  LoginRequest,
  Me,
  Message,
  MyStats,
  NotificationItem,
  PendingAction,
  SettingsPatch,
  DocumentSearchResponse,
} from "@myclass/shared";

/** The API server could not be reached (offline, restarting, or the dev proxy has no backend). */
export class ServerUnavailableError extends Error {
  constructor() {
    super("Server unavailable");
  }
}

/** An error answer from our API; `code` names the cases the app handles itself (e.g. "password_required"). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * GETs already on their way, by path. A second identical GET while the first is pending (React's
 * StrictMode running every effect twice, a re-render, a double tap) shares the first answer
 * instead of asking again: for a course page that would be one more visit in the student's
 * eClass statistics.
 */
const pendingGets = new Map<string, Promise<unknown>>();

function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== "GET") return send<T>(path, init);
  const pending = pendingGets.get(path);
  if (pending) return pending as Promise<T>;
  const p = send<T>(path, init).finally(() => pendingGets.delete(path));
  pendingGets.set(path, p);
  return p;
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Myclass-Client": "240",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ServerUnavailableError();
  }
  if (!res.ok) {
    let errMsg: string | undefined;
    let errCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      errMsg = body.error;
      errCode = body.code;
    } catch {
      /* not a JSON error from our API */
    }
    // A 5xx without our JSON error body means the request never reached the API
    // (e.g. Vite's proxy answers 500 when the backend is down).
    if (!errMsg && res.status >= 500) throw new ServerUnavailableError();
    throw new ApiError(errMsg ?? `HTTP ${res.status}`, errCode);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<{ me: Me | null }>("/api/me"),
  login: (payload: LoginRequest) =>
    req<{ me: Me }>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  deleteAccount: () => req<{ ok: boolean }>("/api/auth/account", { method: "DELETE" }),
  patchSettings: (patch: SettingsPatch) =>
    req<{ me: Me }>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  saveApiKey: (apiKey: string) =>
    req<{ me: Me }>("/api/ai/apikey", { method: "POST", body: JSON.stringify({ apiKey }) }),
  removeApiKey: () => req<{ me: Me }>("/api/ai/apikey", { method: "DELETE" }),

  courses: () => req<{ courses: Course[]; warnings?: PortalWarning[] }>("/api/courses"),
  stats: (fresh = false) => req<{ stats: MyStats }>(`/api/stats${fresh ? "?fresh=1" : ""}`),
  courseTools: (code: string) =>
    req<{ tools: CourseTool[] }>(`/api/courses/${encodeURIComponent(code)}/tools`),
  assignmentDetail: (code: string, id: string) =>
    req<{ assignment: AssignmentDetail }>(
      `/api/assignments/${encodeURIComponent(code)}/${encodeURIComponent(id.split(":").pop() ?? id)}`,
    ),
  /** Multipart upload – must not go through `req`, which forces a JSON Content-Type. */
  async submitAssignment(
    code: string,
    id: string,
    payload: { files: File[]; text?: string; comments?: string },
  ): Promise<SubmissionResult> {
    const fd = new FormData();
    for (const f of payload.files) fd.append("files", f, f.name);
    if (payload.text) fd.append("text", payload.text);
    if (payload.comments) fd.append("comments", payload.comments);
    let res: Response;
    try {
      res = await fetch(
        `/api/assignments/${encodeURIComponent(code)}/${encodeURIComponent(id.split(":").pop() ?? id)}/submit`,
        { method: "POST", credentials: "include", body: fd, headers: { "X-Myclass-Client": "240" } },
      );
    } catch {
      throw new ServerUnavailableError();
    }
    const body = (await res.json().catch(() => ({}))) as { result?: SubmissionResult; error?: string };
    if (!res.ok || !body.result) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.result;
  },
  summarizeDocument: (code: string, path: string, refresh = false) =>
    req<{ summary: DocumentSummary }>(`/api/courses/${encodeURIComponent(code)}/documents/summary`, {
      method: "POST",
      body: JSON.stringify({ path, refresh }),
    }),
  studyMaterial: (code: string, path: string, kind: StudyKind, refresh = false) =>
    req<{ material: StudyMaterial; me: Me }>(`/api/courses/${encodeURIComponent(code)}/documents/study`, {
      method: "POST",
      body: JSON.stringify({ path, kind, refresh }),
    }),
  triage: (announcements: Announcement[]) =>
    req<{ triage: Record<string, AnnouncementTriage> }>("/api/announcements/triage", {
      method: "POST",
      body: JSON.stringify({
        items: announcements.slice(0, 100).map((a) => ({
          id: a.id,
          courseCode: a.courseCode,
          courseTitle: a.courseTitle?.slice(0, 300),
          title: a.title.slice(0, 500),
          contentText: a.contentText.slice(0, 600),
          date: a.date,
        })),
      }),
    }),
  enableCalendarFeed: () => req<{ me: Me }>("/api/calendar/feed", { method: "POST" }),
  disableCalendarFeed: () => req<{ me: Me }>("/api/calendar/feed", { method: "DELETE" }),
  patchCourseMeta: (code: string, patch: { semester?: string; archived?: boolean }) =>
    req<{ ok: boolean }>(`/api/courses/${encodeURIComponent(code)}/meta`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  catalog: (q?: string, department?: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (department) params.set("department", department);
    const qs = params.toString();
    return req<{
      catalog: CatalogCourse[];
      departments?: DepartmentInfo[];
      activeDepartment?: string;
    }>(`/api/catalog${qs ? `?${qs}` : ""}`);
  },
  /**
   * `password`: the course's registration code, for courses that ask for one. `department`: the
   * catalog the course was picked from, when it is not the student's own department.
   */
  enroll: (course: string, password?: string, department?: string) =>
    req<{ course: Course }>("/api/courses/enroll", {
      method: "POST",
      body: JSON.stringify({
        course,
        ...(password !== undefined ? { password } : {}),
        ...(department ? { department } : {}),
      }),
    }),
  unenroll: (code: string) =>
    req<{ course: Course }>(`/api/courses/${encodeURIComponent(code)}/unenroll`, {
      method: "POST",
    }),

  announcements: (course?: string) =>
    req<{ announcements: Announcement[] }>(
      `/api/announcements${course ? `?course=${encodeURIComponent(course)}` : ""}`,
    ),
  messages: () => req<{ messages: Message[] }>("/api/messages"),
  message: (id: string) => req<{ message: Message }>(`/api/messages/${encodeURIComponent(id)}`),
  assignments: (course?: string) =>
    req<{ assignments: Assignment[] }>(
      `/api/assignments${course ? `?course=${encodeURIComponent(course)}` : ""}`,
    ),
  searchDocuments: (code: string, query: string) =>
    req<DocumentSearchResponse>(`/api/courses/${encodeURIComponent(code)}/documents/search`, {
      method: "POST",
      body: JSON.stringify({ query }),
    }),
  documentPreview: (code: string, path: string) =>
    req<{ kind: "text"; name: string; text: string } | { kind: "unsupported"; name: string; reason: string }>(
      `/api/courses/${encodeURIComponent(code)}/documents/preview?path=${encodeURIComponent(path)}`,
    ),
  documents:(code: string, dir = "/") =>
    req<{ nodes: DocNode[]; dir: string }>(
      `/api/courses/${encodeURIComponent(code)}/documents?dir=${encodeURIComponent(dir)}`,
    ),

  notifications: () =>
    req<{ notifications: NotificationItem[]; lastPollAt?: string; lastPollError?: string }>(
      "/api/notifications",
    ),
  pollNow: () =>
    req<{ createdCount: number; notifications: NotificationItem[]; lastPollAt?: string }>(
      "/api/notifications/poll",
      { method: "POST" },
    ),
  markAllNotificationsRead: () =>
    req<{ ok: boolean; notifications?: NotificationItem[] }>("/api/notifications/read-all", {
      method: "POST",
    }),
  openNotification: (id: string, dismiss = false) =>
    req<{ ok: boolean; notifications: NotificationItem[] }>(
      `/api/notifications/${encodeURIComponent(id)}/open${dismiss ? "?dismiss=1" : ""}`,
      { method: "POST" },
    ),
  sendTestNotification: () =>
    req<{ notification: NotificationItem }>("/api/notifications/test", { method: "POST" }),

  chatHistory: () => req<{ messages: ChatMessage[] }>("/api/chat/history"),
  clearChat: () => req<{ ok: boolean }>("/api/chat/history", { method: "DELETE" }),
  decideAction: (actionId: string, decision: "confirm" | "cancel") =>
    req<{ action: PendingAction; message?: ChatMessage }>("/api/chat/action", {
      method: "POST",
      body: JSON.stringify({ actionId, decision }),
    }),

  async streamChat(message: string, onEvent: (ev: ChatStreamEvent) => void): Promise<void> {
    const res = await fetch("/api/chat", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Chat request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const dataLine = block
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(5).trim()) as ChatStreamEvent;
          onEvent(parsed);
        } catch {
          /* ignore malformed event */
        }
      }
    }
  },
};

export function isIosNeedsHomeScreen(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return false;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return !isStandalone;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

export async function registerWebPush(): Promise<{
  ok: boolean;
  reason?: "ios-homescreen" | "denied" | "unsupported" | "error";
}> {
  if (isIosNeedsHomeScreen()) {
    return { ok: false, reason: "ios-homescreen" };
  }
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { ok: false, reason: "unsupported" };
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { ok: false, reason: "denied" };
  }

  try {
    await subscribeWithCurrentKey();
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Same bytes? (the key the subscription was made with vs the server's key now) */
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/**
 * Subscribes this device with the server's current push key and sends the subscription to the
 * server. A subscription made with an older key (the server's keys changed) can never deliver
 * (the push service answers 403), so it is replaced instead of being reused.
 */
async function subscribeWithCurrentKey(): Promise<void> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await req<{ publicKey: string }>("/api/notifications/vapid-public-key");
  const key = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key as unknown as BufferSource,
    });
  }
  await req("/api/notifications/subscribe", {
    method: "POST",
    body: JSON.stringify(sub.toJSON()),
  });
}

/**
 * On every app start, for a student who turned push on and already allowed notifications: make sure
 * the server has a working subscription for this device. Never asks for permission.
 */
export async function refreshWebPush(): Promise<void> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  try {
    await subscribeWithCurrentKey();
  } catch {
    /* tried again next start */
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
