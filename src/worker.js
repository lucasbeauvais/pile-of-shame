// Pile of Shame — relais entre la page et les API Steam / SteamSpy.
// La clé Steam reste côté serveur (secret STEAM_API_KEY) et n'est jamais envoyée au navigateur.

const STEAM = 'https://api.steampowered.com';
const META_TTL = 60 * 60 * 24 * 30; // 30 jours de cache pour les infos d'un jeu
const MAX_IDS = 10;                  // jeux par appel à /api/meta
const SPY_DELAY = 1000;              // SteamSpy demande 1 requête par seconde
const LIVE_TTL = 60 * 30;            // 30 min de cache pour les joueurs connectés et le top Steam
const MAX_LIVE_IDS = 15;             // jeux par appel à /api/players (limite de sous-requêtes d'un Worker)

const CORS = { 'access-control-allow-origin': '*' };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'PileOfShame/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Accepte : URL /profiles/7656…, URL /id/pseudo, SteamID64 seul, ou pseudo seul.
export function parseProfile(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (m) return { steamid: m[1] };
  m = s.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  if (m) return { vanity: decodeURIComponent(m[1]) };
  if (/^\d{17}$/.test(s)) return { steamid: s };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { vanity: s };
  return null;
}

// Réduit la réponse SteamSpy à ce dont la page a besoin.
export function normalizeSpy(d) {
  if (!d || typeof d !== 'object' || !d.appid) return null;
  const tagObj = d.tags && !Array.isArray(d.tags) ? d.tags : {};
  const tags = Object.entries(tagObj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);
  return {
    tags,
    median: Number(d.median_forever) || 0,   // minutes, temps médian joué par les possesseurs
    average: Number(d.average_forever) || 0, // minutes
    pos: Number(d.positive) || 0,
    neg: Number(d.negative) || 0,
    ccu: Number(d.ccu) || 0,                 // pic de joueurs simultanés la veille, sert de point de comparaison
  };
}

// Réduit le top « jeux les plus joués » de Steam. lastWeekRank vaut 0 pour une nouvelle entrée.
export function normalizeCharts(d) {
  const ranks = d?.response?.ranks;
  if (!Array.isArray(ranks)) return null;
  return ranks
    .filter((r) => r && Number(r.appid) > 0)
    .map((r) => ({
      appid: Number(r.appid),
      rank: Number(r.rank) || 0,
      lastWeekRank: Number(r.last_week_rank) || 0,
      peak: Number(r.peak_in_game) || 0,
    }));
}

async function cached(key, ttl, ctx, load) {
  const cache = caches.default;
  const req = new Request(`https://pileofshame.cache/${key}`);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const v = await load();
  if (v != null) {
    ctx.waitUntil(cache.put(req, new Response(JSON.stringify(v), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    })));
  }
  return v;
}

function parseIds(url, max) {
  return [...new Set(
    (url.searchParams.get('ids') || '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  )].slice(0, max);
}

async function profile(url, env) {
  const key = env.STEAM_API_KEY;
  if (!key) return json({ error: 'config', message: "Le serveur n'a pas de clé API Steam configurée." }, 500);

  const p = parseProfile(url.searchParams.get('u'));
  if (!p) {
    return json({
      error: 'bad_input',
      message: "Je n'ai pas reconnu ce profil. Colle l'adresse de ta page de profil Steam (steamcommunity.com/id/… ou steamcommunity.com/profiles/…).",
    }, 400);
  }

  let steamid = p.steamid;
  if (!steamid) {
    const r = await getJSON(`${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(p.vanity)}`);
    if (r?.response?.success !== 1) {
      return json({ error: 'not_found', message: `Aucun profil Steam ne correspond à « ${p.vanity} ».` }, 404);
    }
    steamid = r.response.steamid;
  }

  const [owned, summary] = await Promise.all([
    getJSON(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamid}&include_appinfo=1&include_played_free_games=1&format=json`),
    getJSON(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamid}`).catch(() => null),
  ]);

  const player = summary?.response?.players?.[0] || null;
  const games = owned?.response?.games;
  if (!Array.isArray(games)) {
    return json({
      error: 'private',
      steamid,
      persona: player?.personaname || null,
      message: "Cette bibliothèque est privée. Dans Steam : Profil > Modifier le profil > Paramètres de confidentialité, passe « Détails des jeux » en Public, puis réessaie.",
    }, 403);
  }

  return json({
    steamid,
    persona: player?.personaname || null,
    avatar: player?.avatarmedium || null,
    games: games.map((g) => ({
      appid: g.appid,
      name: g.name || 'App ' + g.appid,
      playtime: g.playtime_forever || 0,
      lastPlayed: g.rtime_last_played || 0,
    })),
  }, 200, { 'cache-control': 'public, max-age=300' });
}

async function meta(url, ctx) {
  const ids = parseIds(url, MAX_IDS);
  if (!ids.length) return json({ error: 'bad_input', message: 'Paramètre ids manquant.' }, 400);

  const cache = caches.default;
  const out = {};
  let upstreamCalls = 0;

  for (const id of ids) {
    const cacheKey = new Request(`https://pileofshame.cache/meta/v1/${id}`);
    const hit = await cache.match(cacheKey);
    if (hit) { out[id] = await hit.json(); continue; }

    if (upstreamCalls++) await sleep(SPY_DELAY);
    let m = null;
    try {
      m = normalizeSpy(await getJSON(`https://steamspy.com/api.php?request=appdetails&appid=${id}`));
    } catch (e) {
      m = null; // SteamSpy indisponible : la page affichera « durée inconnue »
    }
    out[id] = m;
    if (m) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(m), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${META_TTL}` },
      })));
    }
  }
  return json({ meta: out });
}

// Joueurs connectés en ce moment, jeu par jeu. null si Steam ne connaît pas le chiffre.
async function players(url, ctx) {
  const ids = parseIds(url, MAX_LIVE_IDS);
  if (!ids.length) return json({ error: 'bad_input', message: 'Paramètre ids manquant.' }, 400);
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      out[id] = await cached(`players/v1/${id}`, LIVE_TTL, ctx, async () => {
        const r = await getJSON(`${STEAM}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`);
        return r?.response?.result === 1 ? Number(r.response.player_count) || 0 : null;
      });
    } catch (e) {
      out[id] = null;
    }
  }));
  return json({ players: out });
}

// Top 100 des jeux les plus joués sur Steam, avec leur rang de la semaine précédente.
async function charts(env, ctx) {
  const key = env.STEAM_API_KEY ? `key=${env.STEAM_API_KEY}&` : '';
  const ranks = await cached('charts/v1', LIVE_TTL, ctx, async () =>
    normalizeCharts(await getJSON(`${STEAM}/ISteamChartsService/GetMostPlayedGames/v1/?${key}`)));
  if (!ranks) return json({ error: 'upstream', message: 'Le classement Steam est indisponible pour le moment.' }, 502);
  return json({ ranks }, 200, { 'cache-control': `public, max-age=${LIVE_TTL}` });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' } });
    }
    try {
      if (url.pathname === '/api/profile') return await profile(url, env);
      if (url.pathname === '/api/meta') return await meta(url, ctx);
      if (url.pathname === '/api/players') return await players(url, ctx);
      if (url.pathname === '/api/charts') return await charts(env, ctx);
    } catch (e) {
      return json({ error: 'upstream', message: 'Steam ne répond pas pour le moment. Réessaie dans une minute.' }, 502);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
