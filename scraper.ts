// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

const SOURCES = [
    // MTProto — формат: https://t.me/proxy?server=...&port=...&secret=...
    {
        url: "https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt",
        type: "MTPROTO" as const,
        parse: parseMtproto,
    },
    // SOCKS5 — формат: IP:PORT (одна строка)
    {
        url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
        type: "SOCKS5" as const,
        parse: parseSocks5,
    },
    {
        url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
        type: "SOCKS5" as const,
        parse: parseSocks5,
    },
    {
        url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
        type: "SOCKS5" as const,
        parse: parseSocks5,
    },
    {
        url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
        type: "SOCKS5" as const,
        parse: parseSocks5,
    },
];

// https://t.me/proxy?server=X&port=Y&secret=Z  →  tg://proxy?server=X&port=Y&secret=Z
function parseMtproto(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed.startsWith("https://t.me/proxy?")) {
        return trimmed.replace("https://t.me/proxy?", "tg://proxy?");
    }
    if (trimmed.startsWith("tg://proxy?")) return trimmed;
    return null;
}

// IP:PORT  →  tg://socks?server=IP&port=PORT
function parseSocks5(line: string): string | null {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
    if (!match) return null;
    const [, server, port] = match;
    return `tg://socks?server=${server}&port=${port}`;
}

export async function scrapeProxies(): Promise<void> {
    console.log("[scraper] Начинаем скрапинг...");
    let total = 0;

    for (const source of SOURCES) {
        try {
            const { data } = await axios.get<string>(source.url, { timeout: 10_000 });
            for (const line of data.split("\n")) {
                const link = source.parse(line);
                if (!link) continue;
                proxies.insert(source.type, link);
                total++;
            }
            console.log(`[scraper] OK: ${source.url}`);
        } catch (err) {
            console.error(`[scraper] Ошибка: ${source.url}`, (err as Error).message);
        }
    }

    console.log(`[scraper] Готово. Обработано строк: ${total}`);
}
