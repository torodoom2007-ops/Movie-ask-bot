const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==========================================
// הגדרות מערכת ומנהל
// ==========================================
const ADMIN_ID = 8017590244;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ שגיאה קריטית: חסר BOT_TOKEN בהגדרות הסביבה (Environment Variables)!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// שרת HTTP קל לשמירה על השרת פעיל ב-Render
app.get('/', (req, res) => {
  res.send('🎬 השרת של בוט הסרטים והסדרות פעיל ורץ בהצלחה!');
});

app.listen(PORT, () => {
  console.log(`🌐 שרת HTTP פועל בפורט ${PORT}`);
});

// ==========================================
// ניהול מאגר נתונים (JSON Database)
// ==========================================
const DB_FILE = path.join(__dirname, 'movies_db.json');
let db = { movies: [] };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.movies)) db.movies = [];
    } catch (e) {
      console.error("שגיאה בטעינת קובץ המאגר, יוצר מאגר חדש:", e);
      db = { movies: [] };
    }
  } else {
    saveDB();
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

loadDB();

bot.use(session());

let botUsername = '';
bot.telegram.getMe().then((me) => {
  botUsername = me.username;
  console.log(`🤖 הבוט מחובר בהצלחה בתור: @${botUsername}`);
});

const isAdmin = (ctx) => ctx.from && Number(ctx.from.id) === ADMIN_ID;

// תפריט מנהל ראשי
function getAdminKeyboard() {
  return Markup.keyboard([
    ['➕ הוספת סרט/סדרה', '🔍 חיפוש במאגר'],
    ['📁 העלאת מאגר (JSON)', '📥 ייצוא מאגר (JSON)'],
    ['📊 סטטיסטיקת מאגר', '❌ ביטול']
  ]).resize();
}

function resetSession(ctx) {
  if (ctx.session) ctx.session = {};
}

// ==========================================
// פקודות פתיחה וניווט
// ==========================================

bot.start(async (ctx) => {
  const startPayload = ctx.message.text.split(' ')[1];

  // אם המשתמש הגיע דרך קישור ישיר לקבלת סרט/סדרה (Deep Linking)
  if (startPayload && startPayload.startsWith('get_')) {
    const movieId = startPayload.replace('get_', '');
    const item = db.movies.find(m => m.id === movieId);

    if (item) {
      await sendMovieCardToUser(ctx, item);
      return;
    } else {
      return ctx.reply('❌ מצטערים, הסרט או הסדרה המבוקשים לא נמצאו במאגר.');
    }
  }

  if (isAdmin(ctx)) {
    resetSession(ctx);
    return ctx.replyWithHTML(
      `🍿 <b>ברוך הבא ללוח הניהול הממותג!</b>\n` +
      `מכאן תוכל להוסיף תוכן במהירות, לנהל את המאגר ולהעלות קבצים.`,
      getAdminKeyboard()
    );
  }

  return ctx.replyWithHTML(
    `🎬 <b>ברוכים הבאים לבוט הסרטים והסדרות הרשמי!</b> 🍿\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `תוכלו לחפש סרטים וסדרות ישירות כאן או בקבוצות שלנו.\n\n` +
    `🔍 <b>איך מחפשים?</b>\n` +
    `• שלחו לי שם של סרט/סדרה כאן בפרטי.\n` +
    `• או רשמו בקבוצה: <code>/search שם הסרט</code>`
  );
});

bot.hears('❌ ביטול', async (ctx) => {
  resetSession(ctx);
  if (isAdmin(ctx)) {
    await ctx.reply('הפעולה בוטלה בהצלחה.', getAdminKeyboard());
  } else {
    await ctx.reply('הפעולה בוטלה.');
  }
});

// ==========================================
// 1. הוספת סרט/סדרה במהירות (Wizard)
// ==========================================

bot.hears('➕ הוספת סרט/סדרה', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAIT_TYPE' };

  await ctx.replyWithHTML(
    `🎬 <b>הוספת תוכן חדש למאגר</b>\n` +
    `בחר את סוג התוכן שברצונך להוסיף:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🎬 סרט', 'type_movie'), Markup.button.callback('📺 סדרה', 'type_series')]
    ])
  );
});

