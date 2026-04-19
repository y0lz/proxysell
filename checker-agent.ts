// checker-agent.ts — запускается на RU VPS
// Забирает непроверенные прокси с основного сервера, проверяет, шлёт результаты обратно
import "dotenv/config";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";

const MAIN_SERVER  = process.env["MAIN_SERVER_URL"] ?? ""; // http://NL_IP:3000
const API_SECRET   = process.env["API_SECRET"]      ?? "";
const TIMEOUT_MS   = 6_000;
const CONCURRENCY  = 50;
const INTERVAL_MS  = 5 * 60 * 1000; // каждые 5 минут

// Официальные Telegram DC
const TELEGRAM_DCS = [
    { host: "149.154.175.53",  port: 443 },
    { host: "149.154.167.51",  port: 443 },
    { host: "149.154.175.100", port: 443 },
    { host: "149.154.167.91",  port: 443 },
    { host: "91.108.56.130",   port: 443 },
];

const BLOCKED_COUNTRIES = new Set(["RU", "BY", "KZ", "UZ", "TM", "TJ", "AZ", "AM", "KG"]);

// ─── Типы ─────────────────────────────────────────────────────────────────────

interface ProxyRow {
    id: number;
    type: string;
    link: string;
    status: string;
    ping_ms: number | null;
    country: string | null;
}

interface CheckResult {
    id: number;
    status: string;
    ping_ms: number | null;
    country?: string | null;
}

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
                path: url.pathname,
                method,
                headers: {
                    "x-api-secret": API_SECRET,
                    "Content-Type": "application/json",
                    ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
                },
                timeout: 15_000,
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

// ─── Гео-чек ──────────────────────────────────────────────────────────────────

interface IpApiResult { query: string; countryCode: string; status: string; }

async function fetchGeoCountries(ips: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ips.length === 0) return result;
    return new Promise((resolve) => {
        const body = JSON.stringify(ips.map(ip => ({ query: ip, fields: "query,countryCode,status" })));
        const req = http.request(
            { hostname: "ip-api.com", path: "/batch", method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
              timeout: 10_000 },
            (res) => {
                let data = "";
                res.on("data", c => { data += c; });
                res.on("end", () => {
                    try {
                        const list = JSON.parse(data) as IpApiResult[];
                        for (const item of list) {
                            if (item.status === "success") result.set(item.query, item.countryCode);
                        }
                    } catch { /* ignore */ }
                    resolve(result);
                });
            }
        );
        req.on("error", () => resolve(result));
        req.on("timeout", () => { req.destroy(); resolve(result); });
        req.write(body);
        req.end();
    });
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

function checkMtproto(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
        socket.on("connect", () => { socket.destroy(); resolve(Date.now() - start); });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
        socket.on("error", reject);
    });
}

async function checkOne(proxy: ProxyRow, geoMap: Map<string, string>): Promise<CheckResult> {
    try {
        let ping: number;

        if (proxy.type === "SOCKS5") {
            const addr = parseSocks5(proxy.link);
            if (!addr) return { id: proxy.id, status: "dead", ping_ms: null };

            const country = geoMap.get(addr.host) ?? null;
            if (country && BLOCKED_COUNTRIES.has(country)) {
                return { id: proxy.id, status: "dead", ping_ms: null, country };
            }

            ping = await checkSocks5(addr.host, addr.port);
            return { id: proxy.id, status: ping <= 3000 ? "active" : "slow", ping_ms: ping, country };
        } else {
            const addr = parseMtproto(proxy.link);
            if (!addr) return { id: proxy.id, status: "dead", ping_ms: null };
            ping = await checkMtproto(addr.host, addr.port);
            return { id: proxy.id, status: ping <= 3000 ? "active" : "slow", ping_ms: ping };
        }
    } catch {
        return { id: proxy.id, status: "dead", ping_ms: null };
    }
}

// ─── Основной цикл ────────────────────────────────────────────────────────────

async function runAgentCycle(): Promise<void> {
    console.log("[agent] Запрашиваем непроверенные прокси...");

    let batch: ProxyRow[];
    try {
        batch = await apiRequest<ProxyRow[]>("GET", "/unchecked");
    } catch (err) {
        console.error("[agent] Не удалось получить прокси:", err);
        return;
    }

    if (batch.length === 0) {
        console.log("[agent] Нет непроверенных прокси.");
        return;
    }

    console.log(`[agent] Проверяем ${batch.length} прокси из РФ...`);

    // Гео-чек
    const ips = [...new Set(
        batch.map(p => p.type === "SOCKS5" ? parseSocks5(p.link)?.host : null)
             .filter((h): h is string => h != null)
    )].slice(0, 100);
    const geoMap = await fetchGeoCountries(ips);

    // Проверяем пачками
    const results: CheckResult[] = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.allSettled(chunk.map(p => checkOne(p, geoMap)));
        for (const r of chunkResults) {
            if (r.status === "fulfilled") results.push(r.value);
        }
    }

    // Отправляем результаты
    try {
        await apiRequest("POST", "/report", results);
        const active = results.filter(r => r.status === "active").length;
        const dead   = results.filter(r => r.status === "dead").length;
        console.log(`[agent] Отправлено: активных ${active}, мёртвых ${dead}`);
    } catch (err) {
        console.error("[agent] Не удалось отправить результаты:", err);
    }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

if (!MAIN_SERVER) {
    console.error("Ошибка: MAIN_SERVER_URL не задан в .env");
    process.exit(1);
}

console.log(`[agent] RU checker-agent запущен. Сервер: ${MAIN_SERVER}`);
await runAgentCycle();
setInterval(() => { void runAgentCycle(); }, INTERVAL_MS);
