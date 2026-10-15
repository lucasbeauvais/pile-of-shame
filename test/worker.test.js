import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseProfile, normalizeSpy, normalizeCharts, normalizeTtb, siteFromStore, normalizeStoreItem } from '../src/worker.js';

test('parseProfile reconnaît les formats courants', () => {
  assert.deepEqual(parseProfile('https://steamcommunity.com/profiles/76561197960287930/'), { steamid: '76561197960287930' });
  assert.deepEqual(parseProfile('steamcommunity.com/id/gabelogannewell'), { vanity: 'gabelogannewell' });
  assert.deepEqual(parseProfile('https://steamcommunity.com/id/Lucas_42/games/?tab=all'), { vanity: 'Lucas_42' });
  assert.deepEqual(parseProfile('76561197960287930'), { steamid: '76561197960287930' });
  assert.deepEqual(parseProfile('monpseudo'), { vanity: 'monpseudo' });
  assert.equal(parseProfile('https://example.com/rien'), null);
  assert.equal(parseProfile(''), null);
});

test('normalizeSpy garde les tags triés et les durées', () => {
  const m = normalizeSpy({ appid: 1, tags: { RPG: 50, Roguelike: 300, Indie: 10 }, median_forever: 480, average_forever: 900, positive: 90, negative: 10 });
  assert.deepEqual(m.tags, ['Roguelike', 'RPG', 'Indie']);
  assert.equal(m.median, 480);
  assert.equal(m.pos, 90);
  assert.equal(m.ccu, 0);
  assert.equal(normalizeSpy({ appid: 3, ccu: 812 }).ccu, 812);
  assert.deepEqual(normalizeSpy({ appid: 2, tags: [] }).tags, []);
  assert.equal(normalizeSpy(null), null);
});

// --- faux environnement Cloudflare ---
function setup(routes) {
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    for (const [frag, body] of routes) if (String(u).includes(frag)) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('nope', { status: 500 });
  };
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => { const v = store.get(req.url); return v ? new Response(v) : undefined; },
    put: async (req, res) => { store.set(req.url, await res.text()); },
  } };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  return { calls, ctx, flush: () => Promise.all(waits) };
}
const env = { STEAM_API_KEY: 'TESTKEY' };

test('profil public via pseudo', async () => {
  const { calls, ctx } = setup([
    ['ResolveVanityURL', { response: { success: 1, steamid: '76561197960287930' } }],
    ['GetOwnedGames', { response: { game_count: 2, games: [{ appid: 10, name: 'A', playtime_forever: 0 }, { appid: 20, name: 'B', playtime_forever: 300, rtime_last_played: 5 }] } }],
    ['GetPlayerSummaries', { response: { players: [{ personaname: 'Lucas', avatarmedium: 'x.jpg' }] } }],
  ]);
  const r = await worker.fetch(new Request('https://x.dev/api/profile?u=' + encodeURIComponent('https://steamcommunity.com/id/lucas')), env, ctx);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.persona, 'Lucas');
  assert.equal(d.games.length, 2);
  assert.deepEqual(d.games[1], { appid: 20, name: 'B', playtime: 300, lastPlayed: 5 });
  assert.ok(calls.every((c) => !c.includes('undefined')));
});

test('profil privé → 403 avec explication', async () => {
  const { ctx } = setup([
    ['GetOwnedGames', { response: {} }],
    ['GetPlayerSummaries', { response: { players: [] } }],
  ]);
  const r = await worker.fetch(new Request('https://x.dev/api/profile?u=76561197960287930'), env, ctx);
  assert.equal(r.status, 403);
  assert.match((await r.json()).message, /privée/);
});

test('pseudo inconnu → 404', async () => {
  const { ctx } = setup([['ResolveVanityURL', { response: { success: 42 } }]]);
  const r = await worker.fetch(new Request('https://x.dev/api/profile?u=personne'), env, ctx);
  assert.equal(r.status, 404);
});

test('normalizeStoreItem : tags par poids, avis convertis', () => {
  const names = { 1: 'RPG', 2: 'Co-op', 3: 'Indie' };
  const m = normalizeStoreItem({ appid: 10, success: 1, tags: [{ tagid: 3, weight: 10 }, { tagid: 1, weight: 90 }, { tagid: 2, weight: 50 }, { tagid: 99, weight: 5 }], reviews: { summary_filtered: { review_count: 200, percent_positive: 90 } } }, names);
  assert.deepEqual(m, { tags: ['RPG', 'Co-op', 'Indie'], median: 0, average: 0, pos: 180, neg: 20, ccu: 0, ctrl: null, deck: null, v: 2 });
  assert.deepEqual(normalizeStoreItem({ appid: 11, tagids: [2, 1] }, names).tags, ['Co-op', 'RPG']);
  assert.equal(normalizeStoreItem({ appid: 12, success: 2 }, names), null);
  assert.equal(normalizeStoreItem({ appid: 13 }, names), null);
});

