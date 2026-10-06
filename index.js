const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');

// 1. הגדרת משתני סביבה
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // ללא @

if (!BOT_TOKEN || !BOT_USERNAME) {
  console.error('❌ שגיאה: יש להגדיר את BOT_TOKEN ו-BOT_USERNAME במשתני הסביבה!');
  process.exit(1);
}

// 2. שרת Express לשמירה על חיים ב-Render (Health Check)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 הבוט פעיל ועובד!');
});

app.listen(PORT, () => {
  console.log(`[HTTP] Server is running on port ${PORT}`);
});

// 3. אתחול הבוט
const bot = new Telegraf(BOT_TOKEN);

// 4. טעינת בסיס הנתונים
let db = { movies: [] };

function loadDatabase() {
  try {
    const rawData = fs.readFileSync('./movies_db.json', 'utf8');
    db = JSON.parse(rawData);
    console.log(`[DB] נטענו ${db.movies.length} פריטים בהצלחה.`);
  } catch (err) {
    console.error('[DB Error] שגיאה בטעינת movies_db.json:', err.message);
  }
}
loadDatabase();

// 5. פונקציית חיפוש
function searchDatabase(query) {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return [];

  return db.movies.filter(item => {
    const titleMatch = item.title && item.title.toLowerCase().includes(cleanQuery);
    const aliasMatch = item.aliases && item.aliases.some(alias => alias.toLowerCase().includes(cleanQuery));
    return titleMatch || aliasMatch;
  });
}

// 6. פונקציית שליחת הקובץ
async function sendMovieFile(ctx, movieId, chatId) {
  const item = db.movies.find(m => m.id === movieId);
  if (!item) {
    return ctx.telegram.sendMessage(chatId, '❌ הקובץ המבוקש לא נמצא במאגר.');
  }

  try {
    await ctx.telegram.copyMessage(
      chatId,
      item.from_chat_id,
      item.message_id
    );
  } catch (err) {
    console.error(`[Send Error] נכשל בשליחת ${item.id}:`, err.message);
    await ctx.telegram.sendMessage(
      chatId,
      `❌ שגיאה בשליחת **${item.title}**.\nודא שהבוט מוגדר כמנהל בערוץ האחסון וההודעה קיימת.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// 7. טיפול בפקודת /start (כולל הזרמת Deep Link מהקבוצה)
bot.start(async (ctx) => {
  const startPayload = ctx.payload;

  if (startPayload && startPayload.startsWith('mov_')) {
    await ctx.reply('⏳ שולח לך את הקובץ המבוקש...');
    return sendMovieFile(ctx, startPayload, ctx.chat.id);
  }

  await ctx.reply(
    `שלום ${ctx.from.first_name}! 👋\n` +
    `חפש סרט/סדרה ישירות כאן בפרטי, או תוסיף אותי לקבוצה שלך כדי לחפש שם.`
  );
});

// 8. טיפול בחיפוש טקסט (קבוצה + פרטי)
bot.on('text', async (ctx) => {
  const query = ctx.message.text;
  if (query.startsWith('/')) return;

  const results = searchDatabase(query);
  if (results.length === 0) {
    if (ctx.chat.type === 'private') {
      return ctx.reply(`❌ לא נמצאו תוצאות עבור: "${query}"`);
    }
    return;
  }

  const isPrivate = ctx.chat.type === 'private';
  const topResults = results.slice(0, 8);
  const inlineKeyboard = [];

  topResults.forEach(item => {
    if (isPrivate) {
      inlineKeyboard.push([
        Markup.button.callback(`🎬 ${item.title}`, `get:${item.id}`)
      ]);
    } else {
      const deepLinkUrl = `https://t.me/${BOT_USERNAME}?start=${item.id}`;
      inlineKeyboard.push([
        Markup.button.url(`📩 ${item.title} (קבל בפרטי)`, deepLinkUrl)
      ]);
    }
  });

  await ctx.reply(`🔍 **תוצאות חיפוש עבור:** "${query}"\nנמצאו **${results.length}** תוצאות:`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(inlineKeyboard)
  });
});

// 9. טיפול בלחיצה בפרטי
bot.action(/^get:(mov_\d+)$/, async (ctx) => {
  const movieId = ctx.match[1];
  await ctx.answerCbQuery('שולח קובץ...');
  await sendMovieFile(ctx, movieId, ctx.chat.id);
});

// הפעלת הבוט
bot.launch().then(() => {
  console.log('🤖 הבוט פעיל ומוכן לעבודה!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
