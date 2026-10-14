import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseProfile, normalizeSpy } from '../src/worker.js';

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

test('meta : cache utilisé au second appel', async () => {
  const { calls, ctx, flush } = setup([['steamspy.com', { appid: 10, tags: { Puzzle: 5 }, median_forever: 120, positive: 1, negative: 0 }]]);
  const r1 = await worker.fetch(new Request('https://x.dev/api/meta?ids=10'), env, ctx);
  assert.deepEqual((await r1.json()).meta['10'].tags, ['Puzzle']);
  await flush();
  const before = calls.length;
  const r2 = await worker.fetch(new Request('https://x.dev/api/meta?ids=10'), env, ctx);
  assert.equal((await r2.json()).meta['10'].median, 120);
  assert.equal(calls.length, before);
});

test('clé absente → 500 explicite', async () => {
  const { ctx } = setup([]);
  const r = await worker.fetch(new Request('https://x.dev/api/profile?u=abc'), {}, ctx);
  assert.equal(r.status, 500);
});
