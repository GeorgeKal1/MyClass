import type { Lang } from "@myclass/shared";

/** Two-letter weekday names, Monday first ("Τ Τ / Π Π" single letters were ambiguous in Greek). */
export function weekdayShort(lang: Lang): string[] {
  return lang === "el" ? ["Δε", "Τρ", "Τε", "Πε", "Πα", "Σα", "Κυ"] : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
}
