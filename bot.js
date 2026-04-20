// bot.ts
import { Bot, InlineKeyboard } from "grammy";
import { users, proxies, plans, payments } from "./db.js";
import db from "./db.js";
import { notifyNewUser, notifyPurchase } from "./notifications.js";
export const bot = new Bot(process.env["BOT_TOKEN"] ?? "");
// ─── Хелперы ──────────────────────────────────────────────────────────────────
function proxyMessage(proxy) {
    const ping = proxy.ping_ms ? ` · ${proxy.ping_ms}ms` : "";
    const rep = proxy.likes > 0 ? ` · 👍${proxy.likes}` : "";
    const fire = proxy.fires > 0 ? ` · 🔥${proxy.fires}` : "";
    return `✅ MTProto прокси${ping}${rep}${fire}:\n\n\`${proxy.link}\`\n\nНажмите кнопку ниже — Telegram сразу предложит применить.`;
}
function buildMainMenu() {
    return new InlineKeyboard()
        .text("🟩 Получить прокси", "get_proxy").row()
        .text("⭐ Купить Plus", "buy_plus").row()
        .text("👤 Профиль", "profile");
}
function buildProxyKeyboard(proxy, isPlus, canReroll = true) {
    const kb = new InlineKeyboard()
        .url("⚡ Применить прокси", proxy.link)
        .row()
        .text("👍", `vote_like_${proxy.id}`)
        .text("🔥", `vote_fire_${proxy.id}`)
        .text("👎", `vote_dislike_${proxy.id}`)
        .row();
    if (canReroll) {
        kb.text("🔄 Следующий прокси", `reroll_${proxy.id}`);
    }
    else {
        // Если нет рероллов, предлагаем купить Plus
        kb.text("⭐ Купить Plus", "buy_plus");
    }
    kb.row().text("🏠 Главное меню", "main_menu");
    return kb;
}
function buildPlusMenu() {
    return new InlineKeyboard()
        .text("⭐ 10 дней — 13 ⭐", "plus_buy_plus_10").row()
        .text("⭐ 30 дней — 30 ⭐", "plus_buy_plus_30").row()
        .text("⭐ 60 дней — 50 ⭐", "plus_buy_plus_60").row()
        .text("🏠 Главное меню", "main_menu");
}
function buildProfileMenu() {
    return new InlineKeyboard()
        .text("❓ Помощь", "help").row()
        .text("🏠 Главное меню", "main_menu");
}
function buildHelpMenu() {
    return new InlineKeyboard()
        .text("🏠 Главное меню", "main_menu");
}
// ─── /start ───────────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    if (!userId)
        return;
    // Проверяем существует ли пользователь
    let user = users.get(userId);
    const isNewUser = !user;
    // Создаём или обновляем пользователя
    users.upsert(userId, username, firstName);
    user = users.get(userId);
    if (!user)
        return;
    // Уведомляем о новом пользователе
    if (isNewUser) {
        await notifyNewUser({
            userId,
            username,
            firstName,
            timestamp: new Date()
        });
    }
    // Только для НОВЫХ пользователей выдаём первый прокси
    if (isNewUser && JSON.parse(user.shown_proxy_ids).length === 0) {
        const proxy = proxies.getProxyForNewUser();
        if (proxy) {
            // Добавляем в показанные
            users.updateRerollData(userId, 0, null, null, [proxy.id]);
            await ctx.reply(`ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n` +
                `Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n` +
                `Вот твой первый прокси (средний по рейтингу):\n\n` +
                `${proxyMessage(proxy)}`, {
                parse_mode: "Markdown",
                reply_markup: buildProxyKeyboard(proxy, false),
            });
            return;
        }
    }
    const keyboard = buildMainMenu();
    await ctx.reply("ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n" +
        "Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n" +
        "Free: 3 реролла каждые 4 часа\n" +
        "Plus: безлимитные реролы с КД 7 сек", { reply_markup: keyboard });
});
// ─── Главное меню ─────────────────────────────────────────────────────────────
bot.callbackQuery("main_menu", async (ctx) => {
    await ctx.editMessageText("ProxyRoll — бот с рабочими MTProto прокси для Telegram.\n\n" +
        "Скрапим свежие прокси, проверяем их из России, сортируем по скорости и оценкам. 🥰\n\n" +
        "Free: 3 реролла каждые 4 часа\n" +
        "Plus: безлимитные реролы с КД 7 сек", { reply_markup: buildMainMenu() });
    await ctx.answerCallbackQuery();
});
// ─── Получить прокси ──────────────────────────────────────────────────────────
bot.callbackQuery("get_proxy", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user)
        return ctx.answerCallbackQuery();
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
                await ctx.editMessageText(`⏳ *Лимит рероллов исчерпан*\n\n` +
                    `Free пользователи могут получить только 3 прокси каждые 4 часа\\.\n\n` +
                    `⏰ Следующий прокси будет доступен через ${hours}ч\n\n` +
                    `💡 *Plus подписка* даёт безлимитные реролы с КД всего 10 секунд\\!`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
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
    if (!user)
        return ctx.answerCallbackQuery();
    const isPlus = users.isPlus(user);
    // Проверяем возможность реролла
    const rerollCheck = proxies.canReroll(userId);
    if (!rerollCheck.allowed) {
        let message = "";
        let keyboard;
        if (rerollCheck.reason === 'cd') {
            message = `⏳ Кулдаун реролла. Подождите ${rerollCheck.wait_sec} сек.`;
        }
        else if (rerollCheck.reason === 'limit') {
            if (isPlus) {
                const minutes = Math.ceil((rerollCheck.wait_sec || 0) / 60);
                message = `⏳ Лимит рероллов исчерпан (10 за 5 мин). Подождите ${minutes} мин.`;
            }
            else {
                const hours = Math.ceil((rerollCheck.wait_sec || 0) / 3600);
                // Для Free пользователей показываем экран с предложением Plus
                keyboard = new InlineKeyboard()
                    .text("⭐ Купить Plus", "buy_plus").row()
                    .text("🏠 Главное меню", "main_menu");
                await ctx.editMessageText(`⏳ *Лимит рероллов исчерпан*\n\n` +
                    `Free пользователи могут получить только 3 прокси каждые 4 часа\\.\n\n` +
                    `⏰ Следующий прокси будет доступен через ${hours}ч\n\n` +
                    `💡 *Plus подписка* даёт безлимитные реролы с КД всего 10 секунд\\!`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
                return ctx.answerCallbackQuery();
            }
        }
        if (keyboard) {
            return ctx.answerCallbackQuery({ text: message, show_alert: true });
        }
        else {
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
    const vote = ctx.match[1];
    const proxyId = parseInt(ctx.match[2], 10);
    // Проверяем, не голосовал ли уже пользователь за этот прокси
    const existingVote = db.prepare(`
        SELECT vote FROM proxy_votes WHERE proxy_id = ? AND user_id = ?
    `).get(proxyId, userId);
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
        if (!user)
            return;
        const isPlus = users.isPlus(user);
        // Проверяем возможность реролла
        const rerollCheck = proxies.canReroll(userId);
        if (!rerollCheck.allowed) {
            let message = "";
            if (rerollCheck.reason === 'cd') {
                message = `⏳ Кулдаун реролла. Подождите ${rerollCheck.wait_sec} сек.`;
            }
            else if (rerollCheck.reason === 'limit') {
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
        // Проверяем, что это не тот же прокси (избегаем ошибки "message is not modified")
        if (nextProxy.id === proxyId) {
            return ctx.answerCallbackQuery({ text: "👎 Учтём ваш отзыв!" });
        }
        // Проверяем можно ли ещё делать реролл после этого
        const canRerollNext = isPlus || proxies.canReroll(userId).allowed;
        try {
            await ctx.editMessageText(proxyMessage(nextProxy), {
                parse_mode: "Markdown",
                reply_markup: buildProxyKeyboard(nextProxy, isPlus, canRerollNext),
            });
        }
        catch (error) {
            // Если сообщение не изменилось, просто показываем уведомление
            if (error.description?.includes("message is not modified")) {
                return ctx.answerCallbackQuery({ text: "👎 Учтём ваш отзыв!" });
            }
            throw error;
        }
    }
    else {
        await ctx.answerCallbackQuery({ text: labels[vote] });
    }
});
// ─── Plus покупка ─────────────────────────────────────────────────────────────
bot.callbackQuery("buy_plus", async (ctx) => {
    await ctx.editMessageText("⭐ *Plus подписка*\n\n" +
        "• Безлимитные реролы \\(КД 7 сек\\)\n" +
        "• Прокси с лучшим рейтингом в первую очередь\n" +
        "• Приоритетная поддержка\n\n" +
        "💳 Оплата через Telegram Stars", { parse_mode: "MarkdownV2", reply_markup: buildPlusMenu() });
    await ctx.answerCallbackQuery();
});
bot.callbackQuery(/^plus_buy_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    const planId = ctx.match[1];
    const plan = plans.getById(planId);
    if (!plan) {
        return ctx.answerCallbackQuery({ text: "❌ Тариф не найден", show_alert: true });
    }
    // Создаём реальный платёж через Telegram Stars
    try {
        const invoice = await ctx.api.sendInvoice(userId, `Plus подписка на ${plan.duration_days} дней`, `Безлимитные реролы с КД 7 сек, лучшие прокси по рейтингу`, JSON.stringify({ planId, userId }), // payload для идентификации
        "XTR", // Telegram Stars
        [{ label: `Plus ${plan.duration_days} дней`, amount: plan.stars }], {
            start_parameter: `plus_${planId}`,
            photo_url: "https://i.imgur.com/placeholder.jpg", // можно добавить картинку
            photo_width: 512,
            photo_height: 512,
            need_name: false,
            need_phone_number: false,
            need_email: false,
            need_shipping_address: false,
            send_phone_number_to_provider: false,
            send_email_to_provider: false,
            is_flexible: false
        });
        // Создаём запись о платеже в БД
        const paymentId = payments.create(userId, 'plus', plan.duration_days, plan.stars, JSON.stringify({ planId, userId }));
        await ctx.answerCallbackQuery({ text: `💳 Счёт на ${plan.stars} ⭐ отправлен!` });
    }
    catch (error) {
        console.error(`[PAYMENT ERROR] Failed to create invoice for user ${userId}:`, error);
        await ctx.answerCallbackQuery({ text: "❌ Ошибка создания счёта. Попробуйте позже.", show_alert: true });
    }
});
// ─── Профиль ──────────────────────────────────────────────────────────────────
bot.callbackQuery("profile", async (ctx) => {
    const userId = ctx.from.id;
    const user = users.get(userId);
    if (!user) {
        await ctx.answerCallbackQuery({ text: "❌ Пользователь не найден", show_alert: true });
        return;
    }
    const isPlus = users.isPlus(user);
    const shownProxies = JSON.parse(user.shown_proxy_ids).length;
    const joinDate = new Date(user.joined_at).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric"
    });
    let subscriptionInfo = "";
    if (isPlus && user.plus_until) {
        const untilDate = new Date(user.plus_until).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric"
        });
        const daysLeft = Math.ceil((new Date(user.plus_until).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        subscriptionInfo = `⭐ *Plus подписка*\n` +
            `Действует до: ${untilDate}\n` +
            `Осталось дней: ${daysLeft}\n\n`;
    }
    else {
        subscriptionInfo = `🆓 *Free подписка*\n` +
            `Лимит: 3 прокси каждые 4 часа\n\n`;
    }
    // Информация о рероллах
    let rerollInfo = "";
    if (user.reroll_count > 0 && user.reroll_window_start) {
        const windowStart = new Date(user.reroll_window_start);
        const now = new Date();
        const planConfig = isPlus ? { reroll_window_sec: 86400 } : { reroll_window_sec: 14400 };
        const windowEnd = new Date(windowStart.getTime() + planConfig.reroll_window_sec * 1000);
        if (windowEnd > now) {
            const hoursLeft = Math.ceil((windowEnd.getTime() - now.getTime()) / (1000 * 60 * 60));
            rerollInfo = `🔄 Использовано рероллов: ${user.reroll_count}\n` +
                `⏰ Окно сбросится через: ${hoursLeft}ч\n\n`;
        }
    }
    await ctx.editMessageText(`👤 *Ваш профиль*\n\n` +
        `${subscriptionInfo}` +
        `📊 *Статистика:*\n` +
        `Просмотрено прокси: ${shownProxies}\n` +
        `Дата регистрации: ${joinDate}\n\n` +
        `${rerollInfo}` +
        `💡 *Как работает бот:*\n` +
        `• Скрапим прокси из открытых источников\n` +
        `• Проверяем их скорость из России\n` +
        `• Сортируем по рейтингу пользователей\n` +
        `• Plus получает лучшие прокси первыми`, { parse_mode: "Markdown", reply_markup: buildProfileMenu() });
    await ctx.answerCallbackQuery();
});
// ─── Обработка платежей ──────────────────────────────────────────────────────
// Обработка успешного платежа
bot.on("pre_checkout_query", async (ctx) => {
    // Всегда подтверждаем платёж (можно добавить дополнительные проверки)
    await ctx.answerPreCheckoutQuery(true);
});
// Обработка завершённого платежа
bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    try {
        const payloadData = JSON.parse(payment.invoice_payload);
        const planId = payloadData.planId;
        const plan = plans.getById(planId);
        if (!plan) {
            console.error(`[PAYMENT ERROR] Plan not found: ${planId}`);
            return;
        }
        // Находим платёж в БД и подтверждаем его
        const dbPayment = payments.getByPayload(payment.invoice_payload);
        if (dbPayment) {
            const result = payments.confirm(dbPayment.id);
            const untilStr = new Date(result.newPlusUntil).toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric"
            });
            // Отправляем уведомление пользователю
            await ctx.reply(`🎉 *Платёж успешно обработан!*\n\n` +
                `⭐ Plus подписка активирована на ${plan.duration_days} дней\n` +
                `📅 Действует до: *${untilStr}*\n\n` +
                `Теперь вы можете делать безлимитные реролы с лучшими прокси!`, { parse_mode: "Markdown" });
            // Отправляем уведомление админу
            await notifyPurchase({
                userId,
                username,
                firstName,
                planId,
                duration: plan.duration_days,
                stars: plan.stars,
                timestamp: new Date()
            });
        }
        else {
            console.error(`[PAYMENT ERROR] Payment not found in DB for payload: ${payment.invoice_payload}`);
        }
    }
    catch (error) {
        console.error(`[PAYMENT ERROR] Failed to process successful payment:`, error);
    }
});
// ─── Помощь ───────────────────────────────────────────────────────────────────
bot.callbackQuery("help", async (ctx) => {
    await ctx.editMessageText("📖 *Как настроить MTProto прокси:*\n\n" +
        "1\\. Нажмите *Получить прокси*\n" +
        "2\\. Нажмите кнопку *⚡ Применить прокси* — Telegram сам предложит добавить\n" +
        "3\\. Подтвердите в диалоге\n\n" +
        "*Реролл прокси:*\n" +
        "• Free: 3 реролла каждые 4 часа \\(случайные прокси\\)\n" +
        "• Plus: безлимит с КД 7 сек \\(лучшие прокси\\)\n\n" +
        "Если прокси не работает — нажмите 👎 и попробуйте снова\\.", { parse_mode: "MarkdownV2", reply_markup: buildHelpMenu() });
    await ctx.answerCallbackQuery();
});
bot.catch((err) => {
    console.error(`Ошибка апдейта ${err.ctx.update.update_id}:`, err.error);
});
//# sourceMappingURL=bot.js.map