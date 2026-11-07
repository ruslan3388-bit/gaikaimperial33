const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLeagueService, createLeagueServer } = require('./league.js');

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  console.error('Нужна переменная окружения BOT_TOKEN. Не добавляй токен в репозиторий.');
  process.exit(1);
}

const port = Number(process.env.PORT || process.env.LEAGUE_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT должен быть целым числом от 1 до 65535.');
  process.exit(1);
}

const dbPath = process.env.LEAGUE_DB_PATH || path.join(__dirname, '..', 'data', 'league.sqlite');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const service = createLeagueService({ db });
const server = createLeagueServer({
  service,
  botToken,
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://ruslan3388-bit.github.io'
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Лига слушает порт ${port}; база: ${dbPath}`);
});

function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
