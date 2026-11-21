import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Eye, FileText, GraduationCap, RefreshCw, ScrollText, X } from "lucide-react";
import type { DocNode, Lang, Me } from "@myclass/shared";
import { api } from "./api";
import { DocumentSummaryPanel } from "./features";
import { StudyPanel } from "./study";
import { motionReduced, releaseVelocity, rubberBand, springTo } from "./gestures";

/* ================================================================== */
/* A window over the page: one thing to look at, a close button top-right */
/* ================================================================== */

/** Sideways swipe between a window's tabs: `target` follows the finger. */
export interface TabSwipe {
  target: React.RefObject<HTMLElement | null>;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export function Modal({
  onClose,
  labelledBy,
  className = "",
  swipe,
  swipeDownToClose = false,
  children,
}: {
  onClose: () => void;
  labelledBy: string;
  className?: string;
  swipe?: TabSwipe;
  /** Touch: pulling the window down (from the top of its content) closes it. */
  swipeDownToClose?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  useWindowGestures(panelRef, overlayRef, { swipe, swipeDownToClose, onClose });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The page behind stays put while the window is open
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      // Keep Tab inside the window
      if (e.key === "Tab" && panelRef.current) {
        const items = [
          ...panelRef.current.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), iframe, input, select, textarea, video, audio, [tabindex]:not([tabindex='-1'])",
          ),
        ].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [onClose]);

