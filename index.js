'use strict';
/**
 * 🍿 Cinema Stream Bot v2
 * דרישות: Node 18+ ,  npm i telegraf express
 *
 * משתני סביבה:
 *   BOT_TOKEN            (חובה)
 *   ADMIN_IDS            מזהי מנהלים מופרדים בפסיק (ברירת מחדל: 8017590244)
 *   DATA_DIR             תיקייה לשמירת המאגר (מומלץ Persistent Disk ב-Render, למשל /data)
 *   BRAND                שם המותג בכיתובים (ברירת מחדל: CINEMA STREAM)
 *   RENDER_EXTERNAL_URL  (Render מגדיר לבד) - לשמירת השרת ער
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==========================================
// הגדרות
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ חסר BOT_TOKEN במשתני הסביבה!');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '8017590244')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BRAND = process.env.BRAND || 'CINEMA STREAM';
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 8;      // תוצאות בעמוד חיפוש
const EP_PAGE = 30;       // פרקים בעמוד
const BACKUP_DELAY = 10 * 60 * 1000; // גיבוי אוטומטי למנהל, 10 דקות אחרי שינוי

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120000 });
let botUsername = '';

// ==========================================
// עזרים
// ==========================================
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const newId = () => 'i_' + crypto.randomBytes(5).toString('hex');
const isAdminId = (id) => ADMIN_IDS.includes(Number(id));
const isAdmin = (ctx) => !!ctx.from && isAdminId(ctx.from.id);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ==========================================
// פענוח שם / עונה / פרק
// ==========================================
const TECH = /\b(?:2160p|1080p|720p|480p|4k|uhd|web-?dl|web-?rip|blu-?ray|brrip|bdrip|hdrip|hdtv|x26[45]|h\.?26[45]|hevc|aac|ac3|dts|10bit|nf|amzn)\b/gi;
const RE_SE = /\bS(\d{1,2})\s*[ ._-]?\s*E(\d{1,3})\b/i;
const RE_X = /\b(\d{1,2})x(\d{2,3})\b/i;
const RE_S = /(?<![\p{L}])(?:עונה|season)\s*(\d{1,2})/iu;
const RE_E = /(?<![\p{L}])(?:פרק|episode|ep)\.?\s*(\d{1,3})/iu;

function parseMedia(text = '', fileName = '') {
  let raw = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!raw && fileName) raw = fileName.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
  raw = raw.replace(/[\p{Extended_Pictographic}\uFE0F\u200d]/gu, ' ').replace(/\s+/g, ' ').trim();
  const full = String(text || '') + '\n' + raw;

  let season = null, episode = null;
  let m;
  if ((m = full.match(RE_SE)) || (m = full.match(RE_X))) {
    season = +m[1]; episode = +m[2];
  } else {
    const s = full.match(RE_S), e = full.match(RE_E);
    if (s) season = +s[1];
    if (e) episode = +e[1];
  }
  const type = season !== null || episode !== null ? 'series' : 'movie';

  // חותכים את הכותרת בנקודה הראשונה שבה מתחילים פרטי עונה/פרק
  let title = raw;
  const idxs = [RE_SE, RE_X, RE_S, RE_E].map((re) => title.search(re)).filter((i) => i >= 0);
  if (idxs.length) {
    const first = Math.min(...idxs);
    if (first > 0) title = title.slice(0, first);
    else title = title.replace(RE_SE, ' ').replace(RE_X, ' ').replace(RE_S, ' ').replace(RE_E, ' ');
  }
  title = title.replace(TECH, ' ').replace(/[\[\]()]/g, ' ').replace(/[-|_:–—]+/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const cleanTitle = title || raw || 'תוכן ללא שם';
  return { title: raw || cleanTitle, cleanTitle, type, season, episode };
}

// ==========================================
// מאגר נתונים (שמירה אטומית + דחיית כתיבות + גיבוי)
// ==========================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'movies_db.json');
const DB_BAK = DB_FILE + '.bak';

let db = { items: [], users: {} };
const seen = new Set(); // file_unique_id למניעת כפילויות

function indexItem(it) {
  it._t = norm(it.cleanTitle);
  it._h = norm(`${it.cleanTitle} ${it.title} ${it.caption}`);
  it._sid = it.type === 'series' ? shortHash(it._t) : null;
  return it;
}

function prepareItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const caption = String(raw.caption || '').trim();
  const baseTitle = String(raw.title || raw.cleanTitle || raw.name || '').trim();
  if (!baseTitle && !caption && !raw.file_id) return null;
  const type = raw.type === 'series' ? 'series' : 'movie';
  const cleanTitle = String(raw.cleanTitle || '').trim() || parseMedia(baseTitle || caption).cleanTitle;
  return indexItem({
    id: raw.id || newId(),
    title: baseTitle || cleanTitle,
    cleanTitle,
    type,
    season: type === 'series' ? Number(raw.season) || 1 : null,
    episode: type === 'series' ? Number(raw.episode) || null : null,
    file_id: raw.file_id || null,
    file_unique_id: raw.file_unique_id || null,
    file_type: raw.file_type || 'text',
    caption,
    createdAt: raw.createdAt || Date.now()
  });
}

function rebuildSeen() {
  seen.clear();
  db.items.forEach((i) => i.file_unique_id && seen.add(i.file_unique_id));
}

function readJsonFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawItems = Array.isArray(j) ? j : j.items || j.movies || [];
  return {
    items: rawItems.map(prepareItem).filter(Boolean),
    users: !Array.isArray(j) && j.users && typeof j.users === 'object' ? j.users : {}
  };
}

function loadDB() {
  for (const f of [DB_FILE, DB_BAK]) {
    if (!fs.existsSync(f)) continue;
    try {
      db = readJsonFile(f);
      rebuildSeen();
      log(`📚 נטענו ${db.items.length} פריטים מ-${path.basename(f)}`);
      return;
    } catch (e) {
      console.error(`שגיאה בקריאת ${f}:`, e.message);
    }
  }
  writeDB();
}

const serialize = () =>
  JSON.stringify({ version: 2, items: db.items, users: db.users }, (k, v) => (k.startsWith('_') ? undefined : v));

function writeDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, serialize(), 'utf8');
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BAK);
  fs.renameSync(tmp, DB_FILE);
}

let dirty = false, saveTimer = null, backupTimer = null;

function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDB, 800);
  if (!backupTimer) {
    backupTimer = setTimeout(async () => {
      backupTimer = null;
      await sendBackup(true);
    }, BACKUP_DELAY);
  }
}

function flushDB() {
  if (!dirty) return;
  try { writeDB(); dirty = false; } catch (e) { console.error('❌ שמירת המאגר נכשלה:', e); }
}

async function sendBackup(silent) {
  if (!db.items.length) return;
  flushDB();
  try {
    await bot.telegram.sendDocument(
      ADMIN_IDS[0],
      { source: Buffer.from(serialize()), filename: `movies_db_${new Date().toISOString().slice(0, 10)}.json` },
      { caption: `💾 גיבוי אוטומטי | ${db.items.length} פריטים`, disable_notification: !!silent }
    );
  } catch (e) { console.error('גיבוי נכשל:', e.message); }
}

loadDB();

// ==========================================
// חיפוש
// ==========================================
const epSort = (a, b) =>
  (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0) || a.createdAt - b.createdAt;

const seriesEpisodes = (sid) => db.items.filter((i) => i.type === 'series' && i._sid === sid).sort(epSort);
const findItem = (id) => db.items.find((i) => i.id === id);

function searchDB(q) {
  const nq = norm(q);
  if (nq.length < 2) return [];
  const tokens = nq.split(' ');
  const groups = new Map();
  for (const it of db.items) {
    if (!tokens.every((t) => it._h.includes(t))) continue;
    const key = it.type === 'series' ? 's:' + it._sid : 'm:' + it.id;
    let g = groups.get(key);
    if (!g) {
      g = { type: it.type, id: it.type === 'series' ? it._sid : it.id, title: it.cleanTitle, count: 0, score: 0 };
      groups.set(key, g);
    }
    g.count++;
    const sc = it._t === nq ? 3 : it._t.startsWith(nq) ? 2 : it._t.includes(nq) ? 1 : 0;
    if (sc > g.score) g.score = sc;
  }
  return [...groups.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'he'));
}

// מטמון תוצאות חיפוש לצורך דפדוף
const queries = new Map();
function saveQuery(q, groups) {
  const id = crypto.randomBytes(4).toString('hex');
  queries.set(id, { q, groups });
  if (queries.size > 500) queries.delete(queries.keys().next().value);
  return id;
}

// ==========================================
// עזרי תצוגה
// ==========================================
async function render(ctx, text, kb) {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb || {}) };
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, extra); }
    catch (e) {
      if (/not modified/i.test(e.description || e.message || '')) return;
    }
  }
  return ctx.reply(text, extra);
}

const groupLabel = (g) => cut(g.type === 'series' ? `📺 ${g.title} (${g.count} פרקים)` : `🎬 ${g.title}`, 60);

async function renderResults(ctx, qid, page) {
  const entry = queries.get(qid);
  const { q, groups } = entry;
  const pages = Math.ceil(groups.length / PAGE_SIZE);
  page = Math.max(0, Math.min(page, pages - 1));
  const slice = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = slice.map((g) => [
    Markup.button.callback(groupLabel(g), g.type === 'series' ? `sr_${g.id}` : `mv_${g.id}`)
  ]);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ הקודם', `pg_${qid}_${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${pages}`, 'noop'));
    if (page < pages - 1) nav.push(Markup.button.callback('הבא ➡️', `pg_${qid}_${page + 1}`));
    rows.push(nav);
  }
  await render(
    ctx,
    `🍿 <b>${esc(BRAND)}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🔎 נמצאו <b>${groups.length}</b> תוצאות עבור "<b>${esc(q)}</b>":`,
    Markup.inlineKeyboard(rows)
  );
}

async function showSeries(ctx, sid) {
  const eps = seriesEpisodes(sid);
  if (!eps.length) return ctx.reply('❌ לא נמצאו פרקים עבור סדרה זו.');
  const seasons = new Map();
  eps.forEach((e) => seasons.set(e.season || 1, (seasons.get(e.season || 1) || 0) + 1));
  if (seasons.size === 1) return showSeason(ctx, sid, [...seasons.keys()][0], 0);

  const btns = [...seasons.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, c]) => Markup.button.callback(`📺 עונה ${s} (${c})`, `sn_${sid}_${s}_0`));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  await render(
    ctx,
    `🍿 <b>${esc(BRAND)} | 📺 ${esc(eps[0].cleanTitle)}</b>\n━━━━━━━━━━━━━━━━━━━━━━\nבחרו עונה:`,
    Markup.inlineKeyboard(rows)
  );
}

async function showSeason(ctx, sid, season, page) {
  const all = seriesEpisodes(sid);
  const eps = all.filter((e) => (e.season || 1) === season);
  if (!eps.length) return ctx.reply('❌ לא נמצאו פרקים בעונה זו.');
  const multiSeasons = new Set(all.map((e) => e.season || 1)).size > 1;
  const pages = Math.ceil(eps.length / EP_PAGE);
  page = Math.max(0, Math.min(page, pages - 1));
  const start = page * EP_PAGE;

  const btns = eps.slice(start, start + EP_PAGE)
    .map((e, i) => Markup.button.callback(`▶️ ${e.episode ?? start + i + 1}`, `ep_${e.id}`));
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `sn_${sid}_${season}_${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${pages}`, 'noop'));
    if (page < pages - 1) nav.push(Markup.button.callback('➡️', `sn_${sid}_${season}_${page + 1}`));
    rows.push(nav);
  }
  if (multiSeasons) rows.push([Markup.button.callback('🔙 לרשימת העונות', `sr_${sid}`)]);

  await render(
    ctx,
    `🍿 <b>${esc(eps[0].cleanTitle)} | עונה ${season}</b>\n${eps.length} פרקים - בחרו פרק:`,
    Markup.inlineKeyboard(rows)
  );
}

// ==========================================
// שליחת פריט למשתמש
// ==========================================
async function sendItem(ctx, item) {
  const label = item.type === 'series'
    ? `📺 <b>${esc(item.cleanTitle)}</b> | עונה ${item.season || 1} פרק ${item.episode ?? '?'}`
    : `🎬 <b>${esc(item.cleanTitle)}</b>`;
  const caption = `🍿 <b>${esc(BRAND)}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📌 ${label}\n━━━━━━━━━━━━━━━━━━━━━━`;

  const rows = [];
  if (item.type === 'series') {
    const sib = seriesEpisodes(item._sid);
    const idx = sib.findIndex((e) => e.id === item.id);
    const nav = [];
    if (sib[idx - 1]) nav.push(Markup.button.callback('⏮ הקודם', `ep_${sib[idx - 1].id}`));
    if (sib[idx + 1]) nav.push(Markup.button.callback('הבא ⏭', `ep_${sib[idx + 1].id}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback('📋 רשימת הפרקים', `sn_${item._sid}_${item.season || 1}_0`)]);
  }
  if (isAdmin(ctx)) rows.push([Markup.button.callback('🗑 מחק פריט (מנהל)', `del_${item.id}`)]);
  const kb = rows.length ? Markup.inlineKeyboard(rows) : {};
  const extra = { caption, parse_mode: 'HTML', ...kb };

  try {
    switch (item.file_type) {
      case 'video': if (item.file_id) return await ctx.replyWithVideo(item.file_id, extra); break;
      case 'document': if (item.file_id) return await ctx.replyWithDocument(item.file_id, extra); break;
      case 'photo': if (item.file_id) return await ctx.replyWithPhoto(item.file_id, extra); break;
      case 'audio': if (item.file_id) return await ctx.replyWithAudio(item.file_id, extra); break;
    }
    return await ctx.reply(cut(`${caption}\n\n🔗 ${esc(item.caption)}`, 4000), {
      parse_mode: 'HTML', disable_web_page_preview: false, ...kb
    });
  } catch (e) {
    console.error('שליחת פריט נכשלה:', item.id, e.description || e.message);
    return ctx.reply('⚠️ לא הצלחתי לשלוח את הקובץ (ייתכן שהוא הוסר). נסו פריט אחר.');
  }
}

// ==========================================
// Middleware כלליים
// ==========================================
bot.catch((err, ctx) => {
  console.error(`❌ שגיאה בעדכון ${ctx?.update?.update_id}:`, err.description || err.message || err);
});

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from && !db.users[ctx.from.id]) {
    db.users[ctx.from.id] = { t: Date.now() };
    markDirty();
  }
  return next();
});

// ==========================================
// תפריט מנהל
// ==========================================
const BTN = {
  stats: '📊 סטטיסטיקה',
  last: '🗂 פריטים אחרונים',
  export: '📥 ייצוא מאגר',
  import: '📁 ייבוא מאגר',
  broadcast: '📢 הודעה לכל המשתמשים',
  wipe: '🗑️ מחיקת כל המאגר',
  cancel: '❌ ביטול'
};

const adminKeyboard = () => Markup.keyboard([
  [BTN.stats, BTN.last],
  [BTN.export, BTN.import],
  [BTN.broadcast, BTN.wipe],
  [BTN.cancel]
]).resize();

const adminState = new Map(); // adminId -> { step, ... }

// ==========================================
// /start
// ==========================================
bot.start(async (ctx) => {
  const payload = (ctx.message.text.split(' ')[1] || '').trim();

  if (payload) {
    if (/^(get_|g_)/.test(payload)) {
      const item = findItem(payload.replace(/^(get_|g_)/, ''));
      return item ? sendItem(ctx, item) : ctx.reply('❌ הפריט המבוקש לא נמצא במאגר.');
    }
    if (payload.startsWith('s_')) return showSeries(ctx, payload.slice(2));
    if (payload.startsWith('series_')) { // תאימות לקישורים ישנים
      let t = payload.slice(7);
      try { t = decodeURIComponent(t); } catch (_) { /* ignore */ }
      return showSeries(ctx, shortHash(norm(t)));
    }
  }

  if (isAdmin(ctx)) {
    return ctx.replyWithHTML(
      `🍿 <b>מערכת ניהול מופעלת</b>\n\n` +
      `⚡ <b>העלאה מהירה:</b> העבירו (Forward) לכאן סרטונים, קבצים או קישורים - הבוט יפענח וישמור אוטומטית, ` +
      `ויסכם בהודעה אחת בסוף.\n\n` +
      `🛠 פקודות: <code>/last</code> • <code>/rename שם ישן | שם חדש</code>`,
      adminKeyboard()
    );
  }
  return ctx.replyWithHTML(
    `🎬 <b>ברוכים הבאים ל${esc(BRAND)}!</b> 🍿\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔍 <b>איך מחפשים?</b>\n• שלחו שם של סרט או סדרה בפרטי.\n` +
    `• בקבוצות: <code>/search שם הסרט</code>`
  );
});

