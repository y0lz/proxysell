// checker-agent.ts — запускается на RU VPS
import "dotenv/config";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";

const MAIN_SERVER = process.env["MAIN_SERVER_URL"] ?? "";
const API_SECRET  = process.env["API_SECRET"]      ?? "";
const TIMEOUT_MS  = 6_000;
const CONCURRENCY = 100;
const INTERVAL_MS = 5 * 60 * 1000;
const MIN_ACTIVE_MT = 10;  // минимум активных MTProto
const MIN_ACTIVE_S5 = 10;  // минимум активных SOCKS5
const MAX_ROUNDS    = 200;

interface ProxyRow {
    id: number; type: string; link: string;
    status: string; ping_ms: number | null; country: string | null;
}
interface CheckResult {
    id: number; status: string; ping_ms: number | null;
}

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
                timeout: 30_000,
            },
            (res) => {
                let data = "";
                res.on("data", c => { data += c; });
                res.on("end", () => {
                    try { resolve(JSON.parse(data) as T); }
                    catch { reject(new Error("Bad JSON: " + data)); }
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// retry для POST /report — не теряем результаты при моргании сети
async function reportWithRetry(results: CheckResult[], retries = 2): Promise<void> {
    for (let i = 0; i <= retries; i++) {
        try {
            await apiRequest("POST", "/report", results);
            return;
        } catch (err) {
            if (i === retries) { console.error("[agent] Не удалось отправить результаты:", err); return; }
            console.warn(`[agent] Ошибка отправки, повтор ${i + 1}/${retries}...`);
            await sleep(2_000);
        }
    }
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

        // Страховочный таймаут — socks-proxy-agent иногда игнорирует timeout опцию
        const timer = setTimeout(() => {
            if (!done) { done = true; req.destroy(); reject(new Error("timeout")); }
        }, TIMEOUT_MS);

        const req = https.get(
            { hostname: "api.telegram.org", port: 443, path: "/", agent },
            (res) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                res.resume();
                if (res.statusCode && res.statusCode < 500) {
                    resolve(Date.now() - start);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }
        );
        req.on("timeout", () => { if (!done) { done = true; clearTimeout(timer); req.destroy(); reject(new Error("timeout")); } });
        req.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
}

// MTProto: простой TCP connect — если порт открыт, прокси живой
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

// ─── Батч-проверка ────────────────────────────────────────────────────────────

// Возвращает { activeMt, activeS5, batchEmpty }
async function checkBatch(): Promise<{ activeMt: number; activeS5: number; batchEmpty: boolean }> {
    let batch: ProxyRow[];
    try {
        batch = await apiRequest<ProxyRow[]>("GET", "/unchecked");
    } catch (err) {
        console.error("[agent] Не удалось получить прокси:", err);
        return { activeMt: 0, activeS5: 0, batchEmpty: false };
    }

    if (batch.length === 0) {
        console.log("[agent] Нет непроверенных прокси.");
        return { activeMt: 0, activeS5: 0, batchEmpty: true };
    }

    const mtTotal = batch.filter(p => p.type === "MTPROTO").length;
    const s5Total = batch.filter(p => p.type === "SOCKS5").length;
    console.log(`[agent] Проверяем ${batch.length} прокси (MTProto: ${mtTotal}, SOCKS5: ${s5Total})...`);

    const results: CheckResult[] = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(checkOne));
        for (const r of settled) {
            if (r.status === "fulfilled") results.push(r.value);
        }
    }

    const activeMt = results.filter(r => r.status === "active" && batch.find(p => p.id === r.id)?.type === "MTPROTO").length;
    const activeS5 = results.filter(r => r.status === "active" && batch.find(p => p.id === r.id)?.type === "SOCKS5").length;
    const slow     = results.filter(r => r.status === "slow").length;
    const dead     = results.filter(r => r.status === "dead").length;

    console.log(`[agent] Результат: MTProto активных ${activeMt}/${mtTotal}, SOCKS5 активных ${activeS5}/${s5Total}, медленных: ${slow}, мёртвых: ${dead}`);

    await reportWithRetry(results);

    return { activeMt, activeS5, batchEmpty: false };
}

// ─── Основной цикл ────────────────────────────────────────────────────────────

async function runAgentCycle(): Promise<void> {
    let totalMt = 0;
    let totalS5 = 0;
    let round = 0;

    while ((totalMt < MIN_ACTIVE_MT || totalS5 < MIN_ACTIVE_S5) && round < MAX_ROUNDS) {
        round++;
        const { activeMt, activeS5, batchEmpty } = await checkBatch();
        totalMt += activeMt;
        totalS5 += activeS5;

        console.log(`[agent] Раунд ${round}: MTProto ${totalMt}/${MIN_ACTIVE_MT}, SOCKS5 ${totalS5}/${MIN_ACTIVE_S5}`);

        if (totalMt >= MIN_ACTIVE_MT && totalS5 >= MIN_ACTIVE_S5) {
            console.log(`[agent] Достигнут минимум по обоим типам за ${round} раундов.`);
            break;
        }

        if (batchEmpty) {
            console.log("[agent] Непроверенных нет, запрашиваем скрапинг...");
            try { await apiRequest("POST", "/rescrape"); } catch { /* ignore */ }
            await sleep(30_000);
        }
    }

    if (totalMt < MIN_ACTIVE_MT || totalS5 < MIN_ACTIVE_S5) {
        console.log(`[agent] После ${round} раундов: MTProto ${totalMt}/${MIN_ACTIVE_MT}, SOCKS5 ${totalS5}/${MIN_ACTIVE_S5}`);
    }
}

// ─── Health-check + restart HTTP сервер ──────────────────────────────────────

const HEALTH_PORT  = Number(process.env["HEALTH_PORT"]  ?? 3001);
const MAIN_API_URL = process.env["MAIN_SERVER_URL"]     ?? "";

http.createServer((req, res) => {
    const auth = req.headers["x-api-secret"];
    if (req.url !== "/ping" && (!API_SECRET || auth !== API_SECRET)) {
        res.writeHead(401).end("Unauthorized");
        return;
    }

    if (req.url === "/ping") {
        res.writeHead(200).end("ok");
        return;
    }

    // POST /restart — перезапустить агент (PM2 поднимет)
    if (req.method === "POST" && req.url === "/restart") {
        console.log("[agent] Получен запрос на перезапуск...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 300);
        return;
    }

    // POST /restart-peer — перезапустить NL сервер
    if (req.method === "POST" && req.url === "/restart-peer") {
        console.log("[agent] Отправляем команду перезапуска NL серверу...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        if (MAIN_API_URL) {
            const url = new URL(MAIN_API_URL + "/restart");
            const req2 = http.request(
                { hostname: url.hostname, port: url.port, path: "/restart", method: "POST",
                  headers: { "x-api-secret": API_SECRET }, timeout: 5_000 },
                (r) => { r.resume(); console.log(`[agent] NL перезапущен, статус: ${r.statusCode}`); }
            );
            req2.on("error", (e) => console.error("[agent] Ошибка:", e.message));
            req2.end();
        }
        return;
    }

    res.writeHead(404).end();
}).listen(HEALTH_PORT, () => {
    console.log(`[agent] Health-check доступен на порту ${HEALTH_PORT} (/ping)`);
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

if (!MAIN_SERVER) {
    console.error("Ошибка: MAIN_SERVER_URL не задан в .env");
    process.exit(1);
}

console.log(`[agent] RU checker-agent запущен. Сервер: ${MAIN_SERVER}`);
await runAgentCycle();
setInterval(() => { void runAgentCycle(); }, INTERVAL_MS);
