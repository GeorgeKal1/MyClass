import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// TLS certificates are always verified. eClass servers with an incomplete certificate chain
// are handled by supplying the missing intermediate (see eclass/extra-ca.ts), never by
// turning verification off.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.warn(
    "[env] WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks for Gemini and Web Push requests. Remove it.",
  );
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Where users, sessions and (when not provided via env) generated secrets are stored.
 * With Supabase configured, users and sessions live in Postgres instead (see store.ts);
 * otherwise, on hosts with an ephemeral filesystem, point DATA_DIR at a persistent volume.
 */
export const DATA_DIR = path.resolve(process.cwd(), str("DATA_DIR", ".data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Load a secret from env, or generate & persist one under .data (dev only). */
function devSecret(envName: string, file: string, gen: () => string): string {
  const fromEnv = str(envName);
  if (fromEnv) return fromEnv;
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const value = gen();
  fs.writeFileSync(p, value, { mode: 0o600 });
  console.warn(`[env] ${envName} not set – generated a development value in ${p}`);
  return value;
}

const port = Number(str("PORT", "8787"));

/** Public base URL of this server (used for secure-cookie detection). */
export const publicUrl = str("PUBLIC_URL", `http://localhost:${port}`).replace(/\/+$/, "");

export const env = {
  port,
  // In production the server also serves the web app, so the web origin defaults to PUBLIC_URL.
  webOrigin: str("WEB_ORIGIN", isProd ? publicUrl : "http://localhost:5173").replace(/\/+$/, ""),
  isProd,
  /** Session cookies get the Secure flag in production or whenever the app is served over HTTPS. */
  secureCookies: isProd || publicUrl.startsWith("https://"),
  encryptionKey: Buffer.from(
    devSecret("ENCRYPTION_KEY", "secret.key", () => crypto.randomBytes(32).toString("base64")),
    "base64",
  ),
  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    model: str("GEMINI_MODEL"),
    /** AI requests per student per hour on the shared key (0 = no limit). Own keys are never limited. */
    hourlyLimit: ((n) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 15))(Number(str("AI_HOURLY_LIMIT", "15"))),
  },
  /** Server-side only. The service role key bypasses RLS and must never reach the web app or logs. */
  supabase: {
    url: str("SUPABASE_URL").replace(/\/+$/, ""),
    serviceRoleKey: str("SUPABASE_SERVICE_ROLE_KEY"),
  },
  vapid: {
    publicKey: str("VAPID_PUBLIC_KEY"),
    privateKey: str("VAPID_PRIVATE_KEY"),
    subject: str("VAPID_SUBJECT", "mailto:admin@example.com"),
  },
};

if (env.encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
}

/** Users and sessions are kept in Supabase (never during tests, which stay offline). */
export const supabaseConfigured = Boolean(env.supabase.url && env.supabase.serviceRoleKey) && !process.env.VITEST;

if (Boolean(env.supabase.url) !== Boolean(env.supabase.serviceRoleKey)) {
  console.warn("[env] WARNING: set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither. Using DATA_DIR/db.json.");
}
if (env.supabase.url && !env.supabase.url.startsWith("https://")) {
  throw new Error("SUPABASE_URL must be an https:// address");
}

if (isProd) {
  const problems: string[] = [];
  if (!process.env.PUBLIC_URL?.trim()) {
    problems.push("PUBLIC_URL is not set (secure cookies and links will assume localhost)");
  } else if (!publicUrl.startsWith("https://")) {
    problems.push("PUBLIC_URL is not https:// (session cookies are marked Secure, so browsers may drop them)");
  }
  if (!str("ENCRYPTION_KEY")) {
    problems.push(
      supabaseConfigured
        ? "ENCRYPTION_KEY is not set: a key was generated on this disk, so stored eClass passwords and sessions cannot be decrypted after the next redeploy"
        : "ENCRYPTION_KEY is not set (the key is stored next to the data it protects in DATA_DIR)",
    );
  }
  if (!str("VAPID_PUBLIC_KEY") || !str("VAPID_PRIVATE_KEY")) {
    problems.push(
      supabaseConfigured
        ? "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set: push keys are regenerated on every redeploy, so saved push subscriptions stop working"
        : "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set (push keys live only in DATA_DIR)",
    );
  }
  if (!str("GEMINI_API_KEY")) {
    problems.push(
      "GEMINI_API_KEY is not set: the assistant, summaries and study material only work for students who add their own key",
    );
  }
  if (!supabaseConfigured && !str("DATA_DIR")) {
    problems.push(
      `DATA_DIR is not set (using ${DATA_DIR}); on hosts with an ephemeral disk all users and sessions are lost on every redeploy. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to keep them in Supabase`,
    );
  }
  for (const p of problems) console.warn(`[env] WARNING: ${p}`);
}
