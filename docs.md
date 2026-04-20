# Anti-Block Bot — Документация проекта

## Описание

Telegram-бот агрегатор MTProto прокси. Автоматически собирает прокси из публичных Telegram-каналов и GitHub, проверяет их работоспособность из России (через RU-агент) и выдаёт пользователям в виде `tg://proxy` deep-links.

Бизнес-модель: Freemium (1 прокси в сутки бесплатно) + VIP подписка (безлимит, лучшие прокси, реролл).

---

## Технологический стек

- **Язык:** TypeScript (Node.js, ESM)
- **Бот:** grammY
- **БД:** SQLite (better-sqlite3), миграция на Supabase — см. MIGRATION.md
- **HTTP:** встроенный `node:http`
- **Скрапинг:** axios

---

## Архитектура

```
NL сервер (основной)          RU сервер (агент)
├── bot.ts       (бот)        └── checker-agent.ts
├── scraper.ts   (скрапер)         ├── GET /unchecked → берёт прокси
├── checker.ts   (fallback)        ├── проверяет TCP/SOCKS5 из РФ
├── index.ts     (точка входа)     └── POST /report → шлёт результаты
└── db.ts        (SQLite)
```

### Почему два сервера

Прокси проверяются из России — только так можно убедиться что они работают для российских пользователей. NL сервер не может это проверить (Telegram там не заблокирован).

---

## Источники прокси

| Источник | Тип | Формат |
|---|---|---|
| `t.me/s/mtpro_xyz` | MTProto | `t.me/proxy?...` |
| `t.me/s/proxyListFree` | MTProto | `t.me/proxy?...` |
| `t.me/s/mtrproxytg` | MTProto | Server/Port/Secret поля |
| `t.me/s/toproxylab` | SOCKS5 | IP:PORT из текста |
| `raw.githubusercontent.com/Grim1313/...` | MTProto | `t.me/proxy?...` |

---

## Схема БД

### users
| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER | Telegram user_id |
| is_vip | INTEGER | 0/1 |
| vip_until | TEXT | ISO-8601, когда истекает VIP |
| last_free | TEXT | Когда последний раз брал бесплатный прокси |
| joined_at | TEXT | Дата регистрации |

### proxies
| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER | Автоинкремент |
| type | TEXT | MTPROTO / SOCKS5 |
| link | TEXT | tg://proxy?... или tg://socks?... |
| status | TEXT | unchecked / active / slow / dead |
| ping_ms | INTEGER | Задержка в мс |
| likes | INTEGER | Количество лайков |
| dislikes | INTEGER | Количество дизлайков |
| fires | INTEGER | Количество 🔥 |
| country | TEXT | Страна прокси |
| updated_at | TEXT | Время последней проверки |

### proxy_votes
| Поле | Тип | Описание |
|---|---|---|
| proxy_id | INTEGER | ID прокси |
| user_id | INTEGER | ID пользователя |
| vote | TEXT | like / dislike / fire |

---

## Логика репутации

- Пользователь голосует 👍 / 🔥 / 👎 под каждым прокси
- **👎 дизлайки:** если дизлайков ≥ 5 и дизлайков > лайков × 2 → прокси помечается `dead`
- **👍 лайки:** VIP-пользователи получают прокси отсортированные по лайкам (лучшие первыми)
- **🔥 огонь:** собирается как метрика популярности, пока не влияет на выдачу

---

## Пользовательский путь

### Бесплатный пользователь
1. `/start` → главное меню
2. "Получить прокси" → MTProto прокси + кнопки голосования
3. Лимит: 1 прокси в 24 часа

### VIP пользователь
1. Всё то же самое, но без лимита
2. Получает прокси с лучшей репутацией (сортировка по лайкам)
3. Кнопка 🔄 "Следующий прокси" — мгновенная замена без ограничений

---

## HTTP API (NL сервер, порт 3000)

Все запросы требуют заголовок `x-api-secret`.

| Метод | Путь | Описание |
|---|---|---|
| GET | /unchecked | Список непроверенных прокси (100 шт, MTProto в приоритете) |
| POST | /report | Принять результаты проверки от RU-агента |
| POST | /rescrape | Запустить скрапер (cooldown 10 мин) |
| POST | /restart | Перезапустить NL процесс (PM2 поднимет) |
| POST | /restart-peer | Перезапустить RU агент |

## Health-check (RU агент, порт 3001)

| Метод | Путь | Описание |
|---|---|---|
| GET | /ping | Проверка живости |
| POST | /restart | Перезапустить агент |
| POST | /restart-peer | Перезапустить NL сервер |

---

## Переменные окружения

### NL сервер (.env)
```
DATABASE_URL=file:./dev.db
BOT_TOKEN=...
API_PORT=3000
API_SECRET=...
AGENT_URL=http://RU_IP:3001
```

### RU агент (.env)
```
MAIN_SERVER_URL=http://NL_IP:3000
API_SECRET=...   # тот же что на NL
HEALTH_PORT=3001
```

---

## Запуск

```bash
# NL сервер
npm run start        # tsx index.ts

# RU агент
npm run agent        # tsx checker-agent.ts
```

PM2:
```bash
pm2 start npm --name "proxysell" -- run start
pm2 start npm --name "proxy-agent" -- run agent
```

---

## Масштабирование

**Фаза 1 (MVP):** SQLite на одном NL сервере + RU агент для проверки.

**Фаза 2 (> 1000 пользователей):** SQLite начнёт блокироваться. Мигрируем на Supabase — см. `MIGRATION.md`. Меняется только `db.ts` и строка подключения в `.env`.
