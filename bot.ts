// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies } from "./db.js";

export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");

bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) users.upsert(userId);

    const keyboard = new InlineKeyboard()
        .text("🟩 Получить бесплатный прокси", "get_free").row()
        .text("🚀 Купить VIP доступ", "buy_vip").row()
        .text("❓ Помощь / Как настроить", "help");

    await ctx.reply(
        "Привет! Я Anti-Block Bot.\n\n" +
        "Собираю быстрые MTProto и SOCKS5 прокси для обхода блокировок.\n" +
        "Бесплатно — 1 прокси в сутки.",
        { reply_markup: keyboard }
    );
});

// Шаг 1 — выбор типа прокси
bot.callbackQuery("get_free", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) return ctx.answerCallbackQuery();

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const lastFreeMs = user.last_free ? new Date(user.last_free).getTime() : 0;

    if (!user.is_vip && Date.now() - lastFreeMs < ONE_DAY_MS) {
        return ctx.answerCallbackQuery({
            text: "⏳ Дневной лимит исчерпан. Возвращайтесь завтра или купите VIP!",
            show_alert: true,
        });
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
        .text("🔵 MTProto", "proxy_MTPROTO")
        .text("🟠 SOCKS5", "proxy_SOCKS5");

    await ctx.reply(
        "Выберите тип прокси:\n\n" +
        "🔵 *MTProto* — встроен в Telegram, сложнее заблокировать\n" +
        "🟠 *SOCKS5* — работает для всего трафика",
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
});

// Шаг 2 — выдача прокси нужного типа
bot.callbackQuery(/^proxy_(MTPROTO|SOCKS5)$/, async (ctx) => {
    const userId = ctx.from.id;
    const type = ctx.match[1] as string;

    const proxy = proxies.getFastActiveByType(type);
    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: `😔 Нет активных ${type} прокси. Попробуйте другой тип или зайдите позже.`,
            show_alert: true,
        });
    }

    users.setLastFree(userId);

    await ctx.reply(
        `✅ Ваш ${proxy.type} прокси:\n\n\`${proxy.link}\`\n\nНажмите на ссылку, чтобы применить в Telegram.`,
        { parse_mode: "Markdown" }
    );
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("buy_vip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("💳 Здесь будет интеграция с Telegram Payments (карта или TON).");
});

bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        "📖 *Как настроить прокси:*\n\n" +
        "*MTProto* — встроен в Telegram\\. Нажмите на ссылку — Telegram предложит применить автоматически\\.\n\n" +
        "*SOCKS5* — работает для всего трафика\\. Нажмите на ссылку — применится аналогично\\.\n\n" +
        "MTProto сложнее заблокировать через DPI, SOCKS5 универсальнее\\.",
        { parse_mode: "MarkdownV2" }
    );
});

bot.catch((err) => {
    console.error(`Ошибка апдейта ${err.ctx.update.update_id}:`, err.error);
});
