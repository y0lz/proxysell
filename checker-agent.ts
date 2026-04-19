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
const MIN_ACTIVE  = 10;
const MAX_ROUNDS  = 50;

const TELEGRAM_DCS = [
    { host: "149.154.175.53",  port: 443 },
    { host: "149.154.167.51",  port: 443 },
    { host: "149.154.175.100", port: 443 },
    { host: "149.154.167.91",  port: 443 },
    { host: "91.108.56.130",   port: 443 },
];

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
        const dc = TELEGRAM_DCS[Math.floor(Math.random() * TELEGRAM_DCS.length)]!;
        const agent = new SocksProxyAgent(`socks5://${host}:${port}`, { timeout: TIMEOUT_MS });
        const start = Date.now();
        const req = https.get(
            { hostname: dc.host, port: dc.port, path: "/", agent, timeout: TIMEOUT_MS },
            (res) => { res.resume(); resolve(Date.now() - start); }
        );
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
    });
}

// MTProto: TCP + отправляем 16 случайных байт и ждём хоть какой-то ответ
// Это лучше чем просто connect — мёртвые прокси закроют соединение сразу
function checkMtproto(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
        socket.on("connect", () => {
            // Шлём случайные байты — живой MTProto прокси не закроет соединение сразу
            socket.write(Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))));
        });
        // Любой ответ = прокси живой и реагирует
        socket.on("data", () => {
            socket.destroy();
            resolve(Date.now() - start);
        });
        // Если закрыл без ответа — мёртвый
        socket.on("close", (hadError) => {
            if (!hadError) reject(new Error("closed without response"));
        });
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

// Возвращает { active, batchEmpty }
async function checkBatch(): Promise<{ active: number; batchEmpty: boolean }> {
    let batch: ProxyRow[];
    try {
        batch = await apiRequest<ProxyRow[]>("GET", "/unchecked");
    } catch (err) {
        console.error("[agent] Не удалось получить прокси:", err);
        return { active: 0, batchEmpty: false };
    }

    if (batch.length === 0) {
        console.log("[agent] Нет непроверенных прокси.");
        return { active: 0, batchEmpty: true };
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

    const active   = results.filter(r => r.status === "active").length;
    const slow     = results.filter(r => r.status === "slow").length;
    const dead     = results.filter(r => r.status === "dead").length;
    const mtActive = results.filter(r => r.status === "active" && batch.find(p => p.id === r.id)?.type === "MTPROTO").length;
    const s5Active = results.filter(r => r.status === "active" && batch.find(p => p.id === r.id)?.type === "SOCKS5").length;

    console.log(`[agent] Результат: MTProto активных ${mtActive}/${mtTotal}, SOCKS5 активных ${s5Active}/${s5Total}, медленных: ${slow}, мёртвых: ${dead}`);

    await reportWithRetry(results);

    return { active, batchEmpty: false };
}

// ─── Основной цикл ────────────────────────────────────────────────────────────

async function runAgentCycle(): Promise<void> {
    let totalActive = 0;
    let round = 0;

    while (totalActive < MIN_ACTIVE && round < MAX_ROUNDS) {
        round++;
        const { active, batchEmpty } = await checkBatch();
        totalActive += active;

        if (totalActive >= MIN_ACTIVE) {
            console.log(`[agent] Достигнут минимум ${MIN_ACTIVE} активных за ${round} раундов.`);
            break;
        }

        if (batchEmpty) {
            // Непроверенных нет — просим скрапинг и ждём
            console.log("[agent] Непроверенных нет, запрашиваем скрапинг...");
            try { await apiRequest("POST", "/rescrape"); } catch { /* ignore */ }
            await sleep(30_000);
        }
    }

    if (totalActive < MIN_ACTIVE) {
        console.log(`[agent] Найдено ${totalActive}/${MIN_ACTIVE} активных после ${round} раундов.`);
    }
}

// ─── Health-check HTTP сервер ─────────────────────────────────────────────────

const HEALTH_PORT = Number(process.env["HEALTH_PORT"] ?? 3001);
http.createServer((req, res) => {
    if (req.url === "/ping") { res.writeHead(200).end("ok"); return; }
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
