// ==UserScript==
// @name         GeoGuessr Companion
// @namespace    geoguessr-companion
// @version      4.00
// @description  Compagnon d'entraînement GeoGuessr : détection d'events, historique, tips, stats (test edit Claude)
// @match        https://www.geoguessr.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/Fardenn/GeoCompanion-x7k2m9qz/main/geoguessr-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/Fardenn/GeoCompanion-x7k2m9qz/main/geoguessr-companion.user.js
// ==/UserScript==

(function () {
  'use strict';

  // CONFIG
  const SUPABASE_URL = 'https://lpbtzcpmqqsaedpdhptl.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_gH_ae7VUiLAEpuLdRBTlBA_71XF4K44';

  // Marqueur stocké en base pour distinguer "pas d'indice dans cette catégorie" (volontaire, vérifié) de "non renseigné" (juste pas encore fait).
  // Chaîne texte normale (pas de caractère de contrôle) : Postgres rejette les octets NUL (\u0000) dans les colonnes texte.
  // Déclaré ici (scope partagé par tous les modules) plutôt que dans uiPanelModule, pour que countryInfoModule puisse aussi l'utiliser.
  const GC_NO_CLUE_MARKER = '__GC_NO_CLUE__';

  // Accès au vrai contexte de page : un @grant actif fait tourner le script dans un sandbox où "window" ne pointe pas vers la page réelle.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // CORE: namespace global + event bus
  const GeoCompanion = (pageWindow.GeoCompanion = pageWindow.GeoCompanion || {});

  GeoCompanion._listeners = {};

  GeoCompanion.on = function (eventName, callback) {
    if (!GeoCompanion._listeners[eventName]) {
      GeoCompanion._listeners[eventName] = [];
    }
    GeoCompanion._listeners[eventName].push(callback);
  };

  GeoCompanion.emit = function (eventName, payload) {
    const callbacks = GeoCompanion._listeners[eventName] || [];
    for (const cb of callbacks) {
      try {
        cb(payload);
      } catch (e) {
        console.error(`[GeoCompanion] Erreur dans un listener de "${eventName}"`, e);
      }
    }
  };

  // Events disponibles : gameStart/gameEnd/roundStart/roundEnd — payload = l'objet "game" renvoyé par l'API GeoGuessr.
  function injectThemeStyles() {
    if (document.getElementById('geo-companion-theme')) return; // déjà injecté

    // Police réellement utilisée par GeoGuessr (fonctionne même si "Geoguessr Sans" n'est pas publiquement accessible en @font-face).
    let detectedFont = null;
    try {
      const bodyFont = pageWindow.getComputedStyle(document.body).fontFamily;
      if (bodyFont && bodyFont.trim()) detectedFont = bodyFont;
    } catch (e) {
      /* garde le repli générique */
    }

    const style = document.createElement('style');
    style.id = 'geo-companion-theme';
    style.textContent = `
      :root {
        /* Alias vers leur design system (--ds-color-*), repli sur les valeurs relevées manuellement si absentes. */
        --gc-bg: var(--ds-color-purple-100, #171235);
        --gc-bg-gradient: linear-gradient(160deg, var(--ds-color-purple-90, #211a4c), var(--ds-color-purple-100, #171235));
        --gc-bg-secondary: var(--ds-color-purple-90, #211a4c);
        --gc-bg-secondary-hover: var(--ds-color-purple-80, #393273);
        --gc-accent: var(--ds-color-brand-50, #7950e5);
        --gc-accent-gradient: linear-gradient(135deg, var(--ds-color-brand-30, #a685ff), var(--ds-color-brand-50, #7950e5));
        --gc-danger: var(--ds-color-red-50, #e94555);
        --gc-danger-gradient: linear-gradient(135deg, var(--ds-color-red-20, #f75c5f), var(--ds-color-red-50, #e94555));
        --gc-danger-bg: rgba(233, 69, 85, 0.14);
        --gc-success: var(--ds-color-green-50, #97e851);
        --gc-text: var(--ds-color-white-100, #fff);
        --gc-border: 1px solid var(--ds-color-white-10, rgba(255, 255, 255, 0.1));
        --gc-radius: var(--surface-radius-inner, 0.75rem);
        /* Police GeoGuessr héritée en live, repli sur celle détectée au chargement puis repli générique. */
        --gc-font: var(--default-font, ${detectedFont ? detectedFont.replace(/"/g, "'") : "-apple-system, sans-serif"});
      }

      /* ==== Panneaux ==== */
      .gc-panel {
        position: fixed;
        display: flex;
        flex-direction: column;
        background: var(--gc-bg-gradient);
        color: var(--gc-text);
        border-radius: var(--gc-radius);
        border: var(--gc-border);
        padding: 16px;
        font-family: var(--gc-font);
        z-index: 1;
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3);
        line-height: 1.4;
        box-sizing: border-box;
      }
      /* z-index:1 ci-dessus = uniquement pour le dashboard (menu profil), les panneaux résultat/tips sont remontés sinon invisibles. */
      #geo-companion-panel,
      #geo-companion-tips-panel {
        z-index: 999999;
      }

      /* ==== Typo ==== */
      .gc-title { font-weight: 700; font-size: 22px; font-style: italic; text-transform: capitalize; color: var(--ds-color-white-100, #fff); }
      .gc-subtitle { font-weight: 700; font-size: 17px; margin-bottom: 8px; font-style: italic; text-transform: capitalize; color: var(--ds-color-white-100, #fff); }
      .gc-label { opacity: 0.75; font-weight: 700; font-size: 15px; }
      .gc-muted { opacity: 0.6; }
      .gc-muted-light { opacity: 0.45; }

      /* ==== Boutons ==== */
      .gc-btn {
        border: none;
        cursor: pointer;
        border-radius: 6px;
        color: var(--ds-color-white-100, #fff);
        font-family: var(--gc-font);
        font-size: var(--button-font-size, var(--font-size-14, 13px));
        font-style: italic;
        font-weight: 700;
        text-align: center;
        text-transform: capitalize;
        text-shadow: var(--text-shadow, none);
        padding: 6px 10px;
        transition: filter 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease, background 0.15s ease;
      }
      .gc-btn:disabled { opacity: 0.6; cursor: default; }
      .gc-btn--flex { flex: 1; }
      .gc-btn--flex-auto { flex: 1 1 auto; white-space: nowrap; }
      .gc-btn--lg { font-size: 16px; padding: 10px 0; border-radius: 8px; }
      .gc-btn--xs {
        font-size: clamp(9px, 0.85vw, 11px);
        padding: 0 clamp(2px, 0.3vw, 4px);
        height: clamp(19px, 1.7vw, 24px);
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
      }
      .gc-btn--primary { background: var(--gc-accent-gradient); }
      .gc-btn--jouer {
        background: linear-gradient(var(--ds-color-brand-30, #a685ff), var(--ds-color-brand-70, #4a2399));
        text-shadow: 0 0.0625rem 0.125rem var(--ds-color-purple-100, #171235);
        box-shadow:
          0 0.275rem 1.125rem rgba(0, 0, 0, 0.25),
          inset 0 0.0625rem 0 var(--ds-color-white-20, rgba(255, 255, 255, 0.2)),
          inset 0 -0.125rem 0 rgba(0, 0, 0, 0.3);
        padding-bottom: 0.125rem;
      }
      .gc-btn--secondary { background: var(--gc-bg-secondary-hover); }
      /* Icônes simples (fond transparent) toujours utilisées en accent : une seule classe plutôt que icon + icon-accent séparées. */
      .gc-icon-btn { background: none; padding: 2px 4px; font-size: 15px; color: var(--gc-accent); }
      /* Icônes en médaillon (fond sombre semi-transparent, sur une image) : une classe par couleur plutôt que base + modificateur. */
      .gc-btn--edit-tip { background: rgba(0, 0, 0, 0.55); border-radius: 5px; padding: 4px 6px; font-size: 16px; color: var(--gc-accent); }
      .gc-btn--delete-tip { background: rgba(0, 0, 0, 0.55); border-radius: 5px; padding: 4px 6px; font-size: 16px; color: var(--gc-danger); }
      .gc-btn-row { display: flex; gap: 4px; }
      .gc-btn-row--wrap { flex-wrap: wrap; }

      /* ==== Cartes ==== */
      .gc-card {
        background: var(--gc-bg-secondary);
        border-radius: 6px;
        padding: 7px 9px;
        font-size: 15px;
        border: 1px solid transparent;
        transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
      }
      .gc-card-header { display: flex; justify-content: space-between; align-items: center; }

      /* ==== Formulaires ==== */
      .gc-input {
        width: 100%;
        margin-top: 4px;
        border-radius: 4px;
        border: 1px solid transparent;
        padding: 6px;
        box-sizing: border-box;
        background: #1a1a28;
        color: white;
        font-family: var(--gc-font);
        font-size: 15px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .gc-input:focus {
        outline: none;
        border-color: var(--gc-accent);
        box-shadow: 0 0 0 2px rgba(121, 80, 229, 0.3);
      }
      .gc-input--compact { font-size: 13px; padding: 4px; }
      textarea.gc-input { resize: vertical; }

      /* ==== Mise en page ==== */
      .gc-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .gc-grid-2--compact { gap: 3px 4px; }
      /* max 2 colonnes : largeur mini = 150px ou moitié du conteneur si plus grande, au-delà impossible de caser une 3e colonne. */
      .gc-grid-2--responsive { grid-template-columns: repeat(auto-fit, minmax(max(150px, calc(50% - 2px)), 1fr)); }
      .gc-span-2 { grid-column: 1 / span 2; }
      .gc-hr { opacity: 0.15; margin: 12px 0; border-color: #888; }
      .gc-hr--dashed { border-style: dashed; opacity: 0.3; }
      .gc-panel--outlined {
        border-radius: var(--surface-radius-outer, 1rem);
        border: 0.25rem solid oklch(from var(--ds-color-purple-100, #171235) l c h / 90%);
        outline: 0.0625rem solid var(--ds-color-purple-80, #393273);
        outline-offset: 0;
        background-color: oklch(from var(--ds-color-purple-100, #171235) l c h / 90%);
        background-image: linear-gradient(
          to bottom,
          oklch(from var(--ds-color-white-100, #fff) l c h / 4%) 0,
          oklch(from var(--ds-color-white-100, #fff) l c h / 1%) 2.5rem
        );
        background-clip: padding-box;
        background-origin: padding-box;
        background-repeat: no-repeat;
        box-shadow: var(--surface-primary-glow, 0 0 24px rgba(121, 80, 229, 0.25), 0 4px 20px rgba(0, 0, 0, 0.4));
      }
      .gc-link { color: var(--gc-accent); text-decoration: underline; }
      .gc-img { border-radius: 5px; background: #111; display: block; cursor: zoom-in; }
      .gc-relative { position: relative; }
      .gc-mt-6 { margin-top: 6px; }
      .gc-mb-6 { margin-bottom: 6px; }
      .gc-mb-8 { margin-bottom: 8px; }
      .gc-mb-10 { margin-bottom: 10px; }
      .gc-shrink-0 { flex-shrink: 0; }
      .gc-img-overlay-actions { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; }

      /* ==== Utilitaires ajoutés pour remplacer les styles inline ==== */
      .gc-fs-13 { font-size: 13px; }
      .gc-fs-14 { font-size: 14px; }
      .gc-fs-16 { font-size: 16px; }
      .gc-fs-17 { font-size: 17px; }
      .gc-fs-18 { font-size: 18px; }
      .gc-mt-2 { margin-top: 2px; }
      .gc-mb-2 { margin-bottom: 2px; }
      .gc-mt-4 { margin-top: 4px; }
      .gc-opacity-5 { opacity: 0.5; }
      .gc-opacity-8 { opacity: 0.8; }
      .gc-pre-line { white-space: pre-line; }
      .gc-collapsed { display: none !important; }

      /* ==== Composants (remplacent les style="" inline correspondants) ==== */
      .gc-result-panel { top: 20px; right: 20px; width: clamp(300px, 18.75vw, 480px); max-height: 80vh; overflow-y: auto; font-size: 20px; }
      .gc-tips-panel { top: 20px; left: 20px; width: clamp(300px, 18.75vw, 480px); height: auto; max-height: 85vh; padding: 14px; font-size: 19px; }
      /* Duel : les panneaux sont trop haut par défaut (recouvrent l'interface native du duel), abaissés à ~20% du haut de l'écran. */
      .gc-panel--duel-offset { top: 20% !important; }
      .gc-dashboard-panel { top: 70px; right: 304px; width: clamp(340px, 21vw, 536px); max-height: 61vh; padding: 12px; font-size: clamp(11px, 0.95vw, 14px); }


      .widget_root__KcxU_:nth-child(1) {
        anchor-name: --gc-widget;
      }
      .gc-dashboard-panel {
        position-anchor: --gc-widget;
        left: anchor(left);
        width: anchor-size(width);
        top: 70px;
        bottom: auto;
        height: auto;
        max-height: calc(anchor(top) - 70px - 1rem);
        overflow-y: auto;
      }

      .gc-lightbox-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.85); display: flex; align-items: center; justify-content: center; z-index: 9999999; cursor: zoom-out; }
      .gc-lightbox-img { max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6); }
      .gc-flag-img { width: auto; vertical-align: middle; display: inline-block; border-radius: 2px; }
      .gc-flag-img--round { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); }
      .gc-flag-img--list { margin-right: 4px; }
      .gc-round-header { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
      .gc-round-info { flex: 1; min-width: 0; }
      .gc-checkbox-label { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 13px; cursor: pointer; }
      .gc-flex-col-fill { display: flex; flex-direction: column; min-height: 0; flex: 1; }
      .gc-poteau-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
      .gc-flex-gap-6 { display: flex; gap: 6px; }
      .gc-flex-end-gap-8 { display: flex; justify-content: flex-end; gap: 8px; }
      .gc-stats-section { margin-top: 10px; }
      .gc-scroll-fill { flex: 1; overflow-y: auto; min-height: 0; }
      .gc-country-stats { font-size: 12px; opacity: 0.9; white-space: nowrap; flex-shrink: 0; }
      .gc-comparison-row { padding: 6px 8px; border-radius: 6px; margin-bottom: 2px; }
      .gc-comparison-row--me { background: var(--gc-bg-secondary-hover); }
      .gc-comparison-name { font-weight: 400; }
      .gc-comparison-name--me { font-weight: 700; }
      .gc-comparison-stats { font-size: 13px; opacity: 0.85; }
      .gc-btn--collapse-dash { font-style: normal; font-size: 18px; background: none; padding: 2px 4px; color: var(--gc-accent); }
      .gc-btn--delete-dash { font-style: normal; padding: 5px 10px; border-radius: 999px; background: var(--gc-danger-bg); color: var(--gc-danger); }
      .gc-h-full-border { height: 100%; box-sizing: border-box; }
      .gc-poteau-img { height: 98px; width: auto; max-width: 100%; }
      .gc-mb-10-fs-13 { margin-bottom: 10px; font-size: 13px; }
      .gc-tip-content { margin-bottom: 4px; white-space: pre-wrap; font-size: 18px; }
      .gc-mt-4-fs-13 { margin-top: 4px; font-size: 13px; }
      .gc-tip-form-card { margin-top: 6px; border-radius: 8px; }
      .gc-hr-tight { margin: 0 0 10px; }
      .gc-route-img { max-height: 98px; max-width: 100%; display: block; margin-top: 4px; }
      .gc-field-img { max-height: 98px; max-width: 100%; margin-top: 2px; }
      .gc-voiture-img { max-height: 98px; max-width: 100%; margin-top: 4px; }
      .gc-textarea-sm { min-height: 50px; }
      .gc-textarea-md { min-height: 60px; }
      .gc-continent-btn { padding-left: 6px; padding-right: 6px; }
      /* OK/Annuler des mini-formulaires d'édition (route/champ/voiture/tip) : une classe par rôle plutôt que styles séparés. */
      .gc-btn--ok { flex: 1; background: var(--gc-accent-gradient); padding: 4px; font-size: 13px; }
      .gc-btn--cancel { flex: 1; background: var(--gc-bg-secondary-hover); padding: 4px; font-size: 13px; }
      .gc-add-tip-btn { padding: 7px; font-size: 16px; background: var(--gc-bg-secondary-hover); width: 100%; margin-top: 6px; flex-shrink: 0; }
      .gc-btn--refresh-dash { padding: 8px 16px; border-radius: 999px; }
      .gc-btn--stats-toggle { padding: 8px; font-size: 14px; background: var(--gc-bg-secondary-hover); width: 100%; }
      .gc-empty-state { text-align: center; padding: 24px 0; opacity: 0.75; }
      .gc-nowrap-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gc-tip-image { width: 100%; max-height: 300px; object-fit: contain; }
      .gc-tip-card { border-radius: 8px; font-size: 16px; }
      .gc-country-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 10px;
        overflow: hidden;
        border-left: 4px solid transparent;
        transition: transform 0.12s ease, box-shadow 0.15s ease;
      }
      .gc-country-row:hover { transform: translateX(2px); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); }
      .gc-field-highlight { font-weight: bold; font-size: 22px; }
      .gc-driving-btn { padding: 4px; font-size: 11px; background: var(--gc-bg-secondary-hover); }
      .gc-driving-btn--active { background: var(--gc-accent-gradient); }

      /* ==== État "pas d'indice dans cette catégorie" (distinct de "non renseigné") ==== */
      .gc-card--no-clue {
        background: repeating-linear-gradient(
          135deg,
          rgba(255, 255, 255, 0.04),
          rgba(255, 255, 255, 0.04) 8px,
          rgba(0, 0, 0, 0.12) 8px,
          rgba(0, 0, 0, 0.12) 16px
        ), var(--gc-bg-secondary);
        opacity: 0.6;
      }
      .gc-no-clue-content {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 0;
        opacity: 0.85;
        font-style: italic;
        color: var(--gc-danger);
      }
      .gc-no-clue-icon { font-size: 16px; filter: grayscale(1); opacity: 0.8; }
      .gc-btn--toggle-no-clue { background: none; padding: 2px 4px; font-size: 14px; color: var(--gc-muted, #999); opacity: 0.7; }
      .gc-btn--toggle-no-clue--active { color: var(--gc-danger); opacity: 1; }

      /* ==== Polish : ombres, hover, transitions (boutons/cartes/images) ==== */
      .gc-btn:not(:disabled):hover { filter: brightness(1.15); }
      .gc-btn:not(:disabled):active { transform: scale(0.96); }
      .gc-btn--primary:not(:disabled):hover,
      .gc-btn--jouer:not(:disabled):hover,
      .gc-btn--ok:not(:disabled):hover {
        box-shadow: 0 4px 16px rgba(121, 80, 229, 0.45);
        transform: translateY(-1px);
      }
      .gc-btn--secondary:not(:disabled):hover,
      .gc-btn--cancel:not(:disabled):hover,
      .gc-driving-btn:not(:disabled):hover {
        background: var(--ds-color-purple-70, #4a2399);
      }
      .gc-icon-btn:hover,
      .gc-btn--edit-tip:hover,
      .gc-btn--toggle-no-clue:hover {
        transform: scale(1.18);
        filter: brightness(1.3);
      }
      .gc-btn--delete-tip:hover,
      .gc-btn--delete-dash:hover {
        filter: brightness(1.25);
        transform: scale(1.08);
      }
      .gc-card:hover:not(.gc-country-row):not(.gc-comparison-row) {
        border-color: rgba(121, 80, 229, 0.35);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      }
      .gc-img:hover { filter: brightness(1.1); }

      /* ==== Carte des indices (page d'accueil) ==== */
      .gc-indices-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 999997;
      }
      .gc-indices-map-panel {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(97vw, 1320px);
        height: 85vh;
        z-index: 999998;
      }
      .gc-indices-legend {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .gc-indices-legend-bar {
        flex: 1;
        max-width: 160px;
        height: 8px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), var(--ds-color-brand-30, #a685ff));
      }
      .gc-indices-map-wrap {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        position: relative;
      }
      .gc-indices-map-svg { width: 100%; height: 100%; max-height: 100%; }
      .gc-indices-tooltip {
        position: fixed;
        z-index: 9999999;
        background: var(--gc-bg);
        color: var(--gc-text);
        border: var(--gc-border);
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 14px;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
      .gc-toast {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--gc-bg);
        padding: 10px 16px;
        border-radius: 8px;
        font-family: var(--gc-font);
        font-size: 14px;
        z-index: 9999999;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        max-width: 80vw;
      }

      /* ==== Carte "Indices" injectée nativement dans la colonne d'accueil ====
         Traduction fidèle des règles réelles left-panel-card_* / world-card_* / headline_* / body-text_* de
         GeoGuessr (récupérées via DevTools), reprises ici avec nos propres classes gc-* pour ne pas dépendre
         de noms de classes hashés qui changeraient à chaque déploiement de leur site. */
      .gc-native-card-li {
        list-style: none;
        transition: filter 0.3s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
      }
      .gc-native-card-link {
        display: block;
        width: 100%;
        padding: 0;
        background: none;
        border: 0;
        text-align: left;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        border-radius: 1rem;
      }
      .gc-native-card-link:hover .gc-native-card-shimmer { transform: translateX(100%); }
      .gc-native-card-link:hover .gc-native-card-bg-image,
      .gc-native-card-link:hover .gc-native-card-gradient { filter: brightness(1.25); }
      .gc-native-card-link:active .gc-native-card-surface { transform: scale(0.95); transition-duration: 20ms; }

      .gc-native-card-surface {
        background-color: var(--ds-color-purple-90, #211a4c);
        position: relative;
        width: 100%;
        overflow: clip;
        padding-bottom: 0.25rem;
        border-radius: 1rem;
        box-shadow:
          0 0 0 0 color-mix(in srgb, var(--ds-color-brand-30, #a685ff) 0%, transparent),
          0 0 0 0 color-mix(in srgb, var(--ds-color-brand-50, #7950e5) 0%, transparent);
        transition:
          box-shadow 0.3s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
          transform 0.3s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
      }

      /* "relief" : ombres/lumières internes qui donnent le rebord légèrement bombé. */
      .gc-native-card-relief {
        box-shadow:
          inset 0 -0.25rem 0.0625rem 0 oklch(from var(--ds-color-black-100, #000) l c h / 40%),
          inset 0 0.0625rem 0 0 oklch(from var(--ds-color-white-100, #fff) l c h / 10%),
          inset 0 0.125rem 0.5rem 0 oklch(from var(--ds-color-purple-70, #4a2399) l c h / 50%),
          inset 0 0.0625rem 0 0 oklch(from var(--ds-color-white-100, #fff) l c h / 20%);
        position: absolute;
        inset: 0;
        z-index: 50;
        border-radius: inherit;
        pointer-events: none;
      }

      .gc-native-card-gradient {
        position: absolute;
        inset-block: 0;
        left: 0;
        z-index: 0;
        width: 200%;
        border-radius: inherit;
        background-image: linear-gradient(to right, var(--ds-color-purple-90, #211a4c), var(--ds-color-purple-50, #7950e5));
        transform: translateX(0);
        transition:
          transform 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
          filter 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
        pointer-events: none;
      }

      /* Même image de fond que la carte "World" (pas d'asset dédié pour "Indices"). Le dégradé radial sert de
         repli automatique si ce fichier venait à changer de hash lors d'un futur déploiement GeoGuessr. */
      .gc-native-card-bg-image {
        position: absolute;
        inset: 0;
        z-index: 0;
        background-position: 50% center;
        background-size: cover;
        background-repeat: no-repeat;
        background-image:
          url('/_next/static/media/bg-home-world.04379cd4.webp'),
          radial-gradient(circle at 80% 20%, oklch(from var(--ds-color-brand-30, #a685ff) l c h / 35%), transparent 65%);
        pointer-events: none;
        opacity: 1;
        transition:
          opacity 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
          filter 0.5s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
      }

      .gc-native-card-icon-wrapper {
        position: absolute;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        /* Permet à l'icône ci-dessous de se dimensionner en % de la largeur RÉELLE de la carte (cqw),
           comme l'icône native (width: 33.333%) — plutôt qu'une taille fixe qui la faisait paraître minuscule. */
        container-type: inline-size;
      }
      .gc-native-card-icon-emoji {
        position: absolute;
        right: -0.25rem;
        font-size: 56px; /* repli si container queries indisponibles */
        font-size: 30cqw; /* ~33% de la largeur de la carte, comme l'icône native */
        filter: drop-shadow(0 0.25rem 0.25rem oklch(from var(--ds-color-black-100, #000) l c h / 80%));
        transform: rotate(-10deg);
      }

      .gc-native-card-shimmer-mask {
        position: absolute;
        inset: 0;
        overflow: hidden;
        border-radius: inherit;
        pointer-events: none;
      }
      .gc-native-card-shimmer {
        position: absolute;
        inset: 0;
        transform: translateX(-100%);
        background-image: linear-gradient(to right, transparent, oklch(from var(--ds-color-white-100, #fff) l c h / 15%), transparent);
        transition: transform 0.5s var(--ease-out-quart, cubic-bezier(0.25, 1, 0.5, 1));
      }

      .gc-native-card-title {
        padding: 0.75rem 0.75rem 0;
        line-height: 1;
        text-shadow: 0 0.0625rem 0.0625rem oklch(from var(--ds-color-black-100, #000) l c h / 40%);
        position: relative;
        z-index: 10;
        filter: drop-shadow(0 0.125rem 0.03125rem oklch(from var(--ds-color-black-100, #000) l c h / 40%));
      }
      .gc-native-card-heading {
        margin: 0;
        font-size: var(--font-size-18, 18px);
        line-height: var(--line-height-18, 1.2);
        font-weight: 700;
        font-style: italic;
        color: var(--ds-color-white-100, #fff);
      }

      /* Le "collapsible" natif alterne entre un contenu replié (par défaut) et un contenu déplié au survol
         (data-open). On n'a qu'un seul contenu à afficher ici, donc il reste ouvert en permanence via --open. */
      .gc-native-card-collapsible {
        position: relative;
        z-index: 10;
        filter: drop-shadow(0 0.125rem 0.03125rem oklch(from var(--ds-color-black-100, #000) l c h / 40%));
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.3s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
      }
      .gc-native-card-collapsible--open { grid-template-rows: 1fr; }
      .gc-native-card-collapsible-inner { overflow: hidden; min-height: 0; }
      .gc-native-card-collapsed {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem;
        min-height: 4rem;
      }
      .gc-native-card-subtitle {
        font-size: var(--font-size-14, 14px);
        line-height: var(--line-height-14, 1.2);
        font-weight: 400;
        font-style: italic;
        color: var(--ds-color-white-60, rgba(255, 255, 255, 0.6));
      }
    `;
    document.head.appendChild(style);
  }
  injectThemeStyles();

  // CORE: notify (notifications discrètes, non bloquantes)

  GeoCompanion.notify = function (message, type = 'error') {
    const colors = { error: 'var(--gc-danger)', success: 'var(--gc-success)', info: 'var(--gc-accent)' };
    const color = colors[type] || colors.error;

    const toast = document.createElement('div');
    toast.className = 'gc-toast';
    toast.textContent = message;
    toast.style.color = color;
    toast.style.border = `1px solid ${color}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  };

  // CORE: détection des events de partie (fetch/XHR + parsing)
  (function apiDetectionModule() {
    // État interne, persisté pour survivre à un rechargement — le tableau "guesses" de l'API est cumulatif, d'où guessesSeenTotal.
    const STATE_KEY = 'geoCompanion_apiState';
    const savedState = GM_getValue(STATE_KEY, null);

    let currentGameId = savedState?.currentGameId ?? null;
    let currentRound = savedState?.currentRound ?? null;
    let guessesSeenTotal = savedState?.guessesSeenTotal ?? 0;
    let gameState = savedState?.gameState ?? null;
    // Round pour lequel l'event roundEnd a déjà été émis (live challenge, via le WS "LiveChallengeRoundEnded") — évite une double émission.
    let roundEndEmittedRound = savedState?.roundEndEmittedRound ?? null;
    // Dernier objet game live challenge connu (capturé en passif dès qu'une réponse HTTP a le champ rounds[].state), utilisé comme base de repli.
    let lastGoodGameSnapshot = null;
    // Live challenge uniquement : les events WS de début/fin de round n'incluent pas le numéro de round, juste un code — d'où ce compteur.
    let liveChallengeRound = savedState?.liveChallengeRound ?? null;
    // Live challenge : notre propre guess (lat/lng/distance), capturé depuis les messages WS "LiveChallengeLeaderboardUpdate".
    let wsOwnGuessByRound = {};
    // Dernier objet "game" émis pour un roundEnd donné (par round), pour pouvoir rafraîchir l'affichage si le guess arrive en retard.
    let lastEmittedRoundGameByRound = {};

    function persistState() {
      GM_setValue(STATE_KEY, {
        currentGameId,
        currentRound,
        guessesSeenTotal,
        gameState,
        roundEndEmittedRound,
        liveChallengeRound,
      });
    }

    // Le nom du champ identifiant varie selon le mode (classic, challenge, live challenge, battle royale, duels...).
    function getGameToken(game) {
      return game.token || game.gameId || game.id || null;
    }

    // Certaines réponses live challenge n'ont aucun champ round exploitable au niveau racine (contrairement au mode classique).
    function deriveRoundNumber(game) {
      const topLevel = game.round ?? game.roundNumber ?? game.currentRoundNumber;
      if (typeof topLevel === 'number') return topLevel;
      const roundsInfo = game.rounds;
      if (Array.isArray(roundsInfo) && roundsInfo.length > 0) {
        const ongoingIndex = roundsInfo.findIndex((r) => r && r.state != null && !/ended/i.test(r.state));
        if (ongoingIndex !== -1) return ongoingIndex + 1;
        return roundsInfo.length;
      }
      return null;
    }

    function handleGameObject(game) {
      if (!game || typeof game !== 'object') return;

      const token = getGameToken(game);
      if (!token) return;

      const isNewGame = currentGameId !== token;

      if (isNewGame) {
        // reset état pour la nouvelle partie
        currentGameId = token;
        currentRound = null;
        guessesSeenTotal = 0;
        gameState = null;
        liveChallengeRound = null;
        lastGoodGameSnapshot = null;
        wsOwnGuessByRound = {};
        lastEmittedRoundGameByRound = {};
        persistState();
        GeoCompanion.emit('gameStart', game);
      }

      const round = deriveRoundNumber(game);
      const roundsInfo = game.rounds || [];
      const currentRoundInfo = typeof round === 'number' ? roundsInfo[round - 1] : null;
      // Le champ state existe uniquement en live challenge — sa présence indique qu'il ne faut RIEN déclencher depuis HTTP ici.
      const isLiveChallengeResponse = currentRoundInfo?.state != null;

      if (isLiveChallengeResponse) {
        lastGoodGameSnapshot = game;
      }

      // Détection "début de round" (numéro augmenté) : pas en live challenge, géré par le WS "LiveChallengeRoundStarting".
      if (typeof round === 'number' && round !== currentRound) {
        currentRound = round;
        persistState();
        if (!isLiveChallengeResponse) {
          GeoCompanion.emit('roundStart', { ...game, _source: 'http' });
        }
      }

      // Le reste (fin de round/partie) ne concerne pas le live challenge — détecté via l'augmentation du nombre de guesses.
      if (isLiveChallengeResponse) return;

      const guesses = game.player?.guesses || game.guesses;
      if (Array.isArray(guesses) && guesses.length > guessesSeenTotal) {
        guessesSeenTotal = guesses.length;
        persistState();
        GeoCompanion.emit('roundEnd', { ...game, _source: 'http-guesses' });
      }

      // Détection fin de partie (le champ exact peut varier selon le mode : classic, battle royale...)
      const roundCount = game.roundCount ?? game.numberOfRounds;
      const finished =
        game.state?.toLowerCase() === 'finished' ||
        game.status?.toLowerCase() === 'finished' ||
        (Array.isArray(guesses) && roundCount != null && guesses.length === roundCount);

      if (finished && gameState !== 'finished') {
        gameState = 'finished';
        persistState();
        GeoCompanion.emit('gameEnd', game);
      }
    }

    function isGameApiUrl(url) {
      return (
        /\/api\/v3\/games\/[^/]+/.test(url) ||
        /\/api\/v3\/(battle-royale|duels)\//.test(url) ||
        /\/api\/v3\/challenges\/[^/]+/.test(url) ||
        // Live challenge : domaine/format différents (game-server.geoguessr.com/api/live-challenge/{token}[/guess|/advance-round|/{round}]).
        /\/api\/live-challenge\//.test(url)
      );
    }

    // L'API profil ("/api/v3/profiles" ou "/api/v3/profiles/me") est appelée par GeoGuessr au chargement de
    // chaque page : source du pseudo bien plus fiable que le scraping DOM (sélecteur de classe hashée) utilisé
    // en repli par identityModule. Volontairement PAS "/api/v3/profiles/{id}" (profils d'AUTRES joueurs).
    function isOwnProfileApiUrl(url) {
      return /\/api\/v3\/profiles(\/me)?(\?|$)/.test(url);
    }

    function maybeExtractPlayerName(data) {
      // Selon l'endpoint, le pseudo est à la racine ({nick}) ou imbriqué ({user: {nick}}).
      const nick = data?.nick ?? data?.user?.nick ?? null;
      if (typeof nick === 'string' && nick.trim()) {
        GeoCompanion.emit('playerNameFromApi', nick.trim());
      }
    }

    // --- Hook fetch ---
    const originalFetch = pageWindow.fetch;
    pageWindow.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && isGameApiUrl(url)) {
          response
            .clone()
            .json()
            .then(handleGameObject)
            .catch(() => {});
        }
        if (url && isOwnProfileApiUrl(url)) {
          response
            .clone()
            .json()
            .then(maybeExtractPlayerName)
            .catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }

      return response;
    };

    // --- Hook XMLHttpRequest (au cas où certains appels passent par XHR) ---
    const originalOpen = pageWindow.XMLHttpRequest.prototype.open;
    const originalSend = pageWindow.XMLHttpRequest.prototype.send;

    pageWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._geoEventsUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    pageWindow.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (this._geoEventsUrl && isGameApiUrl(this._geoEventsUrl)) {
            const data = JSON.parse(this.responseText);
            handleGameObject(data);
          }
          if (this._geoEventsUrl && isOwnProfileApiUrl(this._geoEventsUrl)) {
            maybeExtractPlayerName(JSON.parse(this.responseText));
          }
        } catch (e) {
          /* ignore */
        }
      });
      return originalSend.apply(this, args);
    };

    // --- Hook WebSocket (live challenge + duel) : GeoGuessr y pousse les vrais events de round/partie ---
    // Adapters par mode : chaque code de message WS pointe vers son handler, regroupés par famille
    // (LiveChallenge* = live challenge, Duel* = duel). Ajouter un mode = ajouter ses handlers ici,
    // sans toucher aux autres.
    const WS_HANDLERS = {
      // ==== Adapter live challenge ====
      LiveChallengeRoundStarting(data) {
        GeoCompanion.emit('roundStart', {
          ...(data.liveChallenge?.state || lastGoodGameSnapshot || {}),
          _source: 'ws-round-starting',
        });
      },

      LiveChallengeRoundEnded(data) {
        const state = data.liveChallenge?.state;
        // currentRoundNumber est présent directement sur ce message (confirmé par capture réseau réelle) — plus fiable que le compteur local.
        const endedRound = state?.currentRoundNumber ?? liveChallengeRound ?? currentRound ?? 1;
        if (roundEndEmittedRound === endedRound) return;

        // state a toujours guesses:null (confirmé par capture réseau) — le guess de ce joueur est ailleurs (LeaderboardUpdate).
        const game = state
          ? { ...(lastGoodGameSnapshot || {}), ...state, guesses: state.guesses ?? lastGoodGameSnapshot?.guesses ?? null }
          : lastGoodGameSnapshot;
        if (!game) return;

        // Le guess capturé via LeaderboardUpdate (wsOwnGuessByRound) est fiable pour tout le monde, host ou non — utilisé en priorité.
        const wsGuess = wsOwnGuessByRound[endedRound];
        const finalGame = wsGuess
          ? {
              ...game,
              guesses: [
                {
                  ...(game.guesses?.[game.guesses.length - 1] || {}),
                  lat: wsGuess.lat,
                  lng: wsGuess.lng,
                  distanceInMeters: wsGuess.distanceMeters,
                  ...(wsGuess.score != null ? { roundScoreInPoints: wsGuess.score } : {}),
                },
              ],
            }
          : game;
        roundEndEmittedRound = endedRound;
        liveChallengeRound = endedRound;
        persistState();
        lastEmittedRoundGameByRound[endedRound] = finalGame;
        GeoCompanion.emit('roundEnd', {
          ...finalGame,
          round: endedRound,
          _source: state ? 'ws-round-ended' : 'ws-round-ended-http-fallback',
        });
      },

      FinishChallengeFinished(data) {
        // Le vrai code est "FinishChallengeFinished", pas "LiveChallengeFinished" (confirmé par capture réseau réelle).
        if (gameState !== 'finished') {
          gameState = 'finished';
          persistState();
          GeoCompanion.emit('gameEnd', data.liveChallenge?.state || lastGoodGameSnapshot || {});
        }
      },

      LiveChallengeLeaderboardUpdate(data) {
        // Repli pour garder liveChallengeRound à jour entre deux RoundEnded (utile si un message venait à être manqué).
        const roundNumber = data.liveChallenge?.leaderboards?.roundGuessTime?.roundNumber;
        if (typeof roundNumber === 'number' && roundNumber !== liveChallengeRound) {
          liveChallengeRound = roundNumber;
          persistState();
        }

        // Notre guess pour ce round : liveChallenge.leaderboards.round.entries[i] et .guesses[i] se correspondent par index.
        const roundLeaderboard = data.liveChallenge?.leaderboards?.round;
        if (
          !roundLeaderboard ||
          typeof roundLeaderboard.roundNumber !== 'number' ||
          !Array.isArray(roundLeaderboard.entries) ||
          !Array.isArray(roundLeaderboard.guesses)
        ) {
          return;
        }
        const myName = GeoCompanion.getPlayerName?.();
        if (!myName) return;
        const myIndex = roundLeaderboard.entries.findIndex((e) => e && e.name === myName);
        const myGuess = myIndex !== -1 ? roundLeaderboard.guesses[myIndex] : null;
        const myEntry = myIndex !== -1 ? roundLeaderboard.entries[myIndex] : null;
        if (!myGuess) return;

        const roundNum = roundLeaderboard.roundNumber;
        const hadGuessBefore = wsOwnGuessByRound[roundNum] != null;
        // Score parfois absent du guess même via HTTP (même souci racine que country_code/actual_lat) — plusieurs replis testés.
        const myScore =
          myGuess.score ??
          myGuess.roundScoreInPoints ??
          myGuess.points ??
          myEntry?.score ??
          myEntry?.roundScore ??
          myEntry?.totalScore ??
          null;
        if (myScore == null) {
          console.log(
            '[GeoCompanion] 🔎 Score introuvable dans le guess WS, structure brute (aide au debug) — guess:',
            JSON.stringify(myGuess),
            '| entry:',
            JSON.stringify(myEntry)
          );
        }
        wsOwnGuessByRound[roundNum] = {
          lat: myGuess.lat,
          lng: myGuess.lng,
          distanceMeters: myGuess.distance,
          score: myScore,
        };

        // Cas particulier : ce guess arrive après le roundEnd déjà traité (joueur qui n'a pas cliqué à temps) — on met à jour et ré-émet.
        if (!hadGuessBefore && roundEndEmittedRound === roundNum && lastEmittedRoundGameByRound[roundNum]) {
          const previousGame = lastEmittedRoundGameByRound[roundNum];
          const updatedGame = {
            ...previousGame,
            guesses: [
              {
                ...(previousGame.guesses?.[0] || {}),
                lat: myGuess.lat,
                lng: myGuess.lng,
                distanceInMeters: myGuess.distance,
                ...(myScore != null ? { roundScoreInPoints: myScore } : {}),
              },
            ],
          };
          lastEmittedRoundGameByRound[roundNum] = updatedGame;
          GeoCompanion.emit('roundEnd', {
            ...updatedGame,
            round: roundNum,
            _source: 'ws-late-guess-update',
          });
        }
      },

      // ==== Adapter duel ====
      DuelStarted(data) {
        WS_HANDLERS._duelRoundStart(data, 'ws-duel-started');
      },
      DuelNewRound(data) {
        WS_HANDLERS._duelRoundStart(data, 'ws-duel-new-round');
      },
      // DuelStarted = premier round, DuelNewRound = suivants ; délai de 3s (demande explicite) pour laisser lire les panneaux du round précédent.
      _duelRoundStart(data, source) {
        const duelStateSnapshot = data.duel?.state || lastGoodGameSnapshot || {};
        setTimeout(() => {
          GeoCompanion.emit('roundStart', { ...duelStateSnapshot, _source: source });
        }, 3000);
      },

      DuelRoundTimedOut(data) {
        // Pays sur rounds[].panorama.countryCode (pas panoramaQuestionPayload comme en live challenge, confirmé par capture réseau) ; score/guess par équipe non géré, seul le pays nous intéresse en duel (demande explicite).
        const duelState = data.duel?.state;
        const endedRound = duelState?.currentRoundNumber ?? duelState?.round ?? liveChallengeRound ?? currentRound ?? 1;
        if (roundEndEmittedRound === endedRound) return;

        const game = duelState
          ? { ...(lastGoodGameSnapshot || {}), ...duelState, guesses: duelState.guesses ?? lastGoodGameSnapshot?.guesses ?? null }
          : lastGoodGameSnapshot;
        if (!game) return;

        roundEndEmittedRound = endedRound;
        liveChallengeRound = endedRound;
        persistState();
        lastEmittedRoundGameByRound[endedRound] = game;
        GeoCompanion.emit('roundEnd', {
          ...game,
          round: endedRound,
          _source: duelState ? 'ws-duel-round-timedout' : 'ws-duel-round-timedout-http-fallback',
        });
      },

      DuelFinished(data) {
        // Contrairement au live challenge (gameEnd trop précoce pour masquer, voir plus bas), DuelFinished masque directement les panneaux (demande explicite).
        if (gameState !== 'finished') {
          gameState = 'finished';
          persistState();
          GeoCompanion.emit('gameEnd', data.duel?.state || lastGoodGameSnapshot || {});
        }
        if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
      },
    };

    const OriginalWebSocket = pageWindow.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
      pageWindow.WebSocket = function (...args) {
        const ws = new OriginalWebSocket(...args);
        ws.addEventListener('message', (event) => {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch (e) {
            return; // message non-JSON, pas pour nous
          }
          if (!data || !data.code) return;

          const handler = WS_HANDLERS[data.code];
          if (handler && !data.code.startsWith('_')) {
            try {
              handler(data);
            } catch (e) {
              console.error(`[GeoCompanion] Erreur dans le handler WS "${data.code}"`, e);
            }
          }
        });
        return ws;
      };
      // Préserve le prototype et les constantes statiques (OPEN, CLOSED...) pour que le reste du site continue de fonctionner normalement.
      pageWindow.WebSocket.prototype = OriginalWebSocket.prototype;
      Object.setPrototypeOf(pageWindow.WebSocket, OriginalWebSocket);
    }
  })();

  // MODULE: debugLogger
  (function debugLoggerModule() {
    GeoCompanion.on('gameStart', (game) => {
      console.log('[GeoCompanion] 🟢 Début de partie', game);
    });

    GeoCompanion.on('gameEnd', (game) => {
      console.log('[GeoCompanion] 🔴 Fin de partie', game);
    });

    GeoCompanion.on('roundStart', (game) => {
      console.log(
        '[GeoCompanion] ▶️ Début de round',
        game.round ?? game.roundNumber ?? game.currentRoundNumber,
        `(source: ${game._source || 'inconnue'})`
      );
    });

    GeoCompanion.on('roundEnd', (game) => {
      console.log(
        '[GeoCompanion] ⏹️ Fin de round',
        game.round ?? game.roundNumber ?? game.currentRoundNumber,
        `(source: ${game._source || 'inconnue'})`
      );
    });
  })();

  // MODULE: identity
  // Sources du pseudo, par ordre de fiabilité :
  //   1. API "/api/v3/profiles" interceptée par apiDetectionModule (event "playerNameFromApi") — fait autorité,
  //      y compris pour corriger un pseudo en cache devenu obsolète (changement de pseudo, changement de compte).
  //   2. Scraping DOM du header (sélecteur de classe hashée) — repli si l'API n'a pas encore répondu.
  //   3. Saisie manuelle (prompt) — dernier recours si rien après 15s.
  (function identityModule() {
    const STORAGE_KEY = 'geoCompanion_playerName';
    let cachedName = GM_getValue(STORAGE_KEY, null);
    let observer = null;
    let promptTimer = null;
    // Vrai dès que l'API a fourni le pseudo : coupe les replis (DOM/prompt) et empêche le DOM de ré-écraser.
    let confirmedByApi = false;

    // Sélecteur best-effort sur le header GeoGuessr (span class="nick_nick__XXXXX") — le suffixe hashé peut changer avec leurs déploiements.
    function detectPlayerNameFromDom() {
      const el = document.querySelector('[class*="nick_nick__"]');
      const name = el?.textContent?.trim();
      return name || null;
    }

    function stopFallbacks() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (promptTimer) {
        clearTimeout(promptTimer);
        promptTimer = null;
      }
    }

    function setPlayerName(name, source) {
      if (!name) return;
      // Le pseudo API fait autorité et peut corriger le cache ; les autres sources ne font que combler un vide.
      if (source !== 'api' && (confirmedByApi || name === cachedName)) return;
      if (name !== cachedName) {
        cachedName = name;
        GM_setValue(STORAGE_KEY, name);
        console.log(`[GeoCompanion] 👤 Joueur identifié (${source}) :`, name);
      }
      if (source === 'api') confirmedByApi = true;
      stopFallbacks();
    }

    // Source primaire : pseudo extrait des réponses de l'API profil (voir apiDetectionModule).
    GeoCompanion.on('playerNameFromApi', (name) => setPlayerName(name, 'api'));

    function tryDetect() {
      const name = detectPlayerNameFromDom();
      if (name) setPlayerName(name, 'dom');
    }

    function askPlayerNameManually() {
      if (cachedName) return; // déjà trouvé entre-temps
      const answer = prompt(
        "GeoGuessr Companion n'a pas réussi à détecter ton pseudo automatiquement — peux-tu le saisir ?"
      );
      if (answer && answer.trim()) {
        setPlayerName(answer.trim(), 'manuel');
      }
    }

    // @run-at document-start : document.body peut ne pas encore exister — on diffère l'init si besoin.
    function initDetection() {
      // Tentative immédiate, puis surveillance du DOM (le header peut apparaître après coup).
      tryDetect();
      if (!cachedName) {
        observer = new MutationObserver(() => tryDetect());
        observer.observe(document.body, { childList: true, subtree: true });

        // Dernier recours si ni l'API ni le DOM n'ont rien donné — délai large pour laisser sa chance à l'API
        // même sur connexion lente (avant : 8s, calibré pour le seul scraping DOM).
        promptTimer = setTimeout(() => {
          stopFallbacks();
          askPlayerNameManually();
        }, 15000);
      }
    }

    if (document.body) {
      initDetection();
    } else {
      document.addEventListener('DOMContentLoaded', initDetection, { once: true });
    }

    GeoCompanion.getPlayerName = function () {
      return cachedName;
    };

    if (cachedName) {
      console.log('[GeoCompanion] 👤 Joueur en cache (session précédente) :', cachedName);
    }
  })();

  // CORE: supabaseClient — toutes les méthodes partagent le même fetch + la même gestion d'erreur (log + notification), factorisé plutôt que répété.
  async function supabaseFetch(path, options, errorLabel) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, ...options.headers },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[GeoCompanion] Erreur Supabase (${errorLabel}) :`, res.status, text);
        GeoCompanion.notify(`Échec : ${errorLabel}`, 'error');
        return null;
      }
      return res;
    } catch (e) {
      console.error(`[GeoCompanion] Exception Supabase (${errorLabel}) :`, e);
      GeoCompanion.notify(`Échec : ${errorLabel}`, 'error');
      return null;
    }
  }

  const supabaseClient = {
    // insert une ou plusieurs lignes ; merge:true fait un upsert (nécessite une policy RLS UPDATE).
    async insert(table, row, { merge = false, ignoreDuplicates = false } = {}) {
      let prefer = 'return=minimal';
      if (merge) prefer = 'resolution=merge-duplicates,return=minimal';
      if (ignoreDuplicates) prefer = 'resolution=ignore-duplicates,return=minimal';
      const res = await supabaseFetch(
        table,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(row) },
        `enregistrement (${table})`
      );
      return !!res;
    },

    // lecture simple avec query string PostgREST (ex: "select=*&country_code=eq.FR")
    async select(table, query = '') {
      const res = await supabaseFetch(`${table}?${query}`, {}, `lecture (${table})`);
      return res ? await res.json() : null;
    },

    async update(table, id, patch) {
      const res = await supabaseFetch(
        `${table}?id=eq.${id}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(patch) },
        `mise à jour (${table})`
      );
      return !!res;
    },

    // supprime la ligne d'id donné (cas particulier de removeWhere)
    async remove(table, id) {
      return this.removeWhere(table, `id=eq.${id}`);
    },

    // suppression par filtre PostgREST plutôt que par id unique — utilisé aussi pour les suppressions en masse.
    async removeWhere(table, query) {
      const res = await supabaseFetch(
        `${table}?${query}`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
        `suppression (${table})`
      );
      return !!res;
    },

    // appel d'une fonction Postgres (RPC) — agrégats calculés côté base plutôt que côté client (voir supabase-stats-functions.sql).
    async rpc(fnName, params = {}) {
      const res = await supabaseFetch(
        `rpc/${fnName}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
        'calcul des statistiques'
      );
      return res ? await res.json() : null;
    },
  };

  GeoCompanion.supabase = supabaseClient;

  // CORE: reverseGeocode — Nominatim, désormais utilisé uniquement en FALLBACK du géocodeur local ci-dessous
  // (rate limit 1 req/s, latence réseau, dépendance à un service tiers au moment précis où on veut afficher vite).
  async function reverseGeocodeCountry(lat, lng) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=3&accept-language=en`
      );
      if (!res.ok) {
        console.error('[GeoCompanion] Erreur reverse-geocoding :', res.status);
        return null;
      }
      const data = await res.json();
      return data.address?.country_code ? data.address.country_code.toUpperCase() : null;
    } catch (e) {
      console.error('[GeoCompanion] Exception reverse-geocoding :', e);
      return null;
    }
  }

  // CORE: géocodeur local (point-in-polygon)
  // Résout "quel pays contient ce point" instantanément et hors-ligne, à partir de frontières simplifiées
  // Natural Earth 110m (~230 Ko, domaine public), téléchargées une fois puis cachées en GM storage.
  const localGeocoder = (function localGeocoderModule() {
    const GEOJSON_URL =
      'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson';
    const CACHE_KEY = 'geoCompanion_countriesGeoJsonCache_v1';

    // Bug connu de Natural Earth 110m : quelques pays ont iso_a2 = "-99" (France et Norvège notamment) —
    // rattrapés par leur nom. Les territoires contestés sans code ISO restent volontairement à null.
    const NAME_TO_ISO_FALLBACK = {
      France: 'FR',
      Norway: 'NO',
      Kosovo: 'XK',
    };

    // Features précompilées : { code, bbox: [minLng, minLat, maxLng, maxLat], polygons: [[ring, hole...], ...] }.
    let compiled = null; // null = pas encore chargé, [] = chargement échoué (fallback Nominatim assumera)
    let loadingPromise = null;

    function ringBbox(ring, bbox) {
      for (const [lng, lat] of ring) {
        if (lng < bbox[0]) bbox[0] = lng;
        if (lat < bbox[1]) bbox[1] = lat;
        if (lng > bbox[2]) bbox[2] = lng;
        if (lat > bbox[3]) bbox[3] = lat;
      }
    }

    function compile(geojson) {
      const features = [];
      for (const f of geojson.features || []) {
        const props = f.properties || {};
        let code = props.iso_a2 && props.iso_a2 !== '-99' ? props.iso_a2.toUpperCase() : null;
        if (!code) code = NAME_TO_ISO_FALLBACK[props.name] || null;
        if (!code || !f.geometry) continue;

        // Normalise Polygon -> [coords] pour traiter uniformément avec MultiPolygon.
        const polygons =
          f.geometry.type === 'Polygon'
            ? [f.geometry.coordinates]
            : f.geometry.type === 'MultiPolygon'
            ? f.geometry.coordinates
            : [];
        if (polygons.length === 0) continue;

        const bbox = [Infinity, Infinity, -Infinity, -Infinity];
        for (const poly of polygons) ringBbox(poly[0], bbox); // l'anneau extérieur suffit pour la bbox
        features.push({ code, bbox, polygons });
      }
      return features;
    }

    async function ensureLoaded() {
      if (compiled) return compiled;
      if (loadingPromise) return loadingPromise;
      loadingPromise = (async () => {
        try {
          let raw = GM_getValue(CACHE_KEY, null);
          if (!raw) {
            const res = await fetch(GEOJSON_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            raw = await res.text();
            GM_setValue(CACHE_KEY, raw);
          }
          compiled = compile(JSON.parse(raw));
          console.log(`[GeoCompanion] 🗺️ Géocodeur local prêt : ${compiled.length} pays chargés.`);
        } catch (e) {
          console.error('[GeoCompanion] Géocodeur local indisponible (fallback Nominatim actif) :', e);
          compiled = []; // ne pas réessayer en boucle cette session ; Nominatim prend le relais
        }
        return compiled;
      })();
      return loadingPromise;
    }

    // Ray casting classique. Coordonnées GeoJSON en [lng, lat].
    function pointInRing(lng, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    }

    // Dans le polygone = dans l'anneau extérieur ET dans aucun trou (anneaux intérieurs).
    function pointInPolygon(lng, lat, polygonRings) {
      if (!pointInRing(lng, lat, polygonRings[0])) return false;
      for (let k = 1; k < polygonRings.length; k++) {
        if (pointInRing(lng, lat, polygonRings[k])) return false;
      }
      return true;
    }

    // Retourne le code ISO A2 du pays contenant le point, ou null si aucun polygone ne matche
    // (point en mer sur des frontières simplifiées, petite île absente du 110m...).
    async function resolve(lat, lng) {
      const features = await ensureLoaded();
      for (const f of features) {
        const [minLng, minLat, maxLng, maxLat] = f.bbox;
        if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue; // filtre bbox rapide
        for (const poly of f.polygons) {
          if (pointInPolygon(lng, lat, poly)) return f.code;
        }
      }
      return null;
    }

    // Préchargement en tâche de fond dès qu'une partie démarre : le GeoJSON est prêt avant le premier roundEnd.
    GeoCompanion.on('gameStart', () => {
      ensureLoaded();
    });

    return { resolve, ensureLoaded };
  })();

  // Résolution pays unifiée : locale d'abord (instantané, hors-ligne, sans rate limit), Nominatim en repli
  // pour les cas hors polygones (côtes/îles absentes des frontières simplifiées 110m).
  async function countryFromLatLng(lat, lng) {
    const local = await localGeocoder.resolve(lat, lng);
    if (local) return local;
    console.log('[GeoCompanion] 🗺️ Point hors polygones locaux, repli Nominatim.', lat, lng);
    return reverseGeocodeCountry(lat, lng);
  }

  // CORE: geoData (mapping pays -> continent)
  const CONTINENT_BY_COUNTRY = (() => {
    const map = {};
    const assign = (continent, codes) => codes.forEach((c) => (map[c] = continent));

    assign('europe', [
      'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE',
      'ES', 'FI', 'FO', 'FR', 'GB', 'GG', 'GI', 'GR', 'HR', 'HU', 'IE', 'IM', 'IS', 'IT',
      'JE', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT',
      'RO', 'RS', 'SE', 'SI', 'SK', 'SM', 'UA', 'VA',
    ]);
    assign('asia', [
      'AE', 'AF', 'AM', 'AZ', 'BD', 'BH', 'BN', 'BT', 'CN', 'GE', 'HK', 'ID', 'IL', 'IN',
      'IQ', 'IR', 'JO', 'JP', 'KG', 'KH', 'KP', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LK', 'MM',
      'MN', 'MO', 'MV', 'MY', 'NP', 'OM', 'PH', 'PK', 'PS', 'QA', 'RU', 'SA', 'SG', 'SY',
      'TH', 'TJ', 'TL', 'TM', 'TR', 'TW', 'UZ', 'VN', 'YE',
    ]);
    assign('africa', [
      'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG',
      'EH', 'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY',
      'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SC', 'SD', 'SL',
      'SN', 'SO', 'SS', 'ST', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
    ]);
    assign('north_america', [
      'AG', 'AI', 'AW', 'BB', 'BM', 'BS', 'BZ', 'CA', 'CR', 'CU', 'CW', 'DM', 'DO', 'GD',
      'GL', 'GP', 'GT', 'HN', 'HT', 'JM', 'KN', 'KY', 'LC', 'MF', 'MQ', 'MS', 'MX', 'NI',
      'PA', 'PR', 'SV', 'SX', 'TC', 'TT', 'US', 'VC', 'VG', 'VI',
    ]);
    assign('south_america', [
      'AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE',
    ]);
    assign('oceania', [
      'AS', 'AU', 'CK', 'FJ', 'FM', 'GU', 'KI', 'MH', 'MP', 'NC', 'NF', 'NR', 'NU', 'NZ',
      'PF', 'PG', 'PW', 'SB', 'TO', 'TV', 'VU', 'WF', 'WS',
    ]);

    return map;
  })();

  const CONTINENT_LABELS = {
    europe: 'Europe',
    asia: 'Asie',
    africa: 'Afrique',
    north_america: 'Amérique du Nord',
    south_america: 'Amérique du Sud',
    oceania: 'Océanie',
  };

  function continentFromCountryCode(code) {
    if (!code) return null;
    return CONTINENT_BY_COUNTRY[code.toUpperCase()] || null;
  }

  // Inverse de CONTINENT_BY_COUNTRY : liste de tous les codes pays connus pour un continent donné.
  const COUNTRIES_BY_CONTINENT = (() => {
    const grouped = {};
    for (const [code, continent] of Object.entries(CONTINENT_BY_COUNTRY)) {
      if (!grouped[continent]) grouped[continent] = [];
      grouped[continent].push(code);
    }
    return grouped;
  })();

  // Pays ayant une couverture Google Street View connue (donc susceptibles d'apparaître réellement en partie) — liste best-effort.
  const STREETVIEW_COVERED_COUNTRIES = new Set([
    'AX', 'AL', 'AS', 'AD', 'AR', 'AU', 'AT', 'BD', 'BY', 'BE', 'BM', 'BT', 'BO', 'BA', 'BW',
    'BR', 'BG', 'KH', 'CA', 'CL', 'CN', 'CO', 'CR', 'HR', 'CW', 'CY', 'CZ', 'DK', 'DO', 'EC',
    'EG', 'EE', 'SZ', 'FK', 'FO', 'FI', 'FR', 'DE', 'GH', 'GI', 'GR', 'GL', 'GU', 'GT', 'HK',
    'HU', 'IS', 'IN', 'ID', 'IQ', 'IE', 'IM', 'IL', 'IT', 'JP', 'JE', 'JO', 'KZ', 'KE', 'KG',
    'LA', 'LV', 'LB', 'LS', 'LI', 'LT', 'LU', 'MO', 'MG', 'MY', 'ML', 'MT', 'MX', 'MC', 'MN',
    'ME', 'NA', 'NP', 'NL', 'NZ', 'NG', 'MK', 'MP', 'NO', 'OM', 'PK', 'PS', 'PA', 'PY', 'PE',
    'PH', 'PL', 'PT', 'PR', 'QA', 'RO', 'RU', 'RW', 'SM', 'SN', 'RS', 'SG', 'SK', 'SI', 'ZA',
    'KR', 'ES', 'LK', 'SE', 'CH', 'TW', 'TZ', 'TH', 'TN', 'TR', 'UG', 'UA', 'AE', 'GB', 'US',
    'UY', 'VU', 'VN', 'VI',
  ]);

  // MODULE: roundHistory
  (function roundHistoryModule() {
    let warnedMapOnce = false;
    // Clés (game_token:round_number) déjà enregistrées cette session — évite un doublon quand un round est réémis avec le score.
    const recordedRoundKeys = new Set();
    GeoCompanion.on('gameStart', () => recordedRoundKeys.clear());

    // ==== Adapters d'extraction par mode ====
    // Chaque mode déclare OÙ trouver ses données dans l'objet game (chemins confirmés par capture réseau).
    // detectGameMode choisit l'adapter ; extractRoundData essaie l'adapter du mode détecté PUIS cascade sur
    // les autres en filet de sécurité (les chemins étant disjoints entre modes, la cascade reproduit
    // exactement les anciennes chaînes de fallback — zéro régression, mais la structure documente qui est quoi).
    const MODE_EXTRACTORS = {
      // Mode classique / challenge : champs à plat sur rounds[i] et guesses imbriqués sous player.
      classic: {
        actualLat: (ri) => ri.lat ?? ri.location?.lat,
        actualLng: (ri) => ri.lng ?? ri.location?.lng,
        countryCode: (ri) => ri.streakLocationCode ?? ri.countryCode,
        guessLat: (g) => g.lat ?? g.position?.lat,
        guessLng: (g) => g.lng ?? g.position?.lng,
        score: (g) => g.roundScoreInPoints ?? g.score?.amount,
        distanceMeters: (g) => g.distanceInMeters,
      },
      // Live challenge : coordonnées dans answer.coordinateAnswerPayload, pays dans panoramaQuestionPayload
      // (souvent absent -> résolu par géocodage), score/distance à plat sur le guess.
      'live-challenge': {
        actualLat: (ri) => ri.answer?.coordinateAnswerPayload?.coordinate?.lat ?? ri.question?.panoramaQuestionPayload?.panorama?.lat,
        actualLng: (ri) => ri.answer?.coordinateAnswerPayload?.coordinate?.lng ?? ri.question?.panoramaQuestionPayload?.panorama?.lng,
        countryCode: (ri) => ri.question?.panoramaQuestionPayload?.panorama?.countryCode,
        guessLat: (g) => g.lat,
        guessLng: (g) => g.lng,
        score: (g) => (typeof g.score === 'number' ? g.score : undefined),
        distanceMeters: (g) => (typeof g.distance === 'number' ? g.distance : undefined),
      },
      // Duel : tout est sur rounds[i].panorama (confirmé par capture réseau) ; guess/score non gérés (demande explicite).
      duel: {
        actualLat: (ri) => ri.panorama?.lat,
        actualLng: (ri) => ri.panorama?.lng,
        countryCode: (ri) => ri.panorama?.countryCode,
        guessLat: () => undefined,
        guessLng: () => undefined,
        score: () => undefined,
        distanceMeters: () => undefined,
      },
    };

    // Détection du mode, centralisée (avant : conditions ternaires imbriquées inline dans le row).
    function detectGameMode(game) {
      if (game._source?.startsWith('ws-duel')) return 'duel';
      if (game.hostId || game._source?.startsWith('ws-')) return 'live-challenge';
      return game.mode || game.gameMode || 'classic';
    }

    // Essaie l'adapter du mode détecté d'abord, puis les autres — première valeur non-nullish retenue.
    function extractField(fieldName, primaryMode, ...args) {
      const order = [primaryMode, ...Object.keys(MODE_EXTRACTORS).filter((m) => m !== primaryMode)];
      for (const mode of order) {
        const extractor = MODE_EXTRACTORS[mode];
        if (!extractor) continue;
        const value = extractor[fieldName](...args);
        if (value != null) return value;
      }
      return null;
    }

    function extractRoundData(game) {
      // Round toujours déjà présent ici : injecté explicitement par le hook WS pour le live challenge, natif pour les autres modes.
      const round = game.round ?? game.roundNumber ?? game.currentRoundNumber;

      // Les infos du lieu réel du round sont généralement dans un tableau "rounds" indexé par (round - 1).
      const roundsInfo = game.rounds || [];
      const roundInfo = roundsInfo[round - 1] || {};

      const guesses = game.player?.guesses || game.guesses || [];
      const guess = guesses[guesses.length - 1] || {};

      const detectedMode = detectGameMode(game);
      const extractorMode = MODE_EXTRACTORS[detectedMode] ? detectedMode : 'classic';

      const actualLat = extractField('actualLat', extractorMode, roundInfo);
      const actualLng = extractField('actualLng', extractorMode, roundInfo);
      const guessLat = extractField('guessLat', extractorMode, guess);
      const guessLng = extractField('guessLng', extractorMode, guess);
      // Confirmé par capture réseau réelle : ce champ arrive en minuscule en live challenge ("gh", "br"...), d'où l'uppercase forcé.
      const actualCountryRaw = extractField('countryCode', extractorMode, roundInfo);
      const actualCountry = actualCountryRaw ? actualCountryRaw.toUpperCase() : null;

      const score = extractField('score', extractorMode, guess);
      const distanceMeters = extractField('distanceMeters', extractorMode, guess);

      // game_mode stocké : le mode détecté, sauf pour les modes HTTP dont le nom natif (game.mode/gameMode)
      // fait autorité — reproduit le comportement précédent à l'identique.
      const gameMode =
        game.mode || game.gameMode || (game.hostId ? 'live-challenge' : game._source?.startsWith('ws-duel') ? 'duel' : null);

      return {
        player_name: GeoCompanion.getPlayerName(),
        game_token: game.token || game.gameId || game.id || null,
        round_number: round ?? null,
        country_code: actualCountry,
        continent: continentFromCountryCode(actualCountry),
        actual_lat: actualLat ?? null,
        actual_lng: actualLng ?? null,
        guess_lat: guessLat ?? null,
        guess_lng: guessLng ?? null,
        score,
        distance_km: distanceMeters != null ? distanceMeters / 1000 : null,
        country_correct: null, // rempli après coup via géocodage (voir handler roundEnd)
        game_mode: gameMode,
        map_id: game.map || game.mapSlug || game.options?.mapSlug || null,
        map_name: game.mapName || null,
        time_remaining_s:
          guess.time != null && game.timeLimit != null ? game.timeLimit - guess.time : null,
      };
    }

    GeoCompanion.on('roundEnd', async (game) => {
      const row = extractRoundData(game);

      // Warning séparé pour map_id (utile pour les stats par carte) — moins critique que les champs ci-dessus donc géré à part.
      if (!warnedMapOnce && row.map_id == null) {
        warnedMapOnce = true;
        console.warn(
          '[GeoCompanion] map_id introuvable dans cet objet game — les stats par carte ' +
            'ne fonctionneront pas tant que ce champ n\'est pas correctement extrait. ' +
            'Vérifie la structure ci-dessous :',
          game
        );
      }

      console.log('[GeoCompanion] 📝 Enregistrement du round :', row);

      // Certains modes (live challenge) ne fournissent pas le code pays réel directement, seulement des coordonnées à reverse-geocoder.
      if (!row.country_code && row.actual_lat != null && row.actual_lng != null) {
        const actualCountry = await countryFromLatLng(row.actual_lat, row.actual_lng);
        if (actualCountry) {
          row.country_code = actualCountry;
          row.continent = continentFromCountryCode(actualCountry);
        }
      }

      // Priorité : trouver le pays et afficher tips/stats sans dépendre de la suite (reverse-geocoding du guess, potentiellement plus lent).
      GeoCompanion.emit('roundRecorded', row);

      // Déduction du pays deviné via reverse-geocoding des coordonnées du guess.
      if (row.guess_lat != null && row.guess_lng != null && row.country_code) {
        const guessedCountry = await countryFromLatLng(row.guess_lat, row.guess_lng);
        if (guessedCountry) {
          row.country_correct = guessedCountry === row.country_code.toUpperCase();
          console.log(
            `[GeoCompanion] 🌍 Pays deviné : ${guessedCountry} — pays réel : ${row.country_code.toUpperCase()} — ${
              row.country_correct ? 'correct ✅' : 'incorrect ❌'
            }`
          );
          // Le panneau est déjà affiché (roundRecorded émis plus haut, avant de connaître ce résultat) — on met juste à jour cette ligne.
          GeoCompanion.emit('roundCorrectnessResolved', row);
        }
      }


      if (row.player_name) {
        await supabaseClient.insert('profiles', { player_name: row.player_name }, { ignoreDuplicates: true });
      }

      // On n'enregistre dans Supabase QUE lorsque le score est connu, sinon on attend un roundEnd ultérieur avec le score.
      const recordKey = `${row.game_token}:${row.round_number}`;
      if (row.game_mode === 'duel') {
        // Demande explicite : pas d'enregistrement en duel (affichage des tips uniquement), pas d'attente de score non plus.
        console.log('[GeoCompanion] Duel : pas d\'enregistrement (pays uniquement).');
      } else if (row.score == null) {
        console.log('[GeoCompanion] ⏳ Score pas encore connu pour ce round — enregistrement différé.');
      } else if (recordedRoundKeys.has(recordKey)) {
        console.log('[GeoCompanion] Round déjà enregistré, pas de ré-insertion.');
      } else {
        recordedRoundKeys.add(recordKey);
        // ignoreDuplicates : le vrai filet anti-doublon est l'index unique en base (rounds_unique_round_per_player) —
        // contrairement au Set ci-dessus, il survit à un rechargement de page. Un doublon post-refresh est ignoré
        // silencieusement (ON CONFLICT DO NOTHING) au lieu d'être inséré une seconde fois.
        const ok = await supabaseClient.insert('rounds', row, { ignoreDuplicates: true });
        if (ok) {
          console.log('[GeoCompanion] ✅ Round enregistré dans Supabase');
        }
      }
    });
  })();

  // MODULE: stats
  (function statsModule() {
    // Convertit un filterKey ('24h'|'7d'|'30d'|'all') en timestamp ISO, ou null pour 'all' (pas de filtre de date côté RPC).
    function sinceTimestamp(filterKey) {
      if (filterKey === 'all') return null;
      const hoursByFilter = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
      const hours = hoursByFilter[filterKey];
      if (!hours) return null;
      return new Date(Date.now() - hours * 3600 * 1000).toISOString();
    }

    // Convertit une ligne renvoyée par une RPC d'agrégat (snake_case, colonnes possiblement absentes) vers le format utilisé par l'UI.
    function toAggregateStats(row) {
      if (!row) return { count: 0, avgScore: null, bestScore: null, worstScore: null, successRate: null };
      return {
        count: row.count ?? 0,
        avgScore: row.avg_score != null ? Math.round(row.avg_score) : null,
        bestScore: row.best_score ?? null,
        worstScore: row.worst_score ?? null,
        successRate: row.success_rate != null ? Math.round(row.success_rate) : null,
      };
    }

    function toComparisonRows(rows) {
      if (!rows) return [];
      return rows
        .map((r) => ({
          player: r.player_name,
          count: r.count,
          avgScore: r.avg_score != null ? Math.round(r.avg_score) : null,
          successRate: r.success_rate != null ? Math.round(r.success_rate) : null,
        }))
        .sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
    }

    // Stats groupées par pays (avec continent) pour un joueur donné — utilisé par le dashboard de la page d'accueil.
    async function getAllCountryStats(playerName, filterKey = 'all') {
      const rows = await supabaseClient.rpc('get_all_country_stats', {
        p_player_name: playerName,
        p_since: sinceTimestamp(filterKey),
      });
      if (!rows) return {};

      const result = {};
      for (const r of rows) {
        if (!r.country_code) continue;
        result[r.country_code] = {
          // Fallback : les rounds enregistrés avant l'ajout de la colonne "continent" l'ont à null en base — recalculé à la volée.
          continent: r.continent || continentFromCountryCode(r.country_code),
          count: r.count,
          avgScore: r.avg_score != null ? Math.round(r.avg_score) : null,
          successRate: r.success_rate != null ? Math.round(r.success_rate) : null,
        };
      }
      return result;
    }

    // Combo fin de round : pays + continent + carte + comparaison en un seul appel réseau (au lieu de 4 requêtes séparées).
    async function getRoundEndStats(countryCode, continent, mapId, filterKey = 'all') {
      const data = await supabaseClient.rpc('get_round_end_stats', {
        p_country_code: countryCode,
        p_continent: continent || null,
        p_map_id: mapId || null,
        p_since: sinceTimestamp(filterKey),
      });
      const safe = data || {};
      return {
        country: toAggregateStats(safe.country),
        continent: safe.continent ? toAggregateStats(safe.continent) : null,
        map: safe.map ? toAggregateStats(safe.map) : null,
        comparison: toComparisonRows(safe.comparison),
      };
    }

    // Même logique de date que les stats — filterKey 'all' supprime tout l'historique du joueur.
    async function deleteRoundsForPlayer(playerName, filterKey = 'all') {
      const since = sinceTimestamp(filterKey);
      const query =
        `player_name=eq.${encodeURIComponent(playerName)}` + (since ? `&played_at=gte.${since}` : '');
      return supabaseClient.removeWhere('rounds', query);
    }

    GeoCompanion.stats = {
      getAllCountryStats,
      getRoundEndStats,
      deleteRoundsForPlayer,
    };
  })();

  // MODULE: tips
  (function tipsModule() {
    async function listTipsForCountry(countryCode) {
      const rows = await supabaseClient.select(
        'tips',
        `select=*&country_code=eq.${countryCode}&order=display_order.asc,created_at.asc`
      );
      return rows || [];
    }

    function inferType(content, imageUrl) {
      if (content && imageUrl) return 'text_image';
      if (imageUrl) return 'image';
      return 'text';
    }

    async function addTip(countryCode, { content, imageUrl }) {
      return supabaseClient.insert('tips', {
        country_code: countryCode,
        author_name: GeoCompanion.getPlayerName(),
        type: inferType(content, imageUrl),
        content: content || null,
        image_url: imageUrl || null,
      });
    }

    async function updateTip(id, { content, imageUrl }) {
      return supabaseClient.update('tips', id, {
        type: inferType(content, imageUrl),
        content: content || null,
        image_url: imageUrl || null,
        updated_at: new Date().toISOString(),
      });
    }

    async function deleteTip(id) {
      return supabaseClient.remove('tips', id);
    }

    // Nombre de tips par pays, en un seul appel réseau — utilisé par la carte des indices (pas de filtre par pays ici).
    async function getAllTipCounts() {
      const rows = await supabaseClient.select('tips', 'select=country_code');
      if (!rows) return {};
      const counts = {};
      for (const r of rows) {
        if (!r.country_code) continue;
        counts[r.country_code] = (counts[r.country_code] || 0) + 1;
      }
      return counts;
    }

    GeoCompanion.tips = { listTipsForCountry, addTip, updateTip, deleteTip, getAllTipCounts };
  })();

  // MODULE: countryInfo
  (function countryInfoModule() {
    // Retourne toutes les métadonnées d'un pays en une seule requête, telles que stockées en base.
    async function getCountryInfo(countryCode) {
      if (!countryCode) return {};
      const upper = countryCode.toUpperCase();
      const rows = await supabaseClient.select(
        'country_info',
        `select=driving_side,plaque_image_url,bollard_image_url,poteau_image_url,voiture_text,voiture_image_url,voiture_exclusive,route_text,route_image_url,langue_text&country_code=eq.${upper}`
      );
      return (rows && rows[0]) || {};
    }

    // Setter multi-champs : sauvegarde plusieurs colonnes en un seul appel (utile pour les champs composites comme "voiture").
    async function setCountryInfoFields(countryCode, fields) {
      if (!countryCode) return false;
      return supabaseClient.insert(
        'country_info',
        { country_code: countryCode.toUpperCase(), ...fields, updated_at: new Date().toISOString() },
        { merge: true }
      );
    }

    // Setter pour un seul champ (raccourci autour de setCountryInfoFields).
    async function setCountryInfoField(countryCode, field, value) {
      if (!field) return false;
      return setCountryInfoFields(countryCode, { [field]: value });
    }

    // Nombre de champs renseignés (hors "pas d'indice") par pays, en un seul appel réseau — utilisé par la carte des indices,
    // en complément des tips, pour donner une vision complète de ce qui est déjà documenté sur chaque pays.
    const RICHNESS_FIELDS = [
      'plaque_image_url',
      'bollard_image_url',
      'poteau_image_url',
      'voiture_text',
      'route_text',
      'langue_text',
    ];

    async function getAllCountryInfoCounts() {
      const rows = await supabaseClient.select(
        'country_info',
        `select=country_code,${RICHNESS_FIELDS.join(',')}`
      );
      if (!rows) return {};
      const counts = {};
      for (const r of rows) {
        if (!r.country_code) continue;
        const filled = RICHNESS_FIELDS.reduce(
          (n, key) => n + (r[key] && r[key] !== GC_NO_CLUE_MARKER ? 1 : 0),
          0
        );
        if (filled > 0) counts[r.country_code] = filled;
      }
      return counts;
    }

    GeoCompanion.countryInfo = { getCountryInfo, setCountryInfoField, setCountryInfoFields, getAllCountryInfoCounts };
  })();

  // MODULE: uiPanel
  (function uiPanelModule() {
    const PANEL_ID = 'geo-companion-panel';
    const TIPS_PANEL_ID = 'geo-companion-tips-panel';
    const FILTERS = [
      { key: '24h', label: '24h' },
      { key: '7d', label: '7j' },
      { key: '30d', label: '30j' },
      { key: 'all', label: 'Total' },
    ];

    // Marqueur "pas d'indice" (défini plus haut, en scope partagé) — alias local pour lisibilité.
    const NO_CLUE_MARKER = GC_NO_CLUE_MARKER;
    function isNoClue(value) {
      return value === NO_CLUE_MARKER;
    }

    // Empêche les touches tapées ici de remonter vers GeoGuessr (raccourcis clavier globaux sur certaines lettres).
    function stopKeyPropagation(el) {
      ['keydown', 'keyup', 'keypress'].forEach((evt) => {
        el.addEventListener(evt, (e) => e.stopPropagation());
      });
    }

    // ==== Délégation d'événements ====
    // Un SEUL listener "click" par panneau, posé une fois (idempotent). Les éléments cliquables portent
    // data-action (+ data-arg optionnel) ; les handlers sont (ré)enregistrés à chaque render via gcSetActions
    // avec les closures à jour. Remplace l'ancien pattern innerHTML + re-binding manuel de chaque bouton,
    // source récurrente de bugs (listener attaché à un élément recréé entre-temps, bouton conditionnel absent).
    function gcDelegate(panel) {
      if (panel._gcDelegated) return;
      panel._gcDelegated = true;
      panel._gcActions = {};
      panel.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el || !panel.contains(el)) return;
        const handler = panel._gcActions[el.dataset.action];
        if (handler) handler(el.dataset.arg, el, e);
      });
    }

    // reset:true (render racine d'un panneau) repart d'un registre vide ; sinon merge (sous-sections et
    // formulaires inline ajoutent leurs actions sans écraser celles des sections sœurs).
    function gcSetActions(panel, actions, { reset = false } = {}) {
      gcDelegate(panel);
      panel._gcActions = reset ? { ...actions } : { ...panel._gcActions, ...actions };
    }

    function countryNameFromCode(code) {
      try {
        return new Intl.DisplayNames(['fr'], { type: 'region' }).of(code.toUpperCase()) || code;
      } catch (e) {
        return code;
      }
    }

    // Noms raccourcis pour les affichages compacts (dashboard en grille serrée) — seuls les noms français les plus longs sont couverts.
    const SHORT_COUNTRY_NAMES = {
      AE: 'Émirats A.U.',
      BA: 'Bosnie-Herz.',
      CZ: 'Tchéquie',
      DO: 'Rép. dominicaine',
      HK: 'Hong Kong',
      KP: 'Corée du Nord',
      KR: 'Corée du Sud',
      MK: 'Macédoine N.',
      MO: 'Macao',
      MP: 'Îles Mariannes N.',
      PS: 'Palestine',
      TT: 'Trinité-Tobago',
      VG: 'Îles Vierges brit.',
      VI: 'Îles Vierges US',
      ZA: 'Afrique du Sud',
    };

    function shortCountryName(code) {
      return SHORT_COUNTRY_NAMES[code.toUpperCase()] || countryNameFromCode(code);
    }

    // Domaine internet (ccTLD) du pays : correspond en général au code ISO en minuscule, quelques exceptions ci-dessous.
    const TLD_OVERRIDES = {
      GB: 'uk', // le Royaume-Uni utilise .uk et non .gb
    };

    function tldFromCode(code) {
      if (!code || code.length !== 2) return null;
      const upper = code.toUpperCase();
      return `.${TLD_OVERRIDES[upper] || upper.toLowerCase()}`;
    }

    // Convertit un code pays ISO en <img> de drapeau via flagcdn.com (gratuit, sans clé) — remplace l'ancien rendu en emoji Unicode.
    function flagImgFromCode(code, { height = '1em', className = '' } = {}) {
      if (!code || code.length !== 2) return '';
      const lower = code.toLowerCase();
      return `<img src="https://flagcdn.com/${lower}.svg" alt="${code.toUpperCase()}" class="gc-flag-img ${className}" style="height:${height};" onerror="this.style.visibility='hidden'">`;
    }

    // Déduit l'URL plonkit.net à partir du nom anglais (ex: "United States" -> "united-states") — best-effort, la slugification ne suit pas toujours leurs URLs réelles.
    const PLONKIT_SLUG_OVERRIDES = {
      // code ISO (majuscule) -> slug plonkit, pour les cas où la conversion automatique ne matche pas.
    };

    function plonkitUrlFromCode(code) {
      if (!code) return null;
      const upper = code.toUpperCase();
      if (PLONKIT_SLUG_OVERRIDES[upper]) {
        return `https://www.plonkit.net/${PLONKIT_SLUG_OVERRIDES[upper]}`;
      }
      try {
        const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(upper);
        if (!name) return null;
        const slug = name
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '') // retire les accents
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        return `https://www.plonkit.net/${slug}`;
      } catch (e) {
        return null;
      }
    }

    function ensurePanel() {
      let panel = document.getElementById(PANEL_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'gc-panel gc-result-panel';
        document.body.appendChild(panel);
      }
      return panel;
    }

    function ensureTipsPanel() {
      let panel = document.getElementById(TIPS_PANEL_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = TIPS_PANEL_ID;
        panel.className = 'gc-panel gc-tips-panel';
        document.body.appendChild(panel);

        // Listener délégué unique (le panneau persiste entre les re-renders) : clic sur toute image data-lightbox pour l'agrandir.
        panel.addEventListener('click', (e) => {
          const img = e.target.closest('img[data-lightbox]');
          if (img) openImageLightbox(img.src);
        });
      }
      return panel;
    }

    function renderRoundResult(panel, row) {
      panel.innerHTML = `
        <div class="gc-round-header">
          <div class="gc-shrink-0">
            ${flagImgFromCode(row.country_code, { height: '10vh', className: 'gc-flag-img--round' })}
          </div>
          <div class="gc-round-info">
            <div class="gc-title gc-mb-8">
              ${row.country_code ? countryNameFromCode(row.country_code) : 'Pays inconnu'}
              ${
                row.country_code && tldFromCode(row.country_code)
                  ? `<span class="gc-title">(${tldFromCode(row.country_code)})</span>`
                  : ''
              }
            </div>
            ${row.score != null ? `<div>Score : ${row.score} pts</div>` : ''}
            ${row.distance_km != null ? `<div>Distance : ${row.distance_km.toFixed(1)} km</div>` : ''}
            <div id="geo-companion-result-line">Résultat : ${
              row.country_correct == null ? '…' : row.country_correct ? '✅ Pays trouvé' : '❌ Pays raté'
            }</div>
          </div>
        </div>
        <hr class="gc-hr">
        <button data-action="toggle-stats" class="gc-btn gc-btn--stats-toggle">📊 Voir les stats</button>
        <div id="geo-companion-stats-section" class="gc-stats-section gc-collapsed">
          <div id="geo-companion-stats">Chargement des statistiques…</div>
          <hr class="gc-hr">
          <div id="geo-companion-continent-stats"></div>
          <hr class="gc-hr">
          <div id="geo-companion-map-stats"></div>
          <hr class="gc-hr">
          <div id="geo-companion-comparison"></div>
        </div>
      `;
    }

    // Génère le HTML commun (rounds/score moyen/meilleur/pire/réussite) — réutilisé pour pays/continent/carte.
    function aggregateStatsHtml(stats) {
      if (stats.count === 0) return 'Aucune donnée pour cette période.';
      return `
        <div>Rounds joués : ${stats.count}</div>
        <div>Score moyen : ${stats.avgScore ?? '-'}</div>
        <div>Meilleur score : ${stats.bestScore ?? '-'}</div>
        <div>Pire score : ${stats.worstScore ?? '-'}</div>
        <div>Taux de réussite : ${stats.successRate != null ? stats.successRate + '%' : '-'}</div>
      `;
    }

    async function renderStats(row, activeFilter, cache) {
      const container = document.getElementById('geo-companion-stats');
      if (!container) return;

      container.innerHTML = `
        <div class="gc-btn-row gc-mb-10">
          ${FILTERS.map(
            (f) => `
            <button data-action="stats-filter" data-arg="${f.key}" class="gc-btn gc-btn--flex gc-btn--lg ${
              f.key === activeFilter ? 'gc-btn--jouer' : 'gc-btn--secondary'
            }">${f.label}</button>
          `
          ).join('')}
        </div>
        <div id="geo-companion-stats-body" class="gc-muted">Chargement…</div>
      `;

      gcSetActions(ensurePanel(), {
        'stats-filter': (filterKey) => renderStats(row, filterKey, cache),
      });

      // Cache par filtre temporel, propre à ce round affiché : changer de filtre puis revenir dessus ne refait pas d'appel réseau.
      let stats;
      if (cache.has(activeFilter)) {
        stats = cache.get(activeFilter);
      } else {
        // Un seul appel réseau pour pays + continent + carte + comparaison (au lieu de 4 requêtes séparées).
        stats = await GeoCompanion.stats.getRoundEndStats(row.country_code, row.continent, row.map_id, activeFilter);
        cache.set(activeFilter, stats);
      }
      const body = document.getElementById('geo-companion-stats-body');
      if (body) body.innerHTML = aggregateStatsHtml(stats.country);

      renderContinentStats(row, stats.continent);
      renderMapStats(row, stats.map);
      renderComparison(row, stats.comparison);
    }

    function renderContinentStats(row, continentStats) {
      const container = document.getElementById('geo-companion-continent-stats');
      if (!container) return;
      if (!row.continent || !continentStats) {
        container.innerHTML = '';
        return;
      }

      const label = CONTINENT_LABELS[row.continent] || row.continent;
      container.innerHTML = `
        <div class="gc-subtitle">🌍 ${label}</div>
        <div class="gc-muted">${aggregateStatsHtml(continentStats)}</div>
      `;
    }

    function renderMapStats(row, mapStats) {
      const container = document.getElementById('geo-companion-map-stats');
      if (!container) return;
      if (!row.map_id || !mapStats) {
        container.innerHTML = '';
        return;
      }

      const label = row.map_name || row.map_id;
      container.innerHTML = `
        <div class="gc-subtitle">🗺️ ${escapeHtml(label)}</div>
        <div class="gc-muted">${aggregateStatsHtml(mapStats)}</div>
      `;
    }

    function renderComparison(row, comparison) {
      const container = document.getElementById('geo-companion-comparison');
      if (!container) return;

      if (!comparison || comparison.length === 0) {
        container.innerHTML = `
          <div class="gc-subtitle">👥 Comparaison</div>
          <div class="gc-muted gc-fs-14">Aucune donnée pour cette période.</div>
        `;
        return;
      }

      const me = GeoCompanion.getPlayerName();
      const rowsHtml = comparison
        .map(
          (p) => `
        <div class="gc-card-header gc-comparison-row ${p.player === me ? 'gc-comparison-row--me' : ''}">
          <span class="gc-comparison-name ${p.player === me ? 'gc-comparison-name--me' : ''}">${escapeHtml(p.player)}</span>
          <span class="gc-comparison-stats">
            ${p.count} rounds · ${p.avgScore ?? '-'} pts moy. · ${p.successRate != null ? p.successRate + '%' : '-'}
          </span>
        </div>
      `
        )
        .join('');

      container.innerHTML = `
        <div class="gc-subtitle">👥 Comparaison</div>
        ${rowsHtml}
      `;
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Affiche une image en grand par-dessus tout le reste (clic pour fermer).
    function openImageLightbox(url) {
      const overlay = document.createElement('div');
      overlay.className = 'gc-lightbox-overlay';
      overlay.innerHTML = `<img src="${url}" class="gc-lightbox-img">`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }

    function tipHtml(tip) {
      const buttonsHtml = `
        <button data-action="edit-tip" data-arg="${tip.id}" class="gc-btn gc-btn--edit-tip" title="Modifier">✏️</button>
        <button data-action="delete-tip" data-arg="${tip.id}" class="gc-btn gc-btn--delete-tip" title="Supprimer">🗑️</button>
      `;

      return `
        <div class="gc-card gc-tip-card">
          ${tip.content ? `<div class="gc-tip-content">${escapeHtml(tip.content)}</div>` : ''}
          ${
            tip.image_url
              ? `
                <div class="gc-relative gc-mb-2">
                  <img data-lightbox="true" src="${tip.image_url}" class="gc-img gc-tip-image">
                  <div class="gc-img-overlay-actions">${buttonsHtml}</div>
                </div>
              `
              : `<div class="gc-flex-end-gap-8">${buttonsHtml}</div>`
          }
        </div>
      `;
    }

    function showTipForm(tipsPanel, row, tip, targetPanel) {
      const formContainer = tipsPanel.querySelector('#geo-companion-tip-form');
      if (!formContainer) return;

      formContainer.innerHTML = `
        <div class="gc-card gc-tip-form-card">
          <textarea id="geo-companion-tip-text" placeholder="Texte du tip (optionnel)" class="gc-input gc-input--compact gc-textarea-sm">${
            tip ? escapeHtml(tip.content || '') : ''
          }</textarea>
          <input id="geo-companion-tip-image" type="text" placeholder="URL d'image (optionnel)" value="${
            tip ? tip.image_url || '' : ''
          }" class="gc-input gc-input--compact">
          <div class="gc-btn-row gc-mt-6">
            <button data-action="tip-save" class="gc-btn gc-btn--ok">Enregistrer</button>
            <button data-action="tip-cancel" class="gc-btn gc-btn--cancel">Annuler</button>
          </div>
        </div>
      `;

      // Empêche GeoGuessr de capter les touches tapées ici comme des raccourcis.
      stopKeyPropagation(formContainer.querySelector('#geo-companion-tip-text'));
      stopKeyPropagation(formContainer.querySelector('#geo-companion-tip-image'));

      // Merge dans le registre du panneau (les actions racine de renderTips restent actives).
      gcSetActions(tipsPanel, {
        'tip-cancel': () => {
          formContainer.innerHTML = '';
        },
        'tip-save': async () => {
          const content = formContainer.querySelector('#geo-companion-tip-text').value.trim();
          const imageUrl = formContainer.querySelector('#geo-companion-tip-image').value.trim();
          if (!content && !imageUrl) return; // rien à enregistrer

          if (tip) {
            await GeoCompanion.tips.updateTip(tip.id, { content, imageUrl });
          } else {
            await GeoCompanion.tips.addTip(row.country_code, { content, imageUrl });
          }
          formContainer.innerHTML = '';
          await renderTips(row, targetPanel);
        },
      });
    }

    async function renderTips(row, targetPanel) {
      const tips = await GeoCompanion.tips.listTipsForCountry(row.country_code);
      // En vue "indices" (depuis la carte des indices), le contenu s'affiche dans le panneau carte déjà ouvert
      // (targetPanel fourni) plutôt que dans le panneau de tips habituel — même élément DOM, pas de nouvelle popup.
      const tipsPanel = targetPanel || ensureTipsPanel();
      if (!targetPanel) {
        tipsPanel.classList.toggle('gc-panel--duel-offset', row.game_mode === 'duel');
      }

      const plonkitUrl = plonkitUrlFromCode(row.country_code);
      const info = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);

      tipsPanel.innerHTML = `
        <div class="gc-card-header gc-mb-8 gc-shrink-0">
          <div class="gc-title">
            ${
              row.game_mode === 'indices-view'
                ? `${flagImgFromCode(row.country_code, { height: '0.9em' })} ${countryNameFromCode(row.country_code)} — 💡 Tips`
                : '💡 Tips'
            } ${
              plonkitUrl
                ? `<a href="${plonkitUrl}" target="_blank" rel="noopener noreferrer" class="gc-link gc-fs-17">🔗 Plonkit</a>`
                : ''
            }
          </div>
          <div class="gc-flex-gap-6">
            <button data-action="tips-refresh" title="Actualiser les tips" class="gc-btn gc-icon-btn gc-fs-16">🔄</button>
            ${
              row.game_mode === 'indices-view'
                ? ''
                : '<button data-action="tips-collapse" title="Replier/déplier" class="gc-btn gc-icon-btn gc-fs-18">▼</button>'
            }
            ${
              row.game_mode === 'indices-view'
                ? `<button data-action="tips-back-to-map" title="Retour à la carte" class="gc-btn gc-icon-btn gc-fs-18">◀</button>`
                : ''
            }
          </div>
        </div>
        <div id="geo-companion-tips-body" class="gc-flex-col-fill">
          <div id="geo-companion-country-fields" class="gc-mb-6 gc-shrink-0"></div>
          <div id="geo-companion-voiture-route-fields" class="gc-grid-2 gc-mb-10 gc-shrink-0">
            <div id="geo-companion-voiture-field"></div>
            <div id="geo-companion-route-field"></div>
          </div>
          <div id="geo-companion-tips-list" class="gc-scroll-fill">
            ${
              tips.length === 0
                ? `<div class="gc-muted gc-fs-16">Aucun tip pour ce pays pour l'instant.</div>`
                : `<div class="gc-grid-2">${tips.map(tipHtml).join('')}</div>`
            }
          </div>
          <button data-action="add-tip" class="gc-btn gc-add-tip-btn">+ Ajouter un tip</button>
          <div id="geo-companion-tip-form" class="gc-shrink-0"></div>
        </div>
      `;

      // Registre racine du panneau : reset:true repart à zéro, les sous-sections (champs pays/voiture/route)
      // et les formulaires inline mergeront leurs actions par-dessus.
      gcSetActions(
        tipsPanel,
        {
          'tips-refresh': async (_arg, btn) => {
            btn.disabled = true;
            await renderTips(row, targetPanel);
          },
          'tips-collapse': (_arg, btn) => {
            const tipsBody = tipsPanel.querySelector('#geo-companion-tips-body');
            const nowCollapsed = tipsBody.classList.toggle('gc-collapsed');
            btn.textContent = nowCollapsed ? '▶' : '▼';
          },
          'tips-back-to-map': () => returnToIndicesMap(),
          'edit-tip': (tipId) => {
            const tip = tips.find((t) => t.id === tipId);
            showTipForm(tipsPanel, row, tip, targetPanel);
          },
          'delete-tip': async (tipId) => {
            if (!confirm('Supprimer ce tip ?')) return;
            await GeoCompanion.tips.deleteTip(tipId);
            await renderTips(row, targetPanel);
          },
          'add-tip': () => showTipForm(tipsPanel, row, null, targetPanel),
        },
        { reset: true }
      );

      renderCountryInfoFields(tipsPanel, row, info);
      renderVoitureField(tipsPanel, row, info);
      renderRouteField(tipsPanel, row, info);
    }

    function drivingSideLabel(side) {
      if (side === 'left') return '⬅️ Gauche';
      if (side === 'right') return '➡️ Droite';
      return 'Inconnu';
    }

    // Champ "Route" composite : texte + image + sens de circulation, affiché à côté du champ Voiture.
    function renderRouteField(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-route-field');
      if (!container) return;

      const noClue = isNoClue(info.route_text);
      const hasContent = !noClue && (info.route_text || info.route_image_url);

      container.innerHTML = `
        <div class="gc-card gc-h-full-border ${noClue ? 'gc-card--no-clue' : ''}">
          <div class="gc-card-header">
            <span class="gc-label">Route 🚗 ${drivingSideLabel(info.driving_side)}</span>
            <div class="gc-flex-gap-6">
              <button data-action="toggle-no-clue-route" class="gc-btn gc-btn--toggle-no-clue ${
                noClue ? 'gc-btn--toggle-no-clue--active' : ''
              }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
              <button data-action="edit-route" class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
            </div>
          </div>
          <div data-route-display class="gc-mt-2">
            ${
              noClue
                ? `<div class="gc-no-clue-content"><span class="gc-no-clue-icon">🚫</span>Pas d'indice dans cette catégorie</div>`
                : hasContent
                ? `
              ${info.route_text ? `<div>${escapeHtml(info.route_text)}</div>` : ''}
              ${
                info.route_image_url
                  ? `<img data-lightbox="true" src="${info.route_image_url}" class="gc-img gc-route-img">`
                  : ''
              }
            `
                : '<span class="gc-muted-light">Non renseigné</span>'
            }
          </div>
          <div data-route-form></div>
        </div>
      `;

      gcSetActions(tipsPanel, {
        'toggle-no-clue-route': async () => {
          if (noClue) {
            await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, { route_text: null });
          } else {
            await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
              route_text: NO_CLUE_MARKER,
              route_image_url: null,
            });
          }
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderRouteField(tipsPanel, row, updated);
        },
        'edit-route': () => {
          const formEl = container.querySelector('[data-route-form]');
          formEl.innerHTML = `
            <input type="text" data-route-text value="${escapeHtml(
              noClue ? '' : info.route_text || ''
            )}" placeholder="Texte (marquage, bornes...)" class="gc-input gc-input--compact">
            <input type="text" data-route-image value="${escapeHtml(
              info.route_image_url || ''
            )}" placeholder="URL de l'image (optionnel)" class="gc-input gc-input--compact">
            <div class="gc-btn-row gc-mt-6">
              <button data-action="route-side" data-arg="left" class="gc-btn gc-btn--flex gc-driving-btn ${
                info.driving_side === 'left' ? 'gc-driving-btn--active' : ''
              }">⬅️ Gauche</button>
              <button data-action="route-side" data-arg="right" class="gc-btn gc-btn--flex gc-driving-btn ${
                info.driving_side === 'right' ? 'gc-driving-btn--active' : ''
              }">➡️ Droite</button>
            </div>
            <div class="gc-btn-row gc-mt-6">
              <button data-action="save-route" class="gc-btn gc-btn--ok">OK</button>
              <button data-action="cancel-route" class="gc-btn gc-btn--cancel">Annuler</button>
            </div>
          `;
          stopKeyPropagation(formEl.querySelector('[data-route-text]'));
          stopKeyPropagation(formEl.querySelector('[data-route-image]'));
        },
        // Le sens sélectionné vit dans le DOM (classe active) plutôt que dans une variable : le save le relit au clic.
        'route-side': (side) => {
          container.querySelectorAll('[data-action="route-side"]').forEach((b) => {
            b.classList.toggle('gc-driving-btn--active', b.dataset.arg === side);
          });
        },
        'cancel-route': () => {
          const formEl = container.querySelector('[data-route-form]');
          if (formEl) formEl.innerHTML = '';
        },
        'save-route': async () => {
          const formEl = container.querySelector('[data-route-form]');
          const activeSideBtn = formEl.querySelector('[data-action="route-side"].gc-driving-btn--active');
          await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
            route_text: formEl.querySelector('[data-route-text]').value.trim() || null,
            route_image_url: formEl.querySelector('[data-route-image]').value.trim() || null,
            driving_side: activeSideBtn ? activeSideBtn.dataset.arg : info.driving_side || null,
          });
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderRouteField(tipsPanel, row, updated);
        },
      });
    }

    // Champs d'identification par pays : plaque/bollard/poteau (photos) et langue (texte) — "Voiture" a son propre rendu composite plus bas.
    const COUNTRY_INFO_FIELDS = [
      { key: 'plaque_image_url', label: 'Plaque', type: 'image' },
      { key: 'bollard_image_url', label: 'Bollard', type: 'image' },
      { key: 'poteau_image_url', label: 'Poteau/Panneau', type: 'images', fullWidth: true },
      { key: 'langue_text', label: 'Langue', type: 'multitext', fullWidth: true },
    ];

    function countryInfoFieldDisplay(fieldConfig, value) {
      if (isNoClue(value)) {
        return `<div class="gc-no-clue-content"><span class="gc-no-clue-icon">🚫</span>Pas d'indice</div>`;
      }
      if (!value) {
        return `<span class="gc-muted-light">Non renseigné</span>`;
      }
      if (fieldConfig.type === 'image') {
        return `<img data-lightbox="true" src="${value}" class="gc-img gc-field-img">`;
      }
      if (fieldConfig.type === 'images') {
        const urls = value
          .split('\n')
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) return `<span class="gc-muted-light">Non renseigné</span>`;
        return `
          <div class="gc-poteau-grid">
            ${urls
              .map((u) => `<img data-lightbox="true" src="${u}" class="gc-img gc-poteau-img">`)
              .join('')}
          </div>
        `;
      }
      const highlightClass = fieldConfig.key === 'langue_text' ? 'gc-field-highlight' : '';
      if (fieldConfig.type === 'multitext') {
        // white-space:pre-line préserve les retours à la ligne saisis (une langue par ligne).
        return `<span class="gc-pre-line ${highlightClass}">${escapeHtml(value)}</span>`;
      }
      return `<span class="${highlightClass}">${escapeHtml(value)}</span>`;
    }

    function renderCountryInfoFields(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-country-fields');
      if (!container) return;

      container.innerHTML = `
        <div class="gc-grid-2">
          ${COUNTRY_INFO_FIELDS.map((f) => {
            const noClue = isNoClue(info[f.key]);
            return `
            <div class="gc-card ${f.fullWidth ? 'gc-span-2' : ''} ${noClue ? 'gc-card--no-clue' : ''}">
              <div class="gc-card-header">
                <span class="gc-label">${f.label}</span>
                <div class="gc-flex-gap-6">
                  <button data-action="toggle-no-clue" data-arg="${f.key}" class="gc-btn gc-btn--toggle-no-clue ${
              noClue ? 'gc-btn--toggle-no-clue--active' : ''
            }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
                  <button data-action="edit-field" data-arg="${f.key}" class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
                </div>
              </div>
              <div data-field-display="${f.key}" class="gc-mt-2">${countryInfoFieldDisplay(f, info[f.key])}</div>
              <div data-field-form="${f.key}"></div>
            </div>
          `;
          }).join('')}
        </div>
      `;

      // Handlers génériques : la clé du champ voyage via data-arg, ce qui permet à plusieurs formulaires
      // d'être ouverts simultanément sans conflit (le save retrouve SON formulaire par la clé).
      gcSetActions(tipsPanel, {
        'toggle-no-clue': async (key) => {
          const newValue = isNoClue(info[key]) ? null : NO_CLUE_MARKER;
          await GeoCompanion.countryInfo.setCountryInfoField(row.country_code, key, newValue);
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderCountryInfoFields(tipsPanel, row, updated);
        },
        'edit-field': (key) => {
          const fieldConfig = COUNTRY_INFO_FIELDS.find((f) => f.key === key);
          const formEl = container.querySelector(`[data-field-form="${key}"]`);
          const currentValue = isNoClue(info[key]) ? '' : info[key] || '';
          const isMultiUrl = fieldConfig.type === 'images'; // liste d'URLs (une par ligne, nettoyées)
          const isFreeText = fieldConfig.type === 'multitext'; // texte libre multi-lignes (ex: langue)
          const isTextarea = isMultiUrl || isFreeText;

          const actionsHtml = `
            <div class="gc-btn-row gc-mt-4">
              <button data-action="save-field" data-arg="${key}" class="gc-btn gc-btn--ok">OK</button>
              <button data-action="cancel-field" data-arg="${key}" class="gc-btn gc-btn--cancel">Annuler</button>
            </div>
          `;

          formEl.innerHTML = isTextarea
            ? `
              <textarea placeholder="${
                isMultiUrl ? "Une URL d'image par ligne" : 'Une ligne par langue'
              }" class="gc-input gc-input--compact gc-textarea-md">${escapeHtml(
                currentValue
              )}</textarea>
              ${actionsHtml}
            `
            : `
              <input type="text" value="${escapeHtml(currentValue)}" placeholder="${
                fieldConfig.type === 'image' ? "URL de l'image" : 'Texte'
              }" class="gc-input gc-input--compact">
              ${actionsHtml}
            `;

          stopKeyPropagation(formEl.querySelector(isTextarea ? 'textarea' : 'input'));
        },
        'cancel-field': (key) => {
          const formEl = container.querySelector(`[data-field-form="${key}"]`);
          if (formEl) formEl.innerHTML = '';
        },
        'save-field': async (key) => {
          const fieldConfig = COUNTRY_INFO_FIELDS.find((f) => f.key === key);
          const formEl = container.querySelector(`[data-field-form="${key}"]`);
          const isMultiUrl = fieldConfig.type === 'images';
          const isFreeText = fieldConfig.type === 'multitext';
          const inputEl = formEl.querySelector(isMultiUrl || isFreeText ? 'textarea' : 'input');
          const value = isMultiUrl
            ? inputEl.value
                .split('\n')
                .map((u) => u.trim())
                .filter(Boolean)
                .join('\n')
            : isFreeText
            ? inputEl.value.replace(/\n{3,}/g, '\n\n').trim() // garde les sauts de ligne, juste évite les blocs vides à rallonge
            : inputEl.value.trim();
          await GeoCompanion.countryInfo.setCountryInfoField(row.country_code, key, value || null);
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderCountryInfoFields(tipsPanel, row, updated);
        },
      });
    }

    // Champ "Voiture" composite (texte + image + case "exclusif au pays"), séparé du système générique car il combine 3 colonnes en une carte.
    function renderVoitureField(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-voiture-field');
      if (!container) return;

      const noClue = isNoClue(info.voiture_text);
      const hasContent = !noClue && (info.voiture_text || info.voiture_image_url);
      const exclusiveBadge =
        info.voiture_exclusive === true
          ? '<span class="gc-opacity-8">🔒 Exclusif au pays</span>'
          : info.voiture_exclusive === false
          ? '<span class="gc-opacity-5">🌍 Non exclusif</span>'
          : '';

      container.innerHTML = `
        <div class="gc-card ${noClue ? 'gc-card--no-clue' : ''}">
          <div class="gc-card-header">
            <span class="gc-label">Voiture</span>
            <div class="gc-flex-gap-6">
              <button data-action="toggle-no-clue-voiture" class="gc-btn gc-btn--toggle-no-clue ${
                noClue ? 'gc-btn--toggle-no-clue--active' : ''
              }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
              <button data-action="edit-voiture" class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
            </div>
          </div>
          <div data-voiture-display class="gc-mt-2">
            ${
              noClue
                ? `<div class="gc-no-clue-content"><span class="gc-no-clue-icon">🚫</span>Pas d'indice dans cette catégorie</div>`
                : hasContent
                ? `
              ${info.voiture_text ? `<div>${escapeHtml(info.voiture_text)}</div>` : ''}
              ${
                info.voiture_image_url
                  ? `<img data-lightbox="true" src="${info.voiture_image_url}" class="gc-img gc-voiture-img">`
                  : ''
              }
              ${exclusiveBadge ? `<div class="gc-mt-4-fs-13">${exclusiveBadge}</div>` : ''}
            `
                : '<span class="gc-muted-light">Non renseigné</span>'
            }
          </div>
          <div data-voiture-form></div>
        </div>
      `;

      gcSetActions(tipsPanel, {
        'toggle-no-clue-voiture': async () => {
          if (noClue) {
            await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, { voiture_text: null });
          } else {
            await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
              voiture_text: NO_CLUE_MARKER,
              voiture_image_url: null,
              voiture_exclusive: null,
            });
          }
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderVoitureField(tipsPanel, row, updated);
        },
        'edit-voiture': () => {
          const formEl = container.querySelector('[data-voiture-form]');
          formEl.innerHTML = `
            <input type="text" data-voiture-text value="${escapeHtml(
              noClue ? '' : info.voiture_text || ''
            )}" placeholder="Texte (marque, modèle...)" class="gc-input gc-input--compact">
            <input type="text" data-voiture-image value="${escapeHtml(
              info.voiture_image_url || ''
            )}" placeholder="URL de l'image (optionnel)" class="gc-input gc-input--compact">
            <label class="gc-checkbox-label">
              <input type="checkbox" data-voiture-exclusive ${info.voiture_exclusive ? 'checked' : ''}>
              Exclusif au pays
            </label>
            <div class="gc-btn-row gc-mt-6">
              <button data-action="save-voiture" class="gc-btn gc-btn--ok">OK</button>
              <button data-action="cancel-voiture" class="gc-btn gc-btn--cancel">Annuler</button>
            </div>
          `;
          stopKeyPropagation(formEl.querySelector('[data-voiture-text]'));
          stopKeyPropagation(formEl.querySelector('[data-voiture-image]'));
        },
        'cancel-voiture': () => {
          const formEl = container.querySelector('[data-voiture-form]');
          if (formEl) formEl.innerHTML = '';
        },
        'save-voiture': async () => {
          const formEl = container.querySelector('[data-voiture-form]');
          await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
            voiture_text: formEl.querySelector('[data-voiture-text]').value.trim() || null,
            voiture_image_url: formEl.querySelector('[data-voiture-image]').value.trim() || null,
            voiture_exclusive: formEl.querySelector('[data-voiture-exclusive]').checked,
          });
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderVoitureField(tipsPanel, row, updated);
        },
      });
    }

    // Affiche le résultat d'un round (panneau principal + tips + bouton stats) — factorisé pour être réutilisable depuis plusieurs events.
    async function displayRoundResult(row) {
      const panel = ensurePanel();
      panel.classList.toggle('gc-panel--duel-offset', row.game_mode === 'duel');
      renderRoundResult(panel, row);
      await renderTips(row);

      // Les stats (et donc la requête Supabase) ne sont chargées que si l'utilisateur clique explicitement sur le bouton.
      const statsCache = new Map(); // propre à cet affichage de round
      let statsLoaded = false;
      gcSetActions(
        panel,
        {
          'toggle-stats': async (_arg, btn) => {
            const statsSection = document.getElementById('geo-companion-stats-section');
            if (!statsSection) return;
            const isHidden = statsSection.classList.contains('gc-collapsed');
            if (isHidden) {
              statsSection.classList.remove('gc-collapsed');
              btn.textContent = '📊 Masquer les stats';
              if (!statsLoaded) {
                statsLoaded = true;
                await renderStats(row, 'all', statsCache);
              }
            } else {
              statsSection.classList.add('gc-collapsed');
              btn.textContent = '📊 Voir les stats';
            }
          },
        },
        { reset: true }
      );
    }

    // Persiste quel round est actuellement affiché (ou "aucun"), pour restaurer l'affichage si la page est rechargée entre la fin d'un round et le suivant.
    const LAST_DISPLAY_KEY = 'geoCompanion_lastRoundDisplay';

    // Vrai dès que gameEnd est émis (fin de partie/duel) — évite qu'un roundRecorded encore en cours de traitement (reverse-geocoding async)
    // ne fasse réapparaître un panneau après coup, alors que hideResultAndTipsPanels a déjà été appelé (ex: DuelFinished).
    let gameFinished = false;
    GeoCompanion.on('gameEnd', () => {
      gameFinished = true;
    });

    GeoCompanion.on('gameStart', () => {
      gameFinished = false;
      GM_setValue(LAST_DISPLAY_KEY, { row: null, visible: false });
      // Filet de sécurité : si on enchaîne directement d'une partie à une autre sans repasser par une page hors partie, checkHomepage() ne voit jamais la transition.
      if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
    });

    GeoCompanion.on('roundRecorded', async (row) => {
      if (!row.country_code) {
        console.log('[GeoCompanion] roundRecorded reçu sans country_code, rien à afficher.', row);
        return; // pas de pays détecté, rien d'exploitable à afficher
      }
      if (gameFinished) {
        // La partie/duel s'est déjà terminée avant même de commencer l'affichage (traitement du dernier round trop lent) — rien à montrer.
        console.log('[GeoCompanion] roundRecorded reçu après la fin de la partie, panneau ignoré.', row);
        return;
      }
      try {
        await displayRoundResult(row);
        if (gameFinished) {
          // La partie/duel s'est terminée PENDANT l'affichage (ex: DuelFinished arrivé pendant le reverse-geocoding) —
          // on ne laisse pas un résultat obsolète/vide affiché sans qu'aucun event ultérieur ne vienne le cacher.
          GeoCompanion.hideResultAndTipsPanels();
          return;
        }
        GM_setValue(LAST_DISPLAY_KEY, { row, visible: true });
      } catch (e) {
        // GeoCompanion.emit ne rattrape que les erreurs SYNCHRONES de ses listeners, pas un throw dans un listener async comme celui-ci.
        console.error('[GeoCompanion] Erreur lors de l\'affichage du résultat du round :', e, row);
      }
    });

    // Le pays deviné (✅/❌) est résolu après coup, une fois le panneau déjà affiché (voir roundHistoryModule) — on patch juste cette ligne.
    GeoCompanion.on('roundCorrectnessResolved', (row) => {
      const line = document.getElementById('geo-companion-result-line');
      if (!line) return; // panneau plus affiché (round suivant déjà démarré) : rien à mettre à jour
      line.textContent = `Résultat : ${row.country_correct ? '✅ Pays trouvé' : '❌ Pays raté'}`;
      GM_setValue(LAST_DISPLAY_KEY, { row, visible: true });
    });

    // Retire les panneaux résultat/tips et oublie l'affichage persisté — exposé sur GeoCompanion pour être réutilisable depuis d'autres modules.
    GeoCompanion.hideResultAndTipsPanels = function () {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      const tipsPanel = document.getElementById(TIPS_PANEL_ID);
      if (tipsPanel) tipsPanel.remove();
      GM_setValue(LAST_DISPLAY_KEY, { row: null, visible: false });
    };

    // Les panneaux résultat/tips n'ont d'intérêt qu'une fois le round terminé (pays révélé) — retirés au début du round suivant.
    GeoCompanion.on('roundStart', () => {
      // Un round qui démarre signifie forcément que la partie n'est PAS finie — plus fiable que de compter sur gameStart,
      // qui ne se déclenche pas de façon garantie en duel (détecté via HTTP, alors que le duel tourne surtout en WebSocket).
      gameFinished = false;
      GeoCompanion.hideResultAndTipsPanels();
    });

    // Pas de masquage sur gameEnd ici : cet event se déclenche quasi simultanément avec le roundEnd du dernier round.

    // Restauration au chargement : si la page est rechargée juste après un round, on réaffiche — seulement si encore sur une page de jeu, sinon les panneaux réapparaîtraient à tort ailleurs.
    const lastDisplay = GM_getValue(LAST_DISPLAY_KEY, null);
    if (lastDisplay?.visible && lastDisplay.row && isGameplayUrl(pageWindow.location.pathname)) {
      displayRoundResult(lastDisplay.row);
    }

    // DASHBOARD (page d'accueil)
    const DASHBOARD_ID = 'geo-companion-dashboard';
    const CONTINENT_ORDER = ['europe', 'asia', 'africa', 'north_america', 'south_america', 'oceania'];
    let dashboardActiveContinent = null; // aucun continent sélectionné par défaut = tous les pays
    let dashboardActiveFilter = 'all';
    let dashboardCollapsed = false; // conservé entre les re-rendus (changement de filtre/continent)

    // Cache en mémoire des stats par filtre temporel : changer d'onglet continent ne refait pas de requête (déjà tout récupéré côté serveur).
    const dashboardStatsCache = new Map();

    function isHomepage() {
      // Accueil GeoGuessr : "/" ou "/xx" (préfixe de langue), rien après.
      return /^\/([a-z]{2})?\/?$/i.test(pageWindow.location.pathname);
    }

    // URL qui correspond à une partie en cours (classique, challenge, live challenge, battle royale, duels...) ou son écran de résultats.
    function isGameplayUrl(pathname) {
      return /\/(game|live-challenge|challenge|battle-royale|duels?)\//i.test(pathname);
    }

    let wasInGameplayUrl = isGameplayUrl(pageWindow.location.pathname);

    function removeDashboard() {
      const el = document.getElementById(DASHBOARD_ID);
      if (el) el.remove();
    }

function ensureDashboard() {
  let panel = document.getElementById(DASHBOARD_ID);

  if (!panel) {
    panel = document.createElement('div');
    panel.id = DASHBOARD_ID;
    panel.className = 'gc-panel gc-panel--outlined gc-dashboard-panel';
    document.body.appendChild(panel);
  }

  return panel;
}

    // Couleur pleine (bordure) et lavée (fond) selon le taux de réussite : interpolation entre le rouge et le vert du design system GeoGuessr.
    function hexToRgb(hex) {
      const n = parseInt(hex.replace('#', ''), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function successColor(rate) {
      if (rate == null) return { solid: 'rgba(255, 255, 255, 0.4)', wash: 'rgba(255, 255, 255, 0.1)' };
      const from = hexToRgb('#e94555'); // --ds-color-red-50
      const to = hexToRgb('#97e851'); // --ds-color-green-50
      const t = Math.max(0, Math.min(1, rate / 100));
      const r = Math.round(from.r + (to.r - from.r) * t);
      const g = Math.round(from.g + (to.g - from.g) * t);
      const b = Math.round(from.b + (to.b - from.b) * t);
      return { solid: `rgb(${r}, ${g}, ${b})`, wash: `rgba(${r}, ${g}, ${b}, 0.18)` };
    }

    // Construit et affiche la liste des pays à partir de stats déjà chargées (aucune requête réseau ici, voir loadDashboardFilterData).
    function renderDashboardCountryList(allStats) {
      const listEl = document.getElementById('geo-companion-dashboard-list');
      if (!listEl) return;

      // Pas de continent sélectionné (désélectionné en recliquant dessus) : on affiche tous les pays, tous continents confondus.
      const allCodesForContinent = dashboardActiveContinent
        ? COUNTRIES_BY_CONTINENT[dashboardActiveContinent] || []
        : Object.values(COUNTRIES_BY_CONTINENT).flat();
      const countries = allCodesForContinent
        .map((code) => ({
          code,
          count: 0,
          avgScore: null,
          successRate: null,
          ...allStats[code], // écrase les valeurs par défaut si des stats existent
        }))
        // un pays jamais joué n'a d'intérêt à afficher que s'il a une couverture Street View connue (sinon il n'apparaîtra jamais en partie).
        .filter((c) => c.count > 0 || STREETVIEW_COVERED_COUNTRIES.has(c.code))
        .sort((a, b) => {
          // pays joués d'abord (triés par taux de réussite décroissant), puis pays jamais joués, triés par nom.
          if (a.count === 0 && b.count === 0) return countryNameFromCode(a.code).localeCompare(countryNameFromCode(b.code));
          if (a.count === 0) return 1;
          if (b.count === 0) return -1;
          return (b.successRate ?? -1) - (a.successRate ?? -1);
        });

      if (countries.length === 0) {
        listEl.innerHTML = `<div class="gc-muted gc-fs-14">${
          dashboardActiveContinent ? 'Aucun pays connu sur ce continent.' : 'Aucun pays connu.'
        }</div>`;
        return;
      }

      listEl.innerHTML = `
        <div class="gc-grid-2 gc-grid-2--compact gc-grid-2--responsive">
          ${countries
            .map((c) => {
              const color = successColor(c.successRate);
              return `
              <div class="gc-country-row" style="background:${color.wash}; border-left-color:${color.solid};">
                <span class="gc-nowrap-ellipsis">${flagImgFromCode(c.code, {
                  height: '0.9em',
                  className: 'gc-flag-img--list',
                })}${shortCountryName(c.code)}</span>
                <span class="gc-country-stats">
                  ${c.count > 0 ? `${c.count} · ${c.successRate != null ? c.successRate + '%' : '-'}` : 'Jamais joué'}
                </span>
              </div>
            `;
            })
            .join('')}
        </div>
      `;
    }

    // Aucune requête Supabase envoyée tant que l'utilisateur n'a pas cliqué sur "Actualiser" (voir renderDashboardEmptyState).
    async function loadDashboardFilterData(playerName) {
      if (!playerName) return;
      if (dashboardStatsCache.has(dashboardActiveFilter)) {
        renderDashboardCountryList(dashboardStatsCache.get(dashboardActiveFilter));
        return;
      }
      const listEl = document.getElementById('geo-companion-dashboard-list');
      if (listEl) listEl.innerHTML = `<div class="gc-muted gc-fs-13">Chargement…</div>`;

      const allStats = await GeoCompanion.stats.getAllCountryStats(playerName, dashboardActiveFilter);
      dashboardStatsCache.set(dashboardActiveFilter, allStats);

      // le DOM a pu changer entre-temps (continent/filtre recliqué pendant le chargement)
      const currentListEl = document.getElementById('geo-companion-dashboard-list');
      if (currentListEl) renderDashboardCountryList(allStats);
    }

    function renderDashboardEmptyState(playerName) {
      const listEl = document.getElementById('geo-companion-dashboard-list');
      if (!listEl) return;

      listEl.innerHTML = `
        <div class="gc-empty-state">
          <div class="gc-mb-10-fs-13">Aucune donnée chargée pour cette période.</div>
          <button data-action="dash-refresh" class="gc-btn gc-btn--jouer gc-btn--refresh-dash">🔄 Actualiser</button>
        </div>
      `;

      gcSetActions(ensureDashboard(), {
        'dash-refresh': async (_arg, btn) => {
          btn.disabled = true;
          btn.textContent = '⏳';
          await loadDashboardFilterData(playerName);
        },
      });
    }

    function renderDashboard() {
      const panel = ensureDashboard();
      const playerName = GeoCompanion.getPlayerName();

      panel.innerHTML = `
        <div class="gc-card-header gc-mb-6 gc-shrink-0">
          <div class="gc-title gc-fs-16">Mes stats</div>
          <div class="gc-flex-gap-6">
            <button data-action="dash-delete" title="Supprimer mes rounds de la période sélectionnée" class="gc-btn gc-btn--delete-dash">🗑️</button>
            <button data-action="dash-collapse" title="Replier/déplier" class="gc-btn gc-btn--collapse-dash">${
              dashboardCollapsed ? '▶' : '▼'
            }</button>
          </div>
        </div>
        <div id="geo-companion-dashboard-body" class="gc-flex-col-fill ${dashboardCollapsed ? 'gc-collapsed' : ''}">
          <hr class="gc-hr gc-hr--dashed gc-hr-tight">
          <div class="gc-btn-row gc-mb-8 gc-shrink-0">
            ${FILTERS.map(
              (f) => `
              <button data-action="dash-filter" data-arg="${f.key}" class="gc-btn gc-btn--flex gc-btn--xs ${
                f.key === dashboardActiveFilter ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }">${f.label}</button>
            `
            ).join('')}
          </div>
          <div class="gc-btn-row gc-btn-row--wrap gc-mb-10 gc-shrink-0">
            ${CONTINENT_ORDER.map(
              (c) => `
              <button data-action="dash-continent" data-arg="${c}" class="gc-btn gc-btn--flex-auto gc-btn--xs gc-continent-btn ${
                c === dashboardActiveContinent ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }">${CONTINENT_LABELS[c]}</button>
            `
            ).join('')}
          </div>
          <div id="geo-companion-dashboard-list" class="gc-scroll-fill"></div>
        </div>
      `;

      gcSetActions(
        panel,
        {
          'dash-collapse': (_arg, btn) => {
            dashboardCollapsed = !dashboardCollapsed;
            panel.querySelector('#geo-companion-dashboard-body').classList.toggle('gc-collapsed', dashboardCollapsed);
            btn.textContent = dashboardCollapsed ? '▶' : '▼';
          },
          'dash-delete': async (_arg, btn) => {
            const filterMeta = FILTERS.find((f) => f.key === dashboardActiveFilter);
            const periodLabel =
              dashboardActiveFilter === 'all'
                ? 'TOUT ton historique de rounds'
                : `tes rounds des dernières ${filterMeta.label}`;

            const confirmed = confirm(`Supprimer ${periodLabel} ? Cette action est irréversible.`);
            if (!confirmed) return;

            btn.disabled = true;
            btn.textContent = '⏳';

            const ok = await GeoCompanion.stats.deleteRoundsForPlayer(playerName, dashboardActiveFilter);
            if (ok) {
              console.log('[GeoCompanion] 🗑️ Rounds supprimés pour la période :', dashboardActiveFilter);
              dashboardStatsCache.clear();
              renderDashboardEmptyState(playerName); // la donnée vient de changer, on ne réaffiche pas l'ancien cache
            } else {
              GeoCompanion.notify('Erreur lors de la suppression des rounds', 'error');
            }
            btn.disabled = false;
            btn.textContent = '🗑️';
          },
          'dash-filter': (filterKey) => {
            dashboardActiveFilter = filterKey;
            renderDashboard();
            // Un clic sur un filtre est une demande explicite pour cette période : on charge depuis le cache s'il existe, sinon en réseau.
            loadDashboardFilterData(playerName);
          },
          'dash-continent': (continent) => {
            // Un clic sur le continent déjà actif le désélectionne (affiche tous les pays, tous continents confondus).
            dashboardActiveContinent = dashboardActiveContinent === continent ? null : continent;
            renderDashboard();
          },
        },
        { reset: true }
      );

      if (!playerName) {
        const listEl = panel.querySelector('#geo-companion-dashboard-list');
        listEl.innerHTML = `<div class="gc-muted gc-fs-13">Identification du joueur en cours…</div>`;
        return;
      }

      // Aucune requête Supabase envoyée ici : on affiche le cache s'il existe pour ce filtre, sinon un état vide avec bouton "Actualiser".
      if (dashboardStatsCache.has(dashboardActiveFilter)) {
        renderDashboardCountryList(dashboardStatsCache.get(dashboardActiveFilter));
      } else {
        renderDashboardEmptyState(playerName);
      }
    }

    // Carte native "Indices", insérée dans la colonne des raccourcis de la page d'accueil (au-dessus de Daily Challenge).
    let nativeCardObserver = null;
    // Observer temporaire utilisé uniquement le temps que React monte la liste (voir plus bas) — distinct de
    // nativeCardObserver qui, lui, surveille en continu que notre carte ne disparaisse pas après insertion.
    let nativeCardBootstrapObserver = null;

    function ensureIndicesNativeCard() {
      if (!isHomepage()) return;
      const cardsList = document.querySelector('ul[class*="new-start-page-left_cards__"]');
      if (!cardsList) {
        // Le script tourne dès document-start : au tout premier chargement, React peut ne pas avoir encore monté
        // cette liste au moment de cet appel (course avec l'hydratation) — sans ce filet, le bouton n'apparaît
        // alors qu'après une navigation SPA ultérieure (d'où "ça marche après un second refresh"). On observe le
        // document jusqu'à ce que la liste existe, plutôt que d'abandonner silencieusement.
        if (!nativeCardBootstrapObserver) {
          nativeCardBootstrapObserver = new MutationObserver(() => {
            if (document.querySelector('ul[class*="new-start-page-left_cards__"]')) {
              nativeCardBootstrapObserver.disconnect();
              nativeCardBootstrapObserver = null;
              ensureIndicesNativeCard();
            }
          });
          nativeCardBootstrapObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
      }

      if (!document.getElementById('geo-companion-native-indices-card')) {
        const li = document.createElement('li');
        li.id = 'geo-companion-native-indices-card';
        li.className = 'gc-native-card-li';
        // Structure calquée sur les cartes natives GeoGuessr (Daily Challenge / World / Competitive) :
        // surface > relief + gradient + bgImage (décor) > iconWrapper (icône) > shimmerMask (reflet animé)
        // > title (h2) > collapsible > collapsibleInner > collapsed (sous-titre).
        li.innerHTML = `
          <a href="#" class="gc-native-card-link">
            <div class="gc-native-card-surface">
              <i class="gc-native-card-relief" aria-hidden="true"></i>
              <i class="gc-native-card-gradient" aria-hidden="true"></i>
              <i class="gc-native-card-bg-image" aria-hidden="true"></i>
              <div class="gc-native-card-icon-wrapper" aria-hidden="true">
                <span class="gc-native-card-icon-emoji">💡</span>
              </div>
              <div class="gc-native-card-shimmer-mask" aria-hidden="true">
                <div class="gc-native-card-shimmer"></div>
              </div>
              <div class="gc-native-card-title">
                <h2 class="gc-native-card-heading">Indices</h2>
              </div>
              <div class="gc-native-card-collapsible gc-native-card-collapsible--open" aria-hidden="false">
                <div class="gc-native-card-collapsible-inner">
                  <div class="gc-native-card-collapsed">
                    <div class="gc-native-card-subtitle">Cartes des indices</div>
                  </div>
                </div>
              </div>
            </div>
          </a>
        `;
        li.querySelector('a').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openIndicesMap();
        });
        cardsList.insertBefore(li, cardsList.firstChild);
      }

      // React peut re-render cette liste (retirant notre <li> au passage) : on la réinjecte si elle disparaît.
      if (!nativeCardObserver) {
        const watchTarget = document.querySelector('[class*="new-start-page-left_root__"]') || document.body;
        nativeCardObserver = new MutationObserver(() => {
          if (isHomepage() && !document.getElementById('geo-companion-native-indices-card')) {
            ensureIndicesNativeCard();
          }
        });
        nativeCardObserver.observe(watchTarget, { childList: true, subtree: true });
      }
    }

    function removeIndicesNativeCard() {
      if (nativeCardObserver) {
        nativeCardObserver.disconnect();
        nativeCardObserver = null;
      }
      if (nativeCardBootstrapObserver) {
        nativeCardBootstrapObserver.disconnect();
        nativeCardBootstrapObserver = null;
      }
      const el = document.getElementById('geo-companion-native-indices-card');
      if (el) el.remove();
    }

    function checkHomepage() {
      const nowInGameplayUrl = isGameplayUrl(pageWindow.location.pathname);
      if (isHomepage()) {
        renderDashboard();
        ensureIndicesNativeCard();
        // Filet de sécurité : en live challenge, la fin de partie/round n'est pas toujours détectée de façon fiable (voir apiDetectionModule).
        if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
      } else {
        removeDashboard();
        removeIndicesNativeCard();
        closeIndicesMap();
        // Complète le filet ci-dessus pour le cas où le joueur quitte la partie vers une page qui n'est ni l'accueil ni une page de jeu.
        if (wasInGameplayUrl && !nowInGameplayUrl && GeoCompanion.hideResultAndTipsPanels) {
          GeoCompanion.hideResultAndTipsPanels();
        }
      }
      wasInGameplayUrl = nowInGameplayUrl;
    }

    // Filet de sécurité indépendant du routing : dès qu'une partie démarre (détecté via l'interception réseau, pas via l'URL).
    GeoCompanion.on('gameStart', removeDashboard);

    // Un nouveau round enregistré rend les stats du dashboard obsolètes.
    GeoCompanion.on('roundRecorded', () => {
      dashboardStatsCache.clear();
    });

    // Détection de navigation SPA : GeoGuessr ne recharge pas la page à chaque clic, donc on intercepte pushState/replaceState/popstate.
    const originalPushState = pageWindow.history.pushState;
    pageWindow.history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(checkHomepage, 300); // léger délai pour laisser la route se stabiliser
      return result;
    };

    const originalReplaceState = pageWindow.history.replaceState;
    pageWindow.history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(checkHomepage, 300);
      return result;
    };

    pageWindow.addEventListener('popstate', () => setTimeout(checkHomepage, 300));

    // CARTE DES INDICES (page d'accueil) : vue d'ensemble de tous les pays ayant au moins un tip ou un champ pays renseigné.
    const INDICES_MAP_ID = 'geo-companion-indices-map';
    // Carte simplifiée, légère (~70 Ko), sous licence libre — chargée à la demande puis mise en cache localement (pas embarquée dans le script).
    const WORLD_MAP_SVG_URL = 'https://raw.githubusercontent.com/flekschas/simple-world-map/master/world-map.svg';
    const WORLD_MAP_CACHE_KEY = 'geoCompanion_worldMapSvgCache_v1';

    // Récupère le SVG (en cache après le premier chargement, pour ne pas re-télécharger à chaque ouverture).
    async function getWorldMapSvgMarkup() {
      const cached = GM_getValue(WORLD_MAP_CACHE_KEY, null);
      if (cached) return cached;
      try {
        const res = await fetch(WORLD_MAP_SVG_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const svgText = await res.text();
        GM_setValue(WORLD_MAP_CACHE_KEY, svgText);
        return svgText;
      } catch (e) {
        console.error('[GeoCompanion] Impossible de charger la carte du monde :', e);
        GeoCompanion.notify('Impossible de charger la carte du monde', 'error');
        return null;
      }
    }

    // Interpolation violet sombre -> accent clair du thème (pas de rouge/vert ici : cet axe n'est pas une "réussite", juste une quantité).
    function indicesIntensityColor(count, maxCount) {
      if (!count) return { fill: 'rgba(255, 255, 255, 0.05)', stroke: 'rgba(255, 255, 255, 0.12)' };
      const from = { r: 57, g: 50, b: 115 }; // --ds-color-purple-80
      const to = { r: 166, g: 133, b: 255 }; // --ds-color-brand-30
      const t = maxCount > 0 ? Math.min(1, count / maxCount) : 0;
      const r = Math.round(from.r + (to.r - from.r) * t);
      const g = Math.round(from.g + (to.g - from.g) * t);
      const b = Math.round(from.b + (to.b - from.b) * t);
      return { fill: `rgb(${r}, ${g}, ${b})`, stroke: 'rgba(255, 255, 255, 0.28)' };
    }

    function ensureIndicesMapPanel() {
      let panel = document.getElementById(INDICES_MAP_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = INDICES_MAP_ID;
        panel.className = 'gc-panel gc-panel--outlined gc-indices-map-panel';
        document.body.appendChild(panel);

        // Ce même panneau affiche aussi bien la carte que la vue détail d'un pays (voir openIndicesDetail) :
        // la délégation lightbox doit donc être posée ici, comme pour le panneau de tips normal.
        panel.addEventListener('click', (e) => {
          const img = e.target.closest('img[data-lightbox]');
          if (img) openImageLightbox(img.src);
        });
      }
      return panel;
    }

    function closeIndicesMap() {
      const backdrop = document.getElementById('geo-companion-indices-backdrop');
      if (backdrop) backdrop.remove();
      const panel = document.getElementById(INDICES_MAP_ID);
      if (panel) panel.remove();
      const tooltip = document.getElementById('geo-companion-indices-tooltip');
      if (tooltip) tooltip.remove();
    }

    // Depuis la vue détail d'un pays : régénère le contenu carte DANS LE MÊME panneau (pas de nouvel élément créé/détruit,
    // donc pas de "saut" visuel), en réutilisant simplement la fonction qui construit la vue carte.
    function returnToIndicesMap() {
      const panel = document.getElementById(INDICES_MAP_ID);
      if (panel) renderIndicesMapContent(panel);
    }

    async function openIndicesDetail(code) {
      // La vue détail s'affiche DANS LE MÊME panneau que la carte (même élément DOM, même position/taille) —
      // seul le contenu intérieur change, pas de nouvelle popup qui apparaît par-dessus.
      const panel = document.getElementById(INDICES_MAP_ID);
      if (!panel) return; // le panneau carte doit déjà être ouvert pour afficher un détail

      // La tooltip de survol (nom du pays + nb d'indices) reste affichée sinon, car le clic ne déclenche pas
      // de "mouseleave" sur le <path> (le contenu change sous la souris sans qu'elle bouge).
      const tooltip = document.getElementById('geo-companion-indices-tooltip');
      if (tooltip) tooltip.classList.add('gc-collapsed');

      const row = { country_code: code, game_mode: 'indices-view' };
      await renderTips(row, panel);
    }

    async function openIndicesMap() {
      // Fond semi-transparent façon lightbox, pour bien détacher la carte du reste de la page.
      let backdrop = document.getElementById('geo-companion-indices-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'geo-companion-indices-backdrop';
        backdrop.className = 'gc-indices-backdrop';
        backdrop.addEventListener('click', closeIndicesMap);
        document.body.appendChild(backdrop);
      }

      const panel = ensureIndicesMapPanel();
      await renderIndicesMapContent(panel);
    }

    // Construit la vue "carte" à l'intérieur d'un panneau déjà existant — factorisé pour être appelable à la fois
    // à l'ouverture (openIndicesMap) et au retour depuis la vue détail (returnToIndicesMap), sans recréer le panneau.
    async function renderIndicesMapContent(panel) {
      panel.innerHTML = `
        <div class="gc-card-header gc-mb-8 gc-shrink-0">
          <div class="gc-title gc-fs-18">💡 Indices par pays</div>
          <div class="gc-flex-gap-6">
            <button data-action="indices-close" class="gc-btn gc-icon-btn gc-fs-18" title="Fermer">✕</button>
          </div>
        </div>
        <div id="geo-companion-indices-map-body" class="gc-flex-col-fill gc-scroll-fill">
          <div class="gc-muted gc-fs-14">Chargement de la carte…</div>
        </div>
      `;
      gcSetActions(panel, { 'indices-close': () => closeIndicesMap() }, { reset: true });

      const [svgText, tipCounts, infoCounts] = await Promise.all([
        getWorldMapSvgMarkup(),
        GeoCompanion.tips.getAllTipCounts(),
        GeoCompanion.countryInfo.getAllCountryInfoCounts(),
      ]);

      const body = document.getElementById('geo-companion-indices-map-body');
      if (!body) return; // le panneau a été refermé pendant le chargement

      if (!svgText) {
        body.innerHTML = `<div class="gc-muted gc-fs-14">Impossible de charger la carte. Réessaie plus tard.</div>`;
        return;
      }

      // Total "indices" par pays = tips + champs pays renseignés, pour une vision complète de ce qui est déjà documenté.
      const totals = {};
      Object.keys(tipCounts).forEach((code) => {
        totals[code] = (totals[code] || 0) + tipCounts[code];
      });
      Object.keys(infoCounts).forEach((code) => {
        totals[code] = (totals[code] || 0) + infoCounts[code];
      });
      const maxCount = Object.values(totals).reduce((max, n) => Math.max(max, n), 0);

      body.innerHTML = `
        <div class="gc-indices-legend gc-shrink-0">
          <span class="gc-fs-13 gc-opacity-8">Moins d'indices</span>
          <span class="gc-indices-legend-bar"></span>
          <span class="gc-fs-13 gc-opacity-8">Plus d'indices</span>
        </div>
        <div class="gc-indices-map-wrap">${svgText}</div>
      `;

      const svgEl = body.querySelector('svg');
      if (!svgEl) {
        body.innerHTML = `<div class="gc-muted gc-fs-14">Carte invalide.</div>`;
        return;
      }
      svgEl.classList.add('gc-indices-map-svg');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      // Le SVG source peut embarquer son propre style (ex: pointer-events:none par défaut pour un effet de survol) —
      // on force explicitement l'interactivité pour ne pas en dépendre.
      svgEl.style.pointerEvents = 'auto';

      // Zoom/déplacement retirés (v3.12) : la gestion de la capture de pointeur nécessaire pour distinguer un
      // glissement d'un simple clic interférait avec le clic sur les pays. Carte statique et cliquable directement.

      // La tooltip doit être un enfant direct de <body>, PAS du panneau : .gc-indices-map-panel a un transform (pour se
      // centrer), et un transform sur un ancêtre change le repère de tout position:fixed à l'intérieur (il devient relatif
      // au panneau transformé plutôt qu'à l'écran) — d'où le décalage par rapport à la souris.
      let tooltip = document.getElementById('geo-companion-indices-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'geo-companion-indices-tooltip';
        tooltip.className = 'gc-indices-tooltip gc-collapsed';
        document.body.appendChild(tooltip);
      }
      tooltip.classList.add('gc-collapsed');

      // Fond neutre par défaut sur TOUS les tracés (y compris ceux qu'on ne reconnaît pas par la suite) — évite qu'un pays
      // reste avec le noir par défaut du SVG source si son id ne matche pas le regroupement par code ci-dessous.
      svgEl.querySelectorAll('path').forEach((path) => {
        path.style.fill = 'rgba(255, 255, 255, 0.05)';
        path.style.stroke = 'rgba(255, 255, 255, 0.12)';
        path.style.strokeWidth = '0.5';
      });

      // Pays pour lesquels on ne garde que le morceau "mainland" — masque les petites îles/territoires d'outre-mer
      // (dur à voir/cliquer sur une carte compacte) pour alléger visuellement la carte.
      const MAINLAND_ONLY_CODES = new Set(['FR', 'ES', 'PT']);

      // Regroupe tous les tracés par code pays. L'id peut être posé directement sur un <path>, OU sur un <g> englobant
      // plusieurs <path> (cas fréquent pour les pays multi-fragments : îles, archipels, territoires d'outre-mer).
      const pathsByCode = {};
      svgEl.querySelectorAll('[id]').forEach((el) => {
        const code = el.id.toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return; // ignore les entrées sans code ISO à 2 lettres (ex: territoires non reconnus)
        const targetPaths = el.tagName.toLowerCase() === 'path' ? [el] : Array.from(el.querySelectorAll('path'));
        if (targetPaths.length === 0) return;

        let keptPaths = targetPaths;
        if (MAINLAND_ONLY_CODES.has(code)) {
          const mainland = targetPaths.filter((p) => p.classList.contains('mainland'));
          if (mainland.length > 0) {
            targetPaths.forEach((p) => {
              if (!mainland.includes(p)) p.style.display = 'none'; // masque les fragments d'outre-mer
            });
            keptPaths = mainland;
          }
        }

        if (!pathsByCode[code]) pathsByCode[code] = [];
        pathsByCode[code].push(...keptPaths);
      });

      const missingCovered = [...STREETVIEW_COVERED_COUNTRIES].filter((code) => !pathsByCode[code]);
      console.log(
        `[GeoCompanion] Carte indices : ${Object.keys(pathsByCode).length} pays détectés dans le SVG, ${
          Object.keys(totals).length
        } avec au moins un indice (max ${maxCount}).`
      );
      if (missingCovered.length) {
        console.warn(
          `[GeoCompanion] Carte indices : ${missingCovered.length} pays couverts par GeoGuessr sans tracé trouvé dans le SVG :`,
          missingCovered.join(', ')
        );
      }

      Object.entries(pathsByCode).forEach(([code, paths]) => {
        // Pays multi-fragments : on masque uniquement les PETITS fragments (typiquement des îles/archipels : Corse,
        // Canaries, Açores...) largement plus petits que le plus grand morceau du pays, pour désencombrer la carte —
        // les grands territoires disjoints (Alaska, Guyane...) restent visibles même s'ils ne sont pas géographiquement
        // "attachés" au reste du pays. Basé sur la taille réelle (bounding box), pas sur un classement approximatif.
        let visiblePaths = paths;
        if (paths.length > 1) {
          const areas = paths.map((p) => {
            try {
              const bbox = p.getBBox();
              return bbox.width * bbox.height;
            } catch (e) {
              return 0;
            }
          });
          const maxArea = Math.max(...areas);
          if (maxArea > 0) {
            const kept = [];
            paths.forEach((p, i) => {
              if (areas[i] < maxArea * 0.1) {
                p.style.display = 'none';
              } else {
                kept.push(p);
              }
            });
            visiblePaths = kept;
          }
        }

        const covered = STREETVIEW_COVERED_COUNTRIES.has(code);
        const count = totals[code] || 0;
        // Pays non couvert par Street View (n'apparaît jamais en partie) : rendu volontairement sombre et non cliquable,
        // distinct du gris neutre par défaut ci-dessus pour qu'on comprenne que c'est intentionnel et pas un bug d'affichage.
        const color = covered
          ? indicesIntensityColor(count, maxCount)
          : { fill: 'rgba(0, 0, 0, 0.55)', stroke: 'rgba(255, 255, 255, 0.08)' };

        visiblePaths.forEach((path) => {
          path.style.fill = color.fill;
          path.style.stroke = color.stroke;
          path.style.strokeWidth = '0.5';
          path.style.cursor = covered ? 'pointer' : 'default';
          path.style.pointerEvents = 'auto';
          path.style.transition = 'filter 0.15s ease';

          // Pas de popup ni de survol pour les pays qui n'apparaissent jamais en partie — seuls les pays jouables
          // (avec 0 indice ou plus) doivent réagir à la souris.
          if (!covered) return;

          path.addEventListener('mouseenter', (e) => {
            // Position immédiate au survol (pas seulement au premier mousemove), sinon la popup apparaît d'abord dans un coin.
            tooltip.style.left = `${e.clientX + 14}px`;
            tooltip.style.top = `${e.clientY + 14}px`;
            path.style.filter = 'brightness(1.35)';
            tooltip.classList.remove('gc-collapsed');
            tooltip.innerHTML = `${flagImgFromCode(code, { height: '1.1em' })} <b>${escapeHtml(
              countryNameFromCode(code)
            )}</b> — ${count} indice${count > 1 ? 's' : ''}`;
          });
          path.addEventListener('mousemove', (e) => {
            tooltip.style.left = `${e.clientX + 14}px`;
            tooltip.style.top = `${e.clientY + 14}px`;
          });
          path.addEventListener('mouseleave', () => {
            path.style.filter = '';
            tooltip.classList.add('gc-collapsed');
          });
          // Le early-return ci-dessus garantit qu'on n'arrive ici que pour les pays couverts.
          path.addEventListener('click', () => openIndicesDetail(code));
        });
      });
    }

    // Filet de sécurité : referme la carte des indices si on quitte l'accueil ou si une partie démarre, pour ne pas la laisser flotter ailleurs.
    GeoCompanion.on('gameStart', closeIndicesMap);

    // Vérification initiale (script chargé directement sur l'accueil, ou en cours de partie après un refresh).
    checkHomepage();
  })();

  console.log('[GeoCompanion] Script chargé, en attente d\'events GeoGuessr...');
})();