// ==========================================
// פקודות ותפריט מנהל
// ==========================================
bot.hears(BTN.cancel, async (ctx) => {
  if (!isAdmin(ctx)) return;
  adminState.delete(ctx.from.id);
  await ctx.reply('הפעולה בוטלה.', adminKeyboard());
});

bot.hears(BTN.stats, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const movies = db.items.filter((i) => i.type === 'movie').length;
  const eps = db.items.filter((i) => i.type === 'series');
  const uniqueSeries = new Set(eps.map((i) => i._sid)).size;
  await ctx.replyWithHTML(
    `📊 <b>סטטיסטיקה</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎬 סרטים: <b>${movies}</b>\n📺 סדרות: <b>${uniqueSeries}</b>\n🧩 פרקים: <b>${eps.length}</b>\n` +
    `📦 סה"כ פריטים: <b>${db.items.length}</b>\n👥 משתמשים: <b>${Object.keys(db.users).length}</b>`
  );
});

bot.hears(BTN.export, async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!db.items.length) return ctx.reply('המאגר ריק כרגע.');
  flushDB();
  await ctx.replyWithDocument(
    { source: Buffer.from(serialize()), filename: 'movies_db.json' },
    { caption: `📦 המאגר המלא | ${db.items.length} פריטים` }
  );
});

