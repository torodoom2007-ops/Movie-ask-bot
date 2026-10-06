const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// -------------------------------------------------------------
// 1. קונפיגורציה ומשתני סביבה
// -------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 8017590244;
const VAULT_CHANNEL_ID = -1004295952149; // ערוץ האחסון מאחורי הקלעים
const SIGNATURE_LINK = 'https://t.me/movie_time_by';
const ADMIN_CONTACT_LINK = 'https://t.me/admi_nos';

if (!BOT_TOKEN) {
  console.error('❌ שגיאה: יש להגדיר BOT_TOKEN במשתני הסביבה!');
  process.exit(1);
}

// -------------------------------------------------------------
// 2. שרת Express ל-Render (Health Check)
// -------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🍿 Movie Fast Bot is Running!'));
app.listen(PORT, () => console.log(`[HTTP] Server listening on port ${PORT}`));

// -------------------------------------------------------------
// 3. ניהול מאגר הנתונים (JSON Persistence)
// -------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'movies_db.json');
let db = { movies: [], channels: [] };

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
      if (!db.movies) db.movies = [];
      if (!db.channels) db.channels = [];
      console.log(`[DB] נטענו ${db.movies.length} פריטים ו-${db.channels.length} ערוצים.`);
    }
  } catch (err) {
    console.error('[DB Error] שגיאה בטעינה:', err.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('[DB Error] שגיאה בשמירה:', err.message);
  }
}

loadDB();

// -------------------------------------------------------------
// 4. ניהול סשנים בזיכרון & מעקב כישלונות
// -------------------------------------------------------------
const adminSessions = {}; // { [adminId]: { step, tempMedia: [], ... } }
const failedSearchAttempts = {}; // { [userId]: count }

// שליחת גיבוי אוטומטי למנהל
async function sendBackupToAdmin(ctx) {
  try {
    saveDB();
    await ctx.telegram.sendDocument(ADMIN_ID, {
      source: DB_PATH,
      filename: 'movies_db.json'
    }, {
      caption: `📦 **גיבוי מאגר מעודכן!**\nסה"כ סרטים/סדרות: **${db.movies.length}**\nסה"כ ערוצים/קבוצות: **${db.channels.length}**`,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('[Backup Error]', err.message);
  }
}

// מקלדת מנהל ראשית
function getAdminKeyboard() {
  return Markup.keyboard([
    ['🎬 הוסף סרט', '📺 הוסף סדרה'],
    ['🔗 הוסף ערוץ/קבוצה', '🔄 שחזר מאגר ידני'],
    ['📊 מצב מאגר']
  ]).resize();
}

// -------------------------------------------------------------
// 5. אתחול הבוט
// -------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

// -------------------------------------------------------------
// 6. פאנל ניהול (מנהל בלבד ID: 8017590244)
// -------------------------------------------------------------

bot.start(async (ctx) => {
  if (ctx.from.id === ADMIN_ID && ctx.chat.type === 'private') {
    adminSessions[ADMIN_ID] = { step: 'IDLE' };
    return ctx.reply('👋 **שלום מנהל!** ברוך הבא לפאנל השליטה.', {
      parse_mode: 'Markdown',
      ...getAdminKeyboard()
    });
  }
  
  await ctx.reply('👋 **ברוכים הבאים לבוט הסרטים והסדרות!**\nחפשו שם סרט או סדרה בלבד בקבוצה.', {
    parse_mode: 'Markdown'
  });
});

// טיפול בכפתורי תפריט מנהל
bot.hears('🎬 הוסף סרט', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminSessions[ADMIN_ID] = { step: 'AWAITING_MOVIE_MEDIA' };
  await ctx.reply('✨ **הוספת סרט חדש**\nאנא שלח/העבר את קובץ הסרט כעת.');
});

bot.hears('📺 הוסף סדרה', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminSessions[ADMIN_ID] = { step: 'AWAITING_SERIES_MEDIA', tempMedia: [] };
  await ctx.reply('✨ **הוספת סדרה חדשה**\nשלח/העבר את כל פרקי הסדרה ברצף.\nכאשר תסיים, שלח את הטקסט: **"סיימתי להעלות"**.');
});

