-- Initial schema (see docs/arc42.md §5). Migrations tooling TBD (backlog).
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