bot.hears(BTN.import, async (ctx) => {
  if (!isAdmin(ctx)) return;
  adminState.set(ctx.from.id, { step: 'AWAIT_JSON' });
  await ctx.reply('שלחו קובץ JSON. הפריטים ימוזגו למאגר הקיים (בלי כפילויות).');
});

bot.hears(BTN.broadcast, async (ctx) => {
  if (!isAdmin(ctx)) return;
  adminState.set(ctx.from.id, { step: 'AWAIT_BROADCAST' });
  await ctx.reply('שלחו את ההודעה שברצונכם לשלוח לכל המשתמשים (טקסט / תמונה / וידאו).');
});

bot.hears(BTN.wipe, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.replyWithHTML(
    `⚠️ <b>למחוק את כל המאגר (${db.items.length} פריטים)?</b>\nלפני המחיקה יישלח אליכם גיבוי.`,
    Markup.inlineKeyboard([[
      Markup.button.callback('🗑 כן, מחק הכל', 'wipe_yes'),
      Markup.button.callback('↩️ ביטול', 'wipe_no')
    ]])
  );
});

async function showLast(ctx) {
  if (!isAdmin(ctx)) return;
  const last = [...db.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  if (!last.length) return ctx.reply('המאגר ריק.');
  const rows = last.map((i) => [Markup.button.callback(
    '🗑 ' + cut(i.type === 'series' ? `${i.cleanTitle} ע${i.season || 1} פ${i.episode ?? '?'}` : i.cleanTitle, 50),
    `del_${i.id}`
  )]);
  await ctx.reply('10 הפריטים האחרונים. לחצו על פריט כדי למחוק אותו:', Markup.inlineKeyboard(rows));
}
bot.command('last', showLast);
bot.hears(BTN.last, showLast);

bot.command('rename', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [oldName, newName] = ctx.message.text.replace(/^\/rename(@\w+)?\s*/i, '').split('|').map((s) => s.trim());
  if (!oldName || !newName) return ctx.reply('שימוש: /rename שם ישן | שם חדש');
  const key = norm(oldName);
  const hits = db.items.filter((i) => i._t === key);
  if (!hits.length) return ctx.reply('❌ לא נמצאו פריטים בשם הזה.');
  hits.forEach((i) => { i.cleanTitle = newName; indexItem(i); });
  markDirty();
  await ctx.reply(`✅ שונה שם ל-${hits.length} פריטים.`);
});

