import { useEffect, useState } from "react";
import { EllipsisVertical, Share, SquarePlus, X } from "lucide-react";
import type { Lang } from "@myclass/shared";

/** Browsers offer "Install" through this event (Chrome, Edge, Android); kept so it can be used later. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredInstall: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as InstallPromptEvent;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    listeners.forEach((fn) => fn());
  });
}

export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** True while the browser can show its own install dialog; re-renders when that changes. */
export function useCanInstall(): boolean {
  const [can, setCan] = useState(() => Boolean(deferredInstall));
  useEffect(() => {
    const update = () => setCan(Boolean(deferredInstall));
    listeners.add(update);
    update();
    return () => void listeners.delete(update);
  }, []);
  return can;
}

/** Opens the browser's install dialog. Resolves true when the student accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferredInstall;
  if (!ev) return false;
  deferredInstall = null;
  listeners.forEach((fn) => fn());
  await ev.prompt();
  const choice = await ev.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  return choice.outcome === "accepted";
}

const SNOOZE_KEY = "myclass.installPrompt.snoozedUntil";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* private mode: it just shows again next visit */
  }
}

type Platform = "ios" | "android" | "other";

function platform(): Platform {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

/**
 * Card that asks the student to install myClass as an app. Shown on the sign-in screen and after
 * signing in, until the app is installed or the student taps "Not now" (then quiet for a week).
 * Where the browser has its own install dialog it opens that; on iPhone and other Android browsers
 * it says which menu to use.
 */
export function InstallAppPrompt({ lang, signedIn }: { lang: Lang; signedIn: boolean }) {
  const el = lang === "el";
  const canInstall = useCanInstall();
  const [hidden, setHidden] = useState(() => isInstalledApp() || snoozed());
  const os = platform();

  if (hidden) return null;
  // On a computer only offer it when the browser can install directly; phones always get the steps
  if (!canInstall && os === "other") return null;

  const dismiss = () => {
    snooze();
    setHidden(true);
  };

  const title = el ? "Κατέβασε το myClass στο κινητό σου" : "Get the myClass app";
  let body: React.ReactNode;
  if (canInstall) {
    body = el
      ? "Ανοίγει από την αρχική οθόνη σαν εφαρμογή και σε ειδοποιεί για προθεσμίες και ανακοινώσεις."
      : "Open it from your home screen like an app, with alerts for deadlines and announcements.";
  } else if (os === "ios") {
    body = (
      <>
        {el ? "Πάτα " : "Tap "}
        <Share className="inline w-3.5 h-3.5 -mt-0.5" aria-label={el ? "Κοινοποίηση" : "Share"} />
        {el ? " και μετά " : " and then "}
        <span className="font-medium text-[var(--text)] whitespace-nowrap">
          <SquarePlus className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />
          {el ? "Προσθήκη στην οθόνη Αφετηρίας" : "Add to Home Screen"}
        </span>
        {el
          ? ". Στο iPhone οι ειδοποιήσεις για προθεσμίες δουλεύουν μόνο έτσι."
          : ". On iPhone, deadline alerts only work this way."}
      </>
    );
  } else {
    body = (
      <>
        {el ? "Από το μενού " : "Open the browser menu "}
        <EllipsisVertical className="inline w-3.5 h-3.5 -mt-0.5" aria-label={el ? "μενού" : "menu"} />
        {el ? " του browser διάλεξε " : " and choose "}
        <span className="font-medium text-[var(--text)]">
          {el ? "Εγκατάσταση εφαρμογής" : "Install app"}
        </span>
        {el ? " ή " : " or "}
        <span className="font-medium text-[var(--text)]">
          {el ? "Προσθήκη στην αρχική οθόνη" : "Add to Home screen"}
        </span>
        .
      </>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={title}
      className={`enter fixed z-40 inset-x-3 md:inset-x-auto md:left-6 md:bottom-6 md:w-[380px] ${
        signedIn ? "bottom-[calc(4.75rem+env(safe-area-inset-bottom))]" : "bottom-[max(0.75rem,env(safe-area-inset-bottom))]"
      } rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-lg shadow-black/15 p-4`}
    >
      <div className="flex items-start gap-3">
        <img src="/icon-192.png" alt="" className="w-10 h-10 rounded-xl shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug pr-6">{title}</div>
          <p className="text-xs text-[var(--muted)] mt-1 leading-relaxed">{body}</p>
          <div className="flex items-center gap-2 mt-3">
            {canInstall ? (
              <>
                <button
                  onClick={async () => {
                    if (await promptInstall()) setHidden(true);
                  }}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] cursor-pointer"
                >
                  {el ? "Εγκατάσταση" : "Install"}
                </button>
                <button
                  onClick={dismiss}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                >
                  {el ? "Όχι τώρα" : "Not now"}
                </button>
              </>
            ) : (
              <button
                onClick={dismiss}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
              >
                {el ? "Εντάξει" : "Got it"}
              </button>
            )}
          </div>
        </div>
      </div>
      <button
        aria-label={el ? "Κλείσιμο" : "Close"}
        onClick={dismiss}
        className="absolute top-3 right-3 p-1 rounded-md text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
