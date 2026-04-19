// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

const SOURCES = [
    // ── MTProto ──────────────────────────────────────────────────────────────
    {
        url: "https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt",
        type: "MTPROTO" as const,
        parse: parseMtproto,
    },
    {
        url: "https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt",
        type: "MTPROTO" as const,
        parse: parseMtproto,
    },
    {
        url: "https://raw.githubusercontent.com/ALIILAPRO/MTProtoProxy/main/mtproto.txt",
        type: "MTPROTO" as const,
        parse: parseMtproto,
    },
    // ── SOCKS5 ───────────────────────────────────────────────────────────────
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
        parse: parseSocks5Prefixed, // формат socks5://ip:port
    },
    {
        url: "https://raw.githubusercontent.com/r00tee/Proxy-List/main/Socks5.txt",
        type: "SOCKS5" as const,
        parse: parseSocks5,
    },
];

// https://t.me/proxy?... → tg://proxy?...
function parseMtproto(line: string): string | null {
    const t = line.trim();
    if (t.startsWith("https://t.me/proxy?")) return t.replace("https://t.me/proxy?", "tg://proxy?");
    if (t.startsWith("tg://proxy?")) return t;
    return null;
}

// IP:PORT → tg://socks?server=IP&port=PORT
function parseSocks5(line: string): string | null {
    const t = line.trim();
    const m = t.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
    if (!m) return null;
    return `tg://socks?server=${m[1]}&port=${m[2]}`;
}

// socks5://IP:PORT → tg://socks?server=IP&port=PORT
function parseSocks5Prefixed(line: string): string | null {
    const t = line.trim().replace(/^socks5:\/\//, "");
    return parseSocks5(t);
}

export async function scrapeProxies(): Promise<void> {
    console.log("[scraper] Начинаем скрапинг...");
    let totalMt = 0, totalS5 = 0;

    for (const source of SOURCES) {
        try {
            const { data } = await axios.get<string>(source.url, { timeout: 10_000 });
            let count = 0;
            for (const line of data.split("\n")) {
                const link = source.parse(line);
                if (!link) continue;
                proxies.insert(source.type, link);
                count++;
            }
            if (source.type === "MTPROTO") totalMt += count;
            else totalS5 += count;
            console.log(`[scraper] OK (${count}): ${source.url}`);
        } catch (err) {
            console.error(`[scraper] ERR: ${source.url} — ${(err as Error).message}`);
        }
    }

    console.log(`[scraper] Готово. MTProto: ${totalMt}, SOCKS5: ${totalS5}`);
}
