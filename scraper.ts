// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

export const SOURCES: Array<{
    name: string;
    url: string;
    type: "MTPROTO" | "SOCKS5";
}> = [
    { name: "mtpro_xyz",      url: "https://t.me/s/mtpro_xyz",      type: "MTPROTO" },
    { name: "proxyListFree",  url: "https://t.me/s/proxyListFree",  type: "MTPROTO" },
];

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// https://t.me/proxy?server=...&port=...&secret=... → tg://proxy?...
function parseHtml(html: string, type: "MTPROTO" | "SOCKS5"): string[] {
    const result: string[] = [];

    if (type === "MTPROTO") {
        const matches = html.matchAll(/https:\/\/t\.me\/proxy\?([^"'\s<>]+)/g);
        for (const m of matches) {
            const params = m[1]!.replace(/&amp;amp;/g, "&").replace(/&amp;/g, "&");
            if (params.includes("secret=")) {
                result.push(`tg://proxy?${params}`);
            }
        }
    }

    if (type === "SOCKS5") {
        const matches = html.matchAll(/https:\/\/t\.me\/socks\?([^"'\s<>]+)/g);
        for (const m of matches) {
            const params = m[1]!.replace(/&amp;amp;/g, "&").replace(/&amp;/g, "&");
            if (params.includes("server=")) {
                result.push(`tg://socks?${params}`);
            }
        }
    }

    return result;
}

// Скрапим один источник и возвращаем количество новых прокси
export async function scrapeSource(source: typeof SOURCES[number]): Promise<number> {
    try {
        const { data } = await axios.get<string>(source.url, { timeout: 10_000, headers: HEADERS });
        const links = parseHtml(data, source.type);
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
}
