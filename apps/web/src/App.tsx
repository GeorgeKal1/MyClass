import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderUp,
  Globe,
  House as HomeIcon,
  Inbox,
  KeyRound,
  LogOut,
  Mail,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  User,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import type {
  Announcement,
  Assignment,
  CatalogCourse,
  PortalWarning,
  ChatMessage,
  Course,
  DepartmentInfo,
  DocNode,
  Lang,
  Me,
  Message,
  NotificationItem,
  ThemePref,
  University,
} from "@myclass/shared";
import { detectUniversityId } from "@myclass/shared";
import { api, ensureServiceWorker, isIosNeedsHomeScreen, registerWebPush, ServerUnavailableError } from "./api";
import { Logo } from "./Logo";
import { safeHref, sanitizeHtml } from "./sanitize";
import { t, type DictKey } from "./i18n";
import {
  AssignmentPanel,
  CourseToolsPanel,
  DeadlineCalendar,
  DocumentSummaryButton,
  DocumentSummaryPanel,
} from "./features";

type Tab = "home" | "courses" | "inbox" | "assistant" | "settings";
const TAB_ORDER: Tab[] = ["home", "courses", "inbox", "assistant", "settings"];
type CourseSubTab = "announcements" | "documents" | "assignments" | "info";
const COURSE_SUB_TABS: CourseSubTab[] = ["announcements", "documents", "assignments", "info"];

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

