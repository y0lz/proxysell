// index.ts — основной сервер (NL)
import "dotenv/config";
import http from "node:http";
import { scrapeProxies } from "./scraper.js";
import { runChecker } from "./checker.js";
import { bot } from "./bot.js";
import { users, proxies } from "./db.js";

const API_PORT      = Number(process.env["API_PORT"]      ?? 3000);
const API_SECRET    = process.env["API_SECRET"]           ?? "";
const AGENT_URL     = process.env["AGENT_URL"]            ?? ""; // http://RU_IP:3001

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

let lastScrapeTime = 0;
const SCRAPE_COOLDOWN = 10 * 60 * 1000; // не чаще раза в 10 минут

    // POST /rescrape — агент просит запустить скрапер заново
    if (req.method === "POST" && req.url === "/rescrape") {
        const now = Date.now();
        if (now - lastScrapeTime < SCRAPE_COOLDOWN) {
            res.writeHead(200).end(JSON.stringify({ ok: true, skipped: true }));
            return;
        }
        lastScrapeTime = now;
        console.log("[api] Агент запросил повторный скрапинг...");
        void scrapeProxies();
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function sendRestart(targetUrl: string, secret: string): void {
    const url = new URL(targetUrl + "/restart");
    const req = http.request(
        { hostname: url.hostname, port: url.port, path: "/restart", method: "POST",
          headers: { "x-api-secret": secret }, timeout: 5_000 },
        (res) => { res.resume(); console.log(`[api] Peer перезапущен, статус: ${res.statusCode}`); }
    );
    req.on("error", (e) => console.error("[api] Ошибка отправки restart:", e.message));
    req.on("timeout", () => req.destroy());
    req.end();
}

void bootstrap();

// ─── Планировщики ─────────────────────────────────────────────────────────────

setInterval(() => { void scrapeProxies(); }, 3 * 60 * 60 * 1000);
setInterval(() => { void runChecker(); },   30 * 60 * 1000);
setInterval(() => { users.expireVip(); },   60 * 60 * 1000);
