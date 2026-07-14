-- Ajoute la position d'ancrage de l'image (ex: "50% 50%" = centre,
-- "0% 0%" = coin haut-gauche, etc.) utilisée comme object-position CSS
-- pour choisir quelle zone de l'image reste visible une fois recadrée.
alter table tips add column image_position text not null default '50% 50%';
