-- Continent calculé côté script à partir du country_code, stocké directement
-- pour simplifier et accélérer les requêtes d'agrégation par continent.
alter table rounds add column continent text;
create index rounds_continent_idx on rounds(continent);
