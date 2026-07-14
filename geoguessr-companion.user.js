// ==UserScript==
// @name         GeoGuessr Companion
// @namespace    geoguessr-companion
// @version      5.2
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

    function persistState() {
      GM_setValue(STATE_KEY, { currentGameId, currentRound, guessesSeenTotal, gameState });
    }

    // Récupère un identifiant de partie quel que soit le nom du champ utilisé
    // selon le mode (classic, challenge, live challenge, battle royale, duels...)
    function getGameToken(game) {
      return game.token || game.gameId || game.id || null;
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
        persistState();
        GeoCompanion.emit('gameStart', game);
      }

      // 1) Détection "début de round" : le numéro de round a augmenté.
      //    Ça arrive typiquement quand le joueur clique sur "suivant", donc plus tard
      //    que la soumission du guess.
      const round = game.round ?? game.roundNumber ?? game.currentRoundNumber;
      if (typeof round === 'number' && round !== currentRound) {
        currentRound = round;
        persistState();
        GeoCompanion.emit('roundStart', game);
      }

      // 2) Détection "fin de round" : un nouveau guess vient d'être soumis pour
      //    le round courant. C'est indépendant du passage au round suivant.
      //    Selon le mode, les guesses peuvent être sous player.guesses ou directement guesses.
      const guesses = game.player?.guesses || game.guesses;
      if (Array.isArray(guesses) && guesses.length > guessesSeenTotal) {
        guessesSeenTotal = guesses.length;
        persistState();
        GeoCompanion.emit('roundEnd', game);
      }

      // Détection fin de partie (le champ exact peut varier selon le mode : classic, battle royale, live challenge...)
      const roundCount = game.roundCount ?? game.numberOfRounds;
      const finished =
        game.state === 'finished' ||
        game.status === 'finished' ||
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
        /\/api\/v3\/social\/live-challenge/.test(url)
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
  // Récupère automatiquement le pseudo du joueur connecté à partir
  // des objets "game" déjà interceptés (pas de saisie manuelle, pas
  // de vraie authentification). Le nom est mis en cache pour être
  // disponible même avant qu'une partie ait commencé.
  //
  // Expose GeoCompanion.getPlayerName() pour les autres modules.
  // ============================================================
  (function identityModule() {
    const STORAGE_KEY = 'geoCompanion_playerName';
    let cachedName = GM_getValue(STORAGE_KEY, null);
    let warnedOnce = false;

    // Plusieurs noms de champs possibles selon le mode / la version de l'API.
    // À ajuster si les logs de warning ci-dessous s'affichent en jeu.
    function extractPlayerName(game) {
      if (game.player?.nick) return game.player.nick;
      if (game.player?.username) return game.player.username;
      if (game.player?.name) return game.player.name;
      if (Array.isArray(game.players)) {
        const me = game.players.find((p) => p.isYou || p.isMe);
        if (me?.nick) return me.nick;
        if (me?.username) return me.username;
      }
      return null;
    }

    function updatePlayerName(game) {
      const name = extractPlayerName(game);

      if (name && name !== cachedName) {
        cachedName = name;
        GM_setValue(STORAGE_KEY, name);
        console.log('[GeoCompanion] 👤 Joueur identifié :', name);
      } else if (!name && !warnedOnce) {
        warnedOnce = true;
        console.warn(
          '[GeoCompanion] Impossible de détecter le pseudo joueur dans cet objet game — ' +
            'vérifie la structure ci-dessous et ajuste extractPlayerName() si besoin :',
          game
        );
      }
    }

    // On tente l'extraction à chaque event, pas seulement gameStart,
    // au cas où le champ n'est pas présent dès la première réponse API.
    GeoCompanion.on('gameStart', updatePlayerName);
    GeoCompanion.on('roundStart', updatePlayerName);

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
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception insertion Supabase (${table}) :`, e);
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
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error(`[GeoCompanion] Exception lecture Supabase (${table}) :`, e);
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
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception update Supabase (${table}) :`, e);
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
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception delete Supabase (${table}) :`, e);
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
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[GeoCompanion] Exception delete Supabase (${table}) :`, e);
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
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error(`[GeoCompanion] Exception RPC Supabase (${fnName}) :`, e);
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
      const round = game.round ?? game.roundNumber ?? game.currentRoundNumber;

      // Les infos du lieu réel du round sont généralement dans un tableau
      // "rounds" indexé par (round - 1).
      const roundsInfo = game.rounds || [];
      const roundInfo = roundsInfo[round - 1] || {};

      // Le guess le plus récent pour ce round.
      const guesses = game.player?.guesses || game.guesses || [];
      const guess = guesses[guesses.length - 1] || {};

      const actualLat = roundInfo.lat ?? roundInfo.location?.lat;
      const actualLng = roundInfo.lng ?? roundInfo.location?.lng;
      const guessLat = guess.lat ?? guess.position?.lat;
      const guessLng = guess.lng ?? guess.position?.lng;
      const actualCountry = roundInfo.streakLocationCode ?? roundInfo.countryCode ?? null;

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
        score: guess.roundScoreInPoints ?? guess.score?.amount ?? null,
        distance_km: guess.distanceInMeters != null ? guess.distanceInMeters / 1000 : null,
        country_correct: null, // rempli après coup via reverse-geocoding (voir handler roundEnd)
        game_mode: game.mode || game.gameMode || null,
        map_id: game.map || game.mapSlug || null,
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

    // Convertit un code pays ISO 2 lettres en emoji drapeau (aucune image nécessaire).
    function flagEmojiFromCode(code) {
      if (!code || code.length !== 2) return '';
      const upper = code.toUpperCase();
      const codePoints = [...upper].map((c) => 127397 + c.charCodeAt(0));
      return String.fromCodePoint(...codePoints);
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
        panel.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          width: 33vw;
          max-width: 480px;
          max-height: 80vh;
          overflow-y: auto;
          background: #1e1e2e;
          color: #f0f0f0;
          border-radius: 12px;
          padding: 16px;
          font-family: -apple-system, sans-serif;
          font-size: 20px;
          z-index: 999999;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
          line-height: 1.5;
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
        panel.style.cssText = `
          position: fixed;
          top: 20px;
          left: 20px;
          width: 480px;
          max-width: 38vw;
          height: auto;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          background: #1e1e2e;
          color: #f0f0f0;
          border-radius: 12px;
          padding: 14px;
          font-family: -apple-system, sans-serif;
          font-size: 19px;
          z-index: 999999;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
          line-height: 1.4;
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
          <div style="font-size:14vh; line-height:0.9; flex-shrink:0;">
            ${flagEmojiFromCode(row.country_code)}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:bold; font-size:22px; margin-bottom:8px;">
              ${row.country_code ? countryNameFromCode(row.country_code) : 'Pays inconnu'}
              ${
                row.country_code && tldFromCode(row.country_code)
                  ? `<span style="opacity:0.55; font-size:16px; font-weight:400;">(${tldFromCode(row.country_code)})</span>`
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
        <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
        <button id="geo-companion-toggle-stats-btn" style="
          padding:8px; border-radius:8px; border:none; cursor:pointer;
          background:#33334a; color:white; font-size:14px; width:100%;
        ">📊 Voir les stats</button>
        <div id="geo-companion-stats-section" style="display:none; margin-top:10px;">
          <div id="geo-companion-stats">Chargement des statistiques…</div>
          <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
          <div id="geo-companion-continent-stats"></div>
          <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
          <div id="geo-companion-map-stats"></div>
          <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
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
        <div style="display:flex; gap:6px; margin-bottom:10px;">
          ${FILTERS.map(
            (f) => `
            <button data-filter="${f.key}" style="
              flex:1; padding:10px 0; border-radius:8px; border:none; cursor:pointer;
              background:${f.key === activeFilter ? '#4a9eff' : '#33334a'};
              color:white; font-size:16px; font-weight:600;
            ">${f.label}</button>
          `
          ).join('')}
        </div>
        <div id="geo-companion-stats-body" style="opacity:0.85;">Chargement…</div>
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
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🌍 ${label}</div>
        <div style="opacity:0.85;">${aggregateStatsHtml(continentStats)}</div>
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
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🗺️ ${escapeHtml(label)}</div>
        <div style="opacity:0.85;">${aggregateStatsHtml(mapStats)}</div>
      `;
    }

    function renderComparison(row, comparison) {
      const container = document.getElementById('geo-companion-comparison');
      if (!container) return;

      if (!comparison || comparison.length === 0) {
        container.innerHTML = `
          <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">👥 Comparaison</div>
          <div style="opacity:0.6; font-size:14px;">Aucune donnée pour cette période.</div>
        `;
        return;
      }

      const me = GeoCompanion.getPlayerName();
      const rowsHtml = comparison
        .map(
          (p) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px;
          background:${p.player === me ? '#33334a' : 'transparent'}; border-radius:6px; margin-bottom:2px;">
          <span style="font-weight:${p.player === me ? '700' : '400'};">${escapeHtml(p.player)}</span>
          <span style="font-size:13px; opacity:0.85;">
            ${p.count} rounds · ${p.avgScore ?? '-'} pts moy. · ${p.successRate != null ? p.successRate + '%' : '-'}
          </span>
        </div>
      `
        )
        .join('');

      container.innerHTML = `
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">👥 Comparaison</div>
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
        <button data-edit-tip="${tip.id}" style="background:rgba(0,0,0,0.55); border:none; color:#4a9eff; cursor:pointer; font-size:16px; padding:4px 6px; border-radius:5px;" title="Modifier">✏️</button>
        <button data-delete-tip="${tip.id}" style="background:rgba(0,0,0,0.55); border:none; color:#ff6b6b; cursor:pointer; font-size:16px; padding:4px 6px; border-radius:5px;" title="Supprimer">🗑️</button>
      `;

      return `
        <div style="background:#2a2a3d; border-radius:8px; padding:6px 8px; font-size:16px;">
          ${tip.content ? `<div style="margin-bottom:4px; white-space:pre-wrap; font-size:18px;">${escapeHtml(tip.content)}</div>` : ''}
          ${
            tip.image_url
              ? `
                <div style="position:relative; margin-bottom:2px;">
                  <img data-lightbox="true" src="${tip.image_url}" style="width:100%; max-height:300px; object-fit:contain; border-radius:5px; background:#111; display:block; cursor:zoom-in;">
                  <div style="position:absolute; top:4px; right:4px; display:flex; gap:4px;">${buttonsHtml}</div>
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
        <div style="margin-top:6px; background:#2a2a3d; border-radius:8px; padding:8px;">
          <textarea id="geo-companion-tip-text" placeholder="Texte du tip (optionnel)" style="
            width:100%; min-height:50px; border-radius:6px; border:none; padding:6px; box-sizing:border-box;
            background:#1a1a28; color:white; font-family:inherit; font-size:13px; resize:vertical;
          ">${tip ? escapeHtml(tip.content || '') : ''}</textarea>
          <input id="geo-companion-tip-image" type="text" placeholder="URL d'image (optionnel)" value="${
            tip ? tip.image_url || '' : ''
          }" style="
            width:100%; margin-top:5px; border-radius:6px; border:none; padding:6px; box-sizing:border-box;
            background:#1a1a28; color:white; font-size:13px;
          ">
          <div style="display:flex; gap:6px; margin-top:6px;">
            <button id="geo-companion-tip-save" style="flex:1; padding:6px; border-radius:6px; border:none; cursor:pointer; background:#4a9eff; color:white; font-weight:600; font-size:13px;">Enregistrer</button>
            <button id="geo-companion-tip-cancel" style="flex:1; padding:6px; border-radius:6px; border:none; cursor:pointer; background:#33334a; color:white; font-size:13px;">Annuler</button>
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
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-shrink:0;">
          <div style="font-weight:bold; font-size:22px;">
            💡 Tips ${
              plonkitUrl
                ? `<a href="${plonkitUrl}" target="_blank" rel="noopener noreferrer" style="color:#4a9eff; text-decoration:underline; font-size:17px;">🔗 Plonkit</a>`
                : ''
            }
          </div>
          <button id="geo-companion-tips-collapse-btn" title="Replier/déplier" style="
            background:none; border:none; color:#4a9eff; cursor:pointer; font-size:18px;
          ">▼</button>
        </div>
        <div id="geo-companion-tips-body" style="display:flex; flex-direction:column; min-height:0; flex:1;">
          <div id="geo-companion-country-fields" style="margin-bottom:6px; flex-shrink:0;"></div>
          <div id="geo-companion-voiture-route-fields" style="margin-bottom:10px; flex-shrink:0; display:grid; grid-template-columns:1fr 1fr; gap:6px;">
            <div id="geo-companion-voiture-field"></div>
            <div id="geo-companion-route-field"></div>
          </div>
          <div id="geo-companion-tips-list" style="flex:1; overflow-y:auto; min-height:0;">
            ${
              tips.length === 0
                ? `<div style="opacity:0.6; font-size:16px;">Aucun tip pour ce pays pour l'instant.</div>`
                : `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">${tips.map(tipHtml).join('')}</div>`
            }
          </div>
          <button id="geo-companion-add-tip-btn" style="
            margin-top:6px; padding:7px; border-radius:8px; border:none; cursor:pointer;
            background:#33334a; color:white; font-size:16px; width:100%; flex-shrink:0;
          ">+ Ajouter un tip</button>
          <div id="geo-companion-tip-form" style="flex-shrink:0;"></div>
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
        <div style="background:#2a2a3d; border-radius:6px; padding:7px 9px; font-size:15px; height:100%; box-sizing:border-box;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="opacity:0.75; font-weight:700; font-size:15px;">Route 🚗 ${drivingSideLabel(info.driving_side)}</span>
            <button data-edit-route style="background:none; border:none; color:#4a9eff; cursor:pointer; font-size:15px;" title="Modifier">✏️</button>
          </div>
          <div data-route-display style="margin-top:2px;">
            ${
              hasContent
                ? `
              ${info.route_text ? `<div>${escapeHtml(info.route_text)}</div>` : ''}
              ${
                info.route_image_url
                  ? `<img data-lightbox="true" src="${info.route_image_url}" style="max-height:98px; max-width:100%; border-radius:4px; display:block; margin-top:4px; background:#111; cursor:zoom-in;">`
                  : ''
              }
            `
                : '<span style="opacity:0.45;">Non renseigné</span>'
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
          )}" placeholder="Texte (marquage, bornes...)" style="
            width:100%; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
            background:#1a1a28; color:white; font-size:15px;
          ">
          <input type="text" data-route-image value="${escapeHtml(
            info.route_image_url || ''
          )}" placeholder="URL de l'image (optionnel)" style="
            width:100%; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
            background:#1a1a28; color:white; font-size:15px;
          ">
          <div style="display:flex; gap:4px; margin-top:6px;">
            <button data-route-side="left" style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:${
              info.driving_side === 'left' ? '#4a9eff' : '#33334a'
            }; color:white; font-size:11px;">⬅️ Gauche</button>
            <button data-route-side="right" style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:${
              info.driving_side === 'right' ? '#4a9eff' : '#33334a'
            }; color:white; font-size:11px;">➡️ Droite</button>
          </div>
          <div style="display:flex; gap:4px; margin-top:6px;">
            <button data-save-route style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#4a9eff; color:white; font-size:13px;">OK</button>
            <button data-cancel-route style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#33334a; color:white; font-size:13px;">Annuler</button>
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
              b.style.background = b.dataset.routeSide === selectedSide ? '#4a9eff' : '#33334a';
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
      { key: 'langue_text', label: 'Langue', type: 'text', fullWidth: true },
    ];

    function countryInfoFieldDisplay(fieldConfig, value) {
      if (!value) {
        return `<span style="opacity:0.45;">Non renseigné</span>`;
      }
      if (fieldConfig.type === 'image') {
        return `<img data-lightbox="true" src="${value}" style="max-height:98px; max-width:100%; border-radius:4px; display:block; margin-top:2px; background:#111; cursor:zoom-in;">`;
      }
      if (fieldConfig.type === 'images') {
        const urls = value
          .split('\n')
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) return `<span style="opacity:0.45;">Non renseigné</span>`;
        return `
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
            ${urls
              .map(
                (u) =>
                  `<img data-lightbox="true" src="${u}" style="height:98px; width:auto; max-width:100%; border-radius:4px; background:#111; cursor:zoom-in;">`
              )
              .join('')}
          </div>
        `;
      }
      return `<span style="${
        fieldConfig.key === 'langue_text' ? 'font-weight:bold; font-size:22px;' : ''
      }">${escapeHtml(value)}</span>`;
    }

    function renderCountryInfoFields(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-country-fields');
      if (!container) return;

      container.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
          ${COUNTRY_INFO_FIELDS.map(
            (f) => `
            <div style="${f.fullWidth ? 'grid-column:1 / span 2;' : ''} background:#2a2a3d; border-radius:6px; padding:7px 9px; font-size:15px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="opacity:0.75; font-weight:700; font-size:15px;">${f.label}</span>
                <button data-edit-field="${f.key}" style="background:none; border:none; color:#4a9eff; cursor:pointer; font-size:15px;" title="Modifier">✏️</button>
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
          const isMulti = fieldConfig.type === 'images';

          formEl.innerHTML = isMulti
            ? `
              <textarea placeholder="Une URL d'image par ligne" style="
                width:100%; min-height:60px; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
                background:#1a1a28; color:white; font-size:15px; font-family:inherit; resize:vertical;
              ">${escapeHtml(currentValue)}</textarea>
              <div style="display:flex; gap:4px; margin-top:4px;">
                <button data-save-field style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#4a9eff; color:white; font-size:13px;">OK</button>
                <button data-cancel-field style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#33334a; color:white; font-size:13px;">Annuler</button>
              </div>
            `
            : `
              <input type="text" value="${escapeHtml(currentValue)}" placeholder="${
                fieldConfig.type === 'image' ? "URL de l'image" : 'Texte'
              }" style="
                width:100%; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
                background:#1a1a28; color:white; font-size:15px;
              ">
              <div style="display:flex; gap:4px; margin-top:4px;">
                <button data-save-field style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#4a9eff; color:white; font-size:13px;">OK</button>
                <button data-cancel-field style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#33334a; color:white; font-size:13px;">Annuler</button>
              </div>
            `;

          const inputEl = formEl.querySelector(isMulti ? 'textarea' : 'input');
          stopKeyPropagation(inputEl);

          formEl.querySelector('[data-cancel-field]').addEventListener('click', () => {
            formEl.innerHTML = '';
          });

          formEl.querySelector('[data-save-field]').addEventListener('click', async () => {
            const value = isMulti
              ? inputEl.value
                  .split('\n')
                  .map((u) => u.trim())
                  .filter(Boolean)
                  .join('\n')
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
        <div style="background:#2a2a3d; border-radius:6px; padding:7px 9px; font-size:15px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="opacity:0.75; font-weight:700; font-size:15px;">Voiture</span>
            <button data-edit-voiture style="background:none; border:none; color:#4a9eff; cursor:pointer; font-size:15px;" title="Modifier">✏️</button>
          </div>
          <div data-voiture-display style="margin-top:2px;">
            ${
              hasContent
                ? `
              ${info.voiture_text ? `<div>${escapeHtml(info.voiture_text)}</div>` : ''}
              ${
                info.voiture_image_url
                  ? `<img data-lightbox="true" src="${info.voiture_image_url}" style="max-height:98px; max-width:100%; border-radius:4px; display:block; margin-top:4px; background:#111; cursor:zoom-in;">`
                  : ''
              }
              ${exclusiveBadge ? `<div style="margin-top:4px; font-size:13px;">${exclusiveBadge}</div>` : ''}
            `
                : '<span style="opacity:0.45;">Non renseigné</span>'
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
          )}" placeholder="Texte (marque, modèle...)" style="
            width:100%; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
            background:#1a1a28; color:white; font-size:15px;
          ">
          <input type="text" data-voiture-image value="${escapeHtml(
            info.voiture_image_url || ''
          )}" placeholder="URL de l'image (optionnel)" style="
            width:100%; margin-top:4px; border-radius:4px; border:none; padding:4px; box-sizing:border-box;
            background:#1a1a28; color:white; font-size:15px;
          ">
          <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px; cursor:pointer;">
            <input type="checkbox" data-voiture-exclusive ${info.voiture_exclusive ? 'checked' : ''}>
            Exclusif au pays
          </label>
          <div style="display:flex; gap:4px; margin-top:6px;">
            <button data-save-voiture style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#4a9eff; color:white; font-size:13px;">OK</button>
            <button data-cancel-voiture style="flex:1; padding:4px; border-radius:4px; border:none; cursor:pointer; background:#33334a; color:white; font-size:13px;">Annuler</button>
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

    GeoCompanion.on('roundRecorded', async (row) => {
      if (!row.country_code) return; // pas de pays détecté, rien d'exploitable à afficher
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
    });

    // Les panneaux résultat/tips n'ont d'intérêt qu'une fois le round terminé
    // (pays révélé) — on les retire au début du round suivant pour ne pas
    // laisser les infos de l'ancien round affichées pendant qu'on joue.
    GeoCompanion.on('roundStart', () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      const tipsPanel = document.getElementById(TIPS_PANEL_ID);
      if (tipsPanel) tipsPanel.remove();
    });

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
        panel.style.cssText = `
          position: fixed;
          top: 70px;
          right: 300px;
          width: 540px;
          max-width: 45vw;
          max-height: 63.5vh;
          display: flex;
          flex-direction: column;
          background: #1e1e2e;
          color: #f0f0f0;
          border-radius: 12px;
          padding: 12px;
          font-family: -apple-system, sans-serif;
          font-size: 14px;
          z-index: 999999;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
          line-height: 1.4;
        `;
        document.body.appendChild(panel);
      }
      return panel;
    }

    // Couleur pleine (bordure) et lavée (fond) selon le taux de réussite :
    // rouge (0%) -> vert (100%).
    function successColor(rate) {
      if (rate == null) return { solid: 'hsl(0, 0%, 45%)', wash: 'hsla(0, 0%, 45%, 0.15)' };
      const hue = Math.round((rate / 100) * 120);
      return { solid: `hsl(${hue}, 65%, 45%)`, wash: `hsla(${hue}, 65%, 45%, 0.18)` };
    }

    async function renderDashboard() {
      const panel = ensureDashboard();

      const playerName = GeoCompanion.getPlayerName();
      let allStats;

      if (!playerName) {
        allStats = {};
      } else if (dashboardStatsCache.has(dashboardActiveFilter)) {
        // déjà en cache pour ce filtre (ex: on ne fait que changer de continent) — pas de requête réseau
        allStats = dashboardStatsCache.get(dashboardActiveFilter);
      } else {
        panel.innerHTML = `<div style="font-weight:bold; font-size:16px; margin-bottom:8px; flex-shrink:0;">📊 Mes stats</div><div style="opacity:0.6;">Chargement…</div>`;
        allStats = await GeoCompanion.stats.getAllCountryStats(playerName, dashboardActiveFilter);
        dashboardStatsCache.set(dashboardActiveFilter, allStats);
      }

      const currentPanel = document.getElementById(DASHBOARD_ID);
      if (!currentPanel) return; // page quittée entre-temps

      currentPanel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-shrink:0;">
          <div style="font-weight:bold; font-size:16px;">📊 Mes stats</div>
          <button id="geo-companion-dashboard-delete-btn" title="Supprimer mes rounds de la période sélectionnée" style="
            background:#3a2020; border:none; color:#ff6b6b; cursor:pointer;
            font-size:13px; padding:4px 8px; border-radius:6px;
          ">🗑️</button>
        </div>
        <div style="display:flex; gap:4px; margin-bottom:8px; flex-shrink:0;">
          ${FILTERS.map(
            (f) => `
            <button data-dash-filter="${f.key}" style="
              flex:1; padding:4px 0; border-radius:6px; border:none; cursor:pointer;
              background:${f.key === dashboardActiveFilter ? '#4a9eff' : '#33334a'};
              color:white; font-size:11px; font-weight:600;
            ">${f.label}</button>
          `
          ).join('')}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; flex-shrink:0;">
          ${CONTINENT_ORDER.map(
            (c) => `
            <button data-dash-continent="${c}" style="
              padding:6px 10px; border-radius:6px; border:none; cursor:pointer;
              background:${c === dashboardActiveContinent ? '#4a9eff' : '#33334a'};
              color:white; font-size:12px;
            ">${CONTINENT_LABELS[c]}</button>
          `
          ).join('')}
        </div>
        <div id="geo-companion-dashboard-list" style="flex:1; overflow-y:auto; min-height:0;"></div>
      `;

      const deleteBtn = currentPanel.querySelector('#geo-companion-dashboard-delete-btn');
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
          await renderDashboard();
        } else {
          alert('Erreur lors de la suppression — vérifie la console pour le détail.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = '🗑️';
        }
      });

      currentPanel.querySelectorAll('[data-dash-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          dashboardActiveFilter = btn.dataset.dashFilter;
          renderDashboard();
        });
      });
      currentPanel.querySelectorAll('[data-dash-continent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          dashboardActiveContinent = btn.dataset.dashContinent;
          renderDashboard();
        });
      });

      const listEl = currentPanel.querySelector('#geo-companion-dashboard-list');
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
        listEl.innerHTML = `<div style="opacity:0.6; font-size:14px;">Aucun pays connu sur ce continent.</div>`;
        return;
      }

      listEl.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:3px;">
          ${countries
            .map((c) => {
              const color = successColor(c.successRate);
              return `
              <div style="
                display:flex; justify-content:space-between; align-items:center; gap:6px;
                padding:3px 10px; border-radius:6px; overflow:hidden;
                background:${color.wash}; border-left:4px solid ${color.solid};
              ">
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${flagEmojiFromCode(
                  c.code
                )} ${shortCountryName(c.code)}</span>
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

    function checkHomepage() {
      if (isHomepage()) {
        renderDashboard();
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