bot.hears('🔗 הוסף ערוץ/קבוצה', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminSessions[ADMIN_ID] = { step: 'AWAITING_CHANNEL_LINK' };
  await ctx.reply('🔗 **הוספת קישור לערוץ/קבוצה**\nאנא שלח את הקישור (למשל: https://t.me/example).');
});

bot.hears('🔄 שחזר מאגר ידני', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminSessions[ADMIN_ID] = { step: 'AWAITING_RESTORE_FILE' };
  await ctx.reply('📂 **שחזור מאגר**\nאנא שלח קובץ `movies_db.json` מעודכן לשחזור.');
});

bot.hears('📊 מצב מאגר', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply(`🎉 **תמונה מצב מאגר:**\n\n🎬 סרטים/פרקים: **${db.movies.length}**\n🔗 ערוצים/קבוצות: **${db.channels.length}**`, {
    parse_mode: 'Markdown'
  });
});

// -------------------------------------------------------------
// 7. טיפול בהודעות פרטיות / תהליכי ניהול מנהל
// -------------------------------------------------------------
bot.on(['message'], async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (ctx.from.id !== ADMIN_ID) return next();

  const session = adminSessions[ADMIN_ID] || { step: 'IDLE' };
  const text = ctx.message.text;

  // 1. שחזור מאגר מקובץ JSON
  if (session.step === 'AWAITING_RESTORE_FILE') {
    if (ctx.message.document && ctx.message.document.file_name.endsWith('.json')) {
      try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
        const response = await fetch(fileLink.href);
        const json = await response.json();
        
        if (json.movies && Array.isArray(json.movies)) {
          db = json;
          saveDB();
          adminSessions[ADMIN_ID] = { step: 'IDLE' };
          return ctx.reply(`✅ **המאגר שוחזר בהצלחה!**\nנטענו **${db.movies.length}** פריטים.`, getAdminKeyboard());
        }
      } catch (err) {
        return ctx.reply('❌ **קובץ לא תקין.** נסה שוב.');
      }
    } else {
      return ctx.reply('⚠️ אנא שלח קובץ JSON תקין.');
    }
  }

  // 2. הוספת סרט - העברת מדיה
  if (session.step === 'AWAITING_MOVIE_MEDIA') {
    if (ctx.message.video || ctx.message.document) {
      try {
        const forwarded = await ctx.telegram.copyMessage(
          VAULT_CHANNEL_ID,
          ctx.chat.id,
          ctx.message.message_id
        );

        adminSessions[ADMIN_ID] = {
          step: 'AWAITING_MOVIE_TITLE',
          vaultMessageId: forwarded.message_id
        };

        return ctx.reply('✅ **המדיה נשמרה באחסון!**\nעכשיו, הזן את שם החיפוש המדויק עבור הסרט.');
      } catch (err) {
        return ctx.reply(`❌ **שגיאה בהעברה לערוץ האחסון:** ${err.message}`);
      }
    } else {
      return ctx.reply('⚠️ אנא שלח קובץ וידאו/מסמך סרט.');
    }
  }

  // הוספת סרט - שמירת שם חיפוש
  if (session.step === 'AWAITING_MOVIE_TITLE' && text) {
    const movieTitle = text.trim();
    const newMovie = {
      id: `mov_${Date.now()}`,
      title: movieTitle,
      aliases: movieTitle.toLowerCase().split(' '),
      from_chat_id: VAULT_CHANNEL_ID,
      message_id: session.vaultMessageId,
      type: 'movie'
    };

    db.movies.push(newMovie);
    saveDB();
    adminSessions[ADMIN_ID] = { step: 'IDLE' };

    await ctx.reply(`🎉 **הסרט "${movieTitle}" נוסף בהצלחה למאגר!**`, getAdminKeyboard());
    await sendBackupToAdmin(ctx);
    return;
  }

  // 3. הוספת סדרה - קבלת פרקים מרובים
  if (session.step === 'AWAITING_SERIES_MEDIA') {
    if (text === 'סיימתי להעלות') {
      if (!session.tempMedia || session.tempMedia.length === 0) {
        return ctx.reply('⚠️ לא העלת אף פרק. אנא שלח פרקים.');
      }

      adminSessions[ADMIN_ID].step = 'AWAITING_SERIES_TITLE';
      return ctx.reply(`👍 נקלטו **${session.tempMedia.length}** פרקים.\nכעת הזן את שם הסדרה והעונה (למשל: סדרה לדוגמא עונה 1).`);
    }

    if (ctx.message.video || ctx.message.document) {
      try {
        const forwarded = await ctx.telegram.copyMessage(
          VAULT_CHANNEL_ID,
          ctx.chat.id,
          ctx.message.message_id
        );
        session.tempMedia.push(forwarded.message_id);
        return ctx.reply(`📥 פרק ${session.tempMedia.length} נקלט באחסון.`);
      } catch (err) {
        return ctx.reply(`❌ שגיאה בשמירת הפרק: ${err.message}`);
      }
    }
  }

  // הוספת סדרה - שמירת שם עונה ומספור אוטומטי
  if (session.step === 'AWAITING_SERIES_TITLE' && text) {
    const seriesBaseTitle = text.trim();
    const mediaList = session.tempMedia || [];

    mediaList.forEach((msgId, idx) => {
      const epNum = idx + 1;
      const fullTitle = `${seriesBaseTitle} פרק ${epNum}`;
      db.movies.push({
        id: `ser_${Date.now()}_${epNum}`,
        title: fullTitle,
        aliases: fullTitle.toLowerCase().split(' '),
        from_chat_id: VAULT_CHANNEL_ID,
        message_id: msgId,
        type: 'series'
      });
    });

    saveDB();
    adminSessions[ADMIN_ID] = { step: 'IDLE' };

    await ctx.reply(`🎉 **הסדרה "${seriesBaseTitle}" (${mediaList.length} פרקים) נשמרה בהצלחה!**`, getAdminKeyboard());
    await sendBackupToAdmin(ctx);
    return;
  }

  // 4. הוספת ערוץ/קבוצה
  if (session.step === 'AWAITING_CHANNEL_LINK' && text) {
    adminSessions[ADMIN_ID] = {
      step: 'AWAITING_CHANNEL_QUERY',
      tempLink: text.trim()
    };
    return ctx.reply('כעת הזן את מילת/שם החיפוש עבור ערוץ זה:');
  }

  if (session.step === 'AWAITING_CHANNEL_QUERY' && text) {
    db.channels.push({
      id: `chan_${Date.now()}`,
      link: session.tempLink,
      query: text.trim().toLowerCase()
    });

    saveDB();
    adminSessions[ADMIN_ID] = { step: 'IDLE' };

    await ctx.reply(`🎉 **הערוץ/קבוצה נוספו בהצלחה למאגר!**`, getAdminKeyboard());
    await sendBackupToAdmin(ctx);
    return;
  }

  return next();
});

