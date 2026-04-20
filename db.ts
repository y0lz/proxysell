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
    id            INTEGER PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    plan          TEXT NOT NULL DEFAULT 'free', -- 'free' | 'vip' | 'vip_plus'
    vip_until     TEXT,
    sub_notified  INTEGER NOT NULL DEFAULT 0,
    last_free_at  TEXT,
    last_proxy_id INTEGER,
    joined_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
    id            TEXT PRIMARY KEY, -- 'vip_1m' | 'vip_3m' | 'vip_plus_1m' и т.д.
    name          TEXT NOT NULL,
    plan_type     TEXT NOT NULL, -- 'vip' | 'vip_plus'
    price_rub     INTEGER NOT NULL,
    price_stars   INTEGER,
    duration_days INTEGER NOT NULL,
    proxy_limit   INTEGER NOT NULL DEFAULT 1, -- прокси в день
    reroll_enabled INTEGER NOT NULL DEFAULT 0, -- 0 = нет, 1 = да
    description   TEXT
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    plan_id         TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    provider        TEXT NOT NULL, -- 'stars' | 'crypto' | 'card'
    invoice_payload TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed' | 'refunded'
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );
`);

// Миграция старых колонок
try { db.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN sub_notified INTEGER NOT NULL DEFAULT 0`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN last_free_at TEXT`); } catch { /* уже есть */ }
try { db.exec(`ALTER TABLE users ADD COLUMN last_proxy_id INTEGER`); } catch { /* уже есть */ }

// Создаём индексы для производительности
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_vip_until ON users(vip_until);
  CREATE INDEX IF NOT EXISTS idx_proxies_status_type ON proxies(status, type);
  CREATE INDEX IF NOT EXISTS idx_proxies_updated_at ON proxies(updated_at);
  CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);

// Заполняем справочник тарифов если пустой
const planCount = db.prepare(`SELECT COUNT(*) as count FROM plans`).get() as { count: number };
if (planCount.count === 0) {
    const insertPlan = db.prepare(`
        INSERT INTO plans (id, name, plan_type, price_rub, price_stars, duration_days, proxy_limit, reroll_enabled, description)
        VALUES (@id, @name, @plan_type, @price_rub, @price_stars, @duration_days, @proxy_limit, @reroll_enabled, @description)
    `);
    
    const defaultPlans = [
        { id: 'vip_1m', name: 'VIP 1 месяц', plan_type: 'vip', price_rub: 299, price_stars: 150, duration_days: 30, proxy_limit: 5, reroll_enabled: 1, description: 'Базовый VIP' },
        { id: 'vip_3m', name: 'VIP 3 месяца', plan_type: 'vip', price_rub: 799, price_stars: 400, duration_days: 90, proxy_limit: 5, reroll_enabled: 1, description: 'VIP на 3 месяца' },
        { id: 'vip_plus_1m', name: 'VIP+ 1 месяц', plan_type: 'vip_plus', price_rub: 499, price_stars: 250, duration_days: 30, proxy_limit: 999, reroll_enabled: 1, description: 'Безлимитные прокси' },
        { id: 'vip_plus_3m', name: 'VIP+ 3 месяца', plan_type: 'vip_plus', price_rub: 1299, price_stars: 650, duration_days: 90, proxy_limit: 999, reroll_enabled: 1, description: 'VIP+ на 3 месяца' },
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
    plan: 'free' | 'vip' | 'vip_plus';
    vip_until: string | null;
    sub_notified: number;
    last_free_at: string | null;
    last_proxy_id: number | null;
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
    name: string;
    plan_type: 'vip' | 'vip_plus';
    price_rub: number;
    price_stars: number | null;
    duration_days: number;
    proxy_limit: number;
    reroll_enabled: number;
    description: string | null;
}

export interface Payment {
    id: number;
    user_id: number;
    plan_id: string;
    amount: number;
    provider: 'stars' | 'crypto' | 'card';
    invoice_payload: string | null;
    status: 'pending' | 'paid' | 'failed' | 'refunded';
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

const stmtSetLastFreeAt = db.prepare(`
  UPDATE users SET last_free_at = datetime('now') WHERE id = ?
`);

const stmtSetLastProxyId = db.prepare(`
  UPDATE users SET last_proxy_id = ? WHERE id = ?
`);

// Проверка истечения подписок
const stmtExpireSubscriptions = db.prepare(`
  UPDATE users 
  SET plan = 'free', vip_until = NULL, sub_notified = 0
  WHERE vip_until IS NOT NULL AND vip_until < datetime('now')
`);

// Получить пользователей для уведомления (подписка истекает через 24ч)
const stmtGetUsersForNotification = db.prepare<[], User>(`
  SELECT * FROM users
  WHERE vip_until IS NOT NULL
    AND sub_notified = 0
    AND datetime(vip_until) BETWEEN datetime('now', '+23 hours') AND datetime('now', '+25 hours')
`);

const stmtSetSubNotified = db.prepare(`
  UPDATE users SET sub_notified = 1 WHERE id = ?
`);

const stmtResetSubNotified = db.prepare(`
  UPDATE users SET sub_notified = 0 WHERE id = ?
