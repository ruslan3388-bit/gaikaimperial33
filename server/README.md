# Сервер сезонной лиги

Сервер хранит отдельный завод каждого игрока и сезона, валидирует `Telegram.WebApp.initData`, принимает игровые действия и сам начисляет очки за подтверждённую отгрузку.

## Требования и запуск

Нужен Node.js 24.15+; локально проверено на Node v24.18.0. Встроенный `node:sqlite` в Node 24 имеет статус Release Candidate и выполняет операции синхронно, поэтому сервер пока прототип: перед production-развёртыванием нужно закрепить поддерживаемую версию Node/драйвер и проверить постоянное хранилище под нагрузкой.

PowerShell:

```powershell
$env:BOT_TOKEN = '<токен бота>'
$env:ALLOWED_ORIGIN = 'https://ruslan3388-bit.github.io'
$env:PORT = '8787'
node server/league-server.js
```

Bash:

```bash
BOT_TOKEN='<токен бота>' \
ALLOWED_ORIGIN='https://ruslan3388-bit.github.io' \
PORT=8787 \
node server/league-server.js
```

`BOT_TOKEN` — секрет сервера; не добавляй его в Git, HTML или клиентские переменные. SQLite-файл по умолчанию создаётся в `data/league.sqlite`; папка `data/` исключена из Git. Путь можно изменить через `LEAGUE_DB_PATH`.

## API

- `GET /api/health` — проверка доступности.
- `GET /api/league/state` — текущий UTC-сезон, состояние лигового завода и таблица лидеров.
- `POST /api/league/action` — серверно проверяемые `tap`, `buy`, `sell`, `sellAll`, `deliver`.

Для API-запросов нужен заголовок `Authorization: tma <Telegram.WebApp.initData>`. Открывать игру нужно в режиме Telegram Mini App, который передаёт подписанный `initData` (например, из меню Mini App бота); не каждый способ запуска Web App передаёт серверу данные пользователя. Разрешённый браузерный origin задаётся через `ALLOWED_ORIGIN` и должен точно совпадать с origin страницы, без завершающего `/`.

## Подключение GitHub Pages

В `index.template.html` укажи публичный HTTPS-адрес развёрнутого API в `window.GAIKA_LEAGUE_API_URL`. Это не секрет. Токен бота остаётся только в секретах серверного хостинга. Пока адрес пустой или API не развёрнут, вкладка лиги сообщает о настройке, а одиночная игра работает отдельно.

Проверка перед выпуском:

```bash
node --test game.test.js server/league.test.js server/league-ui.test.js
node verify_project.js
```

Текущая репозитория содержит серверный прототип, но сам сервер ещё не развёрнут и не подключён к боту.