// ==========================================
// Callbacks
// ==========================================
bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action(/^pg_([a-f0-9]+)_(\d+)$/, async (ctx) => {
  if (!queries.has(ctx.match[1])) {
    return ctx.answerCbQuery('החיפוש פג תוקף, חפשו שוב 🔎', { show_alert: true });
  }
  await ctx.answerCbQuery();
  await renderResults(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
});

bot.action(/^sr_([a-f0-9]+)$/, async (ctx) => { await ctx.answerCbQuery(); await showSeries(ctx, ctx.match[1]); });

bot.action(/^sn_([a-f0-9]+)_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showSeason(ctx, ctx.match[1], parseInt(ctx.match[2], 10), parseInt(ctx.match[3], 10));
});

bot.action(/^(?:ep|mv)_(.+)$/, async (ctx) => {
  const item = findItem(ctx.match[1]);
  if (!item) return ctx.answerCbQuery('❌ הפריט לא נמצא', { show_alert: true });
  await ctx.answerCbQuery('שולח...');
  await sendItem(ctx, item);
});

bot.action(/^del_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const idx = db.items.findIndex((i) => i.id === ctx.match[1]);
  if (idx === -1) return ctx.answerCbQuery('כבר נמחק');
  const [removed] = db.items.splice(idx, 1);
  if (removed.file_unique_id) seen.delete(removed.file_unique_id);
  markDirty();
  await ctx.answerCbQuery('🗑 נמחק');
});

