-- Domino — profiles, match history and per-player stats.
--
-- Security model: clients may READ (their own profile, and matches they played
-- in) but may never WRITE. There is deliberately no INSERT/UPDATE/DELETE policy
-- on the match tables, so even a fully compromised client cannot invent a win.
-- Only the game server writes, using the service role key, through the
-- record_match() function below.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  -- Anonymous players get a profile too; this flips when they attach an email.
  is_anonymous boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Display names are public at the table anyway, so any signed-in player may
-- read them; that is what makes an opponent's record visible after a match.
create policy "profiles are readable by signed-in players"
  on public.profiles for select
  to authenticated
  using (true);

create policy "players may rename themselves"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------

create table if not exists public.matches (
  id            uuid primary key default gen_random_uuid(),
  room_code     text not null,
  rules         jsonb not null,
  target_score  integer not null,
  -- 0 = Team A (seats 0 and 2), 1 = Team B (seats 1 and 3).
  winning_team  smallint check (winning_team in (0, 1)),
  score_a       integer not null default 0,
  score_b       integer not null default 0,
  rounds_played integer not null default 0,
  started_at    timestamptz not null,
  finished_at   timestamptz not null default now()
);

alter table public.matches enable row level security;

create table if not exists public.match_players (
  match_id     uuid not null references public.matches (id) on delete cascade,
  seat         smallint not null check (seat between 0 and 3),
  -- Null for a guest who never signed in, or a since-deleted account.
  player_id    uuid references public.profiles (id) on delete set null,
  -- Snapshot of the name used at the time, so history survives a rename.
  display_name text not null,
  team         smallint not null check (team in (0, 1)),
  won          boolean not null,
  pips_left    integer not null default 0,
  primary key (match_id, seat)
);

alter table public.match_players enable row level security;

create index if not exists match_players_player_idx
  on public.match_players (player_id);
create index if not exists matches_finished_idx
  on public.matches (finished_at desc);

-- A player can see a match only if they were sitting at that table.
create policy "players may read their own matches"
  on public.matches for select
  to authenticated
  using (
    exists (
      select 1 from public.match_players mp
      where mp.match_id = matches.id and mp.player_id = auth.uid()
    )
  );

create policy "players may read the seats of their own matches"
  on public.match_players for select
  to authenticated
  using (
    exists (
      select 1 from public.match_players mine
      where mine.match_id = match_players.match_id and mine.player_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- stats
-- ---------------------------------------------------------------------------

-- security_invoker makes the view obey the caller's RLS rather than the
-- creator's, so a player only ever aggregates matches they can already read.
create or replace view public.player_stats
  with (security_invoker = on) as
select
  mp.player_id                                           as player_id,
  count(*)                                               as matches_played,
  count(*) filter (where mp.won)                         as matches_won,
  round(
    100.0 * count(*) filter (where mp.won) / nullif(count(*), 0)
  )                                                      as win_percent,
  max(m.finished_at)                                     as last_played_at
from public.match_players mp
join public.matches m on m.id = mp.match_id
where mp.player_id is not null
group by mp.player_id;

-- ---------------------------------------------------------------------------
-- the only write path
-- ---------------------------------------------------------------------------

-- Records a finished match and its four seats atomically. Called by the game
-- server with the service role key; revoked from everyone else, so a client
-- holding only the anon key cannot reach it.
create or replace function public.record_match(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  seat   jsonb;
begin
  insert into public.matches (
    room_code, rules, target_score, winning_team,
    score_a, score_b, rounds_played, started_at, finished_at
  )
  values (
    payload ->> 'room_code',
    coalesce(payload -> 'rules', '{}'::jsonb),
    (payload ->> 'target_score')::integer,
    (payload ->> 'winning_team')::smallint,
    (payload ->> 'score_a')::integer,
    (payload ->> 'score_b')::integer,
    (payload ->> 'rounds_played')::integer,
    (payload ->> 'started_at')::timestamptz,
    now()
  )
  returning id into new_id;

  for seat in select * from jsonb_array_elements(payload -> 'players')
  loop
    insert into public.match_players (
      match_id, seat, player_id, display_name, team, won, pips_left
    )
    values (
      new_id,
      (seat ->> 'seat')::smallint,
      nullif(seat ->> 'player_id', '')::uuid,
      seat ->> 'display_name',
      (seat ->> 'team')::smallint,
      (seat ->> 'won')::boolean,
      coalesce((seat ->> 'pips_left')::integer, 0)
    );
  end loop;

  return new_id;
end;
$$;

revoke all on function public.record_match(jsonb) from public, anon, authenticated;

-- Keeps a profile in step with the name a player typed at the table.
create or replace function public.upsert_profile(
  p_id uuid, p_name text, p_anonymous boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, is_anonymous)
  values (p_id, left(p_name, 20), p_anonymous)
  on conflict (id) do update
    set display_name = excluded.display_name,
        is_anonymous = excluded.is_anonymous,
        updated_at   = now();
end;
$$;

revoke all on function public.upsert_profile(uuid, text, boolean) from public, anon, authenticated;