bot.action(/^type_(movie|series)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const type = ctx.match[1];
  ctx.session.itemType = type;
  ctx.session.step = 'AWAIT_TITLE';

  await ctx.replyWithHTML(`הגדרת סוג: <b>${type === 'movie' ? '🎬 סרט' : '📺 סדרה'}</b>\n\nכעת הזן את <b>שם הסרט/הסדרה</b>:`);
});

bot.hears('📁 העלאת מאגר (JSON)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAIT_JSON_FILE' };
  await ctx.replyWithHTML(
    `📥 <b>טעינת מאגר ידנית/אוטומטית באמצעות קובץ JSON</b>\n\n` +
    `שלח כעת קובץ JSON המכיל את רשימת הסרטים/סדרות למאגר.`
  );
});

bot.hears('📥 ייצוא מאגר (JSON)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!fs.existsSync(DB_FILE) || db.movies.length === 0) {
    return ctx.reply('המאגר ריק כרגע.');
  }
  await ctx.replyWithDocument({ source: DB_FILE, filename: 'movies_db.json' }, { caption: '📦 הנה קובץ המאגר המעודכן שלך.' });
});

bot.hears('📊 סטטיסטיקת מאגר', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const total = db.movies.length;
  const moviesCount = db.movies.filter(m => m.type === 'movie').length;
  const seriesCount = db.movies.filter(m => m.type === 'series').length;

  await ctx.replyWithHTML(
    `📊 <b>סטטיסטיקת מאגר הקולנוע</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎬 סרטים במאגר: <b>${moviesCount}</b>\n` +
    `📺 סדרות במאגר: <b>${seriesCount}</b>\n` +
    `📦 סה"כ פריטים: <b>${total}</b>`
  );
});

// ==========================================
// טיפול בשלבי ההזנה והעלאת קבצים
// ==========================================