// -------------------------------------------------------------
// 8. ניהול קבוצה, הגנה, וחיפוש מבוסס ביצועים מהירים
// -------------------------------------------------------------

// א) הגנת ספאם, קישורים וקבצים בקבוצה
bot.on(['document', 'video', 'photo', 'audio'], async (ctx, next) => {
  if (ctx.chat.type === 'private') return next();
  if (ctx.from.id === ADMIN_ID) return next();

  try {
    await ctx.deleteMessage();
    const warnMsg = await ctx.reply(
      `🚫 **[${ctx.from.first_name}](tg://user?id=${ctx.from.id}) אסור לפרסם קבצים או קישורים בקבוצה!**\n\n` +
      `💼 אבל אנחנו מחפשים מנהלים! [הגש מועמדות כאן](${ADMIN_CONTACT_LINK})`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warnMsg.message_id).catch(() => {}), 10000);
  } catch (err) {
    console.error('[Anti-Spam Error]', err.message);
  }
});

// ב) זיהוי הודעות טקסט בקבוצות
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();
  const userId = ctx.from.id;

  // 1. בדיקת קישורים בטקסט
  if (text.includes('http://') || text.includes('https://') || text.includes('t.me/')) {
    if (userId !== ADMIN_ID) {
      try {
        await ctx.deleteMessage();
        const warn = await ctx.reply(
          `🚫 **[${ctx.from.first_name}](tg://user?id=${userId}) אסור לפרסם קישורים בקבוצה!**\n\n` +
          `💼 אנחנו מחפשים מנהלים! [הגש מועמדות כאן](${ADMIN_CONTACT_LINK})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 10000);
        return;
      } catch (e) {}
    }
  }

  // 2. מילות טריגר אסורות ("אפשר את", "יש לכם", וכו')
  const triggerWords = ['אפשר את', 'יש לכם', 'אפשר', 'יש'];
  const startsWithTrigger = triggerWords.some(word => lowerText.startsWith(word));

  if (startsWithTrigger && text.split(' ').length < 5) {
    return ctx.reply('⚠️ **נא להזין שם סרט או סדרה בלבד!**', {
      reply_to_message_id: ctx.message.message_id
    });
  }

  // 3. בדיקת תאימות מול ערוצים/קבוצות שמוגדרים במאגר
  const matchedChannel = db.channels.find(c => lowerText.includes(c.query));
  if (matchedChannel) {
    return ctx.reply(`✨ **נמצא קישור מתאים עבור "${text}":**`, {
      reply_to_message_id: ctx.message.message_id,
      ...Markup.inlineKeyboard([
        [Markup.button.url('🔗 לחץ למעבר לערוץ/קבוצה', matchedChannel.link)]
      ])
    });
  }

  // 4. חיפוש ישיר במאגר הסרטים והסדרות
  const searchResults = db.movies.filter(m => {
    return lowerText.includes(m.title.toLowerCase()) || 
           m.aliases.some(alias => lowerText === alias);
  });

  // אם נמצאה תוצאה - שליחה מיידית של המדיה בלחיצה אחת
  if (searchResults.length > 0) {
    failedSearchAttempts[userId] = 0; // איפוס כישלונות

    for (const item of searchResults.slice(0, 3)) {
      try {
        await ctx.telegram.copyMessage(
          ctx.chat.id,
          item.from_chat_id,
          item.message_id,
          {
            caption: `🎬 **${item.title}**\n\n🍿 לצפייה בערוץ הרשמי שלנו: ${SIGNATURE_LINK}`,
            parse_mode: 'Markdown'
          }
        );
      } catch (err) {
        console.error(`[Copy Error] ${item.id}:`, err.message);
      }
    }
    return;
  }

  // 5. תוצאה לא נמצאה
  failedSearchAttempts[userId] = (failedSearchAttempts[userId] || 0) + 1;

  // תגובת איקס מיידית להודעה
  try {
    await ctx.react('❌');
  } catch (err) {}

  // אם המשתמש נכשל 3 פעמים רצופות
  if (failedSearchAttempts[userId] >= 3) {
    failedSearchAttempts[userId] = 0;
    return ctx.reply(
      `🧐 **אני רואה שלא מצאת את מה שחיפשת...**\n` +
      `💬 [דבר עם המנהל כאן](${ADMIN_CONTACT_LINK})`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }

  // הודעת "לא נמצא" מעוצבת וחדה
  return ctx.reply(
    `⚠️ **הסרט/הסדרה לא נמצא!**\n` +
    `בבקשה לחפש שם סרט או סדרה בלבד עם רווחים.`,
    {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    }
  );
});

// -------------------------------------------------------------
// 9. הפעלת הבוט
// -------------------------------------------------------------
bot.launch().then(() => {
  console.log('⚡ הבוט פעיל במוד מהיר (ללא AI/השהיות) ומוכן לעבודה!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
