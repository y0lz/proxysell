// scraper.ts
import axios from "axios";
import { proxies } from "./db.js";
export const SOURCES = [
    // Старые источники
    { name: "mtpro_xyz", url: "https://t.me/s/mtpro_xyz" },
    { name: "proxyListFree", url: "https://t.me/s/proxyListFree" },
    { name: "mtrproxytg", url: "https://t.me/s/mtrproxytg" },
    { name: "grim1313", url: "https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt" },
    // Новые Telegram каналы
    { name: "MTProxyExpress", url: "https://t.me/s/MTProxyExpress" },
    { name: "MTProxySpot", url: "https://t.me/s/MTProxySpot" },
    { name: "MTProtoStream", url: "https://t.me/s/MTProtoStream" },
    { name: "SecureMTProto", url: "https://t.me/s/SecureMTProto" },
    { name: "MTProtoGateway", url: "https://t.me/s/MTProtoGateway" },
    { name: "FastMTProxyHub", url: "https://t.me/s/FastMTProxyHub" },
    { name: "MTProxyOnly", url: "https://t.me/s/MTProxyOnly" },
    { name: "DailyProxyList", url: "https://t.me/s/DailyProxyList" },
    { name: "FreeSecureProxy", url: "https://t.me/s/FreeSecureProxy" },
    { name: "JustMTProxy", url: "https://t.me/s/JustMTProxy" },
];
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
// ─── Универсальный парсер ─────────────────────────────────────────────────────
// Ищет MTProto прокси в любом формате HTML/текста
function parseUniversal(html) {
    const found = new Set();
    // 1. Готовые tg://proxy? ссылки
    for (const m of html.matchAll(/tg:\/\/proxy\?([^\s"'<>\]]+)/gi)) {
        const params = m[1].replace(/&amp;/g, "&");
        if (params.includes("secret=") && params.includes("server=")) {
            found.add(`tg://proxy?${params}`);
        }
    }
    // 2. https://t.me/proxy?... ссылки
    for (const m of html.matchAll(/https?:\/\/t\.me\/proxy\?([^\s"'<>\]]+)/gi)) {
        const params = m[1].replace(/&amp;amp;/g, "&").replace(/&amp;/g, "&");
        if (params.includes("secret=") && params.includes("server=")) {
            found.add(`tg://proxy?${params}`);
        }
    }
    // 3. Убираем HTML теги и лишние символы для чистого текста
    const text = html.replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ");
    // 4. Различные форматы Server/Port/Secret (более гибкие паттерны)
    const serverPortSecretPatterns = [
        // Стандартные форматы
        /(?:Server|IP|Host):\s*([^\s,;|\n]+)[\s\n]+(?:Port):\s*(\d{2,5})[\s\n]+(?:Secret):\s*([a-fA-F0-9]{16,})/gi,
        /🌐\s*(?:Server|IP):\s*([^\s,;|\n]+)[\s\n]*🔌\s*(?:Port):\s*(\d{2,5})[\s\n]*🔐\s*(?:Secret):\s*([a-fA-F0-9]{16,})/gi,
        // Форматы без меток
        /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})[\s:]+(\d{2,5})[\s:]+([a-fA-F0-9]{16,})/g,
        /([a-zA-Z0-9.-]+\.(?:com|net|org|ru|ir|de|fr|uk|us))[\s:]+(\d{2,5})[\s:]+([a-fA-F0-9]{16,})/g,
        // Форматы с разделителями
        /([^\s,;|]+)\s*[:|]\s*(\d{2,5})\s*[:|]\s*([a-fA-F0-9]{16,})/g,
    ];
    for (const pattern of serverPortSecretPatterns) {
        for (const m of text.matchAll(pattern)) {
            const [, server, port, secret] = m;
            if (server && port && secret &&
                server !== "Unknown" &&
                !server.includes("example") &&
                !server.includes("your") &&
                isValidServer(server) &&
                isValidPort(parseInt(port)) &&
                isValidSecret(secret)) {
                found.add(`tg://proxy?server=${server}&port=${port}&secret=${secret}`);
            }
        }
    }
    // 5. Поиск в JSON структурах
    try {
        const jsonMatches = html.match(/\{[^}]*(?:"server"|"host"|"ip")[^}]*\}/gi);
        if (jsonMatches) {
            for (const jsonStr of jsonMatches) {
                try {
                    const obj = JSON.parse(jsonStr);
                    const server = obj.server || obj.host || obj.ip;
                    const port = obj.port;
                    const secret = obj.secret;
                    if (server && port && secret &&
                        isValidServer(server) &&
                        isValidPort(port) &&
                        isValidSecret(secret)) {
                        found.add(`tg://proxy?server=${server}&port=${port}&secret=${secret}`);
                    }
                }
                catch {
                    // Игнорируем невалидный JSON
                }
            }
        }
    }
    catch {
        // Игнорируем ошибки парсинга JSON
    }
    return [...found];
}
// Валидация сервера (IP или домен)
function isValidServer(server) {
    // IP адрес
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (ipRegex.test(server))
        return true;
    // Домен
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return domainRegex.test(server) && server.includes('.');
}
// Валидация порта
function isValidPort(port) {
    return port >= 1 && port <= 65535;
}
// Валидация секрета (hex строка минимум 16 символов)
function isValidSecret(secret) {
    return /^[a-fA-F0-9]{16,}$/.test(secret);
}
// Тестирование одного источника (для отладки)
export async function testSource(sourceName) {
    const source = SOURCES.find(s => s.name === sourceName);
    if (!source) {
        console.error(`[scraper] Источник "${sourceName}" не найден`);
        return;
    }
    try {
        console.log(`[scraper] 🧪 Тестирование источника: ${source.name}`);
        const { data } = await axios.get(source.url, {
            timeout: 15_000,
            headers: HEADERS
        });
        console.log(`[scraper] 📄 Размер ответа: ${data.length} символов`);
        const links = parseUniversal(data);
        console.log(`[scraper] 🔗 Найдено прокси: ${links.length}`);
        // Показываем первые 3 найденных прокси для проверки
        links.slice(0, 3).forEach((link, i) => {
            console.log(`[scraper] ${i + 1}. ${link}`);
        });
        if (links.length > 3) {
            console.log(`[scraper] ... и ещё ${links.length - 3} прокси`);
        }
    }
    catch (error) {
        console.error(`[scraper] ❌ Ошибка тестирования: ${error.message}`);
    }
}
// SOCKS5: IP:PORT из текста — не используется, оставлено для будущего
// function parseSocks5Text(html: string): string[] { ... }
// Скрапим один источник и возвращаем количество новых прокси
export async function scrapeSource(source) {
    try {
        console.log(`[scraper] 🔍 Скрапинг: ${source.name}`);
        const { data } = await axios.get(source.url, {
            timeout: 15_000,
            headers: HEADERS,
            maxRedirects: 5
        });
        const links = parseUniversal(data);
        let newCount = 0;
        let duplicateCount = 0;
        let errorCount = 0;
        for (const link of links) {
            try {
                const result = proxies.insert("MTPROTO", link);
                if (result.changes > 0) {
                    newCount++;
                }
                else {
                    duplicateCount++;
                }
            }
            catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    duplicateCount++;
                }
                else {
                    errorCount++;
                    console.error(`[scraper] Ошибка вставки прокси: ${error.message}`);
                }
            }
        }
        if (links.length > 0) {
            console.log(`[scraper] ✅ ${source.name}: ${newCount} новых, ${duplicateCount} дубликатов, ${errorCount} ошибок из ${links.length} найденных`);
        }
        else {
            console.log(`[scraper] ⚠️ ${source.name}: прокси не найдены`);
        }
        return newCount;
    }
    catch (err) {
        const errorMsg = err.message;
        console.error(`[scraper] ❌ ${source.name}: ${errorMsg}`);
        return 0;
    }
}
// Скрапим все источники по очереди
export async function scrapeProxies() {
    console.log(`[scraper] 🚀 Начинаем скрапинг ${SOURCES.length} источников...`);
    proxies.resetDeadMtproto();
    let total = 0;
    let successCount = 0;
    let failCount = 0;
    for (const source of SOURCES) {
        const count = await scrapeSource(source);
        total += count;
        if (count > 0) {
            successCount++;
        }
        else {
            failCount++;
        }
        // Небольшая пауза между запросами, чтобы не нагружать серверы
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`[scraper] 🎉 Скрапинг завершён!`);
    console.log(`[scraper] 📊 Статистика: ${total} новых прокси из ${successCount}/${SOURCES.length} источников (${failCount} недоступны)`);
    console.log(`[db] 📈 Состояние БД: unchecked: ${proxies.countByStatus("unchecked")} | active: ${proxies.countByStatus("active")} | slow: ${proxies.countByStatus("slow")} | dead: ${proxies.countByStatus("dead")}`);
}
//# sourceMappingURL=scraper.js.map