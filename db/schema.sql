-- Canonical snapshot of the current schema (see docs/arc42.md §5), kept for
-- reference and quick reads. The database is built and evolved by the ordered
-- migrations in db/migrations/, applied by server/db/migrate.ts
-- (`npm run db:migrate`, or on boot with RUN_MIGRATIONS=true). Change the schema
-- by adding a new migration, then update this snapshot to match.
create table if not exists accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_root      boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists games (
  id              uuid primary key default gen_random_uuid(),
  room_code       text unique not null,
  status          text not null default 'lobby'
                    check (status in ('lobby', 'active', 'ended')),
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
  role      text not null default 'hider'
              check (role in ('hunter', 'hider')),
  status    text not null default 'active'
              check (status in ('active', 'caught', 'out')),
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

create index if not exists events_game_id_created_at_idx
  on events (game_id, created_at);
create index if not exists positions_player_id_recorded_at_idx
  on positions (player_id, recorded_at);
