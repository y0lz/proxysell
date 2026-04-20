// db.ts — единственное место, где живёт логика работы с БД.
// Для миграции на Supabase см. MIGRATION.md
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawUrl = process.env["DATABASE_URL"] ?? "dev.db";
// better-sqlite3 не понимает префикс "file:", убираем его
const DB_PATH = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;

const db = new Database(DB_PATH);

// WAL-режим — снижает блокировки при параллельных чтениях/записях
db.pragma("journal_mode = WAL");

// ─── Схема ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY,
    is_vip    INTEGER NOT NULL DEFAULT 0,
    vip_until TEXT,
    last_free TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proxies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    link       TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'unchecked',
    ping_ms    INTEGER,
    country    TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try { db.exec(`ALTER TABLE users ADD COLUMN vip_until TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE proxies ADD COLUMN country TEXT`); } catch { /* уже есть */ }

// Таблица репутации прокси
db.exec(`
  CREATE TABLE IF NOT EXISTS proxy_votes (
    proxy_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    vote      TEXT NOT NULL, -- 'like' | 'dislike' | 'fire'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (proxy_id, user_id)
  );
`);

// Добавляем счётчики репутации в proxies если нет
try { db.exec(`ALTER TABLE proxies ADD COLUMN likes INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE proxies ADD COLUMN dislikes INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE proxies ADD COLUMN fires INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface User {
    id: number;
    is_vip: number;
    vip_until: string | null;
    last_free: string | null;
    joined_at: string;
}

export interface Proxy {
    id: number;
    type: string;
    link: string;
    status: string;
    ping_ms: number | null;
    country: string | null;
    likes: number;
    dislikes: number;
    fires: number;
    updated_at: string;
}

// ─── Users ────────────────────────────────────────────────────────────────────

const stmtUpsertUser = db.prepare(`
  INSERT INTO users (id) VALUES (@id)
  ON CONFLICT(id) DO NOTHING
`);

const stmtGetUser = db.prepare<[number], User>(`
  SELECT * FROM users WHERE id = ?
`);

const stmtSetLastFree = db.prepare(`
  UPDATE users SET last_free = datetime('now') WHERE id = ?
`);

const stmtSetVip = db.prepare(`
  UPDATE users SET is_vip = 1, vip_until = @vip_until WHERE id = @id
`);

const stmtExpireVip = db.prepare(`
  UPDATE users SET is_vip = 0, vip_until = NULL
  WHERE vip_until IS NOT NULL AND vip_until < datetime('now')
`);

export const users = {
    upsert: (id: number) => stmtUpsertUser.run({ id }),
    get: (id: number): User | undefined => stmtGetUser.get(id),
    setLastFree: (id: number) => stmtSetLastFree.run(id),
    // daysCount — сколько дней VIP (1, 7, 30 и т.д.)
    setVip: (id: number, daysCount: number) => {
        const vip_until = new Date(Date.now() + daysCount * 86400_000).toISOString();
        stmtSetVip.run({ id, vip_until });
    },
    expireVip: () => stmtExpireVip.run(),
};

// ─── Proxies ──────────────────────────────────────────────────────────────────

const stmtInsertProxy = db.prepare(`
  INSERT OR IGNORE INTO proxies (type, link, status)
  VALUES (@type, @link, @status)
`);

const stmtGetFastActive = db.prepare<[], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active'
  ORDER BY ping_ms ASC
  LIMIT 1
`);

const stmtGetFastActiveByType = db.prepare<[string], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ?
  ORDER BY ping_ms ASC
  LIMIT 1
`);

// VIP — сначала прокси с лайками, потом по пингу
const stmtGetVipProxy = db.prepare<[string], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ?
  ORDER BY likes DESC, ping_ms ASC
  LIMIT 1
`);

// Следующий прокси для rerolla — исключаем текущий
const stmtGetNextProxy = db.prepare<[string, number], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ? AND id != ?
  ORDER BY likes DESC, ping_ms ASC
  LIMIT 1
`);

const stmtGetUnchecked = db.prepare<[], Proxy>(`
  SELECT * FROM proxies WHERE status = 'unchecked'
  ORDER BY CASE type WHEN 'MTPROTO' THEN 0 ELSE 1 END
  LIMIT 100
`);

const stmtSetStatus = db.prepare(`
  UPDATE proxies
  SET status = @status, ping_ms = @ping_ms, updated_at = datetime('now')
  WHERE id = @id
`);

const stmtVote = db.prepare(`
  INSERT INTO proxy_votes (proxy_id, user_id, vote) VALUES (@proxy_id, @user_id, @vote)
  ON CONFLICT(proxy_id, user_id) DO UPDATE SET vote = @vote, created_at = datetime('now')
`);

const stmtUpdateReputation = db.prepare(`
  UPDATE proxies SET
    likes    = (SELECT COUNT(*) FROM proxy_votes WHERE proxy_id = @id AND vote = 'like'),
    dislikes = (SELECT COUNT(*) FROM proxy_votes WHERE proxy_id = @id AND vote = 'dislike'),
    fires    = (SELECT COUNT(*) FROM proxy_votes WHERE proxy_id = @id AND vote = 'fire')
  WHERE id = @id
`);

const stmtSetCountry = db.prepare(`
  UPDATE proxies SET country = @country WHERE id = @id
`);

const stmtGetById = db.prepare<[number], Proxy>(`SELECT * FROM proxies WHERE id = ?`);

const stmtDeleteDead = db.prepare(`
  DELETE FROM proxies
  WHERE status = 'dead'
    AND updated_at < datetime('now', '-1 day')
`);

const stmtCountByStatus = db.prepare<[string], { count: number }>(`
  SELECT COUNT(*) as count FROM proxies WHERE status = ?
`);

export const proxies = {
    insert: (type: string, link: string) =>
        stmtInsertProxy.run({ type, link, status: "unchecked" }),
    getFastActive: (): Proxy | undefined => stmtGetFastActive.get(),
    getFastActiveByType: (type: string): Proxy | undefined => stmtGetFastActiveByType.get(type),
    getVipProxy: (type: string): Proxy | undefined => stmtGetVipProxy.get(type),
    getNextProxy: (type: string, excludeId: number): Proxy | undefined => stmtGetNextProxy.get(type, excludeId),
    getById: (id: number): Proxy | undefined => stmtGetById.get(id),
    getUnchecked: (): Proxy[] => stmtGetUnchecked.all(),
    setStatus: (id: number, status: string, ping_ms: number | null) =>
        stmtSetStatus.run({ id, status, ping_ms }),
    setCountry: (id: number, country: string) =>
        stmtSetCountry.run({ id, country }),
    vote: (proxy_id: number, user_id: number, vote: "like" | "dislike" | "fire") => {
        stmtVote.run({ proxy_id, user_id, vote });
        stmtUpdateReputation.run({ id: proxy_id });
        // Если много дизлайков — помечаем как dead
        const proxy = stmtGetById.get(proxy_id);
        if (proxy && proxy.dislikes >= 5 && proxy.dislikes > proxy.likes * 2) {
            stmtSetStatus.run({ id: proxy_id, status: "dead", ping_ms: null });
        }
    },
    deleteDead: () => {
        const result = stmtDeleteDead.run();
        return result.changes;
    },
    resetDeadMtproto: () => {
        db.prepare(`UPDATE proxies SET status='unchecked' WHERE type='MTPROTO' AND status='dead'`).run();
    },
    countByStatus: (status: string): number =>
        stmtCountByStatus.get(status)?.count ?? 0,
};

export default db;
