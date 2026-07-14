# GeoGuessr Companion

Script Tampermonkey compagnon d'entraînement pour GeoGuessr : détection
d'événements de partie, historique des rounds, tips par pays, statistiques
(pays / continent / carte / comparaison entre joueurs).

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/) sur ton navigateur.
2. Ouvrir directement ce lien pour installer le script :
   `https://raw.githubusercontent.com/Fardenn/GeoCompanion-x7k2m9qz/main/geoguessr-companion.user.js`
3. Tampermonkey propose automatiquement l'installation.

Le script se met ensuite à jour automatiquement (Tampermonkey vérifie
périodiquement l'URL ci-dessus).

## Développement

- Éditer `geoguessr-companion.user.js`
- Incrémenter le `@version` dans l'en-tête à chaque changement (obligatoire
  pour que Tampermonkey détecte une mise à jour disponible)
- Commit + push sur `main`

## Backend

Base de données Supabase (schéma dans les fichiers `.sql`). Voir l'historique
du projet pour le détail des tables et policies.

## ⚠️ Confidentialité

Ce dépôt est public mais non référencé — ne pas le lier depuis un endroit
public (réseaux sociaux, forums, etc.). Le lien n'est destiné qu'aux
personnes explicitement invitées à utiliser le script.