  // Rendered at the page root: an animated (transformed) parent would otherwise become the frame
  // that "fixed" is measured against, and the window would not cover the screen
  return createPortal(
    <div
      ref={overlayRef}
      className="overlay-in fixed inset-0 z-[70] flex items-stretch sm:items-center justify-center bg-black/55 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // React passes portal events up to the page: a swipe in here must not also switch the page behind
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`enter relative flex flex-col w-full bg-[var(--surface)] sm:rounded-2xl sm:border sm:border-[var(--border)] shadow-2xl overflow-hidden pt-[env(safe-area-inset-top)] sm:pt-0 ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Touch gestures of a window, the same feel as the app's page swipe: the content follows the finger,
 * a flick or a long enough drag commits, otherwise a spring brings it back with the release speed.
 * - sideways: previous / next tab (resists past the first and last);
 * - down, starting where the content is scrolled to the top: closes the window.
 * Native listeners, because a gesture that is ours must stop the browser from scrolling as well.
 */
function useWindowGestures(
  panelRef: React.RefObject<HTMLDivElement | null>,
  overlayRef: React.RefObject<HTMLDivElement | null>,
  opts: { swipe?: TabSwipe; swipeDownToClose: boolean; onClose: () => void },
) {
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    const panel = panelRef.current;
    const overlay = overlayRef.current;
    if (!panel || !overlay) return;

    type Start = { x: number; y: number; axis: "x" | "y" | "none" | null; sideways: boolean; down: boolean };
    let start: Start | null = null;
    let samples: Array<{ v: number; t: number }> = [];
    let stopSpring: () => void = () => {};

    const setY = (y: number) => {
      panel.style.transform = y ? `translateY(${y}px)` : "";
      const p = Math.min(1, Math.max(0, y) / Math.max(1, panel.offsetHeight));
      overlay.style.backgroundColor = y ? `rgb(0 0 0 / ${0.55 * (1 - p)})` : "";
    };
    const setX = (x: number) => {
      const el = latest.current.swipe?.target.current;
      if (el) el.style.transform = x ? `translateX(${x}px)` : "";
    };

    /** The nearest ancestor (inside the window) that scrolls along this axis, if any. */
    const scroller = (from: Element | null, axis: "x" | "y"): HTMLElement | null => {
      for (let el = from as HTMLElement | null; el && el !== panel; el = el.parentElement) {
        const s = getComputedStyle(el);
        const overflow = axis === "x" ? s.overflowX : s.overflowY;
        const room = axis === "x" ? el.scrollWidth > el.clientWidth + 4 : el.scrollHeight > el.clientHeight + 4;
        if ((overflow === "auto" || overflow === "scroll") && room) return el;
      }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      const target = e.target as Element;
      if (target.closest("input, textarea, select, video, audio, [data-no-swipe='true']")) {
        start = null;
        return;
      }
      stopSpring();
      // The entrance animation holds its last transform, which would win over the drag
      panel.getAnimations().forEach((a) => a.cancel());
      const t = e.touches[0];
      const vScroll = scroller(target, "y");
      start = {
        x: t.clientX,
        y: t.clientY,
        axis: null,
        // A strip that scrolls sideways (the tabs at large text sizes) keeps its own scrolling
        sideways: Boolean(latest.current.swipe) && !scroller(target, "x"),
        // Pull-down closes only from the top of the content, otherwise it is a normal scroll up
        down: latest.current.swipeDownToClose && (!vScroll || vScroll.scrollTop <= 0),
      };
      samples = [];
    };

    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (start.axis === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.2) start.axis = start.sideways ? "x" : "none";
        else start.axis = start.down && dy > 0 ? "y" : "none";
      }
      if (start.axis === "none") return;
      e.preventDefault();
      const now = performance.now();
      const v = start.axis === "x" ? t.clientX : t.clientY;
      samples = [...samples.filter((p) => now - p.t < 100), { v, t: now }];
      if (start.axis === "y") {
        // Pulling back up past where it started resists
        setY(dy >= 0 ? dy : rubberBand(dy, panel.offsetHeight) * 0.3);
      } else {
        const s = latest.current.swipe!;
        const atEdge = dx > 0 ? !s.canPrev : !s.canNext;
        setX(atEdge ? rubberBand(dx, panel.offsetWidth) : dx * 0.85);
      }
    };

    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s || (s.axis !== "x" && s.axis !== "y")) return;
      const t = e.changedTouches[0];
      const velocity = releaseVelocity(samples);
      if (s.axis === "y") {
        const dy = t.clientY - s.y;
        const height = panel.offsetHeight;
        const current = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
        const close = dy > height * 0.25 || (velocity > 600 && dy > 30);
        if (close) {
          // Off the bottom edge and done: a fast flick must not carry it further (or back)
          let closed = false;
          const finish = () => {
            if (closed) return;
            closed = true;
            latest.current.onClose();
          };
          // Aimed past the edge so it leaves at speed instead of creeping the last pixels
          stopSpring = springTo(
            current,
            height * 1.3,
            Math.max(velocity, 900),
            (y) => {
              if (y >= height - 1) {
                setY(height);
                finish();
                return false;
              }
              setY(y);
            },
            finish,
          );
        } else {
          stopSpring = springTo(current, 0, velocity, setY);
        }
        return;
      }
      const sw = latest.current.swipe!;
      const dx = t.clientX - s.x;
      const el = sw.target.current;
      const current = el ? new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 : 0;
      const can = dx > 0 ? sw.canPrev : sw.canNext;
      const far = Math.abs(dx) > panel.offsetWidth * 0.22;
      const flick = Math.abs(velocity) > 450 && Math.abs(dx) > 30 && Math.sign(velocity) === Math.sign(dx);
      if (can && (far || flick)) {
        setX(0);
        if (dx > 0) sw.onPrev();
        else sw.onNext();
        return;
      }
      stopSpring = springTo(current, 0, velocity, setX);
    };

    const onCancel = () => {
      start = null;
      setX(0);
      setY(0);
    };

    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onCancel);
    return () => {
      stopSpring();
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onCancel);
    };
  }, [panelRef, overlayRef]);
}

export function CloseButton({ lang, onClick }: { lang: Lang; onClick: () => void }) {
  return (
    <button
      type="button"
      data-autofocus
      onClick={onClick}
      aria-label={lang === "el" ? "Κλείσιμο" : "Close"}
      title={lang === "el" ? "Κλείσιμο (Esc)" : "Close (Esc)"}
      className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] cursor-pointer"
    >
      <X className="w-5 h-5" />
    </button>
  );
}

/* ================================================================== */
/* Course file: preview, AI summary and study material in one window   */
/* ================================================================== */

export type DocTab = "preview" | "summary" | "study";

type PreviewKind = "pdf" | "image" | "video" | "audio" | "text" | "none";

const extOf = (name: string) => (name.split(".").pop() || "").toLowerCase();

function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  if (ext === "pdf") return "pdf";
  if (/^(png|jpe?g|gif|webp)$/.test(ext)) return "image";
  if (/^(mp4|webm)$/.test(ext)) return "video";
  if (/^(mp3|wav|ogg|m4a)$/.test(ext)) return "audio";
  if (
    /^(docx|pptx|xlsx|txt|md|csv|tsv|json|xml|c|h|cpp|hpp|cc|java|py|js|ts|sql|sh|r|m|tex|yml|yaml|ini|log|php|cs|go|rs|kt|swift|rb|html?)$/.test(
      ext,
    )
  ) {
    return "text";
  }
  return "none";
}

/** What AI summary / study can read (same list as the server's document reader). */
export function aiReadable(name: string): boolean {
  const kind = previewKind(name);
  return kind === "pdf" || kind === "image" || kind === "text";
}

function formatSize(bytes: number | undefined, lang: Lang): string | null {
  if (bytes === undefined) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toLocaleString(lang === "el" ? "el-GR" : "en-GB", { maximumFractionDigits: 1 })} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function DocumentViewer({
  lang,
  courseCode,
  node,
  initialTab = "preview",
  onClose,
  onMeChanged,
}: {
  lang: Lang;
  courseCode: string;
  node: DocNode;
  initialTab?: DocTab;
  onClose: () => void;
  onMeChanged: (m: Me) => void;
}) {
  const el = lang === "el";
  const [tab, setTab] = useState<DocTab>(initialTab);
  // A tab stays mounted once opened, so going back to it keeps its state (and asks the AI nothing new)
  const [visited, setVisited] = useState<Set<DocTab>>(() => new Set([initialTab]));
  const contentRef = useRef<HTMLDivElement>(null);
  const open = (t: DocTab) => {
    if (t === tab) return;
    // The new tab slides in from the side it comes from, like the app's pages
    const forward = order.indexOf(t) > order.indexOf(tab);
    setTab(t);
    setVisited((prev) => (prev.has(t) ? prev : new Set(prev).add(t)));
    if (!motionReduced()) {
      contentRef.current?.animate(
        [
          { transform: `translateX(${forward ? 24 : -24}px)`, opacity: 0 },
          { transform: "translateX(0)", opacity: 1 },
        ],
        { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  };
  const meta = [formatSize(node.size, lang), node.date].filter(Boolean).join(" · ");
  const tabs: Array<[DocTab, string, React.ReactNode]> = [
    ["preview", el ? "Προεπισκόπηση" : "Preview", <Eye key="p" className="w-4 h-4" />],
    // Summary and study only for files the AI can read
    ...(aiReadable(node.name)
      ? ([
          ["summary", el ? "Σύνοψη AI" : "AI summary", <ScrollText key="s" className="w-4 h-4" />],
          ["study", el ? "Μελέτη" : "Study", <GraduationCap key="g" className="w-4 h-4" />],
        ] as Array<[DocTab, string, React.ReactNode]>)
      : []),
  ];
  const order = tabs.map(([key]) => key);
  const at = order.indexOf(tab);

  return (
    <Modal
      onClose={onClose}
      labelledBy="doc-viewer-title"
      className="h-full sm:h-[min(90vh,1000px)] sm:max-w-5xl"
      swipeDownToClose
      swipe={{
        target: contentRef,
        canPrev: at > 0,
        canNext: at < order.length - 1,
        onPrev: () => open(order[at - 1]),
        onNext: () => open(order[at + 1]),
      }}
    >
      {/* Phones: the grab handle says the window can be pulled down */}
      <div aria-hidden className="sm:hidden mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--border)]" />
      <header className="flex items-start gap-3 px-4 sm:px-5 pt-3 sm:pt-4 pb-3">
        <FileText className="hidden sm:block w-5 h-5 mt-0.5 text-[var(--muted)] shrink-0" />
        <div className="min-w-0 flex-1 pt-1.5 sm:pt-0">
          <h2 id="doc-viewer-title" className="text-base leading-snug break-words line-clamp-2">
            {node.name}
          </h2>
          {meta && <p className="text-xs text-[var(--muted)] mt-0.5">{meta}</p>}
        </div>
        {node.downloadUrl && (
          <a
            href={node.downloadUrl}
            aria-label={el ? "Λήψη" : "Download"}
            title={el ? "Λήψη" : "Download"}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-sm font-medium text-[var(--text)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{el ? "Λήψη" : "Download"}</span>
          </a>
        )}
        <CloseButton lang={lang} onClick={onClose} />
      </header>

      <div
        role="tablist"
        aria-label={el ? "Προβολή αρχείου" : "File view"}
        className="flex gap-1 px-3 sm:px-4 border-b border-[var(--border)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map(([key, label, icon]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => open(key)}
            className={`shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-3 py-2.5 -mb-px border-b-2 text-sm font-medium cursor-pointer [&>svg]:hidden sm:[&>svg]:block ${
              tab === key
                ? "border-[var(--accent)] text-[var(--text)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 relative overflow-hidden bg-[var(--bg)]">
        <div ref={contentRef} className="absolute inset-0">
        {visited.has("preview") && (
          <div hidden={tab !== "preview"} className="absolute inset-0">
            <FilePreview lang={lang} courseCode={courseCode} node={node} />
          </div>
        )}
        {visited.has("summary") && (
          <div hidden={tab !== "summary"} className="absolute inset-0 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-5 sm:px-8 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
              <DocumentSummaryPanel lang={lang} courseCode={courseCode} path={node.path} embedded />
            </div>
          </div>
        )}
        {visited.has("study") && (
          <div hidden={tab !== "study"} className="absolute inset-0 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-5 sm:px-8 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
              <StudyPanel lang={lang} courseCode={courseCode} path={node.path} onMeChanged={onMeChanged} embedded />
            </div>
          </div>
        )}
        </div>
      </div>
    </Modal>
  );
}

/** Text previews already fetched in this tab, so reopening a file asks eClass nothing. */
const textMemo = new Map<string, { text?: string; reason?: string }>();

function FilePreview({ lang, courseCode, node }: { lang: Lang; courseCode: string; node: DocNode }) {
  const el = lang === "el";
  const kind = previewKind(node.name);
  const fileUrl = node.downloadUrl ? `${node.downloadUrl}&inline=1` : null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind !== "none");
  // Phones without a built-in PDF viewer (Android Chrome) would only offer a download inside a frame
  const canShowPdf = typeof navigator === "undefined" || (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false;

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setError(null);
    if (kind === "text") {
      const key = `${courseCode}|${node.path}|${lang}`;
      const memo = textMemo.get(key);
      if (memo) {
        setText(memo.text ?? null);
        setError(memo.reason ?? null);
        setLoading(false);
        return;
      }
      setLoading(true);
      api
        .documentPreview(courseCode, node.path)
        .then((r) => {
          if (cancelled) return;
          if (r.kind === "text") {
            textMemo.set(key, { text: r.text });
            setText(r.text);
          } else {
            textMemo.set(key, { reason: r.reason });
            setError(r.reason);
          }
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    } else if (kind !== "none" && fileUrl && !(kind === "pdf" && !canShowPdf)) {
      setLoading(true);
      // Fetched first so a failure (eClass session ended, file gone) shows as a message, not a broken frame
      fetch(fileUrl, { credentials: "same-origin" })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error || (el ? "Το αρχείο δεν άνοιξε." : "The file did not open."));
          }
          return res.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          made = URL.createObjectURL(blob);
          setBlobUrl(made);
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode, node.path, kind]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
        <RefreshCw className="w-4 h-4 animate-spin" />
        {el ? "Άνοιγμα αρχείου…" : "Opening the file…"}
      </div>
    );
  }

  if (error || kind === "none" || (kind === "pdf" && !canShowPdf)) {
    const message =
      error ??
      (kind === "pdf"
        ? el
          ? "Αυτός ο browser δεν δείχνει PDF μέσα στην εφαρμογή."
          : "This browser can't show PDFs inside the app."
        : el
          ? `Τα αρχεία .${extOf(node.name) || "?"} δεν έχουν προεπισκόπηση.`
          : `.${extOf(node.name) || "?"} files have no preview.`);
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-4">
          <FileText className="w-8 h-8 mx-auto text-[var(--muted)]" />
          <p className="text-sm text-[var(--muted)]">{message}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {kind === "pdf" && fileUrl && !error && (
              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl text-sm font-medium border border-[var(--border)] hover:border-[var(--accent)]"
              >
                <ExternalLink className="w-4 h-4" />
                {el ? "Άνοιγμα" : "Open"}
              </a>
            )}
            {node.downloadUrl && (
              <a
                href={node.downloadUrl}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl text-sm font-medium bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)]"
              >
                <Download className="w-4 h-4" />
                {el ? "Λήψη" : "Download"}
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "text") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <PlainText text={text ?? ""} code={/^(c|h|cpp|hpp|cc|java|py|js|ts|sql|sh|r|m|php|cs|go|rs|kt|swift|rb|json|xml|ya?ml|ini|log|csv|tsv)$/.test(extOf(node.name))} />
        </div>
      </div>
    );
  }

  if (!blobUrl) return null;
  if (kind === "pdf") {
    return <iframe src={blobUrl} title={node.name} className="w-full h-full border-0 bg-[var(--surface)]" />;
  }
  if (kind === "image") {
    return (
      <div className="h-full overflow-auto flex items-center justify-center p-4">
        <img src={blobUrl} alt={node.name} className="max-w-full max-h-full object-contain rounded-lg" />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="h-full flex items-center justify-center p-4 bg-black">
        <video src={blobUrl} controls className="max-w-full max-h-full" />
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center p-6">
      <audio src={blobUrl} controls className="w-full max-w-md" />
    </div>
  );
}

/** Text pulled out of a document. Slides become small headings; code keeps its spacing. */
function PlainText({ text, code }: { text: string; code: boolean }) {
  if (!text.trim()) {
    return <p className="text-sm text-[var(--muted)]">—</p>;
  }
  if (code) {
    return <pre className="text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-words font-mono text-[var(--text)]">{text}</pre>;
  }
  const blocks = text.split(/\n(?=--- Slide \d+)/);
  return (
    <div className="space-y-6">
      {blocks.map((block, i) => {
        const m = block.match(/^--- Slide (\d+)[^\n]*---\n?([\s\S]*)$/);
        return (
          <section key={i} className="space-y-1.5">
            {m && <h3 className="text-xs font-semibold text-[var(--muted)] tabular-nums">#{m[1]}</h3>}
            <p className="text-[0.9375rem] leading-7 whitespace-pre-wrap break-words">{(m ? m[2] : block).trim()}</p>
          </section>
        );
      })}
    </div>
  );
}
