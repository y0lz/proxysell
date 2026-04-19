// checker.ts — локальный чекер (fallback, запускается на NL сервере)
import https from "node:https";
import net from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import { proxies } from "./db.js";
import type { Proxy } from "./db.js";

const TIMEOUT_MS  = 6_000;
const CONCURRENCY = 20; // низкая нагрузка — NL сервер слабый (512MB)

const TELEGRAM_DCS = [
    { host: "149.154.175.53",  port: 443 },
    { host: "149.154.167.51",  port: 443 },
    { host: "149.154.175.100", port: 443 },
    { host: "149.154.167.91",  port: 443 },
    { host: "91.108.56.130",   port: 443 },
];

function parseSocks5Link(link: string) {
    try {
        const url = new URL(link.replace("tg://socks", "http://socks"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        return host && port ? { host, port } : null;
    } catch { return null; }
}

function parseMtprotoLink(link: string) {
    try {
        const url = new URL(link.replace("tg://proxy", "http://proxy"));
        const host = url.searchParams.get("server");
        const port = Number(url.searchParams.get("port"));
        return host && port ? { host, port } : null;
    } catch { return null; }
}

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

async function checkOne(proxy: Proxy): Promise<void> {
    // MTProto проверяет только RU агент — из NL они не работают
    if (proxy.type === "MTPROTO") {
        proxies.setStatus(proxy.id, "unchecked", null);
        return;
    }
    try {
        let ping: number;
        if (proxy.type === "SOCKS5") {
            const addr = parseSocks5Link(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }
            ping = await checkSocks5(addr.host, addr.port);
        } else {
            const addr = parseMtprotoLink(proxy.link);
            if (!addr) { proxies.setStatus(proxy.id, "dead", null); return; }
            ping = await checkMtproto(addr.host, addr.port);
        }
        proxies.setStatus(proxy.id, ping <= 3000 ? "active" : "slow", ping);
    } catch {
        proxies.setStatus(proxy.id, "dead", null);
    }
}

export async function runChecker(): Promise<void> {
    const batch = proxies.getUnchecked();
    if (batch.length === 0) { console.log("[checker] Нет непроверенных прокси."); return; }

    console.log(`[checker] Проверяем ${batch.length} прокси...`);
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        await Promise.allSettled(batch.slice(i, i + CONCURRENCY).map(checkOne));
    }
    const deleted = proxies.deleteDead();
    console.log(`[checker] Готово. Активных: ${proxies.countByStatus("active")}, медленных: ${proxies.countByStatus("slow")}, удалено мёртвых: ${deleted}`);
}
