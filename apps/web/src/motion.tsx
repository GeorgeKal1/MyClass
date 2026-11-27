import {
  Atom,
  BookOpen,
  Calculator,
  Code,
  FlaskConical,
  GraduationCap,
  Lightbulb,
  Pencil,
  Sigma,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/* Decorative motion. Everything here is aria-hidden or purely visual, and stops for
   <html class="reduce-motion"> (Settings > Accessibility, or the device setting). */

function reduced(): boolean {
  return document.documentElement.classList.contains("reduce-motion");
}

/* ------------------------------------------------------------------ */
/* Drifting course icons (sign-in screen, empty states)                */
/* ------------------------------------------------------------------ */

/** The same hues the courses use (ui.tsx), so the backdrop looks like the app's own colours. */
const HUES = [258, 205, 160, 32, 330, 12, 186, 92];
const ICONS: LucideIcon[] = [BookOpen, Sigma, Code, FlaskConical, Pencil, GraduationCap, Calculator, Atom, Lightbulb];

type Spot = { x: number; y: number; size: number; depth: number };

/** Hand-placed so nothing lands in the middle, where the form or the text sits. */
const FULL_SPOTS: Spot[] = [
  { x: 6, y: 12, size: 34, depth: 1 },
  { x: 22, y: 30, size: 22, depth: 0.5 },
  { x: 10, y: 58, size: 28, depth: 0.8 },
  { x: 4, y: 86, size: 24, depth: 0.6 },
  { x: 24, y: 76, size: 36, depth: 1 },
  { x: 82, y: 10, size: 26, depth: 0.7 },
  { x: 92, y: 32, size: 34, depth: 1 },
  { x: 76, y: 52, size: 22, depth: 0.5 },
  { x: 90, y: 70, size: 30, depth: 0.9 },
  { x: 74, y: 88, size: 26, depth: 0.6 },
  { x: 48, y: 6, size: 20, depth: 0.4 },
  { x: 54, y: 94, size: 22, depth: 0.5 },
];

const SMALL_SPOTS: Spot[] = [
  { x: 6, y: 30, size: 16, depth: 0.6 },
  { x: 16, y: 72, size: 13, depth: 0.4 },
  { x: 84, y: 26, size: 15, depth: 0.5 },
  { x: 93, y: 68, size: 17, depth: 0.7 },
];

/**
 * Faint course icons that drift slowly and lean a little toward the mouse (or the phone's tilt).
 * Put it inside a `relative overflow-hidden` box; it never takes clicks.
 */
export function FloatingIcons({ variant = "full" }: { variant?: "full" | "small" }) {
  const ref = useRef<HTMLDivElement>(null);
  const spots = variant === "full" ? FULL_SPOTS : SMALL_SPOTS;

  useEffect(() => {
    const el = ref.current;
    if (!el || variant !== "full" || reduced()) return;
    let frame = 0;
    const set = (x: number, y: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty("--px", x.toFixed(3));
        el.style.setProperty("--py", y.toFixed(3));
      });
    };
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      set(e.clientX / window.innerWidth - 0.5, e.clientY / window.innerHeight - 0.5);
    };
    // Phones: only where tilt arrives without a permission prompt (Android); iOS just drifts
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      set(Math.max(-1, Math.min(1, e.gamma / 30)) / 2, Math.max(-1, Math.min(1, (e.beta - 45) / 30)) / 2);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("deviceorientation", onTilt, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("deviceorientation", onTilt);
    };
  }, [variant]);

  return (
    <div ref={ref} aria-hidden className={`floating-icons floating-icons-${variant}`}>
      {spots.map((s, i) => {
        const Icon = ICONS[(i * 4) % ICONS.length];
        const hue = HUES[(i * 3) % HUES.length];
        return (
          <span
            key={i}
            className="floating-icon"
            style={
              {
                left: `${s.x}%`,
                top: `${s.y}%`,
                "--depth": s.depth,
                "--hue": hue,
              } as React.CSSProperties
            }
          >
            <span
              className="floating-icon-drift"
              style={{ animationDuration: `${14 + ((i * 7) % 11)}s`, animationDelay: `${-((i * 5) % 13)}s` }}
            >
              <Icon style={{ width: s.size, height: s.size }} strokeWidth={1.6} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation icons: a small one-off move when a tab is opened         */
/* ------------------------------------------------------------------ */

export type NavAnim = "home" | "courses" | "inbox" | "assistant" | "stats";

const NAV_KEYFRAMES: Record<NavAnim, { frames: Keyframe[]; origin: string; duration: number }> = {
  // The house hops
  home: {
    frames: [{ transform: "translateY(0)" }, { transform: "translateY(-4px)" }, { transform: "translateY(0)" }, { transform: "translateY(-1.5px)" }, { transform: "translateY(0)" }],
    origin: "50% 100%",
    duration: 460,
  },
  // The book opens a little
  courses: {
    frames: [{ transform: "perspective(60px) rotateY(0)" }, { transform: "perspective(60px) rotateY(-38deg)" }, { transform: "perspective(60px) rotateY(0)" }],
    origin: "50% 50%",
    duration: 420,
  },
  // The bell rings from its top
  inbox: {
    frames: [0, 16, -14, 10, -7, 3, 0].map((deg) => ({ transform: `rotate(${deg}deg)` })),
    origin: "50% 8%",
    duration: 560,
  },
  // The assistant tilts its head and pops
  assistant: {
    frames: [{ transform: "rotate(0) scale(1)" }, { transform: "rotate(-12deg) scale(1.12)" }, { transform: "rotate(6deg) scale(1.05)" }, { transform: "rotate(0) scale(1)" }],
    origin: "50% 60%",
    duration: 460,
  },
  // The bars grow from the baseline
  stats: {
    frames: [{ transform: "scaleY(1)" }, { transform: "scaleY(0.55)" }, { transform: "scaleY(1.12)" }, { transform: "scaleY(1)" }],
    origin: "50% 100%",
    duration: 440,
  },
};

/**
 * Wraps a nav icon. Plays its move when the tab becomes active, and the bell also rings when
 * `ping` goes up (a new item reached the Inbox).
 */
export function NavIcon({
  anim,
  active,
  ping,
  children,
}: {
  anim?: NavAnim;
  active: boolean;
  ping?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const sparkRef = useRef<HTMLSpanElement>(null);
  const wasActive = useRef(active);
  const lastPing = useRef(ping ?? 0);

  const play = () => {
    const el = ref.current;
    if (!el || !anim || reduced()) return;
    const k = NAV_KEYFRAMES[anim];
    el.style.transformOrigin = k.origin;
    el.animate(k.frames, { duration: k.duration, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" });
    if (anim === "assistant" && sparkRef.current) {
      sparkRef.current.animate(
        [
          { opacity: 0, transform: "translate(0, 0) scale(0.4) rotate(0deg)" },
          { opacity: 1, transform: "translate(3px, -3px) scale(1) rotate(45deg)", offset: 0.4 },
          { opacity: 0, transform: "translate(5px, -6px) scale(0.6) rotate(90deg)" },
        ],
        { duration: 620, easing: "ease-out" },
      );
    }
  };

  useEffect(() => {
    if (active && !wasActive.current) play();
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const next = ping ?? 0;
    if (next > lastPing.current) play();
    lastPing.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ping]);

  return (
    <span className="relative inline-flex">
      <span ref={ref} className="inline-flex will-change-transform">
        {children}
      </span>
      {anim === "assistant" && (
        <span ref={sparkRef} aria-hidden className="nav-spark">
          <svg viewBox="0 0 10 10" width="8" height="8">
            <path d="M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z" fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** A count badge that bumps when its number goes up. */
export function BumpBadge({ value, className }: { value: number; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    if (value > last.current && ref.current && !reduced()) {
      ref.current.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(0.92)" }, { transform: "scale(1)" }],
        { duration: 480, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" },
      );
    }
    last.current = value;
  }, [value]);
  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* A checkmark that draws itself                                       */
/* ------------------------------------------------------------------ */

export function DrawCheck({ className = "w-3.5 h-3.5", circle = true }: { className?: string; circle?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={`draw-check ${className}`} aria-hidden>
      {circle && <circle cx="12" cy="12" r="10" pathLength={1} className="draw-check-circle" />}
      <path d="M7.5 12.5 L10.5 15.5 L16.5 9" pathLength={1} className="draw-check-tick" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The assistant's face                                                */
/* ------------------------------------------------------------------ */

/**
 * What the assistant is doing, shared by every bot icon on the page (nav, quick-chat button,
 * chat window): it listens while you type, thinks while it works, and smiles when it answers.
 */
export type AiMood = "idle" | "listening" | "thinking" | "happy";

let aiMood: AiMood = "idle";
let happyTimer: ReturnType<typeof setTimeout> | undefined;
const moodListeners = new Set<() => void>();

export function setAiMood(next: AiMood) {
  clearTimeout(happyTimer);
  // A fresh answer: smile for a moment, then go back to resting
  if (next === "happy") happyTimer = setTimeout(() => setAiMood("idle"), 1800);
  if (next === aiMood) return;
  aiMood = next;
  moodListeners.forEach((f) => f());
}

function useAiMood(): AiMood {
  return useSyncExternalStore(
    (f) => {
      moodListeners.add(f);
      return () => moodListeners.delete(f);
    },
    () => aiMood,
  );
}

/** A drop-in for lucide's Bot icon (same 24-unit grid and stroke) with a face that reacts. */
export function AiBot({ className = "w-4 h-4", mood }: { className?: string; mood?: AiMood }) {
  const shared = useAiMood();
  const m = mood ?? shared;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ai-bot ai-${m} ${className}`}
      aria-hidden
    >
      <g className="ai-bot-body">
        <path d="M12 7.5V4.6" />
        <circle className="ai-bot-antenna" cx="12" cy="3" r="1.4" fill="currentColor" stroke="none" />
        <rect x="4" y="7.5" width="16" height="12" rx="3" />
        <path d="M2 12.5v2M22 12.5v2" />
        <g className="ai-bot-eyes">
          <g className="ai-bot-pupils">
            <rect className="ai-bot-eye" x="7.9" y="11.4" width="2.2" height="3.2" rx="1.1" fill="currentColor" stroke="none" />
            <rect className="ai-bot-eye" x="13.9" y="11.4" width="2.2" height="3.2" rx="1.1" fill="currentColor" stroke="none" />
          </g>
          <path className="ai-bot-smile-eyes" d="M7.8 13.4q1.2-1.6 2.4 0M13.8 13.4q1.2-1.6 2.4 0" strokeWidth={1.6} />
        </g>
        <path className="ai-bot-mouth" d="M10 16.6q2 1.3 4 0" strokeWidth={1.6} />
      </g>
    </svg>
  );
}
