-- Domino — leaderboard accounts (username + password, no email).
--
-- Security model: this table is reachable by NOBODY except the game server.
-- It holds password hashes and their salts, so unlike profiles there is no
-- "readable by signed-in players" policy here, and no policy of any other
-- kind. Row level security is on with an empty policy set, which denies
-- every request that goes through PostgREST as anon or authenticated. Only
-- the service role, which bypasses RLS and which only the server holds,
-- can see or change a row.
--
-- Grants are revoked as well as RLS being on. RLS alone would be enough, but
-- a table whose grants were never given cannot be reached even if someone
-- later adds a policy to it by mistake.

create table if not exists public.domino_accounts (
  -- The username lower-cased: the key everything is looked up by.
  id                   text primary key check (char_length(id) between 2 and 16),
  -- The same name as the player typed it, for showing back to them.
  display              text not null check (char_length(display) between 2 and 16),
  -- scrypt output and its per-account salt, both base64. Never leaves the
  -- server: see the revokes below.
  salt                 text not null,
  hash                 text not null,
  is_admin             boolean not null default false,
  wins                 integer not null default 0 check (wins >= 0),
  matches              integer not null default 0 check (matches >= 0),
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.domino_accounts enable row level security;

-- Deliberately no policies. With RLS enabled and none defined, every
-- PostgREST request as anon or authenticated matches no policy and is denied.

revoke all on table public.domino_accounts from public, anon, authenticated;

-- Keep updated_at honest without the server having to remember to send it.
create or replace function public.domino_accounts_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists domino_accounts_touch on public.domino_accounts;
create trigger domino_accounts_touch
  before update on public.domino_accounts
  for each row execute function public.domino_accounts_touch();

-- The leaderboard is ordered by wins, then by fewer matches played.
create index if not exists domino_accounts_standings
  on public.domino_accounts (wins desc, matches asc);
