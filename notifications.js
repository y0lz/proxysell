// notifications.ts - система уведомлений для админа
import { bot } from "./bot.js";
const ADMIN_ID = 1929553674;
// Логирование и отправка уведомления о новом пользователе
export async function notifyNewUser(data) {
    const logMessage = `[NEW USER] ID: ${data.userId}, Username: @${data.username || 'none'}, Name: ${data.firstName || 'none'}, Time: ${data.timestamp.toISOString()}`;
    console.log(logMessage);
    const telegramMessage = `🆕 *Новый пользователь*\n\n` +
        `👤 ID: \`${data.userId}\`\n` +
        `📝 Username: ${data.username ? `@${data.username}` : 'не указан'}\n` +
        `🏷 Имя: ${data.firstName || 'не указано'}\n` +
        `⏰ Время: ${data.timestamp.toLocaleString('ru-RU')}`;
    try {
        await bot.api.sendMessage(ADMIN_ID, telegramMessage, { parse_mode: "Markdown" });
    }
    catch (error) {
        console.error(`[NOTIFICATION ERROR] Failed to send new user notification:`, error);
    }
}
// Логирование и отправка уведомления о покупке
export async function notifyPurchase(data) {
    const logMessage = `[PURCHASE] User: ${data.userId} (@${data.username || 'none'}), Plan: ${data.planId}, Duration: ${data.duration}d, Stars: ${data.stars}, Time: ${data.timestamp.toISOString()}`;
    console.log(logMessage);
    const telegramMessage = `💰 *Новая покупка Plus!*\n\n` +
        `👤 ID: \`${data.userId}\`\n` +
        `📝 Username: ${data.username ? `@${data.username}` : 'не указан'}\n` +
        `🏷 Имя: ${data.firstName || 'не указано'}\n` +
        `📦 План: ${data.planId}\n` +
        `📅 Длительность: ${data.duration} дней\n` +
        `⭐ Стоимость: ${data.stars} звёзд\n` +
        `⏰ Время: ${data.timestamp.toLocaleString('ru-RU')}`;
    try {
        await bot.api.sendMessage(ADMIN_ID, telegramMessage, { parse_mode: "Markdown" });
    }
    catch (error) {
        console.error(`[NOTIFICATION ERROR] Failed to send purchase notification:`, error);
    }
}
// Отправка статистики админу (можно вызывать по команде)
export async function sendDailyStats() {
    try {
        // Здесь можно добавить запросы к БД для получения статистики
        const message = `📊 *Ежедневная статистика*\n\n` +
            `Статистика будет добавлена позже...`;
        await bot.api.sendMessage(ADMIN_ID, message, { parse_mode: "Markdown" });
    }
    catch (error) {
        console.error(`[NOTIFICATION ERROR] Failed to send daily stats:`, error);
    }
}
//# sourceMappingURL=notifications.js.map