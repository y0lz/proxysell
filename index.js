// index.ts — основной сервер (NL)
import "dotenv/config";
import http from "node:http";
import { scrapeProxies, scrapeSource, SOURCES } from "./scraper.js";
import { runChecker } from "./checker.js";
import { bot } from "./bot.js";
import { users, proxies } from "./db.js";
const API_PORT = Number(process.env["API_PORT"] ?? 3000);
const API_SECRET = process.env["API_SECRET"] ?? "";
const AGENT_URL = process.env["AGENT_URL"] ?? ""; // http://RU_IP:3001
// ─── HTTP API ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const auth = req.headers["x-api-secret"];
    if (!API_SECRET || auth !== API_SECRET) {
        res.writeHead(401).end("Unauthorized");
        return;
    }
    // GET /stats — статистика БД для агента
    if (req.method === "GET" && req.url === "/stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            active_mt: proxies.countByStatus("active"),
            unchecked: proxies.getUnchecked().length,
        }));
        return;
    }
    if (req.method === "GET" && req.url === "/unchecked") {
        const batch = proxies.getUnchecked();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(batch));
        return;
    }
    let lastScrapeTime = 0;
    const SCRAPE_COOLDOWN = 30 * 60 * 1000; // не чаще раза в 30 минут
    // POST /rescrape — агент просит запустить скрапер заново
    if (req.method === "POST" && req.url === "/rescrape") {
        const now = Date.now();
        if (now - lastScrapeTime < SCRAPE_COOLDOWN) {
            res.writeHead(200).end(JSON.stringify({ ok: true, skipped: true }));
            return;
        }
        lastScrapeTime = now;
        console.log("[api] Агент запросил повторный скрапинг...");
        // Скрапим по одному источнику — после каждого агент сразу получит новые unchecked
        void (async () => {
            proxies.resetDeadMtproto();
            for (const source of SOURCES) {
                await scrapeSource(source);
            }
        })();
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        return;
    }
    // POST /restart — перезапустить этот процесс (PM2 поднимет автоматически)
    if (req.method === "POST" && req.url === "/restart") {
        console.log("[api] Получен запрос на перезапуск NL сервера...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 300);
        return;
    }
    // POST /restart-peer — перезапустить RU агент
    if (req.method === "POST" && req.url === "/restart-peer") {
        if (!AGENT_URL) {
            res.writeHead(503).end(JSON.stringify({ error: "AGENT_URL not configured" }));
            return;
        }
        console.log("[api] Отправляем команду перезапуска RU агенту...");
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        void sendRestart(AGENT_URL, API_SECRET);
        return;
    }
    if (req.method === "POST" && req.url === "/report") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            // Отвечаем сразу, обрабатываем асинхронно
            res.writeHead(200).end(JSON.stringify({ ok: true }));
            setImmediate(() => {
                try {
                    const results = JSON.parse(body);
                    for (const r of results) {
                        proxies.setStatus(r.id, r.status, r.ping_ms);
                        if (r.country)
                            proxies.setCountry(r.id, r.country);
                    }
                    console.log(`[api] RU-агент прислал ${results.length} результатов`);
                }
                catch {
                    console.error("[api] Ошибка парсинга результатов");
                }
            });
        });
        return;
    }
    res.writeHead(404).end();
});
server.listen(API_PORT, () => {
    console.log(`[api] HTTP API запущен на порту ${API_PORT}`);
});
// ─── Запуск бота сразу ────────────────────────────────────────────────────────
console.log("Запуск бота...");
bot.start();
// ─── Фоновая инициализация ────────────────────────────────────────────────────
async function bootstrap() {
    // Даём боту и API подняться, потом скрапим
    await sleep(3_000);
    await scrapeProxies();
    // Локальный чекер только если RU агент не работает (fallback)
    const active = proxies.countByStatus("active");
    console.log(`[init] Активных прокси в базе: ${active}`);
    if (active < 5) {
        await runChecker();
    }
    console.log(`[init] Готово. Активных прокси: ${proxies.countByStatus("active")}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function sendRestart(targetUrl, secret) {
    const url = new URL(targetUrl + "/restart");
    const req = http.request({ hostname: url.hostname, port: url.port, path: "/restart", method: "POST",
        headers: { "x-api-secret": secret }, timeout: 5_000 }, (res) => { res.resume(); console.log(`[api] Peer перезапущен, статус: ${res.statusCode}`); });
    req.on("error", (e) => console.error("[api] Ошибка отправки restart:", e.message));
    req.on("timeout", () => req.destroy());
    req.end();
}
void bootstrap();
// ─── Планировщики ─────────────────────────────────────────────────────────────
setInterval(() => { void scrapeProxies(); }, 2 * 60 * 60 * 1000); // скрапинг каждые 2 часа
setInterval(() => { void runChecker(); }, 30 * 60 * 1000); // NL fallback чекер каждые 30 мин
// Истечение подписок каждый час
setInterval(() => {
    users.expireSubscriptions();
}, 60 * 60 * 1000);
// Уведомления о подписке (за 24ч до истечения) каждый час
setInterval(async () => {
    const usersToNotify = users.getUsersForNotification();
    for (const user of usersToNotify) {
        try {
            await bot.api.sendMessage(user.id, "⚠️ *Подписка Plus истекает завтра!*\n\n" +
                "Ваша подписка закончится через 24 часа\\. " +
                "Продлите её, чтобы продолжить пользоваться безлимитными рероллами\\.\n\n" +
                "Нажмите /start → ⭐ Купить Plus", { parse_mode: "MarkdownV2" });
            users.setSubNotified(user.id);
            console.log(`[scheduler] Отправлено уведомление пользователю ${user.id}`);
        }
        catch (err) {
            console.error(`[scheduler] Ошибка отправки уведомления ${user.id}:`, err);
        }
    }
}, 60 * 60 * 1000);
// Перепроверка активных каждые 4 часа
setInterval(() => {
    const reset = proxies.resetStaleActive(4);
    if (reset > 0)
        console.log(`[scheduler] Сброшено на перепроверку: ${reset} активных прокси`);
}, 4 * 60 * 60 * 1000);
//# sourceMappingURL=index.js.map