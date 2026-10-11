'use strict';
/**
 * 🍿 Cinema Stream Bot v5
 * דרישות: Node 18+ ,  npm i telegraf@4 express
 *
 * משתני סביבה (הכול אופציונלי חוץ מ-BOT_TOKEN):
 *   BOT_TOKEN            (חובה)
 *   ADMIN_IDS            מזהי מנהלים מופרדים בפסיק (ברירת מחדל: 8017590244)
 *   CHANNEL_URL          קישור הערוץ (ברירת מחדל: https://t.me/ask_movie_MT)
 *   BRAND                שם המותג (ברירת מחדל: CINEMA STREAM)
 *   FORCE_SUB            "1" = חובת הצטרפות לערוץ לפני צפייה (הבוט חייב להיות מנהל בערוץ)
 *   DATA_DIR             תיקייה לשמירת המאגר (Persistent Disk ב-Render, למשל /data)
 *   PREMIUM_EMOJI        "0" לכיבוי אימוג'ים פרימיום
 *   PE_BRAND / PE_MOVIE / PE_SERIES   החלפת מזהי האימוג'ים הפרימיום
 *   RENDER_EXTERNAL_URL  (Render מגדיר לבד)
 */

const { Telegraf, Markup, Telegram } = require('telegraf');
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
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/ask_movie_MT';
const CHANNEL_USER = '@' + CHANNEL_URL.replace(/\/+$/, '').split('/').pop();
const FORCE_SUB = process.env.FORCE_SUB === '1';
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 8;
const EP_PAGE = 30;
const BACKUP_DELAY = 2 * 60 * 1000;
const PREMIUM = process.env.PREMIUM_EMOJI !== '0';

// הגדרות שמנהל משנה מתוך הבוט (⚙️ הגדרות)
// delSec: מחיקת הקבצים שנשלחו למשתמש (0 = כבוי)
// grpSec: מחיקת הודעת "נמצאו תוצאות" בקבוצה + הודעת המשתמש (0 = כבוי). תוצאות החיפוש עצמן לא נמחקות לעולם.
const SETTINGS_VER = 5;
const DEFAULT_SETTINGS = { v: SETTINGS_VER, delSec: 0, grpSec: 20, protect: false };
const DEL_OPTS = [0, 30, 60, 120, 300, 600];
const GRP_OPTS = [0, 10, 20, 30, 60];

// ==========================================
// אימוג'ים פרימיום
// ==========================================
const PE = {
  brand:  { id: process.env.PE_BRAND  || '5371081166013078244', f: '🍿' },
  movie:  { id: process.env.PE_MOVIE  || '5375464961822695044', f: '🎬' },
  series: { id: process.env.PE_SERIES || '5449505950283078474', f: '📺' }
};
const pe = (k) => `<tg-emoji emoji-id="${PE[k].id}">${PE[k].f}</tg-emoji>`;
const stripPE = (s) =>
  typeof s === 'string' ? s.replace(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g, '$1') : s;
const stripPayload = (p) => {
  if (!p || typeof p !== 'object') return p;
  const o = { ...p };
  for (const k of ['text', 'caption']) if (k in o) o[k] = stripPE(o[k]);
  return o;
};
const hasPE = (p) => !!p && /<tg-emoji/.test(String(p.text || '') + String(p.caption || ''));

// אם האימוג'ים הפרימיום נדחים, שולחים שוב עם אימוג'י רגיל
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method, payload, ...rest) {
  if (!PREMIUM) payload = stripPayload(payload);
  try {
    return await origCallApi.call(this, method, payload, ...rest);
  } catch (e) {
    if (PREMIUM && hasPE(payload) && /emoji|entit/i.test(e.description || e.message || '')) {
      return origCallApi.call(this, method, stripPayload(payload), ...rest);
    }
    throw e;
  }
};

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 120000 });
let botUsername = '';

