import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * AES-256-GCM authenticated encryption for secrets at rest
 * (eClass passwords, Gemini API keys, Google refresh tokens).
 * Output format: base64(iv).base64(tag).base64(ciphertext)
 */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", env.encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [ivB, tagB, ctB] = payload.split(".");
  if (!ivB || !tagB || !ctB) throw new Error("Malformed encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", env.encryptionKey, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
