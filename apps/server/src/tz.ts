/**
 * The app reads and shows eClass times, which are Greek local time. Hosts like Render run in UTC,
 * so every `new Date(y, m, d, h, min)` built from an eClass date (and every server-side date text)
 * would be off by 2–3 hours. Pin the process to Athens time before anything else runs.
 * Imported first in index.ts; Node picks up a TZ change at runtime.
 */
process.env.TZ = "Europe/Athens";

export {};
