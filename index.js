const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// הגדרות בסיס
const ADMIN_ID = 8017590244;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("שגיאה: חסר BOT_TOKEN בהגדרות הסביבה (Environment Variables)");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// שרת בריאות עבור Render
app.get('/', (req, res) => res.send('Bot is active and running!'));
app.listen(PORT, () => console.log(`HTTP Server running on port ${PORT}`));

// ניהול זיכרון ומאגר נתונים בסיסי
const DB_FILE = path.join(__dirname, 'database.json');
let db = {
  quickResponses: {}, // trigger -> { type, content, buttons: [[{text, url}]], scope: 'private'|'public' }
  agents: [],         // [{ photo, name, desc, link }]
  personaConfig: { enabled: false, prompt: "אתה עוזר אדיב ואנושי" }
};

// טעינת נתונים
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error("שגיאה שטעינת בסיס הנתונים, מעלה ברירת מחדל");
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

bot.use(session());

// בדיקת הרשאות מנהל
const isAdmin = (ctx) => ctx.from && Number(ctx.from.id) === ADMIN_ID;

// תפריט מנהל ראשי
function getAdminKeyboard() {
  return Markup.keyboard([
    ['⚡ הוספת תגובה מהירה', '📋 רשימת תגובות'],
    ['🕵️‍♂️ הוספת סוכן', '👥 רשימת סוכנים'],
    ['👷‍♂️ הגדרות דמות / AI', '❌ ביטול תהליך']
  ]).resize();
}

// איפוס סשן
function resetStep(ctx) {
  if (ctx.session) ctx.session.step = null;
}

// --- פקודת להתחלה / מנהל ---
bot.start(async (ctx) => {
  if (isAdmin(ctx)) {
    resetStep(ctx);
    return ctx.reply('שלום המנהל! המוח של הבוט מוכן לניהול. בחר פעולה:', getAdminKeyboard());
  }
  return ctx.reply('שלום! במה אוכל לעזור?');
});

bot.hears('❌ ביטול תהליך', async (ctx) => {
  if (!isAdmin(ctx)) return;
  resetStep(ctx);
  await ctx.reply('התהליך בוטל בהצלחה.', getAdminKeyboard());
});

// ==========================================
// 1. מנגנון תגובות מהירות
// ==========================================

bot.hears('⚡ הוספת תגובה מהירה', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAITING_QR_TRIGGER' };
  await ctx.reply('הזן את מילת המפתח/הטריגר לתגובה המהירה (לדוגמה: "היי" או "מחיר"):');
});

bot.hears('📋 רשימת תגובות', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const keys = Object.keys(db.quickResponses);
  if (keys.length === 0) return ctx.reply('אין כרגע תגובות מהירות מוגדרות.');
  
  let msg = '<b>תגובות מהירות קיימות:</b>\n\n';
  keys.forEach((k) => {
    const item = db.quickResponses[k];
    msg += `• <b>${k}</b> (${item.scope === 'public' ? '🌐 ציבורי' : '🔒 פרטי'}) - סוג: ${item.type}\n`;
  });
  await ctx.replyWithHTML(msg);
});

// ==========================================
// 2. מנגנון סוכנים
// ==========================================

bot.hears('🕵️‍♂️ הוספת סוכן', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAITING_AGENT_PHOTO' };
  await ctx.reply('שלח תמונה עבור הכרטיס של הסוכן/סוכנת:');
});

bot.hears('👥 רשימת סוכנים', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (db.agents.length === 0) return ctx.reply('אין סוכנים מוגדרים במערכת.');

  for (const agent of db.agents) {
    const caption = `<b>${agent.name}</b>\n\n${agent.desc}`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.url('פתיחת פנייה 🚀', agent.link)]]);
    await ctx.replyWithPhoto(agent.photo, { caption, parse_mode: 'HTML', ...keyboard });
  }
});

// ==========================================
// 3. מודול דמות / AI (משתמש/ת 👷‍♂️)
// ==========================================

bot.hears('👷‍♂️ הגדרות דמות / AI', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const status = db.personaConfig.enabled ? 'פעיל ✅' : 'כבוי ❌';
  await ctx.reply(
    `הגדרות דמות/עוזר AI:\nסטטוס נוכחי: ${status}\nפרומפט נוכחי: "${db.personaConfig.prompt}"`,
    Markup.inlineKeyboard([
      [Markup.button.callback(db.personaConfig.enabled ? 'כיבוי מודול AI' : 'הפעלת מודול AI', 'toggle_ai')],
      [Markup.button.callback('שינוי פרומפט דמות', 'change_ai_prompt')]
    ])
  );
});

