// index.ts — основной сервер (NL): бот + скрапер + HTTP API для RU-агента
import "dotenv/config";
import http from "node:http";
import { scrapeProxies } from "./scraper.js";
import { runChecker } from "./checker.js";
import { bot } from "./bot.js";
import { users, proxies } from "./db.js";

const API_PORT   = Number(process.env["API_PORT"]   ?? 3000);
const API_SECRET = process.env["API_SECRET"]        ?? "";

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

    // GET /unchecked — отдаём агенту список непроверенных прокси
    if (req.method === "GET" && req.url === "/unchecked") {
        const batch = proxies.getUnchecked();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(batch));
        return;
    }

    // POST /report — принимаем результаты проверки от агента
    if (req.method === "POST" && req.url === "/report") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const results = JSON.parse(body) as CheckResult[];
                for (const r of results) {
                    proxies.setStatus(r.id, r.status, r.ping_ms);
                    if (r.country) proxies.setCountry(r.id, r.country);
                }
                console.log(`[api] RU-агент прислал ${results.length} результатов`);
                res.writeHead(200).end(JSON.stringify({ ok: true }));
            } catch {
                res.writeHead(400).end("Bad JSON");
            }
        });
        return;
    }

    res.writeHead(404).end();
});

server.listen(API_PORT, () => {
    console.log(`[api] HTTP API запущен на порту ${API_PORT}`);
});

// ─── Планировщики ─────────────────────────────────────────────────────────────

await scrapeProxies();
await runChecker(); // локальный чекер как fallback пока нет RU-агента

setInterval(() => { void scrapeProxies(); }, 3 * 60 * 60 * 1000);
setInterval(() => { void runChecker(); },   30 * 60 * 1000);
setInterval(() => { users.expireVip(); },   60 * 60 * 1000);

console.log("Запуск бота...");
bot.start();
