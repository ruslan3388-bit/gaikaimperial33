const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Game = require('../game_core.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.template.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function createUiHarness(fetch) {
  class Element {
    constructor() {
      this.textContent = ''; this.innerHTML = ''; this.disabled = false; this.hidden = false;
      this.style = {}; this.dataset = {}; this.children = []; this.handlers = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.parentElement = { querySelector: () => new Element() };
    }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    click() { if (!this.disabled) this.handlers.click?.({}); }
    querySelector() { return new Element(); }
    replaceChildren(...items) { this.children = items; }
    append(item) { this.children.push(item); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 100 }; }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelectorAll() { return []; },
    querySelector() { return new Element(); },
    createElement() { return new Element(); }
  };
  const storage = new Map();
  const window = {
    IndustryGame: Game,
    GAIKA_LEAGUE_API_URL: 'https://league.test',
    Telegram: { WebApp: { initData: 'signed-test-init-data', ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {} } },
    crypto: { randomUUID: () => 'action-id-0001' }
  };
  const context = vm.createContext({
    window, document, fetch,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, confirm() { return true; }, console
  });
  vm.runInContext(app, context);
  return { context, elements, storage };
}

test('an in-flight league action cannot be exited into solo mode before its response', async () => {
  let resolveAction;
  const serverState = Game.newGame();
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/api/league/state')) return { ok: true, json: async () => makePayload(serverState) };
    if (url.endsWith('/api/league/action') && options.method === 'POST') {
      return new Promise(resolve => { resolveAction = result => resolve({ ok: true, json: async () => result }); });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const { context, elements, storage } = createUiHarness(fetch);
  const soloSaved = storage.get('gaika-empire-industrial-v02');
  await vm.runInContext('refreshLeague({join:true})', context);
  const pending = vm.runInContext('sendLeagueAction({type:"tap"})', context);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(elements.get('league-exit').disabled, true);
    elements.get('league-exit').click();
    assert.equal(vm.runInContext('leagueMode', context), true);
    vm.runInContext('leagueMode = false; state = soloState', context);
  } finally {
    resolveAction(makePayload({ ...serverState, money: 1, lifetime: 1 }));
    await pending;
  }
  assert.equal(vm.runInContext('leagueMode', context), false);
  assert.equal(vm.runInContext('state === soloState', context), true);
  assert.equal(storage.get('gaika-empire-industrial-v02'), soloSaved);
});

test('an older in-flight league refresh cannot overwrite a newer action state', async () => {
  let resolveAction;
  let resolveStaleRefresh;
  let deferNextState = false;
  const serverState = Game.newGame();
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/api/league/state')) {
      if (deferNextState) return new Promise(resolve => {
        resolveStaleRefresh = state => resolve({ ok: true, json: async () => makePayload(state) });
      });
      return { ok: true, json: async () => makePayload(serverState) };
    }
    if (url.endsWith('/api/league/action') && options.method === 'POST') {
      return new Promise(resolve => { resolveAction = state => resolve({ ok: true, json: async () => makePayload(state) }); });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const { context } = createUiHarness(fetch);
  await vm.runInContext('refreshLeague({join:true})', context);
  deferNextState = true;
  const staleRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  deferNextState = false;
  const action = vm.runInContext('sendLeagueAction({type:"tap"})', context);
  await new Promise(resolve => setImmediate(resolve));
  resolveAction({ ...serverState, money: 1, lifetime: 1 });
  await action;
  resolveStaleRefresh(serverState);
  await staleRefresh;
  assert.equal(vm.runInContext('state.money', context), 1);
});

test('a pending join blocks later refreshes and supersedes older failures', async () => {
  let stateRequests = 0;
  let resolveOldFailure;
  let resolveJoin;
  const joinState = { ...Game.newGame(), money: 2 };
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async url => {
    if (!url.endsWith('/api/league/state')) throw new Error(`Unexpected request: ${url}`);
    stateRequests++;
    if (stateRequests === 1) return new Promise(resolve => {
      resolveOldFailure = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'older refresh failed' }) });
    });
    if (stateRequests === 2) return new Promise(resolve => {
      resolveJoin = state => resolve({ ok: true, json: async () => makePayload(state) });
    });
    throw new Error('ordinary refresh should be blocked while join is pending');
  };
  const { context } = createUiHarness(fetch);
  const oldRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  const join = vm.runInContext('refreshLeague({join:true})', context);
  await new Promise(resolve => setImmediate(resolve));
  const blockedRefresh = await vm.runInContext('refreshLeague()', context);
  resolveOldFailure();
  await oldRefresh;
  resolveJoin(joinState);
  await join;
  assert.equal(stateRequests, 2);
  assert.equal(blockedRefresh, null);
  assert.equal(vm.runInContext('leagueMode', context), true);
  assert.equal(vm.runInContext('state.money', context), 2);
  assert.equal(vm.runInContext('leagueError', context), '');
});