bot.action('toggle_ai', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.personaConfig.enabled = !db.personaConfig.enabled;
  saveDB();
  await ctx.answerCbQuery('סטטוס AI עודכן!');
  await ctx.editMessageText(`סטטוס מודול AI עודכן ל: ${db.personaConfig.enabled ? 'פעיל ✅' : 'כבוי ❌'}`);
});

bot.action('change_ai_prompt', async (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = { step: 'AWAITING_AI_PROMPT' };
  await ctx.answerCbQuery();
  await ctx.reply('שלח את הנחיית הבסיס (Prompt) עבור הדמות של הבוט:');
});

// ==========================================
// הטיפול המרכזי בכל שלבי ה-Wizard (מנהל)
// ==========================================

bot.on('message', async (ctx, next) => {
  if (!isAdmin(ctx) || !ctx.session || !ctx.session.step) return next();

  const step = ctx.session.step;

  // --- תגובה מהירה: קליטת מילת מפתח ---
  if (step === 'AWAITING_QR_TRIGGER') {
    ctx.session.qrTrigger = ctx.message.text.trim();
    ctx.session.step = 'AWAITING_QR_CONTENT';
    return ctx.reply('מעולה! עכשיו שלח את התוכן של התגובה (טקסט, תמונה, סרטון, קובץ, או הודעה קולית):');
  }

  // --- תגובה מהירה: קליטת תוכן והצגת תצוגה מקדימה ---
  if (step === 'AWAITING_QR_CONTENT') {
    let type = 'text';
    let content = null;

    if (ctx.message.text) {
      type = 'text';
      content = ctx.message.text;
    } else if (ctx.message.photo) {
      type = 'photo';
      content = { file_id: ctx.message.photo[ctx.message.photo.length - 1].file_id, caption: ctx.message.caption || '' };
    } else if (ctx.message.video) {
      type = 'video';
      content = { file_id: ctx.message.video.file_id, caption: ctx.message.caption || '' };
    } else if (ctx.message.document) {
      type = 'document';
      content = { file_id: ctx.message.document.file_id, caption: ctx.message.caption || '' };
    } else if (ctx.message.voice) {
      type = 'voice';
      content = { file_id: ctx.message.voice.file_id, caption: ctx.message.caption || '' };
    } else {
      return ctx.reply('סוג הודעה לא נתמך. אנא שלח טקסט, תמונה, וידאו, קובץ או קול בלבד.');
    }

    ctx.session.qrType = type;
    ctx.session.qrContent = content;
    ctx.session.qrButtons = [];

    return sendQRPreviewAndPromptButtons(ctx);
  }

  // --- תגובה מהירה: קליטת טקסט לכפתור ---
  if (step === 'AWAITING_BTN_TEXT') {
    ctx.session.tempBtnText = ctx.message.text;
    ctx.session.step = 'AWAITING_BTN_URL';
    return ctx.reply('שלח כעת את הקישור (URL) עבור הכפתור (לדוגמה: https://t.me/...):');
  }

  // --- תגובה מהירה: קליטת URL לכפתור ---
  if (step === 'AWAITING_BTN_URL') {
    const url = ctx.message.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return ctx.reply('קישור לא תקין. אנא שלח קישור המתחיל ב-http:// או https://');
    }

    ctx.session.qrButtons.push([{ text: ctx.session.tempBtnText, url: url }]);
    delete ctx.session.tempBtnText;

    return sendQRPreviewAndPromptButtons(ctx);
  }

  // --- סוכנים: תמונה ---
  if (step === 'AWAITING_AGENT_PHOTO') {
    if (!ctx.message.photo) return ctx.reply('אנא שלח תמונה תקינה.');
    ctx.session.agentPhoto = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    ctx.session.step = 'AWAITING_AGENT_NAME';
    return ctx.reply('הזן את שם הסוכן/סוכנת:');
  }

  // --- סוכנים: שם ---
  if (step === 'AWAITING_AGENT_NAME') {
    ctx.session.agentName = ctx.message.text;
    ctx.session.step = 'AWAITING_AGENT_DESC';
    return ctx.reply('הזן תיאור קצר עבור הסוכן/סוכנת:');
  }

  // --- סוכנים: תיאור ---
  if (step === 'AWAITING_AGENT_DESC') {
    ctx.session.agentDesc = ctx.message.text;
    ctx.session.step = 'AWAITING_AGENT_LINK';
    return ctx.reply('הזן קישור לפנייה ישירה לסוכן (לדוגמה: https://t.me/username):');
  }

  // --- סוכנים: קישור וסיום ---
  if (step === 'AWAITING_AGENT_LINK') {
    const link = ctx.message.text.trim();
    db.agents.push({
      photo: ctx.session.agentPhoto,
      name: ctx.session.agentName,
      desc: ctx.session.agentDesc,
      link: link
    });
    saveDB();
    resetStep(ctx);
    return ctx.reply('הסוכן נוצר ונשמר בהצלחה!', getAdminKeyboard());
  }

  // --- AI Prompt ---
  if (step === 'AWAITING_AI_PROMPT') {
    db.personaConfig.prompt = ctx.message.text;
    saveDB();
    resetStep(ctx);
    return ctx.reply('פרומפט הדמות עודכן בהצלחה!', getAdminKeyboard());
  }

  return next();
});