`);

export const users = {
    upsert: (id: number, username?: string, first_name?: string) => 
        stmtUpsertUser.run({ id, username: username ?? null, first_name: first_name ?? null }),
    
    get: (id: number): User | undefined => stmtGetUser.get(id),
    
    setLastFreeAt: (id: number) => stmtSetLastFreeAt.run(id),
    
    setLastProxyId: (userId: number, proxyId: number) => stmtSetLastProxyId.run(proxyId, userId),
    
    // Истечение подписок
    expireSubscriptions: () => stmtExpireSubscriptions.run(),
    
    // Уведомления о подписке
    getUsersForNotification: (): User[] => stmtGetUsersForNotification.all(),
    
    setSubNotified: (id: number) => stmtSetSubNotified.run(id),
    
    resetSubNotified: (id: number) => stmtResetSubNotified.run(id),
    
    // Проверка VIP статуса
    isVip: (user: User): boolean => {
        if (user.plan === 'free') return false;
        if (!user.vip_until) return false;
        return new Date(user.vip_until) > new Date();
    },
    
    // Проверка лимита бесплатных прокси (1 раз в 24ч)
    canGetFreeProxy: (user: User): boolean => {
        if (!user.last_free_at) return true;
        const lastFree = new Date(user.last_free_at);
        const now = new Date();
        return (now.getTime() - lastFree.getTime()) >= 24 * 60 * 60 * 1000;
    },
};

// ─── Plans ────────────────────────────────────────────────────────────────────

const stmtGetAllPlans = db.prepare<[], Plan>(`SELECT * FROM plans ORDER BY price_rub ASC`);
const stmtGetPlanById = db.prepare<[string], Plan>(`SELECT * FROM plans WHERE id = ?`);

export const plans = {
    getAll: (): Plan[] => stmtGetAllPlans.all(),
    getById: (id: string): Plan | undefined => stmtGetPlanById.get(id),
};

// ─── Payments ─────────────────────────────────────────────────────────────────

const stmtCreatePayment = db.prepare(`
  INSERT INTO payments (user_id, plan_id, amount, provider, invoice_payload, status)
  VALUES (@user_id, @plan_id, @amount, @provider, @invoice_payload, @status)
`);

const stmtGetPaymentById = db.prepare<[number], Payment>(`
  SELECT * FROM payments WHERE id = ?
`);

const stmtGetPaymentByInvoice = db.prepare<[string], Payment>(`
  SELECT * FROM payments WHERE invoice_payload = ?
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
    
    const plan = stmtGetPlanById.get(payment.plan_id);
    if (!plan) {
        throw new Error('Plan not found');
    }
    
    const user = stmtGetUser.get(payment.user_id);
    if (!user) {
        throw new Error('User not found');
    }
    
    // Обновляем статус платежа
    stmtUpdatePaymentStatus.run({ id: paymentId, status: 'paid' });
    
    // Продлеваем подписку
    let newVipUntil: Date;
    if (user.vip_until && new Date(user.vip_until) > new Date()) {
        // Если подписка активна — прибавляем к текущей дате
        newVipUntil = new Date(user.vip_until);
        newVipUntil.setDate(newVipUntil.getDate() + plan.duration_days);
    } else {
        // Если подписки нет или истекла — начинаем с текущей даты
        newVipUntil = new Date();
        newVipUntil.setDate(newVipUntil.getDate() + plan.duration_days);
    }
    
    // Обновляем пользователя
    db.prepare(`
        UPDATE users 
        SET plan = @plan, vip_until = @vip_until, sub_notified = 0
        WHERE id = @id
    `).run({
        id: payment.user_id,
        plan: plan.plan_type,
        vip_until: newVipUntil.toISOString(),
    });
    
    return { payment, plan, newVipUntil };
});

export const payments = {
    create: (user_id: number, plan_id: string, amount: number, provider: 'stars' | 'crypto' | 'card', invoice_payload?: string) => {
        const result = stmtCreatePayment.run({
            user_id,
            plan_id,
            amount,
            provider,
            invoice_payload: invoice_payload ?? null,
            status: 'pending',
        });
        return result.lastInsertRowid as number;
    },
    
    getById: (id: number): Payment | undefined => stmtGetPaymentById.get(id),
    
    getByInvoice: (invoice_payload: string): Payment | undefined => stmtGetPaymentByInvoice.get(invoice_payload),
    
    updateStatus: (id: number, status: 'paid' | 'failed' | 'refunded') => 
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

// Следующий прокси для reroll — исключаем массив ID
const stmtGetNextProxy = db.prepare<[string], Proxy>(`
  SELECT * FROM proxies
  WHERE status = 'active' AND type = ?
  ORDER BY likes DESC, RANDOM()
  LIMIT 1
`);

// Функция для получения следующего прокси с исключением массива ID
function getNextProxyExcluding(type: string, excludeIds: number[]): Proxy | undefined {
    if (excludeIds.length === 0) {
        return stmtGetNextProxy.get(type);
    }
    
    const placeholders = excludeIds.map(() => '?').join(',');
    const query = `
        SELECT * FROM proxies
        WHERE status = 'active' AND type = ? AND id NOT IN (${placeholders})
        ORDER BY likes DESC, RANDOM()
        LIMIT 1
    `;
    const stmt = db.prepare<[string, ...number[]], Proxy>(query);
    return stmt.get(type, ...excludeIds);
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
    getVipProxy: (type: string): Proxy | undefined => stmtGetVipProxy.get(type),
    
    // Получить следующий прокси с исключением массива ID (для реролла)
    getNextProxy: (type: string, excludeIds: number[] = []): Proxy | undefined => 
        getNextProxyExcluding(type, excludeIds),
    
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
