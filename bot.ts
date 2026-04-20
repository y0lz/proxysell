// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies, plans, payments } from "./db.js";
import db from "./db.js";
import type { Proxy } from "./db.js";

export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");

// ─── Хелперы ──────────────────────────────────────────────────────────────────

function proxyMessage(proxy: Proxy): string {
    const ping = proxy.ping_ms ? ` · ${proxy.ping_ms}ms` : "";
    const rep = proxy.likes > 0 ? ` · 👍${proxy.likes}` : "";
    const fire = proxy.fires > 0 ? ` · 🔥${proxy.fires}` : "";
    return `✅ MTProto прокси${ping}${rep}${fire}:\n\n\`${proxy.link}\`\n\nНажмите кнопку ниже — Telegram сразу предложит применить.`;
}

function buildMainMenu(): InlineKeyboard {
    return new InlineKeyboard()
        .text("🟩 Получить прокси", "get_proxy").row()
        .text("⭐ Купить Plus", "buy_plus").row()
        .text("❓ Помощь", "help");
}

function buildProxyKeyboard(proxy: Proxy, isPlus: boolean, canReroll: boolean = true): InlineKeyboard {
    const kb = new InlineKeyboard()
        .url("⚡ Применить прокси", proxy.link)
        .row()
        .text("👍", `vote_like_${proxy.id}`)
        .text("🔥", `vote_fire_${proxy.id}`)
        .text("👎", `vote_dislike_${proxy.id}`)
        .row();
    
    if (canReroll) {
        kb.text("🔄 Следующий прокси", `reroll_${proxy.id}`);
    } else {
        // Если нет рероллов, предлагаем купить Plus
        kb.text("⭐ Купить Plus", "buy_plus");
    }
    
    kb.row().text("🏠 Главное меню", "main_menu");
    
    return kb;
}

function buildPlusMenu(): InlineKeyboard {
    return new InlineKeyboard()
        .text("⭐ 10 дней — 13 ⭐", "plus_buy_plus_10").row()
        .text("⭐ 30 дней — 30 ⭐", "plus_buy_plus_30").row()
        .text("⭐ 60 дней — 50 ⭐", "plus_buy_plus_60").row()
        .text("🏠 Главное меню", "main_menu");
}

function buildHelpMenu(): InlineKeyboard {
    return new InlineKeyboard()
        .text("🏠 Главное меню", "main_menu");
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    
    if (!userId) return;
    
    // Проверяем существует ли пользователь
    let user = users.get(userId);
    const isNewUser = !user;
    
    // Создаём или обновляем пользователя
    users.upsert(userId, username, firstName);
    user = users.get(userId);
    
    if (!user) return;
    
    // Только для НОВЫХ пользователей выдаём первый прокси
    if (isNewUser && JSON.parse(user.shown_proxy_ids).length === 0) {
        const proxy = proxies.getProxyForNewUser();
        if (proxy) {
            // Добавляем в показанные
            users.updateRerollData(userId, 0, null, null, [proxy.id]);
            
            await ctx.reply(
                `ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n` +
                `Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n` +
                `Вот твой первый прокси (средний по рейтингу):\n\n` +
                `${proxyMessage(proxy)}`,
                {
                    parse_mode: "Markdown",
                    reply_markup: buildProxyKeyboard(proxy, false),
                }
            );
            return;
        }
    }

    const keyboard = buildMainMenu();

    await ctx.reply(
        "ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n" +
        "Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n" +
        "Free: 3 реролла каждые 4 часа\n" +
        "Plus: безлимитные реролы с КД 7 сек",
        { reply_markup: keyboard }
    );
});

// ─── Главное меню ─────────────────────────────────────────────────────────────

bot.callbackQuery("main_menu", async (ctx) => {
    await ctx.editMessageText(
        "ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n" +
        "Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n" +
        "Free: 3 реролла каждые 4 часа\n" +
        "Plus: безлимитные реролы с КД 7 сек",
        { reply_markup: buildMainMenu() }
    );
    await ctx.answerCallbackQuery();
});

// ─── Получить прокси ──────────────────────────────────────────────────────────