bot.action('wipe_no', async (ctx) => { await ctx.answerCbQuery('בוטל'); await ctx.deleteMessage().catch(() => {}); });

bot.action('wipe_yes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await sendBackup(false);
  db.items = [];
  seen.clear();
  markDirty();
  flushDB();
  await ctx.editMessageText('🗑 המאגר נמחק (גיבוי נשלח אליכם).').catch(() => {});
});

bot.action('bc_no', async (ctx) => {
  if (!isAdmin(ctx)) return;
  adminState.delete(ctx.from.id);
  await ctx.answerCbQuery('בוטל');
  await ctx.editMessageText('השליחה בוטלה.').catch(() => {});
});

bot.action('bc_yes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const st = adminState.get(ctx.from.id);
  await ctx.answerCbQuery();
  if (!st || st.step !== 'CONFIRM_BC') return ctx.editMessageText('אין הודעה ממתינה.').catch(() => {});
  adminState.delete(ctx.from.id);
  await ctx.editMessageText('📢 השליחה התחילה, אעדכן בסיומה...').catch(() => {});
  runBroadcast(ctx.from.id, st.chatId, st.msgId).catch((e) => console.error('broadcast:', e));
});

async function runBroadcast(adminId, fromChat, msgId) {
  const ids = Object.keys(db.users);
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try {
      await bot.telegram.copyMessage(uid, fromChat, msgId);
      ok++;
    } catch (e) {
      fail++;
      if (e.response?.error_code === 403) { delete db.users[uid]; markDirty(); }
      if (e.response?.error_code === 429) await sleep((e.response.parameters?.retry_after || 5) * 1000);
    }
    await sleep(50);
  }
  await bot.telegram.sendMessage(adminId, `📢 הסתיים: נשלח ל-${ok} | נכשל ${fail}`);
}

