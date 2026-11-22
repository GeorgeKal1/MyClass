import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase (Postgres) backing for store.ts' in-memory cache.
 *
 * Server-side only: it uses the service role key, which bypasses RLS. The tables have RLS on
 * with no policies, so the anon / authenticated keys can read or write nothing.
 * Never log row contents: user rows hold encrypted credentials, chat history and messages.
 */

export interface RemoteUserRow {
  id: string;
  data: unknown;
}

export interface RemoteSessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  data: { createdAt: number };
}

const PAGE = 1000;
const CHUNK = 200;

export function supabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** A short error description without row values. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const err = e as { code?: string; message?: string };
    return [err.code, err.message].filter(Boolean).join(" ") || "unknown error";
  }
  return String(e);
}

async function selectAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(describeError(error));
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Deletes expired sessions, then loads every user and the remaining sessions. */
export async function loadAll(client: SupabaseClient) {
  const nowIso = new Date().toISOString();
  const expired = await client.from("sessions").delete().lte("expires_at", nowIso);
  if (expired.error) throw new Error(`deleting expired sessions: ${describeError(expired.error)}`);

  const users = await selectAll<RemoteUserRow>((a, b) =>
    client.from("users").select("id, data").order("id").range(a, b),
  );
  const sessions = await selectAll<RemoteSessionRow>((a, b) =>
    client
      .from("sessions")
      .select("token_hash, user_id, expires_at, data")
      .gt("expires_at", nowIso)
      .order("token_hash")
      .range(a, b),
  );
  return { users, sessions };
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export async function upsertUsers(client: SupabaseClient, rows: RemoteUserRow[]) {
  const now = new Date().toISOString();
  for (const part of chunks(rows)) {
    const { error } = await client
      .from("users")
      .upsert(part.map((r) => ({ ...r, updated_at: now })), { onConflict: "id" });
    if (error) throw new Error(`upserting users: ${describeError(error)}`);
  }
}

export async function upsertSessions(client: SupabaseClient, rows: RemoteSessionRow[]) {
  for (const part of chunks(rows)) {
    const { error } = await client.from("sessions").upsert(part, { onConflict: "token_hash" });
    if (error) throw new Error(`upserting sessions: ${describeError(error)}`);
  }
}

export async function deleteRows(client: SupabaseClient, table: "users" | "sessions", ids: string[]) {
  const column = table === "users" ? "id" : "token_hash";
  for (const part of chunks(ids)) {
    const { error } = await client.from(table).delete().in(column, part);
    if (error) throw new Error(`deleting ${table}: ${describeError(error)}`);
  }
}

export async function countRows(client: SupabaseClient, table: "users" | "sessions" | "kv"): Promise<number> {
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`counting ${table}: ${describeError(error)}`);
  return count ?? 0;
}
