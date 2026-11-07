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

test('an action uses the UTC season current after acquiring the database write lock', () => {
  let now = Date.UTC(2026, 10, 30, 23, 59, 59, 900);
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => now });
  service.act(user, { actionId: 'nov-action-0001', type: 'tap' });
  const realExec = db.exec.bind(db);
  let rollMonthAtNextLock = true;
  db.exec = sql => {
    if (rollMonthAtNextLock && sql === 'BEGIN IMMEDIATE') {
      now = Date.UTC(2026, 11, 1, 0, 0, 0, 100);
      rollMonthAtNextLock = false;
    }
    return realExec(sql);
  };
  const result = service.act(user, { actionId: 'dec-action-0001', type: 'tap' });
  const previousSeasonReceipts = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE season_id = ?').get('2026-11').count;
  const currentSeasonReceipts = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE season_id = ?').get('2026-12').count;
  assert.equal(result.season.id, '2026-12');
  assert.equal(previousSeasonReceipts, 1);
  assert.equal(currentSeasonReceipts, 1);
  db.close();
});

test('a repeated actionId is deduplicated across a UTC season rollover', () => {
  let now = Date.UTC(2026, 10, 30, 23, 59, 58);
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => now });
  const action = { actionId: 'cross-season-0001', type: 'tap' };
  assert.equal(service.act(user, action).state.money, 1);
  now = Date.UTC(2026, 11, 1, 0, 0, 2);
  const retried = service.act(user, action);
  assert.equal(retried.season.id, '2026-12');
  assert.equal(retried.state.money, 0);
  const receipts = db.prepare('SELECT season_id FROM action_receipts WHERE telegram_id = ? AND action_id = ?').all(user.id, action.actionId);
  assert.deepEqual(receipts.map(row => row.season_id), ['2026-11']);
  db.close();
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

test('duplicate action replay does not grant offline income a second time', () => {
  let now = NOW;
  const { db, service } = fixture({ clock: () => now, game: gameWith({ lathe: 1 }) });
  const action = { actionId: 'offline-replay-01', type: 'tap' };
  const accepted = service.act(user, action);
  now += 1000;
  const replayed = service.act(user, action);
  assert.equal(replayed.state.money, accepted.state.money);
  assert.equal(replayed.state.tickCount, accepted.state.tickCount);
  const resumed = service.getState(user);
  assert.equal(resumed.state.money, accepted.state.money + 0.5);
  assert.equal(resumed.state.tickCount, accepted.state.tickCount + 1);
  db.close();
});

test('client-controlled prototype resource names cannot corrupt league state', () => {
  const { db, service } = fixture();
  const before = service.getState(user).state;
  assert.throws(() => service.act(user, {
    actionId: 'invalid-sell-01', type: 'sell', resource: 'toString', quantity: 1
  }), error => error.status === 409);
  assert.deepEqual(service.getState(user).state, before);
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

test('expired action receipts are removed while processing a later action', () => {
  let now = NOW;
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => now, receiptTtlMs: 1000 });
  service.act(user, { actionId: 'expires-0001', type: 'tap' });
  now += 1001;
  service.act(user, { actionId: 'expires-0002', type: 'tap' });
  const oldReceipt = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE action_id = ?').get('expires-0001').count;
  const currentReceipt = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE action_id = ?').get('expires-0002').count;
  assert.equal(oldReceipt, 0);
  assert.equal(currentReceipt, 1);
  db.close();
});

test('action receipts are compact and capped per player', () => {
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => NOW, maxActionReceiptsPerUser: 2 });
  for (const actionId of ['receipt-0001', 'receipt-0002', 'receipt-0003']) {
    service.act(user, { actionId, type: 'tap' });
  }
  const count = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE season_id = ? AND telegram_id = ?').get('2026-11', user.id).count;
  const maxBytes = db.prepare('SELECT MAX(length(response_json)) AS bytes FROM action_receipts WHERE season_id = ? AND telegram_id = ?').get('2026-11', user.id).bytes;
  const oldest = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE action_id = ?').get('receipt-0001').count;
  assert.equal(count, 2);
  assert.equal(maxBytes, 2);
  assert.equal(oldest, 0);
  db.close();
});

test('replayed action IDs still consume request-rate tokens', () => {
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => NOW, rateLimitPerMinute: 60, rateLimitBurst: 2 });
  const action = { actionId: 'same-replay-id-01', type: 'tap' };
  assert.equal(service.act(user, action).state.money, 1);
  assert.equal(service.act(user, action).state.money, 1);
  assert.throws(() => service.act(user, action), error => error.status === 429);
  const storedState = JSON.parse(db.prepare('SELECT state_json FROM league_factories WHERE season_id = ? AND telegram_id = ?').get('2026-11', user.id).state_json);
  assert.equal(storedState.money, 1);
  db.close();
});

test('startup enforces the per-player receipt cap across seasons', () => {
  let now = Date.UTC(2026, 10, 30, 23, 59, 50);
  const db = new DatabaseSync(':memory:');
  const seedService = createLeagueService({ db, clock: () => now, maxActionReceiptsPerUser: 5 });
  for (let i = 1; i <= 2; i++) seedService.act(user, { actionId: `startup-receipt-${String(i).padStart(2, '0')}`, type: 'tap' });
  now = Date.UTC(2026, 11, 1, 0, 0, 1);
  for (let i = 3; i <= 4; i++) seedService.act(user, { actionId: `startup-receipt-${String(i).padStart(2, '0')}`, type: 'tap' });
  createLeagueService({ db, clock: () => now, maxActionReceiptsPerUser: 3 });
  const count = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE telegram_id = ?').get(user.id).count;
  const previousSeasonCount = db.prepare('SELECT COUNT(*) AS count FROM action_receipts WHERE season_id = ? AND telegram_id = ?').get('2026-11', user.id).count;
  assert.equal(count, 3);
  assert.equal(previousSeasonCount, 1);
  db.close();
});

test('server token bucket limits rapid actions per player', () => {
  let now = NOW;
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => now, rateLimitPerMinute: 60, rateLimitBurst: 2 });
  const act = actionId => service.act(user, { actionId, type: 'tap' });
  assert.equal(act('rate-limit-0001').state.money, 1);
  assert.equal(act('rate-limit-0002').state.money, 2);
  assert.throws(() => act('rate-limit-0003'), error => error.status === 429);
  now += 1000;
  assert.equal(act('rate-limit-0004').state.money, 3);
  db.close();
});

test('state reads consume the shared per-user request-rate budget', () => {
  let now = NOW;
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => now, rateLimitPerMinute: 60, rateLimitBurst: 2 });
  assert.equal(service.getState(user).league.seasonId, '2026-11');
  assert.equal(service.getState(user).league.seasonId, '2026-11');
  assert.throws(() => service.getState(user), error => error.status === 429);
  assert.equal(service.getState({ id: '77124', displayName: 'Другой' }).league.seasonId, '2026-11');
  now += 1000;
  assert.equal(service.getState(user).league.seasonId, '2026-11');
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

test('HTTP API rate-limits repeated authenticated state reads', async t => {
  const db = new DatabaseSync(':memory:');
  const service = createLeagueService({ db, clock: () => NOW, rateLimitPerMinute: 60, rateLimitBurst: 1 });
  const server = createLeagueServer({ service, botToken: BOT_TOKEN, clock: () => NOW });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); db.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/league/state`;
  const headers = { Authorization: `tma ${signedInitData(userData)}` };
  assert.equal((await fetch(url, { headers })).status, 200);
  const limited = await fetch(url, { headers });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Слишком много запросов/);
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