// ==========================================
// עזרים
// ==========================================
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const newId = () => 'i_' + crypto.randomBytes(5).toString('hex');
const isAdminId = (id) => ADMIN_IDS.includes(Number(id));
const isAdmin = (ctx) => !!ctx.from && isAdminId(ctx.from.id);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const nextOf = (arr, v) => arr[(Math.max(0, arr.indexOf(v)) + 1) % arr.length];
const fmtSec = (n) => {
  if (!n) return 'כבוי';
  if (n >= 60 && n % 60 === 0) return n === 60 ? 'דקה' : `${n / 60} דקות`;
  return `${n} שניות`;
};

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '')
  .replace(/[ךםןףץ]/g, (c) => FINALS[c])
  .replace(/[׳'`´’‘"״”“]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const normLegacy = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ==========================================
// רשימה שחורה
// ==========================================
let blRe = null;

function rebuildBL() {
  const ps = (db.blacklist || []).map((p) => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!ps.length) { blRe = null; return; }
  const body = ps.map((p) => p.split(/\s+/).map(escRe).join('[\\s._\\-|]*')).join('|');
  blRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'giu');
}

function stripBL(text) {
  text = String(text ?? '');
  if (!blRe) return text;
  const parts = text.split(/((?:https?:\/\/|t\.me\/)\S+)/gi);
  const replaced = parts.map((p, i) => (i % 2 ? p : p.replace(blRe, ' '))).join('');
  if (replaced === text) return text;
  return replaced.split('\n').map((l) => l
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]*[-|:–—•·,.]+[ \t]*/, '')
    .replace(/[ \t]*[-|:–—•·,]+[ \t]*$/, '')
    .trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ==========================================
// פענוח שם / עונה / פרק
// ==========================================
const TECH = /\b(?:2160p|1080p|720p|480p|4k|uhd|web-?dl|web-?rip|blu-?ray|brrip|bdrip|hdrip|hdtv|x26[45]|h\.?26[45]|hevc|aac|ac3|dts|10bit|nf|amzn)\b/gi;
const RE_SE = /(?<![\p{L}\p{N}])S(\d{1,2})\s*[ ._-]?\s*E(\d{1,3})(?![\p{N}])/iu;
const RE_X = /(?<![\p{L}\p{N}])(\d{1,2})x(\d{1,3})(?![\p{L}\p{N}])/iu;
const RE_S = /(?<![\p{L}\p{N}])(?:עונה|עונת|season|ע)\s*[.:'׳]?\s*(\d{1,2})(?![\p{N}])/iu;
const RE_S_LAT = /(?<![\p{L}\p{N}])s(\d{1,2})(?![\p{L}\p{N}])/iu;
const RE_E = /(?<![\p{L}])(?:פרק|episode|ep|פ|e)\s*[.:'׳]?\s*(\d{1,3})(?![\p{N}])/iu;
const ALL_RE = [RE_SE, RE_X, RE_S, RE_S_LAT, RE_E];

function extractSE(s) {
  s = String(s || '');
  let m;
  if ((m = s.match(RE_SE)) || (m = s.match(RE_X))) return { season: +m[1], episode: +m[2] };
  const ms = s.match(RE_S) || s.match(RE_S_LAT);
  const me = s.match(RE_E);
  return { season: ms ? +ms[1] : null, episode: me ? +me[1] : null };
}

function cutAtMarkers(s) {
  const idxs = ALL_RE.map((re) => s.search(re)).filter((i) => i >= 0);
  if (!idxs.length) return s;
  const first = Math.min(...idxs);
  if (first > 0) return s.slice(0, first);
  let t = s;
  ALL_RE.forEach((re) => { t = t.replace(re, ' '); });
  return t;
}

const cleanLine = (l) => stripBL(l)
  .replace(/https?:\/\/\S+|t\.me\/\S+/gi, ' ')
  .replace(/[@#]\S+/g, ' ')
  .replace(/[\p{Extended_Pictographic}\uFE0F\u200d\u200e\u200f]/gu, ' ')
  .replace(/\s+/g, ' ').trim();

const trimSeps = (s) => s.replace(/^[\s\-|:–—•·,.]+|[\s\-|:–—•·,.]+$/g, '').trim();

function parseMedia(text = '', fileName = '') {
  text = stripBL(text);
  const lines = String(text).split('\n').map(cleanLine).filter(Boolean);
  let raw = lines[0] || '';
  if (!raw && fileName) raw = cleanLine(fileName.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' '));

  const pick = (...srcs) => {
    for (const s of srcs) {
      const r = extractSE(s);
      if (r.season !== null || r.episode !== null) return r;
    }
    return { season: null, episode: null };
  };
  const { season, episode } = pick(raw, text, fileName);
  const type = season !== null || episode !== null ? 'series' : 'movie';

  let title = type === 'series' ? cutAtMarkers(raw) : raw;
  title = title.replace(TECH, ' ').replace(/[\[\]()]/g, ' ').replace(/_/g, ' ')
    .replace(/\s+[-|:–—•]+\s+/g, ' ').replace(/\s+/g, ' ');
  title = trimSeps(title);

  const cleanTitle = title || raw || 'תוכן ללא שם';
  return { title: raw || cleanTitle, cleanTitle, type, season, episode };
}

// ==========================================
// מאגר נתונים
// ==========================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'movies_db.json');
const DB_BAK = DB_FILE + '.bak';

let db = { items: [], users: {}, blacklist: [], settings: { ...DEFAULT_SETTINGS }, pending: [] };
const seen = new Set();

function indexItem(it) {
  it._t = norm(it.cleanTitle);
  it._tok = it._t.split(' ').filter(Boolean);
  it._cap = norm(`${it.title} ${it.caption}`);
  it._sid = it.type === 'series' ? shortHash(it._t) : null;
  it._sidL = it.type === 'series' ? shortHash(normLegacy(it.cleanTitle)) : null;
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
    views: Number(raw.views) || 0,
    createdAt: raw.createdAt || Date.now()
  });
}

function rebuildSeen() {
  seen.clear();
  db.items.forEach((i) => i.file_unique_id && seen.add(i.file_unique_id));
}

function readJsonFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const isObj = !Array.isArray(j);
  const rawItems = isObj ? j.items || j.movies || [] : j;
  const bl = isObj && Array.isArray(j.blacklist) ? j.blacklist.filter((x) => typeof x === 'string') : [];
  db.blacklist = bl; rebuildBL();
  const settings = { ...DEFAULT_SETTINGS, ...(isObj && j.settings && typeof j.settings === 'object' ? j.settings : {}) };
  // מעבר לגרסה 5: מחיקת קבצים כבויה כברירת מחדל, ותוצאות חיפוש אף פעם לא נמחקות
  if (settings.v !== SETTINGS_VER) { settings.v = SETTINGS_VER; settings.delSec = 0; settings.grpSec = 20; }
  return {
    items: rawItems.map(prepareItem).filter(Boolean),
    users: isObj && j.users && typeof j.users === 'object' ? j.users : {},
    blacklist: bl,
    settings,
    pending: isObj && Array.isArray(j.pending) ? j.pending.filter((p) => p && p.c && p.m && p.at) : []
  };
}

function loadDB() {
  for (const f of [DB_FILE, DB_BAK]) {
    if (!fs.existsSync(f)) continue;
    try {
      db = readJsonFile(f);
      rebuildBL();
      rebuildSeen();
      // ביטול מחיקות ממתינות ישנות (מגרסה קודמת) - הן עלולות למחוק תוצאות חיפוש
      db.pending = [];
      log(`📚 נטענו ${db.items.length} פריטים מ-${path.basename(f)}`);
      return;
    } catch (e) {
      console.error(`שגיאה בקריאת ${f}:`, e.message);
    }
  }
  writeDB();
}

const serialize = () =>
  JSON.stringify(
    { version: 5, items: db.items, users: db.users, blacklist: db.blacklist, settings: db.settings, pending: db.pending },
    (k, v) => (k.startsWith('_') ? undefined : v)
  );

function writeDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, serialize(), 'utf8');
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BAK);
  fs.renameSync(tmp, DB_FILE);
}

let dirty = false, saveTimer = null, backupTimer = null;

/** quiet=true: שומר לדיסק אבל לא מפעיל גיבוי אוטומטי למנהל */
function markDirty(quiet) {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDB, 800);
  if (!quiet && !backupTimer) {
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
// מחיקה אוטומטית של הודעות זמניות בלבד (שורדת הפעלה מחדש)
// משמש רק ל: הודעת "נמצאו תוצאות" בקבוצה, הודעת המשתמש שחיפש, וקבצים (אם הופעל בהגדרות)
// תוצאות חיפוש, רשימות עונות ופרקים - לעולם לא נמחקים
// ==========================================
function scheduleDelete(chatId, msgId, sec) {
  if (!chatId || !msgId || !sec) return;
  db.pending.push({ c: chatId, m: msgId, at: Date.now() + sec * 1000 });
  markDirty(true);
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const due = db.pending.filter((p) => p.at <= now);
    if (!due.length) return;
    db.pending = db.pending.filter((p) => p.at > now);
    markDirty(true);
    for (const p of due) {
      await bot.telegram.deleteMessage(p.c, p.m).catch(() => {});
      await sleep(35);
    }
  } finally { sweeping = false; }
}
setInterval(() => sweep().catch(() => {}), 3000).unref();

