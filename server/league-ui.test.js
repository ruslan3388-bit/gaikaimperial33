const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.template.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

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
