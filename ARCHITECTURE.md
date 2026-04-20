# Anti-Block Bot — Полная архитектура проекта

## Обзор

Два сервера работают вместе:

```
┌─────────────────────────────────┐     HTTP API      ┌──────────────────────────┐
│        NL сервер                │◄──────────────────►│      RU агент            │
│  (Нидерланды, основной)         │                    │  (Россия, checker-agent) │
│                                 │                    │                          │
│  • Telegram бот (grammY)        │                    │  • Проверяет прокси      │
│  • Скрапер (4 источника)        │                    │    через TCP из РФ       │
│  • SQLite база данных           │                    │  • Шлёт результаты       │
│  • HTTP API на порту 3000       │                    │    на NL сервер          │
│  • Fallback чекер (NL)          │                    │  • Health-check :3001    │
└─────────────────────────────────┘                    └──────────────────────────┘
```

**Почему два сервера:** прокси нужно проверять из России — только так можно убедиться что они работают для российских пользователей. NL сервер не может это проверить (Telegram там не заблокирован).

---

## Файлы проекта

| Файл | Где запускается | Назначение |
|---|---|---|
| `index.ts` | NL | Точка входа: бот + API + планировщики |
| `bot.ts` | NL | Telegram бот (grammY) |
| `scraper.ts` | NL | Скрапинг прокси из источников |
| `checker.ts` | NL | Fallback чекер (не трогает MTProto) |
| `db.ts` | NL | Вся логика SQLite |
| `checker-agent.ts` | RU | Агент проверки прокси из России |

---

## Поток данных

### 1. Скрапинг (NL, каждые 2 часа)

```
scraper.ts
    │
    ├── GET https://t.me/s/mtpro_xyz
    ├── GET https://t.me/s/proxyListFree
    ├── GET https://t.me/s/mtrproxytg
    └── GET https://raw.githubusercontent.com/Grim1313/...
            │
            ▼ parseUniversal() — ищет:
              1. tg://proxy?... ссылки
              2. https://t.me/proxy?... ссылки
              3. Server:/Port:/Secret: поля в тексте
            │
            ▼
        db.proxies.insert(type="MTPROTO", link, status="unchecked")
```

После скрапинга все мёртвые MTProto сбрасываются в `unchecked` — чтобы RU агент их перепроверил.

---

### 2. Проверка прокси (RU агент, каждые 15 минут)

```
checker-agent.ts
    │
    ├── GET /stats → { active_mt: N, unchecked: M }
    │       │
    │       ├── если unchecked = 0 → POST /rescrape → ждём 45 сек
    │       │
    │       └── если active_mt < 10 → режим 🔴 агрессивный
    │
    ├── GET /unchecked → батч 100 прокси (MTProto в приоритете)
    │
    ├── Проверяем 100 параллельно:
    │       │
    │       ├── MTProto: TCP connect к host:port
    │       │     если соединение открылось → active (ping = время соединения)
    │       │     если таймаут/ошибка → dead
    │       │
    │       └── SOCKS5: HTTPS запрос к api.telegram.org через прокси
    │             если ответ < 500 → active
    │             если таймаут → dead
    │
    └── POST /report → отправляем результаты на NL
            │
            ▼
        NL: db.proxies.setStatus(id, status, ping_ms)
```

---

### 3. Перепроверка активных (NL, каждые 4 часа)

```
index.ts → setInterval(4h)
    │
    └── db.proxies.resetStaleActive(4)
            │
            ▼
        UPDATE proxies SET status='unchecked'
        WHERE status='active'
        AND updated_at < datetime('now', '-4 hours')
```

Активные прокси старше 4 часов сбрасываются в `unchecked` → RU агент их перепроверит на следующем цикле.

---

### 4. Выдача прокси пользователю (бот)

```
Пользователь нажимает "Получить прокси"
    │
    ├── Проверяем VIP статус (is_vip=1 AND vip_until > now)
    │
    ├── Если не VIP: проверяем last_free (лимит 1 раз в 24ч)
    │
    ├── Выбираем прокси из БД:
    │       ├── VIP: ORDER BY likes DESC, ping_ms ASC (лучшие первыми)
    │       └── Free: ORDER BY ping_ms ASC (быстрые первыми)
    │
    ├── Сохраняем users.last_proxy_id = proxy.id
    │
    └── Отправляем сообщение с:
            ├── tg://proxy?... ссылка (кнопка "⚡ Применить")
            ├── Кнопки голосования: 👍 🔥 👎
            └── Кнопка 🔄 (только VIP)
```

---

### 5. Реролл (только VIP)

```
VIP нажимает 🔄
    │
    ├── Берём users.last_proxy_id (последний показанный)
    │
    ├── db.proxies.getNextProxy(type, excludeId)
    │       └── SELECT WHERE id != excludeId
    │           ORDER BY likes DESC, RANDOM()
    │
    ├── Сохраняем новый last_proxy_id
    │
    └── Редактируем сообщение (editMessageText)
```

---

### 6. Голосование за прокси