bot.callbackQuery("get_proxy", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) return ctx.answerCallbackQuery();

    const isPlus = users.isPlus(user);
    
    // Для Free пользователей проверяем лимиты (кроме самого первого прокси)
    if (!isPlus && JSON.parse(user.shown_proxy_ids).length > 0) {
        const rerollCheck = proxies.canReroll(userId);
        if (!rerollCheck.allowed) {
            let message = "";
            if (rerollCheck.reason === 'limit') {
                const hours = Math.ceil((rerollCheck.wait_sec || 0) / 3600);
                message = `⏳ Лимит исчерпан (3 прокси за 4ч).\n\nПодождите ${hours}ч или купите Plus для безлимитных рероллов!`;
                
                // Показываем кнопку покупки Plus
                const keyboard = new InlineKeyboard()
                    .text("⭐ Купить Plus", "buy_plus").row()
                    .text("🏠 Главное меню", "main_menu");
                
                await ctx.editMessageText(
                    `⏳ *Лимит рероллов исчерпан*\n\n` +
                    `Free пользователи могут получить только 3 прокси каждые 4 часа\\.\n\n` +
                    `⏰ Следующий прокси будет доступен через ${hours}ч\n\n` +
                    `💡 *Plus подписка* даёт безлимитные реролы с КД всего 10 секунд\\!`,
                    { parse_mode: "MarkdownV2", reply_markup: keyboard }
                );
                return ctx.answerCallbackQuery();
            }
            return ctx.answerCallbackQuery({ text: message, show_alert: true });
        }
        // Записываем использование лимита
        proxies.recordReroll(userId);
    }

    const proxy = proxies.getNextProxy(userId);

    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: "😔 Нет активных прокси. Идёт обновление, попробуйте позже.",
            show_alert: true,
        });
    }

    // Проверяем можно ли ещё делать реролл
    const canReroll = isPlus || proxies.canReroll(userId).allowed;

    await ctx.editMessageText(proxyMessage(proxy), {
        parse_mode: "Markdown",
        reply_markup: buildProxyKeyboard(proxy, isPlus, canReroll),
    });
    await ctx.answerCallbackQuery();
});

// ─── Реролл ──────────────────────────────────────────────────────────────────

bot.callbackQuery(/^reroll_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) return ctx.answerCallbackQuery();

    const isPlus = users.isPlus(user);
    
    // Проверяем возможность реролла
    const rerollCheck = proxies.canReroll(userId);
    if (!rerollCheck.allowed) {
        let message = "";
        let keyboard: InlineKeyboard | undefined;
        
        if (rerollCheck.reason === 'cd') {
            message = `⏳ Кулдаун реролла. Подождите ${rerollCheck.wait_sec} сек.`;
        } else if (rerollCheck.reason === 'limit') {
            if (isPlus) {
                const minutes = Math.ceil((rerollCheck.wait_sec || 0) / 60);
                message = `⏳ Лимит рероллов исчерпан (10 за 5 мин). Подождите ${minutes} мин.`;
            } else {
                const hours = Math.ceil((rerollCheck.wait_sec || 0) / 3600);
                
                // Для Free пользователей показываем экран с предложением Plus
                keyboard = new InlineKeyboard()
                    .text("⭐ Купить Plus", "buy_plus").row()
                    .text("🏠 Главное меню", "main_menu");
                
                await ctx.editMessageText(
                    `⏳ *Лимит рероллов исчерпан*\n\n` +
                    `Free пользователи могут получить только 3 прокси каждые 4 часа\\.\n\n` +
                    `⏰ Следующий прокси будет доступен через ${hours}ч\n\n` +
                    `💡 *Plus подписка* даёт безлимитные реролы с КД всего 10 секунд\\!`,
                    { parse_mode: "MarkdownV2", reply_markup: keyboard }
                );
                return ctx.answerCallbackQuery();
            }
        }
        
        if (keyboard) {
            return ctx.answerCallbackQuery({ text: message, show_alert: true });
        } else {
            return ctx.answerCallbackQuery({ text: message, show_alert: true });
        }
    }

    // Записываем реролл
    proxies.recordReroll(userId);
    
    // Получаем следующий прокси
    const proxy = proxies.getNextProxy(userId);
    if (!proxy) {
        return ctx.answerCallbackQuery({
            text: "😔 Больше нет активных прокси. Попробуйте позже.",
            show_alert: true,
        });
    }

    // Проверяем можно ли ещё делать реролл после этого
    const canRerollNext = isPlus || proxies.canReroll(userId).allowed;

    await ctx.editMessageText(proxyMessage(proxy), {
        parse_mode: "Markdown",
        reply_markup: buildProxyKeyboard(proxy, isPlus, canRerollNext),
    });
    await ctx.answerCallbackQuery();
});

// ─── Голосование ─────────────────────────────────────────────────────────────

