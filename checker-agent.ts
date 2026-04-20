// checker-agent.ts — запускается на RU VPS
import "dotenv/config";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";

const MAIN_SERVER  = process.env["MAIN_SERVER_URL"] ?? "";
const API_SECRET   = process.env["API_SECRET"]      ?? "";
const HEALTH_PORT  = Number(process.env["HEALTH_PORT"] ?? 3001);

const TIMEOUT_MS   = 6_000;
const CONCURRENCY  = 100;
const MIN_ACTIVE   = 10;   // минимум активных MTProto в базе
const CYCLE_MS     = 15 * 60 * 1000; // повторный цикл каждые 15 минут

const TELEGRAM_DCS = [
    { host: "149.154.175.53",  port: 443 },
    { host: "149.154.167.51",  port: 443 },
    { host: "149.154.175.100", port: 443 },
    { host: "149.154.167.91",  port: 443 },
    { host: "91.108.56.130",   port: 443 },
];

// ─── Типы ─────────────────────────────────────────────────────────────────────

interface ProxyRow {
    id: number; type: string; link: string;
    status: string; ping_ms: number | null; country: string | null;
}
interface CheckResult { id: number; status: string; ping_ms: number | null; }
interface StatsResponse { active_mt: number; unchecked: number; }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── HTTP утилиты ─────────────────────────────────────────────────────────────

