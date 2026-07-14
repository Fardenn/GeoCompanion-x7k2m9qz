-- ============================================================
-- GeoGuessr Companion — setup initial Supabase
-- ============================================================

-- Extension nécessaire pour gen_random_uuid()
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Table: profiles
-- Liste des joueurs connus (remplie automatiquement par le script
-- à partir du pseudo GeoGuessr, pas de vraie authentification)
-- ------------------------------------------------------------
create table profiles (
  player_name   text primary key,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Table: rounds
-- Historique détaillé de chaque round joué
-- ------------------------------------------------------------
create table rounds (
  id                uuid primary key default gen_random_uuid(),
  player_name       text not null references profiles(player_name),
  played_at         timestamptz not null default now(),
  game_token        text,
  round_number      int,
  country_code      text,
  actual_lat        double precision,
  actual_lng        double precision,
  guess_lat         double precision,
  guess_lng         double precision,
  score             int,
  distance_km       double precision,
  country_correct   boolean,
  game_mode         text,
  map_id            text,
  map_name          text,
  time_remaining_s  int
);

create index rounds_player_name_idx on rounds(player_name);
create index rounds_country_code_idx on rounds(country_code);
create index rounds_played_at_idx on rounds(played_at);

-- ------------------------------------------------------------
-- Table: tips
-- Conseils par pays, éditables par tout le monde
-- ------------------------------------------------------------
create table tips (
  id             uuid primary key default gen_random_uuid(),
  country_code   text not null,
  author_name    text references profiles(player_name),
  type           text not null check (type in ('text', 'image', 'text_image')),
  content        text,
  image_url      text,
  category       text,
  tags           text[] default '{}',
  display_order  int not null default 0,
  votes          int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index tips_country_code_idx on tips(country_code);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table profiles enable row level security;
alter table rounds enable row level security;
alter table tips enable row level security;

-- profiles : lecture ouverte, insertion libre (auto-création au
-- premier lancement du script pour un nouveau joueur)
create policy "profiles_select_all"
  on profiles for select
  to anon
  using (true);

create policy "profiles_insert_all"
  on profiles for insert
  to anon
  with check (true);

-- rounds : lecture ouverte à tous (nécessaire pour la comparaison
-- entre joueurs plus tard), insertion libre
create policy "rounds_select_all"
  on rounds for select
  to anon
  using (true);

create policy "rounds_insert_all"
  on rounds for insert
  to anon
  with check (true);

-- tips : lecture, insertion, modification et suppression ouvertes
-- à tout le monde (décision produit : tips modifiables par tous)
create policy "tips_select_all"
  on tips for select
  to anon
  using (true);

create policy "tips_insert_all"
  on tips for insert
  to anon
  with check (true);

create policy "tips_update_all"
  on tips for update
  to anon
  using (true)
  with check (true);

create policy "tips_delete_all"
  on tips for delete
  to anon
  using (true);