test('meta : tout le lot en une requête Steam, SteamSpy pour les absents', async () => {
  const { calls, ctx } = setup([
    ['GetTagList', { response: { tags: [{ tagid: 1, name: 'Puzzle' }] } }],
    ['GetItems', { response: { store_items: [{ appid: 10, success: 1, tags: [{ tagid: 1, weight: 1 }], reviews: { summary_filtered: { review_count: 10, percent_positive: 100 } } }] } }],
    ['steamspy.com', { appid: 20, tags: { Racing: 5 }, median_forever: 120, positive: 1, negative: 0 }],
  ]);
  const r = await worker.fetch(new Request('https://x.dev/api/meta?ids=10,20'), env, ctx);
  const d = (await r.json()).meta;
  assert.deepEqual(d['10'].tags, ['Puzzle']);
  assert.equal(d['10'].pos, 10);
  assert.deepEqual(d['20'].tags, ['Racing']);
  assert.equal(calls.filter((c) => c.includes('GetItems')).length, 1);
  assert.equal(calls.filter((c) => c.includes('steamspy')).length, 1);
  const input = JSON.parse(decodeURIComponent(calls.find((c) => c.includes('GetItems')).split('input_json=')[1]));
  assert.deepEqual(input.ids, [{ appid: 10 }, { appid: 20 }]);
});

test('meta : Steam en panne → SteamSpy pour 3 jeux au plus', async () => {
  const { calls, ctx } = setup([['steamspy.com', { appid: 1, tags: { RPG: 1 } }]]);
  const r = await worker.fetch(new Request('https://x.dev/api/meta?ids=1,2,3,4,5'), env, ctx);
  const d = (await r.json()).meta;
  assert.equal(Object.keys(d).length, 5);
  assert.equal(calls.filter((c) => c.includes('steamspy')).length, 3);
  assert.equal(d['5'], null);
});

test('clé absente → 500 explicite', async () => {
  const { ctx } = setup([]);
  const r = await worker.fetch(new Request('https://x.dev/api/profile?u=abc'), {}, ctx);
  assert.equal(r.status, 500);
});

test('normalizeCharts garde rang, rang précédent et pic', () => {
  const c = normalizeCharts({ response: { ranks: [
    { rank: 1, appid: 730, last_week_rank: 1, peak_in_game: 1500000 },
    { rank: 12, appid: 1237950, last_week_rank: 0, peak_in_game: 40000 },
    { rank: 13 },
  ] } });
  assert.deepEqual(c, [
    { appid: 730, rank: 1, lastWeekRank: 1, peak: 1500000 },
    { appid: 1237950, rank: 12, lastWeekRank: 0, peak: 40000 },
  ]);
  assert.equal(normalizeCharts({}), null);
});

test('players : compte des joueurs, null si inconnu, mis en cache', async () => {
  const { calls, ctx, flush } = setup([
    ['appid=10', { response: { player_count: 4321, result: 1 } }],
    ['appid=20', { response: { result: 42 } }],
  ]);
  const r = await worker.fetch(new Request('https://x.dev/api/players?ids=10,20,30'), env, ctx);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).players, { 10: 4321, 20: null, 30: null });
  await flush();
  const before = calls.length;
  const r2 = await worker.fetch(new Request('https://x.dev/api/players?ids=10'), env, ctx);
  assert.equal((await r2.json()).players['10'], 4321);
  assert.equal(calls.length, before);
});

test('players : ids manquants → 400', async () => {
  const { ctx } = setup([]);
  const r = await worker.fetch(new Request('https://x.dev/api/players'), env, ctx);
  assert.equal(r.status, 400);
});

test('charts : top Steam normalisé, 502 si Steam ne répond pas', async () => {
  let { ctx } = setup([['GetMostPlayedGames', { response: { ranks: [{ rank: 3, appid: 1237950, last_week_rank: 40, peak_in_game: 9000 }] } }]]);
  const r = await worker.fetch(new Request('https://x.dev/api/charts'), env, ctx);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).ranks, [{ appid: 1237950, rank: 3, lastWeekRank: 40, peak: 9000 }]);
  ({ ctx } = setup([]));
  const r2 = await worker.fetch(new Request('https://x.dev/api/charts'), env, ctx);
  assert.equal(r2.status, 502);
});

test('normalizeTtb convertit les secondes IGDB en minutes', () => {
  assert.deepEqual(normalizeTtb({ hastily: 36000, normally: 72000, completely: 0, count: 12 }), { hastily: 600, normally: 1200, completely: 0, count: 12 });
  assert.equal(normalizeTtb(undefined), null);
});