test('a stale refresh cannot erase a failed league action', async () => {
  let resolveAction;
  let resolveStaleRefresh;
  let deferNextState = false;
  const serverState = Game.newGame();
  const staleState = { ...Game.newGame(), money: 9 };
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/api/league/state')) {
      if (deferNextState) return new Promise(resolve => {
        resolveStaleRefresh = () => resolve({ ok: true, json: async () => makePayload(staleState) });
      });
      return { ok: true, json: async () => makePayload(serverState) };
    }
    if (url.endsWith('/api/league/action') && options.method === 'POST') {
      return new Promise(resolve => {
        resolveAction = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'action unavailable' }) });
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const { context } = createUiHarness(fetch);
  await vm.runInContext('refreshLeague({join:true})', context);
  deferNextState = true;
  const staleRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  deferNextState = false;
  const action = vm.runInContext('sendLeagueAction({type:"tap"})', context);
  await new Promise(resolve => setImmediate(resolve));
  resolveAction();
  await action;
  resolveStaleRefresh();
  await staleRefresh;
  assert.equal(vm.runInContext('leagueError', context), 'action unavailable');
  assert.equal(vm.runInContext('state.money', context), 0);
});

test('a stale refresh failure cannot replace a successful action status', async () => {
  let resolveAction;
  let resolveStaleRefresh;
  let deferNextState = false;
  const serverState = Game.newGame();
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/api/league/state')) {
      if (deferNextState) return new Promise(resolve => { resolveStaleRefresh = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'устаревший сбой' }) }); });
      return { ok: true, json: async () => makePayload(serverState) };
    }
    if (url.endsWith('/api/league/action') && options.method === 'POST') {
      return new Promise(resolve => { resolveAction = state => resolve({ ok: true, json: async () => makePayload(state) }); });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const { context } = createUiHarness(fetch);
  await vm.runInContext('refreshLeague({join:true})', context);
  deferNextState = true;
  const staleRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  deferNextState = false;
  const action = vm.runInContext('sendLeagueAction({type:"tap"})', context);
  await new Promise(resolve => setImmediate(resolve));
  resolveAction({ ...serverState, money: 1, lifetime: 1 });
  await action;
  resolveStaleRefresh();
  await staleRefresh;
  assert.equal(vm.runInContext('leagueError', context), '');
  assert.equal(vm.runInContext('state.money', context), 1);
});

test('an older failed refresh cannot leave an error after a newer refresh succeeds', async () => {
  let stateRequests = 0;
  let resolveOldFailure;
  let resolveNewSuccess;
  const serverState = Game.newGame();
  const latestState = { ...Game.newGame(), money: 7 };
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async url => {
    if (!url.endsWith('/api/league/state')) throw new Error(`Unexpected request: ${url}`);
    stateRequests++;
    if (stateRequests === 1) return { ok: true, json: async () => makePayload(serverState) };
    if (stateRequests === 2) return new Promise(resolve => { resolveOldFailure = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'stale failure' }) }); });
    return new Promise(resolve => { resolveNewSuccess = () => resolve({ ok: true, json: async () => makePayload(latestState) }); });
  };
  const { context } = createUiHarness(fetch);
  await vm.runInContext('refreshLeague({join:true})', context);
  const oldRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  const newRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  resolveOldFailure();
  await oldRefresh;
  resolveNewSuccess();
  await newRefresh;
  assert.equal(vm.runInContext('state.money', context), 7);
  assert.equal(vm.runInContext('leagueError', context), '');
});

test('an older successful refresh cannot override a newer refresh failure', async () => {
  let stateRequests = 0;
  let resolveOldSuccess;
  let resolveNewFailure;
  const serverState = Game.newGame();
  const staleState = { ...Game.newGame(), money: 3 };
  const makePayload = state => ({
    player: { displayName: 'Тест' },
    season: { id: '2026-11', startsAt: 0, endsAt: Date.now() + 86400000 },
    league: { seasonId: '2026-11', points: 0, deliveries: 0, rank: 1, leaderboard: [] },
    state
  });
  const fetch = async url => {
    if (!url.endsWith('/api/league/state')) throw new Error(`Unexpected request: ${url}`);
    stateRequests++;
    if (stateRequests === 1) return { ok: true, json: async () => makePayload(serverState) };
    if (stateRequests === 2) return new Promise(resolve => { resolveOldSuccess = state => resolve({ ok: true, json: async () => makePayload(state) }); });
    return new Promise(resolve => { resolveNewFailure = () => resolve({ ok: false, status: 503, json: async () => ({ error: 'new refresh failed' }) }); });
  };
  const { context } = createUiHarness(fetch);
  await vm.runInContext('refreshLeague({join:true})', context);
  const oldRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  const newRefresh = vm.runInContext('refreshLeague()', context);
  await new Promise(resolve => setImmediate(resolve));
  resolveNewFailure();
  await newRefresh;
  resolveOldSuccess(staleState);
  await oldRefresh;
  assert.equal(vm.runInContext('state.money', context), 0);
  assert.equal(vm.runInContext('leagueError', context), 'new refresh failed');
});

test('main game has an explicit monthly league panel and ranking fields', () => {
  assert.match(html, /data-tab="league"/);
  for (const id of ['panel-league', 'league-connect', 'league-status', 'league-season', 'league-rank', 'league-points', 'league-board']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('league client uses Telegram initData and server action endpoints, never unsafe client identity', () => {
  assert.match(app, /\/api\/league\/state/);
  assert.match(app, /\/api\/league\/action/);
  assert.match(app, /WebApp\.initData/);
  assert.doesNotMatch(app, /initDataUnsafe/);
});

test('league-mode gameplay sends actions to server and does not tick or save authoritative state locally', () => {
  assert.match(app, /leagueMode/);
  assert.match(app, /sendLeagueAction/);
  assert.match(app, /if\s*\(!leagueMode\)\s*save\(\)/);
  assert.match(app, /if\s*\(leagueMode\)[\s\S]{0,120}refreshLeague/);
});
