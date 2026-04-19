// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";

const SOURCES: Array<{
    url: string;
    type: "MTPROTO" | "SOCKS5";
    parse: ((line: string) => string | null) | ((html: string) => string[]);
    isHtml?: boolean;
}> = [
    // ── Telegram каналы ───────────────────────────────────────────────────────
    {
        url: "https://t.me/s/mtpro_xyz",
        type: "MTPROTO" as const,
        parse: parseMtprotoFromHtml,
        isHtml: true,
    },
];

// https://t.me/proxy?server=...&port=...&secret=... → tg://proxy?...
function parseMtprotoFromHtml(html: string): string[] {
    const result: string[] = [];
    // Ищем ссылки в href атрибутах и в тексте
    const matches = html.matchAll(/https:\/\/t\.me\/proxy\?([^"'\s<>]+)/g);
    for (const m of matches) {
        // Декодируем HTML entities (&amp; → &)
        const params = m[1]!
            .replace(/&amp;amp;/g, "&")
            .replace(/&amp;/g, "&");
        // Берём только ссылки с secret
        if (params.includes("secret=")) {
            result.push(`tg://proxy?${params}`);
        }
    }
    return result;
}

export async function scrapeProxies(): Promise<void> {
    console.log("[scraper] Начинаем скрапинг...");
    // Сбрасываем мёртвые MTProto — пусть RU агент перепроверит свежие
    proxies.resetDeadMtproto();
    let totalMt = 0, totalS5 = 0;

    for (const source of SOURCES) {
        try {
            const { data } = await axios.get<string>(source.url, {
                timeout: 10_000,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            });

            let count = 0;
            if (source.isHtml) {
                const links = (source.parse as (html: string) => string[])(data);
                for (const link of links) {
                    proxies.insert(source.type, link);
                    count++;
                }
            } else {
                for (const line of data.split("\n")) {
                    const link = (source.parse as (line: string) => string | null)(line);
                    if (!link) continue;
                    proxies.insert(source.type, link);
                    count++;
                }
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
