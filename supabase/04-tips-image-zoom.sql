-- Niveau de zoom (en %, 100 = pas de zoom) appliqué à l'image du tip,
-- centré sur le point choisi via image_position.
alter table tips add column image_zoom integer not null default 100;