/** אחרי שליחת קובץ למשתמש (רק אם מחיקת קבצים מופעלת בהגדרות) */
async function autoClean(ctx, sent) {
  const sec = db.settings.delSec;
  if (!sec || !sent) return;
  const chat = ctx.chat.id;
  scheduleDelete(chat, sent.message_id, sec);
  const n = await ctx.reply(
    `⏳ <b>הקובץ יימחק בעוד ${fmtSec(sec)}</b>\n💡 העבירו אותו להודעות שמורות כדי לשמור.`,
    { parse_mode: 'HTML' }
  ).catch(() => null);
  if (!n) return;
  scheduleDelete(chat, n.message_id, sec);
  const edit = (ms, text) => setTimeout(
    () => ctx.telegram.editMessageText(chat, n.message_id, undefined, text, { parse_mode: 'HTML' }).catch(() => {}),
    ms
  ).unref();
  if (sec >= 30) {
    edit(sec * 500, `⚠️ <b>נשארו ${fmtSec(Math.round(sec / 2))} עד למחיקת הקובץ</b>`);
    edit((sec - 10) * 1000, `🔥 <b>10 שניות אחרונות!</b>`);
  }
}

// ==========================================
// ניהול רשימה שחורה
// ==========================================
function cleanExisting() {
  let n = 0;
  for (const it of db.items) {
    const c = stripBL(it.caption), t = stripBL(it.title), ct = stripBL(it.cleanTitle);
    if (c !== it.caption || t !== it.title || ct !== it.cleanTitle) {
      it.caption = c;
      it.cleanTitle = ct || it.cleanTitle;
      it.title = t || ct || it.title;
      indexItem(it);
      n++;
    }
  }
  return n;
}

function addBlacklist(list) {
  const have = new Set(db.blacklist.map(norm));
  const added = [];
  for (const raw of list) {
    const p = String(raw).trim().replace(/\s+/g, ' ');
    if (p.length < 2 || have.has(norm(p))) continue;
    db.blacklist.push(p);
    have.add(norm(p));
    added.push(p);
  }
  let cleaned = 0;
  if (added.length) { rebuildBL(); cleaned = cleanExisting(); markDirty(); }
  return { added, cleaned };
}

// ==========================================
// חיפוש חכם
// ==========================================
const epSort = (a, b) =>
  (a.season || 1) - (b.season || 1) ||
  (a.episode ?? 1e9) - (b.episode ?? 1e9) ||
  a.createdAt - b.createdAt;

function resolveSid(sid) {
  const it = db.items.find((i) => i.type === 'series' && (i._sid === sid || i._sidL === sid));
  return it ? it._sid : sid;
}
const seriesEpisodes = (sid) => {
  const real = resolveSid(sid);
  return db.items.filter((i) => i.type === 'series' && i._sid === real).sort(epSort);
};
const findItem = (id) => db.items.find((i) => i.id === id);

const STOP = new Set(['סרט', 'סדרה', 'הסרט', 'הסדרה', 'סרטים', 'סדרות', 'של', 'movie', 'film', 'series']);

function tokScore(qt, it) {
  let best = 0;
  for (const t of it._tok) {
    let s = 0;
    if (t === qt) s = 3;
    else if (qt.length >= 2 && t.startsWith(qt)) s = 2.2;
    else if (qt.length >= 3 && t.includes(qt)) s = 1.5;
    else if (qt.length >= 4 && Math.abs(t.length - qt.length) <= 2 &&
      lev(t, qt) <= (qt.length >= 7 ? 2 : 1)) s = 1.1;
    if (s > best) best = s;
    if (best === 3) break;
  }
  if (!best && qt.length >= 3 && it._cap.includes(qt)) best = 0.6;
  return best;
}

function searchDB(q) {
  let qt = norm(q).split(' ').filter(Boolean);
  const filtered = qt.filter((t) => !STOP.has(t));
  if (filtered.length) qt = filtered;
  const nqt = qt.join(' ');
  if (nqt.length < 2) return [];

  const run = (maxMiss) => {
    const groups = new Map();
    for (const it of db.items) {
      let total = 0, miss = 0;
      for (const t of qt) {
        const s = tokScore(t, it);
        if (!s) { if (++miss > maxMiss) break; } else total += s;
      }
      if (miss > maxMiss || miss === qt.length) continue;
      let score = total / qt.length - miss * 0.8;
      if (it._t === nqt) score += 4;
      else if (it._t.startsWith(nqt)) score += 2;
      else if (it._t.includes(nqt)) score += 1;

      const key = it.type === 'series' ? 's:' + it._sid : 'm:' + it.id;
      let g = groups.get(key);
      if (!g) {
        g = { type: it.type, id: it.type === 'series' ? it._sid : it.id, title: it.cleanTitle, count: 0, score: 0 };
        groups.set(key, g);
      }
      g.count++;
      if (score > g.score) g.score = score;
    }
    return [...groups.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'he'));
  };

  let res = run(0);
  if (!res.length && qt.length >= 3) res = run(1);
  return res;
}

const groupKey = (it) => (it.type === 'series' ? 's:' + it._sid : 'm:' + it.id);
const seriesCount = (sid) => db.items.filter((x) => x._sid === sid).length;

function latestGroups(limit = 24) {
  const sorted = [...db.items].sort((a, b) => b.createdAt - a.createdAt);
  const keys = new Set(), out = [];
  for (const it of sorted) {
    const key = groupKey(it);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({
      type: it.type, id: it.type === 'series' ? it._sid : it.id, title: it.cleanTitle,
      count: it.type === 'series' ? seriesCount(it._sid) : 1, score: 0
    });
    if (out.length >= limit) break;
  }
  return out;
}

function topGroups(limit = 24) {
  const m = new Map();
  for (const it of db.items) {
    if (!(it.views > 0)) continue;
    const key = groupKey(it);
    let g = m.get(key);
    if (!g) {
      g = { type: it.type, id: it.type === 'series' ? it._sid : it.id, title: it.cleanTitle, count: 1, views: 0, score: 0 };
      m.set(key, g);
    }
    g.views += it.views;
  }
  const out = [...m.values()].sort((a, b) => b.views - a.views).slice(0, limit);
  out.forEach((g) => { if (g.type === 'series') g.count = seriesCount(g.id); });
  return out;
}

const queries = new Map();
function saveQuery(q, groups, title) {
  const id = crypto.randomBytes(4).toString('hex');
  queries.set(id, { q, groups, title });
  if (queries.size > 500) queries.delete(queries.keys().next().value);
  return id;
}

