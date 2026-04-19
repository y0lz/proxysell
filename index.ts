// index.ts — основной сервер (NL)
import "dotenv/config";
import http from "node:http";
import { scrapeProxies } from "./scraper.js";
import { runChecker } from "./checker.js";
import { bot } from "./bot.js";
import { users, proxies } from "./db.js";

const API_PORT   = Number(process.env["API_PORT"]   ?? 3000);
const API_SECRET = process.env["API_SECRET"]        ?? "";
const MIN_ACTIVE = 10; // минимум активных прокси перед стандартным режимом

interface CheckResult {
    id: number;
    status: string;
    ping_ms: number | null;
    country?: string | null;
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    const auth = req.headers["x-api-secret"];
    if (!API_SECRET || auth !== API_SECRET) {
        res.writeHead(401).end("Unauthorized");
        return;
    }

    if (req.method === "GET" && req.url === "/unchecked") {
        const batch = proxies.getUnchecked();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(batch));
        return;
    }

    // POST /rescrape — агент просит запустить скрапер заново
    if (req.method === "POST" && req.url === "/rescrape") {
        console.log("[api] Агент запросил повторный скрапинг...");
        void scrapeProxies();
        res.writeHead(200).end(JSON.stringify({ ok: true }));
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
                    const results = JSON.parse(body) as CheckResult[];
                    for (const r of results) {
                        proxies.setStatus(r.id, r.status, r.ping_ms);
                        if (r.country) proxies.setCountry(r.id, r.country);
                    }
                    console.log(`[api] RU-агент прислал ${results.length} результатов`);
                } catch {
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

async function bootstrap(): Promise<void> {
    await scrapeProxies();

    // Крутим локальный чекер пока не наберём MIN_ACTIVE
    let active = proxies.countByStatus("active");
    console.log(`[init] Активных прокси в базе: ${active}`);

    while (active < MIN_ACTIVE) {
        console.log(`[init] Мало активных (${active}/${MIN_ACTIVE}), запускаем ещё раунд проверки...`);
        await runChecker();
        active = proxies.countByStatus("active");
        if (active < MIN_ACTIVE && proxies.getUnchecked().length === 0) {
            // Все проверены но мало активных — скрапим заново
            console.log("[init] Непроверенных нет, повторный скрапинг...");
            await scrapeProxies();
        }
    }

    console.log(`[init] Готово. Активных прокси: ${active}`);
}

void bootstrap();

// ─── Планировщики ─────────────────────────────────────────────────────────────

setInterval(() => { void scrapeProxies(); }, 3 * 60 * 60 * 1000);
setInterval(() => { void runChecker(); },   30 * 60 * 1000);
setInterval(() => { users.expireVip(); },   60 * 60 * 1000);
