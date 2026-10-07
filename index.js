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

// שרת HTTP קל לשמירה על השרת פעיל ב-Render 24/7
app.get('/', (req, res) => {
  res.send('⚡ השרת המהיר של בוט הסרטים והסדרות פעיל!');
});

app.listen(PORT, () => {
  console.log(`🌐 שרת HTTP פועל בפורט ${PORT}`);
});

// ==========================================
// ניהול מאגר נתונים (JSON Database)
// ==========================================
const DB_FILE = path.join(__dirname, 'movies_db.json');
let db = { items: [] };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.items)) db.items = [];
    } catch (e) {
      console.error("שגיאה בטעינת קובץ המאגר:", e);
      db = { items: [] };
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
  console.log(`🤖 הבוט מחובר בהצלחה: @${botUsername}`);
});

const isAdmin = (ctx) => ctx.from && Number(ctx.from.id) === ADMIN_ID;

// תפריט מנהל ראשי
function getAdminKeyboard() {
  return Markup.keyboard([
    ['⚡ מצב קליטה מהירה בהעברה (פעיל)', '📊 סטטיסטיקה'],
    ['📁 העלאת מאגר (JSON)', '📥 ייצוא מאגר (JSON)'],
    ['🗑️ מחיקת כל המאגר', '❌ ביטול']
  ]).resize();
}

// ==========================================
// פונקציית פענוח אוטומטית (Auto-Parser)
// ==========================================
function parseMediaDetails(text = '') {
  const cleanText = text.trim();
  if (!cleanText) {
    return { title: 'תוכן ללא שם', cleanTitle: 'תוכן ללא שם', type: 'movie', season: null, episode: null };
  }

  const lines = cleanText.split('\n');
  const rawTitle = lines[0].replace(/[🎬📺🍿🎥⚡🔥]/g, '').trim();

  let season = null;
  let episode = null;
  let type = 'movie';

  // זיהוי פורמט S01E02 או S1E2 או S01 E02
  const seMatch = cleanText.match(/S(\d+)\s*E(\d+)/i);
  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    type = 'series';
  } else {
    // זיהוי בעברית או באנגלית: עונה X פרק Y
    const seasonMatch = cleanText.match(/(?:עונה|season)\s*(\d+)/i);
    const episodeMatch = cleanText.match(/(?:פרק|episode|ep)\s*(\d+)/i);

    if (seasonMatch || episodeMatch) {
      type = 'series';
      if (seasonMatch) season = parseInt(seasonMatch[1], 10);
      if (episodeMatch) episode = parseInt(episodeMatch[1], 10);
    }
  }

  // ניקוי שם הסדרה/הסרט לצורך קיבוץ וחיפוש מדויק
  let cleanTitle = rawTitle
    .replace(/S\d+\s*E\d+/gi, '')
    .replace(/(?:עונה|season)\s*\d+/gi, '')
    .replace(/(?:פרק|episode|ep)\s*\d+/gi, '')
    .replace(/[-|_]/g, ' ')
    .trim();

  if (!cleanTitle) cleanTitle = rawTitle;

  return { title: rawTitle, cleanTitle, type, season, episode };
}

// ==========================================
// פקודות ניווט ותפריטים
// ==========================================