bot.on('message', async (ctx, next) => {
  // טיפול בהעלאת קובץ JSON לטעינת מאגר
  if (ctx.message.document && ctx.session && ctx.session.step === 'AWAIT_JSON_FILE') {
    if (!isAdmin(ctx)) return;
    try {
      const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(fileUrl.href);
      const jsonContent = await res.json();

      let itemsToAdd = [];
      if (Array.isArray(jsonContent)) {
        itemsToAdd = jsonContent;
      } else if (jsonContent && Array.isArray(jsonContent.movies)) {
        itemsToAdd = jsonContent.movies;
      }

      if (itemsToAdd.length === 0) {
        return ctx.reply('❌ הקובץ שנשלח אינו מכיל פורמט תקין של רשימת סרטים.');
      }

      let addedCount = 0;
      itemsToAdd.forEach(item => {
        if (item.title) {
          const newItem = {
            id: item.id || 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            title: item.title,
            type: item.type || 'movie',
            year_genre: item.year_genre || 'כללי',
            description: item.description || 'אין תקציר זמין',
            poster: item.poster || null,
            file_id: item.file_id || null,
            file_type: item.file_type || 'text',
            content_text: item.content_text || null
          };
          db.movies.push(newItem);
          addedCount++;
        }
      });

      saveDB();
      resetSession(ctx);
      return ctx.replyWithHTML(`✅ <b>המאגר עודכן בהצלחה!</b>\nנוספו <b>${addedCount}</b> פריטים חדשים.`, getAdminKeyboard());
    } catch (err) {
      console.error(err);
      return ctx.reply('❌ שגיאה בקריאת קובץ ה-JSON. ודא שהקובץ תקין.');
    }
  }

  if (!isAdmin(ctx) || !ctx.session || !ctx.session.step) return next();

  const step = ctx.session.step;

  // קליטת שם
  if (step === 'AWAIT_TITLE') {
    ctx.session.title = ctx.message.text.trim();
    ctx.session.step = 'AWAIT_YEAR_GENRE';
    return ctx.replyWithHTML('מצויין! כעת הזן <b>שנה וז\'אנר</b> (לדוגמה: <code>2024 | אקשן, דרמה</code>):');
  }

  // קליטת שנה וז'אנר
  if (step === 'AWAIT_YEAR_GENRE') {
    ctx.session.year_genre = ctx.message.text.trim();
    ctx.session.step = 'AWAIT_DESC';
    return ctx.replyWithHTML('כעת הזן <b>תקציר / תיאור קצר</b> עבור התוכן:');
  }

  // קליטת תקציר
  if (step === 'AWAIT_DESC') {
    ctx.session.description = ctx.message.text.trim();
    ctx.session.step = 'AWAIT_POSTER';

    return ctx.replyWithHTML(
      'שלח כעת <b>תמונה / פוסטר</b> עבור התוכן (או לחץ על הכפתור כדי לדלג):',
      Markup.inlineKeyboard([[Markup.button.callback('⏩ דלג על תמונה', 'skip_poster')]])
    );
  }

  // קליטת תמונה
  if (step === 'AWAIT_POSTER') {
    if (ctx.message.photo) {
      ctx.session.poster = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
      return ctx.reply('אנא שלח תמונה תקינה או לחץ על "דלג על תמונה".');
    }
    ctx.session.step = 'AWAIT_CONTENT';
    return ctx.replyWithHTML('כעת שלח את **קובץ הסרט/הסדרה** (וידאו, קובץ, קישור, או הודעת טקסט):');
  }

  // קליטת תוכן הקובץ/וידאו/קישור
  if (step === 'AWAIT_CONTENT') {
    let fileId = null;
    let fileType = 'text';
    let contentText = null;

    if (ctx.message.video) {
      fileType = 'video';
      fileId = ctx.message.video.file_id;
    } else if (ctx.message.document) {
      fileType = 'document';
      fileId = ctx.message.document.file_id;
    } else if (ctx.message.text) {
      fileType = 'text';
      contentText = ctx.message.text.trim();
    } else {
      return ctx.reply('אנא שלח וידאו, קובץ או קישור בטקסט.');
    }

    const newItem = {
      id: 'm_' + Date.now(),
      title: ctx.session.title,
      type: ctx.session.itemType,
      year_genre: ctx.session.year_genre,
      description: ctx.session.description,
      poster: ctx.session.poster || null,
      file_id: fileId,
      file_type: fileType,
      content_text: contentText
    };

    db.movies.push(newItem);
    saveDB();
    resetSession(ctx);

    await ctx.replyWithHTML(`🎉 <b>התוכן "${newItem.title}" נשמר בהצלחה במאגר!</b>`, getAdminKeyboard());
    return sendMovieCardToUser(ctx, newItem);
  }

  return next();
});

bot.action('skip_poster', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session.poster = null;
  ctx.session.step = 'AWAIT_CONTENT';
  await ctx.replyWithHTML('דילגת על התמונה. כעת שלח את **קובץ הסרט/הסדרה** (וידאו, קובץ, קישור, או טקסט):');
});

// ==========================================
// 2. מנוע חיפוש מתקדם בפרטי ובקבוצות
// ==========================================