const requests = new Map();
const reqCool = new Map();
function newReq(q, user) {
  const id = crypto.randomBytes(4).toString('hex');
  requests.set(id, { q, user });
  if (requests.size > 300) requests.delete(requests.keys().next().value);
  return id;
}

// ==========================================
// עזרי תצוגה (עריכת הודעות)
// ==========================================
/** אם יש הודעת "מחפש..." פעילה - עורכים אותה לתוצאה; אם זו לחיצה על כפתור - עורכים את ההודעה */
async function render(ctx, text, kb) {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb || {}) };
  const t = ctx.state && ctx.state.target;
  if (t) {
    ctx.state.target = null;
    try { return await ctx.telegram.editMessageText(t.chat_id, t.message_id, undefined, text, extra); }
    catch (e) {
      if (/not modified/i.test(e.description || e.message || '')) return;
    }
  } else if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, extra); }
    catch (e) {
      if (/not modified/i.test(e.description || e.message || '')) return;
    }
  }
  return ctx.reply(text, extra);
}

async function dropTarget(ctx) {
  const t = ctx.state && ctx.state.target;
  if (!t) return;
  ctx.state.target = null;
  await ctx.telegram.deleteMessage(t.chat_id, t.message_id).catch(() => {});
}

const HR = '━━━━━━━━━━━━━━━━━━━━━━';
const header = () => `${pe('brand')} <a href="${CHANNEL_URL}"><b>${esc(BRAND)}</b></a>\n${HR}`;
const groupLabel = (g) => cut(g.type === 'series' ? `📺 ${g.title} (${g.count} פרקים)` : `🎬 ${g.title}`, 60);

async function renderResults(ctx, qid, page) {
  const { q, groups, title } = queries.get(qid);
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
  const line = title
    ? `${title} (<b>${groups.length}</b>):`
    : `🔎 נמצאו <b>${groups.length}</b> תוצאות עבור "<b>${esc(q)}</b>":`;
  await render(ctx, `${header()}\n${line}`, Markup.inlineKeyboard(rows));
}

async function showSeries(ctx, sid) {
  const eps = seriesEpisodes(sid);
  if (!eps.length) return render(ctx, '❌ לא נמצאו פרקים עבור סדרה זו.');
  const real = eps[0]._sid;
  const seasons = new Map();
  eps.forEach((e) => seasons.set(e.season || 1, (seasons.get(e.season || 1) || 0) + 1));
  if (seasons.size === 1) return showSeason(ctx, real, [...seasons.keys()][0], 0);

  const btns = [...seasons.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, c]) => Markup.button.callback(`📺 עונה ${s} (${c})`, `sn_${real}_${s}_0`));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  await render(
    ctx,
    `${header()}\n${pe('series')} <b>${esc(eps[0].cleanTitle)}</b>\nבחרו עונה:`,
    Markup.inlineKeyboard(rows)
  );
}

async function showSeason(ctx, sid, season, page) {
  const all = seriesEpisodes(sid);
  const eps = all.filter((e) => (e.season || 1) === season);
  if (!eps.length) return render(ctx, '❌ לא נמצאו פרקים בעונה זו.');
  const real = all[0]._sid;
  const multiSeasons = new Set(all.map((e) => e.season || 1)).size > 1;
  const pages = Math.ceil(eps.length / EP_PAGE);
  page = Math.max(0, Math.min(page, pages - 1));
  const start = page * EP_PAGE;

  const counter = new Map(), ver = new Map();
  eps.forEach((e) => {
    if (e.episode == null) return;
    const c = (counter.get(e.episode) || 0) + 1;
    counter.set(e.episode, c);
    ver.set(e.id, c);
  });

  const btns = eps.slice(start, start + EP_PAGE).map((e, i) => {
    const n = e.episode ?? start + i + 1;
    const v = ver.get(e.id) > 1 ? `·${ver.get(e.id)}` : '';
    return Markup.button.callback(`▶️ ${n}${v}`, `ep_${e.id}`);
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️', `sn_${real}_${season}_${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${pages}`, 'noop'));
    if (page < pages - 1) nav.push(Markup.button.callback('➡️', `sn_${real}_${season}_${page + 1}`));
    rows.push(nav);
  }
  if (multiSeasons) rows.push([Markup.button.callback('🔙 לרשימת העונות', `sr_${real}`)]);

  await render(
    ctx,
    `${header()}\n${pe('series')} <b>${esc(eps[0].cleanTitle)}</b> | עונה ${season}\n${eps.length} פרקים - בחרו פרק:`,
    Markup.inlineKeyboard(rows)
  );
}

async function openEpisode(ctx, sid, season, episode) {
  const all = seriesEpisodes(sid);
  if (!all.length) return render(ctx, '❌ לא נמצאו פרקים עבור סדרה זו.');
  const real = all[0]._sid;
  const s = season ?? 1;
  if (episode == null) return showSeason(ctx, real, s, 0);
  const hit = all.find((e) => (e.season || 1) === s && e.episode === episode);
  if (hit) return sendItem(ctx, hit);
  await dropTarget(ctx);
  await ctx.replyWithHTML(
    `❌ ${pe('series')} <b>${esc(all[0].cleanTitle)}</b> | עונה ${s} פרק ${episode} עדיין לא קיים במאגר.\nהנה מה שכן יש:`
  );
  return showSeries(ctx, real);
}

// ==========================================
// חובת הצטרפות לערוץ (אופציונלי)
// ==========================================
async function subscribed(ctx) {
  if (!FORCE_SUB || isAdmin(ctx) || !ctx.from) return true;
  try {
    const m = await ctx.telegram.getChatMember(CHANNEL_USER, ctx.from.id);
    return !['left', 'kicked'].includes(m.status);
  } catch (e) { return true; } // אם הבוט לא מנהל בערוץ - לא חוסמים
}

async function needSub(ctx, item) {
  if (await subscribed(ctx)) return false;
  await ctx.replyWithHTML(
    `${header()}\n🔒 כדי לצפות בתוכן יש להצטרף קודם לערוץ שלנו:`,
    Markup.inlineKeyboard([
      [Markup.button.url('📢 הצטרפו לערוץ', CHANNEL_URL)],
      [Markup.button.callback('✅ הצטרפתי, שלחו לי', `chk_${item.id}`)]
    ])
  );
  return true;
}

// ==========================================
// שליחת פריט למשתמש
// ==========================================
async function sendItem(ctx, item) {
  await dropTarget(ctx);
  if (await needSub(ctx, item)) return;
  const admin = isAdmin(ctx);

  const label = item.type === 'series'
    ? `${pe('series')} <b>${esc(item.cleanTitle)}</b>\n🔸 עונה ${item.season || 1} • פרק ${item.episode ?? '?'}`
    : `${pe('movie')} <b>${esc(item.cleanTitle)}</b>`;
  const caption = `${header()}\n${label}\n${HR}`;

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
  rows.push([Markup.button.url('📢 לערוץ שלנו', CHANNEL_URL)]);
  if (admin) rows.push([Markup.button.callback('🗑 מחק פריט (מנהל)', `del_${item.id}`)]);
  const kb = Markup.inlineKeyboard(rows);
  const protect = !admin && db.settings.protect ? { protect_content: true } : {};
  const extra = { caption, parse_mode: 'HTML', ...protect, ...kb };

  let sent = null;
  try {
    const f = item.file_id;
    if (f && item.file_type === 'video') sent = await ctx.replyWithVideo(f, extra);
    else if (f && item.file_type === 'document') sent = await ctx.replyWithDocument(f, extra);
    else if (f && item.file_type === 'photo') sent = await ctx.replyWithPhoto(f, extra);
    else if (f && item.file_type === 'audio') sent = await ctx.replyWithAudio(f, extra);
    else {
      const links = item.caption.match(/(?:https?:\/\/|t\.me\/)\S+/gi);
      const body = links ? links.map(esc).join('\n') : esc(item.caption);
      sent = await ctx.reply(cut(`${caption}\n\n🔗 ${body}`, 4000), {
        parse_mode: 'HTML', disable_web_page_preview: false, ...protect, ...kb
      });
    }
  } catch (e) {
    console.error('שליחת פריט נכשלה:', item.id, e.description || e.message);
    return ctx.reply('⚠️ לא הצלחתי לשלוח את הקובץ (ייתכן שהוא הוסר). נסו פריט אחר.');
  }

  if (!admin && sent) {
    item.views = (item.views || 0) + 1;
    markDirty(true);
    await autoClean(ctx, sent); // פעיל רק אם הופעל בהגדרות
  }
  return sent;
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
    markDirty(true);
  }
  return next();
});

