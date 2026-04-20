// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

export const SOURCES: Array<{
    name: string;
    url: string;
    type: "MTPROTO" | "SOCKS5";
    parser: "tme_proxy" | "tme_raw_fields" | "toproxylab_socks5";
}> = [
    { name: "mtpro_xyz",     url: "https://t.me/s/mtpro_xyz",     type: "MTPROTO", parser: "tme_proxy" },
    { name: "proxyListFree", url: "https://t.me/s/proxyListFree", type: "MTPROTO", parser: "tme_proxy" },
    { name: "mtrproxytg",    url: "https://t.me/s/mtrproxytg",    type: "MTPROTO", parser: "tme_raw_fields" },
    { name: "toproxylab",    url: "https://t.me/s/toproxylab",    type: "SOCKS5",  parser: "toproxylab_socks5" },
    { name: "grim1313",      url: "https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt", type: "MTPROTO", parser: "tme_proxy" },
];

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// tg://proxy?server=...&port=...&secret=... из href ссылок
function parseTmeProxy(html: string): string[] {
    const result: string[] = [];
    const matches = html.matchAll(/https:\/\/t\.me\/proxy\?([^"'\s<>]+)/g);
    for (const m of matches) {
        const params = m[1]!.replace(/&amp;amp;/g, "&").replace(/&amp;/g, "&");
        if (params.includes("secret=")) result.push(`tg://proxy?${params}`);
    }
    return result;
}

// Server: X / Port: Y / Secret: Z из текста постов (@mtrproxytg)
// Формат: "Server: HOSTPort: PORTSecret: SECRET" (всё слитно в одной строке HTML)
function parseTmeRawFields(html: string): string[] {
    const result: string[] = [];
    // Ищем Server: ... Port: ... Secret: ... в любом порядке пробелов/переносов
    const blocks = html.matchAll(/Server:\s*([^\s<\n]+)[^]*?Port:\s*(\d+)[^]*?Secret:\s*([a-zA-Z0-9+/=]{8,})/g);
    for (const m of blocks) {
        const [, server, port, secret] = m;
        if (!server || !port || !secret) continue;
        if (server === "Unknown") continue;
        result.push(`tg://proxy?server=${server.trim()}&port=${port}&secret=${secret.trim()}`);
    }
    return result;
}

// IP:PORT из текста постов @toproxylab (SOCKS5 секция)
function parseTopProxyLabSocks5(html: string): string[] {
    const result: string[] = [];
    // Ищем паттерн IP:PORT после "SOCKS5" в тексте
    const sections = html.split(/SOCKS5/i);
    for (let i = 1; i < sections.length; i++) {
        const section = sections[i]!.slice(0, 500); // берём только начало секции
        const matches = section.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/g);
        for (const m of matches) {
            result.push(`tg://socks?server=${m[1]}&port=${m[2]}`);
        }
    }
    return result;
}

// Скрапим один источник и возвращаем количество новых прокси
export async function scrapeSource(source: typeof SOURCES[number]): Promise<number> {
    try {
        const { data } = await axios.get<string>(source.url, { timeout: 10_000, headers: HEADERS });

        let links: string[] = [];
        if (source.parser === "tme_proxy")           links = parseTmeProxy(data);
        else if (source.parser === "tme_raw_fields") links = parseTmeRawFields(data);
        else if (source.parser === "toproxylab_socks5") links = parseTopProxyLabSocks5(data);

        let count = 0;
        for (const link of links) {
            proxies.insert(source.type, link);
            count++;
        }
        console.log(`[scraper] OK (${count}): ${source.name}`);
        return count;
    } catch (err) {
        console.error(`[scraper] ERR: ${source.name} — ${(err as Error).message}`);
        return 0;
    }
}

// Скрапим все источники по очереди, после каждого сбрасываем dead MTProto
export async function scrapeProxies(): Promise<void> {
    console.log("[scraper] Начинаем скрапинг...");
    proxies.resetDeadMtproto();

    let totalMt = 0, totalS5 = 0;
    for (const source of SOURCES) {
        const count = await scrapeSource(source);
        if (source.type === "MTPROTO") totalMt += count;
        else totalS5 += count;
    }

    console.log(`[scraper] Готово. MTProto: ${totalMt}, SOCKS5: ${totalS5}`);
    console.log(`[db] unchecked: ${proxies.countByStatus("unchecked")} | active: ${proxies.countByStatus("active")} | slow: ${proxies.countByStatus("slow")} | dead: ${proxies.countByStatus("dead")}`);
}
