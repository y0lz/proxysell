# Миграция с SQLite на Supabase (PostgreSQL)

Весь код бота работает через `db.ts` — единственный файл с SQL.
При переезде на Supabase меняется только этот файл и строка в `.env`.

---

## Когда переезжать

- SQLite начинает давать ошибки `SQLITE_BUSY` при > 1000 активных пользователей
- Нужен доступ к БД с нескольких серверов одновременно
- Нужны realtime-подписки или REST API от Supabase

---

## Шаг 1 — Создать проект в Supabase

1. Зайти на [supabase.com](https://supabase.com) → New project
2. Скопировать `Connection string` (вкладка Settings → Database → URI)
3. Выглядит так: `postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres`

---

## Шаг 2 — Обновить .env

```env
# Было:
DATABASE_URL="file:./dev.db"

# Стало:
DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"
```

---

## Шаг 3 — Создать схему в Supabase

Выполнить в SQL Editor Supabase (или через `psql`):

```sql
CREATE TABLE IF NOT EXISTS users (
  id        BIGINT PRIMARY KEY,
  is_vip    BOOLEAN NOT NULL DEFAULT FALSE,
  last_free TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proxies (
  id         SERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  link       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'unchecked',
  ping_ms    INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Шаг 4 — Заменить db.ts

Установить драйвер:

```bash
npm install postgres
npm install -D @types/pg
```

Заменить содержимое `db.ts` на версию с `postgres` (pg):

```typescript
// db.ts (PostgreSQL версия)
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"] ?? "");

export const users = {
    upsert: async (id: number) => {
        await sql`
            INSERT INTO users (id) VALUES (${id})
            ON CONFLICT (id) DO NOTHING
        `;
    },
    get: async (id: number) => {
        const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
        return rows[0];
    },
    setLastFree: async (id: number) => {
        await sql`UPDATE users SET last_free = NOW() WHERE id = ${id}`;
    },
    setVip: async (id: number) => {
        await sql`UPDATE users SET is_vip = TRUE WHERE id = ${id}`;
    },
};

export const proxies = {
    insert: async (type: string, link: string) => {
        await sql`
            INSERT INTO proxies (type, link, status)
            VALUES (${type}, ${link}, 'unchecked')
            ON CONFLICT (link) DO NOTHING
        `;
    },
    getFastActive: async () => {
        const rows = await sql`
            SELECT * FROM proxies
            WHERE status = 'active'
            ORDER BY ping_ms ASC
            LIMIT 1
        `;
        return rows[0];
    },
    getUnchecked: async () => {
        return sql`SELECT * FROM proxies WHERE status = 'unchecked' LIMIT 100`;
    },
    setStatus: async (id: number, status: string, ping_ms: number | null) => {
        await sql`
            UPDATE proxies
            SET status = ${status}, ping_ms = ${ping_ms}, updated_at = NOW()
            WHERE id = ${id}
        `;
    },
    deleteDead: async () => {
        await sql`
            DELETE FROM proxies
            WHERE status = 'dead' AND updated_at < NOW() - INTERVAL '1 day'
        `;
    },
    countByStatus: async (status: string): Promise<number> => {
        const rows = await sql`SELECT COUNT(*) as count FROM proxies WHERE status = ${status}`;
        return Number(rows[0]?.count ?? 0);
    },
};
```

> Обрати внимание: все методы становятся `async`. Нужно добавить `await` в `bot.ts`, `scraper.ts` и `checker.ts` при вызовах `users.*` и `proxies.*`.

---

## Шаг 5 — Обновить вызовы в bot.ts, scraper.ts, checker.ts

В SQLite-версии вызовы синхронные. В PostgreSQL-версии — асинхронные.

Пример изменения в `bot.ts`:

```typescript
// Было (SQLite — синхронно):
const user = users.get(userId);

// Стало (PostgreSQL — асинхронно):
const user = await users.get(userId);
```

Аналогично для всех остальных вызовов `proxies.*` и `users.*`.

---

## Экспорт данных из SQLite перед миграцией

```bash
# Экспортировать данные в SQL-дамп
sqlite3 dev.db .dump > backup.sql

# Или в CSV для ручного импорта
sqlite3 -csv dev.db "SELECT * FROM proxies;" > proxies.csv
sqlite3 -csv dev.db "SELECT * FROM users;" > users.csv
```

Импорт CSV в Supabase — через Table Editor → Import CSV.

---

## Итого: что меняется при миграции

| Что          | SQLite (сейчас)         | Supabase (потом)              |
|--------------|-------------------------|-------------------------------|
| Драйвер      | `better-sqlite3`        | `postgres`                    |
| Вызовы       | синхронные              | async/await                   |
| `.env`       | `file:./dev.db`         | `postgresql://...`            |
| Файлы кода   | только `db.ts`          | `db.ts` + await в 3 файлах   |
| Схема        | авто при старте         | SQL в Supabase Dashboard      |