// ==========================================
// תפריט מנהל
// ==========================================
const BTN = {
  stats: '📊 סטטיסטיקה',
  last: '🗂 פריטים אחרונים',
  bl: '🚫 רשימה שחורה',
  settings: '⚙️ הגדרות',
  export: '📥 ייצוא מאגר',
  import: '📁 ייבוא מאגר',
  broadcast: '📢 הודעה לכל המשתמשים',
  wipe: '🗑️ מחיקת כל המאגר',
  cancel: '❌ ביטול'
};

const adminKeyboard = () => Markup.keyboard([
  [BTN.stats, BTN.last],
  [BTN.bl, BTN.settings],
  [BTN.export, BTN.import],
  [BTN.broadcast, BTN.wipe],
  [BTN.cancel]
]).resize();

const adminState = new Map();

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
    if (payload.startsWith('e_')) {
      const [, sid, s, e] = payload.split('_');
      return openEpisode(ctx, sid, +s || 1, +e || null);
    }
    if (payload.startsWith('series_')) {
      let t = payload.slice(7);
      try { t = decodeURIComponent(t); } catch (_) { /* ignore */ }
      return showSeries(ctx, shortHash(normLegacy(t)));
    }
  }

  if (isAdmin(ctx)) {
    return ctx.replyWithHTML(
      `${pe('brand')} <b>מערכת ניהול מופעלת</b>\n\n` +
      `⚡ <b>העלאה מהירה:</b> העבירו (Forward) לכאן סרטונים, קבצים או קישורים - הבוט יפענח וישמור אוטומטית, ` +
      `ויסכם בהודעה אחת בסוף.\n\n` +
      `🛠 פקודות:\n` +
      `<code>/last</code> • <code>/new</code> • <code>/top</code>\n` +
      `<code>/rename שם ישן | שם חדש</code>\n` +
      `<code>/bl add ביטוי</code> • <code>/bl del ביטוי</code> • <code>/bl</code>\n` +
      `<code>/reparse</code> - פענוח מחדש של כל המאגר\n\n` +
      `⚙️ מחיקה אוטומטית והגדרות נוספות - בכפתור "הגדרות".`,
      adminKeyboard()
    );
  }
  const delLine = db.settings.delSec
    ? `\n⏳ קבצים נמחקים אוטומטית אחרי ${fmtSec(db.settings.delSec)} - העבירו לשמורות כדי לשמור.` : '';
  return ctx.replyWithHTML(
    `${pe('movie')} <b>ברוכים הבאים ל${esc(BRAND)}!</b> ${pe('brand')}\n${HR}\n` +
    `🔍 <b>איך מחפשים?</b>\n• שלחו שם של סרט או סדרה בפרטי.\n` +
    `• לפרק ספציפי: <code>שם הסדרה ע1 פ3</code>\n` +
    `• חדשים: /new • הכי נצפים: /top\n• בקבוצות: <code>/search שם הסרט</code>${delLine}`,
    Markup.inlineKeyboard([[Markup.button.url('📢 לערוץ שלנו', CHANNEL_URL)]])
  );
});

bot.command('new', async (ctx) => {
  const groups = latestGroups();
  if (!groups.length) return ctx.reply('המאגר ריק כרגע.');
  const qid = saveQuery('new', groups, '🆕 <b>התוספות האחרונות</b>');
  return renderResults(ctx, qid, 0);
});

