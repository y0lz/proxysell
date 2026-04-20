// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies } from "./db.js";
import type { Proxy } from "./db.js";

export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");

// ─── Хелперы ──────────────────────────────────────────────────────────────────

function isVipActive(user: { is_vip: number; vip_until: string | null }): boolean {
    return user.is_vip === 1 && user.vip_until != null && new Date(user.vip_until) > new Date();
}

function proxyMessage(proxy: Proxy): string {
    const ping = proxy.ping_ms ? ` · ${proxy.ping_ms}ms` : "";
    const rep = proxy.likes > 0 ? ` · 👍${proxy.likes}` : "";
    const fire = proxy.fires > 0 ? ` · 🔥${proxy.fires}` : "";
    return `✅ MTProto прокси${ping}${rep}${fire}:\n\n\`${proxy.link}\`\n\nНажмите кнопку ниже — Telegram сразу предложит применить.`;
}

function proxyKeyboard(proxyId: number, isVip: boolean): InlineKeyboard {
    const kb = new InlineKeyboard()
        .url("⚡ Применить прокси", `tg://proxy?${proxyId}`) // placeholder, реальная ссылка в тексте
        .row()
        .text("👍", `vote_like_${proxyId}`)
        .text("🔥", `vote_fire_${proxyId}`)
        .text("👎", `vote_dislike_${proxyId}`);
    if (isVip) {
        kb.row().text("🔄 Следующий прокси", `reroll_${proxyId}`);
    }
    return kb;
}

function buildProxyKeyboard(proxy: Proxy, isVip: boolean): InlineKeyboard {
    const kb = new InlineKeyboard()
        .url("⚡ Применить прокси", proxy.link)
        .row()
        .text("👍", `vote_like_${proxy.id}`)
        .text("🔥", `vote_fire_${proxy.id}`)
        .text("👎", `vote_dislike_${proxy.id}`);
    if (isVip) {
        kb.row().text("🔄 Следующий прокси", `reroll_${proxy.id}`);
    }
    return kb;
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) users.upsert(userId);

    const keyboard = new InlineKeyboard()
        .text("🟩 Получить прокси", "get_free").row()
        .text("🚀 Купить VIP доступ", "buy_vip").row()
        .text("❓ Помощь / Как настроить", "help");

    await ctx.reply(
        "Привет! Я Anti-Block Bot.\n\n" +
        "Собираю быстрые MTProto прокси для обхода блокировок Telegram.\n" +
        "Бесплатно — 1 прокси в сутки.",
        { reply_markup: keyboard }
    );
});

// ─── Получить прокси ──────────────────────────────────────────────────────────

bot.callbackQuery("get_free", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) return ctx.answerCallbackQuery();

    const vip = isVipActive(user);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const lastFreeMs = user.last_free ? new Date(user.last_free).getTime() : 0;

    if (!vip && Date.now() - lastFreeMs < ONE_DAY_MS) {
        return ctx.answerCallbackQuery({
            text: "⏳ Дневной лимит исчерпан. Возвращайтесь завтра или купите VIP!",
            show_alert: true,
        });
    }

    // VIP получает прокси с лучшей репутацией, обычный — просто активный
    const proxy = vip
        ? proxies.getVipProxy("MTPROTO")
        : proxies.getFastActiveByType("MTPROTO");

    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: "😔 Нет активных прокси. Идёт обновление, попробуйте позже.",
            show_alert: true,
        });
    }

    if (!vip) users.setLastFree(userId);
    users.setLastProxyId(userId, proxy.id);

    await ctx.reply(proxyMessage(proxy), {
        parse_mode: "Markdown",
        reply_markup: buildProxyKeyboard(proxy, vip),
    });
    await ctx.answerCallbackQuery();
});

// ─── Реролл (только VIP) ─────────────────────────────────────────────────────

bot.callbackQuery(/^reroll_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);

    if (!user || !isVipActive(user)) {
        return ctx.answerCallbackQuery({ text: "❌ Только для VIP.", show_alert: true });
    }

    // Исключаем последний показанный прокси
    const excludeId = user.last_proxy_id ?? parseInt(ctx.match[1]!, 10);
    const proxy = proxies.getNextProxy("MTPROTO", excludeId);

    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: "😔 Больше нет активных прокси. Попробуйте позже.",
            show_alert: true,
        });
    }

    users.setLastProxyId(userId, proxy.id);

    await ctx.editMessageText(proxyMessage(proxy), {
        parse_mode: "Markdown",
        reply_markup: buildProxyKeyboard(proxy, true),
    });
    await ctx.answerCallbackQuery();
});

// ─── Голосование ─────────────────────────────────────────────────────────────

bot.callbackQuery(/^vote_(like|dislike|fire)_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const vote = ctx.match[1] as "like" | "dislike" | "fire";
    const proxyId = parseInt(ctx.match[2]!, 10);

    proxies.vote(proxyId, userId, vote);

    const labels = { like: "👍 Спасибо!", dislike: "👎 Учтём.", fire: "🔥 Огонь!" };
    await ctx.answerCallbackQuery({ text: labels[vote] });
});

// ─── VIP покупка ──────────────────────────────────────────────────────────────

bot.callbackQuery("buy_vip", async (ctx) => {
    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
        .text("📅 1 день — 29₽ (тест)", "vip_buy_1").row()
        .text("📅 7 дней — 149₽ (тест)", "vip_buy_7").row()
        .text("📅 30 дней — 399₽ (тест)", "vip_buy_30");

    await ctx.reply(
        "🚀 *VIP доступ*\n\n" +
        "• Безлимитные прокси без суточного ограничения\n" +
        "• Прокси с лучшей репутацией в первую очередь\n" +
        "• Кнопка 🔄 для мгновенной смены прокси\n\n" +
        "⚠️ Сейчас оплата в тестовом режиме — подписка активируется бесплатно.",
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
});

bot.callbackQuery(/^vip_buy_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const days = parseInt(ctx.match[1]!, 10);
    users.setVip(userId, days);

    const until = new Date(Date.now() + days * 86400_000);
    const untilStr = until.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

    await ctx.answerCallbackQuery({ text: `✅ VIP активирован на ${days} дн.!`, show_alert: true });
    await ctx.reply(
        `🎉 *VIP активирован!*\n\nДействует до: *${untilStr}*\n\nТеперь вы можете получать прокси без ограничений и использовать кнопку 🔄 для смены.`,
        { parse_mode: "Markdown" }
    );
});

// ─── Помощь ───────────────────────────────────────────────────────────────────

bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        "📖 *Как настроить MTProto прокси:*\n\n" +
        "1\\. Нажмите *Получить прокси*\n" +
        "2\\. Нажмите кнопку *⚡ Применить прокси* — Telegram сам предложит добавить\n" +
        "3\\. Подтвердите в диалоге\n\n" +
        "Если прокси не работает — нажмите 👎 и попробуйте снова\\.\n" +
        "VIP\\-пользователи могут нажать 🔄 для мгновенной замены\\.",
        { parse_mode: "MarkdownV2" }
    );
});

bot.catch((err) => {
    console.error(`Ошибка апдейта ${err.ctx.update.update_id}:`, err.error);
});
