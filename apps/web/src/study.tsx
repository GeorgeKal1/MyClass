import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Layers,
  ListChecks,
  PenLine,
  RefreshCw,
  RotateCcw,
  Shuffle,
  XCircle,
} from "lucide-react";
import type { ExamQuestion, Flashcard, Lang, Me, QuizQuestion, StudyKind, StudyMaterial } from "@myclass/shared";
import { api } from "./api";

/* ================================================================== */
/* Documents: study material from one lecture file                     */
/* ================================================================== */

export function StudyButton({ lang, open, onToggle }: { lang: Lang; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors ${
        open
          ? "bg-[var(--accent)] text-[var(--on-accent)]"
          : "border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]"
      }`}
      title={lang === "el" ? "Κάρτες, κουίζ και ερωτήσεις εξέτασης" : "Flashcards, quiz and exam questions"}
      aria-expanded={open}
    >
      <GraduationCap className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">{lang === "el" ? "Μελέτη" : "Study"}</span>
    </button>
  );
}

const KINDS: Array<{ kind: StudyKind; icon: React.ReactNode; el: string; en: string; hintEl: string; hintEn: string }> = [
  {
    kind: "flashcards",
    icon: <Layers className="w-4 h-4" />,
    el: "Κάρτες",
    en: "Flashcards",
    hintEl: "Όροι και ορισμοί για επανάληψη",
    hintEn: "Terms and definitions to review",
  },
  {
    kind: "quiz",
    icon: <ListChecks className="w-4 h-4" />,
    el: "Κουίζ",
    en: "Quiz",
    hintEl: "Πολλαπλής επιλογής, με εξήγηση",
    hintEn: "Multiple choice, with explanations",
  },
  {
    kind: "exam",
    icon: <PenLine className="w-4 h-4" />,
    el: "Θέματα εξέτασης",
    en: "Exam questions",
    hintEl: "Ανάπτυξης, με ενδεικτική λύση",
    hintEn: "Written answers, with a model answer",
  },
];

/** Sets already made in this tab (the server also caches them for a week, free of quota). */
const materialMemo = new Map<string, StudyMaterial>();

export function StudyPanel({
  lang,
  courseCode,
  path,
  onMeChanged,
  embedded = false,
}: {
  lang: Lang;
  courseCode: string;
  path: string;
  onMeChanged: (m: Me) => void;
  /** Inside the document window: no card of its own. */
  embedded?: boolean;
}) {
  const [kind, setKind] = useState<StudyKind | null>(null);
  const [material, setMaterial] = useState<StudyMaterial | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const el = lang === "el";

  const load = (k: StudyKind, refresh = false) => {
    const key = `${courseCode}|${path}|${k}|${lang}`;
    setKind(k);
    setError(null);
    const memo = materialMemo.get(key);
    if (memo && !refresh) {
      setMaterial(memo);
      return;
    }
    setMaterial(null);
    setLoading(true);
    api
      .studyMaterial(courseCode, path, k, refresh)
      .then((r) => {
        materialMemo.set(key, r.material);
        setMaterial(r.material);
        onMeChanged(r.me);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <div className={embedded ? "space-y-4" : "enter mx-4 mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-4 py-3 space-y-3"}>
      <div role="tablist" aria-label={el ? "Είδος υλικού" : "Material type"} className="grid grid-cols-3 gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            role="tab"
            aria-selected={kind === k.kind}
            disabled={loading}
            onClick={() => kind !== k.kind && load(k.kind)}
            className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg text-left cursor-pointer disabled:cursor-default ${
              kind === k.kind
                ? "bg-[var(--accent)] text-[var(--on-accent)]"
                : "bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)]"
            }`}
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
              {k.icon}
              {el ? k.el : k.en}
            </span>
            <span className={`hidden sm:block text-xs ${kind === k.kind ? "opacity-85" : "text-[var(--muted)]"}`}>
              {el ? k.hintEl : k.hintEn}
            </span>
          </button>
        ))}
      </div>

      {!kind && (
        <p className="text-xs text-[var(--muted)]">
          {el
            ? "Διάλεξε τι θέλεις να φτιαχτεί από αυτό το αρχείο."
            : "Pick what to make from this file."}
        </p>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-[var(--muted)] py-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          {el ? "Διαβάζω το αρχείο και φτιάχνω το σετ…" : "Reading the file and making the set…"}
        </div>
      )}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {material && !loading && (
        <div key={`${material.kind}-${material.name}`} className="enter space-y-3">
          {material.kind === "flashcards" && <Flashcards lang={lang} cards={material.cards} />}
          {material.kind === "quiz" && <Quiz lang={lang} questions={material.questions} />}
          {material.kind === "exam" && <ExamSet lang={lang} questions={material.questions} />}
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[0.6875rem] text-[var(--muted)]">
              {el
                ? "Δημιουργήθηκε από AI — έλεγξέ το με τη διάλεξη."
                : "AI-generated — check it against the lecture."}
            </p>
            <button
              onClick={() => load(material.kind, true)}
              className="shrink-0 text-xs text-[var(--muted)] hover:text-[var(--accent)] inline-flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              {el ? "Νέο σετ" : "New set"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Plain text with **bold** and line breaks, never HTML. */
function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {text.split("\n").map((line, i) => (
        <p key={i} className={line.trim() ? undefined : "h-2"}>
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong key={j}>{part.slice(2, -2)}</strong>
            ) : (
              <React.Fragment key={j}>{part}</React.Fragment>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/* ----------------------------- Flashcards ----------------------------- */

function Flashcards({ lang, cards: initial }: { lang: Lang; cards: Flashcard[] }) {
  const [cards, setCards] = useState(initial);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const el = lang === "el";
  const card = cards[index];

  const go = (delta: number) => {
    setFlipped(false);
    setIndex((i) => (i + delta + cards.length) % cards.length);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length]);

  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        data-flipped={flipped}
        aria-label={flipped ? (el ? "Δείξε την ερώτηση" : "Show the question") : el ? "Δείξε την απάντηση" : "Show the answer"}
        className="flashcard block w-full text-left cursor-pointer"
      >
        <div className="flashcard-inner">
          <div
            aria-hidden={flipped}
            className="flashcard-face min-h-36 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col justify-between gap-3"
          >
            <span className="text-xs text-[var(--muted)]">{el ? "Ερώτηση" : "Question"}</span>
            <RichText text={card.front} className="text-base font-semibold leading-snug" />
            <span className="text-xs text-[var(--muted)]">{el ? "Πάτα για την απάντηση" : "Tap for the answer"}</span>
          </div>
          <div
            aria-hidden={!flipped}
            className="flashcard-face flashcard-back min-h-36 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-4 flex flex-col justify-between gap-3"
          >
            <span className="text-xs text-[var(--accent-text)]">{el ? "Απάντηση" : "Answer"}</span>
            <RichText text={card.back} className="text-sm leading-relaxed" />
            <span className="text-xs text-[var(--muted)]">{el ? "Πάτα για την ερώτηση" : "Tap for the question"}</span>
          </div>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => {
            setCards((c) => [...c].sort(() => Math.random() - 0.5));
            setIndex(0);
            setFlipped(false);
          }}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
        >
          <Shuffle className="w-3.5 h-3.5" />
          {el ? "Ανακάτεμα" : "Shuffle"}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={() => go(-1)}
            aria-label={el ? "Προηγούμενη" : "Previous"}
            className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs tabular-nums text-[var(--muted)] min-w-12 text-center" aria-live="polite">
            {index + 1} / {cards.length}
          </span>
          <button
            onClick={() => go(1)}
            aria-label={el ? "Επόμενη" : "Next"}
            className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Quiz -------------------------------- */

function Quiz({ lang, questions }: { lang: Lang; questions: QuizQuestion[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const el = lang === "el";
  const answered = Object.keys(picked).length;
  const correct = questions.filter((q, i) => picked[i] === q.answer).length;
  const letters = "ΑΒΓΔΕ";

  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const choice = picked[i];
        const done = choice !== undefined;
        return (
          <fieldset key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 space-y-2">
            <legend className="sr-only">{`${el ? "Ερώτηση" : "Question"} ${i + 1}`}</legend>
            <div className="text-sm font-medium flex gap-2">
              <span className="text-[var(--muted)] tabular-nums">{i + 1}.</span>
              <RichText text={q.question} />
            </div>
            <div className="grid gap-1.5">
              {q.options.map((opt, j) => {
                const isAnswer = j === q.answer;
                const isChoice = j === choice;
                const state = !done ? "idle" : isAnswer ? "right" : isChoice ? "wrong" : "dim";
                return (
                  <button
                    key={j}
                    disabled={done}
                    onClick={() => setPicked((p) => ({ ...p, [i]: j }))}
                    aria-pressed={isChoice}
                    className={`flex items-start gap-2 text-left text-sm px-3 py-2 rounded-lg border cursor-pointer disabled:cursor-default ${
                      state === "right"
                        ? "border-[var(--ok)] bg-[var(--ok-soft)]"
                        : state === "wrong"
                          ? "border-[var(--danger)] bg-[var(--danger-soft)]"
                          : state === "dim"
                            ? "border-[var(--border)] text-[var(--muted)]"
                            : "border-[var(--border)] hover:border-[var(--accent)]"
                    }`}
                  >
                    <span className="font-semibold text-[var(--muted)] w-4 shrink-0">
                      {lang === "el" ? letters[j] : String.fromCharCode(65 + j)}
                    </span>
                    <span className="flex-1">{opt}</span>
                    {state === "right" && <CheckCircle2 className="w-4 h-4 text-[var(--ok)] shrink-0 mt-0.5" />}
                    {state === "wrong" && <XCircle className="w-4 h-4 text-[var(--danger)] shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </div>
            {done && q.explanation && (
              <p className="enter text-xs text-[var(--muted)] leading-relaxed">{q.explanation}</p>
            )}
          </fieldset>
        );
      })}
      <div className="flex items-center justify-between gap-2" aria-live="polite">
        <span className="text-sm">
          {answered === questions.length
            ? el
              ? `Σκορ: ${correct} / ${questions.length}`
              : `Score: ${correct} / ${questions.length}`
            : el
              ? `Απαντήθηκαν ${answered} από ${questions.length}`
              : `${answered} of ${questions.length} answered`}
        </span>
        {answered > 0 && (
          <button
            onClick={() => setPicked({})}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {el ? "Ξανά" : "Retry"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- Exam questions --------------------------- */

function ExamSet({ lang, questions }: { lang: Lang; questions: ExamQuestion[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const el = lang === "el";
  return (
    <div className="space-y-3">
      {questions.map((q, i) => (
        <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-medium flex gap-2">
              <span className="text-[var(--muted)] tabular-nums">{i + 1}.</span>
              <RichText text={q.question} className="space-y-1" />
            </div>
            {q.points > 0 && (
              <span className="shrink-0 text-xs text-[var(--muted)] tabular-nums">
                {q.points} {el ? "μον." : "pts"}
              </span>
            )}
          </div>
          <button
            onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
            aria-expanded={!!open[i]}
            className="text-xs font-medium text-[var(--accent)] hover:underline cursor-pointer"
          >
            {open[i] ? (el ? "Απόκρυψη λύσης" : "Hide answer") : el ? "Ενδεικτική λύση" : "Model answer"}
          </button>
          <div className="accordion" data-open={!!open[i]} aria-hidden={!open[i]}>
            <RichText
              text={q.modelAnswer}
              className="text-sm leading-relaxed space-y-1 border-l-2 border-[var(--accent)]/40 pl-3"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
