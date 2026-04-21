# ProxyRoll Bot

🤖 Telegram бот для получения рабочих MTProto прокси с автоматической проверкой и рейтингом.

## 🚀 Возможности

- **Автоматический скрапинг** прокси из 14 источников (398+ прокси)
- **Проверка из России** для гарантии работоспособности
- **Система рейтингов** на основе отзывов пользователей
- **Два тарифа**: Free (10 попыток/5ч) и Plus (безлимит с КД 7 сек)
- **Реальные платежи** через Telegram Stars
- **Уведомления админу** о новых пользователях и покупках

## 📋 Требования

- Node.js 18+
- npm или yarn
- SQLite3

## ⚙️ Установка

1. Клонируйте репозиторий:
```bash
git clone https://github.com/y0lz/proxysell.git
cd proxysell
```

2. Установите зависимости:
```bash
npm install
```

3. Настройте переменные окружения в `.env`:
```env
BOT_TOKEN=your_telegram_bot_token
API_PORT=3000
API_SECRET=your_secret_key
AGENT_URL=http://your-ru-server:3001
```

4. Соберите проект:
```bash
npm run build
```

5. Запустите бота:
```bash
npm start
# или с PM2
pm2 start index.js --name proxysell
```

## 🏗️ Архитектура

- **bot.ts** - Основная логика Telegram бота
- **scraper.ts** - Скрапинг прокси из источников
- **checker.ts** - Проверка работоспособности прокси
- **db.ts** - Работа с базой данных SQLite
- **notifications.ts** - Система уведомлений админу
- **index.ts** - HTTP API и планировщики

## 📊 Источники прокси

### Telegram каналы:
- @mtpro_xyz
- @proxyListFree  
- @mtrproxytg
- @MTProxyExpress
- @MTProxySpot
- @MTProtoStream
- @SecureMTProto
- @MTProtoGateway
- @FastMTProxyHub
- @MTProxyOnly
- @DailyProxyList
- @FreeSecureProxy
- @JustMTProxy

### GitHub:
- Grim1313/mtproto-for-telegram

## 💰 Тарифы Plus

| Длительность | Цена | Возможности |
|-------------|------|-------------|
| 10 дней | 13 ⭐ | Безлимитные реролы, КД 7 сек |
| 30 дней | 30 ⭐ | Лучшие прокси по рейтингу |
| 60 дней | 50 ⭐ | Приоритетная поддержка |

## 🔧 API Endpoints

- `GET /stats` - Статистика базы данных
- `GET /unchecked` - Непроверенные прокси
- `POST /report` - Отчёт о проверке прокси
- `POST /rescrape` - Запуск повторного скрапинга
- `POST /restart` - Перезапуск сервера

## 📱 Команды бота

- `/start` - Начать работу с ботом
- Кнопки:
  - 🟩 Получить прокси
  - ⭐ Купить Plus  
  - 👤 Профиль

## 🛠️ Разработка

```bash
# Разработка с автоперезагрузкой
npm run dev

# Сборка
npm run build

# Тестирование скрапера
node test-scraper.js

# Проверка типов
npx tsc --noEmit
```

## 📈 Мониторинг

Бот автоматически:
- Скрапит новые прокси каждые 2 часа
- Проверяет прокси каждые 30 минут  
- Сбрасывает истёкшие подписки каждый час
- Уведомляет о подписках за 24ч до истечения

## 🔐 Безопасность

- Все платежи через официальный Telegram Stars API
- Валидация всех входящих данных
- Защита от SQL-инъекций через prepared statements
- Ограничения по частоте запросов

## 📞 Поддержка

При возникновении проблем:
1. Проверьте логи: `pm2 logs proxysell`
2. Перезапустите: `pm2 restart proxysell`
3. Обновите: `git pull && npm run build && pm2 restart proxysell`

## 📄 Лицензия

MIT License - используйте свободно для личных и коммерческих проектов.