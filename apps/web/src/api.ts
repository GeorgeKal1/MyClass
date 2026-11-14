import type {
  Announcement,
  Assignment,
  CatalogCourse,
  ChatMessage,
  ChatStreamEvent,
  Course,
  DepartmentInfo,
  DocNode,
  LoginRequest,
  Me,
  Message,
  NotificationItem,
  PendingAction,
  SettingsPatch,
  University,
} from "@myclass/shared";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) errMsg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(errMsg);
  }
  return (await res.json()) as T;
}

export const api = {
  universities: () => req<{ universities: University[] }>("/api/universities"),
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
  startGoogleOAuth: () => req<{ mode: "oauth" | "aistudio"; url: string }>("/api/ai/google/start"),
  connectGoogleAccount: (apiKey: string, email?: string) =>
    req<{ me: Me }>("/api/ai/google/connect", {
      method: "POST",
      body: JSON.stringify({ apiKey, email }),
    }),
  disconnectGoogle: () => req<{ me: Me }>("/api/ai/google/disconnect", { method: "POST" }),

  courses: () => req<{ courses: Course[] }>("/api/courses"),
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
  enroll: (course: string) =>
    req<{ course: Course }>("/api/courses/enroll", {
      method: "POST",
      body: JSON.stringify({ course }),
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
  documents: (code: string, dir = "/") =>
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
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await req<{ publicKey: string }>("/api/notifications/vapid-public-key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    }
    await req("/api/notifications/subscribe", {
      method: "POST",
      body: JSON.stringify(sub.toJSON()),
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
