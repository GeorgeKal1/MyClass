import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileUp,
  Paperclip,
  RefreshCw,
  ScrollText,
  Upload,
  X,
} from "lucide-react";
import type { Assignment, AssignmentDetail, CourseTool, Lang } from "@myclass/shared";
import { api } from "./api";
import { safeHref, sanitizeHtml } from "./sanitize";
import { weekdayShort } from "./format";
import { SectionError, Skeleton } from "./ui";

const locale = (lang: Lang) => (lang === "el" ? "el-GR" : "en-GB");

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "σε 3 ημέρες", "αύριο", "σήμερα 23:59", "πριν 2 ημέρες" */
export function relativeDue(iso: string, lang: Lang): string {
  const due = new Date(iso);
  const days = Math.round((startOfDay(due).getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
  const time = due.toLocaleTimeString(locale(lang), { hour: "2-digit", minute: "2-digit" });
  if (lang === "el") {
    if (days === 0) return `σήμερα ${time}`;
    if (days === 1) return `αύριο ${time}`;
    if (days === -1) return `χθες ${time}`;
    return days > 0 ? `σε ${days} ημέρες` : `πριν ${-days} ημέρες`;
  }
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

type DueState = "submitted" | "overdue" | "unknown" | "soon" | "later";

/**
 * eClass' calendar feed lists deadlines but not hand-ins: only the course's own assignment page says
 * what was submitted. Until that page has been read, an assignment is "not checked", never "pending".
 */
export function isUnchecked(a: Assignment): boolean {
  return !a.submitted && a.submissionKnown !== true;
}

function dueState(a: Assignment, now = Date.now()): DueState {
  if (a.submitted) return "submitted";
  if (!a.deadline) return isUnchecked(a) ? "unknown" : "later";
  const t = new Date(a.deadline).getTime();
  // Past and never seen on its course page: it may well have been handed in, so do not call it overdue
  if (t < now) return isUnchecked(a) ? "unknown" : "overdue";
  if (isUnchecked(a)) return "unknown";
  return t - now < 3 * 86_400_000 ? "soon" : "later";
}

/**
 * Each state has its own shape as well as its colour, so it reads without colour too:
 * a tick (handed in), an exclamation (overdue), a ring (not checked), a filled dot (pending),
 * a filled diamond (due within 3 days).
 */
function DueMarker({ state, size = 10 }: { state: DueState; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 10 10", "aria-hidden": true as const, className: "shrink-0" };
  switch (state) {
    case "submitted":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="5" fill="var(--ok)" />
          <path d="M2.7 5.2 4.3 6.7 7.4 3.5" fill="none" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "overdue":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="5" fill="var(--danger)" />
          <path d="M5 2.4v3.1" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="5" cy="7.4" r="0.85" fill="var(--surface)" />
        </svg>
      );
    case "unknown":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="4.1" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
        </svg>
      );
    case "soon":
      return (
        <svg {...common}>
          <path d="M5 0.6 9.4 5 5 9.4 0.6 5Z" fill="var(--warn)" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="4" fill="var(--muted)" />
        </svg>
      );
  }
}

const STATE_ORDER: DueState[] = ["overdue", "soon", "unknown", "later", "submitted"];

/* ================================================================== */
/* Home: month calendar of assignment deadlines + agenda               */
/* ================================================================== */

export function DeadlineCalendar({
  lang,
  assignments,
  loading,
  ready = true,
  error,
  onRetry,
  onOpenAssignment,
  onCheckSubmissions,
}: {
  lang: Lang;
  assignments: Assignment[];
  loading?: boolean;
  /** The list has arrived (this visit, or the last one on this device) */
  ready?: boolean;
  error?: string;
  onRetry?: () => void;
  onOpenAssignment: (a: Assignment) => void;
  /** Reads these courses' assignment pages (the student's own visits) to learn what was handed in. */
  onCheckSubmissions?: (courseCodes: string[]) => Promise<void>;
}) {
  const el = lang === "el";
  const today = startOfDay(new Date());
  const [checking, setChecking] = useState(false);
  // Phones: the month grid is folded away by default, so the list comes first (remembered)
  const [gridOpen, setGridOpen] = useState(() => {
    try {
      const saved = localStorage.getItem("myclass.calendarOpen");
      if (saved !== null) return saved === "1";
    } catch {
      /* storage unavailable */
    }
    return typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches;
  });
  const toggleGrid = () =>
    setGridOpen((o) => {
      try {
        localStorage.setItem("myclass.calendarOpen", o ? "0" : "1");
      } catch {
        /* not remembered */
      }
      return !o;
    });
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<string | null>(null);

  const withDeadline = useMemo(
    () =>
      assignments
        .filter((a) => a.deadline)
        .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()),
    [assignments],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of withDeadline) {
      const k = dayKey(new Date(a.deadline!));
      map.set(k, [...(map.get(k) ?? []), a]);
    }
    return map;
  }, [withDeadline]);

  // Monday-first grid covering the whole month
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const total = Math.ceil((offset + daysInMonth) / 7) * 7;
    return Array.from({ length: total }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  // Two letters, Monday first: the same labels as the stats ("Τ Τ / Π Π" was ambiguous)
  const weekdayNames = useMemo(() => weekdayShort(lang), [lang]);

  const now = Date.now();
  // Past and not handed in (or not checked yet): their own group, with what to do about them
  const pastOpen = selected
    ? []
    : withDeadline.filter((a) => !a.submitted && new Date(a.deadline!).getTime() < now && new Date(a.deadline!).getTime() > now - 14 * 86_400_000);
  const agenda: Assignment[] = selected
    ? (byDay.get(selected) ?? [])
    : // Every deadline still ahead, handed-in ones too (marked "submitted"), so none silently disappears
      withDeadline.filter((a) => new Date(a.deadline!).getTime() >= now).slice(0, 6);
  const undated = assignments.filter((a) => !a.deadline && !a.submitted);
  // Courses whose shown deadlines have no known hand-in state yet (one check per course)
  const uncheckedCodes = [...new Set([...agenda, ...pastOpen, ...(selected ? [] : undated)].filter(isUnchecked).map((a) => a.courseCode))];

  const monthLabel = month.toLocaleDateString(locale(lang), { month: "long", year: "numeric" });
  const selectedLabel = selected
    ? (() => {
        const [y, m, d] = selected.split("-").map(Number);
        return new Date(y, m, d).toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long" });
      })()
    : null;

  const arrow =
    "w-10 h-10 inline-flex items-center justify-center rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer";
  // Always offered: unchecked courses first; otherwise re-check every course with a deadline shown
  const shownCodes = [...new Set([...agenda, ...pastOpen, ...(selected ? [] : undated)].map((a) => a.courseCode))];
  const checkCodes = uncheckedCodes.length
    ? uncheckedCodes
    : shownCodes.length
      ? shownCodes
      : [...new Set(assignments.map((a) => a.courseCode))];
  const checkButton = onCheckSubmissions && checkCodes.length > 0 && (
    <button
      type="button"
      disabled={checking}
      onClick={async () => {
        setChecking(true);
        try {
          await onCheckSubmissions(checkCodes);
        } finally {
          setChecking(false);
        }
      }}
      title={
        el
          ? "Ανοίγει τη σελίδα εργασιών κάθε μαθήματος στο eClass για να δει τι έχεις παραδώσει (μετράει ως δική σου επίσκεψη)"
          : "Opens each course's assignment page on eClass to see what you handed in (counts as your own visit)"
      }
      className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 min-h-10 px-2.5 -mr-1 rounded-lg text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--accent-soft)] cursor-pointer disabled:opacity-60 disabled:cursor-default"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
      <span>{checking ? (el ? "Έλεγχος…" : "Checking…") : el ? "Έλεγχος παραδόσεων" : "Check hand-ins"}</span>
    </button>
  );

  return (
    <section aria-labelledby="deadlines-title" className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pt-3.5">
        <h2 id="deadlines-title" className="section-title flex items-center gap-2 whitespace-nowrap">
          <CalendarDays className="w-[1.125rem] h-[1.125rem] text-[var(--muted)]" aria-hidden />
          <span>{el ? "Προθεσμίες" : "Deadlines"}</span>
          {loading && ready && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--muted)]" aria-label={el ? "Ενημέρωση…" : "Updating…"} />}
        </h2>
        <div className="flex items-center ml-auto">
          {gridOpen && (
            <>
              <button
                type="button"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                className={arrow}
                aria-label={el ? "Προηγούμενος μήνας" : "Previous month"}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                  setSelected(null);
                }}
                className="min-h-10 px-2 rounded-lg text-sm font-medium capitalize hover:bg-[var(--surface-2)] cursor-pointer whitespace-nowrap text-center"
                title={el ? "Σήμερα" : "Today"}
              >
                {monthLabel}
              </button>
              <button
                type="button"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                className={arrow}
                aria-label={el ? "Επόμενος μήνας" : "Next month"}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={toggleGrid}
            aria-expanded={gridOpen}
            aria-controls="deadline-grid"
            className="min-h-10 px-2.5 rounded-lg text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer"
          >
            {gridOpen ? (el ? "Απόκρυψη μήνα" : "Hide month") : el ? "Εμφάνιση μήνα" : "Show month"}
          </button>
        </div>
      </div>

      {gridOpen && (
        <div id="deadline-grid" className="px-3 pt-2 pb-2">
          <div className="grid grid-cols-7 text-center text-xs text-[var(--muted)] mb-1" aria-hidden>
            {weekdayNames.map((w, i) => (
              <div key={i} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) ?? [];
              const inMonth = d.getMonth() === month.getMonth();
              const isToday = k === dayKey(today);
              const isSelected = k === selected;
              // The most urgent state of the day decides its marker; several deadlines add a count
              const top = items.map((a) => dueState(a, now)).sort((x, y) => STATE_ORDER.indexOf(x) - STATE_ORDER.indexOf(y))[0];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelected(isSelected ? null : k)}
                  aria-pressed={isSelected}
                  className={`relative h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-sm num transition-colors cursor-pointer ${
                    isToday
                      ? "bg-[var(--accent-soft)] text-[var(--accent-text)] font-semibold ring-1 ring-inset ring-[var(--accent)]/60"
                      : isSelected
                        ? "bg-[var(--surface-2)]"
                        : "hover:bg-[var(--surface-2)]"
                  } ${isSelected ? "ring-1 ring-inset ring-[var(--muted)]/50" : ""} ${inMonth ? "" : "opacity-60"}`}
                  aria-label={`${d.toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long" })}${
                    items.length ? ` · ${items.length} ${el ? (items.length === 1 ? "προθεσμία" : "προθεσμίες") : items.length === 1 ? "deadline" : "deadlines"}` : ""
                  }`}
                >
                  <span>{d.getDate()}</span>
                  <span className="flex items-center gap-0.5 h-2.5">
                    {top && <DueMarker state={top} size={9} />}
                    {items.length > 1 && <span className="text-[0.625rem] leading-none font-semibold text-[var(--muted)]">{items.length}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <ul className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 pb-3 pt-1 text-xs text-[var(--muted)]" aria-label={el ? "Υπόμνημα" : "Legend"}>
        {(
          [
            ["soon", el ? "< 3 ημέρες" : "< 3 days"],
            ["later", el ? "Εκκρεμεί" : "Pending"],
            ["overdue", el ? "Έληξε" : "Overdue"],
            ["unknown", el ? "Δεν ελέγχθηκε" : "Not checked"],
            ["submitted", el ? "Παραδόθηκε" : "Submitted"],
          ] as const
        ).map(([k, label]) => (
          <li key={k} className="inline-flex items-center gap-1 whitespace-nowrap">
            <DueMarker state={k} size={10} />
            {label}
          </li>
        ))}
      </ul>

      <div className="border-t border-[var(--border)] px-4 py-3 space-y-1">
        {!ready ? (
          error ? (
            <SectionError lang={lang} detail={error} onRetry={() => onRetry?.()} />
          ) : (
            <div className="space-y-3 py-1" aria-busy="true">
              <span className="sr-only" role="status">
                {el ? "Φόρτωση προθεσμιών…" : "Loading deadlines…"}
              </span>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3" aria-hidden>
                  <Skeleton className="w-2.5 h-2.5 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5" style={{ width: `${70 - i * 12}%` }} />
                    <Skeleton className="h-3 w-2/5" />
                  </div>
                  <Skeleton className="h-3.5 w-14" />
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            {pastOpen.length > 0 && (
              <div className="pb-2 mb-1 border-b border-[var(--border)]">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h3 className="text-xs font-semibold text-[var(--danger)]">{el ? "Εκπρόθεσμα / Προς έλεγχο" : "Overdue / To check"}</h3>
                  {checkButton}
                </div>
                <p className="text-xs text-[var(--muted)] mb-1 measure">
                  {el
                    ? "Η προθεσμία πέρασε. Με «Έλεγχος παραδόσεων» βλέπεις αν τα παρέδωσες· αν όχι, άνοιξε την εργασία για να δεις αν δέχεται ακόμα υποβολές."
                    : "These are past due. “Check hand-ins” shows whether you submitted them; if not, open the assignment to see if it still accepts submissions."}
                </p>
                {pastOpen.slice(0, 4).map((a) => (
                  <AgendaRow key={a.id} a={a} lang={lang} onClick={() => onOpenAssignment(a)} />
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-xs font-semibold text-[var(--muted)] capitalize truncate">
                {selectedLabel ?? (el ? "Επόμενες προθεσμίες" : "Coming up")}
              </h3>
              {pastOpen.length === 0 && checkButton}
            </div>
            {agenda.length === 0 ? (
              <p className="text-sm text-[var(--muted)] py-2">
                {selected
                  ? el
                    ? "Καμία προθεσμία αυτή την ημέρα."
                    : "No deadlines on this day."
                  : el
                    ? "Δεν έχεις προθεσμίες μπροστά σου."
                    : "No deadlines coming up."}
              </p>
            ) : (
              agenda.map((a) => <AgendaRow key={a.id} a={a} lang={lang} onClick={() => onOpenAssignment(a)} />)
            )}
            {!selected && undated.length > 0 && (
              <div className="pt-2">
                <h3 className="text-xs font-semibold text-[var(--muted)] mb-1">{el ? "Χωρίς προθεσμία" : "No deadline"}</h3>
                {undated.slice(0, 4).map((a) => (
                  <AgendaRow key={a.id} a={a} lang={lang} onClick={() => onOpenAssignment(a)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function AgendaRow({ a, lang, onClick }: { a: Assignment; lang: Lang; onClick: () => void }) {
  const state = dueState(a);
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-2 py-2 -mx-2 min-h-11 rounded-xl hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
    >
      <span className="mt-1">
        <DueMarker state={state} size={10} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug line-clamp-2" title={a.title}>{a.title}</span>
        <span className="block text-xs text-[var(--muted)] truncate">{a.courseTitle ?? a.courseCode}</span>
      </span>
      {a.deadline && (
        <span
          className={`text-xs shrink-0 text-right num nowrap ${
            state === "overdue" ? "text-[var(--danger)]" : state === "soon" ? "text-[var(--warn)] font-medium" : "text-[var(--muted)]"
          }`}
        >
          {a.submitted ? (lang === "el" ? "παραδόθηκε" : "submitted") : isUnchecked(a) && new Date(a.deadline).getTime() < Date.now() ? (lang === "el" ? "δεν ελέγχθηκε" : "not checked") : relativeDue(a.deadline, lang)}
          <span className="block text-[var(--muted)] font-normal">
            {new Date(a.deadline).toLocaleDateString(locale(lang), { day: "numeric", month: "short" })}
          </span>
        </span>
      )}
    </button>
  );
}

/* ================================================================== */
/* Course: assignment detail + submission                              */
/* ================================================================== */

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export function AssignmentPanel({
  lang,
  courseCode,
  assignment,
  onClose,
  onSubmitted,
}: {
  lang: Lang;
  courseCode: string;
  assignment: Assignment;
  onClose: () => void;
  onSubmitted: (message: string) => void;
}) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [comments, setComments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .assignmentDetail(courseCode, assignment.id)
      .then((r) => !cancelled && setDetail(r.assignment))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [courseCode, assignment.id]);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const maxFiles = detail?.maxFiles ?? 1;
  const tooMany = files.length > maxFiles;
  const tooBig = totalBytes > MAX_TOTAL_BYTES;
  const canSend =
    !!detail?.canSubmit &&
    !submitting &&
    !tooMany &&
    !tooBig &&
    (detail.submissionType === "text" ? text.trim().length > 0 : files.length > 0);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(list)) {
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return maxFiles === 1 ? next.slice(-1) : next;
    });
  };

  const submit = async () => {
    if (!detail || !canSend) return;
    const ok = window.confirm(
      lang === "el"
        ? `Υποβολή στο eClass για «${detail.title}»;${detail.submitted ? "\nΗ νέα υποβολή μπορεί να αντικαταστήσει την προηγούμενη." : ""}`
        : `Submit to eClass for "${detail.title}"?${detail.submitted ? "\nA new submission may replace your previous one." : ""}`,
    );
    if (!ok) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.submitAssignment(courseCode, assignment.id, { files, text, comments });
      setResult(res);
      if (res.ok) {
        setFiles([]);
        setText("");
        setComments("");
        onSubmitted(res.message);
      }
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--surface)] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug">{detail?.title ?? assignment.title}</h3>
          <div className="text-xs text-[var(--muted)] mt-0.5 flex flex-wrap gap-x-3">
            {assignment.deadline && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {new Date(assignment.deadline).toLocaleString(locale(lang), {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                · {relativeDue(assignment.deadline, lang)}
              </span>
            )}
            {(detail?.submitted ?? assignment.submitted) && (
              <span className="inline-flex items-center gap-1 text-[var(--ok)]">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {lang === "el" ? "Έχεις υποβάλει" : "Submitted"}
              </span>
            )}
            {(detail?.grade ?? assignment.grade) && (
              <span className="text-[var(--accent)] font-medium">
                {lang === "el" ? "Βαθμός" : "Grade"}: {detail?.grade ?? assignment.grade}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-[var(--surface)] text-[var(--muted)] cursor-pointer shrink-0"
          aria-label={lang === "el" ? "Κλείσιμο" : "Close"}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {loading ? (
          <div className="py-6 flex justify-center">
            <RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" />
          </div>
        ) : error ? (
          <p className="text-sm text-[var(--danger)]">{error}</p>
        ) : detail ? (
          <>
            {detail.descriptionHtml ? (
              <div
                className="rich-text text-sm text-[var(--text)]"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.descriptionHtml) }}
              />
            ) : (
              <p className="text-sm text-[var(--muted)]">
                {lang === "el" ? "Δεν υπάρχει περιγραφή." : "No description."}
              </p>
            )}

            {detail.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.attachments.map((f) => (
                  <a
                    key={f.url}
                    href={f.url}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-[var(--accent-soft)] text-[var(--accent-text)] hover:opacity-90"
                  >
                    <Paperclip className="w-3.5 h-3.5" />
                    {f.name}
                  </a>
                ))}
              </div>
            )}

            {detail.existingSubmission && (
              <p className="text-xs text-[var(--muted)] rounded-lg bg-[var(--surface-2)] px-3 py-2">
                {detail.existingSubmission}
              </p>
            )}

            {detail.canSubmit ? (
              <div className="space-y-3 pt-1">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-[var(--muted)]" />
                  {lang === "el" ? "Υποβολή εργασίας" : "Submit your work"}
                </div>

                {detail.submissionType === "text" ? (
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={8}
                    placeholder={lang === "el" ? "Γράψε την απάντησή σου…" : "Write your answer…"}
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                  />
                ) : (
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      addFiles(e.dataTransfer.files);
                    }}
                    onClick={() => inputRef.current?.click()}
                    className="rounded-xl border-2 border-dashed border-[var(--border)] hover:border-[var(--accent)] bg-[var(--bg)] px-4 py-6 text-center cursor-pointer transition-colors"
                  >
                    <FileUp className="w-5 h-5 mx-auto text-[var(--muted)]" />
                    <div className="text-sm mt-1.5">
                      {lang === "el" ? "Σύρε αρχεία εδώ ή πάτα για επιλογή" : "Drop files here or click to choose"}
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-0.5">
                      {lang === "el" ? `Έως ${maxFiles} αρχείο(α) · μέχρι 50 MB` : `Up to ${maxFiles} file(s) · max 50 MB`}
                    </div>
                    <input
                      ref={inputRef}
                      type="file"
                      multiple={maxFiles > 1}
                      className="hidden"
                      onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>
                )}

                {files.length > 0 && (
                  <ul className="space-y-1">
                    {files.map((f) => (
                      <li
                        key={`${f.name}-${f.size}`}
                        className="flex items-center justify-between gap-2 text-sm px-3 py-1.5 rounded-lg bg-[var(--surface-2)]"
                      >
                        <span className="truncate">{f.name}</span>
                        <span className="flex items-center gap-2 shrink-0 text-xs text-[var(--muted)]">
                          {fmtSize(f.size)}
                          <button
                            onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                            className="p-0.5 rounded hover:text-[var(--danger)] cursor-pointer"
                            aria-label={lang === "el" ? "Αφαίρεση" : "Remove"}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(tooMany || tooBig) && (
                  <p className="text-xs text-[var(--danger)]">
                    {tooMany
                      ? lang === "el"
                        ? `Επιτρέπονται έως ${maxFiles} αρχεία.`
                        : `At most ${maxFiles} files are allowed.`
                      : lang === "el"
                        ? "Τα αρχεία ξεπερνούν τα 50 MB."
                        : "Files exceed 50 MB."}
                  </p>
                )}

                <input
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                  placeholder={lang === "el" ? "Σχόλια προς τον διδάσκοντα (προαιρετικά)" : "Comments for the instructor (optional)"}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={submit}
                    disabled={!canSend}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {submitting
                      ? lang === "el"
                        ? "Αποστολή…"
                        : "Uploading…"
                      : lang === "el"
                        ? "Υποβολή στο eClass"
                        : "Submit to eClass"}
                  </button>
                  {safeHref(detail.url) && (
                    <a
                      href={safeHref(detail.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--accent)]"
                    >
                      {lang === "el" ? "Άνοιγμα στο eClass" : "Open on eClass"}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-[var(--muted)] rounded-lg bg-[var(--surface-2)] px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--warn)]" />
                <span>
                  {lang === "el"
                    ? "Η υποβολή δεν είναι ανοιχτή (έληξε η προθεσμία, δεν ξεκίνησε ακόμα, ή γίνεται εκτός eClass)."
                    : "Submission isn't open (deadline passed, not started yet, or handled outside eClass)."}
                  {safeHref(detail.url) && (
                    <>
                      {" "}
                      <a href={safeHref(detail.url)} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                        {lang === "el" ? "Δες το στο eClass" : "View on eClass"}
                      </a>
                    </>
                  )}
                </span>
              </div>
            )}

            {result && (
              <div
                className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${
                  result.ok ? "bg-[var(--ok-soft)] text-[var(--ok)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"
                }`}
              >
                {result.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>{result.message}</span>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Documents: AI summary                                               */
/* ================================================================== */

export function DocumentSummaryButton({
  lang,
  courseCode,
  path,
  open,
  onToggle,
}: {
  lang: Lang;
  courseCode: string;
  path: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors ${
        open
          ? "bg-[var(--accent)] text-[var(--on-accent)]"
          : "border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]"
      }`}
      title={lang === "el" ? "Σύνοψη με AI" : "AI summary"}
      aria-expanded={open}
      data-path={path}
      data-course={courseCode}
    >
      <ScrollText className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">{lang === "el" ? "Σύνοψη" : "Summary"}</span>
    </button>
  );
}

const summaryMemo = new Map<string, string>();

export function DocumentSummaryPanel({
  lang,
  courseCode,
  path,
  embedded = false,
}: {
  lang: Lang;
  courseCode: string;
  path: string;
  /** Inside the document window: no card of its own, roomier text. */
  embedded?: boolean;
}) {
  const key = `${courseCode}|${path}|${lang}`;
  const [summary, setSummary] = useState<string | null>(summaryMemo.get(key) ?? null);
  const [loading, setLoading] = useState(!summaryMemo.has(key));
  const [error, setError] = useState<string | null>(null);

  const load = (refresh = false) => {
    setLoading(true);
    setError(null);
    api
      .summarizeDocument(courseCode, path, refresh)
      .then((r) => {
        summaryMemo.set(key, r.summary.summary);
        setSummary(r.summary.summary);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!summaryMemo.has(key)) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className={embedded ? "" : "mx-4 mb-3 rounded-xl bg-[var(--accent-soft)]/60 border border-[var(--accent)]/25 px-4 py-3"}>
      <div className={`flex items-center justify-between gap-2 ${embedded ? "mb-3" : "mb-1.5"}`}>
        {embedded ? (
          <span />
        ) : (
          <span className="text-xs font-semibold text-[var(--accent-text)] inline-flex items-center gap-1.5">
            <ScrollText className="w-3.5 h-3.5" />
            {lang === "el" ? "Σύνοψη AI" : "AI summary"}
          </span>
        )}
        {!loading && (
          <button
            onClick={() => load(true)}
            className="text-xs text-[var(--muted)] hover:text-[var(--accent)] inline-flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            {lang === "el" ? "Ξανά" : "Regenerate"}
          </button>
        )}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--muted)] py-1">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          {lang === "el" ? "Διαβάζω το αρχείο…" : "Reading the file…"}
        </div>
      ) : error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : (
        <SummaryText text={summary ?? ""} />
      )}
      <p className="text-[0.6875rem] text-[var(--muted)] mt-2">
        {lang === "el"
          ? "Δημιουργήθηκε από AI — έλεγξε σημαντικές λεπτομέρειες στο πρωτότυπο."
          : "AI-generated — double-check important details in the original."}
      </p>
    </div>
  );
}

/** Renders "• " bullets and **bold** from AI text without injecting HTML. */
function SummaryText({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  const renderInline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <React.Fragment key={i}>{part}</React.Fragment>,
    );
  return (
    <div className="text-sm leading-relaxed space-y-1">
      {lines.map((l, i) => {
        const bullet = l.match(/^\s*(?:[•\-*]|\d+[.)])\s+(.*)$/);
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-[var(--muted)]">•</span>
            <span>{renderInline(bullet[1])}</span>
          </div>
        ) : (
          <p key={i}>{renderInline(l)}</p>
        );
      })}
    </div>
  );
}

/* ================================================================== */
/* Course: every eClass tool                                           */
/* ================================================================== */

const NATIVE_TAB: Record<string, "announcements" | "documents" | "assignments"> = {
  announcements: "announcements",
  document: "documents",
  work: "assignments",
};

export function CourseToolsPanel({
  lang,
  courseCode,
  onOpenTab,
  onOpenInbox,
}: {
  lang: Lang;
  courseCode: string;
  onOpenTab: (t: "announcements" | "documents" | "assignments") => void;
  onOpenInbox: () => void;
}) {
  const [tools, setTools] = useState<CourseTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTools(null);
    setError(null);
    api
      .courseTools(courseCode)
      .then((r) => !cancelled && setTools(r.tools))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [courseCode]);

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!tools)
    return (
      <div className="py-6 flex justify-center">
        <RefreshCw className="w-4 h-4 animate-spin text-[var(--accent)]" />
      </div>
    );
  if (tools.length === 0)
    return (
      <p className="text-sm text-[var(--muted)]">
        {lang === "el" ? "Δεν βρέθηκαν εργαλεία για αυτό το μάθημα." : "No tools found for this course."}
      </p>
    );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {tools.map((t) => {
        const nativeTab = NATIVE_TAB[t.id];
        const inner = (
          <>
            <span className="text-sm font-medium truncate">{t.name}</span>
            <span className="text-xs text-[var(--muted)] shrink-0 inline-flex items-center gap-1">
              {nativeTab || t.id === "message" ? (
                lang === "el" ? "στο myClass" : "in myClass"
              ) : (
                <>
                  eClass <ExternalLink className="w-3 h-3" />
                </>
              )}
            </span>
          </>
        );
        const cls =
          "flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)] transition-colors text-left cursor-pointer";
        if (nativeTab)
          return (
            <button key={t.id} className={cls} onClick={() => onOpenTab(nativeTab)}>
              {inner}
            </button>
          );
        if (t.id === "message")
          return (
            <button key={t.id} className={cls} onClick={onOpenInbox}>
              {inner}
            </button>
          );
        return (
          <a key={t.id} className={cls} href={safeHref(t.url)} target="_blank" rel="noreferrer">
            {inner}
          </a>
        );
      })}
    </div>
  );
}
