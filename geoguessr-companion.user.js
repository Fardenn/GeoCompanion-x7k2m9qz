// ==UserScript==
// @name         GeoGuessr Companion
// @namespace    geoguessr-companion
// @version      2.21
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
  // Agrégation des stats par pays, avec filtres temporels
  // (24h / 7j / 30j / total). Les agrégats sont calculés côté
  // client à partir des lignes brutes — largement suffisant pour
  // le volume attendu (2-3 utilisateurs).
  //
  // Expose GeoCompanion.stats.getCountryStats(countryCode, filterKey)
  // ============================================================
  (function statsModule() {
    function sinceClauseFor(filterKey) {
      if (filterKey === 'all') return '';
      const now = new Date();
      const hoursByFilter = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
      const hours = hoursByFilter[filterKey];
      if (!hours) return '';
      const since = new Date(now.getTime() - hours * 3600 * 1000);
      return `&played_at=gte.${since.toISOString()}`;
    }

    // Calcule les agrégats communs (nb rounds, score moyen, meilleur/pire, taux
    // de réussite) à partir d'un tableau de lignes brutes — réutilisé par
    // getCountryStats, getContinentStats et getMapStats pour éviter la
    // duplication.
    function computeAggregateStats(rows) {
      if (!rows || rows.length === 0) {
        return { count: 0, avgScore: null, bestScore: null, worstScore: null, successRate: null };
      }

      const scores = rows.map((r) => r.score).filter((s) => s != null);
      const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const bestScore = scores.length ? Math.max(...scores) : null;
      const worstScore = scores.length ? Math.min(...scores) : null;

      const evaluatedRows = rows.filter((r) => r.country_correct != null);
      const successRate = evaluatedRows.length
        ? Math.round((evaluatedRows.filter((r) => r.country_correct).length / evaluatedRows.length) * 100)
        : null;

      return { count: rows.length, avgScore, bestScore, worstScore, successRate };
    }

    async function getCountryStats(countryCode, filterKey = 'all') {
      const query = `select=score,distance_km,country_correct&country_code=eq.${countryCode}${sinceClauseFor(
        filterKey
      )}`;
      const rows = await supabaseClient.select('rounds', query);
      return computeAggregateStats(rows);
    }

    async function getContinentStats(continent, filterKey = 'all') {
      const query = `select=score,distance_km,country_correct&continent=eq.${continent}${sinceClauseFor(
        filterKey
      )}`;
      const rows = await supabaseClient.select('rounds', query);
      return computeAggregateStats(rows);
    }

    async function getMapStats(mapId, filterKey = 'all') {
      const query = `select=score,distance_km,country_correct&map_id=eq.${encodeURIComponent(
        mapId
      )}${sinceClauseFor(filterKey)}`;
      const rows = await supabaseClient.select('rounds', query);
      return computeAggregateStats(rows);
    }

    // Comparaison entre joueurs pour un pays donné : moyenne/taux de réussite
    // par joueur, triés du meilleur au moins bon score moyen.
    async function getPlayerComparison(countryCode, filterKey = 'all') {
      const query = `select=player_name,score,country_correct&country_code=eq.${countryCode}${sinceClauseFor(
        filterKey
      )}`;
      const rows = await supabaseClient.select('rounds', query);
      if (!rows || rows.length === 0) return [];

      const byPlayer = {};
      for (const r of rows) {
        if (!r.player_name) continue;
        if (!byPlayer[r.player_name]) byPlayer[r.player_name] = { scores: [], corrects: [] };
        if (r.score != null) byPlayer[r.player_name].scores.push(r.score);
        if (r.country_correct != null) byPlayer[r.player_name].corrects.push(r.country_correct);
      }

      return Object.entries(byPlayer)
        .map(([player, data]) => ({
          player,
          count: data.scores.length,
          avgScore: data.scores.length
            ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length)
            : null,
          successRate: data.corrects.length
            ? Math.round((data.corrects.filter(Boolean).length / data.corrects.length) * 100)
            : null,
        }))
        .sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
    }

    GeoCompanion.stats = { getCountryStats, getContinentStats, getMapStats, getPlayerComparison };
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
  // Sens de circulation par pays. Une estimation par défaut est
  // fournie (connaissance générale, pas garantie fiable à 100%),
  // et peut être corrigée manuellement — la correction est alors
  // stockée dans Supabase (table country_info) et prime sur
  // l'estimation par défaut pour tout le monde.
  // ============================================================
  (function countryInfoModule() {
    // Pays roulant à gauche (liste best-effort). Tout pays absent de cette
    // liste est supposé rouler à droite par défaut.
    const LEFT_HAND_TRAFFIC = new Set([
      'AU', 'BD', 'BS', 'BB', 'BN', 'BT', 'BW', 'CY', 'DM', 'FJ', 'GB', 'GD', 'GG',
      'GY', 'HK', 'ID', 'IE', 'IM', 'IN', 'JE', 'JM', 'JP', 'KE', 'KI', 'KN', 'LC',
      'LK', 'LS', 'MO', 'MT', 'MU', 'MV', 'MW', 'MY', 'MZ', 'NA', 'NP', 'NR', 'NZ',
      'PG', 'PK', 'SB', 'SC', 'SG', 'SR', 'SZ', 'TH', 'TL', 'TO', 'TT', 'TV', 'TZ',
      'UG', 'VC', 'WS', 'ZA', 'ZM', 'ZW', 'BM', 'KY', 'VG', 'VI', 'TC', 'AI', 'MS',
      'FK', 'SH',
    ]);

    function defaultDrivingSide(countryCode) {
      if (!countryCode) return null;
      return LEFT_HAND_TRAFFIC.has(countryCode.toUpperCase()) ? 'left' : 'right';
    }

    // Retourne { side: 'left'|'right'|null, isOverride: bool }
    async function getDrivingSide(countryCode) {
      if (!countryCode) return { side: null, isOverride: false };
      const upper = countryCode.toUpperCase();
      const rows = await supabaseClient.select(
        'country_info',
        `select=driving_side&country_code=eq.${upper}`
      );
      if (rows && rows.length > 0 && rows[0].driving_side) {
        return { side: rows[0].driving_side, isOverride: true };
      }
      return { side: defaultDrivingSide(upper), isOverride: false };
    }

    async function setDrivingSide(countryCode, side) {
      if (!countryCode || !['left', 'right'].includes(side)) return false;
      return supabaseClient.insert(
        'country_info',
        { country_code: countryCode.toUpperCase(), driving_side: side, updated_at: new Date().toISOString() },
        { merge: true }
      );
    }

    GeoCompanion.countryInfo = { getDrivingSide, setDrivingSide };
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
          height: 80vh;
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
          width: 400px;
          max-width: 33vw;
          height: 80vh;
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
            </div>
            <div>Score : ${row.score ?? '-'} pts</div>
            <div>Distance : ${row.distance_km != null ? row.distance_km.toFixed(1) + ' km' : '-'}</div>
            <div>Résultat : ${
              row.country_correct == null ? '…' : row.country_correct ? '✅ Pays trouvé' : '❌ Pays raté'
            }</div>
          </div>
        </div>
        <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
        <div id="geo-companion-stats">Chargement des statistiques…</div>
        <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
        <div id="geo-companion-continent-stats"></div>
        <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
        <div id="geo-companion-map-stats"></div>
        <hr style="opacity:0.15; margin:12px 0; border-color:#888;">
        <div id="geo-companion-comparison"></div>
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

    async function renderStats(row, activeFilter) {
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
        btn.addEventListener('click', () => renderStats(row, btn.dataset.filter));
      });

      const stats = await GeoCompanion.stats.getCountryStats(row.country_code, activeFilter);
      const body = document.getElementById('geo-companion-stats-body');
      if (body) body.innerHTML = aggregateStatsHtml(stats);

      await renderContinentStats(row, activeFilter);
      await renderMapStats(row, activeFilter);
      await renderComparison(row, activeFilter);
    }

    async function renderContinentStats(row, activeFilter) {
      const container = document.getElementById('geo-companion-continent-stats');
      if (!container) return;
      if (!row.continent) {
        container.innerHTML = '';
        return;
      }

      const label = CONTINENT_LABELS[row.continent] || row.continent;
      container.innerHTML = `<div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🌍 ${label}</div><div style="opacity:0.6;">Chargement…</div>`;

      const stats = await GeoCompanion.stats.getContinentStats(row.continent, activeFilter);
      const currentContainer = document.getElementById('geo-companion-continent-stats');
      if (!currentContainer) return; // panneau remplacé entre-temps

      currentContainer.innerHTML = `
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🌍 ${label}</div>
        <div style="opacity:0.85;">${aggregateStatsHtml(stats)}</div>
      `;
    }

    async function renderMapStats(row, activeFilter) {
      const container = document.getElementById('geo-companion-map-stats');
      if (!container) return;
      if (!row.map_id) {
        container.innerHTML = '';
        return;
      }

      const label = row.map_name || row.map_id;
      container.innerHTML = `<div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🗺️ ${escapeHtml(
        label
      )}</div><div style="opacity:0.6;">Chargement…</div>`;

      const stats = await GeoCompanion.stats.getMapStats(row.map_id, activeFilter);
      const currentContainer = document.getElementById('geo-companion-map-stats');
      if (!currentContainer) return; // panneau remplacé entre-temps

      currentContainer.innerHTML = `
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">🗺️ ${escapeHtml(label)}</div>
        <div style="opacity:0.85;">${aggregateStatsHtml(stats)}</div>
      `;
    }

    async function renderComparison(row, activeFilter) {
      const container = document.getElementById('geo-companion-comparison');
      if (!container) return;

      container.innerHTML = `<div style="font-weight:bold; font-size:17px; margin-bottom:8px;">👥 Comparaison</div><div style="opacity:0.6;">Chargement…</div>`;

      const comparison = await GeoCompanion.stats.getPlayerComparison(row.country_code, activeFilter);
      const currentContainer = document.getElementById('geo-companion-comparison');
      if (!currentContainer) return; // panneau remplacé entre-temps

      if (comparison.length === 0) {
        currentContainer.innerHTML = `
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

      currentContainer.innerHTML = `
        <div style="font-weight:bold; font-size:17px; margin-bottom:8px;">👥 Comparaison</div>
        ${rowsHtml}
      `;
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function tipHtml(tip) {
      const buttonsHtml = `
        <button data-edit-tip="${tip.id}" style="background:rgba(0,0,0,0.55); border:none; color:#4a9eff; cursor:pointer; font-size:16px; padding:4px 6px; border-radius:5px;" title="Modifier">✏️</button>
        <button data-delete-tip="${tip.id}" style="background:rgba(0,0,0,0.55); border:none; color:#ff6b6b; cursor:pointer; font-size:16px; padding:4px 6px; border-radius:5px;" title="Supprimer">🗑️</button>
      `;

      return `
        <div style="background:#2a2a3d; border-radius:8px; padding:6px 8px; margin-bottom:6px; font-size:16px;">
          ${tip.content ? `<div style="margin-bottom:4px; white-space:pre-wrap; font-size:18px;">${escapeHtml(tip.content)}</div>` : ''}
          ${
            tip.image_url
              ? `
                <div style="position:relative; margin-bottom:2px;">
                  <img src="${tip.image_url}" style="width:100%; max-height:200px; object-fit:contain; border-radius:5px; background:#111; display:block;">
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
      const tld = tldFromCode(row.country_code);
      const drivingInfo = await GeoCompanion.countryInfo.getDrivingSide(row.country_code);

      tipsPanel.innerHTML = `
        <div style="font-weight:bold; font-size:22px; margin-bottom:6px; flex-shrink:0;">
          💡 Tips ${
            plonkitUrl
              ? `<a href="${plonkitUrl}" target="_blank" rel="noopener noreferrer" style="color:#4a9eff; text-decoration:underline; font-size:17px;">🔗 Plonkit</a>`
              : ''
          }
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:16px; font-weight:700; opacity:0.9; margin-bottom:8px; flex-shrink:0;">
          <span>🌐 ${tld || '-'}</span>
          <span id="geo-companion-driving-side"></span>
        </div>
        <div id="geo-companion-tips-list" style="flex:1; overflow-y:auto; min-height:0;">
          ${
            tips.length === 0
              ? `<div style="opacity:0.6; font-size:16px;">Aucun tip pour ce pays pour l'instant.</div>`
              : tips.map(tipHtml).join('')
          }
        </div>
        <button id="geo-companion-add-tip-btn" style="
          margin-top:6px; padding:7px; border-radius:8px; border:none; cursor:pointer;
          background:#33334a; color:white; font-size:16px; width:100%; flex-shrink:0;
        ">+ Ajouter un tip</button>
        <div id="geo-companion-tip-form" style="flex-shrink:0;"></div>
      `;

      renderDrivingSide(tipsPanel, row, drivingInfo);

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

    function renderDrivingSide(tipsPanel, row, info) {
      const container = tipsPanel.querySelector('#geo-companion-driving-side');
      if (!container) return;

      container.innerHTML = `
        <span>🚗 ${drivingSideLabel(info.side)}${info.isOverride ? '' : ' (estimé)'}</span>
        <button data-edit-driving style="background:none; border:none; color:#4a9eff; cursor:pointer; font-size:15px;" title="Corriger">✏️</button>
      `;

      container.querySelector('[data-edit-driving]').addEventListener('click', () => {
        container.innerHTML = `
          <button data-side="left" style="padding:3px 6px; border-radius:5px; border:none; cursor:pointer; background:${
            info.side === 'left' ? '#4a9eff' : '#33334a'
          }; color:white; font-size:11px;">⬅️ Gauche</button>
          <button data-side="right" style="padding:3px 6px; border-radius:5px; border:none; cursor:pointer; background:${
            info.side === 'right' ? '#4a9eff' : '#33334a'
          }; color:white; font-size:11px;">➡️ Droite</button>
        `;

        container.querySelectorAll('[data-side]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await GeoCompanion.countryInfo.setDrivingSide(row.country_code, btn.dataset.side);
            const updated = await GeoCompanion.countryInfo.getDrivingSide(row.country_code);
            renderDrivingSide(tipsPanel, row, updated);
          });
        });
      });
    }

    GeoCompanion.on('roundRecorded', async (row) => {
      if (!row.country_code) return; // pas de pays détecté, rien d'exploitable à afficher
      const panel = ensurePanel();
      renderRoundResult(panel, row);
      await renderStats(row, 'all');
      await renderTips(row);
    });
  })();

  console.log('[GeoCompanion] Script chargé, en attente d\'events GeoGuessr...');
})();
