/**
 * myClass mark: a rounded "m" monogram with a small spark (the assistant).
 * Same geometry as public/icon.svg; colours follow the theme accent.
 */
export const LOGO_M_PATH = "M150 362V246a52 52 0 0 1 104 0v116M254 246a52 52 0 0 1 104 0v116";
export const LOGO_SPARK_PATH =
  "M394 112c5 24 14 33 38 38-24 5-33 14-38 38-5-24-14-33-38-38 24-5 33-14 38-38z";

export function Logo({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] shrink-0 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="96 80 352 352" width={size * 0.72} height={size * 0.72} fill="none">
        <path d={LOGO_M_PATH} stroke="currentColor" strokeWidth={56} strokeLinecap="round" strokeLinejoin="round" />
        <path d={LOGO_SPARK_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}
