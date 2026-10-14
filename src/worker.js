// Pile of Shame — relais entre la page et les API Steam / SteamSpy.
// La clé Steam reste côté serveur (secret STEAM_API_KEY) et n'est jamais envoyée au navigateur.

const STEAM = 'https://api.steampowered.com';
const META_TTL = 60 * 60 * 24 * 30; // 30 jours de cache pour les infos d'un jeu
const MAX_IDS = 50;                  // jeux par appel à /api/meta (une seule requête Steam pour tout le lot)
const SPY_FALLBACK = 3;              // jeux absents de Steam demandés à SteamSpy, par appel (1 par seconde)
const SPY_DELAY = 1000;              // SteamSpy demande 1 requête par seconde
const LIVE_TTL = 60 * 30;            // 30 min de cache pour les joueurs connectés et le top Steam
const MAX_TTB_IDS = 50;              // jeux par appel à /api/ttb (2 requêtes IGDB quel que soit le nombre)
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

// Noms des tags Steam (tagid → nom anglais, les mêmes que ceux de SteamSpy). Cache 7 jours.
async function tagNames(env, ctx) {
  return cached('tagnames/v1', 60 * 60 * 24 * 7, ctx, async () => {
    const d = await getJSON(`${STEAM}/IStoreService/GetTagList/v1/?key=${env.STEAM_API_KEY}&language=english`);
    const out = {};
    for (const t of d?.response?.tags || []) if (t.tagid && t.name) out[t.tagid] = t.name;
    return Object.keys(out).length ? out : null;
  });
}

// Réduit une fiche IStoreBrowseService/GetItems au même format que SteamSpy (tags triés, avis).
export function normalizeStoreItem(item, names) {
  if (!item || (item.success != null && item.success !== 1 && item.success !== true)) return null;
  let tags = Array.isArray(item.tags)
    ? [...item.tags].sort((a, b) => (b.weight || 0) - (a.weight || 0)).map((t) => names[t.tagid])
    : (item.tagids || []).map((id) => names[id]);
  tags = tags.filter(Boolean).slice(0, 15);
  const rv = item.reviews?.summary_filtered || item.reviews?.summary_unfiltered;
  const count = Number(rv?.review_count) || 0;
  const pos = Math.round(count * (Number(rv?.percent_positive) || 0) / 100);
  if (!tags.length && !count) return null;
  return { tags, median: 0, average: 0, pos, neg: count - pos, ccu: 0 };
}

// Genres et avis de tout un lot en une requête Steam.
async function storeItems(ids, env, ctx) {
  const names = await tagNames(env, ctx);
  if (!names) throw new Error('tag list');
  const input = {
    ids: ids.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US', steam_realm: 1 },
    data_request: { include_tag_count: 20, include_reviews: true },
  };
  const d = await getJSON(`${STEAM}/IStoreBrowseService/GetItems/v1/?key=${env.STEAM_API_KEY}&input_json=${encodeURIComponent(JSON.stringify(input))}`);
  const out = {};
  for (const item of d?.response?.store_items || []) {
    const id = Number(item.appid ?? item.id);
    if (ids.includes(id)) out[id] = normalizeStoreItem(item, names);
  }
  return out;
}