bot.start(async (ctx) => {
  const startPayload = ctx.message.text.split(' ')[1];

  // קבלת פריט בודד
  if (startPayload && startPayload.startsWith('get_')) {
    const itemId = startPayload.replace('get_', '');
    const item = db.items.find(i => i.id === itemId);
    if (item) return sendItemToUser(ctx, item);
    return ctx.reply('❌ הפריט המבוקש לא נמצא במאגר.');
  }

  // הצגת סדרה שלמה
  if (startPayload && startPayload.startsWith('series_')) {
    const cleanTitle = decodeURIComponent(startPayload.replace('series_', ''));
    return showSeriesMenu(ctx, cleanTitle);
  }

  if (isAdmin(ctx)) {
    return ctx.replyWithHTML(
      `🍿 <b>מערכת קליטה מהירה מופעלת!</b>\n\n` +
      `⚡ <b>איך מעלים עשרות סרטים ופרקים בדקה?</b>\n` +
      `פשוט <b>תעביר (Forward)</b> לכאן הודעות, סרטונים, קבצים או קישורים מערוצים אחרים.\n` +
      `הבוט יפענח וישמור אותם אוטומטית במאגר תוך שבריר שנייה!`,
      getAdminKeyboard()
    );
  }

  return ctx.replyWithHTML(
    `🎬 <b>ברוכים הבאים לבוט הקולנוע והסדרות!</b> 🍿\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔍 <b>איך מחפשים?</b>\n` +
    `• שלחו שם של סרט או סדרה בפרטי.\n` +
    `• בקבוצות: רשמו <code>/search שם הסרט</code> או פשוט את שם הסרט.`
  );
});

bot.hears('❌ ביטול', async (ctx) => {
  if (isAdmin(ctx)) {
    await ctx.reply('הפעולה בוטלה.', getAdminKeyboard());
  }
});

bot.hears('📊 סטטיסטיקה', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const total = db.items.length;
  const movies = db.items.filter(i => i.type === 'movie').length;
  const seriesEpisodes = db.items.filter(i => i.type === 'series').length;

  // חישוב כמות סדרות ייחודיות
  const uniqueSeries = new Set(db.items.filter(i => i.type === 'series').map(i => i.cleanTitle.toLowerCase())).size;

  await ctx.replyWithHTML(
    `📊 <b>סטטיסטיקת מאגר מהיר</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎬 סרטים במאגר: <b>${movies}</b>\n` +
    `📺 סדרות ייחודיות: <b>${uniqueSeries}</b>\n` +
    `🧩 סה"כ פרקי סדרות: <b>${seriesEpisodes}</b>\n` +
    `📦 סה"כ פריטים במאגר: <b>${total}</b>`
  );
});

bot.hears('📥 ייצוא מאגר (JSON)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (db.items.length === 0) return ctx.reply('המאגר ריק כרגע.');
  await ctx.replyWithDocument({ source: DB_FILE, filename: 'movies_db.json' }, { caption: '📦 קובץ המאגר המלא שלך.' });
});

bot.hears('📁 העלאת מאגר (JSON)', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAIT_JSON' };
  await ctx.reply('שלח כעת קובץ JSON מעודכן להחלפה או מיזוג המאגר.');
});

bot.hears('🗑️ מחיקת כל המאגר', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.replyWithHTML(
    '⚠️ <b>האם אתה בטוח שברצונך למחוק את כל המאגר?</b>',
    Markup.inlineKeyboard([[Markup.button.callback('❌ כן, מחק הכל!', 'confirm_delete_all')]])
  );
});

bot.action('confirm_delete_all', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  db.items = [];
  saveDB();
  await ctx.reply('🗑️ המאגר נמחק כולו בהצלחה!');
});

// ==========================================
// 1. קליטה מהירה במיוחד בשיטת העברה (Forwarding Bulk)
// ==========================================

