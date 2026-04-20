// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

export const SOURCES: Array<{
    name: string;
    url: string;
}> = [
    { name: "mtpro_xyz",     url: "https://t.me/s/mtpro_xyz"     },
    { name: "proxyListFree", url: "https://t.me/s/proxyListFree" },
    { name: "mtrproxytg",    url: "https://t.me/s/mtrproxytg"    },
    { name: "grim1313",      url: "https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt" },
];

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// ─── Универсальный парсер ─────────────────────────────────────────────────────
// Ищет MTProto прокси в любом формате HTML/текста

function parseUniversal(html: string): string[] {
    const found = new Set<string>();

    // 1. Готовые tg://proxy? ссылки
    for (const m of html.matchAll(/tg:\/\/proxy\?([^\s"'<>]+)/g)) {
        const params = m[1]!.replace(/&amp;/g, "&");
        if (params.includes("secret=") && params.includes("server=")) {
            found.add(`tg://proxy?${params}`);
        }
    }

    // 2. https://t.me/proxy?... ссылки
    for (const m of html.matchAll(/https?:\/\/t\.me\/proxy\?([^\s"'<>]+)/g)) {
        const params = m[1]!.replace(/&amp;amp;/g, "&").replace(/&amp;/g, "&");
        if (params.includes("secret=") && params.includes("server=")) {
            found.add(`tg://proxy?${params}`);
        }
    }

    // 3. Server/Port/Secret поля (любой порядок пробелов, переносов, тегов)
    // Убираем HTML теги для чистого текста
    const text = html.replace(/<[^>]+>/g, " ");
    for (const m of text.matchAll(/Server:\s*([^\s,;|]+)\s+Port:\s*(\d{2,5})\s+Secret:\s*([a-zA-Z0-9+/=]{8,})/g)) {
        const [, server, port, secret] = m;
        if (server && port && secret && server !== "Unknown") {
            found.add(`tg://proxy?server=${server}&port=${port}&secret=${secret}`);
        }
    }

    return [...found];
}

// SOCKS5: IP:PORT из текста — не используется, оставлено для будущего
// function parseSocks5Text(html: string): string[] { ... }


// Скрапим один источник и возвращаем количество новых прокси
export async function scrapeSource(source: typeof SOURCES[number]): Promise<number> {
    try {
        const { data } = await axios.get<string>(source.url, { timeout: 10_000, headers: HEADERS });
        const links = parseUniversal(data);
        let count = 0;
        for (const link of links) {
            proxies.insert("MTPROTO", link);
            count++;
        }
        console.log(`[scraper] OK (${count}): ${source.name}`);
        return count;
    } catch (err) {
        console.error(`[scraper] ERR: ${source.name} — ${(err as Error).message}`);
        return 0;
    }
}

// Скрапим все источники по очереди
export async function scrapeProxies(): Promise<void> {
    console.log("[scraper] Начинаем скрапинг...");
    proxies.resetDeadMtproto();
    let total = 0;
    for (const source of SOURCES) {
        total += await scrapeSource(source);
    }
    console.log(`[scraper] Готово. MTProto: ${total}`);
    console.log(`[db] unchecked: ${proxies.countByStatus("unchecked")} | active: ${proxies.countByStatus("active")} | slow: ${proxies.countByStatus("slow")} | dead: ${proxies.countByStatus("dead")}`);
}
