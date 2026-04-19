// index.ts
import "dotenv/config";
import { scrapeProxies } from "./scraper.js";
import { runChecker } from "./checker.js";
import { bot } from "./bot.js";

// Первый запуск
await scrapeProxies();
await runChecker();

// Скрапер каждые 3 часа
setInterval(() => { void scrapeProxies(); }, 3 * 60 * 60 * 1000);

// Чекер каждые 30 минут
setInterval(() => { void runChecker(); }, 30 * 60 * 1000);

console.log("Запуск бота...");
bot.start();