bot.command('top', async (ctx) => {
  const groups = topGroups();
  if (!groups.length) return ctx.reply('עדיין אין מספיק נתוני צפייה.');
  const qid = saveQuery('top', groups, '🔥 <b>הכי נצפים</b>');
  return renderResults(ctx, qid, 0);
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
  const views = db.items.reduce((s, i) => s + (i.views || 0), 0);
  await ctx.replyWithHTML(
    `📊 <b>סטטיסטיקה</b>\n${HR}\n` +
    `${pe('movie')} סרטים: <b>${movies}</b>\n${pe('series')} סדרות: <b>${uniqueSeries}</b>\n🧩 פרקים: <b>${eps.length}</b>\n` +
    `📦 סה"כ פריטים: <b>${db.items.length}</b>\n👥 משתמשים: <b>${Object.keys(db.users).length}</b>\n` +
    `👁 צפיות: <b>${views}</b>\n🚫 ביטויים ברשימה השחורה: <b>${db.blacklist.length}</b>`
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
  await ctx.reply('שלחו קובץ JSON (אפשר גם פשוט להעביר אליי קובץ גיבוי בכל שלב). הפריטים ימוזגו בלי כפילויות.');
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
  await ctx.reply(`✅ שונה שם ל-${hits.length} פריטים (אם קיימת סדרה בשם החדש - הפרקים התמזגו אליה).`);
});

bot.command('reparse', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const msg = await ctx.reply('⏳ שולח גיבוי ומפענח מחדש את כל המאגר...');
  await sendBackup(false);
  let n = 0;
  for (const it of db.items) {
    const p = parseMedia(it.title || it.caption);
    const season = p.type === 'series' ? p.season || 1 : null;
    const episode = p.type === 'series' ? p.episode : null;
    if (p.cleanTitle !== it.cleanTitle || p.type !== it.type || season !== it.season || episode !== it.episode) {
      Object.assign(it, { cleanTitle: p.cleanTitle, type: p.type, season, episode });
      indexItem(it);
      n++;
    }
  }
  if (n) markDirty();
  await ctx.telegram.editMessageText(
    msg.chat.id, msg.message_id, undefined,
    `✅ עודכנו ${n} פריטים מתוך ${db.items.length}.\n(שינויי /rename ידניים שנעשו קודם עלולים להידרס)`
  ).catch(() => {});
});

// ==========================================
// הגדרות
// ==========================================
function setView() {
  const s = db.settings;
  const text =
    `⚙️ <b>הגדרות</b>\n${HR}\n` +
    `👥 <b>מחיקת הודעת "נמצאו תוצאות" בקבוצות:</b> ${fmtSec(s.grpSec)}\n` +
    `<i>נמחקת רק הודעת התגובה והודעת המשתמש שחיפש. תוצאות החיפוש, העונות והפרקים נשארים תמיד.</i>\n\n` +
    `⏱ <b>מחיקת קבצים שנשלחו למשתמש:</b> ${fmtSec(s.delSec)}\n` +
    `🔒 <b>חסימת העברה/שמירה:</b> ${s.protect ? 'פעיל' : 'כבוי'}\n\n` +
    `💡 מנהלים פטורים ממחיקה. בקבוצות הבוט חייב להיות מנהל עם הרשאת מחיקת הודעות.`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`👥 מחיקת "נמצאו" בקבוצות: ${fmtSec(s.grpSec)}`, 'st_grp')],
    [Markup.button.callback(`⏱ מחיקת קבצים: ${fmtSec(s.delSec)}`, 'st_del')],
    [Markup.button.callback(`🔒 הגנה מהעברה: ${s.protect ? 'פעיל' : 'כבוי'}`, 'st_prot')]
  ]);
  return { text, kb };
}

bot.hears(BTN.settings, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const v = setView();
  await ctx.replyWithHTML(v.text, v.kb);
});

bot.action(/^st_(del|grp|prot)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const k = ctx.match[1];
  if (k === 'del') db.settings.delSec = nextOf(DEL_OPTS, db.settings.delSec);
  else if (k === 'grp') db.settings.grpSec = nextOf(GRP_OPTS, db.settings.grpSec);
  else db.settings.protect = !db.settings.protect;
  markDirty(true);
  await ctx.answerCbQuery('✅ עודכן');
  const v = setView();
  await render(ctx, v.text, v.kb);
});

// ==========================================
// רשימה שחורה - ממשק מנהל
// ==========================================
function blView() {
  const list = db.blacklist;
  const rows = list.map((p) => [Markup.button.callback('🗑 ' + cut(p, 40), `bld_${shortHash(p)}`)]);
  rows.push([Markup.button.callback('➕ הוסף ביטוי', 'bl_add')]);
  const text =
    `🚫 <b>רשימה שחורה</b>\n${HR}\n` +
    (list.length
      ? `הביטויים הבאים נמחקים אוטומטית מכל כיתוב/טקסט נכנס ומהמאגר הקיים:\n\n` + list.map((p) => `• ${esc(p)}`).join('\n')
      : `הרשימה ריקה.`) +
    `\n\n💡 הוספה מהירה: <code>/bl add לולו סרטים</code>\nלחיצה על ביטוי מוחקת אותו מהרשימה.`;
  return { text, kb: Markup.inlineKeyboard(rows) };
}

async function showBlacklist(ctx) {
  if (!isAdmin(ctx)) return;
  const v = blView();
  await ctx.replyWithHTML(v.text, v.kb);
}
bot.hears(BTN.bl, showBlacklist);

bot.command(['bl', 'blacklist'], async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  const m = arg.match(/^(add|הוסף|del|rm|מחק)\s+([\s\S]+)$/i);
  if (!m) return showBlacklist(ctx);
  if (/^(add|הוסף)$/i.test(m[1])) {
    const r = addBlacklist(m[2].split('\n'));
    return ctx.reply(r.added.length
      ? `✅ נוספו ${r.added.length} ביטויים. נוקו ${r.cleaned} פריטים קיימים.`
      : 'ℹ️ הביטוי כבר קיים ברשימה (או קצר מדי).');
  }
  const key = norm(m[2]);
  const idx = db.blacklist.findIndex((p) => norm(p) === key);
  if (idx === -1) return ctx.reply('❌ הביטוי לא נמצא ברשימה.');
  db.blacklist.splice(idx, 1);
  rebuildBL();
  markDirty();
  await ctx.reply('🗑 הביטוי הוסר מהרשימה (טקסטים שכבר נמחקו לא יחזרו).');
});

bot.action('bl_add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, { step: 'AWAIT_BL' });
  await ctx.reply('✍️ שלחו ביטוי להוספה (כל שורה = ביטוי נפרד). לדוגמה: לולו סרטים');
});

bot.action(/^bld_([a-f0-9]+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const idx = db.blacklist.findIndex((p) => shortHash(p) === ctx.match[1]);
  if (idx !== -1) {
    db.blacklist.splice(idx, 1);
    rebuildBL();
    markDirty();
  }
  await ctx.answerCbQuery('🗑 הוסר');
  const v = blView();
  await render(ctx, v.text, v.kb);
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
  await ctx.answerCbQuery('🍿 שולח...');
  await sendItem(ctx, item);
});

