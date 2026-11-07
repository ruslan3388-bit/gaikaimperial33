const { createHmac, timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const Game = require('../game_core.js');

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CATCHUP_SECONDS = 8 * 60 * 60;
const MAX_LEADERBOARD_ROWS = 50;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 300;
const DEFAULT_RATE_LIMIT_BURST = 30;
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ACTION_RECEIPTS_PER_USER = 4096;

class LeagueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function seasonWindow(nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('Некорректное время сезона');
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    id: `${year}-${String(month + 1).padStart(2, '0')}`,
    startsAt: Date.UTC(year, month, 1),
    endsAt: Date.UTC(year, month + 1, 1)
  };
}

function cleanDisplayName(user) {
  const raw = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ');
  const cleaned = String(raw || 'Игрок').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
  return cleaned || 'Игрок';
}

function validateTelegramInitData(raw, botToken, nowMs = Date.now(), maxAgeSeconds = MAX_INIT_DATA_AGE_SECONDS) {
  if (typeof botToken !== 'string' || !botToken) throw new Error('Не настроен токен Telegram-бота');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) throw new Error('Нет Telegram initData');
  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  const seenKeys = new Set();
  for (const [key] of entries) {
    if (seenKeys.has(key)) throw new Error('Повтор параметров Telegram initData');
    seenKeys.add(key);
  }
  const receivedHash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error('Некорректная подпись Telegram');

  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(receivedHash, 'hex');
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error('Не совпала подпись Telegram');
  }

  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('Данные Telegram устарели');
  }

  let telegramUser;
  try { telegramUser = JSON.parse(params.get('user') || 'null'); } catch (_) { telegramUser = null; }
  if (!telegramUser || !Number.isSafeInteger(telegramUser.id) || telegramUser.id < 1) {
    throw new Error('В initData нет корректного пользователя Telegram');
  }
  return { id: String(telegramUser.id), displayName: cleanDisplayName(telegramUser) };
}

