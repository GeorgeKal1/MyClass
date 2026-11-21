import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  Calendar,
  ChartNoAxesColumn,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderUp,
  House as HomeIcon,
  KeyRound,
  LogOut,
  Mail,
  Megaphone,
  Monitor,
  Moon,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  Sparkle,
  Star,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  User,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import type {
  Announcement,
  AnnouncementTriage,
  Assignment,
  CatalogCourse,
  PortalWarning,
  ChatMessage,
  Course,
  DepartmentInfo,
  DocNode,
  StarredFile,
  DocumentSearchResponse,
  Lang,
  Me,
  Message,
  NotificationItem,
  ThemePref,
  UserSettings,
} from "@myclass/shared";
import { api, ApiError, ensureServiceWorker, isIosNeedsHomeScreen, registerWebPush, ServerUnavailableError } from "./api";
import { Logo } from "./Logo";
import { safeHref, sanitizeHtml } from "./sanitize";
import { t, type DictKey } from "./i18n";
import {
  AssignmentPanel,
  CourseToolsPanel,
  DeadlineCalendar,
  DocumentSummaryButton,
} from "./features";
import { StatsView } from "./stats";
import { StudyButton } from "./study";
import { aiReadable, DocumentViewer, type DocTab } from "./docviewer";
import { rubberBand } from "./gestures";
import { InstallAppPrompt, isInstalledApp, promptInstall, useCanInstall } from "./install";

type Tab = "home" | "courses" | "inbox" | "assistant" | "stats" | "settings";
const TAB_ORDER: Tab[] = ["home", "courses", "inbox", "assistant", "stats", "settings"];
/** Pages a horizontal swipe moves between: the phone's bottom bar (Settings sits in the top bar). */
const SWIPE_ORDER: Tab[] = ["home", "courses", "inbox", "assistant", "stats"];
type CourseSubTab = "announcements" | "documents" | "starred" | "assignments" | "info";
const COURSE_SUB_TABS: CourseSubTab[] = ["announcements", "documents", "starred", "assignments", "info"];

interface Route {
  tab: Tab;
  course: string | null;
  sub: CourseSubTab;
}

/** URL <-> view state, so the browser/Android back button and notification links work. */
function routeFromLocation(): Route {
  const parts = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const tab = (TAB_ORDER as string[]).includes(parts[0] ?? "") ? (parts[0] as Tab) : "home";
  const subParam = new URLSearchParams(window.location.search).get("tab") as CourseSubTab | null;
  return {
    tab,
    course: tab === "courses" && parts[1] ? parts[1] : null,
    sub: subParam && COURSE_SUB_TABS.includes(subParam) ? subParam : "documents",
  };
}

type Accessibility = UserSettings["accessibility"];
const A11Y_KEY = "myclass.a11y";

/** Last accessibility settings on this device, so text size and motion apply before sign-in loads. */
function cachedAccessibility(): Accessibility {
  try {
    const raw = JSON.parse(localStorage.getItem(A11Y_KEY) ?? "null") as Partial<Accessibility> | null;
    if (raw && typeof raw.fontScale === "number") {
      return { fontScale: raw.fontScale, reduceMotion: raw.reduceMotion ?? "on" };
    }
  } catch {
    /* storage unavailable */
  }
  // Less motion is the default; Settings > Accessibility turns movement back on
  return { fontScale: 1, reduceMotion: "on" };
}

/** True when movement should be skipped (Settings > Accessibility, or the device setting). */
export function reducedMotion(): boolean {
  return document.documentElement.classList.contains("reduce-motion");
}

/** Where and when the student last tapped or pressed a key: theme and text-size changes animate from there. */
let lastInput = { x: 0, y: 0, at: 0 };
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastInput = { x: e.clientX, y: e.clientY, at: Date.now() };
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "keydown",
    () => {
      const el = document.activeElement?.getBoundingClientRect();
      lastInput = el
        ? { x: el.left + el.width / 2, y: el.top + el.height / 2, at: Date.now() }
        : { x: window.innerWidth / 2, y: 0, at: Date.now() };
    },
    { capture: true },
  );
}

/**
 * Applies a page-wide visual change (theme, text size) inside a View Transition: the new theme
 * spreads out in a circle from the control that was pressed, a new text size settles in from 97%.
 * Changes nobody just asked for (settings arriving on start-up) and reduced motion swap instantly.
 * Transitions are off while the change lands, so the "after" snapshot has its final colours.
 */
let swapToken = 0;
function animatedSwap(kind: "theme" | "text-size", apply: () => void) {
  const root = document.documentElement;
  const token = ++swapToken;
  let applied = false;
  const flip = () => {
    if (applied) return;
    applied = true;
    root.classList.add("theme-switching");
    apply();
    const on = () => root.classList.remove("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(on));
    window.setTimeout(on, 300);
  };
  const userAsked = Date.now() - lastInput.at < 3000;
  if (!("startViewTransition" in document) || reducedMotion() || !userAsked || document.visibilityState !== "visible") {
    flip();
    return;
  }
  const x = lastInput.x || window.innerWidth / 2;
  const y = lastInput.y;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.style.setProperty("--vt-x", `${x}px`);
  root.style.setProperty("--vt-y", `${y}px`);
  root.style.setProperty("--vt-r", `${Math.ceil(radius)}px`);
  root.dataset.vt = kind;
  const vt = document.startViewTransition(flip);
  // `ready` rejects when a transition is skipped; that is expected here, not an error
  vt.ready.catch(() => {});
  // A browser that stops painting mid-way (background tab, low-power mode) never runs the update;
  // the setting must still land, so apply it directly and drop the animation
  const fallback = window.setTimeout(() => {
    if (applied) return;
    vt.skipTransition();
    flip();
  }, 400);
  void vt.finished.finally(() => {
    window.clearTimeout(fallback);
    // A newer swap may already be running with its own kind
    if (token === swapToken) delete root.dataset.vt;
  });
}

const LAST_SEEN_KEY = "myclass.lastSeen";
/** Back within this long (a reload, a quick app switch) and the app stays on the page it was on. */
const RESUME_WINDOW_MS = 15 * 60 * 1000;

/**
 * Where a page load starts. Mobile browsers and installed apps reopen the last URL, so a plain
 * reopen after a while starts on Home. `?open=1` (a notification, an app shortcut, the calendar
 * feed) opens what it points to.
 *
 * A course page is never reopened by itself: loading it reads the course's pages on eClass, which
 * eClass logs as a visit the student did not make (an app reopening its last address, a reload).
 * Within the resume window the app goes back to the Courses list instead; one tap reopens the course.
 */
function launchRoute(): Route {
  const route = routeFromLocation();
  const params = new URLSearchParams(window.location.search);
  if (params.get("open") === "1") {
    params.delete("open");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    return route;
  }
  let lastSeen = 0;
  try {
    lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0);
  } catch {
    /* storage unavailable: treat as a new visit */
  }
  const resuming = Date.now() - lastSeen < RESUME_WINDOW_MS;
  if (route.course) {
    const start: Route = resuming
      ? { tab: "courses", course: null, sub: "documents" }
      : { tab: "home", course: null, sub: "documents" };
    window.history.replaceState(null, "", pathForRoute(start));
    return start;
  }
  if (route.tab === "home" || resuming) return route;
  window.history.replaceState(null, "", "/");
  return { tab: "home", course: null, sub: "documents" };
}