bot.on('message', async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith('/start')) return;

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

  // ניקוי מילת חיפוש
  let query = text.replace('/search', '').replace('/חיפוש', '').trim();

  // אם בקבוצה ואין מילת פקודה, נבדוק אם חיפשו שם מהמאגר
  if (isGroup && !text.startsWith('/search') && !text.startsWith('/חיפוש')) {
    if (text.length < 2) return; // התעלם מהודעות קצרות מדי
  }

  const results = searchDatabase(query);

  if (results.length === 0) {
    if (!isGroup) {
      return ctx.replyWithHTML(`❌ לא נמצאו תוצאות עבור <b>"${query}"</b> במאגר.`);
    }
    return;
  }

  // מענה ממותג ומעוצב
  if (isGroup) {
    // בקבוצה שולחים כרטיס עם כפתור פנייה בפרטי לקבלת הסרט (כדי לא לאמוס על הקבוצה)
    for (const item of results.slice(0, 3)) {
      const caption = formatMovieCardHTML(item);
      const deepLink = `https://t.me/${botUsername}?start=get_${item.id}`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.url('🎬 קבלת הקובץ בפרטי 🍿', deepLink)]]);

      if (item.poster) {
        await ctx.replyWithPhoto(item.poster, { caption, parse_mode: 'HTML', ...keyboard });
      } else {
        await ctx.replyWithHTML(caption, keyboard);
      }
    }
  } else {
    // בפרטי שולחים ישירות
    for (const item of results.slice(0, 5)) {
      await sendMovieCardToUser(ctx, item);
    }
  }
});

// חיפוש במאגר לפי שם, ז'אנר או תקציר
function searchDatabase(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return db.movies.filter(m => 
    m.title.toLowerCase().includes(q) || 
    (m.year_genre && m.year_genre.toLowerCase().includes(q)) ||
    (m.description && m.description.toLowerCase().includes(q))
  );
}

// עיצוב מותג לקולנוע
function formatMovieCardHTML(item) {
  return (
    `🍿 <b>CINEMA STREAM | ${item.type === 'series' ? '📺 סדרה' : '🎬 סרט'}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>שם:</b> ${item.title}\n` +
    `📅 <b>פרטים:</b> ${item.year_genre}\n` +
    `📝 <b>תקציר:</b> ${item.description}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// שליחת הכרטיס והקובץ למשתמש
async function sendMovieCardToUser(ctx, item) {
  const caption = formatMovieCardHTML(item);

  if (item.poster) {
    await ctx.replyWithPhoto(item.poster, { caption, parse_mode: 'HTML' });
  } else {
    await ctx.replyWithHTML(caption);
  }

  // שליחת התוכן בפועל (וידאו, קובץ או קישור)
  if (item.file_type === 'video' && item.file_id) {
    return ctx.replyWithVideo(item.file_id, { caption: `🍿 צפייה מהנה ב-${item.title}!` });
  } else if (item.file_type === 'document' && item.file_id) {
    return ctx.replyWithDocument(item.file_id, { caption: `🍿 ההורדה של ${item.title} מוכנה!` });
  } else if (item.content_text) {
    return ctx.replyWithHTML(`🔗 <b>קישור לצפייה/הורדה:</b>\n${item.content_text}`);
  }
}

// ==========================================
// 3. תמיכה בחיפוש אינליין (Inline Search) בכל צ'אט
// ==========================================

bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  if (!query) return ctx.answerInlineQuery([]);

  const results = searchDatabase(query);

  const inlineResults = results.slice(0, 10).map((item) => {
    const deepLink = `https://t.me/${botUsername}?start=get_${item.id}`;
    return {
      type: 'article',
      id: item.id,
      title: `${item.type === 'series' ? '📺' : '🎬'} ${item.title}`,
      description: `${item.year_genre} | ${item.description}`,
      input_message_content: {
        message_text: formatMovieCardHTML(item),
        parse_mode: 'HTML'
      },
      reply_markup: Markup.inlineKeyboard([[Markup.button.url('🎬 לחץ לקבלת הקובץ 🍿', deepLink)]]).reply_markup
    };
  });

  return ctx.answerInlineQuery(inlineResults);
});

// הפעלת הבוט
bot.launch().then(() => console.log('🚀 Cinema Bot is fully running!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
