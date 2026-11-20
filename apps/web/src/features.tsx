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

function dueState(a: Assignment, now = Date.now()): DueState {
  if (a.submitted) return "submitted";
  if (!a.deadline) return "later";
  const t = new Date(a.deadline).getTime();
  // Past and never seen on its course page: it may well have been handed in, so do not call it overdue
  if (t < now) return a.submissionKnown === false ? "unknown" : "overdue";
  return t - now < 3 * 86_400_000 ? "soon" : "later";
}

const DOT_CLASS: Record<DueState, string> = {
  submitted: "bg-[var(--ok)]",
  overdue: "bg-[var(--danger)]",
  unknown: "bg-[var(--border)]",
  soon: "bg-[var(--warn)]",
  later: "bg-[var(--muted)]",
};

/* ================================================================== */
/* Home: month calendar of assignment deadlines + agenda               */
/* ================================================================== */

export function DeadlineCalendar({
  lang,
  assignments,
  loading,
  onOpenAssignment,
}: {
  lang: Lang;
  assignments: Assignment[];
  loading?: boolean;
  onOpenAssignment: (a: Assignment) => void;
}) {
  const today = startOfDay(new Date());
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

  const weekdayNames = useMemo(() => {
    const monday = new Date(2024, 0, 1); // a Monday
    return Array.from({ length: 7 }, (_, i) =>
      new Date(monday.getFullYear(), 0, 1 + i).toLocaleDateString(locale(lang), { weekday: "narrow" }),
    );
  }, [lang]);

  const now = Date.now();
  const agenda: Assignment[] = selected
    ? (byDay.get(selected) ?? [])
    : // Every deadline still ahead, handed-in ones too (marked "submitted"), so none silently disappears
      withDeadline
        .filter((a) => {
          const t = new Date(a.deadline!).getTime();
          return a.submitted ? t >= now : t >= now - 86_400_000;
        })
        .slice(0, 6);
  const undated = assignments.filter((a) => !a.deadline && !a.submitted);

  const monthLabel = month.toLocaleDateString(locale(lang), { month: "long", year: "numeric" });
  const selectedLabel = selected
    ? (() => {
        const [y, m, d] = selected.split("-").map(Number);
        return new Date(y, m, d).toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long" });
      })()
    : null;

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pt-4">
        <h2 className="text-sm font-semibold flex items-center gap-2 whitespace-nowrap">
          <CalendarDays className="w-4 h-4 text-[var(--muted)]" />
          <span>{lang === "el" ? "Προθεσμίες" : "Deadlines"}</span>
          {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--muted)]" />}
        </h2>
        <div className="flex items-center gap-0.5 ml-auto">
          <button
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] cursor-pointer"
            aria-label={lang === "el" ? "Προηγούμενος μήνας" : "Previous month"}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
              setSelected(null);
            }}
            className="px-2 py-1 rounded-lg text-xs font-medium capitalize hover:bg-[var(--surface-2)] cursor-pointer whitespace-nowrap text-center"
            title={lang === "el" ? "Σήμερα" : "Today"}
          >
            {monthLabel}
          </button>
          <button
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] cursor-pointer"
            aria-label={lang === "el" ? "Επόμενος μήνας" : "Next month"}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="px-3 pt-3 pb-2">
        <div className="grid grid-cols-7 text-center text-xs text-[var(--muted)] mb-1">
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
            return (
              <button
                key={k}
                onClick={() => setSelected(isSelected ? null : k)}
                className={`relative h-11 rounded-lg flex flex-col items-center justify-center gap-1 text-xs transition-colors cursor-pointer ${
                  isToday
                    ? "bg-[var(--accent-soft)] text-[var(--accent-text)] font-semibold ring-1 ring-inset ring-[var(--accent)]/60"
                    : isSelected
                      ? "bg-[var(--surface-2)]"
                      : "hover:bg-[var(--surface-2)]"
                } ${isSelected ? "ring-1 ring-inset ring-[var(--muted)]/40" : ""} ${inMonth ? "" : "opacity-35"}`}
                aria-label={`${d.toLocaleDateString(locale(lang))}${items.length ? ` · ${items.length}` : ""}`}
              >
                <span>{d.getDate()}</span>
                <span className="flex gap-0.5 h-1.5">
                  {items.slice(0, 3).map((a) => (
                    <span
                      key={a.id}
                      className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[dueState(a, now)]}`}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 px-1 text-xs text-[var(--muted)]">
          {(
            [
              ["soon", lang === "el" ? "< 3 ημέρες" : "< 3 days"],
              ["later", lang === "el" ? "Εκκρεμεί" : "Pending"],
              ["overdue", lang === "el" ? "Έληξε" : "Overdue"],
              ["unknown", lang === "el" ? "Έληξε, δεν έχει ελεγχθεί" : "Ended, not checked"],
              ["submitted", lang === "el" ? "Παραδόθηκε" : "Submitted"],
            ] as const
          ).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${DOT_CLASS[k]}`} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-[var(--border)] px-4 py-3 space-y-1">
        <div className="text-xs font-medium text-[var(--muted)] capitalize mb-1">
          {selectedLabel ?? (lang === "el" ? "Επόμενες προθεσμίες" : "Coming up")}
        </div>
        {agenda.length === 0 ? (
          <p className="text-sm text-[var(--muted)] py-2">
            {loading
              ? lang === "el"
                ? "Φόρτωση εργασιών…"
                : "Loading assignments…"
              : selected
                ? lang === "el"
                  ? "Καμία προθεσμία αυτή την ημέρα."
                  : "No deadlines on this day."
                : lang === "el"
                  ? "Δεν έχεις προθεσμίες μπροστά σου."
                  : "No deadlines coming up."}
          </p>
        ) : (
          agenda.map((a) => <AgendaRow key={a.id} a={a} lang={lang} onClick={() => onOpenAssignment(a)} />)
        )}
        {!selected && undated.length > 0 && (
          <div className="pt-2">
            <div className="text-xs font-medium text-[var(--muted)] mb-1">
              {lang === "el" ? "Χωρίς προθεσμία" : "No deadline"}
            </div>
            {undated.slice(0, 4).map((a) => (
              <AgendaRow key={a.id} a={a} lang={lang} onClick={() => onOpenAssignment(a)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AgendaRow({ a, lang, onClick }: { a: Assignment; lang: Lang; onClick: () => void }) {
  const state = dueState(a);
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-2 py-2 -mx-2 rounded-xl hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
    >
      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[state]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug">{a.title}</span>
        <span className="block text-xs text-[var(--muted)] truncate">{a.courseTitle ?? a.courseCode}</span>
      </span>
      {a.deadline && (
        <span
          className={`text-xs shrink-0 text-right ${
            state === "overdue" ? "text-[var(--danger)]" : state === "soon" ? "text-[var(--warn)] font-medium" : "text-[var(--muted)]"
          }`}
        >
          {a.submitted ? (lang === "el" ? "παραδόθηκε" : "submitted") : relativeDue(a.deadline, lang)}
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

export function DocumentSummaryPanel({ lang, courseCode, path }: { lang: Lang; courseCode: string; path: string }) {
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
    <div className="mx-4 mb-3 rounded-xl bg-[var(--accent-soft)]/60 border border-[var(--accent)]/25 px-4 py-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-semibold text-[var(--accent-text)] inline-flex items-center gap-1.5">
          <ScrollText className="w-3.5 h-3.5" />
          {lang === "el" ? "Σύνοψη AI" : "AI summary"}
        </span>
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