function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
        const url = new URL(MAIN_SERVER + path);
        const isHttps = url.protocol === "https:";
        const mod = isHttps ? https : http;
        const bodyStr = body ? JSON.stringify(body) : undefined;
        const req = mod.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname, method,
                headers: {
                    "x-api-secret": API_SECRET,
                    "Content-Type": "application/json",
                    ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
                },
                timeout: 60_000, // Увеличил до 60 секунд
            },
            (res) => {
                let data = "";
                res.on("data", c => { data += c; });
                res.on("end", () => {
                    try { resolve(JSON.parse(data) as T); }
                    catch { reject(new Error(`Bad JSON: ${data.slice(0, 100)}`)); }
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function reportWithRetry(results: CheckResult[]): Promise<void> {
    for (let i = 0; i < 3; i++) {
        try { await apiRequest("POST", "/report", results); return; }
        catch { if (i < 2) await sleep(2_000); }
    }
    console.error("[agent] Не удалось отправить результаты после 3 попыток");
}

// ─── Парсеры ──────────────────────────────────────────────────────────────────

function parseSocks5(link: string) {
    try {
        const url = new URL(link.replace("tg://socks", "http://socks"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        return host && port ? { host, port } : null;
    } catch { return null; }
}

function parseMtproto(link: string) {
    try {
        const url = new URL(link.replace("tg://proxy", "http://proxy"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        return host && port ? { host, port } : null;
    } catch { return null; }
}

// ─── Проверки ─────────────────────────────────────────────────────────────────

function checkSocks5(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const agent = new SocksProxyAgent(`socks5://${host}:${port}`);
        const start = Date.now();
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; req.destroy(); reject(new Error("timeout")); }
        }, TIMEOUT_MS);
        const req = https.get(
            { hostname: "api.telegram.org", port: 443, path: "/", agent },
            (res) => {
                if (done) return;
                done = true; clearTimeout(timer); res.resume();
                if (res.statusCode && res.statusCode < 500) resolve(Date.now() - start);
                else reject(new Error(`HTTP ${res.statusCode}`));
            }
        );
        req.on("timeout", () => { if (!done) { done = true; clearTimeout(timer); req.destroy(); reject(new Error("timeout")); } });
        req.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
}

function checkMtproto(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
        socket.on("connect", () => { socket.destroy(); resolve(Date.now() - start); });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
        socket.on("error", reject);
    });
}

async function checkOne(proxy: ProxyRow): Promise<CheckResult> {
    try {
        let ping: number;
        if (proxy.type === "SOCKS5") {
            const addr = parseSocks5(proxy.link);
            if (!addr) return { id: proxy.id, status: "dead", ping_ms: null };
            ping = await checkSocks5(addr.host, addr.port);
        } else {
            const addr = parseMtproto(proxy.link);
            if (!addr) return { id: proxy.id, status: "dead", ping_ms: null };
            ping = await checkMtproto(addr.host, addr.port);
        }
        return { id: proxy.id, status: ping <= 3000 ? "active" : "slow", ping_ms: ping };
    } catch {
        return { id: proxy.id, status: "dead", ping_ms: null };
    }
}

// ─── Основной цикл ────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    console.log("[agent] ── Новый цикл ──────────────────────────────────");

    // Узнаём текущее состояние базы
    let stats: StatsResponse;
    try {
        stats = await apiRequest<StatsResponse>("GET", "/stats");
    } catch (err) {
        console.error("[agent] Не удалось получить статистику:", err);
        console.log("[agent] Повторная попытка через 30 секунд...");
        return; // Выходим из цикла, следующий запуск через 15 минут
    }

    const needMore = stats.active_mt < MIN_ACTIVE;
    console.log(`[agent] Активных: ${stats.active_mt}/${MIN_ACTIVE}, непроверенных: ${stats.unchecked} | режим: ${needMore ? "🔴 агрессивный" : "🟢 обычный"}`);

    // Если непроверенных нет — просим скрапинг
    if (stats.unchecked === 0) {
        console.log("[agent] Непроверенных нет, запрашиваем скрапинг...");
        try { await apiRequest("POST", "/rescrape"); } catch { /* ignore */ }
        await sleep(45_000);
        try { stats = await apiRequest<StatsResponse>("GET", "/stats"); } catch { return; }
        if (stats.unchecked === 0) {
            console.log("[agent] После скрапинга непроверенных нет. Выходим.");
            return;
        }
    }

    // Проверяем все unchecked батчами
    let totalChecked = 0;
    let totalActive  = 0;
    let currentActive = stats.active_mt;

    while (true) {
        let batch: ProxyRow[];
        try {
            batch = await apiRequest<ProxyRow[]>("GET", "/unchecked");
        } catch (err) {
            console.error("[agent] Ошибка получения батча:", err);
            break;
        }

        if (batch.length === 0) {
            console.log("[agent] Все непроверенные обработаны.");
            break;
        }

        const mtCount = batch.filter(p => p.type === "MTPROTO").length;
        const s5Count = batch.filter(p => p.type === "SOCKS5").length;
        console.log(`[agent] Проверяем ${batch.length} (MT:${mtCount} S5:${s5Count})...`);

        const results: CheckResult[] = [];
        for (let i = 0; i < batch.length; i += CONCURRENCY) {
            const chunk = batch.slice(i, i + CONCURRENCY);
            const settled = await Promise.allSettled(chunk.map(checkOne));
            for (const r of settled) {
                if (r.status === "fulfilled") results.push(r.value);
            }
        }

        const batchActive = results.filter(r => r.status === "active").length;
        const batchDead   = results.filter(r => r.status === "dead").length;
        totalChecked  += results.length;
        totalActive   += batchActive;
        currentActive += batchActive;

        console.log(`[agent] Батч: +${batchActive} активных, ${batchDead} мёртвых | итого активных: ${currentActive}`);
        await reportWithRetry(results);

        // В агрессивном режиме (мало активных) — сразу запрашиваем скрапинг
        // если нашли мало и батч был маленький (источники иссякают)
        if (currentActive < MIN_ACTIVE && batch.length < 20) {
            console.log("[agent] Мало активных и мало непроверенных — запрашиваем скрапинг...");
            try { await apiRequest("POST", "/rescrape"); } catch { /* ignore */ }
            await sleep(45_000);
        }
    }

    console.log(`[agent] Цикл завершён. Проверено: ${totalChecked}, найдено активных: ${totalActive}, итого в базе: ${currentActive}`);
}

// ─── Health-check + restart HTTP сервер ──────────────────────────────────────

http.createServer((req, res) => {
    const auth = req.headers["x-api-secret"];

    if (req.url === "/ping") { res.writeHead(200).end("ok"); return; }

    if (!API_SECRET || auth !== API_SECRET) {
        res.writeHead(401).end("Unauthorized");
        return;
    }

    if (req.method === "POST" && req.url === "/restart") {
        console.log("[agent] Получен запрос на перезапуск...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 300);
        return;
    }

    if (req.method === "POST" && req.url === "/restart-peer") {
        console.log("[agent] Отправляем команду перезапуска NL серверу...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        const url = new URL(MAIN_SERVER + "/restart");
        const req2 = http.request(
            { hostname: url.hostname, port: url.port, path: "/restart", method: "POST",
              headers: { "x-api-secret": API_SECRET }, timeout: 5_000 },
            (r) => { r.resume(); }
        );
        req2.on("error", () => {});
        req2.end();
        return;
    }

    res.writeHead(404).end();
}).listen(HEALTH_PORT, () => {
    console.log(`[agent] Health-check на порту ${HEALTH_PORT}`);
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

if (!MAIN_SERVER) {
    console.error("Ошибка: MAIN_SERVER_URL не задан в .env");
    process.exit(1);
}

console.log(`[agent] Запущен. Сервер: ${MAIN_SERVER}`);
await runCycle();
setInterval(() => { void runCycle(); }, CYCLE_MS);
