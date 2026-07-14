-- ============================================================
-- GeoGuessr Companion — table country_info (métadonnées pays)
-- ============================================================

create table country_info (
  country_code   text primary key,
  driving_side   text check (driving_side in ('left', 'right')),
  updated_at     timestamptz not null default now()
);

alter table country_info enable row level security;

-- Lecture, insertion et modification ouvertes à tout le monde (même logique
-- que les autres tables : pas d'authentification réelle, cf. profiles/tips).
create policy "country_info_select_all"
  on country_info for select
  to anon
  using (true);

create policy "country_info_insert_all"
  on country_info for insert
  to anon
  with check (true);

create policy "country_info_update_all"
  on country_info for update
  to anon
  using (true)
  with check (true);