function pathForRoute(r: Route): string {
  if (r.tab === "courses" && r.course) {
    return `/courses/${encodeURIComponent(r.course)}${r.sub !== "documents" ? `?tab=${r.sub}` : ""}`;
  }
  return r.tab === "home" ? "/" : `/${r.tab}`;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [universities, setUniversities] = useState<University[]>([]);
  const initialRoute = useMemo(routeFromLocation, []);
  const [tab, setTab] = useState<Tab>(initialRoute.tab);
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
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);

  const [courses, setCourses] = useState<Course[]>([]);
  const [courseWarnings, setCourseWarnings] = useState<PortalWarning[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [focusAssignmentId, setFocusAssignmentId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogCourse[]>([]);
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);
  const [activeDepartment, setActiveDepartment] = useState<string>("");
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [lastPollAt, setLastPollAt] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [quickChatOpen, setQuickChatOpen] = useState(false);

  // Fallback theme & language before login
  const [guestTheme, setGuestTheme] = useState<ThemePref>("dark");
  const [guestLang, setGuestLang] = useState<Lang>("el");

  const theme: ThemePref = me?.settings.theme ?? guestTheme;
  const lang: Lang = me?.settings.language ?? guestLang;
  const tr = useCallback((k: DictKey) => t(lang, k), [lang]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  // Apply light / dark theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    root.classList.toggle("dark", isDark);
  }, [theme]);

  // Initial session, Service Worker registration & universities check
  useEffect(() => {
    void ensureServiceWorker();
    let cancelled = false;
    // Load the university list independently of the session check, and retry
    // while the API server is unreachable (e.g. still starting up).
    void (async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        try {
          const uRes = await api.universities();
          if (!cancelled) setUniversities(uRes.universities);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
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

  const activeDeptRef = useRef(activeDepartment);
  activeDeptRef.current = activeDepartment;

  const loadDepartmentCatalog = useCallback(
    async (deptId: string) => {
      setActiveDepartment(deptId);
      setCatalogLoading(true);
      try {
        const catRes = await api.catalog(undefined, deptId);
        setCatalog(catRes.catalog);
        if (catRes.departments) setDepartments(catRes.departments);
        if (catRes.activeDepartment) setActiveDepartment(catRes.activeDepartment);
      } catch (err) {
        showToast((err as Error).message);
      } finally {
        setCatalogLoading(false);
      }
    },
    [showToast],
  );

  const refreshAllData = useCallback(async () => {
    if (!me) return;
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
      track(api.catalog(undefined, activeDeptRef.current), (r) => {
        setCatalog(r.catalog);
        if (r.departments) setDepartments(r.departments);
        if (r.activeDepartment) setActiveDepartment(r.activeDepartment);
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
  }, [me, showToast]);

  useEffect(() => {
    if (me) void refreshAllData();
  }, [me, refreshAllData]);

  // Live SSE notification stream
  useEffect(() => {
    if (!me) return;
    const es = new EventSource("/api/notifications/stream", { withCredentials: true });
    es.addEventListener("notification", (ev) => {
      try {
        const item = JSON.parse((ev as MessageEvent).data) as NotificationItem;
        setNotifications((prev) => [item, ...prev]);
        showToast(`🔔 ${item.title}`);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [me, showToast]);

  // Keep the URL in sync with the current view (one history entry per navigation).
  // After a popstate the URL already matches the new state, so nothing is pushed.
  const inAppHistoryRef = useRef(0);
  useEffect(() => {
    if (!me) return;
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
  }, [me, tab, selectedCourseCode, courseSubTab]);

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

  // Result of the Google OAuth redirect (/settings?google=connected|error)
  useEffect(() => {
    if (!me) return;
    const g = new URLSearchParams(window.location.search).get("google");
    if (!g) return;
    showToast(
      g === "connected"
        ? lang === "el"
          ? "Συνδέθηκε ο λογαριασμός Google"
          : "Google account connected"
        : lang === "el"
          ? "Η σύνδεση με Google απέτυχε"
          : "Google sign-in failed",
    );
    window.history.replaceState(null, "", window.location.pathname);
  }, [me, lang, showToast]);

  const unreadNotifCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);
  const unreadMsgCount = useMemo(() => messages.filter((m) => !m.read).length, [messages]);

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
      };
    }
    return null;
  }, [selectedCourseCode, courses, catalog]);

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
    const idx = TAB_ORDER.indexOf(tab);
    if (idx > 0) navigateTab(TAB_ORDER[idx - 1], "right");
  };
  const goNext = () => {
    const idx = TAB_ORDER.indexOf(tab);
    if (selectedCourseCode === null && idx < TAB_ORDER.length - 1) {
      navigateTab(TAB_ORDER[idx + 1], "left");
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
    const idx = TAB_ORDER.indexOf(tab);
    const atEdge =
      (dx > 0 && idx === 0 && selectedCourseCode === null) ||
      (dx < 0 && (idx === TAB_ORDER.length - 1 || selectedCourseCode !== null));
    // Rubber-band at the first/last page
    setSwipeOffset(atEdge ? dx * 0.15 : dx * 0.85);
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    setSwipeOffset(0);
    if (!start || start.ignore || start.locked !== "x" || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const velocity = Math.abs(dx) / Math.max(1, Date.now() - start.time);
    const far = Math.abs(dx) > window.innerWidth * 0.22;
    const flick = velocity > 0.45 && Math.abs(dx) > 30;
    if (!far && !flick) return;
    if (dx > 0) goBackOrPrev();
    else goNext();
  };

  const enrolledCount = useMemo(() => courses.filter((c) => !c.archived).length, [courses]);
  const currentTabIndex = TAB_ORDER.indexOf(tab);
  const tabLabels: Record<Tab, string> = {
    home: tr("navHome"),
    courses: tr("navCourses"),
    inbox: tr("navInbox"),
    assistant: tr("navAssistant"),
    settings: tr("navSettings"),
  };

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>myClass...</span>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <LoginScreen
        universities={universities}
        lang={lang}
        theme={theme}
        onToggleLang={() => setGuestLang((l) => (l === "el" ? "en" : "el"))}
        onToggleTheme={() => setGuestTheme((th) => (th === "dark" ? "light" : "dark"))}
        onLoggedIn={(loggedInMe) => setMe(loggedInMe)}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[var(--bg)] text-[var(--text)]">
      {/* Desktop Minimalist Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 border-r border-[var(--border)] bg-[var(--surface)] px-4 py-5 select-none">
        <div className="flex items-center justify-between px-2 mb-7">
          <button
            onClick={() => navigateTab("home")}
            className="flex items-center gap-2.5 text-left group cursor-pointer"
          >
            <Logo size={36} />
            <div>
              <div className="font-semibold tracking-tight text-base leading-none">myClass</div>
              <div className="text-xs text-[var(--muted)] mt-1 truncate max-w-[140px]">
                {me.universityName}
              </div>
            </div>
          </button>
        </div>

        <nav className="space-y-1 flex-1">
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
            icon={<Inbox className="w-4 h-4" />}
            label={tr("navInbox")}
            badge={unreadMsgCount || undefined}
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
            icon={<Settings className="w-4 h-4" />}
            label={tr("navSettings")}
            active={tab === "settings"}
            onClick={() => navigateTab("settings")}
          />
        </nav>

        {/* Bottom user card */}
        <div className="pt-4 border-t border-[var(--border)] space-y-2">
          <div className="px-2.5 py-2 rounded-xl bg-[var(--surface-2)] flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium truncate">{me.displayName}</div>
              <div className="text-xs text-[var(--muted)] truncate">{me.username}</div>
            </div>
            <button
              title={tr("themeLabel")}
              onClick={async () => {
                const next = theme === "dark" ? "light" : "dark";
                const res = await api.patchSettings({ theme: next });
                setMe(res.me);
              }}
              className="p-1.5 rounded-lg hover:bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="flex-1 md:pl-64 flex flex-col min-h-screen pb-24 md:pb-0">
        {/* Top bar */}
        <header className="sticky top-0 z-20 backdrop-blur-md bg-[var(--bg)]/85 border-b border-[var(--border)] px-4 md:px-8 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {activeCourse ? (
              <button
                onClick={goBack}
                aria-label={tr("back")}
                className="md:hidden -ml-1.5 p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            ) : (
              <Logo size={30} className="md:hidden rounded-lg" />
            )}
            <div className="truncate">
              <span className="md:hidden text-base font-semibold tracking-tight">
                {activeCourse ? activeCourse.title : tabLabels[tab]}
              </span>
              <span className="hidden md:inline text-sm">
                <span className="text-[var(--muted)]">{tr("welcomeBack")} </span>
                <span className="font-medium">{me.displayName}</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setSyncing(true);
                try {
                  await api.pollNow();
                  await refreshAllData();
                  showToast(lang === "el" ? "Συγχρονίστηκε με το eClass" : "Synced with eClass");
                } finally {
                  setSyncing(false);
                }
              }}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3 py-2 md:py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin text-[var(--accent)]" : ""}`} />
              <span className="hidden sm:inline">{syncing ? tr("syncing") : tr("syncNow")}</span>
            </button>

            {/* Notifications bell */}
            <div className="relative">
              <button
                onClick={() => setBellOpen((o) => !o)}
                className="relative p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition cursor-pointer"
                aria-label={tr("notificationsBell")}
              >
                <Bell className="w-4 h-4" />
                {unreadNotifCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[11px] font-bold flex items-center justify-center">
                    {unreadNotifCount}
                  </span>
                )}
              </button>

              {bellOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 z-40">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border)]">
                    <span className="text-xs font-semibold">{tr("notificationsBell")}</span>
                    <button
                      onClick={async () => {
                        const res = await api.markAllNotificationsRead();
                        if (res.notifications) {
                          setNotifications(res.notifications);
                        } else {
                          setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                        }
                      }}
                      className="text-xs text-[var(--accent)] hover:underline cursor-pointer"
                    >
                      {tr("markAllRead")}
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto space-y-1.5">
                    {notifications.length === 0 ? (
                      <div className="text-xs text-[var(--muted)] py-6 text-center">{tr("noItems")}</div>
                    ) : (
                      notifications.slice(0, 12).map((n) => (
                        <div
                          key={n.id}
                          onClick={async () => {
                            setBellOpen(false);
                            // Remove notification once opened
                            setNotifications((prev) => prev.filter((item) => item.id !== n.id));
                            if (n.courseCode) openCourse(n.courseCode, "announcements");
                            try {
                              const res = await api.openNotification(n.id, true);
                              setNotifications(res.notifications);
                            } catch {
                              /* ignore */
                            }
                          }}
                          className={`p-2.5 rounded-xl text-xs cursor-pointer transition group ${
                            n.read ? "opacity-65 hover:bg-[var(--surface-2)]" : "bg-[var(--surface-2)]"
                          }`}
                        >
                          <div className="font-medium flex items-center justify-between gap-2">
                            <span className="truncate">{n.title}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {!n.read && <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
                              <button
                                title={lang === "el" ? "Απόρριψη" : "Dismiss"}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  setNotifications((prev) => prev.filter((item) => item.id !== n.id));
                                  try {
                                    const res = await api.openNotification(n.id, true);
                                    setNotifications(res.notifications);
                                  } catch {
                                    /* ignore */
                                  }
                                }}
                                className="p-0.5 rounded text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                          <div className="text-xs text-[var(--muted)] line-clamp-2 mt-0.5">{n.body}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Toast banner */}
        {toast && (
          <div className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-50 px-4 py-2.5 rounded-xl bg-[var(--surface)] border border-[var(--accent)]/40 shadow-lg text-xs font-medium flex items-center gap-2">
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
          className="flex-1 px-4 sm:px-5 md:px-8 py-4 md:py-6 max-w-6xl w-full mx-auto overflow-x-hidden touch-pan-y"
        >
          <div
            key={`${tab}-${selectedCourseCode ?? "root"}`}
            className={
              slideDir === "left"
                ? "animate-slide-left"
                : slideDir === "right"
                  ? "animate-slide-right"
                  : undefined
            }
            style={{
              transform: swipeOffset !== 0 ? `translateX(${swipeOffset}px)` : undefined,
              transition: swipeOffset !== 0 ? "none" : "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {tab === "home" && (
              <HomeView
                lang={lang}
                courses={courses}
                catalogCount={catalog.length}
                announcements={announcements}
                assignments={assignments}
                assignmentsLoading={assignmentsLoading}
                messages={messages}
                lastPollAt={lastPollAt}
                onOpenCourse={openCourse}
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
                activeDepartment={activeDepartment}
                catalogLoading={catalogLoading}
                warnings={courseWarnings}
                syncing={syncing}
                initialViewMode={coursesInitialViewMode}
                onChangeDepartment={loadDepartmentCatalog}
                onSelectCourse={(code, sub) => openCourse(code, sub)}
                onChanged={refreshAllData}
                showToast={showToast}
              />
            )}

            {tab === "courses" && activeCourse && (
              <CourseDetailView
                lang={lang}
                course={activeCourse}
                subTab={courseSubTab}
                onChangeSubTab={setCourseSubTab}
                announcements={announcements.filter((a) => a.courseCode === activeCourse.code)}
                assignments={assignments.filter((a) => a.courseCode === activeCourse.code)}
                focusAssignmentId={focusAssignmentId}
                onOpenInbox={() => navigateTab("inbox", "left")}
                onBack={goBack}
                onEnrolledOrUnenrolled={async () => {
                  await refreshAllData();
                }}
                showToast={showToast}
              />
            )}

            {tab === "inbox" && <InboxView lang={lang} messages={messages} />}

            {tab === "assistant" && (
              <AssistantView lang={lang} onActionCompleted={refreshAllData} />
            )}

            {tab === "settings" && (
              <SettingsView
                me={me}
                lang={lang}
                onUpdatedMe={setMe}
                onLoggedOut={() => {
                  window.history.replaceState(null, "", "/");
                  setTab("home");
                  setSelectedCourseCode(null);
                  setMe(null);
                }}
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
            className="hidden md:inline-flex fixed bottom-6 right-6 z-30 items-center gap-2 px-3.5 py-2.5 rounded-full bg-[var(--accent)] text-white dark:text-[#0c0a14] font-medium text-xs shadow-lg hover:opacity-95 transition cursor-pointer"
          >
            <Bot className="w-4 h-4" />
            <span>{tr("navAssistant")}</span>
          </button>
          {quickChatOpen && (
            <div className="hidden md:flex fixed bottom-20 right-6 z-40 w-[400px] h-[460px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-2)]">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Bot className="w-4 h-4 text-[var(--accent)]" />
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
          icon={<Inbox className="w-5 h-5" />}
          label={tr("navInbox")}
          badge={unreadMsgCount || undefined}
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
          icon={<Settings className="w-5 h-5" />}
          label={tr("navSettings")}
          active={tab === "settings"}
          onClick={() => navigateTab("settings")}
        />
      </nav>
    </div>
  );
}

/* ================================================================== */
/* Login Screen                                                        */
/* ================================================================== */

const LAST_UNI_KEY = "myclass:lastUniversity";

function readLastUniversity(): string {
  try {
    return localStorage.getItem(LAST_UNI_KEY) ?? "";
  } catch {
    return "";
  }
}

function LoginScreen({
  universities,
  lang,
  theme,
  onToggleLang,
  onToggleTheme,
  onLoggedIn,
}: {
  universities: University[];
  lang: Lang;
  theme: ThemePref;
  onToggleLang: () => void;
  onToggleTheme: () => void;
  onLoggedIn: (me: Me) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [universityId, setUniversityId] = useState<string>(readLastUniversity);
  // Once the user picks a university by hand, stop auto-filling it from the username.
  const [pickedByHand, setPickedByHand] = useState<boolean>(() => readLastUniversity() !== "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedUniversities = useMemo(
    () =>
      [...universities].sort((a, b) =>
        (lang === "el" ? a.name : a.nameEn).localeCompare(lang === "el" ? b.name : b.nameEn, lang),
      ),
    [universities, lang],
  );

  const onUsernameChange = (value: string) => {
    setUsername(value);
    if (!pickedByHand) {
      const detected = detectUniversityId(value);
      if (detected && universities.some((u) => u.id === detected)) setUniversityId(detected);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!universityId) {
      setError(tr("chooseUniversity"));
      return;
    }
    setLoading(true);
    try {
      const res = await api.login({ universityId, username: username.trim(), password, remember });
      try {
        localStorage.setItem(LAST_UNI_KEY, universityId);
      } catch {
        /* storage unavailable */
      }
      onLoggedIn(res.me);
    } catch (err) {
      setError(err instanceof ServerUnavailableError ? tr("serverUnreachable") : (err as Error).message);
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
          <span className="font-semibold tracking-tight text-base">myClass</span>
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
              <label htmlFor="login-university" className="block text-xs font-medium mb-1.5">
                {tr("universityLabel")}
              </label>
              <select
                id="login-university"
                value={universityId}
                onChange={(e) => {
                  setUniversityId(e.target.value);
                  setPickedByHand(true);
                }}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="" disabled>
                  {tr("chooseUniversity")}
                </option>
                {sortedUniversities.map((u) => (
                  <option key={u.id} value={u.id}>
                    {lang === "el" ? u.name : u.nameEn}
                  </option>
                ))}
              </select>
            </div>

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
                onChange={(e) => onUsernameChange(e.target.value)}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
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
              <div role="alert" className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-[var(--accent)] text-white dark:text-[#0c0a14] font-semibold text-sm hover:opacity-95 transition cursor-pointer disabled:opacity-50"
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
  assignments,
  assignmentsLoading,
  messages,
  lastPollAt,
  onOpenCourse,
  onOpenEnrolledCourses,
  onOpenAllCourses,
  onOpenInbox,
  onOpenAssistant,
}: {
  lang: Lang;
  courses: Course[];
  catalogCount: number;
  announcements: Announcement[];
  assignments: Assignment[];
  assignmentsLoading?: boolean;
  messages: Message[];
  lastPollAt?: string;
  onOpenCourse: (
    code: string,
    sub?: "announcements" | "documents" | "assignments" | "info",
    assignmentId?: string,
  ) => void;
  onOpenEnrolledCourses: () => void;
  onOpenAllCourses: () => void;
  onOpenInbox: () => void;
  onOpenAssistant: () => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const activeCourses = courses.filter((c) => !c.archived);
  const now = Date.now();
  const dueThisWeek = assignments.filter(
    (a) =>
      !a.submitted && a.deadline && new Date(a.deadline).getTime() >= now && new Date(a.deadline).getTime() - now < 7 * 86_400_000,
  );
  const unreadMessages = messages.filter((m) => !m.read);

  const chip =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] cursor-pointer";

  return (
    <div className="space-y-5">
      {/* Quick stats */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onOpenEnrolledCourses} className={chip}>
          <BookOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
          {activeCourses.length} {lang === "el" ? "μαθήματα" : "courses"}
        </button>
        <span className={chip.replace("hover:border-[var(--accent)] cursor-pointer", "")}>
          <Clock className="w-3.5 h-3.5 text-[var(--warn)]" />
          {dueThisWeek.length} {lang === "el" ? "προθεσμίες αυτή την εβδομάδα" : "due this week"}
        </span>
        {unreadMessages.length > 0 && (
          <button onClick={onOpenInbox} className={chip}>
            <Mail className="w-3.5 h-3.5 text-[var(--accent)]" />
            {unreadMessages.length} {lang === "el" ? "νέα μηνύματα" : "new messages"}
          </button>
        )}
        <button onClick={onOpenAssistant} className={chip}>
          <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
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
        <div className="xl:col-span-2 xl:order-2 space-y-5">
          <DeadlineCalendar
            lang={lang}
            assignments={assignments}
            loading={assignmentsLoading}
            onOpenAssignment={(a) => onOpenCourse(a.courseCode, "assignments", a.id)}
          />

          {unreadMessages.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Mail className="w-4 h-4 text-[var(--accent)]" />
                <span>{tr("unreadMessages")}</span>
              </h2>
              {unreadMessages.slice(0, 4).map((m) => (
                <button
                  key={m.id}
                  onClick={onOpenInbox}
                  className="w-full text-left p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition cursor-pointer"
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
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Bell className="w-4 h-4 text-[var(--accent)]" />
            <span>{tr("recentAnnouncements")}</span>
          </h2>
          <div className="space-y-2.5">
            {announcements.length === 0 ? (
              <EmptyCard text={tr("noItems")} />
            ) : (
              announcements.slice(0, 8).map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenCourse(a.courseCode, "announcements")}
                  className="w-full text-left p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)] mb-1">
                    <span className="font-medium text-[var(--accent)] truncate">{a.courseTitle ?? a.courseCode}</span>
                    <span className="shrink-0">
                      {new Date(a.date).toLocaleDateString(lang === "el" ? "el-GR" : "en-US", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </div>
                  <div className="text-sm font-semibold leading-snug">{a.title}</div>
                  <p className="text-sm text-[var(--muted)] mt-1 line-clamp-2 leading-relaxed">{a.contentText}</p>
                </button>
              ))
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              onClick={onOpenAllCourses}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)] cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
              {tr("coursesTitle")}
              {catalogCount > 0 && <span className="text-[var(--muted)]">{catalogCount}</span>}
            </button>
            <a
              href="/api/documents/zip-all"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]"
            >
              <Download className="w-3.5 h-3.5 text-[var(--accent)]" />
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

const SEMESTER_META: Array<{
  index: number;
  folder: string;
  labelEl: string;
  labelEn: string;
}> = [
  { index: 1, folder: "Α_εξάμηνο", labelEl: "Α' Εξάμηνο", labelEn: "1st Semester" },
  { index: 2, folder: "Β_εξάμηνο", labelEl: "Β' Εξάμηνο", labelEn: "2nd Semester" },
  { index: 3, folder: "Γ_εξάμηνο", labelEl: "Γ' Εξάμηνο", labelEn: "3rd Semester" },
  { index: 4, folder: "Δ_Εξάμηνο", labelEl: "Δ' Εξάμηνο", labelEn: "4th Semester" },
  { index: 5, folder: "Ε_Εξάμηνο", labelEl: "Ε' Εξάμηνο", labelEn: "5th Semester" },
  { index: 6, folder: "ΣΤ_Εξάμηνο", labelEl: "ΣΤ' Εξάμηνο", labelEn: "6th Semester" },
  { index: 7, folder: "Ζ_Εξάμηνο", labelEl: "Ζ' Εξάμηνο", labelEn: "7th Semester" },
  { index: 8, folder: "Η_Εξάμηνο", labelEl: "Η' Εξάμηνο", labelEn: "8th Semester" },
  { index: 9, folder: "Πτυχιακές_Γενικά", labelEl: "Γενικά & λοιπά", labelEn: "General & other" },
];

function CoursesView({
  lang,
  courses,
  catalog,
  catalogLoading,
  warnings = [],
  syncing = false,
  initialViewMode = "enrolled",
  onSelectCourse,
  onChanged,
  showToast,
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
  onSelectCourse: (code: string, sub?: "announcements" | "documents" | "assignments" | "info") => void;
  onChanged: () => Promise<void>;
  showToast: (m: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  // Default view is the classes the student is subscribed to ("enrolled")
  const [viewMode, setViewMode] = useState<"enrolled" | "all">(initialViewMode);
  const [selectedSemester, setSelectedSemester] = useState<number | "all">("all");
  const [collapsedSemesters, setCollapsedSemesters] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [busyCode, setBusyCode] = useState<string | null>(null);

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
  const filteredSubjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sourceSubjects.filter((s) => {
      if (selectedSemester !== "all" && (s.semesterIndex ?? 9) !== selectedSemester) {
        return false;
      }
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
  }, [sourceSubjects, selectedSemester, searchQuery]);

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
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [filteredSubjects]);

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

  return (
    <div className="space-y-5">
      {/* Header: My courses / All switch + download */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
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
              className={`px-3.5 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                viewMode === mode
                  ? "bg-[var(--accent)] text-white dark:text-[#0c0a14]"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {label}
              <span className="ml-1.5 text-xs opacity-70">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
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
              className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
            >
              <ChevronDown
                className={`w-4 h-4 transition ${
                  groupedBySemester.every(([idx]) => collapsedSemesters.has(idx)) ? "" : "rotate-180"
                }`}
              />
            </button>
          )}
          <a
            href="/api/documents/zip-all"
            title={tr("downloadAllCourses")}
            className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)] hover:border-[var(--accent)]"
          >
            <Download className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Minimalist Search + Semester Folder Dropdown Bar */}
      <div className="p-3 sm:p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] grid grid-cols-1 sm:grid-cols-12 gap-2.5">
        {/* Search Input */}
        <div className="relative sm:col-span-7">
          <Search className="w-4 h-4 text-[var(--muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr("searchCatalogPlaceholder")}
            className="w-full pl-9 pr-8 py-2 rounded-xl text-xs border border-[var(--border)] bg-[var(--surface-2)] focus:outline-none focus:border-[var(--accent)]"
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

        {/* Minimalist Semester Folder Dropdown List */}
        <div className="relative sm:col-span-5">
          <Folder className="w-3.5 h-3.5 text-[var(--accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <select
            aria-label={lang === "el" ? "Επιλογή Εξαμήνου" : "Select Semester"}
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
            className="w-full pl-8 pr-8 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)] cursor-pointer appearance-none"
          >
            <option value="all">
              {tr("allSemestersFilter")} ({sourceSubjects.length})
            </option>
            {SEMESTER_META.map((sem) => {
              const count = semesterCounts.get(sem.index) ?? 0;
              if (count === 0) return null;
              return (
                <option key={sem.index} value={sem.index}>
                  {lang === "el" ? sem.labelEl : sem.labelEn} ({sem.folder}) · {count}
                </option>
              );
            })}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-[var(--muted)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
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
      ) : groupedBySemester.length === 0 ? (
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
                  className="text-xs rounded-lg px-3 py-2 bg-amber-500/10 text-[var(--warn)] border border-amber-500/20"
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
        <div className="space-y-3">
          {groupedBySemester.map(([semIndex, list]) => {
            const meta =
              SEMESTER_META.find((m) => m.index === semIndex) ??
              SEMESTER_META[SEMESTER_META.length - 1];
            const isOpen = !collapsedSemesters.has(semIndex);

            return (
              <section
                key={semIndex}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden transition"
              >
                {/* Minimalist Collapsible Semester Dropdown Header */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSemesterAccordion(semIndex)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleSemesterAccordion(semIndex);
                    }
                  }}
                  className="px-4 py-3 flex items-center justify-between gap-3 bg-[var(--surface)] hover:bg-[var(--surface-2)]/70 transition cursor-pointer select-none"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="text-xs sm:text-sm font-semibold tracking-tight truncate">
                        {lang === "el" ? meta.labelEl : meta.labelEn}
                      </span>
                      <span className="text-xs text-[var(--muted)] font-mono hidden xs:inline">
                        ({meta.folder})
                      </span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--muted)] font-medium">
                        {list.length}
                      </span>
                    </div>
                  </div>

                  <a
                    href={`/api/documents/zip-all?semester=${semIndex}`}
                    onClick={(e) => e.stopPropagation()}
                    title={`${tr("downloadSemesterZip")} (${meta.folder}.zip)`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--accent)] transition shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{meta.folder}.zip</span>
                  </a>
                </div>

                {/* Expandable Minimalist Course List */}
                {isOpen && (
                  <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
                    {list.map((c) => {
                      const isBusy = busyCode === c.code;
                      return (
                        <div
                          key={c.code}
                          className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--surface-2)]/40 transition"
                        >
                          {/* Left: Subject Code, Title & Professor */}
                          <div
                            onClick={() => onSelectCourse(c.code, "documents")}
                            className="min-w-0 flex-1 cursor-pointer group"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono">
                                {c.publicCode ?? c.code}
                              </span>
                              <h3 className="text-xs sm:text-sm font-semibold group-hover:text-[var(--accent)] transition truncate">
                                {c.title}
                              </h3>
                              {c.enrolled && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium inline-flex items-center gap-1">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  <span className="hidden sm:inline">{tr("enrolledBadge")}</span>
                                </span>
                              )}
                            </div>

                            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                              <User className="w-3 h-3 text-[var(--accent)] shrink-0" />
                              <span className="truncate">
                                {c.professor ||
                                  (lang === "el" ? "Διδάσκων Τμήματος" : "Department Instructor")}
                              </span>
                            </div>
                          </div>

                          {/* Right: Minimalist Action Buttons */}
                          <div className="flex items-center justify-end gap-1.5 shrink-0">
                            <button
                              onClick={() => onSelectCourse(c.code, "documents")}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 cursor-pointer"
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                              <span>{tr("viewFilesBtn")}</span>
                            </button>

                            <a
                              href={`/api/courses/${encodeURIComponent(c.code)}/documents/zip`}
                              title={tr("downloadCourseZip")}
                              className="p-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--accent)] transition"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>

                            {c.enrolled ? (
                              <button
                                disabled={isBusy}
                                title={tr("unenrollCourse")}
                                onClick={async () => {
                                  const ok = window.confirm(
                                    lang === "el"
                                      ? `Απεγγραφή από το μάθημα «${c.title}» στο eClass;`
                                      : `Unenroll from "${c.title}" on eClass?`,
                                  );
                                  if (!ok) return;
                                  setBusyCode(c.code);
                                  try {
                                    await api.unenroll(c.code);
                                    showToast(
                                      lang === "el"
                                        ? `Απεγγράφηκες από ${c.title}`
                                        : `Unenrolled from ${c.title}`,
                                    );
                                    await onChanged();
                                  } catch (err) {
                                    showToast((err as Error).message);
                                  } finally {
                                    setBusyCode(null);
                                  }
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-red-500/10 text-[var(--muted)] hover:text-red-400 cursor-pointer disabled:opacity-50"
                              >
                                <UserMinus className="w-3.5 h-3.5" />
                                <span>{lang === "el" ? "Απεγγραφή" : "Leave"}</span>
                              </button>
                            ) : (
                              <button
                                disabled={isBusy || c.locked}
                                onClick={async () => {
                                  setBusyCode(c.code);
                                  try {
                                    await api.enroll(c.code);
                                    showToast(
                                      lang === "el" ? `Εγγράφηκες στο ${c.title}` : `Joined ${c.title}`,
                                    );
                                    await onChanged();
                                  } catch (err) {
                                    showToast((err as Error).message);
                                  } finally {
                                    setBusyCode(null);
                                  }
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--surface-2)] hover:bg-[var(--accent)] hover:text-white dark:hover:text-[#0c0a14] transition cursor-pointer disabled:opacity-40"
                              >
                                <UserPlus className="w-3.5 h-3.5" />
                                <span>{tr("enrollBtn")}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

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
  assignments,
  focusAssignmentId,
  onOpenInbox,
  onBack,
  onEnrolledOrUnenrolled,
  showToast,
}: {
  lang: Lang;
  course: Course;
  subTab: "announcements" | "documents" | "assignments" | "info";
  onChangeSubTab: (t: "announcements" | "documents" | "assignments" | "info") => void;
  announcements: Announcement[];
  assignments: Assignment[];
  focusAssignmentId?: string | null;
  onOpenInbox: () => void;
  onBack: () => void;
  onEnrolledOrUnenrolled: () => Promise<void>;
  showToast: (m: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [dir, setDir] = useState("/");
  const [docs, setDocs] = useState<DocNode[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [courseAnnouncements, setCourseAnnouncements] = useState<Announcement[]>(announcements);
  const [annLoading, setAnnLoading] = useState(false);
  const [openAssignmentId, setOpenAssignmentId] = useState<string | null>(focusAssignmentId ?? null);
  const [summaryPath, setSummaryPath] = useState<string | null>(null);
  const [courseAssignments, setCourseAssignments] = useState<Assignment[]>(assignments);
  const [asgLoading, setAsgLoading] = useState(false);

  useEffect(() => {
    setDir("/");
    setSummaryPath(null);
  }, [course.code]);

  useEffect(() => {
    if (focusAssignmentId) setOpenAssignmentId(focusAssignmentId);
  }, [focusAssignmentId]);

  // Assignments of courses outside the global feed (e.g. opened from the catalog) are fetched on demand
  useEffect(() => {
    if (assignments.length > 0) {
      setCourseAssignments(assignments);
      return;
    }
    if (subTab !== "assignments") return;
    setAsgLoading(true);
    void api
      .assignments(course.code)
      .then((r) => setCourseAssignments(r.assignments))
      .catch(() => setCourseAssignments([]))
      .finally(() => setAsgLoading(false));
  }, [course.code, subTab, assignments]);

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

  // Fetch live announcements for this subject if not already in global feed
  useEffect(() => {
    if (announcements.length > 0) {
      setCourseAnnouncements(announcements);
      return;
    }
    if (subTab !== "announcements") return;
    setAnnLoading(true);
    void api
      .announcements(course.code)
      .then((res) => setCourseAnnouncements(res.announcements))
      .catch(() => setCourseAnnouncements([]))
      .finally(() => setAnnLoading(false));
  }, [course.code, subTab, announcements]);

  const parentDir = useMemo(() => {
    if (!dir || dir === "/") return null;
    const idx = dir.lastIndexOf("/");
    return idx <= 0 ? "/" : dir.slice(0, idx);
  }, [dir]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <button
            onClick={onBack}
            className="hidden md:inline-flex text-xs text-[var(--muted)] hover:text-[var(--accent)] mb-1 items-center gap-1 cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {tr("back")}
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono">
              {course.publicCode ?? course.code}
            </span>
            <h1 className="hidden md:block text-lg font-semibold tracking-tight">{course.title}</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--muted)] mt-1">
            {course.professor && (
              <span className="inline-flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span>{course.professor}</span>
              </span>
            )}
            {course.semester && <span>· {course.semester}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/courses/${encodeURIComponent(course.code)}/documents/zip`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[var(--accent)] text-white dark:text-[#0c0a14] hover:opacity-95 shadow-xs"
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
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 cursor-pointer"
            >
              <UserMinus className="w-3.5 h-3.5" />
              <span>{tr("unenrollCourse")}</span>
            </button>
          ) : (
            <button
              onClick={async () => {
                await api.enroll(course.code);
                showToast(
                  lang === "el" ? `Εγγράφηκες στο ${course.title}` : `Joined ${course.title}`,
                );
                await onEnrolledOrUnenrolled();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-soft)] cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{tr("enrollBtn")}</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border)] overflow-x-auto whitespace-nowrap -mx-4 px-4 md:mx-0 md:px-0">
        {(
          [
            ["documents", tr("tabDocuments")],
            ["announcements", tr("tabAnnouncements")],
            ["assignments", tr("tabAssignments")],
            ["info", tr("tabInfo")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => onChangeSubTab(key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 -mb-px transition cursor-pointer ${
              subTab === key
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

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
          <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-between gap-2">
            <div className="text-xs font-medium truncate">
              <span className="text-[var(--muted)]">{tr("rootFolder")}:</span> {dir}
            </div>
            {parentDir && (
              <button
                onClick={() => setDir(parentDir)}
                className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline cursor-pointer"
              >
                <FolderUp className="w-3.5 h-3.5" />
                <span>{tr("upFolder")}</span>
              </button>
            )}
          </div>

          {docsLoading ? (
            <div className="py-10 flex justify-center"><RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" /></div>
          ) : docs.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--muted)]">{tr("noItems")}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {docs.map((node) => (
                <div key={node.path}>
                <div
                  className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--surface-2)]/60 transition"
                >
                  <div
                    onClick={() => {
                      if (node.isDir) setDir(node.path);
                    }}
                    className={`flex items-center gap-3 min-w-0 ${node.isDir ? "cursor-pointer" : ""}`}
                  >
                    {node.isDir ? (
                      <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <FileText className="w-4 h-4 text-[var(--accent)] shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{node.name}</div>
                      {!node.isDir && (
                        <div className="text-xs text-[var(--muted)] flex items-center gap-2">
                          {node.size !== undefined && (
                            <span>{Math.max(1, Math.round(node.size / 1024))} KB</span>
                          )}
                          {node.date && <span>{node.date}</span>}
                        </div>
                      )}
                    </div>
                  </div>

                  {node.isDir ? (
                    <button
                      onClick={() => setDir(node.path)}
                      className="text-xs text-[var(--accent)] hover:underline cursor-pointer shrink-0"
                    >
                      {lang === "el" ? "Άνοιγμα →" : "Open →"}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <DocumentSummaryButton
                        lang={lang}
                        courseCode={course.code}
                        path={node.path}
                        open={summaryPath === node.path}
                        onToggle={() => setSummaryPath(summaryPath === node.path ? null : node.path)}
                      />
                      <a
                        href={node.downloadUrl}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-[var(--accent-soft)] text-[var(--accent-text)] hover:opacity-90"
                        aria-label={lang === "el" ? "Λήψη" : "Download"}
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">{lang === "el" ? "Λήψη" : "Download"}</span>
                      </a>
                    </div>
                  )}
                </div>
                {summaryPath === node.path && (
                  <DocumentSummaryPanel lang={lang} courseCode={course.code} path={node.path} />
                )}
                </div>
              ))}
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
                  className="w-full text-left p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition flex items-center justify-between gap-4 cursor-pointer"
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
                        asg.submitted ? "bg-emerald-500/15 text-[var(--ok)]" : "bg-amber-500/15 text-[var(--warn)]"
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

function InboxView({ lang, messages }: { lang: Lang; messages: Message[] }) {
  const tr = (k: DictKey) => t(lang, k);
  const [selected, setSelected] = useState<Message | null>(messages[0] ?? null);

  const selectMsg = async (m: Message) => {
    setSelected(m);
    if (!m.bodyHtml) {
      try {
        const res = await api.message(m.id);
        setSelected(res.message);
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">{tr("inboxTitle")}</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] overflow-hidden">
          {messages.length === 0 ? (
            <div className="p-6 text-xs text-[var(--muted)] text-center">{tr("noItems")}</div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                onClick={() => void selectMsg(m)}
                className={`p-4 cursor-pointer transition ${
                  selected?.id === m.id ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold truncate">{m.sender}</span>
                  {!m.read && <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
                </div>
                <div className="text-xs font-medium mt-0.5 truncate">{m.subject}</div>
                <div className="text-xs text-[var(--muted)] mt-0.5 truncate">
                  {m.courseTitle ?? "eClass"}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 min-h-[300px]">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--muted)]">
              {tr("selectMessage")}
            </div>
          ) : (
            <div className="space-y-3">
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
                className="text-xs leading-relaxed space-y-2"
                dangerouslySetInnerHTML={{
                  __html: sanitizeHtml(selected.bodyHtml || selected.preview || ""),
                }}
              />
            </div>
          )}
        </div>
      </div>
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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
      ? [
          "Τι προθεσμίες έχω;",
          "Τι νέα ανακοινώθηκαν;",
          "Ποια μαθήματα έχει το Α' εξάμηνο;",
        ]
      : [
          "What deadlines do I have?",
          "Any new announcements?",
          "What subjects are in the 1st semester?",
        ];

  return (
    <div
      className={`flex flex-col ${
        compact
          ? "h-full"
          : "h-[52vh] sm:h-[62vh] md:h-[calc(100vh-12rem)] max-w-[94%] sm:max-w-full mx-auto w-full"
      }`}
    >
      {!compact && (
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <div>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight flex items-center gap-2">
              <Bot className="w-5 h-5 text-[var(--accent)]" />
              <span>{tr("assistantTitle")}</span>
            </h1>
            <p className="text-xs text-[var(--muted)] mt-0.5">{tr("assistantSubtitle")}</p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={async () => {
                await api.clearChat();
                setMessages([]);
              }}
              className="text-xs text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{tr("clearChat")}</span>
            </button>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4 space-y-3 sm:space-y-4">
        {messages.length === 0 && (
          <div className="py-3 sm:py-6 text-center space-y-3 sm:space-y-4">
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center mx-auto">
              <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="max-w-md mx-auto space-y-1">
              <div className="text-xs sm:text-sm font-semibold">{tr("assistantTitle")}</div>
              <p className="text-xs sm:text-xs text-[var(--muted)]">{tr("assistantSubtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 max-w-lg mx-auto pt-1 sm:pt-2">
              {quickPrompts.map((p) => (
                <button
                  key={p}
                  onClick={() => void sendMessage(p)}
                  className="text-xs sm:text-xs px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] transition cursor-pointer"
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
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-[var(--accent)] text-white dark:text-[#0c0a14] font-medium"
                  : "bg-[var(--surface-2)] text-[var(--text)]"
              }`}
            >
              {m.toolsUsed && m.toolsUsed.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {m.toolsUsed.map((tl, idx) => (
                    <span
                      key={`${tl}-${idx}`}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono"
                    >
                      ⚡ {tl}
                    </span>
                  ))}
                </div>
              )}
              <FormattedChatText text={m.text} isUser={m.role === "user"} />

              {/* Confirmation Card for mutating actions */}
              {m.action && (
                <div className="mt-3 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--accent)]">
                      {tr("actionPending")}
                    </span>
                    <span className="text-[11px] font-mono text-[var(--muted)]">{m.action.tool}</span>
                  </div>
                  <div className="text-xs font-medium">{m.action.summary}</div>

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
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white dark:text-[#0c0a14] hover:opacity-95 cursor-pointer"
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
                    <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>{m.action.result || m.action.status}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            <span>{activeTool ? `Calling ${activeTool}...` : "Thinking..."}</span>
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
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={tr("chatPlaceholder")}
          className="flex-1 px-4 py-2.5 rounded-xl text-xs border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-4 py-2.5 rounded-xl bg-[var(--accent)] text-white dark:text-[#0c0a14] font-semibold text-xs inline-flex items-center gap-1.5 hover:opacity-95 cursor-pointer disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{tr("send")}</span>
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
  onUpdatedMe,
  onLoggedOut,
  showToast,
}: {
  me: Me;
  lang: Lang;
  onUpdatedMe: (m: Me) => void;
  onLoggedOut: () => void;
  showToast: (m: string) => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [googleFlowOpen, setGoogleFlowOpen] = useState(false);
  const [googleKeyInput, setGoogleKeyInput] = useState("");
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

  const setNotify = (key: "announcements" | "messages" | "assignments", value: boolean) =>
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
            {me.username} · {me.universityName}
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
        <SettingsRow label={tr("themeLabel")}>
          <Segmented
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
        <SettingsRow label={tr("languageLabel")}>
          <Segmented
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
        <SettingsRow label={tr("pollIntervalLabel")}>
          <Segmented
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
              : undefined
          }
        >
          {me.settings.notify.push ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-emerald-400 inline-flex items-center gap-1">
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
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer disabled:opacity-50"
            >
              {tr("enableWebPush")}
            </button>
          )}
        </SettingsRow>
      </SettingsGroup>

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
              { value: "google", label: tr("aiModeGoogle") },
            ]}
          />
          <p className="text-xs text-[var(--muted)]">
            {aiMode === "server"
              ? tr("aiModeServerHint")
              : aiMode === "apiKey"
                ? tr("aiModeApiKeyHint")
                : tr("aiModeGoogleHint")}
          </p>

          {aiMode === "apiKey" &&
            (me.ai.hasApiKey ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-400 inline-flex items-center gap-1">
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
                  className="px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer disabled:opacity-50"
                >
                  {tr("saveKeyBtn")}
                </button>
              </form>
            ))}

          {aiMode === "google" &&
            (me.ai.googleConnected ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-400 inline-flex items-center gap-1 truncate">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{me.ai.googleEmail || tr("pushOn")}</span>
                </span>
                <button
                  onClick={() =>
                    run(async () => {
                      const res = await api.disconnectGoogle();
                      onUpdatedMe(res.me);
                    })
                  }
                  className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer shrink-0"
                >
                  {tr("disconnectGoogleBtn")}
                </button>
              </div>
            ) : googleFlowOpen ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const res = await api.connectGoogleAccount(googleKeyInput);
                    onUpdatedMe(res.me);
                    setGoogleKeyInput("");
                    setGoogleFlowOpen(false);
                  });
                }}
              >
                <p className="text-xs text-[var(--muted)]">
                  {lang === "el"
                    ? "Πάτα «Create API key» στο παράθυρο του Google και επικόλλησέ το εδώ."
                    : "Click “Create API key” in the Google window and paste it here."}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={googleKeyInput}
                    onChange={(e) => setGoogleKeyInput(e.target.value)}
                    placeholder={tr("apiKeyPlaceholder")}
                    autoComplete="off"
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="submit"
                    disabled={busy || googleKeyInput.trim().length < 10}
                    className="px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer disabled:opacity-50"
                  >
                    {tr("saveKeyBtn")}
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() =>
                  run(async () => {
                    const res = await api.startGoogleOAuth();
                    if (res.mode === "oauth") {
                      window.location.href = res.url;
                    } else {
                      window.open(res.url, "google_aistudio", "width=960,height=720");
                      setGoogleFlowOpen(true);
                    }
                  })
                }
                className="px-3.5 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer"
              >
                {tr("connectGoogleBtn")}
              </button>
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
            className="p-2 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="px-1 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h2>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3 min-h-[52px]">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-[var(--muted)] mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
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
      className={`relative w-11 h-6 rounded-full transition cursor-pointer disabled:opacity-60 ${
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
  stretch?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={`${stretch ? "flex w-full" : "inline-flex"} rounded-xl bg-[var(--surface-2)] p-1 gap-0.5`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => value !== o.value && onChange(o.value)}
          className={`${stretch ? "flex-1" : ""} inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer disabled:cursor-default ${
            value === o.value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          {o.icon}
          <span className={o.icon ? "hidden sm:inline" : undefined}>{o.label}</span>
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
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition cursor-pointer ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent)] font-semibold"
          : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
      }`}
    >
      <span className="flex items-center gap-2.5">
        {icon}
        <span>{label}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text)]">
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
      className={`relative flex-1 min-h-[52px] flex flex-col items-center justify-center gap-1 px-1 py-1 text-xs font-medium transition cursor-pointer ${
        active ? "text-[var(--accent)] font-semibold" : "text-[var(--muted)] active:opacity-70"
      }`}
    >
      <div
        className={`relative flex items-center justify-center w-14 h-7 rounded-full transition ${
          active ? "bg-[var(--accent-soft)]" : ""
        }`}
      >
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="-top-1 right-2 absolute min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--accent)] text-white dark:text-[#0c0a14] text-[11px] font-bold flex items-center justify-center">
            {badge}
          </span>
        )}
      </div>
      <span className="truncate max-w-[64px]">{label}</span>
    </button>
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
              <span className="text-[var(--accent)] font-bold select-none">•</span>
              <span className="flex-1">{renderInlineBold(content)}</span>
            </div>
          );
        }
        return <div key={idx}>{renderInlineBold(rawLine)}</div>;
      })}
    </div>
  );
}