bot.action(/^chk_(.+)$/, async (ctx) => {
  const item = findItem(ctx.match[1]);
  if (!item) return ctx.answerCbQuery('❌ הפריט לא נמצא', { show_alert: true });
  if (!(await subscribed(ctx))) {
    return ctx.answerCbQuery('עדיין לא הצטרפת לערוץ 😉', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ מעולה, שולח!');
  await ctx.deleteMessage().catch(() => {});
  await sendItem(ctx, item);
});

bot.action(/^rq_([a-f0-9]+)$/, async (ctx) => {
  const r = requests.get(ctx.match[1]);
  if (!r) return ctx.answerCbQuery('הבקשה פגה, חפשו שוב 🔎', { show_alert: true });
  const last = reqCool.get(ctx.from.id) || 0;
  if (Date.now() - last < 30000) return ctx.answerCbQuery('⏳ המתינו כמה שניות בין בקשות', { show_alert: true });
  reqCool.set(ctx.from.id, Date.now());
  if (reqCool.size > 3000) reqCool.clear();
  requests.delete(ctx.match[1]);
  const u = r.user;
  const who = u.username ? '@' + u.username : u.first_name || String(u.id);
  await bot.telegram.sendMessage(
    ADMIN_IDS[0],
    `📩 <b>בקשה חדשה</b>\n${HR}\n🔎 "<b>${esc(r.q)}</b>"\n👤 ${esc(who)} (<code>${u.id}</code>)`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await ctx.answerCbQuery('✅ הבקשה נשלחה!');
  await ctx.editMessageText('✅ <b>הבקשה נשלחה למנהלים!</b>\nנעדכן בערוץ כשהתוכן יתווסף.', { parse_mode: 'HTML' }).catch(() => {});
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
  await ctx.editMessageText('⏳ שולח גיבוי ומוחק...').catch(() => {});
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
  await ctx.editMessageText('📢 השליחה התחילה...').catch(() => {});
  runBroadcast(ctx.from.id, st.chatId, st.msgId, ctx.callbackQuery.message).catch((e) => console.error('broadcast:', e));
});

async function runBroadcast(adminId, fromChat, msgId, statusMsg) {
  const ids = Object.keys(db.users);
  let ok = 0, fail = 0, lastEdit = Date.now();
  for (const uid of ids) {
    try {
      await bot.telegram.copyMessage(uid, fromChat, msgId);
      ok++;
    } catch (e) {
      fail++;
      if (e.response?.error_code === 403) { delete db.users[uid]; markDirty(true); }
      if (e.response?.error_code === 429) await sleep((e.response.parameters?.retry_after || 5) * 1000);
    }
    if (statusMsg && Date.now() - lastEdit > 3000) {
      lastEdit = Date.now();
      bot.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, undefined,
        `📢 שולח... ${ok + fail}/${ids.length}`
      ).catch(() => {});
    }
    await sleep(50);
  }
  const done = `✅ <b>השליחה הסתיימה</b>\nנשלח ל-${ok} | נכשל ${fail}`;
  if (statusMsg) {
    await bot.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, done, { parse_mode: 'HTML' })
      .catch(() => bot.telegram.sendMessage(adminId, done, { parse_mode: 'HTML' }));
  } else {
    await bot.telegram.sendMessage(adminId, done, { parse_mode: 'HTML' });
  }
}

// ==========================================
// קליטה מהירה (מנהל) - הודעת התקדמות חיה שנערכת לסיכום
// ==========================================
const batches = new Map();

function queueSummary(chatId, res, item, flags = {}) {
  let b = batches.get(chatId);
  if (!b) {
    b = { added: 0, dup: 0, skipped: 0, alt: 0, warn: 0, lines: [], timer: null, lastEdit: Date.now(), msg: null };
    b.msg = bot.telegram.sendMessage(chatId, '⏳ <b>קולט קבצים...</b>', { parse_mode: 'HTML', disable_notification: true })
      .catch(() => null);
    batches.set(chatId, b);
  }
  if (res === 'added') {
    b.added++;
    let line = item.type === 'series'
      ? `${pe('series')} ${esc(item.cleanTitle)} | ע${item.season || 1} פ${item.episode ?? '?'}`
      : `${pe('movie')} ${esc(item.cleanTitle)}`;
    if (flags.alt) { b.alt++; line += ' 🔁'; }
    if (item.type === 'series' && item.episode == null) { b.warn++; line += ' ⚠️'; }
    b.lines.push(line);
  } else if (res === 'dup') b.dup++;
  else b.skipped++;

  const total = b.added + b.dup + b.skipped;
  if (Date.now() - b.lastEdit > 3000) {
    b.lastEdit = Date.now();
    b.msg.then((m) => m && bot.telegram.editMessageText(
      chatId, m.message_id, undefined, `⏳ <b>קולט קבצים... ${total}</b>`, { parse_mode: 'HTML' }
    ).catch(() => {}));
  }

  clearTimeout(b.timer);
  b.timer = setTimeout(async () => {
    batches.delete(chatId);
    const shown = b.lines.slice(0, 15).join('\n');
    const more = b.lines.length > 15 ? `\n…ועוד ${b.lines.length - 15}` : '';
    const legend =
      (b.alt ? `\n🔁 = גרסה נוספת לפרק שכבר קיים` : '') +
      (b.warn ? `\n⚠️ = לא זוהה מספר פרק (לא מסודר לפי סדר)` : '');
    const text = `✅ <b>נקלטו ${b.added} פריטים</b>` +
      (b.dup ? ` | ♻️ כפולים: ${b.dup}` : '') + (b.skipped ? ` | ⏭ דולגו: ${b.skipped}` : '') +
      (shown ? `\n${HR}\n${shown}${more}${legend}` : '');
    const m = await b.msg;
    try {
      if (m) await bot.telegram.editMessageText(chatId, m.message_id, undefined, text, { parse_mode: 'HTML' });
      else await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', disable_notification: true });
    } catch (e) { console.error('summary:', e.message); }
  }, 1500);
}

function ingest(ctx) {
  const m = ctx.message;
  const text = stripBL(m.caption || m.text || '');
  const isFwd = !!(m.forward_origin || m.forward_date || m.forward_from_chat);

  let media = null, fileName = '';
  if (m.video) { media = { type: 'video', f: m.video }; fileName = m.video.file_name; }
  else if (m.document) { media = { type: 'document', f: m.document }; fileName = m.document.file_name; }
  else if (m.audio) { media = { type: 'audio', f: m.audio }; fileName = m.audio.file_name; }
  else if (m.photo?.length) { media = { type: 'photo', f: m.photo[m.photo.length - 1] }; }

  if (!media) {
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

  const alt = item.type === 'series' && item.episode != null && db.items.some((i) =>
    i.type === 'series' && i._sid === item._sid && i.season === item.season && i.episode === item.episode);

  db.items.push(item);
  if (uid) seen.add(uid);
  markDirty();
  queueSummary(ctx.chat.id, 'added', item, { alt });
  return true;
}

async function handleImport(ctx) {
  adminState.delete(ctx.from.id);
  const wait = await ctx.reply('⏳ מייבא...').catch(() => null);
  const finish = (text) => wait
    ? ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, text).catch(() => ctx.reply(text, adminKeyboard()))
    : ctx.reply(text, adminKeyboard());
  try {
    const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    const res = await fetch(link.href);
    const j = await res.json();
    const raw = Array.isArray(j) ? j : j.items || j.movies || [];

    if (!Array.isArray(j) && Array.isArray(j.blacklist)) addBlacklist(j.blacklist);

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
    if (!added && !dup) return finish('❌ קובץ JSON ריק או לא תקין.');
    cleanExisting();
    markDirty();
    await finish(`✅ נוספו ${added} פריטים (דולגו ${dup} כפולים).`);
  } catch (e) {
    console.error('import:', e);
    await finish('❌ שגיאה בקריאת קובץ ה-JSON.');
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
  q = stripBL(q).trim();

  if (isGroup && q.length > 60) return;
  if (q.length < 2) {
    if (explicit || !isGroup) await ctx.reply('✍️ כתבו שם של סרט או סדרה (לפחות 2 תווים).');
    return;
  }

  const now = Date.now();
  if (now - (cooldown.get(ctx.from.id) || 0) < 1200) return;
  cooldown.set(ctx.from.id, now);
  if (cooldown.size > 5000) cooldown.clear();

  // בקבוצות: הודעת תגובה זמנית ("נמצאו תוצאות") + הודעת המשתמש נמחקות. התוצאות עצמן נשארות.
  const tempNote = async (html) => {
    const sec = db.settings.grpSec;
    const s = await ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
    if (sec) {
      if (s) scheduleDelete(ctx.chat.id, s.message_id, sec);
      scheduleDelete(ctx.chat.id, ctx.message.message_id, sec);
    }
    return s;
  };
  // תוצאות בקבוצה - קבועות, לא נמחקות לעולם
  const groupResults = (html, kb) => ctx.replyWithHTML(html, kb);

  // בפרטי: הודעת "מחפש..." שנערכת לתוצאה
  if (!isGroup) {
    const w = await ctx.reply('🔎 <b>מחפש...</b>', { parse_mode: 'HTML' }).catch(() => null);
    if (w) ctx.state.target = { chat_id: w.chat.id, message_id: w.message_id };
  }

  const route = async () => {
    const se = extractSE(q);
    const hasSE = se.season !== null || se.episode !== null;
    const titleQ = hasSE ? trimSeps(cutAtMarkers(q)) : q;

    const groups = searchDB(titleQ.length >= 2 ? titleQ : q);
    if (!groups.length) {
      if (isGroup) {
        if (explicit) await tempNote(`❌ לא נמצאו תוצאות עבור <b>"${esc(q)}"</b>.`);
        return;
      }
      const rid = newReq(q, ctx.from);
      return render(
        ctx,
        `❌ לא נמצאו תוצאות עבור <b>"${esc(q)}"</b>.\nנסו שם קצר יותר או כתיב אחר, או בקשו שנוסיף:`,
        Markup.inlineKeyboard([[Markup.button.callback('📩 בקשו שנוסיף את זה', `rq_${rid}`)]])
      );
    }

    const cand = groups.filter((g) => g.type === 'series');
    const clearWinner = hasSE && cand.length && (cand.length === 1 || cand[0].score > cand[1].score + 0.3);

    if (isGroup) {
      const who = esc(ctx.from.first_name || 'משתמש');
      if (clearWinner) {
        const label = `▶️ ${cut(cand[0].title, 30)} ע${se.season ?? 1}${se.episode != null ? ` פ${se.episode}` : ''}`;
        await tempNote(`🔎 ${who}, מצאתי את מה שחיפשת 👇`);
        return groupResults(
          `${header()}\n✨ מצאתי! לחצו לפתיחה בפרטי:`,
          Markup.inlineKeyboard([[Markup.button.url(
            label, `https://t.me/${botUsername}?start=e_${cand[0].id}_${se.season ?? 1}_${se.episode ?? 0}`
          )]])
        );
      }
      const rows = groups.slice(0, 5).map((g) => [Markup.button.url(
        groupLabel(g),
        `https://t.me/${botUsername}?start=${g.type === 'series' ? 's_' : 'g_'}${g.id}`
      )]);
      await tempNote(`🔎 ${who}, נמצאו <b>${groups.length}</b> תוצאות עבור "<b>${esc(cut(q, 40))}</b>" 👇`);
      return groupResults(
        `${header()}\nנמצאו <b>${groups.length}</b> תוצאות. לחצו לפתיחה בפרטי:`,
        Markup.inlineKeyboard(rows)
      );
    }

    if (clearWinner) return openEpisode(ctx, cand[0].id, se.season, se.episode);

    if (groups.length === 1) {
      const g = groups[0];
      if (g.type === 'series') return showSeries(ctx, g.id);
      const item = findItem(g.id);
      return item ? sendItem(ctx, item) : null;
    }
    const qid = saveQuery(q, groups);
    return renderResults(ctx, qid, 0);
  };

  try { await route(); } finally { await dropTarget(ctx); }
}

// ==========================================
// מטפל הודעות יחיד
// ==========================================
bot.on('message', async (ctx) => {
  const m = ctx.message;

  if (isAdmin(ctx)) {
    const st = adminState.get(ctx.from.id);

    if (m.document && (st?.step === 'AWAIT_JSON' || /\.json$/i.test(m.document.file_name || ''))) {
      return handleImport(ctx);
    }

    if (st?.step === 'AWAIT_BL' && m.text) {
      adminState.delete(ctx.from.id);
      const r = addBlacklist(m.text.split('\n'));
      return ctx.reply(r.added.length
        ? `✅ נוספו ${r.added.length} ביטויים לרשימה השחורה. נוקו ${r.cleaned} פריטים קיימים.`
        : 'ℹ️ לא נוסף כלום (הביטוי כבר קיים או קצר מדי).', adminKeyboard());
    }

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
    await bot.telegram.setMyCommands([
      { command: 'search', description: 'חיפוש סרט או סדרה' },
      { command: 'new', description: 'התוספות האחרונות' },
      { command: 'top', description: 'הכי נצפים' }
    ]).catch(() => {});

    if (!db.items.length) {
      bot.telegram.sendMessage(
        ADMIN_IDS[0],
        '⚠️ הבוט עלה והמאגר ריק (ייתכן שהדיסק אופס). העבירו אליי את קובץ הגיבוי האחרון (JSON) והוא ישוחזר אוטומטית.'
      ).catch(() => {});
    }

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