bot.on('message', async (ctx, next) => {
  // טיפול בהעלאת קובץ JSON
  if (ctx.message.document && ctx.session && ctx.session.step === 'AWAIT_JSON') {
    if (!isAdmin(ctx)) return;
    try {
      const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(fileUrl.href);
      const jsonContent = await res.json();

      let itemsToAdd = Array.isArray(jsonContent) ? jsonContent : (jsonContent.items || jsonContent.movies || []);

      if (itemsToAdd.length === 0) return ctx.reply('❌ קובץ JSON לא תקין או ריק.');

      db.items.push(...itemsToAdd);
      saveDB();
      ctx.session = {};
      return ctx.reply(`✅ נטענו בהצלחה ${itemsToAdd.length} פריטים למאגר!`, getAdminKeyboard());
    } catch (e) {
      return ctx.reply('❌ שגיאה בטעינת קובץ ה-JSON.');
    }
  }

  // אם ההודעה התקבלה מהמנהל - קליטה אוטומטית מיידית
  if (isAdmin(ctx)) {
    const text = ctx.message.caption || ctx.message.text || '';
    let fileId = null;
    let fileType = 'text';

    if (ctx.message.video) {
      fileType = 'video';
      fileId = ctx.message.video.file_id;
    } else if (ctx.message.document) {
      fileType = 'document';
      fileId = ctx.message.document.file_id;
    } else if (ctx.message.photo) {
      fileType = 'photo';
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    }

    if (fileId || text) {
      const parsed = parseMediaDetails(text);

      const newItem = {
        id: 'i_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        title: parsed.title,
        cleanTitle: parsed.cleanTitle,
        type: parsed.type,
        season: parsed.season,
        episode: parsed.episode,
        file_id: fileId,
        file_type: fileType,
        caption: text,
        createdAt: Date.now()
      };

      db.items.push(newItem);
      saveDB();

      let detailsStr = parsed.type === 'series' 
        ? `📺 סדרה: <b>${parsed.cleanTitle}</b> | עונה ${parsed.season || 1} פרק ${parsed.episode || 1}`
        : `🎬 סרט: <b>${parsed.cleanTitle}</b>`;

      return ctx.replyWithHTML(`⚡ <b>נקלט בהצלחה!</b>\n${detailsStr}`, { disable_notification: true });
    }
  }

  return next();
});

// ==========================================
// 2. מנוע חיפוש מתקדם ותמיכה בעונות/פרקים
// ==========================================

