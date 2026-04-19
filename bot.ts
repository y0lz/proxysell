// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies } from "./db.js";

export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");

// ─── /start ───────────────────────────────────────────────────────────────────

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

// ─── Бесплатный прокси: шаг 1 — выбор типа ───────────────────────────────────

bot.callbackQuery("get_free", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) return ctx.answerCallbackQuery();

    // Проверяем лимит (VIP не ограничен)
    const isVipActive = user.is_vip === 1 &&
        user.vip_until != null &&
        new Date(user.vip_until) > new Date();

    if (!isVipActive) {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const lastFreeMs = user.last_free ? new Date(user.last_free).getTime() : 0;
        if (Date.now() - lastFreeMs < ONE_DAY_MS) {
            return ctx.answerCallbackQuery({
                text: "⏳ Дневной лимит исчерпан. Возвращайтесь завтра или купите VIP!",
                show_alert: true,
            });
        }
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

// ─── Бесплатный прокси: шаг 2 — выдача + кнопка применения ──────────────────

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

    // Кнопка с tg:// ссылкой — при нажатии Telegram сразу предложит применить прокси
    const keyboard = new InlineKeyboard().url("⚡ Применить прокси", proxy.link);

    const pingInfo = proxy.ping_ms ? ` (${proxy.ping_ms}ms)` : "";
    await ctx.reply(
        `✅ Ваш ${proxy.type} прокси${pingInfo}:\n\n` +
        `\`${proxy.link}\`\n\n` +
        `Нажмите кнопку ниже — Telegram сразу предложит применить.`,
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery();
});

// ─── VIP: покупка (тестовая пустышка) ────────────────────────────────────────

bot.callbackQuery("buy_vip", async (ctx) => {
    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
        .text("📅 1 день — 29₽ (тест)", "vip_buy_1").row()
        .text("📅 7 дней — 149₽ (тест)", "vip_buy_7").row()
        .text("📅 30 дней — 399₽ (тест)", "vip_buy_30");

    await ctx.reply(
        "🚀 *VIP доступ*\n\n" +
        "• Безлимитные прокси без суточного ограничения\n" +
        "• Только самые быстрые (ping < 500ms)\n" +
        "• Мгновенная замена одной кнопкой\n\n" +
        "⚠️ Сейчас оплата в тестовом режиме — подписка активируется бесплатно.",
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
});

// Тестовая активация VIP (без реальной оплаты)
bot.callbackQuery(/^vip_buy_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const days = parseInt(ctx.match[1] as string, 10);

    users.setVip(userId, days);

    const until = new Date(Date.now() + days * 86400_000);
    const untilStr = until.toLocaleDateString("ru-RU", {
        day: "numeric", month: "long", year: "numeric"
    });

    await ctx.answerCallbackQuery({ text: `✅ VIP активирован на ${days} дн.!`, show_alert: true });
    await ctx.reply(
        `🎉 *VIP активирован!*\n\n` +
        `Действует до: *${untilStr}*\n\n` +
        `Теперь вы можете получать прокси без ограничений.`,
        { parse_mode: "Markdown" }
    );
});

// VIP: мгновенная замена прокси
bot.callbackQuery(/^vip_replace_(MTPROTO|SOCKS5)$/, async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    const type = ctx.match[1] as string;

    const isVipActive = user?.is_vip === 1 &&
        user.vip_until != null &&
        new Date(user.vip_until) > new Date();

    if (!isVipActive) {
        return ctx.answerCallbackQuery({ text: "❌ VIP не активен.", show_alert: true });
    }

    const proxy = proxies.getFastActiveByType(type);
    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: `😔 Нет активных ${type} прокси.`,
            show_alert: true,
        });
    }

    const keyboard = new InlineKeyboard()
        .url("⚡ Применить прокси", proxy.link).row()
        .text("🔄 Заменить ещё раз", `vip_replace_${type}`);

    const pingInfo = proxy.ping_ms ? ` (${proxy.ping_ms}ms)` : "";
    await ctx.reply(
        `⚡ *VIP прокси*${pingInfo}:\n\n\`${proxy.link}\``,
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery();
});

// ─── Помощь ───────────────────────────────────────────────────────────────────

bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
        .text("🔄 Заменить MTProto", "vip_replace_MTPROTO")
        .text("🔄 Заменить SOCKS5", "vip_replace_SOCKS5");

    await ctx.reply(
        "📖 *Как настроить прокси:*\n\n" +
        "1\\. Нажмите *Получить прокси* и выберите тип\n" +
        "2\\. Нажмите кнопку *Применить прокси* — Telegram сам предложит добавить\n" +
        "3\\. Подтвердите в диалоге\n\n" +
        "*MTProto* — встроен в Telegram, сложнее заблокировать через DPI\n" +
        "*SOCKS5* — работает для всего трафика устройства\n\n" +
        "VIP\\-пользователи могут мгновенно менять прокси:",
        { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
});

bot.catch((err) => {
    console.error(`Ошибка апдейта ${err.ctx.update.update_id}:`, err.error);
});