// ==========================================
// קליטה מהירה (מנהל)
// ==========================================
const batches = new Map();

function queueSummary(chatId, res, item) {
  let b = batches.get(chatId);
  if (!b) { b = { added: 0, dup: 0, skipped: 0, lines: [], timer: null }; batches.set(chatId, b); }
  if (res === 'added') {
    b.added++;
    b.lines.push(item.type === 'series'
      ? `📺 ${esc(item.cleanTitle)} | ע${item.season || 1} פ${item.episode ?? '?'}`
      : `🎬 ${esc(item.cleanTitle)}`);
  } else if (res === 'dup') b.dup++;
  else b.skipped++;

  clearTimeout(b.timer);
  b.timer = setTimeout(async () => {
    batches.delete(chatId);
    const shown = b.lines.slice(0, 10).join('\n');
    const more = b.lines.length > 10 ? `\n…ועוד ${b.lines.length - 10}` : '';
    const text = `⚡ <b>נקלטו ${b.added} פריטים</b>` +
      (b.dup ? ` | ♻️ כפולים: ${b.dup}` : '') + (b.skipped ? ` | ⏭ דולגו: ${b.skipped}` : '') +
      (shown ? `\n━━━━━━━━━━━━━━\n${shown}${more}` : '');
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', disable_notification: true }); }
    catch (e) { console.error('summary:', e.message); }
  }, 1500);
}