// הצגת תצוגה מקדימה ובחירת כפתורים
async function sendQRPreviewAndPromptButtons(ctx) {
  await ctx.reply('<b>--- תצוגה מקדימה ---</b>', { parse_mode: 'HTML' });
  await sendMediaMessage(ctx, ctx.chat.id, ctx.session.qrType, ctx.session.qrContent, ctx.session.qrButtons);

  ctx.session.step = 'AWAITING_BTN_DECISION';

  return ctx.reply(
    'תוכל להוסיף כפתור אינליין או להתקדם לבחירת הגדרת הפרטיות:',
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ הוסף כפתור קישור', 'add_inline_btn')],
      [Markup.button.callback('✅ המשך לבחירת היקף (פרטי/ציבורי)', 'finish_buttons')]
    ])
  );
}

// Inline Callback Actions עבור תהליך התגובה המהירה
bot.action('add_inline_btn', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session.step = 'AWAITING_BTN_TEXT';
  await ctx.reply('הזן את הטקסט שיופיע על הכפתור:');
});

bot.action('finish_buttons', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session.step = 'AWAITING_SCOPE';
  await ctx.reply(
    'בחר היכן התגובה המהירה תפעל:\n\n' +
    '• <b>פרטי</b>: תפעל רק בצ'אט פרטי מול הבוט.\n' +
    '• <b>ציבורי</b>: תפעל גם בתוך קבוצות.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔒 פרטי בלבד', 'scope_private')],
        [Markup.button.callback('🌐 ציבורי (גם בקבוצות)', 'scope_public')]
      ])
    }
  );
});

bot.action(/^scope_(private|public)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const scope = ctx.match[1];
  await ctx.answerCbQuery();

  const trigger = ctx.session.qrTrigger;
  db.quickResponses[trigger] = {
    type: ctx.session.qrType,
    content: ctx.session.qrContent,
    buttons: ctx.session.qrButtons || [],
    scope: scope
  };

  saveDB();
  resetStep(ctx);

  await ctx.reply(`התגובה המהירה עבור "${trigger}" נשמרה בהצלחה! (${scope === 'public' ? '🌐 ציבורי' : '🔒 פרטי'})`, getAdminKeyboard());
});

// ==========================================
// 4. מנגנון מענה למשתמשים בקבוצות ובפרטי
// ==========================================

bot.on('message', async (ctx) => {
  const text = ctx.message.text || ctx.message.caption;
  if (!text) return;

  const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'
  const isPrivate = chatType === 'private';

  // חיפוש תגובה מהירה תואמת
  const matchedKey = Object.keys(db.quickResponses).find(k => text.trim().toLowerCase() === k.toLowerCase());

  if (matchedKey) {
    const item = db.quickResponses[matchedKey];

    // בדיקת הרשאת פרטי / ציבורי
    if (item.scope === 'private' && !isPrivate) {
      return; // התגובה מוגדרת לפרטי בלבד וההודעה נשלחה בקבוצה
    }

    return sendMediaMessage(ctx, ctx.chat.id, item.type, item.content, item.buttons);
  }

  // אם לא נמצאה תגובה מהירה ומודול ה-AI פעיל
  if (db.personaConfig.enabled && isPrivate) {
    await ctx.sendChatAction('typing');
    // כאן מתחברים למודול AI/עוזר (ניתן לחבר OpenAI / Gemini במידת הצורך)
    const replyText = `[תגובת AI - דמות]: קיבלתי את ההודעה "${text}". (הפרומפט מוגדר כ: ${db.personaConfig.prompt})`;
    return ctx.reply(replyText);
  }
});

// פונקציית עזר לשליחת מדיה עם כפתורים
async function sendMediaMessage(ctx, chatId, type, content, buttons = []) {
  const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined;

  switch (type) {
    case 'text':
      return ctx.telegram.sendMessage(chatId, content, keyboard);
    case 'photo':
      return ctx.telegram.sendPhoto(chatId, content.file_id, { caption: content.caption, ...keyboard });
    case 'video':
      return ctx.telegram.sendVideo(chatId, content.file_id, { caption: content.caption, ...keyboard });
    case 'document':
      return ctx.telegram.sendDocument(chatId, content.file_id, { caption: content.caption, ...keyboard });
    case 'voice':
      return ctx.telegram.sendVoice(chatId, content.file_id, { caption: content.caption, ...keyboard });
  }
}

bot.launch().then(() => console.log('Bot is running successfully!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
