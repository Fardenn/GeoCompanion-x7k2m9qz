// ==UserScript==
// @name         GeoGuessr Companion
// @namespace    geoguessr-companion
// @version      2.42
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
      .gc-btn--indices-open { width: 100%; }
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
        cursor: grab;
        touch-action: none;
      }
      .gc-indices-map-wrap--dragging { cursor: grabbing; }
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
      /* Vue "grande" du panneau tips, utilisée quand il est ouvert depuis la carte des indices plutôt qu'en fin de round. */
      .gc-tips-panel--big {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(90vw, 900px);
        max-height: 88vh;
        font-size: 21px;
        z-index: 9999999;
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
        } catch (e) {
          /* ignore */
        }
      });
      return originalSend.apply(this, args);
    };

    // --- Hook WebSocket (live challenge + duel) : GeoGuessr y pousse les vrais events de round/partie ---
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

          if (data.code === 'LiveChallengeRoundStarting') {
            GeoCompanion.emit('roundStart', {
              ...(data.liveChallenge?.state || lastGoodGameSnapshot || {}),
              _source: 'ws-round-starting',
            });
          } else if (data.code === 'LiveChallengeRoundEnded') {
            const state = data.liveChallenge?.state;
            // currentRoundNumber est présent directement sur ce message (confirmé par capture réseau réelle) — plus fiable que le compteur local.
            const endedRound = state?.currentRoundNumber ?? liveChallengeRound ?? currentRound ?? 1;
            if (roundEndEmittedRound !== endedRound) {
              // state a toujours guesses:null (confirmé par capture réseau) — le guess de ce joueur est ailleurs (LeaderboardUpdate).
              const game = state
                ? { ...(lastGoodGameSnapshot || {}), ...state, guesses: state.guesses ?? lastGoodGameSnapshot?.guesses ?? null }
                : lastGoodGameSnapshot;
              if (game) {
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
              }
            }
          } else if (data.code === 'FinishChallengeFinished') {
            // Le vrai code est "FinishChallengeFinished", pas "LiveChallengeFinished" (confirmé par capture réseau réelle).
            if (gameState !== 'finished') {
              gameState = 'finished';
              persistState();
              GeoCompanion.emit('gameEnd', data.liveChallenge?.state || lastGoodGameSnapshot || {});
            }
          } else if (data.code === 'DuelStarted' || data.code === 'DuelNewRound') {
            // DuelStarted = premier round, DuelNewRound = suivants ; délai de 3s (demande explicite) pour laisser lire les panneaux du round précédent.
            const duelStateSnapshot = data.duel?.state || lastGoodGameSnapshot || {};
            const source = data.code === 'DuelStarted' ? 'ws-duel-started' : 'ws-duel-new-round';
            setTimeout(() => {
              GeoCompanion.emit('roundStart', { ...duelStateSnapshot, _source: source });
            }, 3000);
          } else if (data.code === 'DuelRoundTimedOut') {
            // Pays sur rounds[].panorama.countryCode (pas panoramaQuestionPayload comme en live challenge, confirmé par capture réseau) ; score/guess par équipe non géré, seul le pays nous intéresse en duel (demande explicite).
            const duelState = data.duel?.state;
            const endedRound = duelState?.currentRoundNumber ?? duelState?.round ?? liveChallengeRound ?? currentRound ?? 1;
            if (roundEndEmittedRound !== endedRound) {
              const game = duelState
                ? { ...(lastGoodGameSnapshot || {}), ...duelState, guesses: duelState.guesses ?? lastGoodGameSnapshot?.guesses ?? null }
                : lastGoodGameSnapshot;
              if (game) {
                roundEndEmittedRound = endedRound;
                liveChallengeRound = endedRound;
                persistState();
                lastEmittedRoundGameByRound[endedRound] = game;
                GeoCompanion.emit('roundEnd', {
                  ...game,
                  round: endedRound,
                  _source: duelState ? 'ws-duel-round-timedout' : 'ws-duel-round-timedout-http-fallback',
                });
              }
            }
          } else if (data.code === 'DuelFinished') {
            // Contrairement au live challenge (gameEnd trop précoce pour masquer, voir plus bas), DuelFinished masque directement les panneaux (demande explicite).
            if (gameState !== 'finished') {
              gameState = 'finished';
              persistState();
              GeoCompanion.emit('gameEnd', data.duel?.state || lastGoodGameSnapshot || {});
            }
            if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
          } else if (data.code === 'LiveChallengeLeaderboardUpdate') {
            // Repli pour garder liveChallengeRound à jour entre deux RoundEnded (utile si un message venait à être manqué).
            const roundNumber = data.liveChallenge?.leaderboards?.roundGuessTime?.roundNumber;
            if (typeof roundNumber === 'number' && roundNumber !== liveChallengeRound) {
              liveChallengeRound = roundNumber;
              persistState();
            }

            // Notre guess pour ce round : liveChallenge.leaderboards.round.entries[i] et .guesses[i] se correspondent par index.
            const roundLeaderboard = data.liveChallenge?.leaderboards?.round;
            if (
              roundLeaderboard &&
              typeof roundLeaderboard.roundNumber === 'number' &&
              Array.isArray(roundLeaderboard.entries) &&
              Array.isArray(roundLeaderboard.guesses)
            ) {
              const myName = GeoCompanion.getPlayerName?.();
              if (myName) {
                const myIndex = roundLeaderboard.entries.findIndex((e) => e && e.name === myName);
                const myGuess = myIndex !== -1 ? roundLeaderboard.guesses[myIndex] : null;
                const myEntry = myIndex !== -1 ? roundLeaderboard.entries[myIndex] : null;
                if (myGuess) {
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
                }
              }
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
  (function identityModule() {
    const STORAGE_KEY = 'geoCompanion_playerName';
    let cachedName = GM_getValue(STORAGE_KEY, null);
    let observer = null;

    // Sélecteur best-effort sur le header GeoGuessr (span class="nick_nick__XXXXX") — le suffixe hashé peut changer avec leurs déploiements.
    function detectPlayerNameFromDom() {
      const el = document.querySelector('[class*="nick_nick__"]');
      const name = el?.textContent?.trim();
      return name || null;
    }

    function setPlayerName(name) {
      if (!name || name === cachedName) return;
      cachedName = name;
      GM_setValue(STORAGE_KEY, name);
      console.log('[GeoCompanion] 👤 Joueur identifié :', name);
      if (observer) {
        observer.disconnect(); // plus besoin de surveiller une fois trouvé
        observer = null;
      }
    }

    function tryDetect() {
      const name = detectPlayerNameFromDom();
      if (name) setPlayerName(name);
    }

    function askPlayerNameManually() {
      if (cachedName) return; // déjà trouvé entre-temps
      const answer = prompt(
        "GeoGuessr Companion n'a pas réussi à détecter ton pseudo automatiquement — peux-tu le saisir ?"
      );
      if (answer && answer.trim()) {
        setPlayerName(answer.trim());
      }
    }

    // @run-at document-start : document.body peut ne pas encore exister — on diffère l'init si besoin.
    function initDetection() {
      // Tentative immédiate, puis surveillance du DOM (le header peut apparaître après coup).
      tryDetect();
      if (!cachedName) {
        observer = new MutationObserver(() => tryDetect());
        observer.observe(document.body, { childList: true, subtree: true });

        // Si rien après quelques secondes, on demande manuellement plutôt que de rester bloqué indéfiniment sans pseudo.
        setTimeout(() => {
          if (observer) {
            observer.disconnect();
            observer = null;
          }
          askPlayerNameManually();
        }, 8000);
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

  // CORE: reverseGeocode
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

    function extractRoundData(game) {
      // Round toujours déjà présent ici : injecté explicitement par le hook WS pour le live challenge, natif pour les autres modes.
      const round = game.round ?? game.roundNumber ?? game.currentRoundNumber;

      // Les infos du lieu réel du round sont généralement dans un tableau "rounds" indexé par (round - 1).
      const roundsInfo = game.rounds || [];
      const roundInfo = roundsInfo[round - 1] || {};

      const guesses = game.player?.guesses || game.guesses || [];
      const guess = guesses[guesses.length - 1] || {};

      // Live challenge : coordonnées dans answer.coordinateAnswerPayload.coordinate ; duel : directement sur rounds[].panorama (confirmé par capture réseau).
      const actualLat =
        roundInfo.lat ??
        roundInfo.location?.lat ??
        roundInfo.answer?.coordinateAnswerPayload?.coordinate?.lat ??
        roundInfo.question?.panoramaQuestionPayload?.panorama?.lat ??
        roundInfo.panorama?.lat;
      const actualLng =
        roundInfo.lng ??
        roundInfo.location?.lng ??
        roundInfo.answer?.coordinateAnswerPayload?.coordinate?.lng ??
        roundInfo.question?.panoramaQuestionPayload?.panorama?.lng ??
        roundInfo.panorama?.lng;
      const guessLat = guess.lat ?? guess.position?.lat;
      const guessLng = guess.lng ?? guess.position?.lng;
      // Pas de code pays direct en live challenge (juste des coordonnées) — résolu par reverse-geocoding dans le handler roundEnd si besoin.
      const actualCountryRaw =
        roundInfo.streakLocationCode ??
        roundInfo.countryCode ??
        roundInfo.question?.panoramaQuestionPayload?.panorama?.countryCode ??
        roundInfo.panorama?.countryCode ??
        null;
      // Confirmé par capture réseau réelle : ce champ arrive en minuscule en live challenge ("gh", "br"...), d'où l'uppercase forcé.
      const actualCountry = actualCountryRaw ? actualCountryRaw.toUpperCase() : null;


      // Live challenge : score/distance sont des valeurs directes sur le guess (guess.score, guess.distance), pas imbriquées comme en classique.
      const score =
        guess.roundScoreInPoints ?? guess.score?.amount ?? (typeof guess.score === 'number' ? guess.score : null);
      const distanceMeters = guess.distanceInMeters ?? (typeof guess.distance === 'number' ? guess.distance : null);

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
        country_correct: null, // rempli après coup via reverse-geocoding (voir handler roundEnd)
        game_mode: game.mode || game.gameMode || (game.hostId ? 'live-challenge' : game._source?.startsWith('ws-duel') ? 'duel' : null),
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
        const actualCountry = await reverseGeocodeCountry(row.actual_lat, row.actual_lng);
        if (actualCountry) {
          row.country_code = actualCountry;
          row.continent = continentFromCountryCode(actualCountry);
        }
      }

      // Priorité : trouver le pays et afficher tips/stats sans dépendre de la suite (reverse-geocoding du guess, potentiellement plus lent).
      GeoCompanion.emit('roundRecorded', row);

      // Déduction du pays deviné via reverse-geocoding des coordonnées du guess.
      if (row.guess_lat != null && row.guess_lng != null && row.country_code) {
        const guessedCountry = await reverseGeocodeCountry(row.guess_lat, row.guess_lng);
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
        const ok = await supabaseClient.insert('rounds', row);
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
        <button id="geo-companion-toggle-stats-btn" class="gc-btn gc-btn--stats-toggle">📊 Voir les stats</button>
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
            <button data-filter="${f.key}" class="gc-btn gc-btn--flex gc-btn--lg ${
              f.key === activeFilter ? 'gc-btn--jouer' : 'gc-btn--secondary'
            }">${f.label}</button>
          `
          ).join('')}
        </div>
        <div id="geo-companion-stats-body" class="gc-muted">Chargement…</div>
      `;

      container.querySelectorAll('button[data-filter]').forEach((btn) => {
        btn.addEventListener('click', () => renderStats(row, btn.dataset.filter, cache));
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
        <button data-edit-tip="${tip.id}" class="gc-btn gc-btn--edit-tip" title="Modifier">✏️</button>
        <button data-delete-tip="${tip.id}" class="gc-btn gc-btn--delete-tip" title="Supprimer">🗑️</button>
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

    function showTipForm(tipsPanel, row, tip) {
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
            <button id="geo-companion-tip-save" class="gc-btn gc-btn--ok">Enregistrer</button>
            <button id="geo-companion-tip-cancel" class="gc-btn gc-btn--cancel">Annuler</button>
          </div>
        </div>
      `;

      const textEl = formContainer.querySelector('#geo-companion-tip-text');
      const imageEl = formContainer.querySelector('#geo-companion-tip-image');
      // Empêche GeoGuessr de capter les touches tapées ici comme des raccourcis.
      stopKeyPropagation(textEl);
      stopKeyPropagation(imageEl);

      formContainer.querySelector('#geo-companion-tip-cancel').addEventListener('click', () => {
        formContainer.innerHTML = '';
      });

      formContainer.querySelector('#geo-companion-tip-save').addEventListener('click', async () => {
        const content = textEl.value.trim();
        const imageUrl = imageEl.value.trim();
        if (!content && !imageUrl) return; // rien à enregistrer

        if (tip) {
          await GeoCompanion.tips.updateTip(tip.id, { content, imageUrl });
        } else {
          await GeoCompanion.tips.addTip(row.country_code, { content, imageUrl });
        }
        formContainer.innerHTML = '';
        await renderTips(row);
      });
    }

    async function renderTips(row) {
      const tips = await GeoCompanion.tips.listTipsForCountry(row.country_code);
      const tipsPanel = ensureTipsPanel();
      tipsPanel.classList.toggle('gc-panel--duel-offset', row.game_mode === 'duel');

      const plonkitUrl = plonkitUrlFromCode(row.country_code);
      const info = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);

      tipsPanel.innerHTML = `
        <div class="gc-card-header gc-mb-8 gc-shrink-0">
          <div class="gc-title">
            💡 Tips ${
              plonkitUrl
                ? `<a href="${plonkitUrl}" target="_blank" rel="noopener noreferrer" class="gc-link gc-fs-17">🔗 Plonkit</a>`
                : ''
            }
          </div>
          <div class="gc-flex-gap-6">
            <button id="geo-companion-tips-refresh-btn" title="Actualiser les tips" class="gc-btn gc-icon-btn gc-fs-16">🔄</button>
            <button id="geo-companion-tips-collapse-btn" title="Replier/déplier" class="gc-btn gc-icon-btn gc-fs-18">▼</button>
            ${
              row.game_mode === 'indices-view'
                ? `<button id="geo-companion-tips-close-indices-btn" title="Fermer" class="gc-btn gc-icon-btn gc-fs-18">✕</button>`
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
          <button id="geo-companion-add-tip-btn" class="gc-btn gc-add-tip-btn">+ Ajouter un tip</button>
          <div id="geo-companion-tip-form" class="gc-shrink-0"></div>
        </div>
      `;

      renderCountryInfoFields(tipsPanel, row, info);
      renderVoitureField(tipsPanel, row, info);
      renderRouteField(tipsPanel, row, info);

      const collapseBtn = tipsPanel.querySelector('#geo-companion-tips-collapse-btn');
      const tipsBody = tipsPanel.querySelector('#geo-companion-tips-body');
      collapseBtn.addEventListener('click', () => {
        const nowCollapsed = tipsBody.classList.toggle('gc-collapsed');
        collapseBtn.textContent = nowCollapsed ? '▶' : '▼';
      });

      const refreshBtn = tipsPanel.querySelector('#geo-companion-tips-refresh-btn');
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        await renderTips(row);
      });

      const closeIndicesBtn = tipsPanel.querySelector('#geo-companion-tips-close-indices-btn');
      if (closeIndicesBtn) closeIndicesBtn.addEventListener('click', closeIndicesDetail);

      tipsPanel.querySelectorAll('[data-edit-tip]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tip = tips.find((t) => t.id === btn.dataset.editTip);
          showTipForm(tipsPanel, row, tip);
        });
      });

      tipsPanel.querySelectorAll('[data-delete-tip]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Supprimer ce tip ?')) return;
          await GeoCompanion.tips.deleteTip(btn.dataset.deleteTip);
          await renderTips(row);
        });
      });

      const addBtn = tipsPanel.querySelector('#geo-companion-add-tip-btn');
      if (addBtn) addBtn.addEventListener('click', () => showTipForm(tipsPanel, row, null));
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
              <button data-toggle-no-clue-route class="gc-btn gc-btn--toggle-no-clue ${
                noClue ? 'gc-btn--toggle-no-clue--active' : ''
              }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
              <button data-edit-route class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
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

      container.querySelector('[data-toggle-no-clue-route]').addEventListener('click', async () => {
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
      });

      container.querySelector('[data-edit-route]').addEventListener('click', () => {
        const formEl = container.querySelector('[data-route-form]');
        formEl.innerHTML = `
          <input type="text" data-route-text value="${escapeHtml(
            noClue ? '' : info.route_text || ''
          )}" placeholder="Texte (marquage, bornes...)" class="gc-input gc-input--compact">
          <input type="text" data-route-image value="${escapeHtml(
            info.route_image_url || ''
          )}" placeholder="URL de l'image (optionnel)" class="gc-input gc-input--compact">
          <div class="gc-btn-row gc-mt-6">
            <button data-route-side="left" class="gc-btn gc-btn--flex gc-driving-btn ${
              info.driving_side === 'left' ? 'gc-driving-btn--active' : ''
            }">⬅️ Gauche</button>
            <button data-route-side="right" class="gc-btn gc-btn--flex gc-driving-btn ${
              info.driving_side === 'right' ? 'gc-driving-btn--active' : ''
            }">➡️ Droite</button>
          </div>
          <div class="gc-btn-row gc-mt-6">
            <button data-save-route class="gc-btn gc-btn--ok">OK</button>
            <button data-cancel-route class="gc-btn gc-btn--cancel">Annuler</button>
          </div>
        `;

        let selectedSide = info.driving_side || null;
        const textEl = formEl.querySelector('[data-route-text]');
        const imageEl = formEl.querySelector('[data-route-image]');
        stopKeyPropagation(textEl);
        stopKeyPropagation(imageEl);

        formEl.querySelectorAll('[data-route-side]').forEach((btn) => {
          btn.addEventListener('click', () => {
            selectedSide = btn.dataset.routeSide;
            formEl.querySelectorAll('[data-route-side]').forEach((b) => {
              b.classList.toggle('gc-driving-btn--active', b.dataset.routeSide === selectedSide);
            });
          });
        });

        formEl.querySelector('[data-cancel-route]').addEventListener('click', () => {
          formEl.innerHTML = '';
        });

        formEl.querySelector('[data-save-route]').addEventListener('click', async () => {
          await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
            route_text: textEl.value.trim() || null,
            route_image_url: imageEl.value.trim() || null,
            driving_side: selectedSide,
          });
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderRouteField(tipsPanel, row, updated);
        });
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
                  <button data-toggle-no-clue="${f.key}" class="gc-btn gc-btn--toggle-no-clue ${
              noClue ? 'gc-btn--toggle-no-clue--active' : ''
            }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
                  <button data-edit-field="${f.key}" class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
                </div>
              </div>
              <div data-field-display="${f.key}" class="gc-mt-2">${countryInfoFieldDisplay(f, info[f.key])}</div>
              <div data-field-form="${f.key}"></div>
            </div>
          `;
          }).join('')}
        </div>
      `;

      container.querySelectorAll('[data-toggle-no-clue]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.toggleNoClue;
          const newValue = isNoClue(info[key]) ? null : NO_CLUE_MARKER;
          await GeoCompanion.countryInfo.setCountryInfoField(row.country_code, key, newValue);
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderCountryInfoFields(tipsPanel, row, updated);
        });
      });

      container.querySelectorAll('[data-edit-field]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.editField;
          const fieldConfig = COUNTRY_INFO_FIELDS.find((f) => f.key === key);
          const formEl = container.querySelector(`[data-field-form="${key}"]`);
          const currentValue = isNoClue(info[key]) ? '' : info[key] || '';
          const isMultiUrl = fieldConfig.type === 'images'; // liste d'URLs (une par ligne, nettoyées)
          const isFreeText = fieldConfig.type === 'multitext'; // texte libre multi-lignes (ex: langue)
          const isTextarea = isMultiUrl || isFreeText;

          const actionsHtml = `
            <div class="gc-btn-row gc-mt-4">
              <button data-save-field class="gc-btn gc-btn--ok">OK</button>
              <button data-cancel-field class="gc-btn gc-btn--cancel">Annuler</button>
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

          const inputEl = formEl.querySelector(isTextarea ? 'textarea' : 'input');
          stopKeyPropagation(inputEl);

          formEl.querySelector('[data-cancel-field]').addEventListener('click', () => {
            formEl.innerHTML = '';
          });

          formEl.querySelector('[data-save-field]').addEventListener('click', async () => {
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
          });
        });
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
              <button data-toggle-no-clue-voiture class="gc-btn gc-btn--toggle-no-clue ${
                noClue ? 'gc-btn--toggle-no-clue--active' : ''
              }" title="${noClue ? 'Annuler : pas d’indice' : 'Marquer : pas d’indice dans cette catégorie'}">🚫</button>
              <button data-edit-voiture class="gc-btn gc-icon-btn" title="Modifier">✏️</button>
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

      container.querySelector('[data-toggle-no-clue-voiture]').addEventListener('click', async () => {
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
      });

      container.querySelector('[data-edit-voiture]').addEventListener('click', () => {
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
            <button data-save-voiture class="gc-btn gc-btn--ok">OK</button>
            <button data-cancel-voiture class="gc-btn gc-btn--cancel">Annuler</button>
          </div>
        `;

        const textEl = formEl.querySelector('[data-voiture-text]');
        const imageEl = formEl.querySelector('[data-voiture-image]');
        stopKeyPropagation(textEl);
        stopKeyPropagation(imageEl);

        formEl.querySelector('[data-cancel-voiture]').addEventListener('click', () => {
          formEl.innerHTML = '';
        });

        formEl.querySelector('[data-save-voiture]').addEventListener('click', async () => {
          const exclusiveEl = formEl.querySelector('[data-voiture-exclusive]');
          await GeoCompanion.countryInfo.setCountryInfoFields(row.country_code, {
            voiture_text: textEl.value.trim() || null,
            voiture_image_url: imageEl.value.trim() || null,
            voiture_exclusive: exclusiveEl.checked,
          });
          const updated = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);
          renderVoitureField(tipsPanel, row, updated);
        });
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
      const toggleBtn = document.getElementById('geo-companion-toggle-stats-btn');
      const statsSection = document.getElementById('geo-companion-stats-section');
      if (toggleBtn && statsSection) {
        let loaded = false;
        toggleBtn.addEventListener('click', async () => {
          const isHidden = statsSection.classList.contains('gc-collapsed');
          if (isHidden) {
            statsSection.classList.remove('gc-collapsed');
            toggleBtn.textContent = '📊 Masquer les stats';
            if (!loaded) {
              loaded = true;
              await renderStats(row, 'all', statsCache);
            }
          } else {
            statsSection.classList.add('gc-collapsed');
            toggleBtn.textContent = '📊 Voir les stats';
          }
        });
      }
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
          <button id="geo-companion-dashboard-refresh-btn" class="gc-btn gc-btn--jouer gc-btn--refresh-dash">🔄 Actualiser</button>
        </div>
      `;

      const refreshBtn = listEl.querySelector('#geo-companion-dashboard-refresh-btn');
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳';
        await loadDashboardFilterData(playerName);
      });
    }

    function renderDashboard() {
      const panel = ensureDashboard();
      const playerName = GeoCompanion.getPlayerName();

      panel.innerHTML = `
        <div class="gc-card-header gc-mb-6 gc-shrink-0">
          <div class="gc-title gc-fs-16">Mes stats</div>
          <div class="gc-flex-gap-6">
            <button id="geo-companion-dashboard-delete-btn" title="Supprimer mes rounds de la période sélectionnée" class="gc-btn gc-btn--delete-dash">🗑️</button>
            <button id="geo-companion-dashboard-collapse-btn" title="Replier/déplier" class="gc-btn gc-btn--collapse-dash">${
              dashboardCollapsed ? '▶' : '▼'
            }</button>
          </div>
        </div>
        <div id="geo-companion-dashboard-body" class="gc-flex-col-fill ${dashboardCollapsed ? 'gc-collapsed' : ''}">
          <hr class="gc-hr gc-hr--dashed gc-hr-tight">
          <button id="geo-companion-indices-open-btn" class="gc-btn gc-btn--secondary gc-btn--indices-open gc-mb-8">💡 Voir la carte des indices</button>
          <div class="gc-btn-row gc-mb-8 gc-shrink-0">
            ${FILTERS.map(
              (f) => `
              <button data-dash-filter="${f.key}" class="gc-btn gc-btn--flex gc-btn--xs ${
                f.key === dashboardActiveFilter ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }">${f.label}</button>
            `
            ).join('')}
          </div>
          <div class="gc-btn-row gc-btn-row--wrap gc-mb-10 gc-shrink-0">
            ${CONTINENT_ORDER.map(
              (c) => `
              <button data-dash-continent="${c}" class="gc-btn gc-btn--flex-auto gc-btn--xs gc-continent-btn ${
                c === dashboardActiveContinent ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }">${CONTINENT_LABELS[c]}</button>
            `
            ).join('')}
          </div>
          <div id="geo-companion-dashboard-list" class="gc-scroll-fill"></div>
        </div>
      `;

      const indicesOpenBtn = panel.querySelector('#geo-companion-indices-open-btn');
      if (indicesOpenBtn) indicesOpenBtn.addEventListener('click', () => openIndicesMap());

      const collapseBtn = panel.querySelector('#geo-companion-dashboard-collapse-btn');
      const dashboardBody = panel.querySelector('#geo-companion-dashboard-body');
      collapseBtn.addEventListener('click', () => {
        dashboardCollapsed = !dashboardCollapsed;
        dashboardBody.classList.toggle('gc-collapsed', dashboardCollapsed);
        collapseBtn.textContent = dashboardCollapsed ? '▶' : '▼';
      });

      const deleteBtn = panel.querySelector('#geo-companion-dashboard-delete-btn');
      deleteBtn.addEventListener('click', async () => {
        const filterMeta = FILTERS.find((f) => f.key === dashboardActiveFilter);
        const periodLabel =
          dashboardActiveFilter === 'all' ? 'TOUT ton historique de rounds' : `tes rounds des dernières ${filterMeta.label}`;

        const confirmed = confirm(
          `Supprimer ${periodLabel} ? Cette action est irréversible.`
        );
        if (!confirmed) return;

        deleteBtn.disabled = true;
        deleteBtn.textContent = '⏳';

        const ok = await GeoCompanion.stats.deleteRoundsForPlayer(playerName, dashboardActiveFilter);
        if (ok) {
          console.log('[GeoCompanion] 🗑️ Rounds supprimés pour la période :', dashboardActiveFilter);
          dashboardStatsCache.clear();
          renderDashboardEmptyState(playerName); // la donnée vient de changer, on ne réaffiche pas l'ancien cache
          deleteBtn.disabled = false;
          deleteBtn.textContent = '🗑️';
        } else {
          GeoCompanion.notify('Erreur lors de la suppression des rounds', 'error');
          deleteBtn.disabled = false;
          deleteBtn.textContent = '🗑️';
        }
      });

      panel.querySelectorAll('[data-dash-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          dashboardActiveFilter = btn.dataset.dashFilter;
          renderDashboard();
          // Un clic sur un filtre est une demande explicite pour cette période : on charge depuis le cache s'il existe, sinon en réseau.
          loadDashboardFilterData(playerName);
        });
      });
      panel.querySelectorAll('[data-dash-continent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const clicked = btn.dataset.dashContinent;
          // Un clic sur le continent déjà actif le désélectionne (affiche tous les pays, tous continents confondus).
          dashboardActiveContinent = dashboardActiveContinent === clicked ? null : clicked;
          renderDashboard();
        });
      });

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

    function checkHomepage() {
      const nowInGameplayUrl = isGameplayUrl(pageWindow.location.pathname);
      if (isHomepage()) {
        renderDashboard();
        // Filet de sécurité : en live challenge, la fin de partie/round n'est pas toujours détectée de façon fiable (voir apiDetectionModule).
        if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
      } else {
        removeDashboard();
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
      }
      return panel;
    }

    function closeIndicesDetail() {
      const tipsPanel = document.getElementById(TIPS_PANEL_ID);
      if (tipsPanel && tipsPanel.classList.contains('gc-tips-panel--big')) {
        tipsPanel.remove();
      }
    }

    function closeIndicesMap() {
      const backdrop = document.getElementById('geo-companion-indices-backdrop');
      if (backdrop) backdrop.remove();
      const panel = document.getElementById(INDICES_MAP_ID);
      if (panel) panel.remove();
      const tooltip = document.getElementById('geo-companion-indices-tooltip');
      if (tooltip) tooltip.remove();
      closeIndicesDetail();
    }

    async function openIndicesDetail(code) {
      const row = { country_code: code, game_mode: 'indices-view' };
      await renderTips(row);
      const tipsPanel = document.getElementById(TIPS_PANEL_ID);
      if (tipsPanel) {
        tipsPanel.classList.add('gc-tips-panel--big');
        tipsPanel.classList.remove('gc-panel--duel-offset');
      }
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
      panel.innerHTML = `
        <div class="gc-card-header gc-mb-8 gc-shrink-0">
          <div class="gc-title gc-fs-18">💡 Indices par pays</div>
          <div class="gc-flex-gap-6">
            <button id="geo-companion-indices-zoom-reset-btn" class="gc-btn gc-icon-btn gc-fs-16" title="Réinitialiser le zoom">🔎</button>
            <button id="geo-companion-indices-close-btn" class="gc-btn gc-icon-btn gc-fs-18" title="Fermer">✕</button>
          </div>
        </div>
        <div id="geo-companion-indices-map-body" class="gc-flex-col-fill gc-scroll-fill">
          <div class="gc-muted gc-fs-14">Chargement de la carte…</div>
        </div>
      `;
      panel.querySelector('#geo-companion-indices-close-btn').addEventListener('click', closeIndicesMap);

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

      // ZOOM / DÉPLACEMENT : molette pour zoomer (centré sur le curseur), glisser pour se déplacer une fois zoomé —
      // utile pour sélectionner précisément les petites îles/archipels. État remis à zéro à chaque ouverture de la carte.
      const wrap = body.querySelector('.gc-indices-map-wrap');
      let indicesZoom = 1;
      let indicesPanX = 0;
      let indicesPanY = 0;
      const INDICES_ZOOM_MIN = 1;
      const INDICES_ZOOM_MAX = 10;

      function applyIndicesTransform() {
        svgEl.style.transform = `translate(${indicesPanX}px, ${indicesPanY}px) scale(${indicesZoom})`;
      }
      svgEl.style.transformOrigin = '0 0';
      applyIndicesTransform();

      wrap.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const rect = wrap.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const zoomFactor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
          const newZoom = Math.min(INDICES_ZOOM_MAX, Math.max(INDICES_ZOOM_MIN, indicesZoom * zoomFactor));
          if (newZoom === indicesZoom) return;
          // Garde le point sous le curseur fixe pendant le zoom, plutôt que de zoomer depuis le coin.
          indicesPanX = mouseX - ((mouseX - indicesPanX) / indicesZoom) * newZoom;
          indicesPanY = mouseY - ((mouseY - indicesPanY) / indicesZoom) * newZoom;
          indicesZoom = newZoom;
          applyIndicesTransform();
        },
        { passive: false }
      );

      let isDragging = false;
      let didDrag = false; // distingue un vrai clic pays d'un léger glisser, pour ne pas ouvrir un pays par erreur
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartPanX = 0;
      let dragStartPanY = 0;

      wrap.addEventListener('pointerdown', (e) => {
        isDragging = true;
        didDrag = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartPanX = indicesPanX;
        dragStartPanY = indicesPanY;
        wrap.classList.add('gc-indices-map-wrap--dragging');
        wrap.setPointerCapture(e.pointerId);
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
        indicesPanX = dragStartPanX + dx;
        indicesPanY = dragStartPanY + dy;
        applyIndicesTransform();
      });
      const endDrag = () => {
        isDragging = false;
        wrap.classList.remove('gc-indices-map-wrap--dragging');
      };
      wrap.addEventListener('pointerup', endDrag);
      wrap.addEventListener('pointercancel', endDrag);

      // Capturé AVANT le clic sur le <path> lui-même (phase de capture) : si on vient de glisser, on annule le clic pays.
      svgEl.addEventListener(
        'click',
        (e) => {
          if (didDrag) {
            e.stopPropagation();
            e.preventDefault();
            didDrag = false;
          }
        },
        { capture: true }
      );

      const zoomResetBtn = panel.querySelector('#geo-companion-indices-zoom-reset-btn');
      if (zoomResetBtn) {
        zoomResetBtn.addEventListener('click', () => {
          indicesZoom = 1;
          indicesPanX = 0;
          indicesPanY = 0;
          applyIndicesTransform();
        });
      }

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