/** מחזיר true אם ההודעה טופלה כקליטה */
function ingest(ctx) {
  const m = ctx.message;
  const text = m.caption || m.text || '';
  const isFwd = !!(m.forward_origin || m.forward_date || m.forward_from_chat);

  let media = null, fileName = '';
  if (m.video) { media = { type: 'video', f: m.video }; fileName = m.video.file_name; }
  else if (m.document) { media = { type: 'document', f: m.document }; fileName = m.document.file_name; }
  else if (m.audio) { media = { type: 'audio', f: m.audio }; fileName = m.audio.file_name; }
  else if (m.photo?.length) { media = { type: 'photo', f: m.photo[m.photo.length - 1] }; }

  if (!media) {
    // טקסט: נקלט רק אם הועבר וכולל קישור, אחרת זו סתם חיפוש של המנהל
    if (!isFwd || !/(https?:\/\/|t\.me\/)/i.test(text)) return false;
  } else if (media.type === 'photo' && !text) {
    queueSummary(ctx.chat.id, 'skip');
    return true;
  }

  const uid = media?.f.file_unique_id || null;
  if (uid && seen.has(uid)) { queueSummary(ctx.chat.id, 'dup'); return true; }

  const parsed = parseMedia(text, fileName);
  const item = prepareItem({
    ...parsed,
    caption: text,
    file_id: media?.f.file_id || null,
    file_unique_id: uid,
    file_type: media ? media.type : 'text'
  });
  db.items.push(item);
  if (uid) seen.add(uid);
  markDirty();
  queueSummary(ctx.chat.id, 'added', item);
  return true;
}

async function handleImport(ctx) {
  adminState.delete(ctx.from.id);
  try {
    const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    const res = await fetch(link.href);
    const j = await res.json();
    const raw = Array.isArray(j) ? j : j.items || j.movies || [];
    const ids = new Set(db.items.map((i) => i.id));
    let added = 0, dup = 0;
    for (const r of raw) {
      const it = prepareItem(r);
      if (!it) continue;
      if (ids.has(it.id) || (it.file_unique_id && seen.has(it.file_unique_id))) { dup++; continue; }
      db.items.push(it);
      ids.add(it.id);
      if (it.file_unique_id) seen.add(it.file_unique_id);
      added++;
    }
    if (!Array.isArray(j) && j.users) {
      for (const [k, v] of Object.entries(j.users)) if (!db.users[k]) db.users[k] = v;
    }
    if (!added && !dup) return ctx.reply('❌ קובץ JSON ריק או לא תקין.', adminKeyboard());
    markDirty();
    await ctx.reply(`✅ נוספו ${added} פריטים (דולגו ${dup} כפולים).`, adminKeyboard());
  } catch (e) {
    console.error('import:', e);
    await ctx.reply('❌ שגיאה בקריאת קובץ ה-JSON.', adminKeyboard());
  }
}

// ==========================================
// חיפוש משתמשים
// ==========================================
const cooldown = new Map();