```
Пользователь нажимает 👍 / 🔥 / 👎
    │
    ├── INSERT INTO proxy_votes (proxy_id, user_id, vote)
    │   ON CONFLICT DO UPDATE SET vote = новый_голос
    │   (один пользователь = один голос на прокси, можно менять)
    │
    ├── UPDATE proxies SET
    │       likes    = COUNT(vote='like')
    │       dislikes = COUNT(vote='dislike')
    │       fires    = COUNT(vote='fire')
    │
    └── Если dislikes >= 5 AND dislikes > likes * 2:
            └── setStatus(id, 'dead') — прокси убирается из выдачи
```

---

## База данных (SQLite)

### Таблица `users`

| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER PK | Telegram user_id |
| is_vip | INTEGER | 0 = free, 1 = VIP |
| vip_until | TEXT | ISO-8601, когда истекает VIP |
| last_free | TEXT | Когда последний раз брал прокси (лимит) |
| last_proxy_id | INTEGER | ID последнего показанного прокси (для реролла) |
| joined_at | TEXT | Дата первого /start |

### Таблица `proxies`

| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER PK | Автоинкремент |
| type | TEXT | MTPROTO / SOCKS5 |
| link | TEXT UNIQUE | tg://proxy?server=...&port=...&secret=... |
| status | TEXT | unchecked → active/slow/dead |
| ping_ms | INTEGER | Задержка TCP соединения в мс |
| likes | INTEGER | Количество 👍 |
| dislikes | INTEGER | Количество 👎 |
| fires | INTEGER | Количество 🔥 |
| country | TEXT | Страна (не используется активно) |
| updated_at | TEXT | Время последнего изменения статуса |

### Таблица `proxy_votes`

| Поле | Тип | Описание |
|---|---|---|
| proxy_id | INTEGER | FK → proxies.id |
| user_id | INTEGER | Telegram user_id |
| vote | TEXT | like / dislike / fire |
| created_at | TEXT | Время голоса |

PRIMARY KEY (proxy_id, user_id) — один голос на пару.

### Жизненный цикл прокси

```
scraper добавляет
        │
        ▼
   [unchecked]
        │
        ├── RU агент проверяет TCP
        │
        ├── ping <= 3000ms → [active]
        ├── ping > 3000ms  → [slow]
        └── ошибка/таймаут → [dead]
                                │
                                └── через 24ч → DELETE

[active] ──── каждые 4ч ────► [unchecked] (перепроверка)
[active] ──── 5+ дизлайков ──► [dead]
```

---

## HTTP API (NL сервер :3000)

Все запросы требуют заголовок `x-api-secret: <секрет>`.

| Метод | Путь | Описание |
|---|---|---|
| GET | /stats | `{ active_mt, unchecked }` — статистика для агента |
| GET | /unchecked | Батч 100 непроверенных (MTProto в приоритете) |
| POST | /report | Принять результаты проверки `[{id, status, ping_ms}]` |
| POST | /rescrape | Запустить скрапер (cooldown 30 мин) |
| POST | /restart | Перезапустить NL процесс (PM2 поднимет) |
| POST | /restart-peer | Перезапустить RU агент |

## Health-check (RU агент :3001)

| Метод | Путь | Описание |
|---|---|---|
| GET | /ping | `ok` — проверка живости (без авторизации) |
| POST | /restart | Перезапустить агент |
| POST | /restart-peer | Перезапустить NL сервер |

---

## Планировщики (NL сервер)

| Интервал | Действие |
|---|---|
| Старт + каждые 2ч | Скрапинг всех источников |
| Каждые 30 мин | NL fallback чекер (только SOCKS5, MTProto пропускает) |
| Каждый час | Истечение VIP подписок |
| Каждые 4ч | Сброс активных прокси старше 4ч на перепроверку |

## Планировщики (RU агент)

| Интервал | Действие |
|---|---|
| Старт + каждые 15 мин | Полный цикл проверки всех unchecked |

---

## Переменные окружения

### NL сервер
```env
DATABASE_URL=file:./dev.db
BOT_TOKEN=...
API_PORT=3000
API_SECRET=...          # общий секрет с RU агентом
AGENT_URL=http://RU_IP:3001
```

### RU агент
```env
MAIN_SERVER_URL=http://NL_IP:3000
API_SECRET=...          # тот же что на NL
HEALTH_PORT=3001
```

---

## Запуск

```bash
# NL сервер
npm run start    # tsx index.ts

# RU агент
npm run agent    # tsx checker-agent.ts
```

PM2:
```bash
# NL
pm2 start npm --name "proxysell" -- run start

# RU
pm2 start npm --name "proxy-agent" -- run agent
```

Перезапуск через API:
```bash
# Перезапустить RU агент с NL:
curl -X POST http://localhost:3000/restart-peer -H "x-api-secret: СЕКРЕТ"

# Перезапустить NL с RU:
curl -X POST http://localhost:3001/restart-peer -H "x-api-secret: СЕКРЕТ"
```