function createLeagueService({
  db, clock = () => Date.now(), game = Game, maxCatchupSeconds = MAX_CATCHUP_SECONDS,
  rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE,
  rateLimitBurst = DEFAULT_RATE_LIMIT_BURST,
  receiptTtlMs = DEFAULT_RECEIPT_TTL_MS,
  maxActionReceiptsPerUser = DEFAULT_MAX_ACTION_RECEIPTS_PER_USER
}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new TypeError('Нужна SQLite-база данных');
  if (!Number.isFinite(rateLimitPerMinute) || rateLimitPerMinute <= 0 || !Number.isInteger(rateLimitBurst) || rateLimitBurst < 1) throw new TypeError('Некорректные параметры лимита действий');
  if (!Number.isFinite(receiptTtlMs) || receiptTtlMs <= 0 || !Number.isInteger(maxActionReceiptsPerUser) || maxActionReceiptsPerUser < 1) throw new TypeError('Некорректные параметры квитанций');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS players (
      telegram_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS league_factories (
      season_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (season_id, telegram_id),
      FOREIGN KEY (telegram_id) REFERENCES players(telegram_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS season_scores (
      season_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      deliveries INTEGER NOT NULL DEFAULT 0,
      last_delivery_at INTEGER,
      PRIMARY KEY (season_id, telegram_id),
      FOREIGN KEY (telegram_id) REFERENCES players(telegram_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS action_receipts (
      season_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (season_id, telegram_id, action_id),
      FOREIGN KEY (telegram_id) REFERENCES players(telegram_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS season_score_rank_idx
      ON season_scores(season_id, points DESC, deliveries DESC, last_delivery_at ASC);
    CREATE INDEX IF NOT EXISTS action_receipt_created_idx ON action_receipts(created_at);
    CREATE INDEX IF NOT EXISTS action_receipt_user_idx ON action_receipts(season_id, telegram_id, created_at);
  `);

  const insertPlayer = db.prepare('INSERT OR IGNORE INTO players(telegram_id, display_name, created_at, updated_at) VALUES(?, ?, ?, ?)');
  const updatePlayer = db.prepare('UPDATE players SET display_name = ?, updated_at = ? WHERE telegram_id = ?');
  const getFactory = db.prepare('SELECT state_json, updated_at FROM league_factories WHERE season_id = ? AND telegram_id = ?');
  const insertFactory = db.prepare('INSERT OR IGNORE INTO league_factories(season_id, telegram_id, state_json, updated_at) VALUES(?, ?, ?, ?)');
  const updateFactory = db.prepare('UPDATE league_factories SET state_json = ?, updated_at = ? WHERE season_id = ? AND telegram_id = ?');
  const ensureScore = db.prepare('INSERT OR IGNORE INTO season_scores(season_id, telegram_id) VALUES(?, ?)');
  const getScore = db.prepare('SELECT points, deliveries, last_delivery_at FROM season_scores WHERE season_id = ? AND telegram_id = ?');
  const latestDelivery = db.prepare('SELECT MAX(last_delivery_at) AS latest FROM season_scores WHERE season_id = ?');
  const updateScore = db.prepare('UPDATE season_scores SET points = points + 1, deliveries = deliveries + 1, last_delivery_at = ? WHERE season_id = ? AND telegram_id = ?');
  const getReceipt = db.prepare('SELECT 1 AS found FROM action_receipts WHERE season_id = ? AND telegram_id = ? AND action_id = ?');
  const saveReceipt = db.prepare('INSERT INTO action_receipts(season_id, telegram_id, action_id, response_json, created_at) VALUES(?, ?, ?, ?, ?)');
  const pruneOtherSeasonReceipts = db.prepare('DELETE FROM action_receipts WHERE season_id <> ?');
  const pruneExpiredReceipts = db.prepare('DELETE FROM action_receipts WHERE created_at < ?');
  const pruneExcessReceipts = db.prepare(`
    DELETE FROM action_receipts WHERE rowid IN (
      SELECT rowid FROM action_receipts
      WHERE season_id = ? AND telegram_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT -1 OFFSET ?
    )
  `);
  const getReceiptOwners = db.prepare('SELECT DISTINCT telegram_id FROM action_receipts WHERE season_id = ?');
  const rateLimitBuckets = new Map();
  const rateTokensPerMs = rateLimitPerMinute / 60000;
  let rateLimitSweepCount = 0;

  function consumeActionToken(userId, now) {
    const bucket = rateLimitBuckets.get(userId);
    const tokens = bucket
      ? Math.min(rateLimitBurst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * rateTokensPerMs)
      : rateLimitBurst;
    if (tokens < 1) throw new LeagueError(429, 'Слишком много действий. Подожди немного.');
    rateLimitBuckets.set(userId, { tokens: tokens - 1, updatedAt: now });
    rateLimitSweepCount++;
    if (rateLimitSweepCount % 256 === 0) {
      for (const [id, last] of rateLimitBuckets) {
        if (now - last.updatedAt > 2 * 60 * 1000) rateLimitBuckets.delete(id);
      }
    }
  }

  const startupNow = clock();
  const startupSeason = seasonWindow(startupNow);
  db.prepare("UPDATE action_receipts SET response_json = '{}' WHERE response_json <> '{}'").run();
  pruneOtherSeasonReceipts.run(startupSeason.id);
  pruneExpiredReceipts.run(startupNow - receiptTtlMs);
  for (const owner of getReceiptOwners.all(startupSeason.id)) {
    pruneExcessReceipts.run(startupSeason.id, owner.telegram_id, maxActionReceiptsPerUser);
  }

  function normalizeUser(user) {
    const id = String(user && user.id || '');
    if (!/^\d{1,20}$/.test(id)) throw new LeagueError(401, 'Некорректный пользователь');
    return { id, displayName: String(user.displayName || 'Игрок').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'Игрок' };
  }

  function loadOrCreate(user, season, now) {
    insertPlayer.run(user.id, user.displayName, now, now);
    updatePlayer.run(user.displayName, now, user.id);
    let row = getFactory.get(season.id, user.id);
    if (!row) {
      insertFactory.run(season.id, user.id, JSON.stringify(game.newGame()), now);
      row = getFactory.get(season.id, user.id);
    }
    const state = JSON.parse(row.state_json);
    if (!state || typeof state !== 'object' || !state.resources || !state.buildings || !state.idleOwned) {
      throw new LeagueError(500, 'Серверное сохранение повреждено');
    }
    return { user, row, state };
  }

  function persist(player, season, now) {
    updateFactory.run(JSON.stringify(player.state), now, season.id, player.user.id);
    updatePlayer.run(player.user.displayName, now, player.user.id);
    player.row.updated_at = now;
  }

  function advance(player, season, now) {
    const prior = Number(player.row.updated_at);
    const seconds = Math.min(maxCatchupSeconds, Math.max(0, (now - prior) / 1000));
    if (seconds > 0) game.tick(player.state, seconds);
    persist(player, season, now);
  }

  function leaderboard(seasonId, userId) {
    const entries = db.prepare(`
      SELECT s.telegram_id, p.display_name, s.points, s.deliveries, s.last_delivery_at
      FROM season_scores s JOIN players p ON p.telegram_id = s.telegram_id
      WHERE s.season_id = ?
      ORDER BY s.points DESC,
        CASE WHEN s.last_delivery_at IS NULL THEN 1 ELSE 0 END ASC,
        s.last_delivery_at ASC,
        s.telegram_id ASC
      LIMIT ?
    `).all(seasonId, MAX_LEADERBOARD_ROWS);
    const me = getScore.get(seasonId, userId) || { points: 0, deliveries: 0, last_delivery_at: null };
    const ahead = db.prepare(`
      SELECT COUNT(*) AS count FROM season_scores
      WHERE season_id = ? AND (
        points > ? OR
        (points = ? AND
          (CASE WHEN last_delivery_at IS NULL THEN 1 ELSE 0 END) <
          (CASE WHEN ? IS NULL THEN 1 ELSE 0 END)) OR
        (points = ? AND
          (CASE WHEN last_delivery_at IS NULL THEN 1 ELSE 0 END) =
          (CASE WHEN ? IS NULL THEN 1 ELSE 0 END) AND
          COALESCE(last_delivery_at, 9223372036854775807) < COALESCE(?, 9223372036854775807)) OR
        (points = ? AND
          COALESCE(last_delivery_at, 9223372036854775807) = COALESCE(?, 9223372036854775807) AND
          telegram_id < ?)
      )
    `).get(seasonId, me.points, me.points, me.last_delivery_at, me.points,
      me.last_delivery_at, me.last_delivery_at, me.points, me.last_delivery_at, userId).count;
    return {
      points: me.points,
      deliveries: me.deliveries,
      rank: ahead + 1,
      leaderboard: entries.map((entry, index) => ({
        rank: index + 1,
        displayName: entry.display_name,
        points: entry.points,
        deliveries: entry.deliveries
      }))
    };
  }

  function snapshot(normalized, season, state) {
    ensureScore.run(season.id, normalized.id);
    const league = leaderboard(season.id, normalized.id);
    return {
      player: { displayName: normalized.displayName },
      season,
      league: { seasonId: season.id, ...league },
      state
    };
  }

  function getState(user) {
    const normalized = normalizeUser(user);
    const now = clock();
    const season = seasonWindow(now);
    const player = loadOrCreate(normalized, season, now);
    advance(player, season, now);
    return snapshot(normalized, season, player.state);
  }

  function act(user, action) {
    const normalized = normalizeUser(user);
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.actionId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(action.actionId)) {
      throw new LeagueError(400, 'Нужен уникальный actionId');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = clock();
      const season = seasonWindow(now);
      consumeActionToken(normalized.id, now);
      pruneOtherSeasonReceipts.run(season.id);
      pruneExpiredReceipts.run(now - receiptTtlMs);
      const existing = getReceipt.get(season.id, normalized.id, action.actionId);
      if (existing) {
        const player = loadOrCreate(normalized, season, now);
        const result = snapshot(normalized, season, player.state);
        db.exec('COMMIT');
        return result;
      }
      const player = loadOrCreate(normalized, season, now);
      advance(player, season, now);
      ensureScore.run(season.id, normalized.id);
      const score = getScore.get(season.id, normalized.id);

      let accepted = false;
      switch (action.type) {
        case 'tap':
          accepted = game.tap(player.state) > 0;
          break;
        case 'buy':
          accepted = game.buy(player.state, action.machine);
          break;
        case 'sell':
          accepted = game.sell(player.state, action.resource, action.quantity);
          break;
        case 'sellAll':
          accepted = game.sellAll(player.state, action.resource);
          break;
        case 'deliver':
          accepted = game.deliverContract(player.state, score.deliveries);
          break;
        default:
          throw new LeagueError(400, 'Неизвестное действие');
      }
      if (!accepted) throw new LeagueError(409, 'Действие недоступно: проверь деньги, склад или заказ');

      persist(player, season, now);
      if (action.type === 'deliver') {
        const latest = latestDelivery.get(season.id).latest;
        const completedAt = latest === null || latest === undefined ? now : Math.max(now, latest + 1);
        updateScore.run(completedAt, season.id, normalized.id);
      }
      const result = snapshot(normalized, season, player.state);
      saveReceipt.run(season.id, normalized.id, action.actionId, '{}', now);
      pruneExcessReceipts.run(season.id, normalized.id, maxActionReceiptsPerUser);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { db, getState, act };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(new LeagueError(413, 'Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (_) { reject(new LeagueError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function createLeagueServer({ service, botToken, allowedOrigin = '', clock = () => Date.now() }) {
  if (!service || typeof service.getState !== 'function' || typeof service.act !== 'function') throw new TypeError('Нужен сервис лиги');
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin) {
      if (!allowedOrigin || origin !== allowedOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Origin не разрешён' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('tma ')) throw new LeagueError(401, 'Нужна авторизация Telegram Mini App');
      let user;
      try { user = validateTelegramInitData(authHeader.slice(4), botToken, clock()); }
      catch (error) { throw new LeagueError(401, error.message); }

      if (req.method === 'GET' && url.pathname === '/api/league/state') {
        res.writeHead(200); res.end(JSON.stringify(service.getState(user))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/league/action') {
        const action = await readJsonBody(req);
        const result = service.act(user, action);
        res.writeHead(200); res.end(JSON.stringify(result)); return;
      }
      throw new LeagueError(404, 'Маршрут не найден');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = Number.isInteger(error.status) ? error.status : 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: status === 500 ? 'Внутренняя ошибка сервера' : error.message }));
    }
  });
  return server;
}

module.exports = {
  LeagueError,
  MAX_CATCHUP_SECONDS,
  MAX_INIT_DATA_AGE_SECONDS,
  createLeagueService,
  createLeagueServer,
  seasonWindow,
  validateTelegramInitData
};