bot.callbackQuery(/^vote_(like|dislike|fire)_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const vote = ctx.match[1] as "like" | "dislike" | "fire";
    const proxyId = parseInt(ctx.match[2]!, 10);

    // Проверяем, не голосовал ли уже пользователь за этот прокси
    const existingVote = db.prepare(`
        SELECT vote FROM proxy_votes WHERE proxy_id = ? AND user_id = ?
    `).get(proxyId, userId) as { vote: string } | undefined;

    if (existingVote) {
        await ctx.answerCallbackQuery({ text: "Вы уже оценили этот прокси!", show_alert: true });
        return;
    }

    // Записываем голос
    proxies.vote(proxyId, userId, vote);

    const labels = { like: "👍 Спасибо!", dislike: "👎 Учтём.", fire: "🔥 Огонь!" };
    
    // Если дизлайк - автоматически переходим к следующему прокси
    if (vote === 'dislike') {
        await ctx.answerCallbackQuery({ text: labels[vote] });
        
        const user = users.get(userId);
        if (!user) return;

        const isPlus = users.isPlus(user);
        
        // Проверяем возможность реролла
        const rerollCheck = proxies.canReroll(userId);
        if (!rerollCheck.allowed) {
            let message = "";
            if (rerollCheck.reason === 'cd') {
                message = `⏳ Кулдаун реролла. Подождите ${rerollCheck.wait_sec} сек.`;
            } else if (rerollCheck.reason === 'limit') {
                const hours = Math.ceil((rerollCheck.wait_sec || 0) / 3600);
                message = `⏳ Лимит исчерпан (3 прокси за 4ч). Подождите ${hours}ч или купите Plus!`;
            }
            return ctx.answerCallbackQuery({ text: message, show_alert: true });
        }

        // Записываем реролл
        proxies.recordReroll(userId);
        
        // Получаем следующий прокси
        const nextProxy = proxies.getNextProxy(userId);
        if (!nextProxy) {
            return ctx.answerCallbackQuery({
                text: "😔 Больше нет активных прокси. Попробуйте позже.",
                show_alert: true,
            });
        }

        // Проверяем можно ли ещё делать реролл после этого
        const canRerollNext = isPlus || proxies.canReroll(userId).allowed;

        await ctx.editMessageText(proxyMessage(nextProxy), {
            parse_mode: "Markdown",
            reply_markup: buildProxyKeyboard(nextProxy, isPlus, canRerollNext),
        });
    } else {
        await ctx.answerCallbackQuery({ text: labels[vote] });
    }
});

// ─── Plus покупка ─────────────────────────────────────────────────────────────

bot.callbackQuery("buy_plus", async (ctx) => {
    await ctx.editMessageText(
        "⭐ *Plus подписка*\n\n" +
        "• Безлимитные реролы \\(КД 7 сек\\)\n" +
        "• Прокси с лучшим рейтингом в первую очередь\n" +
        "• Приоритетная поддержка\n\n" +
        "⚠️ Сейчас оплата в тестовом режиме — подписка активируется бесплатно\\.",
        { parse_mode: "MarkdownV2", reply_markup: buildPlusMenu() }
    );
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^plus_buy_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const planId = ctx.match[1]!;
    const plan = plans.getById(planId);
    
    if (!plan) {
        return ctx.answerCallbackQuery({ text: "❌ Тариф не найден", show_alert: true });
    }

    // Создаём платёж (в тестовом режиме сразу подтверждаем)
    const paymentId = payments.create(userId, 'plus', plan.duration_days, plan.stars);
    const result = payments.confirm(paymentId);

    const untilStr = new Date(result.newPlusUntil).toLocaleDateString("ru-RU", { 
        day: "numeric", 
        month: "long", 
        year: "numeric" 
    });

    await ctx.answerCallbackQuery({ text: `✅ Plus активирован на ${plan.duration_days} дней!`, show_alert: true });
    await ctx.reply(
        `🎉 *Plus активирован!*\n\n` +
        `Действует до: *${untilStr}*\n\n` +
        `Теперь вы можете делать безлимитные реролы с лучшими прокси!`,
        { parse_mode: "Markdown" }
    );
});

// ─── Помощь ───────────────────────────────────────────────────────────────────

bot.callbackQuery("help", async (ctx) => {
    await ctx.editMessageText(
        "📖 *Как настроить MTProto прокси:*\n\n" +
        "1\\. Нажмите *Получить прокси*\n" +
        "2\\. Нажмите кнопку *⚡ Применить прокси* — Telegram сам предложит добавить\n" +
        "3\\. Подтвердите в диалоге\n\n" +
        "*Реролл прокси:*\n" +
        "• Free: 3 реролла каждые 4 часа \\(случайные прокси\\)\n" +
        "• Plus: безлимит с КД 7 сек \\(лучшие прокси\\)\n\n" +
        "Если прокси не работает — нажмите 👎 и попробуйте снова\\.",
        { parse_mode: "MarkdownV2", reply_markup: buildHelpMenu() }
    );
    await ctx.answerCallbackQuery();
});

bot.catch((err) => {
    console.error(`Ошибка апдейта ${err.ctx.update.update_id}:`, err.error);
});
