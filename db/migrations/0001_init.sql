-- 0001_init: initial schema (see docs/arc42.md §5 — PostgreSQL persistence).
-- Tables: accounts, games, players, events, positions.
--
-- Migrations are applied in filename order by the runner in
-- `server/db/migrate.ts`, each in its own transaction and recorded in the
-- `schema_migrations` bookkeeping table. Migration files are immutable once
-- merged: to change the schema, add a new numbered migration.

-- gen_random_uuid() is built in on PostgreSQL 13+, but pgcrypto provides it on
-- older servers too; enabling it is a no-op where it already exists.
create extension if not exists pgcrypto;

create table if not exists accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_root      boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists games (
  id              uuid primary key default gen_random_uuid(),
  room_code       text unique not null,
  status          text not null default 'lobby',   -- lobby | active | ended
  mode            text not null default 'classic',
  boundary        jsonb,
  ping_interval_s int not null default 180,
  duration_s      int not null default 1800,
  created_at      timestamptz not null default now(),
  started_at      timestamptz
);

create table if not exists players (
  id        uuid primary key default gen_random_uuid(),
  game_id   uuid not null references games(id),
  account_id uuid references accounts(id),
  name      text not null,
  role      text not null default 'hider',   -- hunter | hider
  status    text not null default 'active',  -- active | caught | out
  joined_at timestamptz not null default now()
);

create table if not exists events (
  id         bigserial primary key,
  game_id    uuid not null references games(id),
  actor_id   uuid references players(id),
  type       text not null,                  -- join | catch | ping | win | ...
  payload    jsonb,
  created_at timestamptz not null default now()
);

create table if not exists positions (
  id          bigserial primary key,
  player_id   uuid not null references players(id),
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz not null default now()
);

-- Hot-path indexes for the event log and position history, which are queried
-- per-game / per-player and ordered by time.
create index if not exists events_game_id_created_at_idx
  on events (game_id, created_at);
create index if not exists positions_player_id_recorded_at_idx
  on positions (player_id, recorded_at);
