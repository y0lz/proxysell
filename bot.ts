// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies, plans, payments } from "./db.js";
import type { Proxy, User } from "./db.js";

export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");

// ─── Хелперы ──────────────────────────────────────────────────────────────────

function proxyMessage(proxy: Proxy): string {
    const ping = proxy.ping_ms ? ` · ${proxy.ping_ms}ms` : "";
    const rep = proxy.likes > 0 ? ` · 👍${proxy.likes}` : "";
    const fire = proxy.fires > 0 ? ` · 🔥${proxy.fires}` : "";
    return `✅ MTProto прокси${ping}${rep}${fire}:\n\n\`${proxy.link}\`\n\nНажмите кнопку ниже — Telegram сразу предложит применить.`;
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
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    
    if (userId) {
        users.upsert(userId, username, firstName);
    }

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

    const vip = users.isVip(user);

    if (!vip && !users.canGetFreeProxy(user)) {
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

    if (!vip) users.setLastFreeAt(userId);
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

    if (!user || !users.isVip(user)) {
        return ctx.answerCallbackQuery({ text: "❌ Только для VIP.", show_alert: true });
    }

    // Исключаем последний показанный прокси
    const excludeId = user.last_proxy_id ?? parseInt(ctx.match[1]!, 10);
    const proxy = proxies.getNextProxy("MTPROTO", [excludeId]);

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

    const allPlans = plans.getAll();
    const keyboard = new InlineKeyboard();
    
    for (const plan of allPlans) {
        const emoji = plan.plan_type === 'vip_plus' ? '⭐' : '📅';
        const price = plan.price_stars ? `${plan.price_stars} ⭐` : `${plan.price_rub}₽`;
        keyboard.text(`${emoji} ${plan.name} — ${price}`, `vip_buy_${plan.id}`).row();
    }

    await ctx.reply(
        "🚀 *VIP доступ*\n\n" +
        "• *VIP:* 5 прокси в день, реролл, лучшая репутация\n" +
        "• *VIP\\+:* безлимитные прокси, реролл, приоритет\n\n" +
        "⚠️ Сейчас оплата в тестовом режиме — подписка активируется бесплатно\\.",
        { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
});

bot.callbackQuery(/^vip_buy_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const planId = ctx.match[1]!;
    const plan = plans.getById(planId);
    
    if (!plan) {
        return ctx.answerCallbackQuery({ text: "❌ Тариф не найден", show_alert: true });
    }

    // Создаём платёж (в тестовом режиме сразу подтверждаем)
    const paymentId = payments.create(userId, plan.id, plan.price_rub, 'stars');
    const result = payments.confirm(paymentId);

    const untilStr = new Date(result.newVipUntil).toLocaleDateString("ru-RU", { 
        day: "numeric", 
        month: "long", 
        year: "numeric" 
    });

    await ctx.answerCallbackQuery({ text: `✅ ${plan.name} активирован!`, show_alert: true });
    await ctx.reply(
        `🎉 *${plan.name} активирован!*\n\n` +
        `Действует до: *${untilStr}*\n\n` +
        `Теперь вы можете получать прокси ${plan.proxy_limit === 999 ? 'без ограничений' : `до ${plan.proxy_limit} раз в день`} ` +
        `и использовать кнопку 🔄 для смены.`,
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