function pathForRoute(r: Route): string {
  if (r.tab === "courses" && r.course) {
    return `/courses/${encodeURIComponent(r.course)}${r.sub !== "documents" ? `?tab=${r.sub}` : ""}`;
  }
  return r.tab === "home" ? "/" : `/${r.tab}`;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  // Fallback theme & language before login
  const [guestTheme, setGuestTheme] = useState<ThemePref>("dark");
  const [guestLang, setGuestLang] = useState<Lang>("el");
  const theme: ThemePref = me?.settings.theme ?? guestTheme;
  const lang: Lang = me?.settings.language ?? guestLang;
  const [guestAccess] = useState(cachedAccessibility);
  const access: Accessibility = me?.settings.accessibility ?? guestAccess;

  // Text size and reduced motion on <html> (remembered on this device for the next start)
  useEffect(() => {
    const root = document.documentElement;
    const scale = String(access.fontScale);
    const current = root.style.getPropertyValue("--font-scale");
    if (current && current !== scale) {
      animatedSwap("text-size", () => root.style.setProperty("--font-scale", scale));
    } else {
      root.style.setProperty("--font-scale", scale);
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () =>
      root.classList.toggle("reduce-motion", access.reduceMotion === "on" || (access.reduceMotion === "system" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    try {
      localStorage.setItem(A11Y_KEY, JSON.stringify(access));
    } catch {
      /* storage unavailable */
    }
    return () => mq.removeEventListener("change", apply);
  }, [access.fontScale, access.reduceMotion]);

  // Apply light / dark theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    // Browser chrome (status bar, installed app's title bar) follows the page background
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark ? "#111216" : "#f6f6f8");
    if (root.classList.contains("dark") === isDark) return;
    animatedSwap("theme", () => root.classList.toggle("dark", isDark));
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Initial session check & Service Worker registration
  useEffect(() => {
    void ensureServiceWorker();
    let cancelled = false;
    void (async () => {
      try {
        const mRes = await api.me();
        if (!cancelled) setMe(mRes.me);
      } catch {
        /* server might still be starting */
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>myClass</span>
        </div>
      </div>
    );
  }

  // The "install the app" card stays mounted across sign-in, so it doesn't flash away and back
  const installPrompt = <InstallAppPrompt lang={lang} signedIn={!!me} />;

  if (!me) {
    return (
      <>
        <LoginScreen
          lang={lang}
          theme={theme}
          onToggleLang={() => setGuestLang((l) => (l === "el" ? "en" : "el"))}
          onToggleTheme={() => setGuestTheme((th) => (th === "dark" ? "light" : "dark"))}
          onLoggedIn={(loggedInMe) => {
            // Signing in lands on Home, unless the sign-in interrupted a link to a course
            if (!routeFromLocation().course) window.history.replaceState(null, "", "/");
            setMe(loggedInMe);
          }}
        />
        {installPrompt}
      </>
    );
  }

  // Keyed by user id: signing in as someone else starts from a clean slate (courses, catalog, chat…)
  return (
    <>
      <Workspace
        key={me.id}
        me={me}
        setMe={setMe}
        onLoggedOut={() => {
          window.history.replaceState(null, "", "/");
          setMe(null);
        }}
      />
      {installPrompt}
    </>
  );
}

/* ================================================================== */
/* Signed-in workspace                                                 */
/* ================================================================== */

function Workspace({
  me,
  setMe,
  onLoggedOut,
}: {
  me: Me;
  setMe: (m: Me) => void;
  onLoggedOut: () => void;
}) {
  const initialRoute = useMemo(launchRoute, []);
  const [tab, setTab] = useState<Tab>(initialRoute.tab);

  // Remember when the app was last in use, so the next start knows whether to resume or open Home
  useEffect(() => {
    const mark = () => {
      try {
        localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
      } catch {
        /* storage unavailable */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") mark();
    };
    mark();
    const id = window.setInterval(mark, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", mark);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", mark);
    };
  }, []);
  const [selectedCourseCode, setSelectedCourseCode] = useState<string | null>(initialRoute.course);
  const [coursesInitialViewMode, setCoursesInitialViewMode] = useState<"enrolled" | "all">("enrolled");
  const [courseSubTab, setCourseSubTab] = useState<CourseSubTab>(initialRoute.sub);

  // Mobile horizontal swipe navigation state
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    ignore: boolean;
    locked: "x" | "y" | null;
  } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const swipeSamples = useRef<Array<{ x: number; t: number }>>([]);
  const springFrame = useRef<number | null>(null);
  const setPageOffset = (px: number) => {
    const el = pageRef.current;
    if (el) el.style.transform = px ? `translateX(${px}px)` : "";
  };
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);

  const [courses, setCourses] = useState<Course[]>([]);
  const [courseWarnings, setCourseWarnings] = useState<PortalWarning[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [focusAssignmentId, setFocusAssignmentId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogCourse[]>([]);
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [triage, setTriage] = useState<Record<string, AnnouncementTriage>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [lastPollAt, setLastPollAt] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [quickChatOpen, setQuickChatOpen] = useState(false);

  const theme: ThemePref = me.settings.theme;
  const lang: Lang = me.settings.language;
  const departmentId = me.departmentId ?? "";
  const tr = useCallback((k: DictKey) => t(lang, k), [lang]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  /** The department is part of the user's settings, so the catalog follows `me.departmentId`. */
  const changeDepartment = useCallback(
    async (deptId: string) => {
      if (!deptId || deptId === departmentId) return;
      try {
        const res = await api.patchSettings({ departmentId: deptId });
        setMe(res.me);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [departmentId, setMe, showToast],
  );

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const catRes = await api.catalog(undefined, departmentId || undefined);
      setCatalog(catRes.catalog);
      if (catRes.departments) setDepartments(catRes.departments);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  }, [departmentId, showToast]);

  const refreshAllData = useCallback(async () => {
    setSyncing(true);
    setAssignmentsLoading(true);
    // Each source updates the UI as soon as it arrives (assignments are the slowest: one request per course)
    let firstError: string | null = null;
    const track = <T,>(p: Promise<T>, apply: (v: T) => void) =>
      p.then(apply).catch((err: Error) => {
        firstError ??= err.message;
      });
    await Promise.all([
      track(api.courses(), (r) => {
        setCourses(r.courses);
        setCourseWarnings(r.warnings ?? []);
      }),
      track(api.announcements(), (r) => setAnnouncements(r.announcements)),
      track(api.messages(), (r) => setMessages(r.messages)),
      track(api.assignments(), (r) => setAssignments(r.assignments)).finally(() => setAssignmentsLoading(false)),
      track(api.notifications(), (r) => {
        setNotifications(r.notifications);
        setLastPollAt(r.lastPollAt);
      }),
    ]);
    if (firstError) showToast(firstError);
    setSyncing(false);
  }, [showToast]);

  /** A course's own assignment page was read: it says what was handed in, so Home and the calendar follow it. */
  const mergeCourseAssignments = useCallback((code: string, list: Assignment[]) => {
    if (list.length === 0) return;
    setAssignments((prev) => {
      const titles = new Map(prev.filter((a) => a.courseCode === code).map((a) => [a.id, a.courseTitle]));
      const fresh = list.map((n) => ({ ...n, courseTitle: n.courseTitle ?? titles.get(n.id) ?? prev.find((a) => a.courseCode === code)?.courseTitle }));
      return [...prev.filter((a) => a.courseCode !== code || !list.some((n) => n.id === a.id)), ...fresh];
    });
  }, []);

  /**
   * The student pressed "check" on Home: read the assignment page of each course with a deadline whose
   * hand-in state is unknown. One course at a time; each is the student's own visit to that course.
   */
  const checkSubmissions = useCallback(
    async (codes: string[]) => {
      let failed = 0;
      for (const code of codes) {
        try {
          const r = await api.assignments(code);
          if (r.assignments.length === 0) failed++;
          mergeCourseAssignments(code, r.assignments);
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        showToast(
          lang === "el"
            ? "Δεν ήταν δυνατός ο έλεγχος σε κάποιο μάθημα. Δοκίμασε ξανά αργότερα."
            : "Could not check one of the courses. Try again later.",
        );
      }
    },
    [mergeCourseAssignments, showToast, lang],
  );

  /** Pinned courses live in the account settings, so a pin on the PC also shows on the phone. */
  const pinnedCourses = useMemo(() => me.settings.pinnedCourses ?? [], [me.settings.pinnedCourses]);
  const togglePin = useCallback(
    async (code: string) => {
      const before = me;
      const next = pinnedCourses.includes(code) ? pinnedCourses.filter((c) => c !== code) : [...pinnedCourses, code];
      setMe({ ...me, settings: { ...me.settings, pinnedCourses: next } });
      try {
        const res = await api.patchSettings({ pinnedCourses: next });
        setMe(res.me);
      } catch (err) {
        setMe(before);
        showToast((err as Error).message);
      }
    },
    [me, pinnedCourses, setMe, showToast],
  );

  /** Starred files live in the account settings too: starred on the PC, there on the phone. */
  const starredFiles = useMemo(() => me.settings.starredFiles ?? [], [me.settings.starredFiles]);
  const toggleStar = useCallback(
    async (courseCode: string, node: DocNode, folder: string) => {
      const before = me;
      const isStarred = starredFiles.some((f) => f.courseCode === courseCode && f.path === node.path);
      const next: StarredFile[] = isStarred
        ? starredFiles.filter((f) => !(f.courseCode === courseCode && f.path === node.path))
        : [
            {
              courseCode,
              path: node.path,
              name: node.name,
              ...(folder ? { folder } : {}),
              ...(node.size !== undefined ? { size: node.size } : {}),
              ...(node.date ? { date: node.date } : {}),
              at: new Date().toISOString(),
            },
            ...starredFiles,
          ].slice(0, 400);
      setMe({ ...me, settings: { ...me.settings, starredFiles: next } });
      try {
        const res = await api.patchSettings({ starredFiles: next });
        setMe(res.me);
      } catch (err) {
        setMe(before);
        showToast((err as Error).message);
      }
    },
    [me, starredFiles, setMe, showToast],
  );

  /** Everything the Refresh button does: poll eClass now, then reload every list. */
  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await api.pollNow();
      await Promise.all([refreshAllData(), loadCatalog()]);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [refreshAllData, loadCatalog, showToast]);

  useEffect(() => {
    void refreshAllData();
  }, [refreshAllData]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // "Action needed" / "FYI" for announcements not classified yet (cached server-side per announcement)
  const triageRequested = useRef(new Set<string>());
  useEffect(() => {
    const missing = announcements.filter((a) => !triageRequested.current.has(a.id));
    if (!missing.length) return;
    for (const a of missing) triageRequested.current.add(a.id);
    api
      .triage(missing)
      .then((r) => setTriage((prev) => ({ ...prev, ...r.triage })))
      .catch(() => {
        for (const a of missing) triageRequested.current.delete(a.id);
      });
  }, [announcements]);

  // Live SSE notification stream
  useEffect(() => {
    const es = new EventSource("/api/notifications/stream", { withCredentials: true });
    es.addEventListener("notification", (ev) => {
      try {
        const item = JSON.parse((ev as MessageEvent).data) as NotificationItem;
        setNotifications((prev) => [item, ...prev]);
        showToast(item.title);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [showToast]);

  // Keep the URL in sync with the current view (one history entry per navigation).
  // After a popstate the URL already matches the new state, so nothing is pushed.
  const inAppHistoryRef = useRef(0);
  useEffect(() => {
    const path = pathForRoute({ tab, course: selectedCourseCode, sub: courseSubTab });
    const current = window.location.pathname + window.location.search;
    if (path === current) return;
    // Switching sub-tabs inside the same course replaces the entry instead of stacking them
    const sameCourse =
      selectedCourseCode !== null &&
      window.location.pathname === `/courses/${encodeURIComponent(selectedCourseCode)}`;
    if (sameCourse) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
      inAppHistoryRef.current += 1;
    }
  }, [tab, selectedCourseCode, courseSubTab]);

  /** Back inside the app; if the page was opened directly (no in-app history), go to the list. */
  const goBack = useCallback(() => {
    if (inAppHistoryRef.current > 0) {
      window.history.back();
    } else {
      setSlideDir("right");
      setSelectedCourseCode(null);
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation();
      inAppHistoryRef.current = Math.max(0, inAppHistoryRef.current - 1);
      setSlideDir("right");
      setTab(r.tab);
      setSelectedCourseCode(r.course);
      setCourseSubTab(r.sub);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const unreadMsgCount = useMemo(() => messages.filter((m) => !m.read).length, [messages]);
  /** Unread messages plus unread non-message notifications (a message notification is the same item as the message). */
  const inboxBadge = useMemo(
    () => unreadMsgCount + notifications.filter((n) => !n.read && n.kind !== "message").length,
    [unreadMsgCount, notifications],
  );

  // Resolve active course from either enrolled courses OR the full university semester catalog
  const activeCourse: Course | null = useMemo(() => {
    if (!selectedCourseCode) return null;
    const enrolledMatch = courses.find((c) => c.code === selectedCourseCode);
    if (enrolledMatch) return { ...enrolledMatch, enrolled: true };
    const catalogMatch = catalog.find((c) => c.code === selectedCourseCode);
    if (catalogMatch) {
      return {
        code: catalogMatch.code,
        publicCode: catalogMatch.publicCode,
        title: catalogMatch.title,
        professor: catalogMatch.professor,
        semester: catalogMatch.semester,
        semesterIndex: catalogMatch.semesterIndex,
        semesterFolder: catalogMatch.semesterFolder,
        departmentId: catalogMatch.departmentId,
        departmentName: catalogMatch.departmentName,
        url: catalogMatch.url,
        portal: catalogMatch.portal,
        enrolled: catalogMatch.enrolled,
        needsPassword: catalogMatch.needsPassword,
      };
    }
    return null;
  }, [selectedCourseCode, courses, catalog]);

  // Stable between renders: the course page loads its own announcements when these come back empty,
  // and a new array on every render made it ask eClass again (one more counted visit) each time
  const activeCourseAnnouncements = useMemo(
    () => (activeCourse ? announcements.filter((a) => a.courseCode === activeCourse.code) : []),
    [announcements, activeCourse?.code],
  );
  const activeCourseAssignments = useMemo(
    () => (activeCourse ? assignments.filter((a) => a.courseCode === activeCourse.code) : []),
    [assignments, activeCourse?.code],
  );

  const openCourse = (code: string, sub: CourseSubTab = "documents", assignmentId?: string) => {
    setFocusAssignmentId(assignmentId ?? null);
    setSlideDir("left");
    setSelectedCourseCode(code);
    setCourseSubTab(sub);
    setTab("courses");
  };

  const navigateTab = useCallback(
    (nextTab: Tab, dir: "left" | "right" | null = null, forceCoursesView?: "enrolled" | "all") => {
      if (dir) {
        setSlideDir(dir);
      } else {
        const curIdx = TAB_ORDER.indexOf(tab);
        const nextIdx = TAB_ORDER.indexOf(nextTab);
        setSlideDir(nextIdx > curIdx ? "left" : nextIdx < curIdx ? "right" : null);
      }
      setSelectedCourseCode(null);
      if (nextTab === "courses") {
        setCoursesInitialViewMode(forceCoursesView ?? "enrolled");
      }
      setTab(nextTab);
    },
    [tab],
  );

  // Mobile horizontal swipe between pages: the page follows the finger, and a quick
  // flick or a drag past ~22% of the screen width switches page.
  const goBackOrPrev = () => {
    if (selectedCourseCode !== null) {
      goBack();
      return;
    }
    const idx = SWIPE_ORDER.indexOf(tab);
    if (idx > 0) navigateTab(SWIPE_ORDER[idx - 1], "right");
  };
  const goNext = () => {
    const idx = SWIPE_ORDER.indexOf(tab);
    if (selectedCourseCode === null && idx >= 0 && idx < SWIPE_ORDER.length - 1) {
      navigateTab(SWIPE_ORDER[idx + 1], "left");
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    let ignore = false;
    if (target) {
      if (target.closest('input, textarea, select, [data-no-swipe="true"]')) {
        ignore = true;
      } else {
        // Let horizontally scrollable areas (tab strips, tables) scroll instead of switching page
        let el: HTMLElement | null = target;
        while (el && el !== e.currentTarget) {
          const ox = window.getComputedStyle(el).overflowX;
          if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 4) {
            ignore = true;
            break;
          }
          el = el.parentElement;
        }
      }
    }
    const touch = e.touches[0];
    if (springFrame.current !== null) cancelAnimationFrame(springFrame.current);
    springFrame.current = null;
    swipeSamples.current = [{ x: touch.clientX, t: performance.now() }];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), ignore, locked: null };
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    if (!start || start.ignore || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!start.locked) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      start.locked = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
    }
    if (start.locked !== "x") return;
    const now = performance.now();
    swipeSamples.current = [...swipeSamples.current.filter((p) => now - p.t < 100), { x: touch.clientX, t: now }];
    const idx = SWIPE_ORDER.indexOf(tab);
    const atEdge =
      idx < 0 ||
      (dx > 0 && idx === 0 && selectedCourseCode === null) ||
      (dx < 0 && (idx === SWIPE_ORDER.length - 1 || selectedCourseCode !== null));
    setPageOffset(atEdge ? rubberBand(dx, window.innerWidth) : dx * 0.85);
  };

  /** Hands the page back to a critically damped spring that starts at the finger's release velocity. */
  const springPageBack = (from: number, velocity: number) => {
    if (reducedMotion()) {
      setPageOffset(0);
      return;
    }
    const omega = (2 * Math.PI) / 0.5; // duration 0.5 s, bounce 0
    const t0 = performance.now();
    const step = (now: number) => {
      const t = (now - t0) / 1000;
      const x = (from + (velocity + omega * from) * t) * Math.exp(-omega * t);
      if (t > 0.05 && Math.abs(x) < 0.5) {
        setPageOffset(0);
        springFrame.current = null;
        return;
      }
      setPageOffset(x);
      springFrame.current = requestAnimationFrame(step);
    };
    springFrame.current = requestAnimationFrame(step);
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || start.ignore || start.locked !== "x" || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const samples = swipeSamples.current;
    const first = samples[0];
    const last = samples[samples.length - 1];
    // px per second over the last ~100 ms of the drag
    const releaseVelocity = first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const el = pageRef.current;
    const current = el ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 : 0;

    const idx = SWIPE_ORDER.indexOf(tab);
    const canGo =
      selectedCourseCode !== null ? dx > 0 : idx >= 0 && (dx > 0 ? idx > 0 : idx < SWIPE_ORDER.length - 1);
    const far = Math.abs(dx) > window.innerWidth * 0.22;
    const flick = Math.abs(releaseVelocity) > 450 && Math.abs(dx) > 30 && Math.sign(releaseVelocity) === Math.sign(dx);
    if (canGo && (far || flick)) {
      setPageOffset(0);
      if (dx > 0) goBackOrPrev();
      else goNext();
      return;
    }
    springPageBack(current, releaseVelocity);
  };

  const enrolledCount = useMemo(() => courses.filter((c) => !c.archived).length, [courses]);
  const currentTabIndex = TAB_ORDER.indexOf(tab);
  const tabLabels: Record<Tab, string> = {
    home: tr("navHome"),
    courses: tr("navCourses"),
    inbox: tr("navInbox"),
    assistant: tr("navAssistant"),
    stats: tr("navStats"),
    settings: tr("navSettings"),
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[var(--bg)] text-[var(--text)]">
      {/* Desktop sidebar: brand + quick actions on top, navigation, account at the bottom */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 border-r border-[var(--border)] bg-[var(--surface)] px-3 py-4 select-none z-30">
        <div className="flex items-center justify-between gap-2 px-1.5 mb-5">
          <button
            onClick={() => navigateTab("home")}
            className="flex items-center gap-2 text-left cursor-pointer min-w-0"
          >
            <Logo size={30} />
            <span className="font-display text-[17px] leading-none">myClass</span>
          </button>
          <div className="flex items-center gap-0.5">
            <IconButton label={syncing ? tr("syncing") : tr("syncNow")} onClick={() => void syncNow()} disabled={syncing}>
              <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin text-[var(--accent)]" : ""}`} />
            </IconButton>
            <NotificationsBell
              lang={lang}
              notifications={notifications}
              setNotifications={setNotifications}
              onOpenCourse={(code) => openCourse(code, "announcements")}
              placement="sidebar"
            />
          </div>
        </div>

        <nav className="space-y-0.5 flex-1">
          <NavButton
            icon={<HomeIcon className="w-4 h-4" />}
            label={tr("navHome")}
            active={tab === "home"}
            onClick={() => navigateTab("home")}
          />
          <NavButton
            icon={<BookOpen className="w-4 h-4" />}
            label={tr("navCourses")}
            badge={enrolledCount || undefined}
            active={tab === "courses"}
            onClick={() => navigateTab("courses", null, "enrolled")}
          />
          <NavButton
            icon={<Bell className="w-4 h-4" />}
            label={tr("navInbox")}
            badge={inboxBadge || undefined}
            active={tab === "inbox"}
            onClick={() => navigateTab("inbox")}
          />
          <NavButton
            icon={<Bot className="w-4 h-4" />}
            label={tr("navAssistant")}
            active={tab === "assistant"}
            onClick={() => navigateTab("assistant")}
          />
          <NavButton
            icon={<ChartNoAxesColumn className="w-4 h-4" />}
            label={tr("navStats")}
            active={tab === "stats"}
            onClick={() => navigateTab("stats")}
          />
        </nav>

        {/* Account: name, theme and settings */}
        <div
          className={`mt-3 px-2 py-2 rounded-xl flex items-center gap-1 ${
            tab === "settings" ? "bg-[var(--accent-soft)]" : "bg-[var(--surface-2)]"
          }`}
        >
          <div className="min-w-0 flex-1 px-0.5">
            <div className="text-[13px] font-medium truncate leading-tight" title={me.displayName}>
              {me.displayName}
            </div>
            <div className="text-xs text-[var(--muted)] truncate leading-tight mt-0.5">{me.username}</div>
          </div>
          <IconButton
            label={tr("themeLabel")}
            tooltipSide="top"
            onClick={async () => {
              const res = await api.patchSettings({ theme: theme === "dark" ? "light" : "dark" });
              setMe(res.me);
            }}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </IconButton>
          <IconButton
            label={tr("navSettings")}
            tooltipSide="top"
            active={tab === "settings"}
            onClick={() => navigateTab("settings")}
          >
            <Settings className="w-4 h-4" />
          </IconButton>
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="flex-1 min-w-0 md:pl-60 flex flex-col min-h-screen pb-24 md:pb-0">
        {/* Phone top bar (desktop has everything in the sidebar) */}
        <header className="md:hidden sticky top-0 z-20 backdrop-blur-md bg-[var(--bg)]/85 border-b border-[var(--border)] px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {activeCourse ? (
              <button
                onClick={goBack}
                aria-label={tr("back")}
                className="-ml-1.5 p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            ) : (
              <Logo size={26} className="rounded-lg" />
            )}
            <span className="truncate font-display text-base">
              {activeCourse ? activeCourse.title : tabLabels[tab]}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton label={syncing ? tr("syncing") : tr("syncNow")} onClick={() => void syncNow()} disabled={syncing}>
              <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin text-[var(--accent)]" : ""}`} />
            </IconButton>
            <NotificationsBell
              lang={lang}
              notifications={notifications}
              setNotifications={setNotifications}
              onOpenCourse={(code) => openCourse(code, "announcements")}
              placement="header"
            />
            <IconButton label={tr("navSettings")} active={tab === "settings"} onClick={() => navigateTab("settings")}>
              <Settings className="w-4 h-4" />
            </IconButton>
          </div>
        </header>

        {/* Toast banner */}
        {toast && (
          <div className="enter fixed bottom-24 md:bottom-6 right-4 md:right-6 z-[80] px-4 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] shadow-lg shadow-black/10 text-xs font-medium flex items-center gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--muted)] hover:text-[var(--text)]">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Active View with Touch Swipe Gesture Support */}
        <main
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="flex-1 flex flex-col px-4 sm:px-5 md:px-8 py-4 md:py-5 max-w-6xl w-full mx-auto overflow-x-hidden touch-pan-y"
        >
          <div
            ref={pageRef}
            key={`${tab}-${selectedCourseCode ?? "root"}`}
            className={[
              (tab === "courses" && !activeCourse) || tab === "inbox" ? "flex-1 flex flex-col" : "",
              slideDir === "left"
                ? "animate-slide-left"
                : slideDir === "right"
                  ? "animate-slide-right"
                  : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined}
          >
            {tab === "home" && (
              <HomeView
                lang={lang}
                courses={courses}
                catalogCount={catalog.length}
                announcements={announcements}
                triage={triage}
                assignments={assignments}
                assignmentsLoading={assignmentsLoading}
                messages={messages}
                lastPollAt={lastPollAt}
                onOpenCourse={openCourse}
                onCheckSubmissions={checkSubmissions}
                onOpenEnrolledCourses={() => navigateTab("courses", "left", "enrolled")}
                onOpenAllCourses={() => navigateTab("courses", "left", "all")}
                onOpenInbox={() => navigateTab("inbox", "left")}
                onOpenAssistant={() => navigateTab("assistant", "left")}
              />
            )}

            {tab === "courses" && !activeCourse && (
              <CoursesView
                lang={lang}
                courses={courses}
                catalog={catalog}
                departments={departments}
                activeDepartment={departmentId}
                catalogLoading={catalogLoading}
                warnings={courseWarnings}
                syncing={syncing}
                initialViewMode={coursesInitialViewMode}
                onChangeDepartment={changeDepartment}
                onSelectCourse={(code, sub) => openCourse(code, sub)}
                onChanged={async () => {
                  await Promise.all([refreshAllData(), loadCatalog()]);
                }}
                showToast={showToast}
                pinned={pinnedCourses}
                onTogglePin={(code) => void togglePin(code)}
              />
            )}

            {tab === "courses" && activeCourse && (
              <CourseDetailView
                lang={lang}
                course={activeCourse}
                subTab={courseSubTab}
                onChangeSubTab={setCourseSubTab}
                announcements={activeCourseAnnouncements}
                triage={triage}
                onMeChanged={setMe}
                assignments={activeCourseAssignments}
                onAssignmentsLoaded={mergeCourseAssignments}
                starred={starredFiles.filter((f) => f.courseCode === activeCourse.code)}
                onToggleStar={(code, node, folder) => void toggleStar(code, node, folder)}
                focusAssignmentId={focusAssignmentId}
                onOpenInbox={() => navigateTab("inbox", "left")}
                onBack={goBack}
                onEnrolledOrUnenrolled={async () => {
                  await refreshAllData();
                }}
                showToast={showToast}
              />
            )}

            {tab === "inbox" && (
              <InboxView
                lang={lang}
                messages={messages}
                announcements={announcements}
                triage={triage}
                notifications={notifications}
                setNotifications={setNotifications}
                onOpenNotification={(n) => {
                  if (!n.courseCode) return;
                  openCourse(n.courseCode, n.kind === "assignment" || n.kind === "deadline" ? "assignments" : "announcements");
                }}
                onOpenAnnouncement={(a) => openCourse(a.courseCode, "announcements")}
              />
            )}

            {tab === "assistant" && (
              <AssistantView lang={lang} onActionCompleted={refreshAllData} />
            )}

            {tab === "stats" && <StatsView lang={lang} />}

            {tab === "settings" && (
              <SettingsView
                me={me}
                lang={lang}
                departments={departments}
                onUpdatedMe={setMe}
                onLoggedOut={onLoggedOut}
                showToast={showToast}
              />
            )}
          </div>
        </main>
      </div>

      {/* Floating Quick AI Button (when not on the Assistant tab) */}
      {tab !== "assistant" && (
        <>
          <button
            onClick={() => setQuickChatOpen((o) => !o)}
            className="hidden md:inline-flex fixed bottom-6 right-6 z-30 items-center gap-2 px-4 h-10 rounded-full bg-[var(--accent)] text-[var(--on-accent)] font-medium text-xs hover:bg-[var(--accent-hover)] cursor-pointer"
          >
            <Bot className="w-4 h-4" />
            <span>{tr("navAssistant")}</span>
          </button>
          {quickChatOpen && (
            <div className="enter origin-bottom-right hidden md:flex fixed bottom-20 right-6 z-40 w-[400px] h-[460px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-lg shadow-black/15 flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-2)]">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Bot className="w-4 h-4 text-[var(--muted)]" />
                  <span>{tr("assistantTitle")}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setQuickChatOpen(false);
                      navigateTab("assistant");
                    }}
                    className="p-1.5 rounded hover:bg-[var(--surface)] text-[var(--muted)]"
                    title="Expand"
                  >
                    <ArrowUpRight className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setQuickChatOpen(false)}
                    className="p-1.5 rounded hover:bg-[var(--surface)] text-[var(--muted)]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-hidden p-3">
                <AssistantView compact lang={lang} onActionCompleted={refreshAllData} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Mobile Bottom Navigation Bar (Accessible touch targets + swipe sync) */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-md flex items-center justify-around px-1 pt-1.5 pb-[max(0.45rem,env(safe-area-inset-bottom))] select-none"
      >
        <MobileTab
          icon={<HomeIcon className="w-5 h-5" />}
          label={tr("navHome")}
          active={tab === "home"}
          onClick={() => navigateTab("home")}
        />
        <MobileTab
          icon={<BookOpen className="w-5 h-5" />}
          label={tr("navCourses")}
          badge={enrolledCount || undefined}
          active={tab === "courses"}
          onClick={() => navigateTab("courses", null, "enrolled")}
        />
        <MobileTab
          icon={<Bell className="w-5 h-5" />}
          label={tr("navInbox")}
          badge={inboxBadge || undefined}
          active={tab === "inbox"}
          onClick={() => navigateTab("inbox")}
        />
        <MobileTab
          icon={<Bot className="w-5 h-5" />}
          label={tr("navAssistant")}
          active={tab === "assistant"}
          onClick={() => navigateTab("assistant")}
        />
        <MobileTab
          icon={<ChartNoAxesColumn className="w-5 h-5" />}
          label={tr("navStats")}
          active={tab === "stats"}
          onClick={() => navigateTab("stats")}
        />
      </nav>
    </div>
  );
}

/* ================================================================== */
/* Notifications bell (sidebar on desktop, top bar on phones)          */
/* ================================================================== */

function NotificationsBell({
  lang,
  notifications,
  setNotifications,
  onOpenCourse,
  placement,
}: {
  lang: Lang;
  notifications: NotificationItem[];
  setNotifications: React.Dispatch<React.SetStateAction<NotificationItem[]>>;
  onOpenCourse: (code: string) => void;
  placement: "sidebar" | "header";
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.read).length;

  // Close when clicking anywhere else
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const dismiss = async (id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
    try {
      const res = await api.openNotification(id, true);
      setNotifications(res.notifications);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="relative" ref={ref}>
      <IconButton label={tr("notificationsBell")} onClick={() => setOpen((o) => !o)} active={open}>
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--accent)] text-[var(--on-accent)] text-[0.6875rem] font-semibold tabular-nums flex items-center justify-center">
            {unread}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          className={`enter absolute mt-2 w-80 sm:w-96 rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-lg shadow-black/10 p-3 z-50 ${
            placement === "sidebar" ? "left-0 origin-top-left" : "right-0 origin-top-right"
          }`}
        >
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border)]">
            <span className="text-sm font-semibold">{tr("notificationsBell")}</span>
            {notifications.length > 0 && (
              <button
                onClick={async () => {
                  const res = await api.markAllNotificationsRead();
                  setNotifications(res.notifications ?? []);
                }}
                className="text-xs text-[var(--accent)] hover:underline cursor-pointer"
              >
                {tr("markAllRead")}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto space-y-1.5">
            {notifications.length === 0 ? (
              <div className="text-sm text-[var(--muted)] py-6 text-center">{tr("noItems")}</div>
            ) : (
              notifications.slice(0, 20).map((n) => (
                <div
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    if (n.courseCode) onOpenCourse(n.courseCode);
                    void dismiss(n.id);
                  }}
                  className={`p-2.5 rounded-xl cursor-pointer transition-colors ${
                    n.read ? "opacity-65 hover:bg-[var(--surface-2)]" : "bg-[var(--surface-2)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug">{n.title}</span>
                    <button
                      title={lang === "el" ? "Απόρριψη" : "Dismiss"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismiss(n.id);
                      }}
                      className="p-0.5 rounded text-[var(--muted)] hover:text-[var(--text)] cursor-pointer shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-xs text-[var(--muted)] line-clamp-2 mt-0.5">{n.body}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared tooltip timing: only the first tooltip waits; while one was shown recently, the next opens at once. */
const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_WARM_MS = 600;
let tooltipWarmUntil = 0;

function IconButton({
  label,
  onClick,
  href,
  children,
  disabled,
  active,
  tone = "default",
  pressed,
  tooltipSide = "bottom",
}: {
  label: string;
  onClick?: () => void;
  /** A link instead of a button (file downloads). */
  href?: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  /** "danger": turns red on hover (leaving a course). */
  tone?: "default" | "danger";
  /** A toggle (pin): says whether it is on. */
  pressed?: boolean;
  /** "left": beside the icon, for rows inside clipped cards. */
  tooltipSide?: "top" | "bottom" | "left";
}) {
  const [tip, setTip] = useState<"hidden" | "delayed" | "instant">("hidden");
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const show = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clear();
    if (Date.now() < tooltipWarmUntil) setTip("instant");
    else timer.current = window.setTimeout(() => setTip("delayed"), TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    clear();
    setTip((cur) => {
      if (cur !== "hidden") tooltipWarmUntil = Date.now() + TOOLTIP_WARM_MS;
      return "hidden";
    });
  };

  const className = `relative inline-flex p-2 rounded-lg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default ${
    active
      ? "text-[var(--accent)] bg-[var(--accent-soft)]"
      : tone === "danger"
        ? "text-[var(--muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-soft)]"
        : "text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
  }`;
  const tooltip = tip !== "hidden" && (
    <span
      role="tooltip"
      className={`tooltip ${
        tooltipSide === "left"
          ? "right-full mr-1.5 top-1/2 -translate-y-1/2"
          : `left-1/2 -translate-x-1/2 ${tooltipSide === "top" ? "bottom-full mb-2" : "top-full mt-2"}`
      }`}
      style={tip === "instant" ? { animation: "none" } : undefined}
    >
      {label}
    </span>
  );

  if (href) {
    return (
      <a href={href} aria-label={label} onClick={hide} onPointerEnter={show} onPointerLeave={hide} className={className}>
        {children}
        {tooltip}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={() => {
        hide();
        onClick?.();
      }}
      onPointerEnter={show}
      onPointerLeave={hide}
      disabled={disabled}
      className={className}
    >
      {children}
      {tooltip}
    </button>
  );
}

/* ================================================================== */
/* Login Screen                                                        */
/* ================================================================== */

function LoginScreen({
  lang,
  theme,
  onToggleLang,
  onToggleTheme,
  onLoggedIn,
}: {
  lang: Lang;
  theme: ThemePref;
  onToggleLang: () => void;
  onToggleTheme: () => void;
  onLoggedIn: (me: Me) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badCredentials, setBadCredentials] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  /** Wrong password: shake the field (it also turns red). Restarts on every wrong attempt. */
  const shakePassword = () => {
    const el = passwordRef.current;
    if (!el || reducedMotion()) return;
    el.animate(
      [0, -10, 10, -6, 6, -3, 0].map((px) => ({ transform: `translateX(${px}px)` })),
      { duration: 360, easing: "ease-out" },
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBadCredentials(false);
    setLoading(true);
    try {
      const res = await api.login({ username: username.trim(), password, remember });
      onLoggedIn(res.me);
    } catch (err) {
      const unreachable = err instanceof ServerUnavailableError;
      setError(unreachable ? tr("serverUnreachable") : (err as Error).message);
      if (!unreachable) {
        setBadCredentials(true);
        shakePassword();
      }
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full px-3.5 py-2.5 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]";

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] px-4 py-5">
      <div className="max-w-md w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <span className="font-display text-lg leading-none">myClass</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggleLang}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            {lang === "el" ? "EN" : "ΕΛ"}
          </button>
          <button
            onClick={onToggleTheme}
            aria-label={tr("themeLabel")}
            className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center">
        <div className="max-w-md w-full mx-auto my-8 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{tr("loginTitle")}</h1>
          <p className="text-sm text-[var(--muted)] mt-1">{tr("loginSubtitle")}</p>

          <form onSubmit={handleSubmit} className="space-y-4 mt-6">
            <div>
              <label htmlFor="login-username" className="block text-xs font-medium mb-1.5">
                {tr("usernameLabel")}
              </label>
              <input
                id="login-username"
                type="text"
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium mb-1.5">
                {tr("passwordLabel")}
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                ref={passwordRef}
                value={password}
                aria-invalid={badCredentials || undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setBadCredentials(false);
                }}
                className={`${inputClass} ${badCredentials ? "border-[var(--danger)] focus:border-[var(--danger)]" : ""}`}
              />
            </div>

            <label className="flex items-center gap-2.5 text-sm text-[var(--muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-4 h-4 accent-[var(--accent)]"
              />
              <span>{tr("rememberLabel")}</span>
            </label>

            {error && (
              <div role="alert" className="p-3 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-[var(--accent)] text-[var(--on-accent)] font-medium text-sm hover:bg-[var(--accent-hover)] cursor-pointer disabled:opacity-50"
            >
              {loading ? tr("signingIn") : tr("signInBtn")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Home / Feed View                                                    */
/* ================================================================== */

function HomeView({
  lang,
  courses,
  catalogCount,
  announcements,
  triage,
  assignments,
  assignmentsLoading,
  messages,
  lastPollAt,
  onOpenCourse,
  onCheckSubmissions,
  onOpenEnrolledCourses,
  onOpenAllCourses,
  onOpenInbox,
  onOpenAssistant,
}: {
  lang: Lang;
  courses: Course[];
  catalogCount: number;
  announcements: Announcement[];
  triage: Record<string, AnnouncementTriage>;
  assignments: Assignment[];
  assignmentsLoading?: boolean;
  messages: Message[];
  lastPollAt?: string;
  onOpenCourse: (
    code: string,
    sub?: CourseSubTab,
    assignmentId?: string,
  ) => void;
  onCheckSubmissions?: (courseCodes: string[]) => Promise<void>;
  onOpenEnrolledCourses: () => void;
  onOpenAllCourses: () => void;
  onOpenInbox: () => void;
  onOpenAssistant: () => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const activeCourses = courses.filter((c) => !c.archived);
  const now = Date.now();
  // Deadlines in the next 7 days; handed-in ones count too, and the chip says how many are still open
  const dueThisWeek = assignments.filter(
    (a) => a.deadline && new Date(a.deadline).getTime() >= now && new Date(a.deadline).getTime() - now < 7 * 86_400_000,
  );
  const openThisWeek = dueThisWeek.filter((a) => !a.submitted).length;
  const unreadMessages = messages.filter((m) => !m.read);
  const [annFilter, setAnnFilter] = useState<"all" | "action" | "fyi">("all");
  const actionCount = announcements.filter((a) => triage[a.id]?.label === "action").length;
  const shownAnnouncements = (
    annFilter === "all" ? announcements : announcements.filter((a) => triage[a.id]?.label === annFilter)
  ).slice(0, 8);

  // Opened from the "Deadlines" app shortcut: bring the calendar into view
  const calendarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "calendar") {
      calendarRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  const chip =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] cursor-pointer";

  return (
    <div className="space-y-5">
      {/* Quick stats */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onOpenEnrolledCourses} className={chip}>
          <BookOpen className="w-3.5 h-3.5 text-[var(--muted)]" />
          {activeCourses.length} {lang === "el" ? "μαθήματα" : "courses"}
        </button>
        <span className={chip.replace("hover:border-[var(--accent)] cursor-pointer", "")}>
          <Clock className="w-3.5 h-3.5 text-[var(--warn)]" />
          {dueThisWeek.length} {lang === "el" ? (dueThisWeek.length === 1 ? "προθεσμία αυτή την εβδομάδα" : "προθεσμίες αυτή την εβδομάδα") : "due this week"}
          {openThisWeek < dueThisWeek.length && (
            <span className="ml-1 text-[var(--muted)] font-normal">
              · {dueThisWeek.length - openThisWeek}{" "}
              {lang === "el" ? (dueThisWeek.length - openThisWeek === 1 ? "παραδόθηκε" : "παραδόθηκαν") : "handed in"}
            </span>
          )}
        </span>
        {unreadMessages.length > 0 && (
          <button onClick={onOpenInbox} className={chip}>
            <Mail className="w-3.5 h-3.5 text-[var(--muted)]" />
            {unreadMessages.length} {lang === "el" ? "νέα μηνύματα" : "new messages"}
          </button>
        )}
        <button onClick={onOpenAssistant} className={chip}>
          <Bot className="w-3.5 h-3.5 text-[var(--muted)]" />
          {lang === "el" ? "Ρώτα τον βοηθό" : "Ask the assistant"}
        </button>
        {lastPollAt && (
          <span className="text-xs text-[var(--muted)] ml-auto">
            {lang === "el" ? "Ενημέρωση" : "Updated"}{" "}
            {new Date(lastPollAt).toLocaleTimeString(lang === "el" ? "el-GR" : "en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        {/* Calendar first on phones (deadlines are the most actionable), right column on desktop */}
        <div ref={calendarRef} className="xl:col-span-2 xl:order-2 space-y-5 scroll-mt-4">
          <DeadlineCalendar
            lang={lang}
            assignments={assignments}
            loading={assignmentsLoading}
            onOpenAssignment={(a) => onOpenCourse(a.courseCode, "assignments", a.id)}
            onCheckSubmissions={onCheckSubmissions}
          />

          {unreadMessages.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Mail className="w-4 h-4 text-[var(--muted)]" />
                <span>{tr("unreadMessages")}</span>
              </h2>
              {unreadMessages.slice(0, 4).map((m) => (
                <button
                  key={m.id}
                  onClick={onOpenInbox}
                  className="w-full text-left p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition-colors cursor-pointer"
                >
                  <div className="text-sm font-medium truncate">{m.subject}</div>
                  <div className="text-xs text-[var(--muted)] mt-0.5 truncate">
                    {m.sender} · {m.courseTitle ?? "eClass"}
                  </div>
                </button>
              ))}
            </section>
          )}
        </div>

        <section className="xl:col-span-3 xl:order-1 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--muted)]" />
              <span>{tr("recentAnnouncements")}</span>
            </h2>
            {announcements.length > 0 && (
              <Segmented
                value={annFilter}
                onChange={setAnnFilter}
                options={[
                  { value: "all", label: lang === "el" ? "Όλες" : "All" },
                  {
                    value: "action",
                    label: `${lang === "el" ? "Χρειάζεται ενέργεια" : "Action needed"}${actionCount ? ` ${actionCount}` : ""}`,
                  },
                  { value: "fyi", label: lang === "el" ? "Για ενημέρωση" : "FYI" },
                ]}
              />
            )}
          </div>
          <div className="space-y-2.5">
            {shownAnnouncements.length === 0 ? (
              <EmptyCard
                text={
                  annFilter === "action"
                    ? lang === "el"
                      ? "Καμία ανακοίνωση δεν ζητά κάτι από σένα."
                      : "No announcement asks anything of you."
                    : tr("noItems")
                }
              />
            ) : (
              shownAnnouncements.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenCourse(a.courseCode, "announcements")}
                  className="w-full text-left px-4 py-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition-colors cursor-pointer"
                >
                  {/* Home stays a glance: the title, then one line. The full text is a tap away. */}
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-semibold leading-snug truncate">{a.title}</div>
                    <span className="shrink-0 text-xs text-[var(--muted)] tabular-nums">
                      {new Date(a.date).toLocaleDateString(lang === "el" ? "el-GR" : "en-US", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </div>
                  {triage[a.id]?.label === "action" ? (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-[var(--warn)] min-w-0">
                      <CircleAlert className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">
                        {triage[a.id]?.reason ?? (lang === "el" ? "Χρειάζεται ενέργεια" : "Action needed")}
                        <span className="font-normal text-[var(--muted)]"> · {a.courseTitle ?? a.courseCode}</span>
                      </span>
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-[var(--muted)] truncate">
                      <span className="font-medium text-[var(--accent-text)]">{a.courseTitle ?? a.courseCode}</span>
                      {a.contentText ? ` · ${a.contentText}` : ""}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              onClick={onOpenAllCourses}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)] cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--muted)]" />
              {tr("coursesTitle")}
              {catalogCount > 0 && <span className="text-[var(--muted)]">{catalogCount}</span>}
            </button>
            <a
              href="/api/documents/zip-all"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]"
            >
              <Download className="w-3.5 h-3.5 text-[var(--muted)]" />
              {tr("downloadAllCourses")}
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Courses View — Minimalist Semester Dropdowns & Default Subscribed   */
/* ================================================================== */

/** Course groups in display order: latest semester first (Η' down to Α'), electives, postgraduate, then everything else. */
const SEMESTER_META: Array<{
  index: number;
  folder: string;
  labelEl: string;
  labelEn: string;
  /** Chip label in the phone's semester filter */
  shortEl: string;
  shortEn: string;
}> = [
  { index: 8, folder: "Η_Εξάμηνο", labelEl: "Η' Εξάμηνο", labelEn: "8th Semester", shortEl: "Η'", shortEn: "8th" },
  { index: 7, folder: "Ζ_Εξάμηνο", labelEl: "Ζ' Εξάμηνο", labelEn: "7th Semester", shortEl: "Ζ'", shortEn: "7th" },
  { index: 6, folder: "ΣΤ_Εξάμηνο", labelEl: "ΣΤ' Εξάμηνο", labelEn: "6th Semester", shortEl: "ΣΤ'", shortEn: "6th" },
  { index: 5, folder: "Ε_Εξάμηνο", labelEl: "Ε' Εξάμηνο", labelEn: "5th Semester", shortEl: "Ε'", shortEn: "5th" },
  { index: 4, folder: "Δ_Εξάμηνο", labelEl: "Δ' Εξάμηνο", labelEn: "4th Semester", shortEl: "Δ'", shortEn: "4th" },
  { index: 3, folder: "Γ_εξάμηνο", labelEl: "Γ' Εξάμηνο", labelEn: "3rd Semester", shortEl: "Γ'", shortEn: "3rd" },
  { index: 2, folder: "Β_εξάμηνο", labelEl: "Β' Εξάμηνο", labelEn: "2nd Semester", shortEl: "Β'", shortEn: "2nd" },
  { index: 1, folder: "Α_εξάμηνο", labelEl: "Α' Εξάμηνο", labelEn: "1st Semester", shortEl: "Α'", shortEn: "1st" },
  { index: 10, folder: "Επιλογής", labelEl: "Μαθήματα επιλογής", labelEn: "Electives", shortEl: "Επιλογής", shortEn: "Electives" },
  { index: 11, folder: "Μεταπτυχιακά", labelEl: "Μεταπτυχιακά", labelEn: "Postgraduate", shortEl: "Μεταπτυχιακά", shortEn: "Postgraduate" },
  { index: 9, folder: "Πτυχιακές_Γενικά", labelEl: "Γενικά & λοιπά", labelEn: "General & other", shortEl: "Λοιπά", shortEn: "Other" },
];
const semesterOrder = (idx: number) => {
  const i = SEMESTER_META.findIndex((m) => m.index === idx);
  return i === -1 ? SEMESTER_META.length : i;
};

/**
 * Joins a course on eClass. Courses with a registration code (given by the teacher; without
 * joining, eClass shows none of their files) open a small dialog that asks for it first, or
 * again after eClass turns a code down.
 */
function useJoinCourse({
  lang,
  showToast,
  onJoined,
}: {
  lang: Lang;
  showToast: (m: string) => void;
  onJoined: () => Promise<void>;
}) {
  const [ask, setAsk] = useState<{ code: string; title: string; wrongAttempt: number } | null>(null);

  const join = async (c: { code: string; title: string; needsPassword?: boolean }, password?: string) => {
    if (c.needsPassword && password === undefined) {
      setAsk({ code: c.code, title: c.title, wrongAttempt: 0 });
      return;
    }
    try {
      await api.enroll(c.code, password);
      setAsk(null);
      showToast(lang === "el" ? `Εγγράφηκες στο ${c.title}` : `Joined ${c.title}`);
      await onJoined();
    } catch (err) {
      if (err instanceof ApiError && err.code?.startsWith("password_")) {
        const wrong = err.code === "password_wrong";
        setAsk((prev) => ({ code: c.code, title: c.title, wrongAttempt: (prev?.wrongAttempt ?? 0) + (wrong ? 1 : 0) }));
        return;
      }
      showToast((err as Error).message);
    }
  };

  const dialog = ask ? (
    <CourseCodeDialog
      key={ask.code}
      lang={lang}
      title={ask.title}
      wrongAttempt={ask.wrongAttempt}
      onSubmit={(pw) => join({ code: ask.code, title: ask.title }, pw)}
      onClose={() => setAsk(null)}
    />
  ) : null;

  return { join, dialog, askCode: (c: { code: string; title: string }) => setAsk({ ...c, wrongAttempt: 0 }) };
}

function CourseCodeDialog({
  lang,
  title,
  wrongAttempt,
  onSubmit,
  onClose,
}: {
  lang: Lang;
  title: string;
  wrongAttempt: number;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrong = wrongAttempt > 0;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Wrong code: shake the field and select it for retyping (once per refused attempt)
  useEffect(() => {
    if (!wrongAttempt) return;
    const el = inputRef.current;
    el?.select();
    if (!el || reducedMotion()) return;
    el.animate(
      [0, -10, 10, -6, 6, -3, 0].map((px) => ({ transform: `translateX(${px}px)` })),
      { duration: 360, easing: "ease-out" },
    );
  }, [wrongAttempt]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-code-title"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value.trim() || busy) return;
          setBusy(true);
          try {
            await onSubmit(value.trim());
          } finally {
            setBusy(false);
          }
        }}
        className="enter w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 mb-[env(safe-area-inset-bottom)]"
      >
        <div className="space-y-1">
          <h2 id="course-code-title" className="text-base">
            {lang === "el" ? "Κωδικός μαθήματος" : "Course code"}
          </h2>
          <p className="text-sm text-[var(--muted)]">
            {lang === "el"
              ? `Το «${title}» ζητά κωδικό εγγραφής για να δεις τα αρχεία του. Τον δίνει ο διδάσκων.`
              : `"${title}" asks for a registration code before its files open. Your teacher gives it out.`}
          </p>
        </div>
        <div className="space-y-1.5">
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={wrong || undefined}
            aria-describedby={wrong ? "course-code-error" : undefined}
            placeholder={lang === "el" ? "Κωδικός" : "Code"}
            className={`w-full px-3 py-2.5 rounded-xl text-sm bg-[var(--surface-2)] border focus:outline-none ${
              wrong ? "border-[var(--danger)]" : "border-[var(--border)] focus:border-[var(--accent)]"
            }`}
          />
          {wrong && (
            <p id="course-code-error" className="text-xs text-[var(--danger)]">
              {lang === "el" ? "Λάθος κωδικός. Δοκίμασε ξανά." : "That code didn't work. Try again."}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-xl text-sm text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
          >
            {lang === "el" ? "Άκυρο" : "Cancel"}
          </button>
          <button
            type="submit"
            disabled={!value.trim() || busy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            {busy && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {lang === "el" ? "Εγγραφή" : "Join"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** eClass titles typed in capitals ("ΑΝΑΓΝΩΡΙΣΗ ΠΡΟΤΥΠΩΝ") get a little extra letter spacing. */
const isAllCaps = (s: string) => /\p{Lu}/u.test(s) && s === s.toLocaleUpperCase("el");

function CoursesView({
  lang,
  courses,
  catalog,
  departments = [],
  activeDepartment = "",
  onChangeDepartment = async () => {},
  catalogLoading,
  warnings = [],
  syncing = false,
  initialViewMode = "enrolled",
  onSelectCourse,
  onChanged,
  showToast,
  pinned = [],
  onTogglePin,
}: {
  lang: Lang;
  courses: Course[];
  catalog: CatalogCourse[];
  departments?: DepartmentInfo[];
  activeDepartment?: string;
  catalogLoading: boolean;
  warnings?: PortalWarning[];
  syncing?: boolean;
  initialViewMode?: "enrolled" | "all";
  onChangeDepartment?: (deptId: string) => Promise<void>;
  onSelectCourse: (code: string, sub?: CourseSubTab) => void;
  onChanged: () => Promise<void>;
  showToast: (m: string) => void;
  /** Course codes pinned to the top, in pin order. */
  pinned?: string[];
  onTogglePin?: (code: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  // Default view is the classes the student is subscribed to ("enrolled")
  const [viewMode, setViewMode] = useState<"enrolled" | "all">(initialViewMode);
  const [selectedSemester, setSelectedSemester] = useState<number | "all">("all");
  const [collapsedSemesters, setCollapsedSemesters] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const { join, dialog: courseCodeDialog } = useJoinCourse({ lang, showToast, onJoined: onChanged });
  /** Phone: the course whose long-press menu is open */
  const [sheetCourse, setSheetCourse] = useState<CatalogCourse | null>(null);
  // The pinned group can be folded away; remembered on this device
  const [pinnedOpen, setPinnedOpen] = useState(() => {
    try {
      return localStorage.getItem(PINNED_FOLDED_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const togglePinnedOpen = () =>
    setPinnedOpen((open) => {
      try {
        localStorage.setItem(PINNED_FOLDED_KEY, open ? "1" : "0");
      } catch {
        /* private mode: the fold just isn't remembered */
      }
      return !open;
    });

  const leave = async (c: CatalogCourse) => {
    const ok = window.confirm(
      lang === "el" ? `Απεγγραφή από το μάθημα «${c.title}» στο eClass;` : `Unenroll from "${c.title}" on eClass?`,
    );
    if (!ok) return;
    setBusyCode(c.code);
    try {
      await api.unenroll(c.code);
      showToast(lang === "el" ? `Απεγγράφηκες από ${c.title}` : `Unenrolled from ${c.title}`);
      await onChanged();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusyCode(null);
    }
  };
  const enroll = async (c: CatalogCourse) => {
    setBusyCode(c.code);
    try {
      await join(c);
    } finally {
      setBusyCode(null);
    }
  };

  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  const enrolledCourses = useMemo(() => courses.filter((c) => !c.archived), [courses]);
  const enrolledCodes = useMemo(() => new Set(courses.map((c) => c.code)), [courses]);

  // Build unified list of subjects with semester & enrollment status
  const sourceSubjects: CatalogCourse[] = useMemo(() => {
    if (viewMode === "enrolled") {
      return enrolledCourses.map((c) => ({
        code: c.code,
        publicCode: c.publicCode ?? c.code,
        title: c.title,
        professor: c.professor,
        semester: c.semester,
        semesterIndex: c.semesterIndex ?? 9,
        semesterFolder: c.semesterFolder ?? "Γενικά",
        departmentId: c.departmentId,
        departmentName: c.departmentName,
        url: c.url,
        portal: c.portal,
        enrolled: true,
      }));
    }
    if (catalog.length > 0) {
      return catalog.map((c) => ({
        ...c,
        enrolled: enrolledCodes.has(c.code) || c.enrolled,
      }));
    }
    return enrolledCourses.map((c) => ({
      code: c.code,
      publicCode: c.publicCode ?? c.code,
      title: c.title,
      professor: c.professor,
      semester: c.semester,
      semesterIndex: c.semesterIndex ?? 9,
      semesterFolder: c.semesterFolder ?? "Πτυχιακές_Γενικά",
      url: c.url,
      portal: c.portal,
      enrolled: true,
    }));
  }, [viewMode, catalog, enrolledCourses, enrolledCodes]);

  // Filter by search query and selected semester
  const searchMatched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sourceSubjects.filter((s) => {
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        (s.publicCode ?? "").toLowerCase().includes(q) ||
        (s.professor ?? "").toLowerCase().includes(q) ||
        (s.semester ?? "").toLowerCase().includes(q) ||
        (s.semesterFolder ?? "").toLowerCase().includes(q)
      );
    });
  }, [sourceSubjects, searchQuery]);

  // Pinned courses sit above the semesters, in pin order. The search narrows them; the semester
  // filter does not (pinned means "always on top").
  const pinnedSubjects = useMemo(
    () =>
      pinned
        .map((code) => searchMatched.find((s) => s.code === code))
        .filter((s): s is CatalogCourse => Boolean(s)),
    [pinned, searchMatched],
  );
  const pinnedShown = useMemo(() => new Set(pinnedSubjects.map((s) => s.code)), [pinnedSubjects]);

  const filteredSubjects = useMemo(
    () =>
      searchMatched.filter(
        (s) =>
          !pinnedShown.has(s.code) && (selectedSemester === "all" || (s.semesterIndex ?? 9) === selectedSemester),
      ),
    [searchMatched, pinnedShown, selectedSemester],
  );

  // Count per semester for dropdown options
  const semesterCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const s of sourceSubjects) {
      const idx = s.semesterIndex ?? 9;
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    return counts;
  }, [sourceSubjects]);

  // Group filtered subjects by semesterIndex (1..8, 9)
  const groupedBySemester = useMemo(() => {
    const map = new Map<number, CatalogCourse[]>();
    for (const s of filteredSubjects) {
      const idx = s.semesterIndex ?? 9;
      const list = map.get(idx) ?? [];
      list.push(s);
      map.set(idx, list);
    }
    return [...map.entries()].sort((a, b) => semesterOrder(a[0]) - semesterOrder(b[0]));
  }, [filteredSubjects]);

  // A semester filter that no longer exists (e.g. after switching department) would show an empty page
  useEffect(() => {
    if (selectedSemester !== "all" && !semesterCounts.has(selectedSemester) && sourceSubjects.length > 0) {
      setSelectedSemester("all");
    }
  }, [selectedSemester, semesterCounts, sourceSubjects.length]);

  const toggleSemesterAccordion = (semIndex: number) => {
    setCollapsedSemesters((prev) => {
      const next = new Set(prev);
      if (next.has(semIndex)) {
        next.delete(semIndex);
      } else {
        next.add(semIndex);
      }
      return next;
    });
  };

  /** Collapse-all and download-all: in the toolbar on wider screens; on a phone collapse-all sits beside the semester chips. */
  const listActions = (
    <>
      {groupedBySemester.length > 1 && (
        <button
          onClick={() => {
            const allCollapsed = groupedBySemester.every(([idx]) => collapsedSemesters.has(idx));
            setCollapsedSemesters(allCollapsed ? new Set() : new Set(groupedBySemester.map(([idx]) => idx)));
          }}
          title={
            groupedBySemester.every(([idx]) => collapsedSemesters.has(idx))
              ? lang === "el" ? "Ανάπτυξη όλων" : "Expand all"
              : lang === "el" ? "Σύμπτυξη όλων" : "Collapse all"
          }
          className="p-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer shrink-0"
        >
          <ChevronDown
            className={`w-4 h-4 transition-colors ${
              groupedBySemester.every(([idx]) => collapsedSemesters.has(idx)) ? "" : "rotate-180"
            }`}
          />
        </button>
      )}
      <a
        href="/api/documents/zip-all"
        title={tr("downloadAllCourses")}
        aria-label={tr("downloadAllCourses")}
        className="hidden sm:block p-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)] hover:border-[var(--accent)] shrink-0"
      >
        <Download className="w-4 h-4" />
      </a>
    </>
  );

  return (
    <div className="flex-1 flex flex-col gap-4">
      {courseCodeDialog}
      {/* One compact toolbar: My courses / All, search, department, semester, actions */}
      <div className="flex flex-col xl:flex-row xl:items-center gap-2">
        <div className="flex sm:inline-flex sm:self-start rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 shrink-0">
          {(
            [
              ["enrolled", tr("viewEnrolledOnly"), enrolledCourses.length],
              ["all", tr("viewAllSemesters"), catalog.length],
            ] as const
          ).map(([mode, label, count]) => (
            <button
              key={mode}
              onClick={() => {
                setViewMode(mode);
                setSelectedSemester("all");
              }}
              className={`flex-1 sm:flex-none px-3 py-2 sm:py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                viewMode === mode
                  ? "bg-[var(--accent)] text-[var(--on-accent)]"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {label}
              <span className="ml-1.5 text-xs opacity-70">{count}</span>
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-[var(--muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr("searchCatalogPlaceholder")}
            className="w-full pl-9 pr-8 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div
          className={`${viewMode === "all" && departments.length > 0 ? "flex" : "hidden sm:flex"} items-center justify-end gap-2`}
        >
          {viewMode === "all" && departments.length > 0 && (
            <div className="relative flex-1 xl:flex-none xl:w-60 min-w-0">
              <select
                aria-label={tr("departmentLabel")}
                value={activeDepartment}
                onChange={(e) => void onChangeDepartment(e.target.value)}
                className="w-full pl-3 pr-8 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] cursor-pointer appearance-none truncate"
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {lang === "el" ? d.name : d.nameEn}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--muted)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}

          {/* Phones pick the semester from the chips below; wider screens keep the compact select */}
          <div className="relative hidden sm:block flex-1 xl:flex-none xl:w-48 min-w-0">
            <select
              aria-label={lang === "el" ? "Εξάμηνο" : "Semester"}
              value={selectedSemester === "all" ? "all" : String(selectedSemester)}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "all") {
                  setSelectedSemester("all");
                } else {
                  const num = Number(val);
                  setSelectedSemester(num);
                  setCollapsedSemesters((prev) => {
                    const next = new Set(prev);
                    next.delete(num);
                    return next;
                  });
                }
              }}
              className="w-full pl-3 pr-8 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] cursor-pointer appearance-none"
            >
              <option value="all">
                {tr("allSemestersFilter")} ({sourceSubjects.length})
              </option>
              {SEMESTER_META.map((sem) => {
                const count = semesterCounts.get(sem.index) ?? 0;
                if (count === 0) return null;
                return (
                  <option key={sem.index} value={sem.index}>
                    {lang === "el" ? sem.labelEl : sem.labelEn} · {count}
                  </option>
                );
              })}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-[var(--muted)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          <div className="hidden sm:contents">{listActions}</div>
        </div>

        {/* Phone semester filter: one row of chips, scrolls sideways when it runs out of room */}
        {sourceSubjects.length > 0 && (
          <div className="sm:hidden flex items-center gap-2">
            <div
              role="radiogroup"
              aria-label={lang === "el" ? "Εξάμηνο" : "Semester"}
              className="flex-1 min-w-0 -ml-4 pl-4 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {[
                { value: "all" as const, label: lang === "el" ? "Όλα" : "All", count: sourceSubjects.length },
                ...SEMESTER_META.filter((m) => (semesterCounts.get(m.index) ?? 0) > 0).map((m) => ({
                  value: m.index,
                  label: lang === "el" ? m.shortEl : m.shortEn,
                  count: semesterCounts.get(m.index) ?? 0,
                })),
              ].map((chip) => {
                const on = selectedSemester === chip.value;
                return (
                  <button
                    key={chip.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setSelectedSemester(chip.value);
                      if (chip.value !== "all") {
                        setCollapsedSemesters((prev) => {
                          const next = new Set(prev);
                          next.delete(chip.value as number);
                          return next;
                        });
                      }
                    }}
                    className={`shrink-0 inline-flex items-baseline gap-1.5 h-9 px-3.5 rounded-full border text-sm font-medium transition-colors cursor-pointer ${
                      on
                        ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent-text)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]"
                    }`}
                  >
                    <span className="self-center">{chip.label}</span>
                    <span className="self-center text-xs tabular-nums opacity-75">{chip.count}</span>
                  </button>
                );
              })}
            </div>
            {listActions}
          </div>
        )}
      </div>

      {/* Collapsible Minimalist Semester Dropdowns & Subject Rows */}
      {catalogLoading ? (
        <div className="p-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center gap-2 text-xs text-[var(--muted)]">
          <RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>
            {lang === "el"
              ? "Φόρτωση..."
              : "Loading..."}
          </span>
        </div>
      ) : groupedBySemester.length === 0 && pinnedSubjects.length === 0 ? (
        <div className="p-8 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 text-center space-y-3">
          <p className="text-sm text-[var(--muted)]">
            {viewMode === "enrolled" && enrolledCourses.length === 0
              ? syncing
                ? lang === "el"
                  ? "Φόρτωση μαθημάτων από το eClass…"
                  : "Loading your courses from eClass…"
                : lang === "el"
                  ? "Δεν βρέθηκαν εγγεγραμμένα μαθήματα."
                  : "No subscribed classes found."
              : tr("noItems")}
          </p>
          {viewMode === "enrolled" && !syncing && warnings.length > 0 && (
            <div className="max-w-lg mx-auto text-left space-y-1.5">
              {warnings.map((w) => (
                <p
                  key={w.portal}
                  className="text-xs rounded-lg px-3 py-2 bg-[var(--warn-soft)] text-[var(--warn)]"
                >
                  <span className="font-semibold">{w.portal}:</span> {w.message}
                </p>
              ))}
            </div>
          )}
          {viewMode === "enrolled" && (
            <button
              onClick={() => setViewMode("all")}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>
                {tr("viewAllSemesters")} ({catalog.length})
              </span>
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {pinnedSubjects.length > 0 && (
            <section aria-labelledby="pinned-courses-title" className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <button
                type="button"
                onClick={togglePinnedOpen}
                aria-expanded={pinnedOpen}
                className="w-full px-4 py-3 flex items-center gap-2.5 text-left hover:bg-[var(--surface-2)] cursor-pointer"
              >
                <Pin className="w-4 h-4 text-[var(--accent)] shrink-0" />
                <span id="pinned-courses-title" className="font-display text-[0.9375rem] font-semibold">
                  {lang === "el" ? "Καρφιτσωμένα" : "Pinned"}
                </span>
                <span className="text-xs text-[var(--muted)] tabular-nums">{pinnedSubjects.length}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--muted)]">
                  <span className="hidden sm:inline">
                    {pinnedOpen ? (lang === "el" ? "Ελαχιστοποίηση" : "Minimize") : lang === "el" ? "Εμφάνιση" : "Show"}
                  </span>
                  <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${pinnedOpen ? "rotate-180" : ""}`} />
                </span>
              </button>
              <div className="accordion" data-open={pinnedOpen} inert={!pinnedOpen}>
                <ul className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
                  {pinnedSubjects.map((c) => (
                    <CourseRow
                      key={c.code}
                      lang={lang}
                      course={c}
                      showEnrolledMark={viewMode === "all"}
                      pinned
                      busy={busyCode === c.code}
                      onOpen={() => onSelectCourse(c.code, "documents")}
                      onTogglePin={onTogglePin ? () => onTogglePin(c.code) : undefined}
                      onLeave={() => void leave(c)}
                      onJoin={() => void enroll(c)}
                      onLongPress={() => setSheetCourse(c)}
                    />
                  ))}
                </ul>
              </div>
            </section>
          )}

          {groupedBySemester.map(([semIndex, list]) => {
            const meta = SEMESTER_META.find((m) => m.index === semIndex) ?? SEMESTER_META[SEMESTER_META.length - 1];
            const isOpen = !collapsedSemesters.has(semIndex);
            return (
              <section key={semIndex} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="flex items-center gap-2 pr-2 hover:bg-[var(--surface-2)]">
                  <button
                    type="button"
                    onClick={() => toggleSemesterAccordion(semIndex)}
                    aria-expanded={isOpen}
                    className="flex-1 min-w-0 pl-4 py-3 flex items-center gap-2.5 text-left cursor-pointer"
                  >
                    <ChevronRight
                      className={`w-4 h-4 text-[var(--muted)] shrink-0 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
                    />
                    <span className="font-display text-[0.9375rem] font-semibold truncate">
                      {lang === "el" ? meta.labelEl : meta.labelEn}
                    </span>
                    <span className="text-xs text-[var(--muted)] tabular-nums">{list.length}</span>
                  </button>
                  <span className="hidden sm:inline-flex">
                    <IconButton
                      label={`${tr("downloadSemesterZip")} (${meta.folder}.zip)`}
                      href={`/api/documents/zip-all?semester=${semIndex}`}
                      tooltipSide="left"
                    >
                      <Download className="w-4 h-4" />
                    </IconButton>
                  </span>
                </div>
                <div className="accordion" data-open={isOpen} inert={!isOpen}>
                  <ul className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
                    {list.map((c) => (
                      <CourseRow
                        key={c.code}
                        lang={lang}
                        course={c}
                        showEnrolledMark={viewMode === "all"}
                        pinned={false}
                        busy={busyCode === c.code}
                        onOpen={() => onSelectCourse(c.code, "documents")}
                        onTogglePin={onTogglePin && c.enrolled ? () => onTogglePin(c.code) : undefined}
                        onLeave={() => void leave(c)}
                        onJoin={() => void enroll(c)}
                        onLongPress={() => setSheetCourse(c)}
                      />
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}

          {pinned.length === 0 && onTogglePin && viewMode === "enrolled" && (
            <p className="sm:hidden text-xs text-[var(--muted)] text-center px-4">
              {lang === "el"
                ? "Κράτα πατημένο ένα μάθημα για να το καρφιτσώσεις στην κορυφή."
                : "Press and hold a course to pin it to the top."}
            </p>
          )}
        </div>
      )}

      {sheetCourse && (
        <CourseActionSheet
          lang={lang}
          course={sheetCourse}
          pinned={pinned.includes(sheetCourse.code)}
          onClose={() => setSheetCourse(null)}
          onTogglePin={onTogglePin && sheetCourse.enrolled ? () => onTogglePin(sheetCourse.code) : undefined}
          onOpen={() => onSelectCourse(sheetCourse.code, "documents")}
          onOpenStarred={() => onSelectCourse(sheetCourse.code, "starred")}
          onLeave={() => void leave(sheetCourse)}
          onJoin={() => void enroll(sheetCourse)}
        />
      )}
    </div>
  );
}

/* ================================================================== */
/* Courses list pieces: a row, its long-press menu (phones)            */
/* ================================================================== */

const PINNED_FOLDED_KEY = "myclass.pinnedFolded";

/**
 * Touch press-and-hold. Fires once after `ms` if the finger stays put (a scroll or swipe cancels
 * it), and swallows the click that follows so the row doesn't also open. Mouse is left alone.
 */
function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const touch = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      touch.current = e.pointerType !== "mouse";
      fired.current = false;
      if (!touch.current) return;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        navigator.vibrate?.(10);
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    // Android opens its own menu on a long touch; the course menu replaces it
    onContextMenu: (e: React.MouseEvent) => {
      if (touch.current) e.preventDefault();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

function CourseRow({
  lang,
  course: c,
  showEnrolledMark,
  pinned,
  busy,
  onOpen,
  onTogglePin,
  onLeave,
  onJoin,
  onLongPress,
}: {
  lang: Lang;
  course: CatalogCourse;
  showEnrolledMark: boolean;
  pinned: boolean;
  busy: boolean;
  onOpen: () => void;
  onTogglePin?: () => void;
  onLeave: () => void;
  onJoin: () => void;
  onLongPress: () => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const press = useLongPress(onLongPress);
  return (
    <li className="group flex items-center gap-2 pl-4 pr-2 hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)] sm:active:bg-[var(--surface-2)]">
      {/* Title on its own line; code and teacher share a quiet second line */}
      <button
        type="button"
        onClick={onOpen}
        {...press}
        className="long-press min-w-0 flex-1 py-3 text-left cursor-pointer rounded-md"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className={`text-[0.9375rem] leading-snug font-medium text-[var(--text)] group-hover:text-[var(--accent-text)] line-clamp-2 sm:line-clamp-1 ${
              isAllCaps(c.title) ? "caps-title" : ""
            }`}
          >
            {c.title}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--muted)] min-w-0">
          {c.enrolled && showEnrolledMark && (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[var(--ok)]" aria-label={tr("enrolledBadge")} />
          )}
          <span className="font-mono shrink-0">{c.publicCode ?? c.code}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{c.professor || (lang === "el" ? "Διδάσκων Τμήματος" : "Department Instructor")}</span>
        </span>
      </button>

      {/* Desktop: quiet icon actions. Phones: join stays (the main action in "All"); the rest is in the long-press menu */}
      <div className="flex items-center gap-0.5 shrink-0">
        {onTogglePin && (
          <span className="hidden sm:inline-flex">
            <IconButton
              label={pinned ? (lang === "el" ? "Ξεκαρφίτσωμα" : "Unpin") : lang === "el" ? "Καρφίτσωμα στην κορυφή" : "Pin to top"}
              onClick={onTogglePin}
              active={pinned}
              pressed={pinned}
              tooltipSide="left"
            >
              {pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
            </IconButton>
          </span>
        )}
        <span className="hidden sm:inline-flex">
          <IconButton
            label={tr("downloadCourseZip")}
            href={`/api/courses/${encodeURIComponent(c.code)}/documents/zip`}
            tooltipSide="left"
          >
            <Download className="w-4 h-4" />
          </IconButton>
        </span>
        {c.enrolled ? (
          <span className="hidden sm:inline-flex">
            <IconButton label={tr("unenrollCourse")} onClick={onLeave} disabled={busy} tone="danger" tooltipSide="left">
              <UserMinus className="w-4 h-4" />
            </IconButton>
          </span>
        ) : (
          <button
            type="button"
            disabled={busy || c.locked}
            onClick={onJoin}
            title={
              c.locked
                ? lang === "el" ? "Οι εγγραφές είναι κλειστές" : "Registration is closed"
                : c.needsPassword
                  ? lang === "el" ? "Θέλει κωδικό εγγραφής" : "Needs a registration code"
                  : undefined
            }
            aria-label={tr("enrollBtn")}
            className="inline-flex items-center justify-center gap-1.5 w-9 h-9 sm:w-auto sm:h-8 sm:px-3 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent-text)] cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {busy ? (
              <RefreshCw className="w-4 h-4 sm:w-3.5 sm:h-3.5 animate-spin" />
            ) : c.needsPassword ? (
              <KeyRound className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            ) : (
              <UserPlus className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            )}
            <span className="hidden sm:inline">{tr("enrollBtn")}</span>
          </button>
        )}
      </div>
    </li>
  );
}

/** Phone menu for one course, opened by pressing and holding its row. */
function CourseActionSheet({
  lang,
  course: c,
  pinned,
  onClose,
  onTogglePin,
  onOpen,
  onOpenStarred,
  onLeave,
  onJoin,
}: {
  lang: Lang;
  course: CatalogCourse;
  pinned: boolean;
  onClose: () => void;
  onTogglePin?: () => void;
  onOpen: () => void;
  onOpenStarred: () => void;
  onLeave: () => void;
  onJoin: () => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const item = "w-full flex items-center gap-3 px-4 min-h-12 py-2 rounded-xl text-[0.9375rem] text-left cursor-pointer hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]";
  return createPortal(
    <div
      className="overlay-in fixed inset-0 z-[70] flex items-end bg-black/55"
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-sheet-title"
        className="sheet-up w-full rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--border)]" />
        <div className="px-4 pb-3 mb-1 border-b border-[var(--border)]">
          <h2 id="course-sheet-title" className="text-base leading-snug line-clamp-2">
            {c.title}
          </h2>
          <p className="text-xs text-[var(--muted)] mt-0.5 truncate">
            <span className="font-mono">{c.publicCode ?? c.code}</span>
            {c.professor ? ` · ${c.professor}` : ""}
          </p>
        </div>
        {onTogglePin && (
          <button ref={firstRef} type="button" onClick={run(onTogglePin)} className={item}>
            {pinned ? <PinOff className="w-5 h-5 text-[var(--muted)]" /> : <Pin className="w-5 h-5 text-[var(--muted)]" />}
            {pinned ? (lang === "el" ? "Ξεκαρφίτσωμα" : "Unpin") : lang === "el" ? "Καρφίτσωμα στην κορυφή" : "Pin to top"}
          </button>
        )}
        <button ref={onTogglePin ? undefined : firstRef} type="button" onClick={run(onOpen)} className={item}>
          <FolderOpen className="w-5 h-5 text-[var(--muted)]" />
          {lang === "el" ? "Άνοιγμα μαθήματος" : "Open course"}
        </button>
        {c.enrolled && (
          <button type="button" onClick={run(onOpenStarred)} className={item}>
            <Star className="w-5 h-5 text-[var(--muted)]" />
            {lang === "el" ? "Επισημασμένα αρχεία" : "Highlighted files"}
          </button>
        )}
        <a href={`/api/courses/${encodeURIComponent(c.code)}/documents/zip`} onClick={onClose} className={item}>
          <Download className="w-5 h-5 text-[var(--muted)]" />
          {lang === "el" ? "Λήψη αρχείων (.zip)" : "Download files (.zip)"}
        </a>
        {c.enrolled ? (
          <button type="button" onClick={run(onLeave)} className={`${item} text-[var(--danger)]`}>
            <UserMinus className="w-5 h-5" />
            {tr("unenrollCourse")}
          </button>
        ) : (
          <button type="button" disabled={c.locked} onClick={run(onJoin)} className={`${item} disabled:opacity-40`}>
            {c.needsPassword ? <KeyRound className="w-5 h-5 text-[var(--muted)]" /> : <UserPlus className="w-5 h-5 text-[var(--muted)]" />}
            {tr("enrollBtn")}
          </button>
        )}
        <button type="button" onClick={onClose} className={`${item} justify-center mt-1 font-medium text-[var(--muted)]`}>
          {lang === "el" ? "Άκυρο" : "Cancel"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ================================================================== */
/* Course documents: one file row, and the AI search icon              */
/* ================================================================== */

/** A magnifier with a small star on it: search that the AI does. */
function AiSearchIcon({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`relative inline-flex w-4 h-4 ${className}`}>
      <Search className="w-4 h-4" />
      <Sparkle className="absolute -top-1 -right-1 w-2.5 h-2.5 fill-current text-[var(--accent)]" strokeWidth={2.5} />
    </span>
  );
}

function formatDocSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * One course file: the name opens the preview window (download is there); summary, study and the
 * star (highlight as important) sit at the end.
 */
function DocFileRow({
  lang,
  courseCode,
  node,
  detail,
  onOpen,
  starred,
  onToggleStar,
}: {
  lang: Lang;
  courseCode: string;
  node: DocNode;
  /** Second line instead of size and date (search results: folder and why it matches). */
  detail?: string;
  onOpen: (tab: DocTab) => void;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const starRef = useRef<HTMLSpanElement>(null);
  return (
    <div className="group pl-4 pr-2 sm:pr-3 py-2.5 flex items-center gap-3 hover:bg-[var(--surface-2)]">
      <button
        type="button"
        onClick={() => onOpen("preview")}
        title={lang === "el" ? "Προεπισκόπηση" : "Preview"}
        className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer rounded-md"
      >
        <FileText className="w-[1.125rem] h-[1.125rem] text-[var(--muted)] shrink-0" />
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-snug break-words line-clamp-2 group-hover:text-[var(--accent-text)]">
            {node.name}
          </span>
          <span className="block text-xs text-[var(--muted)] mt-0.5 line-clamp-2">
            {detail ?? [formatDocSize(node.size), node.date].filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        {/* Phones: summary and study are tabs in the file window, so the name keeps the room */}
        {aiReadable(node.name) && (
          <span className="hidden sm:contents">
            <DocumentSummaryButton lang={lang} courseCode={courseCode} path={node.path} open={false} onToggle={() => onOpen("summary")} />
            <StudyButton lang={lang} open={false} onToggle={() => onOpen("study")} />
          </span>
        )}
        <IconButton
          label={starred ? (lang === "el" ? "Αφαίρεση επισήμανσης" : "Remove highlight") : lang === "el" ? "Επισήμανση ως σημαντικό" : "Highlight as important"}
          pressed={starred}
          tooltipSide="left"
          onClick={() => {
            // Turning on: the star gives a small pop
            if (!starred && !reducedMotion()) {
              starRef.current?.animate([{ scale: 1 }, { scale: 1.3 }, { scale: 1 }], { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
            }
            onToggleStar();
          }}
        >
          <span ref={starRef} className="inline-flex">
            <Star className={`w-4 h-4 ${starred ? "fill-[var(--star)] text-[var(--star)]" : ""}`} />
          </span>
        </IconButton>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Course Detail View (Announcements · Documents · Assignments · Info) */
/* ================================================================== */

function CourseDetailView({
  lang,
  course,
  subTab,
  onChangeSubTab,
  announcements,
  triage,
  onMeChanged,
  assignments,
  onAssignmentsLoaded,
  focusAssignmentId,
  onOpenInbox,
  onBack,
  onEnrolledOrUnenrolled,
  showToast,
  starred,
  onToggleStar,
}: {
  lang: Lang;
  course: Course;
  triage: Record<string, AnnouncementTriage>;
  onMeChanged: (m: Me) => void;
  subTab: CourseSubTab;
  onChangeSubTab: (t: CourseSubTab) => void;
  /** This course's starred files, newest first. */
  starred: StarredFile[];
  onToggleStar: (courseCode: string, node: DocNode, folder: string) => void;
  announcements: Announcement[];
  assignments: Assignment[];
  /** The course page told which assignments were handed in: Home and the calendar learn it too. */
  onAssignmentsLoaded?: (courseCode: string, list: Assignment[]) => void;
  focusAssignmentId?: string | null;
  onOpenInbox: () => void;
  onBack: () => void;
  onEnrolledOrUnenrolled: () => Promise<void>;
  showToast: (m: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const { join, dialog: courseCodeDialog, askCode } = useJoinCourse({ lang, showToast, onJoined: onEnrolledOrUnenrolled });
  const [dir, setDirPath] = useState("/");
  /** Names of the folders from the top down to `dir` */
  const [dirTrail, setDirTrail] = useState<string[]>([]);
  const setDir = (path: string, name?: string) => {
    setDirPath(path);
    setDirTrail((trail) => (path === "/" ? [] : name ? [...trail, name] : trail.slice(0, -1)));
  };
  const folderLabel = dirTrail.join(" / ");
  const starredPaths = useMemo(() => new Set(starred.map((f) => f.path)), [starred]);
  const [docs, setDocs] = useState<DocNode[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [courseAnnouncements, setCourseAnnouncements] = useState<Announcement[]>(announcements);
  const [annLoading, setAnnLoading] = useState(false);
  const [openAssignmentId, setOpenAssignmentId] = useState<string | null>(focusAssignmentId ?? null);
  /** The file open in the document window, and which of its tabs */
  const [viewer, setViewer] = useState<{ node: DocNode; tab: DocTab } | null>(null);
  // AI file search over the whole course (Documents header, magnifier at the end)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocumentSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRun = useRef(0);
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const closeSearch = () => {
    searchRun.current++;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults(null);
    setSearchError(null);
    setSearching(false);
  };
  const runSearch = async () => {
    const q = searchQuery.trim();
    if (q.length < 2 || searching) return;
    const run = ++searchRun.current;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.searchDocuments(course.code, q);
      if (run === searchRun.current) setSearchResults(res);
    } catch (err) {
      if (run === searchRun.current) {
        setSearchResults(null);
        setSearchError((err as Error).message);
      }
    } finally {
      if (run === searchRun.current) setSearching(false);
    }
  };
  const [courseAssignments, setCourseAssignments] = useState<Assignment[]>(assignments);
  const [asgLoading, setAsgLoading] = useState(false);

  useEffect(() => {
    setDir("/");
    setViewer(null);
    closeSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.code]);

  useEffect(() => {
    if (focusAssignmentId) setOpenAssignmentId(focusAssignmentId);
  }, [focusAssignmentId]);

  // Until the tab is opened, show what Home already knows (from eClass' calendar feed)
  useEffect(() => {
    if (assignments.length > 0) setCourseAssignments(assignments);
  }, [assignments]);

  // Opening the Assignments tab reads the course's own assignment page: the one place eClass says
  // what was handed in and graded. It is the student's own visit, so eClass logging it is right.
  useEffect(() => {
    if (subTab !== "assignments") return;
    let cancelled = false;
    setAsgLoading(true);
    void api
      .assignments(course.code)
      .then((r) => {
        if (cancelled) return;
        setCourseAssignments(r.assignments);
        onAssignmentsLoaded?.(course.code, r.assignments);
      })
      .catch(() => {
        if (!cancelled && assignments.length === 0) setCourseAssignments([]);
      })
      .finally(() => {
        if (!cancelled) setAsgLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.code, subTab]);

  // Fetch live documents for any subject (enrolled or open in catalog)
  useEffect(() => {
    if (subTab !== "documents") return;
    setDocsLoading(true);
    void api
      .documents(course.code, dir)
      .then((res) => setDocs(res.nodes))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  }, [course.code, subTab, dir]);

  // Announcements the account-wide feed already has for this course
  useEffect(() => {
    if (announcements.length > 0) setCourseAnnouncements(announcements);
  }, [announcements]);

  // Nothing in the feed: the course's own announcements, once, when the student opens the tab.
  // Keyed on "has feed items", not on the array, so re-renders never ask eClass again.
  const feedHasAnnouncements = announcements.length > 0;
  useEffect(() => {
    if (feedHasAnnouncements || subTab !== "announcements") return;
    let cancelled = false;
    setAnnLoading(true);
    void api
      .announcements(course.code)
      .then((res) => {
        if (!cancelled) setCourseAnnouncements(res.announcements);
      })
      .catch(() => {
        if (!cancelled) setCourseAnnouncements([]);
      })
      .finally(() => {
        if (!cancelled) setAnnLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [course.code, subTab, feedHasAnnouncements]);

  const parentDir = useMemo(() => {
    if (!dir || dir === "/") return null;
    const idx = dir.lastIndexOf("/");
    return idx <= 0 ? "/" : dir.slice(0, idx);
  }, [dir]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={onBack}
              aria-label={tr("back")}
              title={tr("back")}
              className="hidden md:inline-flex -ml-1.5 p-1 rounded-lg text-[var(--muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono">
              {course.publicCode ?? course.code}
            </span>
            <h1 className="hidden md:block text-lg font-semibold tracking-tight">{course.title}</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--muted)] mt-1">
            {course.professor && (
              <span className="inline-flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-[var(--muted)]" />
                <span>{course.professor}</span>
              </span>
            )}
            {course.semester && <span>· {course.semester}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/courses/${encodeURIComponent(course.code)}/documents/zip`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-95 shadow-xs"
          >
            <Download className="w-4 h-4" />
            <span>{tr("downloadCourseZip")}</span>
          </a>

          {course.enrolled ? (
            <button
              onClick={async () => {
                const ok = window.confirm(
                  lang === "el"
                    ? `Απεγγραφή από «${course.title}» στο eClass;`
                    : `Unenroll from "${course.title}" on eClass?`,
                );
                if (!ok) return;
                await api.unenroll(course.code);
                showToast(
                  lang === "el"
                    ? `Απεγγράφηκες από ${course.title}`
                    : `Unenrolled from ${course.title}`,
                );
                await onEnrolledOrUnenrolled();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger)]/20 cursor-pointer"
            >
              <UserMinus className="w-3.5 h-3.5" />
              <span>{tr("unenrollCourse")}</span>
            </button>
          ) : (
            <button
              onClick={() => void join(course)}
              disabled={course.locked}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-soft)] cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
              {course.needsPassword ? <KeyRound className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
              <span>{tr("enrollBtn")}</span>
            </button>
          )}
        </div>
      </div>
      {courseCodeDialog}
      {viewer && (
        <DocumentViewer
          key={viewer.node.path}
          lang={lang}
          courseCode={course.code}
          node={viewer.node}
          initialTab={viewer.tab}
          onClose={() => setViewer(null)}
          onMeChanged={onMeChanged}
        />
      )}

      {/* eClass shows nothing of a code-protected course until you join it with its code */}
      {!course.enrolled && course.needsPassword && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <KeyRound className="hidden sm:block w-4 h-4 text-[var(--muted)] shrink-0" />
          <p className="text-sm text-[var(--muted)] flex-1">
            {lang === "el"
              ? "Τα αρχεία αυτού του μαθήματος ανοίγουν με τον κωδικό εγγραφής που δίνει ο διδάσκων."
              : "This course's files open with the registration code your teacher gives out."}
          </p>
          <button
            onClick={() => askCode(course)}
            className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] cursor-pointer shrink-0"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {lang === "el" ? "Βάλε κωδικό" : "Enter code"}
          </button>
        </div>
      )}

      {/* Sub-navigation tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border)] overflow-x-auto whitespace-nowrap -mx-4 px-4 md:mx-0 md:px-0">
        {(
          [
            ["documents", tr("tabDocuments")],
            ["starred", lang === "el" ? "Επισημασμένα" : "Highlighted"],
            ["announcements", tr("tabAnnouncements")],
            ["assignments", tr("tabAssignments")],
            ["info", tr("tabInfo")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => onChangeSubTab(key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
              subTab === key
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {label}
            {key === "starred" && starred.length > 0 && <span className="ml-1.5 tabular-nums opacity-70">{starred.length}</span>}
          </button>
        ))}
      </div>

      {subTab === "starred" && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          {starred.length === 0 ? (
            <div className="px-6 py-10 text-center space-y-2">
              <Star className="w-6 h-6 mx-auto text-[var(--muted)]" />
              <p className="text-sm text-[var(--muted)] max-w-xs mx-auto">
                {lang === "el"
                  ? "Πάτησε το αστέρι δίπλα σε ένα αρχείο για να το βρίσκεις εδώ."
                  : "Tap the star next to a file to keep it here."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {starred.map((f) => {
                const node: DocNode = {
                  path: f.path,
                  name: f.name,
                  isDir: false,
                  size: f.size,
                  date: f.date,
                  downloadUrl: `/api/courses/${encodeURIComponent(course.code)}/documents/file?path=${encodeURIComponent(f.path)}`,
                };
                return (
                  <DocFileRow
                    key={f.path}
                    lang={lang}
                    courseCode={course.code}
                    node={node}
                    detail={[f.folder || (lang === "el" ? "Αρχικός φάκελος" : "Top folder"), formatDocSize(f.size), f.date]
                      .filter(Boolean)
                      .join(" · ")}
                    onOpen={(tab) => setViewer({ node, tab })}
                    starred
                    onToggleStar={() => onToggleStar(course.code, node, f.folder ?? "")}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {subTab === "announcements" && (
        <div className="space-y-3">
          {annLoading ? (
            <div className="py-10 flex justify-center"><RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" /></div>
          ) : courseAnnouncements.length === 0 ? (
            <EmptyCard text={tr("noItems")} />
          ) : (
            courseAnnouncements.map((a) => (
              <div
                key={a.id}
                className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                  <span>{new Date(a.date).toLocaleDateString(lang === "el" ? "el-GR" : "en-US")}</span>
                  {safeHref(a.url) && (
                    <a
                      href={safeHref(a.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                    >
                      <span>eClass</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                <h3 className="text-sm font-semibold">{a.title}</h3>
                <TriageTag lang={lang} triage={triage[a.id]} />
                <div
                  className="rich-text text-sm text-[var(--text)]/90"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(a.contentHtml || a.contentText) }}
                />
              </div>
            ))
          )}
        </div>
      )}

      {subTab === "documents" && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          {/* Header: where you are, up a folder, and the AI file search at the end */}
          <div className="min-h-[3.25rem] pl-4 pr-2 py-2 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2">
            {searchOpen ? (
              <form
                className="flex-1 min-w-0 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch();
                }}
              >
                <AiSearchIcon className="text-[var(--accent-text)] shrink-0" />
                <input
                  ref={searchInputRef}
                  type="search"
                  enterKeyHint="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                    }
                  }}
                  maxLength={200}
                  aria-label={lang === "el" ? "Αναζήτηση στα αρχεία με AI" : "Search the files with AI"}
                  placeholder={lang === "el" ? "Τι ψάχνεις; π.χ. η διάλεξη για τη χρηστικότητα" : "What are you looking for? e.g. the lecture on usability"}
                  className="flex-1 min-w-0 bg-transparent text-sm py-1.5 focus:outline-none placeholder:text-[var(--muted)] [&::-webkit-search-cancel-button]:hidden"
                />
                {searching ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-[var(--muted)] shrink-0" aria-label={lang === "el" ? "Αναζήτηση…" : "Searching…"} />
                ) : (
                  searchQuery.trim().length >= 2 && (
                    <button
                      type="submit"
                      className="hidden sm:inline-flex shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--accent-soft)] cursor-pointer"
                    >
                      {lang === "el" ? "Αναζήτηση" : "Search"}
                    </button>
                  )
                )}
                <IconButton label={lang === "el" ? "Κλείσιμο αναζήτησης" : "Close search"} onClick={closeSearch} tooltipSide="left">
                  <X className="w-4 h-4" />
                </IconButton>
              </form>
            ) : (
              <>
                <div className="flex-1 min-w-0 text-xs font-medium truncate">
                  <span className="text-[var(--muted)]">{tr("rootFolder")}:</span> {folderLabel || "/"}
                </div>
                {parentDir && (
                  <button
                    onClick={() => setDir(parentDir)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-[var(--accent-text)] hover:bg-[var(--surface)] cursor-pointer"
                  >
                    <FolderUp className="w-3.5 h-3.5" />
                    <span>{tr("upFolder")}</span>
                  </button>
                )}
                <IconButton
                  label={lang === "el" ? "Αναζήτηση στα αρχεία με AI" : "Search the files with AI"}
                  onClick={openSearch}
                  tooltipSide="left"
                >
                  <AiSearchIcon />
                </IconButton>
              </>
            )}
          </div>

          {searchOpen && (searchResults || searchError) ? (
            <div>
              {searchError ? (
                <p className="px-4 py-8 text-center text-sm text-[var(--danger)]">{searchError}</p>
              ) : searchResults && searchResults.results.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">
                  {lang === "el" ? "Δεν βρέθηκε αρχείο που να ταιριάζει." : "No file matches that."}
                </p>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {searchResults!.results.map((r) => (
                    <DocFileRow
                      key={r.node.path}
                      lang={lang}
                      courseCode={course.code}
                      node={r.node}
                      detail={[r.node.folder || (lang === "el" ? "Αρχικός φάκελος" : "Top folder"), r.why].filter(Boolean).join(" · ")}
                      onOpen={(tab) => setViewer({ node: r.node, tab })}
                      starred={starredPaths.has(r.node.path)}
                      onToggleStar={() => onToggleStar(course.code, r.node, r.node.folder)}
                    />
                  ))}
                </div>
              )}
              {searchResults && (
                <p className="px-4 py-2.5 border-t border-[var(--border)] text-xs text-[var(--muted)]">
                  {lang === "el"
                    ? `Έψαξε ${searchResults.searchedFiles} αρχεία σε ${searchResults.searchedFolders} φακέλους${searchResults.truncated ? " (όχι σε όλους: πολλοί φάκελοι)" : ""}. Το AI βλέπει ονόματα και φακέλους, όχι το περιεχόμενο.`
                    : `Searched ${searchResults.searchedFiles} files in ${searchResults.searchedFolders} folders${searchResults.truncated ? " (not all: too many folders)" : ""}. The AI sees names and folders, not the contents.`}
                </p>
              )}
            </div>
          ) : docsLoading ? (
            <div className="py-10 flex justify-center"><RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" /></div>
          ) : docs.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--muted)]">{tr("noItems")}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {docs.map((node) =>
                node.isDir ? (
                  <button
                    key={node.path}
                    type="button"
                    onClick={() => setDir(node.path, node.name)}
                    className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[var(--surface-2)] cursor-pointer"
                  >
                    <Folder className="w-[1.125rem] h-[1.125rem] text-[var(--warn)] shrink-0" />
                    <span className="min-w-0 flex-1 text-sm font-medium truncate">{node.name}</span>
                    <ChevronRight className="w-4 h-4 text-[var(--muted)] shrink-0" />
                  </button>
                ) : (
                  <DocFileRow
                    key={node.path}
                    lang={lang}
                    courseCode={course.code}
                    node={node}
                    onOpen={(tab) => setViewer({ node, tab })}
                    starred={starredPaths.has(node.path)}
                    onToggleStar={() => onToggleStar(course.code, node, folderLabel)}
                  />
                ),
              )}
            </div>
          )}
        </div>
      )}

      {subTab === "assignments" && (
        <div className="space-y-3">
          {asgLoading ? (
            <div className="py-10 flex justify-center"><RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" /></div>
          ) : courseAssignments.length === 0 ? (
            <EmptyCard text={tr("noItems")} />
          ) : (
            courseAssignments.map((asg) =>
              openAssignmentId === asg.id ? (
                <AssignmentPanel
                  key={asg.id}
                  lang={lang}
                  courseCode={course.code}
                  assignment={asg}
                  onClose={() => setOpenAssignmentId(null)}
                  onSubmitted={(msg) => {
                    showToast(msg);
                    void onEnrolledOrUnenrolled();
                  }}
                />
              ) : (
                <button
                  key={asg.id}
                  onClick={() => setOpenAssignmentId(asg.id)}
                  className="w-full text-left p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug">{asg.title}</div>
                    {asg.deadline && (
                      <div className="text-xs text-[var(--muted)] mt-1">
                        {new Date(asg.deadline).toLocaleString(lang === "el" ? "el-GR" : "en-GB", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                    {asg.grade && (
                      <div className="text-xs text-[var(--accent)] font-medium mt-1">
                        {tr("grade")}: {asg.grade}
                      </div>
                    )}
                  </div>
                  <span className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        asg.submitted ? "bg-[var(--ok-soft)] text-[var(--ok)]" : "bg-[var(--warn-soft)] text-[var(--warn)]"
                      }`}
                    >
                      {asg.submitted ? tr("submitted") : tr("pending")}
                    </span>
                    <ChevronRight className="w-4 h-4 text-[var(--muted)]" />
                  </span>
                </button>
              ),
            )
          )}
        </div>
      )}

      {subTab === "info" && (
        <div className="space-y-4">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            {lang === "el" ? "Όλα τα εργαλεία του μαθήματος" : "All course tools"}
          </h3>
          <p className="text-xs text-[var(--muted)]">
            {lang === "el"
              ? "Ανακοινώσεις, έγγραφα, εργασίες και μηνύματα ανοίγουν εδώ· τα υπόλοιπα (κουίζ, συζητήσεις, βαθμολόγιο κ.ά.) ανοίγουν στο eClass."
              : "Announcements, documents, assignments and messages open here; everything else (quizzes, forum, gradebook, …) opens on eClass."}
          </p>
          <CourseToolsPanel
            lang={lang}
            courseCode={course.code}
            onOpenTab={(t) => onChangeSubTab(t)}
            onOpenInbox={onOpenInbox}
          />
        </section>
        <div className="p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] space-y-4">
          <div className="text-xs space-y-2">
            <div>
              <span className="text-[var(--muted)]">Code:</span>{" "}
              <span className="font-medium font-mono">
                {course.publicCode ?? course.code} ({course.code})
              </span>
            </div>
            <div>
              <span className="text-[var(--muted)]">Semester:</span>{" "}
              <span className="font-medium">
                {course.semester} {course.semesterFolder ? `(${course.semesterFolder})` : ""}
              </span>
            </div>
            {course.professor && (
              <div>
                <span className="text-[var(--muted)]">Professor:</span>{" "}
                <span className="font-medium">{course.professor}</span>
              </div>
            )}
            {course.departmentName && (
              <div>
                <span className="text-[var(--muted)]">{tr("departmentLabel")}:</span>{" "}
                <span className="font-medium">{course.departmentName}</span>
              </div>
            )}
            {safeHref(course.url) && (
              <div>
                <a
                  href={safeHref(course.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline font-medium"
                >
                  <span>{lang === "el" ? "Άνοιγμα στο eClass" : "Open in eClass"}</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Inbox View                                                          */
/* ================================================================== */

/** "14:05" for today, "25 Νοε" otherwise. */
function shortDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  const locale = lang === "el" ? "el-GR" : "en-US";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** A section heading; with `open` + `onToggle` the whole title folds its section open and shut. */
function SectionTitle({
  icon,
  title,
  count,
  action,
  open,
  onToggle,
  controls,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  action?: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /** id of the region the toggle shows and hides */
  controls?: string;
}) {
  const label = (
    <>
      <span className="text-[var(--muted)]">{icon}</span>
      <span>{title}</span>
      {!!count && <span className="text-xs font-normal text-[var(--muted)] tabular-nums">{count}</span>}
    </>
  );
  return (
    <div className={`flex items-center justify-between gap-2 shrink-0 ${open === false ? "" : "mb-2"}`}>
      <h2 className="text-sm font-semibold min-w-0">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={controls}
            className="flex items-center gap-2 -ml-1 px-1 py-1 rounded-lg hover:bg-[var(--surface-2)] cursor-pointer"
          >
            <ChevronRight
              className={`w-4 h-4 text-[var(--muted)] shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            />
            {label}
          </button>
        ) : (
          <span className="flex items-center gap-2">{label}</span>
        )}
      </h2>
      {open !== false && action}
    </div>
  );
}

/** One row of the Inbox feed: an eClass announcement, or a myClass notification. */
type FeedItem =
  | { type: "ann"; key: string; date: string; a: Announcement; notif?: NotificationItem }
  | { type: "notif"; key: string; date: string; n: NotificationItem };

const FEED_PAGE = 40;

function feedIcon(kind: NotificationItem["kind"] | "ann") {
  const cls = "w-3.5 h-3.5";
  switch (kind) {
    case "ann":
    case "announcement":
      return <Megaphone className={cls} />;
    case "message":
      return <Mail className={cls} />;
    case "assignment":
      return <FileText className={cls} />;
    case "deadline":
      return <Clock className={cls} />;
    default:
      return <Bell className={cls} />;
  }
}

function InboxView({
  lang,
  messages,
  announcements,
  triage,
  notifications,
  setNotifications,
  onOpenNotification,
  onOpenAnnouncement,
}: {
  lang: Lang;
  messages: Message[];
  announcements: Announcement[];
  triage: Record<string, AnnouncementTriage>;
  notifications: NotificationItem[];
  setNotifications: React.Dispatch<React.SetStateAction<NotificationItem[]>>;
  onOpenNotification: (n: NotificationItem) => void;
  onOpenAnnouncement: (a: Announcement) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const el = lang === "el";
  const [selected, setSelected] = useState<Message | null>(messages[0] ?? null);
  /** Phones and narrow windows show the list or the open message, one at a time. */
  const [readerOpen, setReaderOpen] = useState(false);
  const messagesRef = useRef<HTMLElement>(null);
  const unreadNotifs = notifications.filter((n) => !n.read).length;
  const unreadMsgs = messages.filter((m) => !m.read).length;
  const [feedFilter, setFeedFilter] = useState<"all" | "announcements" | "action">("all");
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  // Both sections start open; either one folds away to give the other the page
  const [feedOpen, setFeedOpen] = useState(true);
  const [messagesOpen, setMessagesOpen] = useState(true);

  /*
   * Announcements and notifications in one list, newest first. A notification about an
   * announcement folds into that announcement's row (same course and date) and gives it
   * the unread dot, so nothing shows twice.
   */
  const feed = useMemo(() => {
    const annByKey = new Map<string, FeedItem & { type: "ann" }>();
    const items: FeedItem[] = [];
    for (const a of announcements) {
      const item = { type: "ann" as const, key: `a-${a.id}`, date: a.date, a };
      annByKey.set(`${a.courseCode}|${a.date}`, item);
      items.push(item);
    }
    for (const n of notifications) {
      const match = n.kind === "announcement" && n.courseCode ? annByKey.get(`${n.courseCode}|${n.date}`) : undefined;
      if (match && !match.notif) match.notif = n;
      else items.push({ type: "notif", key: `n-${n.id}`, date: n.date, n });
    }
    return items.sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime());
  }, [announcements, notifications]);

  const needsAction = (item: FeedItem) =>
    item.type === "ann"
      ? triage[item.a.id]?.label === "action"
      : item.n.triage === "action" || item.n.kind === "deadline";
  const actionCount = feed.filter(needsAction).length;
  const filteredFeed =
    feedFilter === "all"
      ? feed
      : feedFilter === "action"
        ? feed.filter(needsAction)
        : feed.filter((i) => i.type === "ann" || i.n.kind === "announcement");
  const shownFeed = filteredFeed.slice(0, feedLimit);

  const selectMsg = async (m: Message) => {
    setSelected(m);
    setReaderOpen(true);
    if (!m.bodyHtml) {
      try {
        const res = await api.message(m.id);
        setSelected(res.message);
      } catch {
        /* ignore */
      }
    }
  };

  const dismiss = async (id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
    try {
      const res = await api.openNotification(id, true);
      setNotifications(res.notifications);
    } catch {
      /* ignore */
    }
  };

  const openNotif = (n: NotificationItem) => {
    void dismiss(n.id);
    if (n.kind === "message") {
      setMessagesOpen(true);
      messagesRef.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    } else {
      onOpenNotification(n);
    }
  };

  const panel = "rounded-2xl border border-[var(--border)] bg-[var(--surface)]";

  return (
    <div className="flex-1 flex flex-col gap-6 md:gap-5 md:h-[calc(100dvh-2.5rem)] md:min-h-0">
      {/* Notifications and announcements in one feed, capped so messages always keep room below */}
      <section
        className={`flex flex-col min-h-0 shrink-0 ${feedOpen && messagesOpen ? "md:max-h-[45%]" : feedOpen ? "md:flex-1" : ""}`}
      >
        <SectionTitle
          icon={<Bell className="w-4 h-4" />}
          title={el ? "Ειδοποιήσεις και ανακοινώσεις" : "Notifications and announcements"}
          count={unreadNotifs}
          open={feedOpen}
          onToggle={() => setFeedOpen((o) => !o)}
          controls="inbox-feed"
          action={
            notifications.some((n) => !n.read) && (
              <button
                onClick={async () => {
                  const res = await api.markAllNotificationsRead();
                  setNotifications(res.notifications ?? []);
                }}
                className="text-xs text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
              >
                {tr("markAllRead")}
              </button>
            )
          }
        />
        <div id="inbox-feed" hidden={!feedOpen} className="contents">
        {feed.length > 0 && (
          <div className="mb-2 shrink-0 overflow-x-auto">
            <Segmented
              value={feedFilter}
              onChange={(v) => {
                setFeedFilter(v);
                setFeedLimit(FEED_PAGE);
              }}
              options={[
                { value: "all", label: el ? "Όλα" : "All" },
                { value: "announcements", label: el ? "Ανακοινώσεις" : "Announcements" },
                {
                  value: "action",
                  label: `${el ? "Χρειάζεται ενέργεια" : "Action needed"}${actionCount ? ` ${actionCount}` : ""}`,
                },
              ]}
            />
          </div>
        )}
        <div className={`${panel} min-h-0 max-h-[55vh] md:max-h-none overflow-y-auto divide-y divide-[var(--border)]`}>
          {shownFeed.length === 0 ? (
            <div className="p-5 text-xs text-[var(--muted)] text-center">
              {feedFilter === "action"
                ? el
                  ? "Τίποτα δεν ζητά κάτι από σένα."
                  : "Nothing asks anything of you."
                : tr("noItems")}
            </div>
          ) : (
            shownFeed.map((item) => {
              const n = item.type === "notif" ? item.n : item.notif;
              const unread = !!n && !n.read;
              const open = () => {
                if (item.type === "notif") return openNotif(item.n);
                if (item.notif) void dismiss(item.notif.id);
                onOpenAnnouncement(item.a);
              };
              const title = item.type === "ann" ? item.a.title : item.n.title;
              const courseTitle = item.type === "ann" ? (item.a.courseTitle ?? item.a.courseCode) : item.n.courseTitle;
              const body = item.type === "ann" ? item.a.contentText : item.n.body;
              const tag: AnnouncementTriage | undefined =
                item.type === "ann" ? triage[item.a.id] : item.n.triage ? { label: item.n.triage } : undefined;
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open();
                  }}
                  className="group flex items-start gap-3 pl-3 pr-2 py-3 cursor-pointer transition-colors hover:bg-[var(--surface-2)]/60"
                >
                  <span className="relative mt-0.5 shrink-0 w-7 h-7 rounded-lg bg-[var(--surface-2)] text-[var(--muted)] inline-flex items-center justify-center">
                    {feedIcon(item.type === "ann" ? "ann" : item.n.kind)}
                    {unread && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--surface)]" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={`text-sm truncate ${unread ? "font-semibold" : "font-medium"}`}>{title}</span>
                      <span className="text-xs text-[var(--muted)] shrink-0 tabular-nums">
                        {shortDate(item.date, lang)}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--muted)] truncate mt-0.5">
                      {courseTitle && <span className="text-[var(--accent)]">{courseTitle} · </span>}
                      {body}
                    </div>
                    <TriageTag lang={lang} triage={tag} />
                  </div>
                  {item.type === "notif" ? (
                    <button
                      aria-label={el ? "Απόρριψη" : "Dismiss"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismiss(item.n.id);
                      }}
                      className="p-1 rounded-md text-[var(--muted)] hover:text-[var(--text)] cursor-pointer shrink-0 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <span className="w-[22px] shrink-0" />
                  )}
                </div>
              );
            })
          )}
          {filteredFeed.length > shownFeed.length && (
            <button
              onClick={() => setFeedLimit((l) => l + FEED_PAGE)}
              className="w-full py-2.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
            >
              {el ? "Περισσότερα" : "Show more"} ({filteredFeed.length - shownFeed.length})
            </button>
          )}
        </div>
        </div>
      </section>

      {/* Messages: list + reader side by side on wide screens, one at a time on phones */}
      <section
        ref={messagesRef}
        className={`flex flex-col min-h-0 scroll-mt-16 md:scroll-mt-0 ${messagesOpen ? "flex-1" : "shrink-0"}`}
      >
        <SectionTitle
          icon={<Mail className="w-4 h-4" />}
          title={tr("messagesSection")}
          count={unreadMsgs}
          open={messagesOpen}
          onToggle={() => setMessagesOpen((o) => !o)}
          controls="inbox-messages"
        />
        <div id="inbox-messages" hidden={!messagesOpen} className="flex-1 min-h-0 grid grid-cols-1 md:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <div
            className={`${panel} min-h-0 overflow-y-auto divide-y divide-[var(--border)] ${
              readerOpen ? "hidden lg:block" : ""
            }`}
          >
            {messages.length === 0 ? (
              <div className="p-5 text-xs text-[var(--muted)] text-center">{tr("noItems")}</div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void selectMsg(m)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void selectMsg(m);
                  }}
                  className={`px-4 py-3 cursor-pointer transition-colors ${
                    selected?.id === m.id ? "lg:bg-[var(--surface-2)]" : ""
                  } hover:bg-[var(--surface-2)]/60`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={`text-sm truncate ${m.read ? "" : "font-semibold"}`}>{m.sender}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-[var(--muted)] tabular-nums">{shortDate(m.date, lang)}</span>
                      {!m.read && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
                    </span>
                  </div>
                  <div className="text-sm mt-0.5 truncate">{m.subject}</div>
                  <div className="text-xs text-[var(--muted)] mt-0.5 truncate">{m.courseTitle ?? "eClass"}</div>
                </div>
              ))
            )}
          </div>

          <div
            className={`${panel} min-h-0 overflow-y-auto p-5 ${readerOpen ? "" : "hidden lg:block"} ${
              selected ? "" : "lg:flex lg:items-center lg:justify-center"
            }`}
          >
            {!selected ? (
              <div className="text-xs text-[var(--muted)]">{tr("selectMessage")}</div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={() => setReaderOpen(false)}
                  className="lg:hidden -ml-1 inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                  {tr("messagesSection")}
                </button>
                <div className="pb-3 border-b border-[var(--border)]">
                  <div className="text-xs text-[var(--accent)] font-medium">
                    {selected.courseTitle ?? "eClass"}
                  </div>
                  <h2 className="text-base font-semibold mt-0.5">{selected.subject}</h2>
                  <div className="text-xs text-[var(--muted)] mt-1">
                    {selected.sender} ·{" "}
                    {new Date(selected.date).toLocaleString(lang === "el" ? "el-GR" : "en-US")}
                  </div>
                </div>
                <div
                  className="rich-text text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHtml(selected.bodyHtml || selected.preview || ""),
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ================================================================== */
/* AI Assistant View (with Tool Badges & Action Confirmation Cards)    */
/* ================================================================== */

function AssistantView({
  lang,
  compact = false,
  onActionCompleted,
}: {
  lang: Lang;
  compact?: boolean;
  onActionCompleted: () => Promise<void>;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.chatHistory().then((res) => setMessages(res.messages));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
  }, [messages, streamingText]);

  const sendMessage = async (textToSend?: string) => {
    const prompt = (textToSend ?? input).trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setStreamingText("");

    const optimisticUser: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text: prompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    try {
      await api.streamChat(prompt, (ev) => {
        if (ev.type === "tool") setActiveTool(ev.name);
        if (ev.type === "text") setStreamingText(ev.delta);
        if (ev.type === "done") {
          setStreamingText("");
          setActiveTool(null);
          setMessages((prev) => [...prev, ev.message]);
        }
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text: `Error: ${(err as Error).message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setBusy(false);
      setActiveTool(null);
    }
  };

  const quickPrompts =
    lang === "el"
      ? ["Τι προθεσμίες έχω αυτή την εβδομάδα;", "Τι νέο υπάρχει στα μαθήματά μου;", "Κάνε μου ένα πλάνο διαβάσματος"]
      : ["What's due this week?", "What's new in my courses?", "Make me a study plan"];

  const toolLabel = (name: string | null): string => {
    const el: Record<string, string> = {
      list_courses: "Κοιτάζω τα μαθήματά σου",
      search_catalog: "Ψάχνω στον κατάλογο",
      list_documents: "Κοιτάζω τα αρχεία",
      read_document: "Διαβάζω το αρχείο",
      get_announcements: "Κοιτάζω τις ανακοινώσεις",
      get_messages: "Κοιτάζω τα μηνύματα",
      read_message: "Διαβάζω το μήνυμα",
      get_deadlines: "Κοιτάζω τις προθεσμίες",
      get_assignment_details: "Διαβάζω την εργασία",
    };
    const en: Record<string, string> = {
      list_courses: "Checking your courses",
      search_catalog: "Searching the catalog",
      list_documents: "Looking at the files",
      read_document: "Reading the file",
      get_announcements: "Checking announcements",
      get_messages: "Checking messages",
      read_message: "Reading the message",
      get_deadlines: "Checking deadlines",
      get_assignment_details: "Reading the assignment",
    };
    const fallback = lang === "el" ? "Σκέφτομαι" : "Thinking";
    return (name && (lang === "el" ? el : en)[name]) || fallback;
  };

  return (
    <div
      className={`flex flex-col ${
        compact
          ? "h-full"
          : "h-[calc(100dvh-10.5rem)] md:h-[calc(100vh-2.5rem)] max-w-4xl mx-auto w-full"
      }`}
    >
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4 space-y-3 sm:space-y-4">
        {messages.length === 0 && (
          <div className="py-3 sm:py-6 text-center space-y-3 sm:space-y-4">
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-[var(--surface-2)] text-[var(--muted)] flex items-center justify-center mx-auto">
              <Bot className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="max-w-md mx-auto space-y-1">
              <div className="text-base font-semibold">{tr("assistantTitle")}</div>
              <p className="text-sm text-[var(--muted)]">{tr("assistantSubtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 max-w-lg mx-auto pt-1 sm:pt-2">
              {quickPrompts.map((p) => (
                <button
                  key={p}
                  onClick={() => void sendMessage(p)}
                  className="text-sm px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] transition-colors cursor-pointer"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-[var(--accent)] text-[var(--on-accent)] font-medium"
                  : "bg-[var(--surface-2)] text-[var(--text)]"
              }`}
            >
              <FormattedChatText text={m.text} isUser={m.role === "user"} />

              {/* Confirmation Card for mutating actions */}
              {m.action && (
                <div className="mt-3 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--accent)]">
                      {tr("actionPending")}
                    </span>
                  </div>
                  <div className="text-sm font-medium">{m.action.summary}</div>

                  {m.action.status === "pending" ? (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={async () => {
                          const res = await api.decideAction(m.action!.id, "confirm");
                          setMessages((prev) =>
                            prev.map((x) => (x.id === m.id ? { ...x, action: res.action } : x)),
                          );
                          await onActionCompleted();
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-95 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{tr("confirmAction")}</span>
                      </button>
                      <button
                        onClick={async () => {
                          const res = await api.decideAction(m.action!.id, "cancel");
                          setMessages((prev) =>
                            prev.map((x) => (x.id === m.id ? { ...x, action: res.action } : x)),
                          );
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>{tr("cancelAction")}</span>
                      </button>
                    </div>
                  ) : (
                    <div
                      className={`text-xs flex items-center gap-1.5 ${
                        m.action.status === "done" ? "text-[var(--ok)]" : "text-[var(--muted)]"
                      }`}
                    >
                      {m.action.status === "done" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <X className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>{m.action.result || m.action.status}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            <span>{toolLabel(activeTool)}…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage();
        }}
        className="mt-3 flex items-center gap-2"
      >
        {!compact && messages.length > 0 && (
          <button
            type="button"
            title={tr("clearChat")}
            aria-label={tr("clearChat")}
            onClick={async () => {
              await api.clearChat();
              setMessages([]);
            }}
            className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={tr("chatPlaceholder")}
          className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label={tr("send")}
          className="px-4 py-2.5 rounded-xl bg-[var(--accent)] text-[var(--on-accent)] font-semibold text-sm inline-flex items-center gap-1.5 hover:opacity-95 cursor-pointer disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          <span className="hidden sm:inline">{tr("send")}</span>
        </button>
      </form>
    </div>
  );
}

/* ================================================================== */
/* Settings View (Theme, Language, Notifications, Gemini Google/Key)   */
/* ================================================================== */

function SettingsView({
  me,
  lang,
  departments,
  onUpdatedMe,
  onLoggedOut,
  showToast,
}: {
  me: Me;
  lang: Lang;
  departments: DepartmentInfo[];
  onUpdatedMe: (m: Me) => void;
  onLoggedOut: () => void;
  showToast: (m: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showToast(err instanceof ServerUnavailableError ? tr("serverUnreachable") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Parameters<typeof api.patchSettings>[0]) =>
    run(async () => {
      const res = await api.patchSettings(p);
      onUpdatedMe(res.me);
    });

  const setNotify = (key: "announcements" | "messages" | "assignments" | "deadlines", value: boolean) =>
    patch({ notify: { ...me.settings.notify, [key]: value } });

  const aiMode = me.settings.ai.mode;
  const initials =
    me.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";

  const enablePush = () =>
    run(async () => {
      const res = await registerWebPush();
      if (res.ok) {
        const mRes = await api.me();
        if (mRes.me) onUpdatedMe(mRes.me);
        return;
      }
      showToast(
        res.reason === "ios-homescreen"
          ? lang === "el"
            ? "Στο iPhone: Κοινοποίηση → Προσθήκη στην οθόνη αφετηρίας, και άνοιξε το myClass από εκεί."
            : "On iPhone: Share → Add to Home Screen, then open myClass from there."
          : res.reason === "denied"
            ? lang === "el"
              ? "Οι ειδοποιήσεις είναι μπλοκαρισμένες στον browser."
              : "Notifications are blocked in your browser."
            : lang === "el"
              ? "Δεν ήταν δυνατή η ενεργοποίηση."
              : "Couldn't turn on notifications.",
      );
    });

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-4">
      {/* Profile */}
      <div className="flex items-center gap-3 p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="w-12 h-12 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center font-semibold shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{me.displayName}</div>
          <div className="text-xs text-[var(--muted)] truncate">
            {me.username} · {me.departmentName ?? me.universityName}
          </div>
        </div>
        <button
          onClick={() =>
            run(async () => {
              await api.logout();
              onLoggedOut();
            })
          }
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer shrink-0"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">{tr("signOutBtn")}</span>
        </button>
      </div>

      <SettingsGroup title={tr("appearanceSection")}>
        <SettingsRow label={tr("themeLabel")} stack>
          <Segmented
            stretch="mobile"
            value={me.settings.theme}
            disabled={busy}
            onChange={(v) => patch({ theme: v })}
            options={[
              { value: "light", label: tr("themeLight"), icon: <Sun className="w-3.5 h-3.5" /> },
              { value: "dark", label: tr("themeDark"), icon: <Moon className="w-3.5 h-3.5" /> },
              { value: "system", label: tr("themeSystem"), icon: <Monitor className="w-3.5 h-3.5" /> },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={tr("languageLabel")} stack>
          <Segmented
            stretch="mobile"
            value={me.settings.language}
            disabled={busy}
            onChange={(v) => patch({ language: v })}
            options={[
              { value: "el", label: "Ελληνικά" },
              { value: "en", label: "English" },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={lang === "el" ? "Προσβασιμότητα" : "Accessibility"}>
        <SettingsRow
          label={lang === "el" ? "Μέγεθος κειμένου" : "Text size"}
          hint={lang === "el" ? "Ισχύει σε όλη την εφαρμογή." : "Applies across the whole app."}
          stack
        >
          <Segmented
            stretch="mobile"
            value={String(me.settings.accessibility.fontScale)}
            disabled={busy}
            onChange={(v) => patch({ accessibility: { fontScale: Number(v) as 0.9 | 1 | 1.15 | 1.3 } })}
            options={[
              { value: "0.9", label: "A−" },
              { value: "1", label: "A" },
              { value: "1.15", label: "A+" },
              { value: "1.3", label: "A++" },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label={lang === "el" ? "Λιγότερη κίνηση" : "Reduce motion"}
          hint={
            lang === "el"
              ? "Χωρίς κινήσεις και μεταβάσεις. «Συσκευή» ακολουθεί τη ρύθμιση του κινητού/υπολογιστή."
              : "No movement or transitions. “Device” follows your phone or computer setting."
          }
          stack
        >
          <Segmented
            stretch="mobile"
            value={me.settings.accessibility.reduceMotion}
            disabled={busy}
            onChange={(v) => patch({ accessibility: { reduceMotion: v } })}
            options={[
              { value: "system", label: lang === "el" ? "Συσκευή" : "Device" },
              { value: "on", label: lang === "el" ? "Ναι" : "On" },
              { value: "off", label: lang === "el" ? "Όχι" : "Off" },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      {departments.length > 0 && (
        <SettingsGroup title={lang === "el" ? "Σπουδές" : "Studies"}>
          <SettingsRow
            label={tr("departmentLabel")}
            hint={lang === "el" ? "Ο κατάλογος «Όλα» και ο βοηθός χρησιμοποιούν αυτό το τμήμα." : "Used by the “All” catalog and the assistant."}
            stack
          >
            <select
              aria-label={tr("departmentLabel")}
              value={me.departmentId ?? ""}
              disabled={busy}
              onChange={(e) => patch({ departmentId: e.target.value })}
              className="w-full sm:w-auto sm:max-w-xs px-3 py-2 sm:py-1.5 rounded-lg text-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {lang === "el" ? d.name : d.nameEn}
                </option>
              ))}
            </select>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title={tr("notificationsSection")}>
        <SettingsRow label={tr("notifyAnnouncements")}>
          <Toggle
            checked={me.settings.notify.announcements}
            disabled={busy}
            label={tr("notifyAnnouncements")}
            onChange={(v) => setNotify("announcements", v)}
          />
        </SettingsRow>
        <SettingsRow label={tr("notifyMessages")}>
          <Toggle
            checked={me.settings.notify.messages}
            disabled={busy}
            label={tr("notifyMessages")}
            onChange={(v) => setNotify("messages", v)}
          />
        </SettingsRow>
        <SettingsRow label={tr("notifyAssignments")}>
          <Toggle
            checked={me.settings.notify.assignments}
            disabled={busy}
            label={tr("notifyAssignments")}
            onChange={(v) => setNotify("assignments", v)}
          />
        </SettingsRow>
        <SettingsRow
          label={lang === "el" ? "Υπενθυμίσεις προθεσμιών" : "Deadline reminders"}
          hint={
            lang === "el"
              ? "24 ώρες και 1 ώρα πριν λήξει εργασία που δεν έχεις υποβάλει."
              : "24 hours and 1 hour before an assignment you haven't submitted is due."
          }
        >
          <Toggle
            checked={me.settings.notify.deadlines}
            disabled={busy}
            label={lang === "el" ? "Υπενθυμίσεις προθεσμιών" : "Deadline reminders"}
            onChange={(v) => setNotify("deadlines", v)}
          />
        </SettingsRow>
        <SettingsRow label={tr("pollIntervalLabel")} stack>
          <Segmented
            stretch="mobile"
            value={String(me.settings.pollIntervalMin)}
            disabled={busy}
            onChange={(v) => patch({ pollIntervalMin: Number(v) })}
            options={[5, 15, 30, 60].map((m) => ({ value: String(m), label: `${m}′` }))}
          />
        </SettingsRow>
        <SettingsRow
          label={tr("pushLabel")}
          hint={
            isIosNeedsHomeScreen()
              ? lang === "el"
                ? "Στο iPhone πρόσθεσε πρώτα το myClass στην οθόνη αφετηρίας."
                : "On iPhone, add myClass to your Home Screen first."
              : lang === "el"
                ? "Ανακοινώσεις, μηνύματα, εργασίες και υπενθυμίσεις, ακόμα κι όταν η εφαρμογή είναι κλειστή."
                : "Announcements, messages, assignments and reminders, even when the app is closed."
          }
        >
          {me.settings.notify.push ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-[var(--ok)] inline-flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {tr("pushOn")}
              </span>
              <button
                onClick={() => run(async () => void (await api.sendTestNotification()))}
                className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
              >
                {tr("testNotificationBtn")}
              </button>
            </div>
          ) : (
            <button
              onClick={enablePush}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-[var(--on-accent)] cursor-pointer disabled:opacity-50"
            >
              {tr("enableWebPush")}
            </button>
          )}
        </SettingsRow>
      </SettingsGroup>

      <HomeScreenCalendarSettings me={me} lang={lang} onUpdatedMe={onUpdatedMe} showToast={showToast} />

      <SettingsGroup title={tr("aiSection")}>
        <div className="px-4 py-3.5 space-y-3">
          <Segmented
            value={aiMode}
            disabled={busy}
            stretch
            onChange={(v) => patch({ ai: { mode: v, model: me.settings.ai.model } })}
            options={[
              { value: "server", label: tr("aiModeServer") },
              { value: "apiKey", label: tr("aiModeApiKey") },
            ]}
          />
          <p className="text-xs text-[var(--muted)]">
            {aiMode === "server"
              ? me.ai.serverKeyAvailable
                ? tr("aiModeServerHint")
                : tr("aiModeServerMissing")
              : tr("aiModeApiKeyHint")}
          </p>

          {aiMode === "apiKey" &&
            (me.ai.hasApiKey ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--ok)] inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {tr("keySaved")}
                </span>
                <button
                  onClick={() =>
                    run(async () => {
                      const res = await api.removeApiKey();
                      onUpdatedMe(res.me);
                    })
                  }
                  className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
                >
                  {tr("removeKeyBtn")}
                </button>
              </div>
            ) : (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const res = await api.saveApiKey(apiKeyInput);
                    onUpdatedMe(res.me);
                    setApiKeyInput("");
                  });
                }}
              >
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={tr("apiKeyPlaceholder")}
                  autoComplete="off"
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] focus:outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="submit"
                  disabled={busy || apiKeyInput.trim().length < 10}
                  className="px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-[var(--on-accent)] cursor-pointer disabled:opacity-50"
                >
                  {tr("saveKeyBtn")}
                </button>
              </form>
            ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={tr("accountSection")}>
        <SettingsRow label={tr("deleteDataBtn")} hint={tr("deleteDataHint")}>
          <button
            onClick={() => {
              if (!window.confirm(tr("deleteDataConfirm"))) return;
              void run(async () => {
                await api.deleteAccount();
                onLoggedOut();
              });
            }}
            aria-label={tr("deleteDataBtn")}
            className="p-2 rounded-lg bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger)]/20 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

/**
 * Deadlines on the home screen. Phone browsers don't let web apps place widgets, so on Android and
 * iPhone the deadlines go into the phone's own calendar (a private subscription link) and that
 * calendar's widget shows them. On Windows, the installed app has its own Widgets board card.
 */
function HomeScreenCalendarSettings({
  me,
  lang,
  onUpdatedMe,
  showToast,
}: {
  me: Me;
  lang: Lang;
  onUpdatedMe: (m: Me) => void;
  showToast: (m: string) => void;
}) {
  const el = lang === "el";
  const [busy, setBusy] = useState(false);
  const canInstall = useCanInstall();
  const installed = isInstalledApp();
  const ua = navigator.userAgent;
  const isWindows = /Windows/.test(ua);
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua);
  const isIos = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const feed = me.calendarFeedUrl;
  const webcal = feed?.replace(/^https?:\/\//, "webcal://");
  const googleAdd = webcal ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` : undefined;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const linkBtn =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer";

  return (
    <SettingsGroup title={el ? "Προθεσμίες στην αρχική οθόνη" : "Deadlines on your home screen"}>
      {!installed && (canInstall || isIos || isAndroid) && (
        <SettingsRow
          label={el ? "Εγκατάσταση εφαρμογής" : "Install the app"}
          hint={
            canInstall
              ? el
                ? "Το myClass ως εφαρμογή, με εικονίδιο και συντομεύσεις."
                : "myClass as an app, with an icon and shortcuts."
              : isIos
                ? el
                  ? "Πάτα Κοινοποίηση → «Προσθήκη στην οθόνη Αφετηρίας». Στο iPhone οι ειδοποιήσεις δουλεύουν μόνο έτσι."
                  : "Tap Share → “Add to Home Screen”. On iPhone, alerts only work this way."
                : el
                  ? "Από το μενού του browser διάλεξε «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη»."
                  : "From the browser menu choose “Install app” or “Add to Home screen”."
          }
        >
          {canInstall && (
            <button
              onClick={() => void promptInstall()}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-[var(--on-accent)] cursor-pointer"
            >
              {el ? "Εγκατάσταση" : "Install"}
            </button>
          )}
        </SettingsRow>
      )}

      <div className="px-4 py-3.5 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">{el ? "Widget ημερολογίου" : "Calendar widget"}</div>
            <div className="text-xs text-[var(--muted)] mt-0.5">
              {el
                ? `Οι προθεσμίες σου μπαίνουν στο ${isApple ? "Ημερολόγιο του iPhone" : "Google Calendar"} και ενημερώνονται μόνες τους. Μετά πρόσθεσε το widget του ημερολογίου στην αρχική οθόνη.`
                : `Your deadlines go into ${isApple ? "Apple Calendar" : "Google Calendar"} and stay up to date. Then add that calendar's widget to your home screen.`}
            </div>
          </div>
          {!feed && (
            <button
              disabled={busy}
              onClick={() => run(async () => onUpdatedMe((await api.enableCalendarFeed()).me))}
              className="shrink-0 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-[var(--on-accent)] cursor-pointer disabled:opacity-50"
            >
              {el ? "Ενεργοποίηση" : "Turn on"}
            </button>
          )}
        </div>
        {feed && (
          <div className="enter space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <a href={isApple ? webcal : googleAdd} target="_blank" rel="noreferrer" className={linkBtn}>
                <Calendar className="w-3.5 h-3.5" />
                {el ? "Προσθήκη στο ημερολόγιο" : "Add to calendar"}
              </a>
              {!isApple && (
                <a href={webcal} className={linkBtn}>
                  {el ? "Άλλη εφαρμογή ημερολογίου" : "Other calendar app"}
                </a>
              )}
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(feed)
                    .then(() => showToast(el ? "Ο σύνδεσμος αντιγράφηκε." : "Link copied."))
                    .catch(() => showToast(feed))
                }
                className={linkBtn}
              >
                {el ? "Αντιγραφή συνδέσμου" : "Copy link"}
              </button>
              <button
                disabled={busy}
                onClick={() => run(async () => onUpdatedMe((await api.disableCalendarFeed()).me))}
                className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--danger)] cursor-pointer"
              >
                {el ? "Απενεργοποίηση" : "Turn off"}
              </button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              {el
                ? "Ο σύνδεσμος είναι ιδιωτικός: όποιος τον έχει βλέπει τις προθεσμίες σου. Αν τον μοιράστηκες κατά λάθος, απενεργοποίησέ τον και ενεργοποίησέ τον ξανά."
                : "The link is private: anyone who has it sees your deadlines. If you shared it by mistake, turn it off and on again."}
            </p>
          </div>
        )}
      </div>

      {isWindows && (
        <SettingsRow
          label={el ? "Widget των Windows" : "Windows widget"}
          hint={
            installed
              ? el
                ? "Πάτα Win + W → «+» → myClass deadlines."
                : "Press Win + W → “+” → myClass deadlines."
              : el
                ? "Εγκατάστησε το myClass από τον Edge, μετά Win + W → «+» → myClass deadlines."
                : "Install myClass from Edge, then Win + W → “+” → myClass deadlines."
          }
        >
          <span className="text-xs text-[var(--muted)]">Windows 11</span>
        </SettingsRow>
      )}

      {(installed || /Android/.test(ua)) && (
        <SettingsRow
          label={el ? "Συντόμευση" : "Shortcut"}
          hint={
            el
              ? "Κράτα πατημένο το εικονίδιο του myClass → «Προθεσμίες» για να ανοίξει κατευθείαν το ημερολόγιο."
              : "Long-press the myClass icon → “Προθεσμίες” to open straight to the calendar."
          }
        >
          <span />
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="px-1 mb-2 text-sm text-[var(--muted)]">{title}</h2>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {children}
      </div>
    </section>
  );
}

/**
 * One setting. `stack` is for wide controls (segmented choices): on a phone the control moves
 * under the label at full width, so the label and hint keep the whole line instead of a sliver.
 */
function SettingsRow({
  label,
  hint,
  stack,
  children,
}: {
  label: string;
  hint?: string;
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`px-4 py-3 flex justify-between min-h-[52px] ${
        stack ? "flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3" : "items-center gap-3"
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-[var(--muted)] mt-0.5">{hint}</div>}
      </div>
      <div className={stack ? "w-full sm:w-auto sm:shrink-0" : "shrink-0"}>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
        checked ? "bg-[var(--accent)]" : "bg-[var(--border)]"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  stretch,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Full width always, or (`"mobile"`) only on phones, where it sits under its label. */
  stretch?: boolean | "mobile";
}) {
  const wide = stretch === true ? "flex w-full" : stretch === "mobile" ? "flex w-full sm:inline-flex sm:w-auto" : "inline-flex";
  const grow = stretch === true ? "flex-1" : stretch === "mobile" ? "flex-1 sm:flex-none" : "";
  return (
    <div role="radiogroup" className={`${wide} rounded-xl bg-[var(--surface-2)] p-1 gap-0.5`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => value !== o.value && onChange(o.value)}
          className={`${grow} inline-flex items-center justify-center gap-1.5 px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:cursor-default ${
            value === o.value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          {o.icon}
          {/* Icon-only on a phone, unless the control has the whole width to itself */}
          <span className={o.icon && stretch !== "mobile" ? "hidden sm:inline" : undefined}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ================================================================== */
/* Small UI primitives                                                 */
/* ================================================================== */

function NavButton({
  icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
      }`}
    >
      <span className="flex items-center gap-2.5">
        {icon}
        <span>{label}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="text-xs px-1.5 rounded-full bg-[var(--surface-2)] text-[var(--muted)]">
          {badge}
        </span>
      )}
    </button>
  );
}

function MobileTab({
  icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      // Tab labels stop growing at 12px (like the phone's own tab bars), so five of them still fit at A++
      className={`relative flex-1 min-w-0 min-h-[52px] px-0.5 flex flex-col items-center justify-center gap-1 py-1 text-[min(0.6875rem,12px)] font-medium transition-colors cursor-pointer ${
        active ? "text-[var(--accent-text)]" : "text-[var(--muted)]"
      }`}
    >
      <div
        className={`relative flex items-center justify-center w-14 h-7 rounded-full transition-colors ${
          active ? "bg-[var(--accent-soft)]" : ""
        }`}
      >
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="-top-1 right-2 absolute min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--accent)] text-[var(--on-accent)] text-[0.6875rem] font-semibold tabular-nums flex items-center justify-center">
            {badge}
          </span>
        )}
      </div>
      <span className="truncate max-w-full px-0.5">{label}</span>
    </button>
  );
}

/** "Action needed · what to do" under an announcement title; nothing for FYI items. */
function TriageTag({ lang, triage }: { lang: Lang; triage?: AnnouncementTriage }) {
  if (triage?.label !== "action") return null;
  return (
    <div className="mt-1.5 inline-flex items-center gap-1.5 max-w-full px-2 py-0.5 rounded-md text-xs font-medium bg-[var(--warn-soft)] text-[var(--warn)]">
      <CircleAlert className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        {lang === "el" ? "Χρειάζεται ενέργεια" : "Action needed"}
        {triage.reason ? ` · ${triage.reason}` : ""}
      </span>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="p-6 rounded-2xl border border-dashed border-[var(--border)] text-center text-xs text-[var(--muted)]">
      {text}
    </div>
  );
}

function FormattedChatText({ text, isUser }: { text: string; isUser?: boolean }) {
  if (isUser) {
    return <div>{text}</div>;
  }

  // Clean any raw LaTeX/Markdown symbols so chat replies read naturally
  const cleaned = text
    .replace(/\\text(?:bf|it|tt|rm)\{([^}]*)\}/g, "**$1**")
    .replace(/\\(?:underline|emph)\{([^}]*)\}/g, "$1")
    .replace(/\$\$([^$]+)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_([\s).,;:!?]|$)/g, "$1$2$3")
    .replace(/`([^`\n]+)`/g, "$1");

  const renderInlineBold = (line: string) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return (
          <strong key={idx} className="font-semibold text-[var(--text)]">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return <React.Fragment key={idx}>{part.replace(/\*\*/g, "")}</React.Fragment>;
    });
  };

  const lines = cleaned.split("\n");
  return (
    <div className="space-y-1">
      {lines.map((rawLine, idx) => {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          return <div key={idx} className="h-1.5" />;
        }
        if (/^#{1,6}\s+/.test(trimmed)) {
          const heading = trimmed.replace(/^#{1,6}\s+/, "");
          return (
            <div key={idx} className="font-semibold text-[13px] text-[var(--accent)] pt-1">
              {renderInlineBold(heading)}
            </div>
          );
        }
        if (/^([-•*])\s+/.test(trimmed)) {
          const content = trimmed.replace(/^([-•*])\s+/, "");
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="text-[var(--muted)] select-none">•</span>
              <span className="flex-1">{renderInlineBold(content)}</span>
            </div>
          );
        }
        return <div key={idx}>{renderInlineBold(rawLine)}</div>;
      })}
    </div>
  );
}