test('ttb : rien sans identifiants Twitch', async () => {
  const { calls, ctx } = setup([]);
  const r = await worker.fetch(new Request('https://x.dev/api/ttb?ids=10,20'), env, ctx);
  assert.deepEqual(await r.json(), { status: 'not_configured', ttb: {} });
  assert.equal(calls.length, 0);
});

test('ttb : durées IGDB en lot, null pour les jeux inconnus', async () => {
  const { calls, ctx } = setup([
    ['oauth2/token', { access_token: 'T', expires_in: 5000000 }],
    ['v4/external_games', [{ id: 1, game: 77, uid: '10' }, { id: 2, game: 88, uid: '20' }]],
    ['v4/game_time_to_beats', [{ game_id: 77, hastily: 18000, normally: 36000, completely: 72000, count: 40 }]],
  ]);
  const r = await worker.fetch(new Request('https://x.dev/api/ttb?ids=10,20,30'), { ...env, TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 's' }, ctx);
  const d = await r.json();
  assert.equal(d.status, 'ok');
  assert.deepEqual(d.ttb, { 10: { hastily: 300, normally: 600, completely: 1200, count: 40 }, 20: null, 30: null });
  assert.equal(calls.filter((c) => c.includes('igdb.com')).length, 2);
});

test('siteFromStore : site http(s) seulement', () => {
  assert.equal(siteFromStore({ 10: { success: true, data: { website: 'https://jeu.example/ ' } } }, 10), 'https://jeu.example/');
  assert.equal(siteFromStore({ 10: { success: true, data: { website: 'javascript:alert(1)' } } }, 10), null);
  assert.equal(siteFromStore({ 10: { success: true, data: { website: null } } }, 10), null);
  assert.equal(siteFromStore({ 10: { success: false } }, 10), null);
});

test('site : redirige vers le site du jeu, sinon vers la page Steam', async () => {
  let { ctx } = setup([['appdetails?appids=10', { 10: { success: true, data: { website: 'https://jeu.example/' } } }]]);
  let r = await worker.fetch(new Request('https://x.dev/api/site?appid=10'), env, ctx);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://jeu.example/');
  ({ ctx } = setup([['appdetails?appids=20', { 20: { success: true, data: {} } }]]));
  r = await worker.fetch(new Request('https://x.dev/api/site?appid=20'), env, ctx);
  assert.equal(r.headers.get('location'), 'https://store.steampowered.com/app/20');
  ({ ctx } = setup([]));
  r = await worker.fetch(new Request('https://x.dev/api/site?appid=30'), env, ctx);
  assert.equal(r.headers.get('location'), 'https://store.steampowered.com/app/30');
});

test('normalizeStoreItem : manette et Steam Deck', () => {
  const names = { 1: 'FPS', 2: 'Full controller support', 3: 'Controller' };
  const base = { appid: 1, success: 1, reviews: { summary_filtered: { review_count: 10, percent_positive: 50 } } };
  const full = normalizeStoreItem({ ...base, categories: { controller_categoryids: [28] }, platforms: { steam_deck_compat_category: 3 } }, names);
  assert.equal(full.ctrl, 'full'); assert.equal(full.deck, 3);
  assert.equal(normalizeStoreItem({ ...base, categories: { feature_categoryids: [2, 18] } }, names).ctrl, 'partial');
  const none = normalizeStoreItem({ ...base, categories: { feature_categoryids: [1, 2] }, platforms: { steam_deck_compat_category: 1 } }, names);
  assert.equal(none.ctrl, 'none'); assert.equal(none.deck, 1);
  assert.equal(normalizeStoreItem({ ...base, tags: [{ tagid: 2, weight: 1 }] }, names).ctrl, 'full');
  assert.equal(normalizeStoreItem({ ...base, tags: [{ tagid: 1, weight: 9 }, { tagid: 3, weight: 1 }] }, names).ctrl, 'partial');
  assert.equal(normalizeStoreItem({ ...base, tags: [{ tagid: 1, weight: 9 }] }, names).ctrl, null);
});

test('meta : demande plateformes et infos de base à Steam', async () => {
  const { calls, ctx } = setup([
    ['GetTagList', { response: { tags: [{ tagid: 1, name: 'FPS' }] } }],
    ['GetItems', { response: { store_items: [{ appid: 730, success: 1, tags: [{ tagid: 1, weight: 1 }], categories: { feature_categoryids: [1] }, platforms: { steam_deck_compat_category: 1 } }] } }],
  ]);
  const d = (await (await worker.fetch(new Request('https://x.dev/api/meta?ids=730'), env, ctx)).json()).meta;
  assert.equal(d['730'].ctrl, 'none'); assert.equal(d['730'].deck, 1);
  const input = JSON.parse(decodeURIComponent(calls.find((c) => c.includes('GetItems')).split('input_json=')[1]));
  assert.equal(input.data_request.include_platforms, true);
  assert.equal(input.data_request.include_basic_info, true);
});
