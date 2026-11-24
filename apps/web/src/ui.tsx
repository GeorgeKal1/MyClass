import React from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import type { Lang } from "@myclass/shared";

/* ================================================================== */
/* Loading placeholders and failed sections                            */
/* ================================================================== */

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={`skeleton block ${className}`} style={style} />;
}

/** A section whose data did not arrive: says so and offers to try again. */
export function SectionError({ lang, onRetry, detail }: { lang: Lang; onRetry: () => void; detail?: string }) {
  return (
    <div role="alert" className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center gap-3">
      <TriangleAlert className="w-4 h-4 text-[var(--warn)] shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{lang === "el" ? "Δεν φορτώθηκε" : "Didn't load"}</p>
        {detail && <p className="text-xs text-[var(--muted)] mt-0.5 line-clamp-2">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 min-h-10 px-3.5 rounded-xl text-sm font-medium border border-[var(--border-strong)] hover:bg-[var(--surface-2)] cursor-pointer"
      >
        <RefreshCw className="w-4 h-4" aria-hidden />
        {lang === "el" ? "Δοκιμή ξανά" : "Try again"}
      </button>
    </div>
  );
}

/* ================================================================== */
/* Course identity: one colour per course                              */
/* ================================================================== */

const COURSE_HUES = [258, 205, 160, 32, 330, 12, 186, 92];

/** The same course always gets the same colour (Home announcements, Courses list). */
export function courseHue(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return COURSE_HUES[h % COURSE_HUES.length];
}

export function courseColor(code: string): string {
  return `hsl(${courseHue(code)} var(--course-s) var(--course-l))`;
}
