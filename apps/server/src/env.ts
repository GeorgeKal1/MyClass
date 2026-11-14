import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Several Greek university departmental eClass instances (e.g. https://thales.cs.unipi.gr)
// serve leaf TLS certificates without the full intermediate CA chain, which causes Node's
// built-in undici fetch to fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE unless relaxed.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const DATA_DIR = path.resolve(process.cwd(), ".data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Load a secret from env, or generate & persist one under .data (dev only). */
function devSecret(envName: string, file: string, gen: () => string): string {
  const fromEnv = str(envName);
  if (fromEnv) return fromEnv;
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const value = gen();
  fs.writeFileSync(p, value, { mode: 0o600 });
  console.warn(`[env] ${envName} not set – generated a development value in .data/${file}`);
  return value;
}

export const env = {
  port: Number(str("PORT", "8787")),
  webOrigin: str("WEB_ORIGIN", "http://localhost:5173"),
  isProd: process.env.NODE_ENV === "production",
  encryptionKey: Buffer.from(
    devSecret("ENCRYPTION_KEY", "secret.key", () => crypto.randomBytes(32).toString("base64")),
    "base64",
  ),
  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    model: str("GEMINI_MODEL", "gemini-3.8-flash"),
  },
  google: {
    clientId: str("GOOGLE_CLIENT_ID"),
    clientSecret: str("GOOGLE_CLIENT_SECRET"),
    scopes: str(
      "GOOGLE_OAUTH_SCOPES",
      "https://www.googleapis.com/auth/generative-language.retriever https://www.googleapis.com/auth/cloud-platform",
    ),
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

export const publicUrl = `http://localhost:${env.port}`;