bot.on('message', async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith('/start')) return;

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  let query = text.replace('/search', '').replace('/חיפוש', '').trim().toLowerCase();

  if (!query || query.length < 2) return;

  // חיפוש במאגר
  const results = db.items.filter(i => 
    i.cleanTitle.toLowerCase().includes(query) || 
    i.title.toLowerCase().includes(query) ||
    i.caption.toLowerCase().includes(query)
  );

  if (results.length === 0) {
    if (!isGroup) await ctx.replyWithHTML(`❌ לא נמצאו תוצאות עבור <b>"${query}"</b>.`);
    return;
  }

  // מקבצים את התוצאות לפי שם סדרה/סרט
  const grouped = {};
  results.forEach(item => {
    const key = item.cleanTitle;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  const groupKeys = Object.keys(grouped);

  for (const cleanTitle of groupKeys.slice(0, 5)) {
    const items = grouped[cleanTitle];
    const first = items[0];

    if (first.type === 'series') {
      // אם זו סדרה - מציגים תפריט עונות ופרקים
      if (isGroup) {
        const deepLink = `https://t.me/${botUsername}?start=series_${encodeURIComponent(cleanTitle)}`;
        await ctx.replyWithHTML(
          `🍿 <b>CINEMA STREAM | 📺 סדרה: ${cleanTitle}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `קיימים <b>${items.length}</b> פרקים במאגר.\n` +
          `לחץ למטה לצפייה בעונות ובפרקים בפרטי:`,
          Markup.inlineKeyboard([[Markup.button.url('📺 פתח רשימת עונות ופרקים 🍿', deepLink)]])
        );
      } else {
        await showSeriesMenu(ctx, cleanTitle);
      }
    } else {
      // אם זה סרט
      if (isGroup) {
        const deepLink = `https://t.me/${botUsername}?start=get_${first.id}`;
        await ctx.replyWithHTML(
          `🍿 <b>CINEMA STREAM | 🎬 סרט: ${first.cleanTitle}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `לחץ למטה לקבלת הקובץ בפרטי:`,
          Markup.inlineKeyboard([[Markup.button.url('🎬 קבלת הסרט בפרטי 🍿', deepLink)]])
        );
      } else {
        await sendItemToUser(ctx, first);
      }
    }
  }
});

// הצגת תפריט סדרה (עונות ופרקים)
async function showSeriesMenu(ctx, cleanTitle) {
  const episodes = db.items.filter(i => i.cleanTitle.toLowerCase() === cleanTitle.toLowerCase() && i.type === 'series');

  if (episodes.length === 0) return ctx.reply('❌ לא נמצאו פרקים עבור סדרה זו.');

  // איסוף כל העונות הקיימות
  const seasonsSet = new Set(episodes.map(e => e.season || 1));
  const seasons = Array.from(seasonsSet).sort((a, b) => a - b);

  let buttons = [];

  if (seasons.length === 1) {
    // אם יש רק עונה אחת - מציגים ישירות את הפרקים
    return showSeasonEpisodes(ctx, cleanTitle, seasons[0]);
  }

  // יצירת כפתורים לפי עונות
  seasons.forEach(s => {
    const count = episodes.filter(e => (e.season || 1) === s).length;
    buttons.push([Markup.button.callback(`📺 עונה ${s} (${count} פרקים)`, `sn_${encodeURIComponent(cleanTitle)}_${s}`)]);
  });

  await ctx.replyWithHTML(
    `🍿 <b>CINEMA STREAM | 📺 ${cleanTitle}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `בחר עונה לצפייה:`,
    Markup.inlineKeyboard(buttons)
  );
}

// הצגת פרקים של עונה ספציפית
bot.action(/^sn_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cleanTitle = decodeURIComponent(ctx.match[1]);
  const season = parseInt(ctx.match[2], 10);
  await showSeasonEpisodes(ctx, cleanTitle, season);
});

async function showSeasonEpisodes(ctx, cleanTitle, season) {
  const episodes = db.items
    .filter(i => i.cleanTitle.toLowerCase() === cleanTitle.toLowerCase() && (i.season || 1) === season)
    .sort((a, b) => (a.episode || 0) - (b.episode || 0));

  let buttons = [];
  let row = [];

  episodes.forEach((ep) => {
    const epNum = ep.episode ? `פרק ${ep.episode}` : 'פרק';
    row.push(Markup.button.callback(`▶️ ${epNum}`, `getep_${ep.id}`));
    if (row.length === 2) {
      buttons.push(row);
      row = [];
    }
  });
  if (row.length > 0) buttons.push(row);

  const text = `🍿 <b>${cleanTitle} | עונה ${season}</b>\nבחר פרק לצפייה והורדה:`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else {
    await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
  }
}

// שליחת פרק בודד מתוך בלוק
bot.action(/^getep_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  const item = db.items.find(i => i.id === itemId);
  if (item) await sendItemToUser(ctx, item);
});

// פונקציית שליחת קובץ למשתמש
async function sendItemToUser(ctx, item) {
  const titleStr = item.type === 'series' 
    ? `📺 <b>${item.cleanTitle}</b> | עונה ${item.season || 1} פרק ${item.episode || 1}`
    : `🎬 <b>${item.cleanTitle}</b>`;

  const caption = `🍿 <b>CINEMA STREAM</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📌 ${titleStr}\n━━━━━━━━━━━━━━━━━━━━━━`;

  if (item.file_type === 'video' && item.file_id) {
    return ctx.replyWithVideo(item.file_id, { caption, parse_mode: 'HTML' });
  } else if (item.file_type === 'document' && item.file_id) {
    return ctx.replyWithDocument(item.file_id, { caption, parse_mode: 'HTML' });
  } else if (item.file_type === 'photo' && item.file_id) {
    return ctx.replyWithPhoto(item.file_id, { caption, parse_mode: 'HTML' });
  } else {
    return ctx.replyWithHTML(`${caption}\n\n🔗 ${item.caption}`);
  }
}

// הפעלת הבוט
bot.launch().then(() => console.log('🚀 Ultra-Fast Cinema Bot running!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
