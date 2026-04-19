// checker.ts — реальная проверка прокси через socks-proxy-agent / net
import https from "node:https";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import { proxies } from "./db.js";
import type { Proxy } from "./db.js";

const TIMEOUT_MS = 6_000;
const CONCURRENCY = 40;
// Лёгкий эндпоинт Telegram — просто проверяем TCP/TLS доступность
const CHECK_HOST = "api.telegram.org";
const CHECK_PORT = 443;

// ─── Парсеры ссылок ───────────────────────────────────────────────────────────

function parseSocks5Link(link: string): { host: string; port: number } | null {
    try {
        // tg://socks?server=IP&port=PORT
        const url = new URL(link.replace("tg://socks", "http://socks"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        if (!host || !port) return null;
        return { host, port };
    } catch {
        return null;
    }
}

function parseMtprotoLink(link: string): { host: string; port: number } | null {
    try {
        // tg://proxy?server=HOST&port=PORT&secret=...
        const url = new URL(link.replace("tg://proxy", "http://proxy"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        if (!host || !port) return null;
        return { host, port };
    } catch {
        return null;
    }
}

// ─── Проверка SOCKS5 ──────────────────────────────────────────────────────────
// Подключаемся к api.telegram.org:443 через SOCKS5-прокси

function checkSocks5(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const agent = new SocksProxyAgent(`socks5://${host}:${port}`, {
            timeout: TIMEOUT_MS,
        });
        const start = Date.now();
        const req = https.get(
            { hostname: CHECK_HOST, port: CHECK_PORT, path: "/", agent, timeout: TIMEOUT_MS },
            (res) => {
                res.resume(); // дренируем тело
                resolve(Date.now() - start);
            }
        );
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
    });
}

// ─── Проверка MTProto ─────────────────────────────────────────────────────────
// MTProto — просто TCP-хендшейк к серверу прокси (порт открыт = живой)

function checkMtproto(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
        socket.on("connect", () => {
            socket.destroy();
            resolve(Date.now() - start);
        });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
        socket.on("error", reject);
    });
}

// ─── Основная функция проверки одного прокси ─────────────────────────────────

async function checkOne(proxy: Proxy): Promise<void> {
    try {
        let ping: number;

        if (proxy.type === "SOCKS5") {
            const addr = parseSocks5Link(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }
            ping = await checkSocks5(addr.host, addr.port);
        } else {
            // MTPROTO
            const addr = parseMtprotoLink(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }
            ping = await checkMtproto(addr.host, addr.port);
        }

        const status = ping <= 1500 ? "active" : "slow";
        proxies.setStatus(proxy.id, status, ping);
    } catch {
        proxies.setStatus(proxy.id, "dead", null);
    }
}

// ─── Экспортируемый раннер ────────────────────────────────────────────────────

export async function runChecker(): Promise<void> {
    const batch = proxies.getUnchecked();
    if (batch.length === 0) {
        console.log("[checker] Нет непроверенных прокси.");
        return;
    }

    console.log(`[checker] Проверяем ${batch.length} прокси (по ${CONCURRENCY} параллельно)...`);

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map(checkOne));
    }

    proxies.deleteDead();

    const active = proxies.countByStatus("active");
    const slow   = proxies.countByStatus("slow");
    console.log(`[checker] Готово. Активных: ${active}, медленных: ${slow}`);
}
