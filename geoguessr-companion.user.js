// ==UserScript==
// @name         GeoGuessr Companion
// @namespace    geoguessr-companion
// @version      1.32
// @description  Compagnon d'entraînement GeoGuessr : détection d'events, historique, tips, stats
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

  // ============================================================
  // CONFIG
  // ============================================================
  const SUPABASE_URL = 'https://lpbtzcpmqqsaedpdhptl.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_gH_ae7VUiLAEpuLdRBTlBA_71XF4K44';

  // Accès au vrai contexte de la page : dès qu'un @grant autre que "none" est
  // utilisé, Tampermonkey exécute le script dans un sandbox où "window" ne
  // pointe plus vers la page réelle. unsafeWindow le fait.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ============================================================
  // CORE: namespace global + event bus
  // ------------------------------------------------------------
  // Chaque module s'abonne aux events qui l'intéressent via
  // GeoCompanion.on(nom, callback). Le core ne fait qu'émettre,
  // il ne connaît pas les modules qui l'écoutent.
  // ============================================================
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

  // Events disponibles : 'gameStart', 'gameEnd', 'roundStart', 'roundEnd'
  // Payload : l'objet "game" tel que renvoyé par l'API GeoGuessr

  // ============================================================
  // CORE: thème (variables CSS injectées, alignées sur le vrai
  // thème GeoGuessr)
  // ------------------------------------------------------------
  // Les couleurs/rayons/etc. sont des alias vers les vraies variables
  // CSS de GeoGuessr (--ds-color-*, --surface-radius-*...), avec repli
  // sur les valeurs exactes relevées manuellement dans leur CSS si ces
  // variables ne sont pas exposées (ex: var(--ds-color-brand-50, #7950e5)).
  // La résolution se fait nativement par le navigateur via CSS, pas
  // besoin de scanner nous-mêmes leurs feuilles de style pour ça.
  // Centralise tout en un seul endroit — un seul thème à ajuster au
  // lieu de chercher/remplacer des codes hex dans tout le fichier.
  // ============================================================
  function injectThemeStyles() {
    if (document.getElementById('geo-companion-theme')) return; // déjà injecté

    // Police réellement utilisée par GeoGuessr sur cette page (fonctionne
    // même si leur police maison "Geoguessr Sans" n'est pas publiquement
    // accessible — on hérite simplement de la valeur déjà chargée par eux).
    // Sert de repli si var(--default-font) n'est pas trouvable.
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
        /* Alias vers leur design system quand disponible (--ds-color-*),
           avec repli sur les valeurs exactes qu'on leur a vues (relevées
           manuellement dans leur CSS) si ces variables ne sont pas trouvées. */
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
        /* var(--default-font) = variable réelle de GeoGuessr (héritée en live,
           toujours synchronisée) ; repli sur la police détectée au chargement,
           puis repli générique si rien n'est trouvable du tout. */
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
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        line-height: 1.4;
        box-sizing: border-box;
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
      }
      .gc-btn:disabled { opacity: 0.6; cursor: default; }
      .gc-btn--block { width: 100%; }
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
      .gc-btn--danger { background: var(--gc-danger-bg); color: var(--gc-danger); }
      .gc-btn--icon { background: none; padding: 2px 4px; font-size: 15px; }
      .gc-btn--icon-overlay { background: rgba(0, 0, 0, 0.55); border-radius: 5px; padding: 4px 6px; font-size: 16px; }
      .gc-btn-row { display: flex; gap: 4px; }

      /* ==== Cartes ==== */
      .gc-card { background: var(--gc-bg-secondary); border-radius: 6px; padding: 7px 9px; font-size: 15px; }
      .gc-card-header { display: flex; justify-content: space-between; align-items: center; }

      /* ==== Formulaires ==== */
      .gc-input {
        width: 100%;
        margin-top: 4px;
        border-radius: 4px;
        border: none;
        padding: 6px;
        box-sizing: border-box;
        background: #1a1a28;
        color: white;
        font-family: var(--gc-font);
        font-size: 15px;
      }
      .gc-input--compact { font-size: 13px; padding: 4px; }
      textarea.gc-input { resize: vertical; }

      /* ==== Mise en page ==== */
      .gc-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .gc-grid-2--compact { gap: 3px 4px; }
      .gc-span-2 { grid-column: 1 / span 2; }
      .gc-hr { opacity: 0.15; margin: 12px 0; border-color: #888; }
      .gc-hr--dashed { border-style: dashed; opacity: 0.3; }
      .gc-btn--pill { border-radius: 999px; }
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
      .gc-btn--icon-accent { color: var(--gc-accent); }
      .gc-btn--icon-danger { color: var(--gc-danger); }
      .gc-relative { position: relative; }
      .gc-mt-6 { margin-top: 6px; }
      .gc-mb-6 { margin-bottom: 6px; }
      .gc-mb-8 { margin-bottom: 8px; }
      .gc-mb-10 { margin-bottom: 10px; }
      .gc-shrink-0 { flex-shrink: 0; }
      .gc-img-overlay-actions { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; }
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

      /* Voir foreignOverlayModule plus bas : dès qu'un élément de GeoGuessr
         lui-même (menu profil, modale...) est ajouté par-dessus, on repasse
         nos panneaux sous la interface du site le temps qu'il soit ouvert,
         plutôt que de le recouvrir avec notre z-index habituellement énorme. */
      body.gc-foreign-overlay-open .gc-panel {
        z-index: 100 !important;
      }
    `;
    document.head.appendChild(style);
  }
  injectThemeStyles();

  // ============================================================
  // CORE: notify (notifications discrètes, non bloquantes)
  // ------------------------------------------------------------
  // Point d'entrée unique pour signaler une erreur à l'utilisateur —
  // remplace le mélange précédent console.error (invisible) / alert
  // (bloquant). Toast discret en bas de l'écran, auto-disparaît ;
  // le détail technique reste toujours loggé en console à côté.
  // ============================================================

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

  // ============================================================
  // CORE: foreignOverlay (menu profil GeoGuessr masqué par nos panneaux)
  // ------------------------------------------------------------
  // Nos panneaux (.gc-panel) utilisent un z-index volontairement énorme
  // pour rester au-dessus du contenu du jeu. Problème : ça recouvre aussi
  // les propres menus déroulants/modales de GeoGuessr (ex: le menu profil
  // dans le header), qui apparaissent alors visuellement "en dessous".
  // On ne connaît pas leurs sélecteurs exacts (et ils peuvent changer), donc
  // on détecte génériquement : dès qu'un nouvel élément est ajouté comme
  // enfant direct de <body> par le site (pas par nous), on suppose que
  // c'est un overlay du site (menu, modale, tooltip portalé...) et on
  // repasse temporairement nos panneaux sous lui via la classe CSS
  // gc-foreign-overlay-open (voir injectThemeStyles). Restauré dès que cet
  // élément étranger est retiré du DOM (menu refermé).
  // ============================================================
  (function foreignOverlayModule() {
    function isOwnNode(node) {
      return !!(node.id && node.id.startsWith('geo-companion'));
    }

    // Référence des enfants de <body> déjà présents une fois la page
    // stabilisée (racine de l'app GeoGuessr, etc.) — sans ça, la racine
    // de leur app compterait elle-même comme "étrangère" en permanence
    // dès la première mutation, et la classe resterait activée pour de bon.
    let baselineChildren = null;

    function captureBaseline() {
      baselineChildren = new Set(Array.from(document.body.children));
    }

    function refreshOverlayState() {
      if (!baselineChildren) return; // référence pas encore figée, on ignore
      const hasForeignOverlay = Array.from(document.body.children).some(
        (child) => !isOwnNode(child) && !baselineChildren.has(child)
      );
      document.body.classList.toggle('gc-foreign-overlay-open', hasForeignOverlay);
    }

    // Le bootstrap tourne en document-start : document.body peut ne pas
    // encore exister, on attend qu'il soit disponible avant d'observer.
    function start() {
      if (!document.body) {
        setTimeout(start, 50);
        return;
      }
      const observer = new MutationObserver(refreshOverlayState);
      observer.observe(document.body, { childList: true });
      // On fige la référence une fois la page chargée (pas avant : les
      // éléments ajoutés par GeoGuessr à son propre démarrage ne doivent
      // pas être pris pour un overlay).
      if (document.readyState === 'complete') {
        captureBaseline();
      } else {
        pageWindow.addEventListener('load', captureBaseline, { once: true });
      }
    }
    start();
  })();

  // ============================================================
  // CORE: détection des events de partie (fetch/XHR + parsing)
  // ============================================================
  (function apiDetectionModule() {
    // --- état interne, persisté pour survivre à un rechargement de page ---
    // (le tableau "guesses" de l'API est cumulatif sur toute la partie ; sans
    // cette persistance, un refresh en cours de partie ferait croire au script
    // qu'un guess déjà traité avant le refresh est nouveau, et redéclencherait
    // à tort roundStart/roundEnd pour du contenu déjà passé.)
    const STATE_KEY = 'geoCompanion_apiState';
    const savedState = GM_getValue(STATE_KEY, null);

    let currentGameId = savedState?.currentGameId ?? null;
    let currentRound = savedState?.currentRound ?? null;
    let guessesSeenTotal = savedState?.guessesSeenTotal ?? 0;
    let gameState = savedState?.gameState ?? null;
    // Round pour lequel l'event roundEnd basé sur rounds[].state === "Ended"
    // a déjà été émis (live challenge) — évite de le réémettre à chaque
    // requête suivante tant que ce round reste marqué "Ended".
    let roundEndEmittedRound = savedState?.roundEndEmittedRound ?? null;
    // Dernier objet game contenant un vrai guess (live challenge : la
    // réponse qui signale la vraie fin de round, ex. l'appel "end-round",
    // n'a pas les données du guess — on les récupère depuis ce snapshot).
    let lastGoodGameSnapshot = null;
    // Live challenge uniquement : les events WebSocket de début/fin de round
    // n'incluent pas le numéro de round (juste un code). Sans ce compteur
    // dédié, on dépendait de "currentRound" — qui ne se met à jour que si
    // une réponse HTTP avec un champ round exploitable arrive entre deux
    // rounds. Un joueur qui ne fait plus aucune requête après avoir guessé
    // (cas courant à plusieurs) ne déclenchait alors jamais la mise à jour,
    // et le round-end suivant était silencieusement ignoré (comparaison à
    // l'identique). Ce compteur avance uniquement via les events WS eux-mêmes,
    // donc indépendamment de si HTTP a suivi ou non — best-effort, à confirmer
    // sur le terrain.
    let liveChallengeRound = savedState?.liveChallengeRound ?? null;

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

    // Récupère un identifiant de partie quel que soit le nom du champ utilisé
    // selon le mode (classic, challenge, live challenge, battle royale, duels...)
    function getGameToken(game) {
      return game.token || game.gameId || game.id || null;
    }

    // Certaines réponses live challenge n'ont aucun champ round exploitable
    // au niveau racine (contrairement au mode classique) — on retombe alors
    // sur game.rounds[] : le premier round dont l'état n'est pas "Ended"
    // (donc celui en cours), sinon le dernier de la liste si tous sont
    // terminés. Rend la détection de round moins dépendante d'un champ qui
    // peut être absent selon le mode — best-effort, à confirmer sur le terrain.
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

    // Analyse un objet "game" renvoyé par l'API et émet les events correspondants
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
        persistState();
        GeoCompanion.emit('gameStart', game);
      }

      // 1) Détection "début de round" : le numéro de round a augmenté.
      //    Ça arrive typiquement quand le joueur clique sur "suivant", donc plus tard
      //    que la soumission du guess.
      const round = deriveRoundNumber(game);
      if (typeof round === 'number' && round !== currentRound) {
        currentRound = round;
        // Recale le compteur dédié live challenge sur cette valeur fiable
        // (HTTP), pour éviter qu'il ne dérive s'il avait avancé séparément
        // via des events WebSocket entre-temps.
        liveChallengeRound = round;
        persistState();
        GeoCompanion.emit('roundStart', game);
      }

      // 2) Détection "fin de round" :
      //    - Live challenge : chaque round a un champ state ("Ongoing"/"Ended")
      //      dans game.rounds[] — signal fiable, indépendant du moment où CE
      //      joueur guess (les autres peuvent encore jouer). Sa réponse n'a
      //      pas les guesses (null) : complété via le dernier snapshot qui en avait.
      //    - Autres modes : pas de ce champ, on retombe sur l'heuristique
      //      "le nombre de guesses a augmenté".
      const guesses = game.player?.guesses || game.guesses;
      const roundsInfo = game.rounds || [];
      const currentRoundInfo = typeof round === 'number' ? roundsInfo[round - 1] : null;
      // Le champ state existe uniquement en live challenge — sa seule présence
      // (peu importe sa valeur "Ongoing"/"Ended") indique qu'il faut se fier à
      // lui, et surtout ne PAS utiliser l'heuristique guesses en parallèle
      // (sinon double émission : une fois au guess, une fois à "Ended").
      const hasStateField = currentRoundInfo?.state != null;
      const roundStateEnded = hasStateField && /ended/i.test(currentRoundInfo.state);
      const hasRealGuesses = Array.isArray(guesses) && guesses.length > 0;
      // Une réponse peut révéler les données du lieu réel (pays/coordonnées)
      // du round en cours même si CE joueur n'a lui-même rien guessé (round
      // terminé sans qu'il ait répondu à temps) — on capture aussi ce cas.
      // Avant ce correctif, le snapshot restait bloqué sur un round
      // précédent dans ce cas, et le round-end ne trouvait alors aucun pays
      // exploitable (rien à afficher, roundRecorded abandonnait en silence).
      const currentRoundHasLocationData =
        currentRoundInfo &&
        (currentRoundInfo.countryCode != null ||
          currentRoundInfo.streakLocationCode != null ||
          currentRoundInfo.question?.panoramaQuestionPayload?.panorama?.countryCode != null ||
          currentRoundInfo.lat != null ||
          currentRoundInfo.location?.lat != null);

      if (hasRealGuesses || currentRoundHasLocationData) {
        lastGoodGameSnapshot = game;
      }

      if (hasStateField) {
        if (roundStateEnded && roundEndEmittedRound !== round) {
          roundEndEmittedRound = round;
          liveChallengeRound = round;
          if (hasRealGuesses) guessesSeenTotal = guesses.length;
          persistState();
          GeoCompanion.emit('roundEnd', hasRealGuesses ? game : lastGoodGameSnapshot || game);
        }
      } else if (hasRealGuesses && guesses.length > guessesSeenTotal) {
        guessesSeenTotal = guesses.length;
        persistState();
        GeoCompanion.emit('roundEnd', game);
      }

      // Détection fin de partie (le champ exact peut varier selon le mode : classic, battle royale, live challenge...)
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
        // Live challenge : domaine et format différents du reste de l'API
        // (game-server.geoguessr.com/api/live-challenge/{token}[/guess|/advance-round|/{round}])
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

    // --- Hook WebSocket (live challenge uniquement) ---
    // En live challenge, GeoGuessr pousse les vrais events de fin de round/
    // partie via WebSocket ("LiveChallengeRoundEnded", "LiveChallengeFinished"),
    // pas seulement via des réponses HTTP. Un joueur qui a déjà guessé et ne
    // fait plus aucune requête HTTP ensuite ne verrait jamais la transition
    // "Ended" avec le seul hook fetch/XHR — d'où ce hook supplémentaire,
    // confirmé nécessaire par capture réseau (le round-end HTTP ne se
    // déclenchait pas de façon fiable à plusieurs joueurs).
    // Ces messages WS ne contiennent pas les données du round (juste un code
    // + gameId), donc on les utilise comme simple déclencheur fiable, et on
    // reconstruit l'event à partir du dernier snapshot HTTP connu (déjà
    // utilisé comme filet de sécurité pour le cas classique aussi).
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

          if (data.code === 'LiveChallengeRoundEnded') {
            // Le round qui vient de se terminer : on se fie au compteur
            // dédié (liveChallengeRound) plutôt qu'à currentRound, qui peut
            // ne jamais avoir été mis à jour si aucune requête HTTP avec un
            // round exploitable n'est arrivée depuis le round précédent.
            const endedRound = liveChallengeRound ?? currentRound ?? 1;
            if (roundEndEmittedRound !== endedRound && lastGoodGameSnapshot) {
              roundEndEmittedRound = endedRound;
              persistState();
              // On force le round sur le snapshot émis : extractRoundData()
              // lit game.round, et le snapshot HTTP disponible peut être
              // légèrement daté par rapport à ce round précis.
              GeoCompanion.emit('roundEnd', { ...lastGoodGameSnapshot, round: endedRound });
            }
          } else if (data.code === 'LiveChallengeFinished') {
            if (gameState !== 'finished') {
              gameState = 'finished';
              persistState();
              GeoCompanion.emit('gameEnd', lastGoodGameSnapshot || {});
            }
          } else if (data.code === 'LiveChallengeRoundStarted') {
            // Pas de données de round dans ce message — sert de déclencheur
            // pour nettoyer les panneaux de l'ancien round, et fait avancer
            // le compteur dédié pour le prochain "Ended".
            liveChallengeRound = (liveChallengeRound ?? currentRound ?? 1) + 1;
            persistState();
            GeoCompanion.emit('roundStart', lastGoodGameSnapshot || {});
          }
        });
        return ws;
      };
      // Préserve le prototype et les constantes statiques (OPEN, CLOSED...)
      // pour que le reste du site continue de fonctionner normalement.
      pageWindow.WebSocket.prototype = OriginalWebSocket.prototype;
      Object.setPrototypeOf(pageWindow.WebSocket, OriginalWebSocket);
    }
  })();

  // ============================================================
  // MODULE: debugLogger
  // ------------------------------------------------------------
  // Log simple dans la console à chaque event. Sert aussi
  // d'exemple pour brancher un futur module (historique, tips...)
  // sur le même bus d'events, indépendamment du core.
  // ============================================================
  (function debugLoggerModule() {
    GeoCompanion.on('gameStart', (game) => {
      console.log('[GeoCompanion] 🟢 Début de partie', game);
    });

    GeoCompanion.on('gameEnd', (game) => {
      console.log('[GeoCompanion] 🔴 Fin de partie', game);
    });

    GeoCompanion.on('roundStart', (game) => {
      console.log('[GeoCompanion] ▶️ Début de round', game.round ?? game.roundNumber);
    });

    GeoCompanion.on('roundEnd', (game) => {
      console.log('[GeoCompanion] ⏹️ Fin de round', game.round ?? game.roundNumber);
    });
  })();

  // ============================================================
  // MODULE: identity
  // ------------------------------------------------------------
  // Récupère le pseudo depuis le header de la page (affiché sur
  // TOUTE page GeoGuessr, indépendamment du mode joué) plutôt que
  // depuis les objets "game" — ces derniers ne sont disponibles
  // qu'en partie, et le live challenge ne les fournit pas du tout
  // dans un format exploitable (ambiguïté entre les 2 joueurs).
  //
  // Filet de sécurité : demande manuelle (popup) si le DOM ne
  // donne jamais rien après quelques secondes.
  //
  // Expose GeoCompanion.getPlayerName() pour les autres modules.
  // ============================================================
  (function identityModule() {
    const STORAGE_KEY = 'geoCompanion_playerName';
    let cachedName = GM_getValue(STORAGE_KEY, null);
    let observer = null;

    // Sélecteur best-effort basé sur le header actuel de GeoGuessr
    // (<span class="nick_nick__XXXXX">Pseudo</span>). Le suffixe hashé
    // après "__" peut changer à un futur déploiement de leur site — d'où
    // un sélecteur par préfixe de classe plutôt qu'un nom exact, plus
    // résistant à ce genre de changement mineur.
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

    // Le script tourne en @run-at document-start : document.body peut ne
    // pas encore exister à ce stade. On diffère l'init si besoin plutôt
    // que de planter sur observer.observe(document.body, ...).
    function initDetection() {
      // Tentative immédiate (au cas où le header serait déjà chargé), puis
      // surveillance du DOM : le header peut apparaître après coup
      // (chargement différé) ou être reconstruit lors d'une navigation SPA.
      tryDetect();
      if (!cachedName) {
        observer = new MutationObserver(() => tryDetect());
        observer.observe(document.body, { childList: true, subtree: true });

        // Si rien après quelques secondes, on demande manuellement plutôt
        // que de rester bloqué indéfiniment sans pseudo.
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

  // ============================================================
  // CORE: supabaseClient
  // ------------------------------------------------------------
  // Petit wrapper autour de l'API REST Supabase (PostgREST), sans
  // dépendance externe. Réutilisable par tous les futurs modules
  // (historique, tips, stats...).
  // ============================================================
  const supabaseClient = {
    // insert une ou plusieurs lignes.
    // - merge: true fait un upsert avec update sur conflit (nécessite une policy RLS UPDATE)
    // - ignoreDuplicates: true ignore silencieusement les conflits (aucun UPDATE déclenché,
    //   donc aucune policy RLS supplémentaire requise) — utile pour "profiles"
    async insert(table, row, { merge = false, ignoreDuplicates = false } = {}) {
      try {
        let prefer = 'return=minimal';
        if (merge) prefer = 'resolution=merge-duplicates,return=minimal';
        if (ignoreDuplicates) prefer = 'resolution=ignore-duplicates,return=minimal';

        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Prefer: prefer,
          },
          body: JSON.stringify(row),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[GeoCompanion] Erreur insertion Supabase (${table}) :`, res.status, text);
          GeoCompanion.notify(`Échec de l'enregistrement (${table})`, 'error');
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception insertion Supabase (${table}) :`, e);
        GeoCompanion.notify(`Échec de l'enregistrement (${table})`, 'error');
        return false;
      }
    },

    // lecture simple avec query string PostgREST (ex: "select=*&country_code=eq.FR")
    async select(table, query = '') {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        });
        if (!res.ok) {
          console.error(`[GeoCompanion] Erreur lecture Supabase (${table}) :`, res.status);
          GeoCompanion.notify(`Échec de la lecture des données (${table})`, 'error');
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error(`[GeoCompanion] Exception lecture Supabase (${table}) :`, e);
        GeoCompanion.notify(`Échec de la lecture des données (${table})`, 'error');
        return null;
      }
    },

    // met à jour la ligne d'id donné avec les champs de `patch`
    async update(table, id, patch) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[GeoCompanion] Erreur update Supabase (${table}) :`, res.status, text);
          GeoCompanion.notify(`Échec de la mise à jour (${table})`, 'error');
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception update Supabase (${table}) :`, e);
        GeoCompanion.notify(`Échec de la mise à jour (${table})`, 'error');
        return false;
      }
    },

    // supprime la ligne d'id donné
    async remove(table, id) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Prefer: 'return=minimal',
          },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[GeoCompanion] Erreur delete Supabase (${table}) :`, res.status, text);
          GeoCompanion.notify(`Échec de la suppression (${table})`, 'error');
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception delete Supabase (${table}) :`, e);
        GeoCompanion.notify(`Échec de la suppression (${table})`, 'error');
        return false;
      }
    },

    // suppression par filtre PostgREST (ex: "player_name=eq.X&played_at=gte....")
    // plutôt que par id unique — utilisé pour les suppressions en masse.
    async removeWhere(table, query) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Prefer: 'return=minimal',
          },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[GeoCompanion] Erreur delete Supabase (${table}) :`, res.status, text);
          GeoCompanion.notify(`Échec de la suppression (${table})`, 'error');
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception delete Supabase (${table}) :`, e);
        GeoCompanion.notify(`Échec de la suppression (${table})`, 'error');
        return false;
      }
    },

    // appel d'une fonction Postgres (RPC) — utilisé pour les agrégats
    // calculés côté base plutôt que côté client (voir supabase-stats-functions.sql)
    async rpc(fnName, params = {}) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify(params),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[GeoCompanion] Erreur RPC Supabase (${fnName}) :`, res.status, text);
          GeoCompanion.notify(`Échec du calcul des statistiques`, 'error');
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error(`[GeoCompanion] Exception RPC Supabase (${fnName}) :`, e);
        GeoCompanion.notify(`Échec du calcul des statistiques`, 'error');
        return null;
      }
    },
  };

  GeoCompanion.supabase = supabaseClient;

  // ============================================================
  // CORE: reverseGeocode
  // ------------------------------------------------------------
  // GeoGuessr ne fournit pas le pays deviné par le joueur (seulement
  // ses coordonnées lat/lng), donc on le déduit via Nominatim
  // (OpenStreetMap) — gratuit, sans clé, CORS ouvert.
  // Politique d'usage : ~1 requête/seconde max, ce qui est largement
  // suffisant ici (un seul appel par fin de round).
  // ============================================================
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

  // ============================================================
  // CORE: geoData (mapping pays -> continent)
  // ------------------------------------------------------------
  // Contrairement au sens de circulation ou aux slugs Plonkit, le
  // découpage continental est un fait géographique stable — cette
  // liste est une bonne source de vérité, pas juste une estimation.
  // Quelques cas limites (Russie transcontinentale, territoires
  // d'outre-mer) sont tranchés arbitrairement mais raisonnablement.
  // ============================================================
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

  // Inverse de CONTINENT_BY_COUNTRY : liste de tous les codes pays connus
  // pour un continent donné (utilisé pour afficher la liste complète des
  // pays, y compris ceux jamais joués).
  const COUNTRIES_BY_CONTINENT = (() => {
    const grouped = {};
    for (const [code, continent] of Object.entries(CONTINENT_BY_COUNTRY)) {
      if (!grouped[continent]) grouped[continent] = [];
      grouped[continent].push(code);
    }
    return grouped;
  })();

  // Pays ayant une couverture Google Street View connue (donc susceptibles
  // d'apparaître réellement dans une partie GeoGuessr). Best-effort, basé
  // sur une source communautaire mise à jour mensuellement — la couverture
  // évolue avec le temps, cette liste peut donc devenir légèrement datée.
  // Utilisé uniquement pour filtrer les pays "jamais joués" affichés dans
  // le dashboard (un round réellement enregistré s'affiche toujours, quelle
  // que soit cette liste — CONTINENT_BY_COUNTRY reste complet pour ça).
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

  // ============================================================
  // MODULE: roundHistory
  // ------------------------------------------------------------
  // À chaque fin de round, enregistre les données dans Supabase
  // (table "rounds"). Crée aussi le profil du joueur au passage
  // s'il n'existe pas encore (upsert silencieux).
  //
  // ⚠️ Les noms de champs dans extractRoundData() sont une
  // meilleure estimation, pas une certitude — à ajuster une fois
  // testé en conditions réelles (voir les warnings en console).
  // ============================================================
  (function roundHistoryModule() {
    let warnedOnce = false;
    let warnedMapOnce = false;

    function extractRoundData(game) {
      // Repli identique à apiDetectionModule::deriveRoundNumber (module
      // séparé, pas de closure partagée) : certaines réponses live
      // challenge n'ont aucun champ round exploitable à la racine.
      let round = game.round ?? game.roundNumber ?? game.currentRoundNumber;
      const roundsInfoForDerive = game.rounds;
      if (typeof round !== 'number' && Array.isArray(roundsInfoForDerive) && roundsInfoForDerive.length > 0) {
        const ongoingIndex = roundsInfoForDerive.findIndex((r) => r && r.state != null && !/ended/i.test(r.state));
        round = ongoingIndex !== -1 ? ongoingIndex + 1 : roundsInfoForDerive.length;
      }

      // Les infos du lieu réel du round sont généralement dans un tableau
      // "rounds" indexé par (round - 1).
      const roundsInfo = game.rounds || [];
      const roundInfo = roundsInfo[round - 1] || {};

      // Le guess le plus récent pour ce round.
      const guesses = game.player?.guesses || game.guesses || [];
      const guess = guesses[guesses.length - 1] || {};

      // Live challenge : les coordonnées réelles sont imbriquées dans
      // answer.coordinateAnswerPayload.coordinate plutôt qu'à plat sur roundInfo.
      const actualLat =
        roundInfo.lat ?? roundInfo.location?.lat ?? roundInfo.answer?.coordinateAnswerPayload?.coordinate?.lat;
      const actualLng =
        roundInfo.lng ?? roundInfo.location?.lng ?? roundInfo.answer?.coordinateAnswerPayload?.coordinate?.lng;
      const guessLat = guess.lat ?? guess.position?.lat;
      const guessLng = guess.lng ?? guess.position?.lng;
      // Pas de code pays direct en live challenge (juste des coordonnées) —
      // sera résolu par reverse-geocoding dans le handler roundEnd si besoin.
      // Live challenge : le pays réel est fourni, mais imbriqué plus profond
      // (rounds[].question.panoramaQuestionPayload.panorama.countryCode)
      // plutôt qu'à plat comme en classique.
      const actualCountry =
        roundInfo.streakLocationCode ??
        roundInfo.countryCode ??
        roundInfo.question?.panoramaQuestionPayload?.panorama?.countryCode ??
        null;

      // Live challenge : score/distance sont des valeurs directes sur le
      // guess (guess.score, guess.distance), pas imbriquées comme en classique.
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
        game_mode: game.mode || game.gameMode || (game.hostId ? 'live-challenge' : null),
        map_id: game.map || game.mapSlug || game.options?.mapSlug || null,
        map_name: game.mapName || null,
        time_remaining_s:
          guess.time != null && game.timeLimit != null ? game.timeLimit - guess.time : null,
      };
    }

    GeoCompanion.on('roundEnd', async (game) => {
      const row = extractRoundData(game);

      // Warning si les champs essentiels manquent, pour repérer vite un souci d'extraction.
      if (!warnedOnce && (row.actual_lat == null || row.guess_lat == null || row.country_code == null)) {
        warnedOnce = true;
        console.warn(
          '[GeoCompanion] Certains champs clés du round sont introuvables — ' +
            'vérifie la structure ci-dessous et ajuste extractRoundData() si besoin :',
          { extracted: row, rawGame: game }
        );
      }

      // Warning séparé pour map_id (utile pour les stats par carte) — moins
      // critique que les champs ci-dessus donc géré à part.
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

      // Certains modes (live challenge) ne fournissent pas le code pays réel
      // directement, seulement des coordonnées — on le déduit alors par
      // reverse-geocoding, comme on le fait déjà pour le guess plus bas.
      if (!row.country_code && row.actual_lat != null && row.actual_lng != null) {
        const actualCountry = await reverseGeocodeCountry(row.actual_lat, row.actual_lng);
        if (actualCountry) {
          row.country_code = actualCountry;
          row.continent = continentFromCountryCode(actualCountry);
        }
      }

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
        }
      }

      // Notifie les autres modules (UI, stats...) avec la donnée finale du round,
      // pour éviter qu'ils ne redupliquent la logique d'extraction ci-dessus.
      GeoCompanion.emit('roundRecorded', row);

      if (row.player_name) {
        await supabaseClient.insert('profiles', { player_name: row.player_name }, { ignoreDuplicates: true });
      }

      const ok = await supabaseClient.insert('rounds', row);
      if (ok) {
        console.log('[GeoCompanion] ✅ Round enregistré dans Supabase');
      }
    });
  })();

  // ============================================================
  // MODULE: stats
  // ------------------------------------------------------------
  // Agrégation des stats par pays/continent/carte, avec filtres
  // temporels (24h / 7j / 30j / total). Les agrégats sont calculés
  // côté base (fonctions Postgres, voir supabase-stats-functions.sql)
  // plutôt que côté client — le volume de données transféré reste
  // constant dans le temps, quelle que soit la taille de l'historique.
  //
  // Expose GeoCompanion.stats.getCountryStats(countryCode, filterKey)
  // ============================================================
  (function statsModule() {
    // Convertit un filterKey ('24h'|'7d'|'30d'|'all') en timestamp ISO,
    // ou null pour 'all' (pas de filtre de date côté RPC).
    function sinceTimestamp(filterKey) {
      if (filterKey === 'all') return null;
      const hoursByFilter = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
      const hours = hoursByFilter[filterKey];
      if (!hours) return null;
      return new Date(Date.now() - hours * 3600 * 1000).toISOString();
    }

    // Convertit une ligne renvoyée par une RPC d'agrégat (snake_case,
    // colonnes possiblement absentes) vers le format utilisé par l'UI.
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

    async function getCountryStats(countryCode, filterKey = 'all') {
      const rows = await supabaseClient.rpc('get_country_stats', {
        p_country_code: countryCode,
        p_since: sinceTimestamp(filterKey),
      });
      return toAggregateStats(rows && rows[0]);
    }

    async function getContinentStats(continent, filterKey = 'all') {
      const rows = await supabaseClient.rpc('get_continent_stats', {
        p_continent: continent,
        p_since: sinceTimestamp(filterKey),
      });
      return toAggregateStats(rows && rows[0]);
    }

    async function getMapStats(mapId, filterKey = 'all') {
      const rows = await supabaseClient.rpc('get_map_stats', {
        p_map_id: mapId,
        p_since: sinceTimestamp(filterKey),
      });
      return toAggregateStats(rows && rows[0]);
    }

    // Comparaison entre joueurs pour un pays donné : moyenne/taux de réussite
    // par joueur, triés du meilleur au moins bon score moyen.
    async function getPlayerComparison(countryCode, filterKey = 'all') {
      const rows = await supabaseClient.rpc('get_player_comparison', {
        p_country_code: countryCode,
        p_since: sinceTimestamp(filterKey),
      });
      return toComparisonRows(rows);
    }

    // Stats groupées par pays (avec leur continent) pour un joueur donné —
    // utilisé par le dashboard sur la page d'accueil. Filtré par joueur car
    // c'est un outil de progression personnelle (voir tes propres points
    // faibles), la comparaison entre joueurs existe déjà par ailleurs.
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
          // Fallback : les rounds enregistrés avant l'ajout de la colonne
          // "continent" l'ont à null en base — recalculé à la volée dans ce cas.
          continent: r.continent || continentFromCountryCode(r.country_code),
          count: r.count,
          avgScore: r.avg_score != null ? Math.round(r.avg_score) : null,
          successRate: r.success_rate != null ? Math.round(r.success_rate) : null,
        };
      }
      return result;
    }

    // Combo fin de round : pays + continent + carte + comparaison en un
    // seul appel réseau (au lieu de 4 requêtes séparées).
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

    // Supprime les rounds d'un joueur correspondant au filtre temporel donné
    // (même logique de date que les stats — filterKey 'all' supprime tout
    // l'historique du joueur, sans restriction de date).
    async function deleteRoundsForPlayer(playerName, filterKey = 'all') {
      const since = sinceTimestamp(filterKey);
      const query =
        `player_name=eq.${encodeURIComponent(playerName)}` + (since ? `&played_at=gte.${since}` : '');
      return supabaseClient.removeWhere('rounds', query);
    }

    GeoCompanion.stats = {
      getCountryStats,
      getContinentStats,
      getMapStats,
      getPlayerComparison,
      getAllCountryStats,
      getRoundEndStats,
      deleteRoundsForPlayer,
    };
  })();

  // ============================================================
  // MODULE: tips
  // ------------------------------------------------------------
  // CRUD des tips par pays. Modifiables par tout le monde (décision
  // produit), pas de restriction par auteur. Ce module ne fait que
  // la donnée — l'affichage est dans uiPanel juste après.
  // ============================================================
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

    GeoCompanion.tips = { listTipsForCountry, addTip, updateTip, deleteTip };
  })();

  // ============================================================
  // MODULE: countryInfo
  // ------------------------------------------------------------
  // Métadonnées par pays : sens de circulation, langue, plaque/
  // bollard/poteau (photos) et voiture (texte), tous modifiables
  // manuellement. Les valeurs de base (sens de circulation, indices
  // de langue) sont pré-remplies directement dans Supabase via un
  // script SQL de seed (pas de liste codée en dur ici) — voir
  // supabase-country-info-seed.sql. Toute correction manuelle prime
  // et n'est jamais écrasée par un futur seed (ON CONFLICT + COALESCE).
  // ============================================================
  (function countryInfoModule() {
    // Retourne toutes les métadonnées d'un pays en une seule requête,
    // telles que stockées en base (valeurs déjà seedées ou corrigées).
    async function getCountryInfo(countryCode) {
      if (!countryCode) return {};
      const upper = countryCode.toUpperCase();
      const rows = await supabaseClient.select(
        'country_info',
        `select=driving_side,plaque_image_url,bollard_image_url,poteau_image_url,voiture_text,voiture_image_url,voiture_exclusive,route_text,route_image_url,langue_text&country_code=eq.${upper}`
      );
      return (rows && rows[0]) || {};
    }

    // Setter multi-champs : sauvegarde plusieurs colonnes de country_info
    // en un seul appel (utile pour les champs composites comme "voiture").
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

    GeoCompanion.countryInfo = { getCountryInfo, setCountryInfoField, setCountryInfoFields };
  })();

  // ============================================================
  // MODULE: uiPanel
  // ------------------------------------------------------------
  // Encart affiché uniquement en fin de round (une fois le pays
  // révélé). Montre le résultat du round + les stats du pays
  // avec filtres temporels. S'appuie sur GeoCompanion.stats et sur
  // l'event "roundRecorded" (pas de duplication de logique).
  // ============================================================
  (function uiPanelModule() {
    const PANEL_ID = 'geo-companion-panel';
    const TIPS_PANEL_ID = 'geo-companion-tips-panel';
    const FILTERS = [
      { key: '24h', label: '24h' },
      { key: '7d', label: '7j' },
      { key: '30d', label: '30j' },
      { key: 'all', label: 'Total' },
    ];

    // Empêche les touches tapées dans un champ de saisie de remonter vers
    // GeoGuessr (qui a des raccourcis clavier globaux sur certaines lettres).
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

    // Noms raccourcis pour les affichages compacts (ex: dashboard en grille
    // serrée) — seuls les noms français les plus longs sont couverts.
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

    // Domaine internet (ccTLD) du pays. Dans la grande majorité des cas, ça
    // correspond directement au code ISO en minuscule — quelques exceptions
    // connues sont listées ci-dessous (liste non exhaustive, à compléter si
    // un cas manquant est repéré).
    const TLD_OVERRIDES = {
      GB: 'uk', // le Royaume-Uni utilise .uk et non .gb
    };

    function tldFromCode(code) {
      if (!code || code.length !== 2) return null;
      const upper = code.toUpperCase();
      return `.${TLD_OVERRIDES[upper] || upper.toLowerCase()}`;
    }

    // Convertit un code pays ISO 2 lettres en <img> de drapeau via flagcdn.com
    // (gratuit, pas de clé). On utilisait un emoji drapeau Unicode avant,
    // mais Chrome/Windows ne les rend pas du tout (juste les 2 lettres du
    // code ISO côte à côte) — une image est fiable sur toutes plateformes.
    function flagImgFromCode(code, { height = '1em', style = '' } = {}) {
      if (!code || code.length !== 2) return '';
      const lower = code.toLowerCase();
      return `<img src="https://flagcdn.com/${lower}.svg" alt="${code.toUpperCase()}" style="height:${height}; width:auto; vertical-align:middle; display:inline-block; border-radius:2px; ${style}" onerror="this.style.visibility='hidden'">`;
    }

    // Déduit l'URL de la page pays sur plonkit.net à partir du nom anglais
    // (ex: "United States" -> "united-states"). Best-effort : plonkit ne suit
    // pas toujours exactement les noms ISO, donc quelques pays peuvent tomber
    // sur une mauvaise URL — à corriger au cas par cas si repéré.
    const PLONKIT_SLUG_OVERRIDES = {
      // code ISO (majuscule) -> slug plonkit, pour les cas où la conversion
      // automatique du nom anglais ne matche pas l'URL réelle.
      // Exemple : KR: 'south-korea',
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
        panel.className = 'gc-panel';
        panel.style.cssText = `
          top: 20px;
          right: 20px;
          width: clamp(300px, 18.75vw, 480px);
          max-height: 80vh;
          overflow-y: auto;
          font-size: 20px;
        `;
        document.body.appendChild(panel);
      }
      return panel;
    }

    function ensureTipsPanel() {
      let panel = document.getElementById(TIPS_PANEL_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = TIPS_PANEL_ID;
        panel.className = 'gc-panel';
        panel.style.cssText = `
          top: 20px;
          left: 20px;
          width: clamp(300px, 18.75vw, 480px);
          height: auto;
          max-height: 85vh;
          padding: 14px;
          font-size: 19px;
        `;
        document.body.appendChild(panel);

        // Listener délégué unique (le panneau persiste entre les re-renders) :
        // clique sur n'importe quelle image marquée data-lightbox pour la
        // voir en taille réelle.
        panel.addEventListener('click', (e) => {
          const img = e.target.closest('img[data-lightbox]');
          if (img) openImageLightbox(img.src);
        });
      }
      return panel;
    }

    function renderRoundResult(panel, row) {
      panel.innerHTML = `
        <div style="display:flex; align-items:center; gap:16px; margin-bottom:12px;">
          <div style="flex-shrink:0;">
            ${flagImgFromCode(row.country_code, { height: '10vh', style: 'box-shadow:0 2px 10px rgba(0,0,0,0.4);' })}
          </div>
          <div style="flex:1; min-width:0;">
            <div class="gc-title" style="margin-bottom:8px;">
              ${row.country_code ? countryNameFromCode(row.country_code) : 'Pays inconnu'}
              ${
                row.country_code && tldFromCode(row.country_code)
                  ? `<span class="gc-title">(${tldFromCode(row.country_code)})</span>`
                  : ''
              }
            </div>
            <div>Score : ${row.score ?? '-'} pts</div>
            <div>Distance : ${row.distance_km != null ? row.distance_km.toFixed(1) + ' km' : '-'}</div>
            <div>Résultat : ${
              row.country_correct == null ? '…' : row.country_correct ? '✅ Pays trouvé' : '❌ Pays raté'
            }</div>
          </div>
        </div>
        <hr class="gc-hr">
        <button id="geo-companion-toggle-stats-btn" class="gc-btn gc-btn--secondary gc-btn--block" style="padding:8px; font-size:14px;">📊 Voir les stats</button>
        <div id="geo-companion-stats-section" style="display:none; margin-top:10px;">
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

    // Génère le HTML commun (rounds/score moyen/meilleur/pire/réussite) à
    // partir d'un objet stats — réutilisé pour pays/continent/carte.
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
        <div class="gc-btn-row" style="margin-bottom:10px;">
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

      // Cache par filtre temporel : changer de filtre puis revenir dessus ne
      // refait pas d'appel réseau. Le cache est propre à ce round affiché
      // (créé à chaque nouvel affichage), donc toujours à jour.
      let stats;
      if (cache.has(activeFilter)) {
        stats = cache.get(activeFilter);
      } else {
        // Un seul appel réseau pour pays + continent + carte + comparaison,
        // au lieu de 4 requêtes séparées (économise de la bande passante).
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
          <div class="gc-muted" style="font-size:14px;">Aucune donnée pour cette période.</div>
        `;
        return;
      }

      const me = GeoCompanion.getPlayerName();
      const rowsHtml = comparison
        .map(
          (p) => `
        <div class="gc-card-header" style="padding:6px 8px; border-radius:6px; margin-bottom:2px;
          background:${p.player === me ? 'var(--gc-bg-secondary-hover)' : 'transparent'};">
          <span style="font-weight:${p.player === me ? '700' : '400'};">${escapeHtml(p.player)}</span>
          <span style="font-size:13px; opacity:0.85;">
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
      overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999999; cursor: zoom-out;
      `;
      overlay.innerHTML = `<img src="${url}" style="max-width:90vw; max-height:90vh; border-radius:8px; box-shadow:0 8px 40px rgba(0,0,0,0.6);">`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }

    function tipHtml(tip) {
      const buttonsHtml = `
        <button data-edit-tip="${tip.id}" class="gc-btn gc-btn--icon-overlay gc-btn--icon-accent" title="Modifier">✏️</button>
        <button data-delete-tip="${tip.id}" class="gc-btn gc-btn--icon-overlay gc-btn--icon-danger" title="Supprimer">🗑️</button>
      `;

      return `
        <div class="gc-card" style="border-radius:8px; font-size:16px;">
          ${tip.content ? `<div style="margin-bottom:4px; white-space:pre-wrap; font-size:18px;">${escapeHtml(tip.content)}</div>` : ''}
          ${
            tip.image_url
              ? `
                <div class="gc-relative gc-mb-2">
                  <img data-lightbox="true" src="${tip.image_url}" class="gc-img" style="width:100%; max-height:300px; object-fit:contain;">
                  <div class="gc-img-overlay-actions">${buttonsHtml}</div>
                </div>
              `
              : `<div style="display:flex; justify-content:flex-end; gap:8px;">${buttonsHtml}</div>`
          }
        </div>
      `;
    }

    function showTipForm(tipsPanel, row, tip) {
      const formContainer = tipsPanel.querySelector('#geo-companion-tip-form');
      if (!formContainer) return;

      formContainer.innerHTML = `
        <div class="gc-card" style="margin-top:6px; border-radius:8px;">
          <textarea id="geo-companion-tip-text" placeholder="Texte du tip (optionnel)" class="gc-input gc-input--compact" style="min-height:50px;">${
            tip ? escapeHtml(tip.content || '') : ''
          }</textarea>
          <input id="geo-companion-tip-image" type="text" placeholder="URL d'image (optionnel)" value="${
            tip ? tip.image_url || '' : ''
          }" class="gc-input gc-input--compact">
          <div class="gc-btn-row" style="margin-top:6px;">
            <button id="geo-companion-tip-save" class="gc-btn gc-btn--flex gc-btn--primary" style="padding:6px; font-size:13px;">Enregistrer</button>
            <button id="geo-companion-tip-cancel" class="gc-btn gc-btn--flex gc-btn--secondary" style="padding:6px; font-size:13px;">Annuler</button>
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

      const plonkitUrl = plonkitUrlFromCode(row.country_code);
      const info = await GeoCompanion.countryInfo.getCountryInfo(row.country_code);

      tipsPanel.innerHTML = `
        <div class="gc-card-header gc-mb-8 gc-shrink-0">
          <div class="gc-title">
            💡 Tips ${
              plonkitUrl
                ? `<a href="${plonkitUrl}" target="_blank" rel="noopener noreferrer" class="gc-link" style="font-size:17px;">🔗 Plonkit</a>`
                : ''
            }
          </div>
          <div style="display:flex; gap:6px;">
            <button id="geo-companion-tips-refresh-btn" title="Actualiser les tips" class="gc-btn gc-btn--icon gc-btn--icon-accent" style="font-size:16px;">🔄</button>
            <button id="geo-companion-tips-collapse-btn" title="Replier/déplier" class="gc-btn gc-btn--icon gc-btn--icon-accent" style="font-size:18px;">▼</button>
          </div>
        </div>
        <div id="geo-companion-tips-body" style="display:flex; flex-direction:column; min-height:0; flex:1;">
          <div id="geo-companion-country-fields" class="gc-mb-6 gc-shrink-0"></div>
          <div id="geo-companion-voiture-route-fields" class="gc-grid-2 gc-mb-10 gc-shrink-0">
            <div id="geo-companion-voiture-field"></div>
            <div id="geo-companion-route-field"></div>
          </div>
          <div id="geo-companion-tips-list" style="flex:1; overflow-y:auto; min-height:0;">
            ${
              tips.length === 0
                ? `<div class="gc-muted" style="font-size:16px;">Aucun tip pour ce pays pour l'instant.</div>`
                : `<div class="gc-grid-2">${tips.map(tipHtml).join('')}</div>`
            }
          </div>
          <button id="geo-companion-add-tip-btn" class="gc-btn gc-btn--secondary gc-btn--block gc-mt-6 gc-shrink-0" style="padding:7px; font-size:16px;">+ Ajouter un tip</button>
          <div id="geo-companion-tip-form" class="gc-shrink-0"></div>
        </div>
      `;

      renderCountryInfoFields(tipsPanel, row, info);
      renderVoitureField(tipsPanel, row, info);
      renderRouteField(tipsPanel, row, info);

      const collapseBtn = tipsPanel.querySelector('#geo-companion-tips-collapse-btn');
      const tipsBody = tipsPanel.querySelector('#geo-companion-tips-body');
      collapseBtn.addEventListener('click', () => {
        const isHidden = tipsBody.style.display === 'none';
        tipsBody.style.display = isHidden ? 'flex' : 'none';
        collapseBtn.textContent = isHidden ? '▼' : '▶';
      });

      const refreshBtn = tipsPanel.querySelector('#geo-companion-tips-refresh-btn');
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        await renderTips(row);
      });

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

    // Champ "Route" composite : texte + image + sens de circulation,
    // affiché à côté du champ Voiture.
    function renderRouteField(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-route-field');
      if (!container) return;

      const hasContent = info.route_text || info.route_image_url;

      container.innerHTML = `
        <div class="gc-card" style="height:100%; box-sizing:border-box;">
          <div class="gc-card-header">
            <span class="gc-label">Route 🚗 ${drivingSideLabel(info.driving_side)}</span>
            <button data-edit-route class="gc-btn gc-btn--icon gc-btn--icon-accent" title="Modifier">✏️</button>
          </div>
          <div data-route-display style="margin-top:2px;">
            ${
              hasContent
                ? `
              ${info.route_text ? `<div>${escapeHtml(info.route_text)}</div>` : ''}
              ${
                info.route_image_url
                  ? `<img data-lightbox="true" src="${info.route_image_url}" class="gc-img" style="max-height:98px; max-width:100%; display:block; margin-top:4px;">`
                  : ''
              }
            `
                : '<span class="gc-muted-light">Non renseigné</span>'
            }
          </div>
          <div data-route-form></div>
        </div>
      `;

      container.querySelector('[data-edit-route]').addEventListener('click', () => {
        const formEl = container.querySelector('[data-route-form]');
        formEl.innerHTML = `
          <input type="text" data-route-text value="${escapeHtml(
            info.route_text || ''
          )}" placeholder="Texte (marquage, bornes...)" class="gc-input gc-input--compact">
          <input type="text" data-route-image value="${escapeHtml(
            info.route_image_url || ''
          )}" placeholder="URL de l'image (optionnel)" class="gc-input gc-input--compact">
          <div class="gc-btn-row" style="margin-top:6px;">
            <button data-route-side="left" class="gc-btn gc-btn--flex" style="padding:4px; font-size:11px; background:${
              info.driving_side === 'left' ? 'var(--gc-accent-gradient)' : 'var(--gc-bg-secondary-hover)'
            };">⬅️ Gauche</button>
            <button data-route-side="right" class="gc-btn gc-btn--flex" style="padding:4px; font-size:11px; background:${
              info.driving_side === 'right' ? 'var(--gc-accent-gradient)' : 'var(--gc-bg-secondary-hover)'
            };">➡️ Droite</button>
          </div>
          <div class="gc-btn-row" style="margin-top:6px;">
            <button data-save-route class="gc-btn gc-btn--flex gc-btn--primary" style="padding:4px; font-size:13px;">OK</button>
            <button data-cancel-route class="gc-btn gc-btn--flex gc-btn--secondary" style="padding:4px; font-size:13px;">Annuler</button>
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
              b.style.background = b.dataset.routeSide === selectedSide ? 'var(--gc-accent-gradient)' : 'var(--gc-bg-secondary-hover)';
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

    // Champs d'identification par pays : plaque/bollard/poteau (photos) et
    // langue (texte). "Voiture" a son propre rendu composite juste en
    // dessous (texte + image + case "exclusif au pays").
    const COUNTRY_INFO_FIELDS = [
      { key: 'plaque_image_url', label: 'Plaque', type: 'image' },
      { key: 'bollard_image_url', label: 'Bollard', type: 'image' },
      { key: 'poteau_image_url', label: 'Poteau/Panneau', type: 'images', fullWidth: true },
      { key: 'langue_text', label: 'Langue', type: 'multitext', fullWidth: true },
    ];

    function countryInfoFieldDisplay(fieldConfig, value) {
      if (!value) {
        return `<span class="gc-muted-light">Non renseigné</span>`;
      }
      if (fieldConfig.type === 'image') {
        return `<img data-lightbox="true" src="${value}" class="gc-img" style="max-height:98px; max-width:100%; margin-top:2px;">`;
      }
      if (fieldConfig.type === 'images') {
        const urls = value
          .split('\n')
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) return `<span class="gc-muted-light">Non renseigné</span>`;
        return `
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
            ${urls
              .map((u) => `<img data-lightbox="true" src="${u}" class="gc-img" style="height:98px; width:auto; max-width:100%;">`)
              .join('')}
          </div>
        `;
      }
      if (fieldConfig.type === 'multitext') {
        // white-space:pre-line préserve les retours à la ligne saisis (une
        // langue par ligne par ex.) sans casser le rendu si le texte est long.
        return `<span style="white-space:pre-line; ${
          fieldConfig.key === 'langue_text' ? 'font-weight:bold; font-size:22px;' : ''
        }">${escapeHtml(value)}</span>`;
      }
      return `<span style="${
        fieldConfig.key === 'langue_text' ? 'font-weight:bold; font-size:22px;' : ''
      }">${escapeHtml(value)}</span>`;
    }

    function renderCountryInfoFields(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-country-fields');
      if (!container) return;

      container.innerHTML = `
        <div class="gc-grid-2">
          ${COUNTRY_INFO_FIELDS.map(
            (f) => `
            <div class="gc-card ${f.fullWidth ? 'gc-span-2' : ''}">
              <div class="gc-card-header">
                <span class="gc-label">${f.label}</span>
                <button data-edit-field="${f.key}" class="gc-btn gc-btn--icon gc-btn--icon-accent" title="Modifier">✏️</button>
              </div>
              <div data-field-display="${f.key}" style="margin-top:2px;">${countryInfoFieldDisplay(
                f,
                info[f.key]
              )}</div>
              <div data-field-form="${f.key}"></div>
            </div>
          `
          ).join('')}
        </div>
      `;

      container.querySelectorAll('[data-edit-field]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.editField;
          const fieldConfig = COUNTRY_INFO_FIELDS.find((f) => f.key === key);
          const formEl = container.querySelector(`[data-field-form="${key}"]`);
          const currentValue = info[key] || '';
          const isMultiUrl = fieldConfig.type === 'images'; // liste d'URLs (une par ligne, nettoyées)
          const isFreeText = fieldConfig.type === 'multitext'; // texte libre multi-lignes (ex: langue)
          const isTextarea = isMultiUrl || isFreeText;

          const actionsHtml = `
            <div class="gc-btn-row" style="margin-top:4px;">
              <button data-save-field class="gc-btn gc-btn--flex gc-btn--primary" style="padding:4px; font-size:13px;">OK</button>
              <button data-cancel-field class="gc-btn gc-btn--flex gc-btn--secondary" style="padding:4px; font-size:13px;">Annuler</button>
            </div>
          `;

          formEl.innerHTML = isTextarea
            ? `
              <textarea placeholder="${
                isMultiUrl ? "Une URL d'image par ligne" : 'Une ligne par langue'
              }" class="gc-input gc-input--compact" style="min-height:60px;">${escapeHtml(
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

    // Champ "Voiture" composite : texte + image + case "exclusif au pays".
    // Séparé du système générique car il combine 3 colonnes en une carte.
    function renderVoitureField(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-voiture-field');
      if (!container) return;

      const hasContent = info.voiture_text || info.voiture_image_url;
      const exclusiveBadge =
        info.voiture_exclusive === true
          ? '<span style="opacity:0.8;">🔒 Exclusif au pays</span>'
          : info.voiture_exclusive === false
          ? '<span style="opacity:0.5;">🌍 Non exclusif</span>'
          : '';

      container.innerHTML = `
        <div class="gc-card">
          <div class="gc-card-header">
            <span class="gc-label">Voiture</span>
            <button data-edit-voiture class="gc-btn gc-btn--icon gc-btn--icon-accent" title="Modifier">✏️</button>
          </div>
          <div data-voiture-display style="margin-top:2px;">
            ${
              hasContent
                ? `
              ${info.voiture_text ? `<div>${escapeHtml(info.voiture_text)}</div>` : ''}
              ${
                info.voiture_image_url
                  ? `<img data-lightbox="true" src="${info.voiture_image_url}" class="gc-img" style="max-height:98px; max-width:100%; margin-top:4px;">`
                  : ''
              }
              ${exclusiveBadge ? `<div style="margin-top:4px; font-size:13px;">${exclusiveBadge}</div>` : ''}
            `
                : '<span class="gc-muted-light">Non renseigné</span>'
            }
          </div>
          <div data-voiture-form></div>
        </div>
      `;

      container.querySelector('[data-edit-voiture]').addEventListener('click', () => {
        const formEl = container.querySelector('[data-voiture-form]');
        formEl.innerHTML = `
          <input type="text" data-voiture-text value="${escapeHtml(
            info.voiture_text || ''
          )}" placeholder="Texte (marque, modèle...)" class="gc-input gc-input--compact">
          <input type="text" data-voiture-image value="${escapeHtml(
            info.voiture_image_url || ''
          )}" placeholder="URL de l'image (optionnel)" class="gc-input gc-input--compact">
          <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px; cursor:pointer;">
            <input type="checkbox" data-voiture-exclusive ${info.voiture_exclusive ? 'checked' : ''}>
            Exclusif au pays
          </label>
          <div class="gc-btn-row" style="margin-top:6px;">
            <button data-save-voiture class="gc-btn gc-btn--flex gc-btn--primary" style="padding:4px; font-size:13px;">OK</button>
            <button data-cancel-voiture class="gc-btn gc-btn--flex gc-btn--secondary" style="padding:4px; font-size:13px;">Annuler</button>
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

    // Affiche le résultat d'un round (panneau principal + tips + bouton
    // stats) — factorisé pour être réutilisable à la fois depuis l'event
    // roundRecorded normal ET depuis la restauration après un rechargement
    // de page (voir plus bas).
    async function displayRoundResult(row) {
      const panel = ensurePanel();
      renderRoundResult(panel, row);
      await renderTips(row);

      // Les stats ne sont chargées (et donc aucune requête Supabase envoyée)
      // que si l'utilisateur clique explicitement sur le bouton — évite une
      // requête systématique à chaque round si on ne regarde pas les stats.
      const statsCache = new Map(); // propre à cet affichage de round
      const toggleBtn = document.getElementById('geo-companion-toggle-stats-btn');
      const statsSection = document.getElementById('geo-companion-stats-section');
      if (toggleBtn && statsSection) {
        let loaded = false;
        toggleBtn.addEventListener('click', async () => {
          const isHidden = statsSection.style.display === 'none';
          if (isHidden) {
            statsSection.style.display = 'block';
            toggleBtn.textContent = '📊 Masquer les stats';
            if (!loaded) {
              loaded = true;
              await renderStats(row, 'all', statsCache);
            }
          } else {
            statsSection.style.display = 'none';
            toggleBtn.textContent = '📊 Voir les stats';
          }
        });
      }
    }

    // Persiste quel round est actuellement affiché (ou "aucun"), pour
    // pouvoir restaurer l'affichage si la page est rechargée entre la fin
    // d'un round (pays révélé) et le début du suivant — sans avoir besoin
    // d'attendre un nouvel event réseau, qui pourrait ne jamais arriver
    // (ex: on ne fait plus aucune requête après avoir vu le résultat).
    const LAST_DISPLAY_KEY = 'geoCompanion_lastRoundDisplay';

    GeoCompanion.on('gameStart', () => {
      GM_setValue(LAST_DISPLAY_KEY, { row: null, visible: false });
    });

    GeoCompanion.on('roundRecorded', async (row) => {
      if (!row.country_code) return; // pas de pays détecté, rien d'exploitable à afficher
      await displayRoundResult(row);
      GM_setValue(LAST_DISPLAY_KEY, { row, visible: true });
    });

    // Retire les panneaux résultat/tips et oublie l'affichage persisté.
    // Exposé sur GeoCompanion pour être réutilisable depuis d'autres modules
    // (ex: le dashboard, qui les masque aussi au retour sur l'accueil — voir
    // plus bas : en live challenge, la détection roundStart/gameEnd peut
    // être en retard ou manquée, laissant ces panneaux affichés à tort une
    // fois la partie terminée).
    GeoCompanion.hideResultAndTipsPanels = function () {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      const tipsPanel = document.getElementById(TIPS_PANEL_ID);
      if (tipsPanel) tipsPanel.remove();
      GM_setValue(LAST_DISPLAY_KEY, { row: null, visible: false });
    };

    // Les panneaux résultat/tips n'ont d'intérêt qu'une fois le round terminé
    // (pays révélé) — on les retire au début du round suivant pour ne pas
    // laisser les infos de l'ancien round affichées pendant qu'on joue.
    GeoCompanion.on('roundStart', () => {
      GeoCompanion.hideResultAndTipsPanels();
    });

    // Une fois la partie terminée (dernier round révélé, leaderboard/résultats
    // final affichés par GeoGuessr), nos panneaux du dernier round n'ont plus
    // lieu d'être par-dessus cet écran — on les retire, sans attendre un
    // éventuel retour manuel sur l'accueil. Léger délai avant de le faire :
    // gameEnd peut arriver quasi en même temps que le roundEnd du tout
    // dernier round, dont l'enregistrement (Supabase) + l'affichage sont
    // asynchrones — sans ce délai, on risquerait de masquer le panneau avant
    // même que le résultat du dernier round ait eu le temps de s'afficher.
    GeoCompanion.on('gameEnd', () => {
      setTimeout(() => {
        GeoCompanion.hideResultAndTipsPanels();
      }, 3000);
    });

    // Restauration au chargement du script : si la page est rechargée juste
    // après la fin d'un round (avant le round suivant), on réaffiche
    // immédiatement à partir des données déjà connues, sans attendre.
    const lastDisplay = GM_getValue(LAST_DISPLAY_KEY, null);
    if (lastDisplay?.visible && lastDisplay.row) {
      displayRoundResult(lastDisplay.row);
    }

    // ==========================================================
    // DASHBOARD (page d'accueil)
    // ----------------------------------------------------------
    // Récap perso par continent/pays, affiché uniquement sur la
    // page d'accueil GeoGuessr (pas pendant une partie). GeoGuessr
    // étant une SPA, on détecte les changements de route sans
    // rechargement de page via un hook sur history.pushState.
    // ==========================================================
    const DASHBOARD_ID = 'geo-companion-dashboard';
    const CONTINENT_ORDER = ['europe', 'asia', 'africa', 'north_america', 'south_america', 'oceania'];
    let dashboardActiveContinent = CONTINENT_ORDER[0];
    let dashboardActiveFilter = 'all';
    let dashboardCollapsed = false; // conservé entre les re-rendus (changement de filtre/continent)

    // Cache en mémoire des stats par filtre temporel : changer d'onglet
    // continent ne change pas la requête sous-jacente (déjà tout récupéré
    // pour ce filtre), donc pas besoin de retaper le réseau à chaque clic.
    // Invalidé dès qu'un round est enregistré ou supprimé.
    const dashboardStatsCache = new Map();

    function isHomepage() {
      // Accueil GeoGuessr : "/" ou "/xx" (préfixe de langue), rien après.
      return /^\/([a-z]{2})?\/?$/i.test(pageWindow.location.pathname);
    }

    function removeDashboard() {
      const el = document.getElementById(DASHBOARD_ID);
      if (el) el.remove();
    }

    function ensureDashboard() {
      let panel = document.getElementById(DASHBOARD_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = DASHBOARD_ID;
        panel.className = 'gc-panel gc-panel--outlined';
        panel.style.cssText = `
          top: 70px;
          right: 304px;
          width: clamp(340px, 21vw, 536px);
          max-height: 61vh;
          padding: 12px;
          font-size: clamp(11px, 0.95vw, 14px);
        `;
        document.body.appendChild(panel);
      }
      return panel;
    }

    // Couleur pleine (bordure) et lavée (fond) selon le taux de réussite :
    // interpolation entre leur vrai rouge et leur vrai vert (design system
    // GeoGuessr), plutôt qu'un dégradé HSL générique.
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

    // Construit et affiche la liste des pays à partir de stats déjà chargées
    // (aucune requête réseau ici — c'est le rôle de renderDashboard/du bouton
    // Actualiser).
    function renderDashboardCountryList(allStats) {
      const listEl = document.getElementById('geo-companion-dashboard-list');
      if (!listEl) return;

      const allCodesForContinent = COUNTRIES_BY_CONTINENT[dashboardActiveContinent] || [];
      const countries = allCodesForContinent
        .map((code) => ({
          code,
          count: 0,
          avgScore: null,
          successRate: null,
          ...allStats[code], // écrase les valeurs par défaut si des stats existent
        }))
        // un pays jamais joué n'a d'intérêt à afficher que s'il a une
        // couverture Street View connue (sinon il n'apparaîtra jamais en
        // jeu) — un pays réellement joué s'affiche toujours, les données
        // réelles priment sur cette liste best-effort.
        .filter((c) => c.count > 0 || STREETVIEW_COVERED_COUNTRIES.has(c.code))
        .sort((a, b) => {
          // pays joués d'abord (triés par taux de réussite décroissant), puis
          // pays jamais joués, triés par nom.
          if (a.count === 0 && b.count === 0) return countryNameFromCode(a.code).localeCompare(countryNameFromCode(b.code));
          if (a.count === 0) return 1;
          if (b.count === 0) return -1;
          return (b.successRate ?? -1) - (a.successRate ?? -1);
        });

      if (countries.length === 0) {
        listEl.innerHTML = `<div class="gc-muted" style="font-size:14px;">Aucun pays connu sur ce continent.</div>`;
        return;
      }

      listEl.innerHTML = `
        <div class="gc-grid-2 gc-grid-2--compact">
          ${countries
            .map((c) => {
              const color = successColor(c.successRate);
              return `
              <div style="
                display:flex; justify-content:space-between; align-items:center; gap:6px;
                padding:2px 10px; border-radius:10px; overflow:hidden;
                background:${color.wash}; border-left:4px solid ${color.solid};
              ">
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${flagImgFromCode(c.code, {
                  height: '0.9em',
                  style: 'margin-right:4px;',
                })}${shortCountryName(c.code)}</span>
                <span style="font-size:12px; opacity:0.9; white-space:nowrap; flex-shrink:0;">
                  ${c.count > 0 ? `${c.count} · ${c.successRate != null ? c.successRate + '%' : '-'}` : 'Jamais joué'}
                </span>
              </div>
            `;
            })
            .join('')}
        </div>
      `;
    }

    // Affiche l'état vide + bouton "Actualiser" : aucune requête Supabase
    // n'est envoyée tant que l'utilisateur n'a pas cliqué dessus.
    // Charge les données pour le filtre courant : depuis le cache si déjà
    // disponible, sinon depuis Supabase (seul cas qui déclenche une requête
    // réseau). Réutilisé par le bouton "Actualiser" et par les boutons de
    // filtre temporel (qui appellent explicitement une nouvelle période).
    async function loadDashboardFilterData(playerName) {
      if (!playerName) return;
      if (dashboardStatsCache.has(dashboardActiveFilter)) {
        renderDashboardCountryList(dashboardStatsCache.get(dashboardActiveFilter));
        return;
      }
      const listEl = document.getElementById('geo-companion-dashboard-list');
      if (listEl) listEl.innerHTML = `<div class="gc-muted" style="font-size:13px;">Chargement…</div>`;

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
        <div style="text-align:center; padding:24px 0; opacity:0.75;">
          <div style="margin-bottom:10px; font-size:13px;">Aucune donnée chargée pour cette période.</div>
          <button id="geo-companion-dashboard-refresh-btn" class="gc-btn gc-btn--jouer gc-btn--pill" style="padding:8px 16px;">🔄 Actualiser</button>
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
          <div class="gc-title" style="font-size:16px;">Mes stats</div>
          <div style="display:flex; gap:6px;">
            <button id="geo-companion-dashboard-delete-btn" title="Supprimer mes rounds de la période sélectionnée" class="gc-btn gc-btn--danger gc-btn--pill" style="font-style:normal; padding:5px 10px;">🗑️</button>
            <button id="geo-companion-dashboard-collapse-btn" title="Replier/déplier" class="gc-btn gc-btn--icon gc-btn--icon-accent" style="font-style:normal; font-size:18px;">${
              dashboardCollapsed ? '▶' : '▼'
            }</button>
          </div>
        </div>
        <div id="geo-companion-dashboard-body" style="display:${
          dashboardCollapsed ? 'none' : 'flex'
        }; flex-direction:column; min-height:0; flex:1;">
          <hr class="gc-hr gc-hr--dashed" style="margin:0 0 10px;">
          <div class="gc-btn-row gc-mb-8 gc-shrink-0">
            ${FILTERS.map(
              (f) => `
              <button data-dash-filter="${f.key}" class="gc-btn gc-btn--flex gc-btn--pill gc-btn--xs ${
                f.key === dashboardActiveFilter ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }">${f.label}</button>
            `
            ).join('')}
          </div>
          <div class="gc-btn-row gc-mb-10 gc-shrink-0">
            ${CONTINENT_ORDER.map(
              (c) => `
              <button data-dash-continent="${c}" class="gc-btn gc-btn--flex-auto gc-btn--pill gc-btn--xs ${
                c === dashboardActiveContinent ? 'gc-btn--jouer' : 'gc-btn--secondary'
              }" style="padding-left:6px; padding-right:6px;">${CONTINENT_LABELS[c]}</button>
            `
            ).join('')}
          </div>
          <div id="geo-companion-dashboard-list" style="flex:1; overflow-y:auto; min-height:0;"></div>
        </div>
      `;

      const collapseBtn = panel.querySelector('#geo-companion-dashboard-collapse-btn');
      const dashboardBody = panel.querySelector('#geo-companion-dashboard-body');
      collapseBtn.addEventListener('click', () => {
        dashboardCollapsed = !dashboardCollapsed;
        dashboardBody.style.display = dashboardCollapsed ? 'none' : 'flex';
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
          // Un clic sur un filtre est une demande explicite pour cette
          // période : on charge depuis le cache s'il existe, sinon on va
          // chercher sur Supabase — contrairement au changement de continent
          // (passif, ne déclenche jamais de requête).
          loadDashboardFilterData(playerName);
        });
      });
      panel.querySelectorAll('[data-dash-continent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          dashboardActiveContinent = btn.dataset.dashContinent;
          renderDashboard();
        });
      });

      if (!playerName) {
        const listEl = panel.querySelector('#geo-companion-dashboard-list');
        listEl.innerHTML = `<div style="opacity:0.6; font-size:13px;">Identification du joueur en cours…</div>`;
        return;
      }

      // Aucune requête Supabase envoyée ici : on affiche le cache s'il existe
      // pour ce filtre, sinon un état vide avec bouton "Actualiser" — c'est
      // le clic sur ce bouton qui déclenche la seule requête réseau.
      if (dashboardStatsCache.has(dashboardActiveFilter)) {
        renderDashboardCountryList(dashboardStatsCache.get(dashboardActiveFilter));
      } else {
        renderDashboardEmptyState(playerName);
      }
    }

    function checkHomepage() {
      if (isHomepage()) {
        renderDashboard();
        // Filet de sécurité : en live challenge, la fin de partie/round
        // n'est pas toujours détectée de façon fiable (voir apiDetectionModule),
        // donc les panneaux résultat/tips de la dernière partie peuvent rester
        // affichés à tort. De retour sur l'accueil, ils n'ont plus lieu d'être
        // dans tous les cas — on les nettoie systématiquement ici, qu'ils
        // aient déjà été masqués ou non.
        if (GeoCompanion.hideResultAndTipsPanels) GeoCompanion.hideResultAndTipsPanels();
      } else {
        removeDashboard();
      }
    }

    // Filet de sécurité indépendant du routing : dès qu'une partie démarre
    // (détecté de façon fiable via l'interception réseau, pas via l'URL),
    // on masque le dashboard directement.
    GeoCompanion.on('gameStart', removeDashboard);

    // Un nouveau round enregistré rend les stats du dashboard obsolètes.
    GeoCompanion.on('roundRecorded', () => {
      dashboardStatsCache.clear();
    });

    // Détection de navigation SPA : GeoGuessr ne recharge pas la page à
    // chaque clic, donc on intercepte pushState/replaceState/popstate (même
    // principe que le hook fetch/XHR plus haut). replaceState est nécessaire
    // en plus de pushState : certaines transitions (ex: lancer une partie
    // depuis l'accueil) semblent l'utiliser plutôt que pushState.
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

    // Vérification initiale (script chargé directement sur l'accueil, ou en
    // cours de partie après un refresh).
    checkHomepage();
  })();

  console.log('[GeoCompanion] Script chargé, en attente d\'events GeoGuessr...');
})();