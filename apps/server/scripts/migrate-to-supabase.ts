/**
 * Copies DATA_DIR/db.json (default apps/server/.data/db.json) into Supabase.
 *
 *   npm run migrate:supabase -w @myclass/server -- --dry-run   counts only, no network
 *   npm run migrate:supabase -w @myclass/server                upsert, then verify
 *   ... -- --overwrite                                          also replace users the server changed since
 *
 * Idempotent: rows are upserted by primary key, so running it twice gives the same result. After the
 * first run, users whose Supabase row was updated later (by the live server) are skipped unless
 * --overwrite is given, so a re-run never rolls back newer data.
 *
 * Prints counts and yes/no checks only: never credentials, tokens, keys or message contents.
 * Never modifies or deletes db.json.
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  countRows,
  describeError,
  supabaseClient,
  upsertSessions,
  upsertUsers,
  type RemoteSessionRow,
} from "../src/store-remote.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const overwrite = args.has("--overwrite");

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || ".data");
const dbFile = path.join(dataDir, "db.json");

interface LocalUser {
  id: string;
  encPassword?: string;
  encSession?: string;
  ai?: { encApiKey?: string };
  pushSubscriptions?: unknown[];
}
interface LocalSession {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

function fail(msg: string): never {
  console.error(`[migrate] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(dbFile)) fail(`no db.json in ${dataDir}`);
const raw = JSON.parse(fs.readFileSync(dbFile, "utf8")) as {
  users?: Record<string, LocalUser>;
  sessions?: Record<string, LocalSession>;
};
const localUsers = Object.values(raw.users ?? {});
const userIds = new Set(localUsers.map((u) => u.id));
const now = Date.now();
const allSessions = Object.entries(raw.sessions ?? {});
const liveSessions = allSessions.filter(([, s]) => s.expiresAt > now && userIds.has(s.userId));
const subscriptions = localUsers.reduce((n, u) => n + (u.pushSubscriptions?.length ?? 0), 0);

console.log(`[migrate] source: ${dbFile}`);
console.log(`[migrate] users:         ${localUsers.length}`);
console.log(
  `[migrate] sessions:      ${liveSessions.length} live (${allSessions.length - liveSessions.length} expired or orphaned, skipped)`,
);
console.log(`[migrate] subscriptions: ${subscriptions} (inside user rows)`);

/* ---- key checks: compare without printing any value ---- */

function readTrim(file: string): string | undefined {
  const p = path.join(dataDir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : undefined;
}

function decrypts(payload: string, key: Buffer): boolean {
  try {
    const [iv, tag, ct] = payload.split(".");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]);
    return true;
  } catch {
    return false;
  }
}

const fileKey = readTrim("secret.key");
const envKey = process.env.ENCRYPTION_KEY?.trim();
const ciphertexts = localUsers.flatMap((u) => [u.encPassword, u.encSession, u.ai?.encApiKey].filter(Boolean) as string[]);
if (fileKey) {
  const ok = ciphertexts.filter((c) => decrypts(c, Buffer.from(fileKey, "base64"))).length;
  console.log(`[migrate] encrypted fields that decrypt with secret.key: ${ok}/${ciphertexts.length}`);
}
console.log(
  `[migrate] ENCRYPTION_KEY in this shell: ${envKey ? (envKey === fileKey ? "set, same as secret.key" : "set, DIFFERENT from secret.key") : "not set"}`,
);
const vapidFile = readTrim("vapid.json");
if (vapidFile) {
  const v = JSON.parse(vapidFile) as { publicKey?: string; privateKey?: string };
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  console.log(
    `[migrate] VAPID keys in this shell: ${envPub || envPriv ? (envPub === v.publicKey && envPriv === v.privateKey ? "set, same as vapid.json" : "set, DIFFERENT from vapid.json") : "not set"}`,
  );
}

if (dryRun) {
  console.log("[migrate] dry run: nothing was sent to Supabase");
  process.exit(0);
}

/* ---- upload ---- */

const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) fail("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in apps/server/.env or the shell)");
if (!url.startsWith("https://")) fail("SUPABASE_URL must be an https:// address");

const client = supabaseClient(url, serviceKey);
const MARKER = "migrated_from_file";

try {
  const marker = await client.from("kv").select("value").eq("key", MARKER).maybeSingle();
  if (marker.error) throw marker.error;
  const migratedAt = (marker.data?.value as { at?: string } | undefined)?.at;

  // Users the live server has written since the previous migration are newer than db.json
  let skip = new Set<string>();
  if (migratedAt && !overwrite) {
    const newer = await client
      .from("users")
      .select("id")
      .in("id", [...userIds])
      .gt("updated_at", migratedAt);
    if (newer.error) throw newer.error;
    skip = new Set((newer.data ?? []).map((r) => r.id as string));
    if (skip.size) console.log(`[migrate] ${skip.size} users changed in Supabase since ${migratedAt}: kept (use --overwrite to replace)`);
  }

  const userRows = localUsers.filter((u) => !skip.has(u.id)).map((u) => ({ id: u.id, data: u }));
  const sessionRows: RemoteSessionRow[] = liveSessions.map(([sid, s]) => ({
    token_hash: crypto.createHash("sha256").update(sid).digest("hex"),
    user_id: s.userId,
    expires_at: new Date(s.expiresAt).toISOString(),
    data: { createdAt: s.createdAt },
  }));

  await upsertUsers(client, userRows);
  await upsertSessions(client, sessionRows);

  /* ---- verify ---- */
  const foundUsers = await client.from("users").select("id", { count: "exact", head: true }).in("id", [...userIds]);
  if (foundUsers.error) throw foundUsers.error;
  const hashes = sessionRows.map((r) => r.token_hash);
  let foundSessions = 0;
  for (let i = 0; i < hashes.length; i += 200) {
    const r = await client
      .from("sessions")
      .select("token_hash", { count: "exact", head: true })
      .in("token_hash", hashes.slice(i, i + 200));
    if (r.error) throw r.error;
    foundSessions += r.count ?? 0;
  }

  const totalUsers = await countRows(client, "users");
  const totalSessions = await countRows(client, "sessions");
  console.log(`[migrate] upserted users ${userRows.length}, sessions ${sessionRows.length}`);
  console.log(`[migrate] verify users:    ${foundUsers.count}/${userIds.size} present (table total ${totalUsers})`);
  console.log(`[migrate] verify sessions: ${foundSessions}/${sessionRows.length} present (table total ${totalSessions})`);

  const ok = foundUsers.count === userIds.size && foundSessions === sessionRows.length;
  if (!ok) fail("verification failed: some rows are missing");

  const write = await client.from("kv").upsert(
    {
      key: MARKER,
      value: { at: new Date().toISOString(), users: userIds.size, sessions: sessionRows.length },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (write.error) throw write.error;
  console.log("[migrate] done; db.json was left untouched");
} catch (e) {
  fail(`Supabase error: ${describeError(e)}`);
}
