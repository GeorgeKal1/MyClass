import type { AiQuota } from "@myclass/shared";
import { env } from "./env.js";
import { users, type UserRecord } from "./store.js";

/**
 * Hourly limit on AI requests that run on the shared server key. A student who added their own
 * Gemini key pays for it themselves and is never limited. Only requests the student starts count
 * (a chat message, a document summary, a study set); background work like announcement triage
 * does not, and cached answers are free.
 */

const WINDOW_MS = 60 * 60 * 1000;

export function usesOwnKey(user: UserRecord): boolean {
  return user.settings.ai.mode === "apiKey" && Boolean(user.ai.encApiKey);
}

function recent(user: UserRecord, now: number): number[] {
  return (user.aiUsage ?? []).filter((t) => now - t < WINDOW_MS).sort((a, b) => a - b);
}

export function quotaFor(user: UserRecord, now = Date.now()): AiQuota | null {
  const limit = env.gemini.hourlyLimit;
  if (!limit || usesOwnKey(user)) return null;
  const used = recent(user, now);
  return {
    limit,
    used: Math.min(used.length, limit),
    resetAt: used.length ? new Date(used[0] + WINDOW_MS).toISOString() : undefined,
  };
}

export class AiQuotaError extends Error {
  constructor(
    message: string,
    public resetAt: string,
  ) {
    super(message);
  }
}

export function quotaExceededText(lang: "el" | "en", limit: number, resetAt: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((new Date(resetAt).getTime() - now) / 60_000));
  return lang === "el"
    ? `Έφτασες το όριο των ${limit} αιτημάτων AI την ώρα με το κοινό κλειδί. Ξαναδοκίμασε σε ${minutes}′, ή πρόσθεσε το δικό σου δωρεάν κλειδί Gemini στις Ρυθμίσεις για χρήση χωρίς όριο.`
    : `You reached the limit of ${limit} AI requests per hour on the shared key. Try again in ${minutes} min, or add your own free Gemini key in Settings for unlimited use.`;
}

/**
 * Counts one request, or throws AiQuotaError when the hour's allowance is used up.
 * Returns the stamp to pass to refundAiQuota if the request then fails (null when not counted).
 */
export function consumeAiQuota(user: UserRecord, now = Date.now()): number | null {
  const limit = env.gemini.hourlyLimit;
  if (!limit || usesOwnKey(user)) return null;
  const used = recent(user, now);
  if (used.length >= limit) {
    const resetAt = new Date(used[0] + WINDOW_MS).toISOString();
    throw new AiQuotaError(quotaExceededText(user.settings.language, limit, resetAt, now), resetAt);
  }
  users.update(user.id, (u) => {
    u.aiUsage = [...used, now];
  });
  return now;
}

/** Gives a request back when it failed before Gemini produced anything useful. */
export function refundAiQuota(user: UserRecord, at: number | null): void {
  if (at === null) return;
  users.update(user.id, (u) => {
    const i = (u.aiUsage ?? []).lastIndexOf(at);
    if (i >= 0) u.aiUsage!.splice(i, 1);
  });
}
