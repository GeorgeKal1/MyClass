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
  GraduationCap,
  Inbox,
  KeyRound,
  LogOut,
  Mail,
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
import { api, ensureServiceWorker, isIosNeedsHomeScreen, registerWebPush } from "./api";
import { t, type DictKey } from "./i18n";

type Tab = "home" | "courses" | "inbox" | "assistant" | "settings";
const TAB_ORDER: Tab[] = ["home", "courses", "inbox", "assistant", "settings"];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [universities, setUniversities] = useState<University[]>([]);
  const [tab, setTab] = useState<Tab>("home");
  const [selectedCourseCode, setSelectedCourseCode] = useState<string | null>(null);
  const [coursesInitialViewMode, setCoursesInitialViewMode] = useState<"enrolled" | "all">("enrolled");
  const [courseSubTab, setCourseSubTab] = useState<"announcements" | "documents" | "assignments" | "info">(
    "documents",
  );

  // Mobile horizontal swipe navigation state
  const touchStartRef = useRef<{ x: number; y: number; time: number; ignore: boolean } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);

  const [courses, setCourses] = useState<Course[]>([]);
  const [catalog, setCatalog] = useState<CatalogCourse[]>([]);
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);
  const [activeDepartment, setActiveDepartment] = useState<string>("cs-ug");
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
    void (async () => {
      try {
        const [uRes, mRes] = await Promise.all([api.universities(), api.me()]);
        setUniversities(uRes.universities);
        setMe(mRes.me);
      } catch {
        /* server might still be starting */
      } finally {
        setBooting(false);
      }
    })();
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
    try {
      const [cRes, catRes, aRes, mRes, asgRes, nRes] = await Promise.all([
        api.courses(),
        api.catalog(undefined, activeDeptRef.current),
        api.announcements(),
        api.messages(),
        api.assignments(),
        api.notifications(),
      ]);
      setCourses(cRes.courses);
      setCatalog(catRes.catalog);
      if (catRes.departments) setDepartments(catRes.departments);
      if (catRes.activeDepartment) setActiveDepartment(catRes.activeDepartment);
      setAnnouncements(aRes.announcements);
      setMessages(mRes.messages);
      setAssignments(asgRes.assignments);
      setNotifications(nRes.notifications);
      setLastPollAt(nRes.lastPollAt);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setSyncing(false);
    }
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

  const openCourse = (code: string, sub: "announcements" | "documents" | "assignments" | "info" = "documents") => {
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

  // Mobile horizontal touch swipe handlers (left/right between tabs or back from course detail)
  const handleTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    let ignore = false;
    if (target) {
      if (target.closest('input, textarea, select, button, a, [data-no-swipe="true"]')) {
        ignore = true;
      } else {
        let el: HTMLElement | null = target;
        while (el && el !== e.currentTarget) {
          if (el.scrollWidth > el.clientWidth + 8) {
            ignore = true;
            break;
          }
          el = el.parentElement;
        }
      }
    }
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), ignore };
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    if (!start || start.ignore || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      const clamped = Math.max(-64, Math.min(64, dx * 0.35));
      setSwipeOffset(clamped);
    } else if (Math.abs(dy) > Math.abs(dx)) {
      start.ignore = true;
      setSwipeOffset(0);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    setSwipeOffset(0);
    if (!start || start.ignore || e.changedTouches.length === 0) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const dt = Date.now() - start.time;

    if (dt > 700 || Math.abs(dx) < 52 || Math.abs(dx) < Math.abs(dy) * 1.3) return;

    const curIdx = TAB_ORDER.indexOf(tab);
    if (dx < 0) {
      // Swiped left -> next page
      if (curIdx < TAB_ORDER.length - 1) {
        navigateTab(TAB_ORDER[curIdx + 1], "left");
      }
    } else {
      // Swiped right -> back from CourseDetailView or previous page
      if (selectedCourseCode !== null) {
        setSlideDir("right");
        setSelectedCourseCode(null);
      } else if (curIdx > 0) {
        navigateTab(TAB_ORDER[curIdx - 1], "right");
      }
    }
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
            <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center font-bold shadow-xs">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold tracking-tight text-base leading-none">myClass</div>
              <div className="text-[11px] text-[var(--muted)] mt-1 truncate max-w-[140px]">
                {me.universityName}
              </div>
            </div>
          </button>
        </div>

        <nav className="space-y-1 flex-1">
          <NavButton
            icon={<Sparkles className="w-4 h-4" />}
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
              <div className="text-[11px] text-[var(--muted)] truncate">{me.username}</div>
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
            <div className="md:hidden w-8 h-8 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
              <GraduationCap className="w-4 h-4" />
            </div>
            <div className="truncate">
              <span className="text-xs text-[var(--muted)] hidden sm:inline">{tr("welcomeBack")} </span>
              <span className="text-sm font-medium">{me.displayName}</span>
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
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[10px] font-bold flex items-center justify-center">
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
                      className="text-[11px] text-[var(--accent)] hover:underline cursor-pointer"
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
                          <div className="text-[11px] text-[var(--muted)] line-clamp-2 mt-0.5">{n.body}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Mobile Swipe Page Slider Bar (Allows sliding left/right + quick tap arrows & dots) */}
        <div className="md:hidden flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]/70 select-none">
          <button
            onClick={() => {
              if (selectedCourseCode !== null) {
                setSlideDir("right");
                setSelectedCourseCode(null);
              } else if (currentTabIndex > 0) {
                navigateTab(TAB_ORDER[currentTabIndex - 1], "right");
              }
            }}
            disabled={currentTabIndex === 0 && selectedCourseCode === null}
            aria-label="Previous page"
            className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-25 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text)]">
              <span>{activeCourse ? activeCourse.title : tabLabels[tab]}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {TAB_ORDER.map((tKey) => (
                <button
                  key={tKey}
                  onClick={() => navigateTab(tKey)}
                  aria-label={tabLabels[tKey]}
                  className={`h-1.5 rounded-full transition-all cursor-pointer ${
                    tab === tKey ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--border)]"
                  }`}
                />
              ))}
            </div>
          </div>

          <button
            onClick={() => {
              if (currentTabIndex < TAB_ORDER.length - 1) {
                navigateTab(TAB_ORDER[currentTabIndex + 1], "left");
              }
            }}
            disabled={currentTabIndex === TAB_ORDER.length - 1}
            aria-label="Next page"
            className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-25 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

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
          className="flex-1 px-3.5 sm:px-5 md:px-8 py-5 md:py-6 max-w-6xl w-full mx-auto overflow-x-hidden"
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
            style={
              swipeOffset !== 0
                ? {
                    transform: `translateX(${swipeOffset}px)`,
                    transition: "none",
                  }
                : undefined
            }
          >
            {tab === "home" && (
              <HomeView
                lang={lang}
                courses={courses}
                catalogCount={catalog.length}
                announcements={announcements}
                assignments={assignments}
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
                onBack={() => {
                  setSlideDir("right");
                  setSelectedCourseCode(null);
                }}
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
                onLoggedOut={() => setMe(null)}
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
            className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-30 inline-flex items-center gap-2 px-3.5 py-2.5 rounded-full bg-[var(--accent)] text-white dark:text-[#0c0a14] font-medium text-xs shadow-lg hover:opacity-95 transition cursor-pointer"
          >
            <Bot className="w-4 h-4" />
            <span className="hidden sm:inline">AI Assistant</span>
          </button>
          {quickChatOpen && (
            <div className="fixed bottom-32 md:bottom-20 right-3 md:right-6 z-40 w-[calc(100vw-2.5rem)] max-w-[340px] sm:max-w-none sm:w-[400px] h-[360px] sm:h-[460px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl flex flex-col overflow-hidden">
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
          icon={<Sparkles className="w-4 h-4" />}
          label={tr("navHome")}
          active={tab === "home"}
          onClick={() => navigateTab("home")}
        />
        <MobileTab
          icon={<BookOpen className="w-4 h-4" />}
          label={tr("navCourses")}
          badge={enrolledCount || undefined}
          active={tab === "courses"}
          onClick={() => navigateTab("courses", null, "enrolled")}
        />
        <MobileTab
          icon={<Inbox className="w-4 h-4" />}
          label={tr("navInbox")}
          badge={unreadMsgCount || undefined}
          active={tab === "inbox"}
          onClick={() => navigateTab("inbox")}
        />
        <MobileTab
          icon={<Bot className="w-4 h-4" />}
          label={tr("navAssistant")}
          active={tab === "assistant"}
          onClick={() => navigateTab("assistant")}
        />
        <MobileTab
          icon={<Settings className="w-4 h-4" />}
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

function detectClientUniversityPreview(
  rawUsername: string,
  universities: University[],
  lang: Lang,
): { uniName: string; deptLabel?: string; eclassUrl: string } {
  const u = rawUsername.trim().toLowerCase();
  const findUni = (id: string) => universities.find((x) => x.id === id);

  let uni = findUni("unipi");
  let deptLabel: string | undefined =
    lang === "el" ? "Τμήμα Πληροφορικής" : "Department of Informatics";

  if (/@([a-z0-9.-]+)/i.test(u)) {
    const domain = u.split("@")[1] ?? "";
    if (domain.includes("uoa.gr") || domain.includes("di.uoa.gr")) {
      uni = findUni("uoa");
      deptLabel = undefined;
    } else if (domain.includes("ntua.gr")) {
      uni = findUni("ntua");
      deptLabel = undefined;
    } else if (domain.includes("auth.gr")) {
      uni = findUni("auth");
      deptLabel = undefined;
    } else if (domain.includes("aueb.gr")) {
      uni = findUni("aueb");
      deptLabel = undefined;
    } else if (domain.includes("upatras.gr")) {
      uni = findUni("upatras");
      deptLabel = undefined;
    } else if (domain.includes("uniwa.gr")) {
      uni = findUni("uniwa");
      deptLabel = undefined;
    }
  } else if (/^sdi\d{5,}/i.test(u)) {
    uni = findUni("uoa");
    deptLabel = undefined;
  } else if (/^el\d{5,}/i.test(u)) {
    uni = findUni("ntua");
    deptLabel = undefined;
  } else if (/^dai\d{2,}/i.test(u)) {
    deptLabel = lang === "el" ? "Τμήμα Ψηφιακών Συστημάτων" : "Digital Systems";
  }

  return {
    uniName: uni
      ? lang === "el"
        ? uni.name
        : uni.nameEn
      : lang === "el"
        ? "Πανεπιστήμιο Πειραιώς"
        : "University of Piraeus",
    deptLabel,
    eclassUrl: uni?.eclassUrl ?? "https://eclass.unipi.gr",
  };
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
  const [selectedUniId, setSelectedUniId] = useState<string>("auto");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detected = useMemo(() => {
    if (selectedUniId !== "auto") {
      const u = universities.find((x) => x.id === selectedUniId);
      if (u) {
        return {
          uniName: lang === "el" ? u.name : u.nameEn,
          eclassUrl: u.eclassUrl,
          deptLabel: undefined,
        };
      }
    }
    return detectClientUniversityPreview(username, universities, lang);
  }, [selectedUniId, username, universities, lang]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login({ universityId: selectedUniId, username, password, remember });
      onLoggedIn(res.me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[var(--bg)] text-[var(--text)] px-4 py-6">
      <div className="max-w-5xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
            <GraduationCap className="w-5 h-5" />
          </div>
          <div>
            <span className="font-semibold tracking-tight text-base">myClass</span>
            <span className="hidden sm:inline text-xs text-[var(--muted)] ml-2">{tr("appTagline")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleLang}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>{lang === "el" ? "ΕΛ / EN" : "EN / ΕΛ"}</span>
          </button>
          <button
            onClick={onToggleTheme}
            className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="max-w-md w-full mx-auto my-8 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">{tr("loginTitle")}</h1>
          <p className="text-xs text-[var(--muted)] mt-1.5 leading-relaxed">{tr("loginSubtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1">
              {lang === "el" ? "Πανεπιστήμιο" : "University"}
            </label>
            <select
              value={selectedUniId}
              onChange={(e) => setSelectedUniId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
            >
              <option value="auto">
                {lang === "el" ? "✨ Αυτόματη ανίχνευση (από το username)" : "✨ Auto-detect (from username)"}
              </option>
              {universities.map((u) => (
                <option key={u.id} value={u.id}>
                  {lang === "el" ? u.name : u.nameEn}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{tr("usernameLabel")}</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="p24..."
              className="w-full px-3 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] focus:outline-none focus:border-[var(--accent)]"
            />
            {username.trim().length >= 2 && (
              <div className="mt-2 px-3 py-2 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-1.5 text-[var(--text)] truncate">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-medium truncate">
                    {detected.uniName}
                    {detected.deptLabel ? ` · ${detected.deptLabel}` : ""}
                  </span>
                </div>
                <span className="uppercase text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
                  CAS SSO
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{tr("passwordLabel")}</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 rounded-xl text-sm border border-[var(--border)] bg-[var(--surface-2)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <label className="flex items-start gap-2.5 text-xs text-[var(--muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>{tr("rememberLabel")}</span>
          </label>

          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-xl bg-[var(--accent)] text-white dark:text-[#0c0a14] font-semibold text-xs hover:opacity-95 transition cursor-pointer disabled:opacity-50"
          >
            {loading ? tr("signingIn") : tr("signInBtn")}
          </button>
        </form>
      </div>

      <footer className="text-center text-[11px] text-[var(--muted)]">
        myClass · Open eClass (GUnet) Assistant · AES-256-GCM Encrypted Session Store
      </footer>
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
  messages: Message[];
  lastPollAt?: string;
  onOpenCourse: (code: string, sub?: "announcements" | "documents" | "assignments" | "info") => void;
  onOpenEnrolledCourses: () => void;
  onOpenAllCourses: () => void;
  onOpenInbox: () => void;
  onOpenAssistant: () => void;
}) {
  const tr = (k: DictKey) => t(lang, k);
  const activeCourses = courses.filter((c) => !c.archived);
  const pendingAssignments = assignments.filter((a) => !a.submitted);
  const unreadMessages = messages.filter((m) => !m.read);

  return (
    <div className="space-y-6">
      {/* Top quick stats focused on Subscribed Classes */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {lang === "el" ? "Πίνακας Ελέγχου Εξαμήνου" : "Semester Overview"}
          </h1>
          <p className="text-xs text-[var(--muted)] mt-0.5 leading-relaxed">
            <button
              onClick={onOpenEnrolledCourses}
              className="text-[var(--accent)] hover:underline font-medium cursor-pointer"
            >
              {activeCourses.length}{" "}
              {lang === "el" ? "εγγεγραμμένα μαθήματα" : "subscribed courses"}
            </button>{" "}
            · {pendingAssignments.length} {lang === "el" ? "εκκρεμείς εργασίες" : "pending deadlines"}
            {lastPollAt && (
              <span>
                {" "}
                · {lang === "el" ? "Τελευταίος έλεγχος" : "Last checked"}{" "}
                {new Date(lastPollAt).toLocaleTimeString(lang === "el" ? "el-GR" : "en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onOpenEnrolledCourses}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] transition cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>{tr("viewEnrolledOnly")}</span>
          </button>
          <button
            onClick={onOpenAssistant}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] hover:opacity-95 transition cursor-pointer"
          >
            <Bot className="w-3.5 h-3.5" />
            <span>{tr("navAssistant")}</span>
          </button>
        </div>
      </div>

      {/* Main 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 cols: Recent Announcements */}
        <section className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--accent)]" />
              <span>{tr("recentAnnouncements")}</span>
            </h2>
          </div>

          <div className="space-y-2.5">
            {announcements.length === 0 ? (
              <EmptyCard text={tr("noItems")} />
            ) : (
              announcements.slice(0, 8).map((a) => (
                <div
                  key={a.id}
                  onClick={() => onOpenCourse(a.courseCode, "announcements")}
                  className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--muted)] mb-1">
                    <span className="font-medium text-[var(--accent)] truncate">
                      {a.courseTitle ?? a.courseCode}
                    </span>
                    <span className="shrink-0">
                      {new Date(a.date).toLocaleDateString(lang === "el" ? "el-GR" : "en-US", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </span>
                  </div>
                  <div className="text-sm font-medium">{a.title}</div>
                  <p className="text-xs text-[var(--muted)] mt-1 line-clamp-2 leading-relaxed">
                    {a.contentText}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Right col: Deadlines & Unread Messages */}
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[var(--accent)]" />
              <span>{tr("upcomingDeadlines")}</span>
            </h2>
            <div className="space-y-2">
              {assignments.length === 0 ? (
                <EmptyCard text={tr("noItems")} />
              ) : (
                assignments.slice(0, 5).map((asg) => (
                  <div
                    key={asg.id}
                    onClick={() => onOpenCourse(asg.courseCode, "assignments")}
                    className="p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-[var(--muted)] truncate">
                        {asg.courseTitle ?? asg.courseCode}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          asg.submitted
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-amber-500/15 text-amber-400"
                        }`}
                      >
                        {asg.submitted ? tr("submitted") : tr("pending")}
                      </span>
                    </div>
                    <div className="text-xs font-medium mt-1">{asg.title}</div>
                    {asg.deadline && (
                      <div className="text-[11px] text-[var(--muted)] mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>
                          {new Date(asg.deadline).toLocaleDateString(lang === "el" ? "el-GR" : "en-US", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Mail className="w-4 h-4 text-[var(--accent)]" />
                <span>{tr("unreadMessages")}</span>
              </h2>
            </div>
            <div className="space-y-2">
              {unreadMessages.length === 0 ? (
                <EmptyCard text={tr("noItems")} />
              ) : (
                unreadMessages.slice(0, 4).map((m) => (
                  <div
                    key={m.id}
                    onClick={onOpenInbox}
                    className="p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/50 transition cursor-pointer"
                  >
                    <div className="text-xs font-medium truncate">{m.subject}</div>
                    <div className="text-[11px] text-[var(--muted)] mt-0.5 truncate">
                      {m.sender} · {m.courseTitle ?? "eClass"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Bottom Footer Actions: All Subjects & Download All Subjects (.zip) */}
      <div className="pt-2 border-t border-[var(--border)]">
        <div className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">
              {lang === "el" ? "Πλήρης Κατάλογος & Μαζική Λήψη" : "Full Curriculum & Bulk Download"}
            </span>
            <span className="block sm:inline sm:ml-2">
              {catalogCount}{" "}
              {lang === "el"
                ? "συνολικά μαθήματα προγράμματος σπουδών (Α'–Η' Εξάμηνο)"
                : "total curriculum subjects (1st–8th Semester)"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onOpenAllCourses}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] text-[var(--text)] transition cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>
                {tr("viewAllSemesters")} ({catalogCount})
              </span>
            </button>
            <a
              href="/api/documents/zip-all"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{tr("downloadAllCourses")}</span>
            </a>
          </div>
        </div>
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
  { index: 9, folder: "Πτυχιακές_Γενικά", labelEl: "Πτυχιακές / Γενικά", labelEn: "Thesis / General" },
];

function CoursesView({
  lang,
  courses,
  catalog,
  catalogLoading,
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
        semesterFolder: c.semesterFolder ?? "Πτυχιακές_Γενικά",
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
      {/* Minimalist Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold tracking-tight">
              {viewMode === "enrolled"
                ? lang === "el"
                  ? "Τα Μαθήματά μου"
                  : "My Subscribed Classes"
                : tr("coursesTitle")}
            </h1>
            <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-medium">
              {viewMode === "enrolled"
                ? `${enrolledCourses.length} ${lang === "el" ? "εγγεγραμμένα" : "subscribed"}`
                : `${sourceSubjects.length} ${lang === "el" ? "σύνολο" : "total"}`}
            </span>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            {viewMode === "enrolled"
              ? lang === "el"
                ? "Προβολή των μαθημάτων στα οποία είσαι εγγεγραμμένος. Στο κάτω μέρος της σελίδας μπορείς να δεις όλα τα μαθήματα του τμήματος."
                : "Showing the classes you are subscribed to. Scroll to the bottom to browse all university subjects."
              : tr("coursesSubtitle")}
          </p>
        </div>

        {groupedBySemester.length > 1 && (
          <button
            onClick={() => {
              const allCollapsed = groupedBySemester.every(([idx]) => collapsedSemesters.has(idx));
              if (allCollapsed) {
                setCollapsedSemesters(new Set());
              } else {
                setCollapsedSemesters(new Set(groupedBySemester.map(([idx]) => idx)));
              }
            }}
            className="self-start sm:self-auto text-[11px] text-[var(--muted)] hover:text-[var(--text)] px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] cursor-pointer transition"
          >
            {groupedBySemester.every(([idx]) => collapsedSemesters.has(idx))
              ? lang === "el"
                ? "Ανάπτυξη όλων των εξαμήνων"
                : "Expand all semesters"
              : lang === "el"
                ? "Σύμπτυξη όλων των εξαμήνων"
                : "Collapse all semesters"}
          </button>
        )}
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
              ? "Φόρτωση μαθημάτων από το Open eClass..."
              : "Loading subjects from Open eClass..."}
          </span>
        </div>
      ) : groupedBySemester.length === 0 ? (
        <div className="p-8 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 text-center space-y-3">
          <p className="text-xs text-[var(--muted)]">
            {viewMode === "enrolled" && enrolledCourses.length === 0
              ? lang === "el"
                ? "Δεν βρέθηκαν εγγεγραμμένα μαθήματα."
                : "No subscribed classes found."
              : tr("noItems")}
          </p>
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
                      <span className="text-[11px] text-[var(--muted)] font-mono hidden xs:inline">
                        ({meta.folder})
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--muted)] font-medium">
                        {list.length}
                      </span>
                    </div>
                  </div>

                  <a
                    href={`/api/documents/zip-all?semester=${semIndex}`}
                    onClick={(e) => e.stopPropagation()}
                    title={`${tr("downloadSemesterZip")} (${meta.folder}.zip)`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--accent)] transition shrink-0"
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
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono">
                                {c.publicCode ?? c.code}
                              </span>
                              <h3 className="text-xs sm:text-sm font-semibold group-hover:text-[var(--accent)] transition truncate">
                                {c.title}
                              </h3>
                              {c.enrolled && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium inline-flex items-center gap-1">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  <span className="hidden sm:inline">{tr("enrolledBadge")}</span>
                                </span>
                              )}
                            </div>

                            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
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
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium hover:bg-red-500/10 text-[var(--muted)] hover:text-red-400 cursor-pointer disabled:opacity-50"
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
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-[var(--surface-2)] hover:bg-[var(--accent)] hover:text-white dark:hover:text-[#0c0a14] transition cursor-pointer disabled:opacity-40"
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

      {/* Bottom Bar: Switch between Subscribed Classes & All University Subjects + Download All Subjects (.zip) */}
      <div className="pt-3 border-t border-[var(--border)]">
        <div className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold">
              {lang === "el"
                ? "Επιλογές Καταλόγου & Μαζικής Λήψης Αρχείων"
                : "Course Catalog & Bulk Download Options"}
            </div>
            <p className="text-[11px] text-[var(--muted)]">
              {lang === "el"
                ? "Εναλλαγή μεταξύ των εγγεγραμμένων μαθημάτων σου και όλων των μαθημάτων του προγράμματος σπουδών (Α'–Η' Εξάμηνο), ή λήψη όλων σε .zip."
                : "Switch between your subscribed classes and all university subjects (1st–8th Semester), or download all course files as a .zip."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
              <button
                onClick={() => {
                  setViewMode("enrolled");
                  setSelectedSemester("all");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                  viewMode === "enrolled"
                    ? "bg-[var(--accent)] text-white dark:text-[#0c0a14]"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {tr("viewEnrolledOnly")} ({enrolledCourses.length})
              </button>
              <button
                onClick={() => {
                  setViewMode("all");
                  setSelectedSemester("all");
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                  viewMode === "all"
                    ? "bg-[var(--accent)] text-white dark:text-[#0c0a14]"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {tr("viewAllSemesters")} ({catalog.length})
              </button>
            </div>

            <a
              href="/api/documents/zip-all"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] text-[var(--accent)] transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{tr("downloadAllCourses")}</span>
            </a>
          </div>
        </div>
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
  assignments,
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

  useEffect(() => {
    setDir("/");
  }, [course.code]);

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
            className="text-xs text-[var(--muted)] hover:text-[var(--accent)] mb-1 inline-flex items-center gap-1 cursor-pointer"
          >
            ← {tr("coursesTitle")}
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono">
              {course.publicCode ?? course.code}
            </span>
            {course.semesterFolder && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium inline-flex items-center gap-1">
                <Folder className="w-3 h-3" />
                <span>{course.semesterFolder}</span>
              </span>
            )}
            <h1 className="text-lg font-semibold tracking-tight">{course.title}</h1>
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
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
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
            <div className="py-10 text-center text-xs text-[var(--muted)]">Loading...</div>
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
                  {a.url && (
                    <a
                      href={a.url}
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
                  className="text-xs text-[var(--muted)] leading-relaxed prose prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: a.contentHtml || a.contentText }}
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
            <div className="py-10 text-center text-xs text-[var(--muted)]">Loading...</div>
          ) : docs.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--muted)]">{tr("noItems")}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {docs.map((node) => (
                <div
                  key={node.path}
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
                        <div className="text-[11px] text-[var(--muted)] flex items-center gap-2">
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
                      className="text-xs text-[var(--accent)] hover:underline cursor-pointer"
                    >
                      Open →
                    </button>
                  ) : (
                    <a
                      href={node.downloadUrl}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === "assignments" && (
        <div className="space-y-3">
          {assignments.length === 0 ? (
            <EmptyCard text={tr("noItems")} />
          ) : (
            assignments.map((asg) => (
              <div
                key={asg.id}
                className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-4"
              >
                <div>
                  <div className="text-sm font-medium">{asg.title}</div>
                  {asg.deadline && (
                    <div className="text-xs text-[var(--muted)] mt-1">
                      {new Date(asg.deadline).toLocaleString(lang === "el" ? "el-GR" : "en-US")}
                    </div>
                  )}
                  {asg.grade && (
                    <div className="text-xs text-[var(--accent)] font-medium mt-1">
                      {tr("grade")}: {asg.grade}
                    </div>
                  )}
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${
                    asg.submitted
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-amber-500/15 text-amber-400"
                  }`}
                >
                  {asg.submitted ? tr("submitted") : tr("pending")}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {subTab === "info" && (
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
                <span className="text-[var(--muted)]">Department:</span>{" "}
                <span className="font-medium">{course.departmentName}</span>
              </div>
            )}
            {course.url && (
              <div>
                <a
                  href={course.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline font-medium"
                >
                  <span>Open directly on eClass</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
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
                <div className="text-[11px] text-[var(--muted)] mt-0.5 truncate">
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
                  __html: selected.bodyHtml || selected.preview || "",
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
          "Πες μου για την 1η εργασία",
          "Ποια μαθήματα έχει το Α' Εξάμηνο;",
          "Ποια μαθήματα έχει το Ε' Εξάμηνο;",
          "Τι αρχεία έχει το μάθημα Αντικειμενοστρεφής Ανάπτυξη Εφαρμογών;",
        ]
      : [
          "Tell me about the 1st project",
          "What subjects are in the 1st Semester?",
          "What subjects are in the 5th Semester?",
          "What files are uploaded in Object-Oriented Application Development?",
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
              <p className="text-[11px] sm:text-xs text-[var(--muted)]">{tr("assistantSubtitle")}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 max-w-lg mx-auto pt-1 sm:pt-2">
              {quickPrompts.map((p) => (
                <button
                  key={p}
                  onClick={() => void sendMessage(p)}
                  className="text-[11px] sm:text-xs px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] transition cursor-pointer"
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
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-mono"
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
                    <span className="text-[11px] font-semibold text-[var(--accent)]">
                      {tr("actionPending")}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--muted)]">{m.action.tool}</span>
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
  const [googleEmailInput, setGoogleEmailInput] = useState("");
  const [googleKeyInput, setGoogleKeyInput] = useState("");

  const patch = async (p: Parameters<typeof api.patchSettings>[0]) => {
    const res = await api.patchSettings(p);
    onUpdatedMe(res.me);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-lg font-semibold tracking-tight">{tr("settingsTitle")}</h1>

      {/* Appearance & Language */}
      <section className="p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] space-y-4">
        <h2 className="text-sm font-semibold">{tr("appearanceSection")}</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1.5">{tr("themeLabel")}</label>
            <select
              value={me.settings.theme}
              onChange={(e) => void patch({ theme: e.target.value as ThemePref })}
              className="w-full px-3 py-2 rounded-xl text-xs border border-[var(--border)] bg-[var(--surface-2)]"
            >
              <option value="light">{tr("themeLight")}</option>
              <option value="dark">{tr("themeDark")}</option>
              <option value="system">{tr("themeSystem")}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-[var(--muted)] mb-1.5">{tr("languageLabel")}</label>
            <select
              value={me.settings.language}
              onChange={(e) => void patch({ language: e.target.value as Lang })}
              className="w-full px-3 py-2 rounded-xl text-xs border border-[var(--border)] bg-[var(--surface-2)]"
            >
              <option value="el">Ελληνικά (Greek)</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
      </section>

      {/* Gemini AI Connection (Google OAuth + API Key option) */}
      <section className="p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4 text-[var(--accent)]" />
            <span>{tr("aiSection")}</span>
          </h2>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">
            {me.settings.ai.model}
          </span>
        </div>

        {/* Option 1: Connect Google Account */}
        <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium flex items-center gap-2">
                <span>{tr("aiModeGoogle")}</span>
                {me.ai.googleConnected && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>{me.ai.googleEmail || "Connected"}</span>
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--muted)] mt-0.5">
                {me.ai.googleConnected
                  ? lang === "el"
                    ? `Συνδεδεμένος λογαριασμός Google (${me.ai.googleEmail ?? "Gemini"})`
                    : `Connected Google account (${me.ai.googleEmail ?? "Gemini"})`
                  : lang === "el"
                    ? "Σύνδεση με τον λογαριασμό Google σου (Google AI Studio / OAuth)"
                    : "Sign in with your Google account (Google AI Studio / OAuth)"}
              </div>
            </div>
            {me.ai.googleConnected ? (
              <button
                onClick={async () => {
                  const res = await api.disconnectGoogle();
                  onUpdatedMe(res.me);
                  showToast(
                    lang === "el" ? "Αποσυνδέθηκε ο λογαριασμός Google" : "Google account disconnected",
                  );
                }}
                className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
              >
                {tr("disconnectGoogleBtn")}
              </button>
            ) : (
              <button
                onClick={async () => {
                  try {
                    const res = await api.startGoogleOAuth();
                    if (res.mode === "oauth") {
                      window.location.href = res.url;
                    } else {
                      window.open(res.url, "google_aistudio", "width=960,height=720");
                      setGoogleFlowOpen(true);
                    }
                  } catch (err) {
                    showToast((err as Error).message);
                  }
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] hover:opacity-95 cursor-pointer"
              >
                {tr("connectGoogleBtn")}
              </button>
            )}
          </div>

          {googleFlowOpen && !me.ai.googleConnected && (
            <div className="pt-3 border-t border-[var(--border)] space-y-2.5">
              <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                {lang === "el"
                  ? "Άνοιξε το παράθυρο του Google AI Studio με τον λογαριασμό Google σου. Πάτησε «Create API key», επικόλλησέ το παρακάτω και πάτησε Ολοκλήρωση Σύνδεσης:"
                  : "A Google AI Studio window opened with your Google account. Click 'Create API key', paste it below, and click Complete Connection:"}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="email"
                  value={googleEmailInput}
                  onChange={(e) => setGoogleEmailInput(e.target.value)}
                  placeholder={lang === "el" ? "Google email (προαιρετικό)" : "Google email (optional)"}
                  className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
                />
                <input
                  type="password"
                  value={googleKeyInput}
                  onChange={(e) => setGoogleKeyInput(e.target.value)}
                  placeholder="AIzaSy... (Google Gemini token)"
                  className="sm:col-span-2 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setGoogleFlowOpen(false)}
                  className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
                >
                  {lang === "el" ? "Ακύρωση" : "Cancel"}
                </button>
                <button
                  onClick={async () => {
                    try {
                      const res = await api.connectGoogleAccount(googleKeyInput, googleEmailInput);
                      onUpdatedMe(res.me);
                      setGoogleKeyInput("");
                      setGoogleFlowOpen(false);
                      showToast(
                        lang === "el"
                          ? "Ο λογαριασμός Google συνδέθηκε επιτυχώς!"
                          : "Google account connected!",
                      );
                    } catch (err) {
                      showToast((err as Error).message);
                    }
                  }}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer"
                >
                  {lang === "el" ? "Ολοκλήρωση Σύνδεσης Google" : "Complete Google Connection"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Option 2: Personal Gemini API Key */}
        <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>{tr("aiModeApiKey")}</span>
            </div>
            {me.ai.hasApiKey && (
              <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Saved (Encrypted)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={tr("apiKeyPlaceholder")}
              className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={async () => {
                try {
                  const res = await api.saveApiKey(apiKeyInput);
                  onUpdatedMe(res.me);
                  setApiKeyInput("");
                  showToast("Gemini API key saved");
                } catch (err) {
                  showToast((err as Error).message);
                }
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white dark:text-[#0c0a14] cursor-pointer"
            >
              {tr("saveKeyBtn")}
            </button>
            {me.ai.hasApiKey && (
              <button
                onClick={async () => {
                  const res = await api.removeApiKey();
                  onUpdatedMe(res.me);
                  showToast("Gemini API key removed");
                }}
                className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
              >
                {tr("removeKeyBtn")}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{tr("notificationsSection")}</h2>
          {me.settings.notify.push && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              <span>{lang === "el" ? "Push Ενεργό" : "Push Active"}</span>
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-[var(--muted)]">{tr("pollIntervalLabel")}</span>
          <select
            value={me.settings.pollIntervalMin}
            onChange={(e) => void patch({ pollIntervalMin: Number(e.target.value) })}
            className="px-3 py-1.5 rounded-xl text-xs border border-[var(--border)] bg-[var(--surface-2)]"
          >
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
          </select>
        </div>

        {isIosNeedsHomeScreen() && (
          <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[11px] text-[var(--muted)] leading-relaxed">
            {lang === "el"
              ? "📱 Για λήψη ειδοποιήσεων Push σε iPhone/iPad: πατήστε «Κοινοποίηση» (Share) στο Safari → «Προσθήκη στην Οθόνη Αφετηρίας» (Add to Home Screen), ανοίξτε το myClass από την αρχική οθόνη και πατήστε «Ενεργοποίηση Web Push»."
              : "📱 To receive Push notifications on iPhone/iPad: tap Share in Safari → Add to Home Screen, open myClass from your Home Screen, and tap Enable Web Push."}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={async () => {
              const res = await registerWebPush();
              if (res.ok) {
                const mRes = await api.me();
                if (mRes.me) onUpdatedMe(mRes.me);
                showToast(
                  lang === "el"
                    ? "Οι ειδοποιήσεις Web Push ενεργοποιήθηκαν!"
                    : "Web Push notifications enabled!",
                );
              } else if (res.reason === "ios-homescreen") {
                showToast(
                  lang === "el"
                    ? "Σε iPhone προσθέστε πρώτα το myClass στην Οθόνη Αφετηρίας (Add to Home Screen)"
                    : "On iPhone, first add myClass to your Home Screen (Share → Add to Home Screen)",
                );
              } else if (res.reason === "denied") {
                showToast(
                  lang === "el"
                    ? "Η άδεια ειδοποιήσεων απορρίφθηκε στις ρυθμίσεις του browser"
                    : "Notification permission was denied in browser settings",
                );
              } else {
                showToast(
                  lang === "el"
                    ? "Δεν ήταν δυνατή η ενεργοποίηση Web Push"
                    : "Could not enable Web Push",
                );
              }
            }}
            className="px-3.5 py-1.5 rounded-xl text-xs font-medium border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] cursor-pointer"
          >
            {tr("enableWebPush")}
          </button>
          <button
            onClick={async () => {
              await api.sendTestNotification();
            }}
            className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] cursor-pointer"
          >
            {tr("testNotificationBtn")}
          </button>
        </div>
      </section>

      {/* Account & Privacy */}
      <section className="p-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{tr("accountSection")}</h2>
          <p className="text-xs text-[var(--muted)]">
            {me.displayName} · {me.universityName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              await api.logout();
              onLoggedOut();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{tr("signOutBtn")}</span>
          </button>
          <button
            onClick={async () => {
              if (!window.confirm("Delete all stored data and credentials from myClass?")) return;
              await api.deleteAccount();
              onLoggedOut();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs bg-red-500/15 text-red-400 hover:bg-red-500/25 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{tr("deleteDataBtn")}</span>
          </button>
        </div>
      </section>
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
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text)]">
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
      className={`relative flex-1 min-h-[48px] flex flex-col items-center justify-center gap-0.5 px-1.5 py-1 rounded-xl text-[10px] font-medium transition cursor-pointer ${
        active
          ? "text-[var(--accent)] bg-[var(--accent-soft)]/60 font-semibold"
          : "text-[var(--muted)] active:bg-[var(--surface-2)]"
      }`}
    >
      <div className="relative flex items-center justify-center">
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className=" -top-1.5 -right-3 absolute min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--accent)] text-white dark:text-[#0c0a14] text-[9px] font-bold flex items-center justify-center">
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