async function handleSearch(ctx, text) {
  const isGroup = ctx.chat.type !== 'private';
  const cmdRe = /^\/(?:search|find|חיפוש)(?:@\w+)?(?:\s+|$)/i;
  const explicit = cmdRe.test(text);
  let q = text;
  if (explicit) q = text.replace(cmdRe, '');
  else if (text.startsWith('/')) return;
  q = q.trim();

  if (isGroup && q.length > 60) return;
  if (q.length < 2) {
    if (explicit || !isGroup) await ctx.reply('✍️ כתבו שם של סרט או סדרה (לפחות 2 תווים).');
    return;
  }

  const now = Date.now();
  if (now - (cooldown.get(ctx.from.id) || 0) < 1200) return;
  cooldown.set(ctx.from.id, now);
  if (cooldown.size > 5000) cooldown.clear();

  const groups = searchDB(q);
  if (!groups.length) {
    if (!isGroup || explicit) await ctx.replyWithHTML(`❌ לא נמצאו תוצאות עבור <b>"${esc(q)}"</b>.\nנסו שם קצר יותר או כתיב אחר.`);
    return;
  }

  if (isGroup) {
    const rows = groups.slice(0, 5).map((g) => [Markup.button.url(
      groupLabel(g),
      `https://t.me/${botUsername}?start=${g.type === 'series' ? 's_' : 'g_'}${g.id}`
    )]);
    return ctx.replyWithHTML(
      `🍿 <b>${esc(BRAND)}</b>\n━━━━━━━━━━━━━━━━━━━━━━\nנמצאו <b>${groups.length}</b> תוצאות. לחצו לפתיחה בפרטי:`,
      Markup.inlineKeyboard(rows)
    );
  }

  if (groups.length === 1) {
    const g = groups[0];
    if (g.type === 'series') return showSeries(ctx, g.id);
    const item = findItem(g.id);
    return item ? sendItem(ctx, item) : null;
  }
  const qid = saveQuery(q, groups);
  return renderResults(ctx, qid, 0);
}

// ==========================================
// מטפל הודעות יחיד
// ==========================================
bot.on('message', async (ctx) => {
  const m = ctx.message;

  if (isAdmin(ctx)) {
    const st = adminState.get(ctx.from.id);

    if (st?.step === 'AWAIT_JSON' && m.document) return handleImport(ctx);

    if (st?.step === 'AWAIT_BROADCAST') {
      adminState.set(ctx.from.id, { step: 'CONFIRM_BC', chatId: ctx.chat.id, msgId: m.message_id });
      return ctx.reply(
        `לשלוח את ההודעה שלמעלה ל-${Object.keys(db.users).length} משתמשים?`,
        Markup.inlineKeyboard([[
          Markup.button.callback('✅ שלח', 'bc_yes'),
          Markup.button.callback('❌ בטל', 'bc_no')
        ]])
      );
    }

    if (ingest(ctx)) return;
  }

  if (m.text) return handleSearch(ctx, m.text);
});

// ==========================================
// שרת HTTP (Render) + שמירה על ערנות
// ==========================================
const app = express();
app.get('/', (_req, res) => res.send('⚡ Cinema bot is running'));
app.get('/health', (_req, res) => res.json({ ok: true, items: db.items.length, uptime: process.uptime() }));
const server = app.listen(PORT, () => log(`🌐 HTTP על פורט ${PORT}`));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 10 * 60 * 1000).unref();
}

// ==========================================
// הפעלה וכיבוי מסודר
// ==========================================
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

(async () => {
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    log(`🤖 מחובר: @${botUsername}`);
    await bot.telegram.setMyCommands([{ command: 'search', description: 'חיפוש סרט או סדרה' }]).catch(() => {});
    bot.launch({ dropPendingUpdates: false }).catch((e) => {
      console.error('❌ launch נכשל (בדקו שאין מופע נוסף של הבוט רץ):', e.description || e.message);
      process.exit(1);
    });
  } catch (e) {
    console.error('❌ אתחול נכשל:', e.description || e.message);
    process.exit(1);
  }
})();

function shutdown(sig) {
  log(`⏹ ${sig} - שומר ויוצא`);
  try { flushDB(); } catch (_) { /* ignore */ }
  try { bot.stop(sig); } catch (_) { /* ignore */ }
  server.close();
  setTimeout(() => process.exit(0), 500);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