// GET /api/meta : Steam d'abord (tout le lot d'un coup), SteamSpy en secours pour quelques jeux absents.
// Pas de cache par jeu côté Worker : c'est le navigateur qui garde les résultats (pos.meta).
async function meta(url, env, ctx) {
  const ids = parseIds(url, MAX_IDS);
  if (!ids.length) return json({ error: 'bad_input', message: 'Paramètre ids manquant.' }, 400);
  let out = {};
  if (env.STEAM_API_KEY) {
    try { out = await storeItems(ids, env, ctx); } catch (e) { out = {}; }
  }
  let spyCalls = 0;
  for (const id of ids) {
    if (out[id]) continue;
    out[id] = null;
    if (spyCalls >= SPY_FALLBACK) continue;
    if (spyCalls++) await sleep(SPY_DELAY);
    try { out[id] = normalizeSpy(await getJSON(`https://steamspy.com/api.php?request=appdetails&appid=${id}`)); } catch (e) { /* inconnu */ }
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

// --- IGDB (Twitch) : durées « time to beat ». Optionnel : secrets TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET. ---
async function igdbToken(env, ctx) {
  const req = new Request('https://pileofshame.cache/igdb-token/v1');
  const hit = await caches.default.match(req);
  if (hit) return (await hit.json()).token;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(env.TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`, { method: 'POST' });
  if (!r.ok) throw new Error('twitch ' + r.status);
  const d = await r.json();
  const ttl = Math.max(60, (Number(d.expires_in) || 3600) - 3600);
  ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify({ token: d.access_token }), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
  })));
  return d.access_token;
}

async function igdbQuery(env, token, endpoint, body) {
  const r = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'client-id': env.TWITCH_CLIENT_ID, authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
    body,
  });
  if (!r.ok) throw new Error(`igdb ${endpoint} ${r.status}`);
  return r.json();
}

// Réduit une ligne game_time_to_beats d'IGDB (secondes) en minutes.
export function normalizeTtb(row) {
  if (!row) return null;
  const min = (v) => (Number(v) > 0 ? Math.round(Number(v) / 60) : 0);
  return { hastily: min(row.hastily), normally: min(row.normally), completely: min(row.completely), count: Number(row.count) || 0 };
}

// Durées IGDB pour plusieurs jeux Steam en 2 requêtes : correspondance Steam → IGDB, puis temps pour finir.
async function igdbBatch(appids, env, ctx) {
  const token = await igdbToken(env, ctx);
  const uids = appids.map((id) => `"${id}"`).join(',');
  // La source « Steam » vaut 1. IGDB a renommé le champ category en external_game_source : on essaie les deux.
  let ext = null;
  for (const field of ['external_game_source', 'category']) {
    try {
      ext = await igdbQuery(env, token, 'external_games', `fields game,uid; where uid = (${uids}) & ${field} = 1; limit 500;`);
      if (ext.length) break;
    } catch (e) { /* champ inconnu : on tente l'autre */ }
  }
  if (!ext) throw new Error('igdb external_games');
  const byGame = {};
  for (const e of ext) if (e.game && appids.includes(Number(e.uid))) byGame[e.game] = Number(e.uid);
  const out = Object.fromEntries(appids.map((id) => [id, null]));
  const games = Object.keys(byGame);
  if (!games.length) return out;
  const rows = await igdbQuery(env, token, 'game_time_to_beats', `fields game_id,hastily,normally,completely,count; where game_id = (${games.join(',')}); limit 500;`);
  for (const r of rows) { const id = byGame[r.game_id]; if (id) out[id] = normalizeTtb(r); }
  return out;
}

// GET /api/ttb?ids=… : temps pour finir (minutes) d'après IGDB, null si IGDB ne connaît pas le jeu.
async function ttb(url, env, ctx) {
  const ids = parseIds(url, MAX_TTB_IDS);
  if (!ids.length) return json({ error: 'bad_input', message: 'Paramètre ids manquant.' }, 400);
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return json({ status: 'not_configured', ttb: {} });
  return json({ status: 'ok', ttb: await igdbBatch(ids, env, ctx) });
}

// Site officiel d'un jeu, lu sur sa fiche Steam. Seuls les liens http(s) sont acceptés.
export function siteFromStore(d, appid) {
  const raw = d?.[appid]?.success ? d[appid].data?.website : null;
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch (e) { return null; }
}

// GET /api/site?appid=X : redirige vers le site officiel du jeu, ou vers sa page Steam s'il n'en a pas.
async function site(url, ctx) {
  const appid = Number(url.searchParams.get('appid'));
  if (!Number.isInteger(appid) || appid <= 0) return json({ error: 'bad_input', message: 'Paramètre appid manquant.' }, 400);
  const store = `https://store.steampowered.com/app/${appid}`;
  let target = null;
  try {
    target = await cached(`site/v1/${appid}`, META_TTL, ctx, async () =>
      siteFromStore(await getJSON(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`), appid) || '');
  } catch (e) { target = null; }
  return Response.redirect(target || store, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' } });
    }
    try {
      if (url.pathname === '/api/profile') return await profile(url, env);
      if (url.pathname === '/api/meta') return await meta(url, env, ctx);
      if (url.pathname === '/api/players') return await players(url, ctx);
      if (url.pathname === '/api/charts') return await charts(env, ctx);
      if (url.pathname === '/api/ttb') return await ttb(url, env, ctx);
      if (url.pathname === '/api/site') return await site(url, ctx);
    } catch (e) {
      return json({ error: 'upstream', message: 'Steam ne répond pas pour le moment. Réessaie dans une minute.' }, 502);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
