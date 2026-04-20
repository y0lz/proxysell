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
// Включаем foreign keys
db.pragma("foreign_keys = ON");

// ─── Схема ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY,
    username            TEXT,
    first_name          TEXT,
    plan                TEXT NOT NULL DEFAULT 'free', -- 'free' | 'plus'
    plus_until          TEXT,
    sub_notified        INTEGER NOT NULL DEFAULT 0,
    reroll_count        INTEGER NOT NULL DEFAULT 0,
    reroll_window_start TEXT,
    last_reroll_at      TEXT,
    shown_proxy_ids     TEXT NOT NULL DEFAULT '[]', -- JSON массив
    joined_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proxies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    link       TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'unchecked',
    ping_ms    INTEGER,
    country    TEXT,
    likes      INTEGER NOT NULL DEFAULT 0,
    dislikes   INTEGER NOT NULL DEFAULT 0,
    fires      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proxy_votes (
    proxy_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    vote       TEXT NOT NULL, -- 'like' | 'dislike' | 'fire'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (proxy_id, user_id),
    FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS plans (
    id                TEXT PRIMARY KEY, -- 'plus_10', 'plus_30', 'plus_60'
    duration_days     INTEGER NOT NULL,
    stars             INTEGER NOT NULL,
    reroll_limit      INTEGER NOT NULL,
    reroll_window_sec INTEGER NOT NULL,
    reroll_cd_sec     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    plan            TEXT NOT NULL, -- 'plus'
    duration_days   INTEGER NOT NULL,
    stars_amount    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
    payload         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Миграция старых колонок
try { db.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN plus_until TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN sub_notified INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN reroll_count INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN reroll_window_start TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN last_reroll_at TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN shown_proxy_ids TEXT NOT NULL DEFAULT '[]'`); } catch { /* уже есть */ }

// Создаём индексы для производительности
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_plus_until ON users(plus_until);
  CREATE INDEX IF NOT EXISTS idx_proxies_status_type ON proxies(status, type);
  CREATE INDEX IF NOT EXISTS idx_proxies_likes_ping ON proxies(likes, ping_ms);
  CREATE INDEX IF NOT EXISTS idx_proxies_updated_at ON proxies(updated_at);
  CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);

// Заполняем справочник тарифов если пустой
const planCount = db.prepare(`SELECT COUNT(*) as count FROM plans`).get() as { count: number };
if (planCount.count === 0) {
    const insertPlan = db.prepare(`
        INSERT INTO plans (id, duration_days, stars, reroll_limit, reroll_window_sec, reroll_cd_sec)
        VALUES (@id, @duration_days, @stars, @reroll_limit, @reroll_window_sec, @reroll_cd_sec)
    `);
    
    const defaultPlans = [
        { id: 'free', duration_days: 0, stars: 0, reroll_limit: 3, reroll_window_sec: 14400, reroll_cd_sec: 0 }, // 4 часа
        { id: 'plus_10', duration_days: 10, stars: 13, reroll_limit: 10, reroll_window_sec: 300, reroll_cd_sec: 10 }, // 5 мин
        { id: 'plus_30', duration_days: 30, stars: 30, reroll_limit: 10, reroll_window_sec: 300, reroll_cd_sec: 10 },
        { id: 'plus_60', duration_days: 60, stars: 50, reroll_limit: 10, reroll_window_sec: 300, reroll_cd_sec: 10 },
    ];
    
    for (const plan of defaultPlans) {
        insertPlan.run(plan);
    }
}

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface User {
    id: number;
    username: string | null;
    first_name: string | null;
    plan: 'free' | 'plus';
    plus_until: string | null;
    sub_notified: number;
    reroll_count: number;
    reroll_window_start: string | null;
    last_reroll_at: string | null;
    shown_proxy_ids: string; // JSON массив
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

export interface Plan {
    id: string;
    duration_days: number;
    stars: number;
    reroll_limit: number;
    reroll_window_sec: number;
    reroll_cd_sec: number;
}

export interface Payment {
    id: number;
    user_id: number;
    plan: string;
    duration_days: number;
    stars_amount: number;
    status: 'pending' | 'paid' | 'failed';
    payload: string | null;
    created_at: string;
    paid_at: string | null;
}

// ─── Users ────────────────────────────────────────────────────────────────────

const stmtUpsertUser = db.prepare(`
  INSERT INTO users (id, username, first_name) 
  VALUES (@id, @username, @first_name)
  ON CONFLICT(id) DO UPDATE SET 
    username = @username,
    first_name = @first_name
`);

const stmtGetUser = db.prepare<[number], User>(`
  SELECT * FROM users WHERE id = ?
`);

// Проверка истечения подписок
const stmtExpireSubscriptions = db.prepare(`
  UPDATE users 
  SET plan = 'free', plus_until = NULL, sub_notified = 0
  WHERE plus_until IS NOT NULL AND plus_until < datetime('now')
`);

// Получить пользователей для уведомления (подписка истекает через 24ч)
const stmtGetUsersForNotification = db.prepare<[], User>(`
  SELECT * FROM users
  WHERE plus_until IS NOT NULL
    AND sub_notified = 0
    AND datetime(plus_until) BETWEEN datetime('now', '+23 hours') AND datetime('now', '+25 hours')
`);

const stmtSetSubNotified = db.prepare(`
  UPDATE users SET sub_notified = 1 WHERE id = ?
`);

const stmtResetSubNotified = db.prepare(`
  UPDATE users SET sub_notified = 0 WHERE id = ?
`);

const stmtUpdateRerollData = db.prepare(`
  UPDATE users 
  SET reroll_count = @reroll_count, 
      reroll_window_start = @reroll_window_start,
      last_reroll_at = @last_reroll_at,
      shown_proxy_ids = @shown_proxy_ids
  WHERE id = @id
`);

export const users = {
    upsert: (id: number, username?: string, first_name?: string) => 
        stmtUpsertUser.run({ id, username: username ?? null, first_name: first_name ?? null }),
    
    get: (id: number): User | undefined => stmtGetUser.get(id),
    
    // Истечение подписок
    expireSubscriptions: () => stmtExpireSubscriptions.run(),
    
    // Уведомления о подписке
    getUsersForNotification: (): User[] => stmtGetUsersForNotification.all(),
    
    setSubNotified: (id: number) => stmtSetSubNotified.run(id),
    
    resetSubNotified: (id: number) => stmtResetSubNotified.run(id),
    
    // Проверка Plus статуса
    isPlus: (user: User): boolean => {
        if (user.plan === 'free') return false;
        if (!user.plus_until) return false;
        return new Date(user.plus_until) > new Date();
    },
    
    // Обновить данные реролла
    updateRerollData: (userId: number, rerollCount: number, windowStart: string | null, lastRerollAt: string | null, shownProxyIds: number[]) => {
        stmtUpdateRerollData.run({
            id: userId,
            reroll_count: rerollCount,
            reroll_window_start: windowStart,
            last_reroll_at: lastRerollAt,
            shown_proxy_ids: JSON.stringify(shownProxyIds)
        });
    },
};

// ─── Plans ────────────────────────────────────────────────────────────────────

const stmtGetAllPlans = db.prepare<[], Plan>(`SELECT * FROM plans WHERE id != 'free' ORDER BY stars ASC`);
const stmtGetPlanById = db.prepare<[string], Plan>(`SELECT * FROM plans WHERE id = ?`);

export const plans = {
    getAll: (): Plan[] => stmtGetAllPlans.all(),
    getById: (id: string): Plan | undefined => stmtGetPlanById.get(id),
};

// ─── Payments ─────────────────────────────────────────────────────────────────

const stmtCreatePayment = db.prepare(`
  INSERT INTO payments (user_id, plan, duration_days, stars_amount, status, payload)
  VALUES (@user_id, @plan, @duration_days, @stars_amount, @status, @payload)
`);

const stmtGetPaymentById = db.prepare<[number], Payment>(`
  SELECT * FROM payments WHERE id = ?
`);

const stmtGetPaymentByPayload = db.prepare<[string], Payment>(`
  SELECT * FROM payments WHERE payload = ?
`);

const stmtUpdatePaymentStatus = db.prepare(`
  UPDATE payments 
  SET status = @status, paid_at = CASE WHEN @status = 'paid' THEN datetime('now') ELSE paid_at END
  WHERE id = @id
`);

const stmtGetUserPayments = db.prepare<[number], Payment>(`
  SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC
`);

// Подтверждение оплаты — транзакция: обновить payment + продлить подписку
const confirmPayment = db.transaction((paymentId: number) => {
    const payment = stmtGetPaymentById.get(paymentId);
    if (!payment || payment.status !== 'pending') {
        throw new Error('Payment not found or already processed');
    }
    
    const user = stmtGetUser.get(payment.user_id);
    if (!user) {
        throw new Error('User not found');
    }
    
    // Обновляем статус платежа
    stmtUpdatePaymentStatus.run({ id: paymentId, status: 'paid' });
    
    // Продлеваем подписку
    let newPlusUntil: Date;
    if (user.plus_until && new Date(user.plus_until) > new Date()) {
        // Если подписка активна — прибавляем к текущей дате
        newPlusUntil = new Date(user.plus_until);
        newPlusUntil.setDate(newPlusUntil.getDate() + payment.duration_days);
    } else {
        // Если подписки нет или истекла — начинаем с текущей даты
        newPlusUntil = new Date();
        newPlusUntil.setDate(newPlusUntil.getDate() + payment.duration_days);
    }
    
    // Обновляем пользователя
    db.prepare(`
        UPDATE users 
        SET plan = 'plus', plus_until = @plus_until, sub_notified = 0
        WHERE id = @id
    `).run({
        id: payment.user_id,
        plus_until: newPlusUntil.toISOString(),
    });
    
    return { payment, newPlusUntil };
});

export const payments = {
    create: (user_id: number, plan: string, duration_days: number, stars_amount: number, payload?: string) => {
        const result = stmtCreatePayment.run({
            user_id,
            plan,
            duration_days,
            stars_amount,
            status: 'pending',
            payload: payload ?? null,
        });
        return result.lastInsertRowid as number;
    },
    
    getById: (id: number): Payment | undefined => stmtGetPaymentById.get(id),
    
    getByPayload: (payload: string): Payment | undefined => stmtGetPaymentByPayload.get(payload),
    
    updateStatus: (id: number, status: 'paid' | 'failed') => 
        stmtUpdatePaymentStatus.run({ id, status }),
    
    getUserPayments: (user_id: number): Payment[] => stmtGetUserPayments.all(user_id),
    
    // Подтверждение оплаты с продлением подписки (транзакция)
    confirm: confirmPayment,
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

// Прокси для новых пользователей (средний по рейтингу)
const stmtGetProxyForNewUser = db.prepare<[], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = 'MTPROTO'
  ORDER BY likes ASC
  LIMIT 1 OFFSET (
    SELECT COUNT(*) / 2 FROM proxies 
    WHERE status = 'active' AND type = 'MTPROTO'
  )
`);

// Plus прокси (лучшие по рейтингу)
const stmtGetPlusProxy = db.prepare<[string], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ?
  ORDER BY likes DESC, ping_ms ASC
  LIMIT 1
`);

// Free прокси (случайный)
const stmtGetFreeProxy = db.prepare<[string], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ?
  ORDER BY RANDOM()
  LIMIT 1
`);

// Следующий прокси с учётом shown_proxy_ids
function getNextProxyWithHistory(type: string, shownIds: number[], isPlus: boolean): Proxy | undefined {
    let query: string;
    let params: any[];
    
    if (shownIds.length === 0) {
        // Первый прокси
        if (isPlus) {
            query = `SELECT * FROM proxies WHERE status = 'active' AND type = ? ORDER BY likes DESC, ping_ms ASC LIMIT 1`;
            params = [type];
        } else {
            query = `SELECT * FROM proxies WHERE status = 'active' AND type = ? ORDER BY RANDOM() LIMIT 1`;
            params = [type];
        }
    } else {
        // Исключаем уже показанные
        const placeholders = shownIds.map(() => '?').join(',');
        if (isPlus) {
            query = `SELECT * FROM proxies WHERE status = 'active' AND type = ? AND id NOT IN (${placeholders}) ORDER BY likes DESC, ping_ms ASC LIMIT 1`;
        } else {
            query = `SELECT * FROM proxies WHERE status = 'active' AND type = ? AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`;
        }
        params = [type, ...shownIds];
    }
    
    const stmt = db.prepare<any[], Proxy>(query);
    return stmt.get(...params);
}

// Проверка возможности реролла
function canReroll(userId: number): { allowed: boolean; reason: 'cd' | 'limit' | 'ok'; wait_sec?: number } {
    const user = stmtGetUser.get(userId);
    if (!user) return { allowed: false, reason: 'ok' };
    
    const now = new Date();
    const isPlus = users.isPlus(user);
    const planConfig = stmtGetPlanById.get(isPlus ? 'plus_10' : 'free');
    if (!planConfig) return { allowed: false, reason: 'ok' };
    
    // Проверяем кулдаун (только для Plus)
    if (isPlus && user.last_reroll_at) {
        const lastReroll = new Date(user.last_reroll_at);
        const cdMs = planConfig.reroll_cd_sec * 1000;
        const timeSinceLastReroll = now.getTime() - lastReroll.getTime();
        
        if (timeSinceLastReroll < cdMs) {
            const waitSec = Math.ceil((cdMs - timeSinceLastReroll) / 1000);
            return { allowed: false, reason: 'cd', wait_sec: waitSec };
        }
    }
    
    // Проверяем лимит в окне
    if (user.reroll_window_start) {
        const windowStart = new Date(user.reroll_window_start);
        const windowMs = planConfig.reroll_window_sec * 1000;
        const timeSinceWindowStart = now.getTime() - windowStart.getTime();
        
        if (timeSinceWindowStart < windowMs) {
            // Окно ещё активно
            if (user.reroll_count >= planConfig.reroll_limit) {
                const waitSec = Math.ceil((windowMs - timeSinceWindowStart) / 1000);
                return { allowed: false, reason: 'limit', wait_sec: waitSec };
            }
        }
        // Если окно истекло, счётчик сбросится в recordReroll
    }
    
    return { allowed: true, reason: 'ok' };
}

// Записать реролл
function recordReroll(userId: number): void {
    const user = stmtGetUser.get(userId);
    if (!user) return;
    
    const now = new Date();
    const isPlus = users.isPlus(user);
    const planConfig = stmtGetPlanById.get(isPlus ? 'plus_10' : 'free');
    if (!planConfig) return;
    
    let newCount = user.reroll_count;
    let newWindowStart = user.reroll_window_start;
    
    // Проверяем нужно ли сбросить окно
    if (user.reroll_window_start) {
        const windowStart = new Date(user.reroll_window_start);
        const windowMs = planConfig.reroll_window_sec * 1000;
        const timeSinceWindowStart = now.getTime() - windowStart.getTime();
        
        if (timeSinceWindowStart >= windowMs) {
            // Окно истекло, сбрасываем
            newCount = 0;
            newWindowStart = null;
        }
    }
    
    // Если окна нет или оно сброшено, создаём новое
    if (!newWindowStart) {
        newWindowStart = now.toISOString();
        newCount = 0;
    }
    
    // Увеличиваем счётчик
    newCount += 1;
    
    users.updateRerollData(userId, newCount, newWindowStart, now.toISOString(), JSON.parse(user.shown_proxy_ids));
}

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
    
    // Прокси для новых пользователей (средний по рейтингу)
    getProxyForNewUser: (): Proxy | undefined => stmtGetProxyForNewUser.get(),
    
    // Получить следующий прокси с учётом shown_proxy_ids и инфинити-ролла
    getNextProxy: (userId: number, type: string = "MTPROTO"): Proxy | undefined => {
        const user = stmtGetUser.get(userId);
        if (!user) return undefined;
        
        const isPlus = users.isPlus(user);
        const shownIds: number[] = JSON.parse(user.shown_proxy_ids);
        
        // Получаем общее количество активных прокси
        const totalActive = stmtCountByStatus.get('active')?.count ?? 0;
        
        // Если показали все прокси, сбрасываем список (инфинити-ролл)
        if (shownIds.length >= totalActive && totalActive > 0) {
            users.updateRerollData(userId, user.reroll_count, user.reroll_window_start, user.last_reroll_at, []);
            return getNextProxyWithHistory(type, [], isPlus);
        }
        
        // Получаем следующий прокси
        const proxy = getNextProxyWithHistory(type, shownIds, isPlus);
        
        // Добавляем в список показанных
        if (proxy) {
            const newShownIds = [...shownIds, proxy.id];
            users.updateRerollData(userId, user.reroll_count, user.reroll_window_start, user.last_reroll_at, newShownIds);
        }
        
        return proxy;
    },
    
    // Проверка возможности реролла
    canReroll: (userId: number) => canReroll(userId),
    
    // Записать реролл
    recordReroll: (userId: number) => recordReroll(userId),
    
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
    // Сбрасываем активные прокси старше N часов на перепроверку
    resetStaleActive: (olderThanHours = 6) => {
        const result = db.prepare(`
            UPDATE proxies SET status='unchecked'
            WHERE status='active'
            AND updated_at < datetime('now', '-${olderThanHours} hours')
        `).run();
        return result.changes;
    },
    countByStatus: (status: string): number =>
        stmtCountByStatus.get(status)?.count ?? 0,
};

export default db;
