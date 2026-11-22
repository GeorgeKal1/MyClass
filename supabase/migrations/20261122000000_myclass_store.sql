-- myClass server store (users, sessions, server key/value state).
-- Run once in the Supabase SQL editor, or with `supabase db push`. Safe to run again.
--
-- Only the server touches these tables, with the service role key (which bypasses RLS).
-- RLS is enabled with no policies, so the anon and authenticated keys can read or write nothing.

create table if not exists public.users (
  id          text primary key,
  -- The whole UserRecord. eClass passwords, sessions and API keys inside it are AES-256-GCM
  -- ciphertext made with the server's ENCRYPTION_KEY.
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.sessions (
  -- sha256 (hex) of the session cookie value; the cookie itself is never stored
  token_hash  text primary key,
  user_id     text not null references public.users (id) on delete cascade,
  expires_at  timestamptz not null,
  data        jsonb not null default '{}'::jsonb
);

create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);

create table if not exists public.kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.users    enable row level security;
alter table public.sessions enable row level security;
alter table public.kv       enable row level security;

-- No policies on purpose. Also drop the default grants so the public API roles see nothing.
revoke all on table public.users, public.sessions, public.kv from anon, authenticated;
