// checker.ts — реальная проверка прокси через socks-proxy-agent / net
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import { proxies } from "./db.js";
import type { Proxy } from "./db.js";

const TIMEOUT_MS = 6_000;
const CONCURRENCY = 100;

// Официальные IP дата-центров Telegram (DC1–DC5)
const TELEGRAM_DCS = [
    { host: "149.154.175.53",  port: 443 }, // DC1 Miami
    { host: "149.154.167.51",  port: 443 }, // DC2 Amsterdam
    { host: "149.154.175.100", port: 443 }, // DC3 Miami
    { host: "149.154.167.91",  port: 443 }, // DC4 Amsterdam
    { host: "91.108.56.130",   port: 443 }, // DC5 Singapore
];

// Страны СНГ — прокси из них скорее всего заблокированы РКН
const BLOCKED_COUNTRIES = new Set(["RU", "BY", "KZ", "UZ", "TM", "TJ", "AZ", "AM", "KG"]);

// ─── Гео-чек через ip-api.com (батч до 100 IP, бесплатно) ────────────────────

interface IpApiResult {
    query: string;
    countryCode: string;
    status: string;
}

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
                    } catch { /* игнорируем ошибки парсинга */ }
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

// ─── Парсеры ссылок ───────────────────────────────────────────────────────────

function parseSocks5Link(link: string): { host: string; port: number } | null {
    try {
        const url = new URL(link.replace("tg://socks", "http://socks"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        if (!host || !port) return null;
        return { host, port };
    } catch { return null; }
}

function parseMtprotoLink(link: string): { host: string; port: number } | null {
    try {
        const url = new URL(link.replace("tg://proxy", "http://proxy"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        if (!host || !port) return null;
        return { host, port };
    } catch { return null; }
}

// ─── Проверка SOCKS5 — подключаемся к Telegram DC через прокси ───────────────

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

// ─── Проверка MTProto — TCP-хендшейк к серверу прокси ────────────────────────

function checkMtproto(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
        socket.on("connect", () => { socket.destroy(); resolve(Date.now() - start); });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
        socket.on("error", reject);
    });
}

// ─── Проверка одного прокси ───────────────────────────────────────────────────

async function checkOne(proxy: Proxy, geoMap: Map<string, string>): Promise<void> {
    try {
        let ping: number;
        let addr: { host: string; port: number } | null;

        if (proxy.type === "SOCKS5") {
            addr = parseSocks5Link(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }

            // Если страна уже известна и заблокирована — сразу dead
            const country = geoMap.get(addr.host) ?? proxy.country ?? null;
            if (country) proxies.setCountry(proxy.id, country);
            if (country && BLOCKED_COUNTRIES.has(country)) {
                proxies.setStatus(proxy.id, "dead", null);
                return;
            }

            ping = await checkSocks5(addr.host, addr.port);
        } else {
            addr = parseMtprotoLink(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }
            ping = await checkMtproto(addr.host, addr.port);
        }

        proxies.setStatus(proxy.id, ping <= 3000 ? "active" : "slow", ping);
    } catch {
        proxies.setStatus(proxy.id, "dead", null);
    }
}

// ─── Раннер ───────────────────────────────────────────────────────────────────

export async function runChecker(): Promise<void> {
    const batch = proxies.getUnchecked();
    if (batch.length === 0) {
        console.log("[checker] Нет непроверенных прокси.");
        return;
    }

    console.log(`[checker] Проверяем ${batch.length} прокси...`);

    // Собираем уникальные IP для батч гео-запроса
    const ips = [...new Set(
        batch
            .map(p => p.type === "SOCKS5" ? parseSocks5Link(p.link)?.host : null)
            .filter((h): h is string => h != null)
    )].slice(0, 100); // ip-api.com лимит — 100 за раз

    const geoMap = await fetchGeoCountries(ips);
    const blocked = [...geoMap.values()].filter(c => BLOCKED_COUNTRIES.has(c)).length;
    console.log(`[checker] Гео: ${geoMap.size} IP определено, заблокировано по стране: ${blocked}`);

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map(p => checkOne(p, geoMap)));
    }

    proxies.deleteDead();

    const active = proxies.countByStatus("active");
    const slow   = proxies.countByStatus("slow");
    console.log(`[checker] Готово. Активных: ${active}, медленных: ${slow}`);
}
