import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { Lang, MyStats } from "@myclass/shared";
import { api } from "./api";

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const locale = (lang: Lang) => (lang === "el" ? "el-GR" : "en-GB");

function formatDuration(seconds: number, lang: Lang): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (lang === "el") return h > 0 ? `${h} ώρ.${m ? ` ${m} λ.` : ""}` : `${m} λ.`;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function formatInt(n: number, lang: Lang): string {
  return n.toLocaleString(locale(lang));
}

function monthLabel(ym: string, lang: Lang, style: "short" | "long" = "short"): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale(lang), style === "short" ? { month: "short" } : { month: "long", year: "numeric" });
}

function dayLabel(ymd: string, lang: Lang): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(lang), { day: "numeric", month: "short" });
}

const L = {
  el: {
    title: "Στατιστικά",
    source: "Από τα προσωπικά στατιστικά του eClass",
    time30: "Χρόνος, τελευταίες 30 μέρες",
    visits30: "Επισκέψεις, τελευταίες 30 μέρες",
    activeDays: "Ενεργές μέρες",
    coursesActive: "Μαθήματα με δραστηριότητα",
    vsPrev: "από τις προηγούμενες 30",
    same: "Ίδιο με τις προηγούμενες 30",
    inYear: "στους 12 μήνες",
    monthly: "Χρόνος μελέτης ανά μήνα",
    byCourse: "Πού πήγε ο χρόνος",
    weekdays: "Επισκέψεις ανά ημέρα",
    tools: "Εργαλεία eClass",
    visitsUnit: "επισκέψεις",
    last: "τελευταία",
    other: "Υπόλοιπα",
    showAll: (n: number) => `Όλα τα μαθήματα (${n})`,
    showLess: "Λιγότερα",
    empty: "Δεν υπάρχει δραστηριότητα στο eClass τους τελευταίους 12 μήνες.",
    failed: "Δεν φορτώθηκαν τα στατιστικά.",
    retry: "Ξανά",
    partial: "Χωρίς δεδομένα από",
    adjusted: (visits: string, time?: string) =>
      `Χωρίς τους αυτόματους ελέγχους του myClass (${visits} επισκέψεις${time ? `, περίπου ${time}` : ""}).`,
    uncorrected: (date: string) => `Πριν από τις ${date} μετρούν μαζί και οι αυτόματοι έλεγχοι του myClass, γιατί δεν ξεχωρίζουν.`,
    days: ["Δε", "Τρ", "Τε", "Πε", "Πα", "Σα", "Κυ"],
  },
  en: {
    title: "My stats",
    source: "From your eClass personal statistics",
    time30: "Time, last 30 days",
    visits30: "Visits, last 30 days",
    activeDays: "Active days",
    coursesActive: "Courses with activity",
    vsPrev: "vs the previous 30",
    same: "Same as the previous 30",
    inYear: "in 12 months",
    monthly: "Study time by month",
    byCourse: "Where the time went",
    weekdays: "Visits by weekday",
    tools: "eClass tools",
    visitsUnit: "visits",
    last: "last",
    other: "Other",
    showAll: (n: number) => `All courses (${n})`,
    showLess: "Fewer",
    empty: "No eClass activity in the last 12 months.",
    failed: "Could not load your stats.",
    retry: "Retry",
    partial: "No data from",
    adjusted: (visits: string, time?: string) =>
      `Excludes myClass's automatic checks (${visits} visits${time ? `, about ${time}` : ""}).`,
    uncorrected: (date: string) => `Before ${date}, myClass's automatic checks are included, as they cannot be told apart.`,
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function StatsView({ lang }: { lang: Lang }) {
  const s = L[lang];
  const [stats, setStats] = useState<MyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setStats((await api.stats(fresh)).stats);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const period = stats ? `${monthLabel(stats.months[0].month, lang, "long")} – ${monthLabel(stats.months[11].month, lang, "long")}` : "";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="font-display text-2xl leading-tight">{s.title}</h1>
          <p className="text-xs text-[var(--muted)] mt-1">{period ? `${period} · ${s.source}` : s.source}</p>
        </div>
      </header>

      {loading && !stats && <StatsSkeleton />}

      {error && !stats && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">{s.failed}</div>
            <div className="text-xs text-[var(--muted)] mt-1">{error}</div>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg text-xs font-medium border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            {s.retry}
          </button>
        </div>
      )}

      {stats && stats.totals.visits === 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--muted)]">{s.empty}</div>
      )}

      {stats && stats.totals.visits > 0 && <StatsBody stats={stats} lang={lang} />}

      {stats?.adjustment ? <AdjustmentNote adjustment={stats.adjustment} lang={lang} /> : null}

      {stats?.warnings?.length ? (
        <p className="text-xs text-[var(--muted)]">
          {s.partial} {stats.warnings.map((w) => w.portal).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** One quiet line: what was taken out of eClass' log, and which days could not be separated. */
function AdjustmentNote({ adjustment, lang }: { adjustment: NonNullable<MyStats["adjustment"]>; lang: Lang }) {
  const s = L[lang];
  const parts: string[] = [];
  if (adjustment.visits > 0) {
    const time = adjustment.seconds >= 60 ? formatDuration(adjustment.seconds, lang) : undefined;
    parts.push(s.adjusted(formatInt(adjustment.visits, lang), time));
  }
  if (adjustment.uncorrectedBefore) {
    const [y, m, d] = adjustment.uncorrectedBefore.split("-").map(Number);
    const date = new Date(y, m - 1, d).toLocaleDateString(locale(lang), { day: "numeric", month: "long", year: "numeric" });
    parts.push(s.uncorrected(date));
  }
  return parts.length ? <p className="text-xs text-[var(--muted)] leading-relaxed">{parts.join(" ")}</p> : null;
}

function StatsSkeleton() {
  const block = "rounded-2xl border border-[var(--border)] bg-[var(--surface)]";
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${block} h-[104px]`} />
        ))}
      </div>
      <div className={`${block} h-[320px]`} />
    </div>
  );
}

function StatsBody({ stats, lang }: { stats: MyStats; lang: Lang }) {
  const s = L[lang];
  const { recent, totals } = stats;

  const timeDelta = recent.seconds - recent.prevSeconds;
  const visitDelta = recent.visits - recent.prevVisits;
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          index={0}
          label={s.time30}
          value={formatDuration(recent.seconds, lang)}
          note={timeDelta === 0 ? s.same : `${sign(timeDelta)}${formatDuration(Math.abs(timeDelta), lang)} ${s.vsPrev}`}
        />
        <StatCard
          index={1}
          label={s.visits30}
          value={formatInt(recent.visits, lang)}
          note={visitDelta === 0 ? s.same : `${sign(visitDelta)}${formatInt(Math.abs(visitDelta), lang)} ${s.vsPrev}`}
        />
        <StatCard index={2} label={s.activeDays} value={formatInt(totals.activeDays, lang)} note={s.inYear} />
        <StatCard index={3} label={s.coursesActive} value={formatInt(totals.courses, lang)} note={s.inYear} />
      </div>

      <section className="enter rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 md:p-6" style={stagger(4)}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h2 className="font-display text-base">{s.monthly}</h2>
          <span className="text-xs text-[var(--muted)] tabular-nums">{formatDuration(totals.seconds, lang)} {s.inYear}</span>
        </div>
        <MonthlyChart months={stats.months} lang={lang} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <section className="enter lg:col-span-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 md:p-6" style={stagger(5)}>
          <h2 className="font-display text-base mb-4">{s.byCourse}</h2>
          <CourseShare stats={stats} lang={lang} />
        </section>
        <div className="lg:col-span-2 space-y-4">
          <section className="enter rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" style={stagger(6)}>
            <h2 className="font-display text-base mb-4">{s.weekdays}</h2>
            <WeekdayBars weekdays={stats.weekdays} lang={lang} />
          </section>
          <section className="enter rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" style={stagger(7)}>
            <h2 className="font-display text-base mb-3">{s.tools}</h2>
            <ToolList tools={stats.tools} lang={lang} />
          </section>
        </div>
      </div>
    </div>
  );
}

/** One short entrance for the page, staggered by 40 ms per block. */
const stagger = (i: number): React.CSSProperties => ({ animationDelay: `${i * 40}ms` });

function StatCard({ index, label, value, note }: { index: number; label: string; value: string; note: string }) {
  return (
    <div className="enter rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4 md:px-5" style={stagger(index)}>
      <div className="text-xs text-[var(--muted)] leading-snug">{label}</div>
      <div className="font-display text-[28px] leading-none mt-3 tabular-nums">{value}</div>
      <div className="text-xs text-[var(--muted)] mt-2 leading-snug">{note}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main chart: study time per month                                    */
/* ------------------------------------------------------------------ */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Monotone cubic path through the points, so the line never dips below zero between months. */
function monotonePath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    t.push(slope[i - 1] * slope[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]));
  }
  t.push(slope[n - 2]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

function niceStep(max: number): number {
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function MonthlyChart({ months, lang }: { months: MyStats["months"]; lang: Lang }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 240;
  const pad = { top: 16, right: 12, bottom: 28, left: 44 };
  const hours = months.map((m) => m.seconds / 3600);
  const step = niceStep(Math.max(1, ...hours));
  const top = Math.max(step, Math.ceil(Math.max(...hours) / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (innerW * i) / (months.length - 1);
  const y = (h: number) => pad.top + innerH - (innerH * h) / top;
  const pts = hours.map((h, i) => [x(i), y(h)] as [number, number]);
  const line = monotonePath(pts);
  const area = line ? `${line} L${x(months.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : "";
  const nowIdx = months.length - 1;
  const showLabelEvery = innerW < 420 ? 2 : 1;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / Math.max(1, box.width);
    setHover(Math.max(0, Math.min(months.length - 1, Math.round(rel * (months.length - 1)))));
  };

  const active = hover ?? null;
  const hoverMonth = active !== null ? months[active] : null;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={L[lang].monthly}>
          <defs>
            <linearGradient id="monthly-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tv)} y2={y(tv)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={pad.left - 10} y={y(tv)} dy="0.32em" textAnchor="end" className="chart-label">
                {lang === "el" ? `${tv} ώ` : `${tv}h`}
              </text>
            </g>
          ))}

          {months.map((m, i) =>
            i % showLabelEvery === (months.length - 1) % showLabelEvery ? (
              <text
                key={m.month}
                x={x(i)}
                y={height - 8}
                textAnchor="middle"
                className={i === nowIdx ? "chart-label chart-label-now" : "chart-label"}
              >
                {monthLabel(m.month, lang)}
              </text>
            ) : null,
          )}

          <path d={area} fill="url(#monthly-area)" />
          <path d={line} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {active !== null && (
            <line x1={x(active)} x2={x(active)} y1={pad.top} y2={y(0)} stroke="var(--chart-grid-strong)" strokeWidth={1} />
          )}
          {active !== null && active !== nowIdx && (
            <circle cx={x(active)} cy={y(hours[active])} r={4.5} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />
          )}

          {/* The current month carries the accent: the only "now" on the chart */}
          <circle cx={x(nowIdx)} cy={y(hours[nowIdx])} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />

          <rect
            x={pad.left}
            y={pad.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}

      {hoverMonth && active !== null && (
        <div
          className="chart-tooltip"
          style={{
            // Beside the point, never on it: above when there is room, otherwise below
            transform: `translate(${Math.min(Math.max(x(active) - 80, 0), Math.max(0, width - 160))}px, ${
              y(hours[active]) - 92 >= 0 ? y(hours[active]) - 92 : y(hours[active]) + 16
            }px)`,
          }}
        >
          <div className="text-xs text-[var(--muted)]">{monthLabel(hoverMonth.month, lang, "long")}</div>
          <div className="text-sm font-medium tabular-nums mt-0.5">{formatDuration(hoverMonth.seconds, lang)}</div>
          <div className="text-xs text-[var(--muted)] tabular-nums">
            {formatInt(hoverMonth.visits, lang)} {L[lang].visitsUnit}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Course share: one stacked bar + the ranked list that labels it      */
/* ------------------------------------------------------------------ */

const SERIES = 5;
const COLLAPSED_ROWS = 6;

function CourseShare({ stats, lang }: { stats: MyStats; lang: Lang }) {
  const s = L[lang];
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const total = Math.max(1, stats.courses.reduce((n, c) => n + c.seconds, 0));
  const lead = stats.courses.slice(0, SERIES).filter((c) => c.seconds > 0);
  const otherSeconds = total - lead.reduce((n, c) => n + c.seconds, 0);
  const segments = [
    ...lead.map((c, i) => ({ key: c.title, title: c.title, seconds: c.seconds, color: `var(--series-${i + 1})` })),
    ...(otherSeconds > 0 ? [{ key: "__other", title: s.other, seconds: otherSeconds, color: "var(--series-other)" }] : []),
  ];
  const pct = (sec: number) => Math.round((sec / total) * 100);

  const rows = stats.courses;
  const head = rows.slice(0, COLLAPSED_ROWS);
  const rest = rows.slice(COLLAPSED_ROWS);

  const row = (c: MyStats["courses"][number], i: number) => (
    <li
      key={c.title}
      className={`grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 border-t border-[var(--border)] first:border-t-0 ${
        hover !== null && hover !== i && i < SERIES ? "opacity-60" : ""
      } transition-opacity`}
      onPointerEnter={() => i < SERIES && setHover(i)}
      onPointerLeave={() => setHover(null)}
    >
      <span
        className="w-2.5 h-2.5 rounded-[3px]"
        style={{ background: i < SERIES ? `var(--series-${i + 1})` : "var(--series-other)" }}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-sm truncate" title={c.title}>
          {c.title}
        </div>
        <div className="text-xs text-[var(--muted)] tabular-nums">
          {formatInt(c.visits, lang)} {s.visitsUnit} · {s.last} {dayLabel(c.lastDay, lang)}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-medium tabular-nums">{formatDuration(c.seconds, lang)}</div>
        <div className="text-xs text-[var(--muted)] tabular-nums">{pct(c.seconds)}%</div>
      </div>
    </li>
  );

  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] rounded-[4px] overflow-hidden" role="img" aria-label={s.byCourse}>
        {segments.map((seg, i) => (
          <div
            key={seg.key}
            className="h-full transition-opacity first:rounded-l-[4px] last:rounded-r-[4px]"
            style={{
              flexGrow: seg.seconds,
              flexBasis: 0,
              minWidth: 4,
              background: seg.color,
              opacity: hover !== null && hover !== i ? 0.35 : 1,
            }}
            title={`${seg.title} · ${pct(seg.seconds)}%`}
            onPointerEnter={() => setHover(i < lead.length ? i : null)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </div>

      <ul className="mt-4">{head.map(row)}</ul>

      {rest.length > 0 && (
        <>
          <div className="accordion" data-open={expanded} aria-hidden={!expanded}>
            <ul className="border-t border-[var(--border)]">{rest.map((c, i) => row(c, i + COLLAPSED_ROWS))}</ul>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-2 inline-flex items-center gap-1.5 h-8 px-2 -ml-2 rounded-lg text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
            {expanded ? s.showLess : s.showAll(rows.length)}
          </button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small panels                                                        */
/* ------------------------------------------------------------------ */

function WeekdayBars({ weekdays, lang }: { weekdays: number[]; lang: Lang }) {
  const max = Math.max(1, ...weekdays);
  const today = (new Date().getDay() + 6) % 7;
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="grid grid-cols-7 gap-2 items-end" style={{ height: 112 }}>
      {weekdays.map((v, i) => (
        <div
          key={i}
          className="relative flex flex-col items-center justify-end h-full gap-2"
          onPointerEnter={() => setHover(i)}
          onPointerLeave={() => setHover(null)}
        >
          {hover === i && (
            <span className="absolute -top-1 text-xs font-medium tabular-nums whitespace-nowrap">{formatInt(v, lang)}</span>
          )}
          <div
            className="w-full max-w-[22px] rounded-t-[4px]"
            style={{
              height: `${Math.max(2, (v / max) * 76)}px`,
              background: i === today ? "var(--accent)" : "var(--chart-bar)",
            }}
          />
          <span className={`text-xs ${i === today ? "text-[var(--text)] font-medium" : "text-[var(--muted)]"}`}>{L[lang].days[i]}</span>
        </div>
      ))}
    </div>
  );
}

function ToolList({ tools, lang }: { tools: MyStats["tools"]; lang: Lang }) {
  const top = tools.slice(0, 6);
  const max = Math.max(1, ...top.map((t) => t.visits));
  return (
    <ul className="space-y-3">
      {top.map((t) => (
        <li key={t.name}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{t.name}</span>
            <span className="text-xs text-[var(--muted)] tabular-nums shrink-0">{formatInt(t.visits, lang)}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-[var(--surface-2)] overflow-hidden">
            <div className="h-full rounded-full bg-[var(--chart-bar)]" style={{ width: `${(t.visits / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

