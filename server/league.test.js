const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Game = require('../game_core.js');
const { createLeagueService, createLeagueServer, validateTelegramInitData, seasonWindow } = require('./league.js');

const BOT_TOKEN = 'test-bot-token';
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function signedInitData(user, now = NOW, token = BOT_TOKEN) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

function gameWith({ parts = 0, lathe = 0 } = {}) {
  return {
    ...Game,
    newGame() {
      const state = Game.newGame();
      state.resources = { ore: 0, steel: 0, parts };
      state.buildings = { mine: 0, smelter: 0, workshop: 0, power: 0 };
      state.idleOwned = { press: 0, lathe, auto: 0, belt: 0, gold: 0 };
      return state;
    }
  };
}

function fixture({ clock = () => NOW, game = Game } = {}) {
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock, game });
  return { db, service };
}

const userData = { id: 77123, first_name: 'Рус', username: 'rus' };
const user = { id: String(userData.id), displayName: '@rus' };

test('Telegram initData is verified, tampering and stale signatures are rejected', () => {
  const initData = signedInitData(userData);
  assert.deepEqual(validateTelegramInitData(initData, BOT_TOKEN, NOW), {
    id: '77123', displayName: '@rus'
  });
  assert.throws(() => validateTelegramInitData(`${initData}&role=admin`, BOT_TOKEN, NOW), /подпись/i);
  assert.throws(() => validateTelegramInitData(`${initData}&hash=${'0'.repeat(64)}`, BOT_TOKEN, NOW), /повтор/i);
  assert.throws(() => validateTelegramInitData(signedInitData(userData, NOW - 25 * 60 * 60 * 1000), BOT_TOKEN, NOW), /устар/i);
});

test('season windows use UTC calendar months', () => {
  assert.deepEqual(seasonWindow(Date.UTC(2026, 10, 7)), {
    id: '2026-11', startsAt: Date.UTC(2026, 10, 1), endsAt: Date.UTC(2026, 11, 1)
  });
});

test('a new UTC month starts a fresh league factory and score', () => {
  let now = Date.UTC(2026, 10, 30, 23, 59, 50);
  const { db, service } = fixture({ clock: () => now, game: gameWith() });
  service.getState(user);
  const earned = service.act(user, { actionId: 'tap-nov-0001', type: 'tap' });
  assert.equal(earned.state.money, 1);
  assert.equal(earned.league.seasonId, '2026-11');

  now = Date.UTC(2026, 11, 1, 0, 0, 5);
  const next = service.getState(user);
  assert.equal(next.league.seasonId, '2026-12');
  assert.equal(next.league.points, 0);
  assert.equal(next.state.money, 0);
  assert.deepEqual(next.state.resources, { ore: 0, steel: 0, parts: 0 });
  assert.equal(db.prepare('SELECT points FROM season_scores WHERE season_id = ?').get('2026-11').points, 0);
  db.close();
});

test('server advances offline factory income by at most eight hours', () => {
  let now = NOW;
  const { db, service } = fixture({ clock: () => now, game: gameWith({ lathe: 1 }) });
  service.getState(user);
  now += 24 * 60 * 60 * 1000;
  const resumed = service.getState(user);
  assert.equal(resumed.state.money, 0.5 * 8 * 60 * 60);
  assert.equal(resumed.state.tickCount, 8 * 60 * 60);
  db.close();
});

test('only server-accepted deliveries score, and retries are idempotent', () => {
  const { db, service } = fixture({ game: gameWith({ parts: 3 }) });
  const initial = service.getState(user);
  assert.equal(initial.league.points, 0);

  const accepted = service.act(user, { actionId: 'delivery-0001', type: 'deliver' });
  assert.equal(accepted.league.points, 1);
  assert.equal(accepted.league.deliveries, 1);
  assert.equal(accepted.state.resources.parts, 0);

  const retried = service.act(user, { actionId: 'delivery-0001', type: 'deliver' });
  assert.deepEqual(retried, accepted);
  assert.throws(() => service.act(user, { actionId: 'delivery-0002', type: 'deliver' }), error => error.status === 409);
  assert.equal(service.getState(user).league.points, 1);
  db.close();
});

test('league order requirements and rewards progress on the server, not client input', () => {
  const { db, service } = fixture({ game: gameWith({ parts: 8 }) });
  const first = service.act(user, { actionId: 'order-0001', type: 'deliver', orderIndex: 99 });
  assert.equal(first.league.points, 1);
  assert.equal(first.state.resources.parts, 5);
  assert.equal(first.state.money, 520);

  const second = service.act(user, { actionId: 'order-0002', type: 'deliver', orderIndex: 0 });
  assert.equal(second.league.points, 2);
  assert.equal(second.league.deliveries, 2);
  assert.equal(second.state.resources.parts, 0);
  assert.equal(second.state.money, 1460);
  db.close();
});

test('equal scores rank by who reached that score first without exposing Telegram IDs', () => {
  let now = NOW;
  const { db, service } = fixture({ clock: () => now, game: gameWith({ parts: 3 }) });
  service.act(user, { actionId: 'rus-order-01', type: 'deliver' });
  now += 1000;
  const laterUser = { id: '77124', displayName: 'Другой игрок' };
  service.act(laterUser, { actionId: 'other-order-01', type: 'deliver' });

  const first = service.getState(user);
  const second = service.getState(laterUser);
  assert.equal(first.league.rank, 1);
  assert.equal(second.league.rank, 2);
  for (const entry of first.league.leaderboard) {
    assert.deepEqual(Object.keys(entry).sort(), ['deliveries', 'displayName', 'points', 'rank']);
    assert.equal(Object.hasOwn(entry, 'telegram_id'), false);
  }
  db.close();
});

test('same-millisecond deliveries still preserve server acceptance order in tie-breaks', () => {
  const { db, service } = fixture({ game: gameWith({ parts: 3 }) });
  const firstUser = { id: '77124', displayName: 'Первый' };
  const secondUser = { id: '77123', displayName: 'Второй' };
  service.act(firstUser, { actionId: 'first-order-01', type: 'deliver' });
  service.act(secondUser, { actionId: 'second-order-1', type: 'deliver' });
  assert.equal(service.getState(firstUser).league.rank, 1);
  assert.equal(service.getState(secondUser).league.rank, 2);
  db.close();
});

test('HTTP API requires valid Telegram initData and returns season state', async t => {
  const { db, service } = fixture();
  const server = createLeagueServer({ service, botToken: BOT_TOKEN, allowedOrigin: 'https://example.test', clock: () => NOW });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const denied = await fetch(`${base}/api/league/state`);
  assert.equal(denied.status, 401);
  const initData = signedInitData(userData);
  const response = await fetch(`${base}/api/league/state`, {
    headers: { Authorization: `tma ${initData}` }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.league.seasonId, '2026-11');
  assert.equal(payload.player.displayName, '@rus');
  assert.equal(Array.isArray(payload.league.leaderboard), true);
});

test('browser origins are rejected until an exact CORS origin is configured', async t => {
  const { db, service } = fixture();
  const server = createLeagueServer({ service, botToken: BOT_TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const blocked = await fetch(`${base}/api/health`, { headers: { Origin: 'https://unlisted.example' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  const serverToServer = await fetch(`${base}/api/health`);
  assert.equal(serverToServer.status, 200);
});
