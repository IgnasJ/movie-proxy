require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const express = require('express');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const SOURCE = (process.env.SOURCE_URL || 'https://176.97.124.32').replace(/\/$/, '');
const TOPFILMAI = (process.env.TOPFILMAI_URL || 'https://213.111.148.194').replace(/\/$/, '');
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const enc = encodeURIComponent;
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'pass';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Dispatcher that ignores TLS cert mismatches, used only for /tvproxy fetches —
// stream CDNs are often on raw IPs with certs for another name. Scoped per
// request (not global) so TMDB and the source site keep normal verification.
let insecureAgent = null;
try { insecureAgent = new (require('undici').Agent)({ connect: { rejectUnauthorized: false } }); }
catch { /* undici not exposed — fall back to default fetch */ }

// Cache-busting for static assets: append the file's mtime so a changed
// css/js gets a new URL and browsers fetch it instead of a stale cached copy
// (the files are still cached long; the ?v= just changes when they change).
const _assetVer = new Map();
function asset(p) {
  if (!_assetVer.has(p)) {
    try { _assetVer.set(p, Math.floor(fs.statSync(path.join(__dirname, 'public', p)).mtimeMs)); }
    catch { _assetVer.set(p, 0); }
  }
  const v = _assetVer.get(p);
  return v ? `${p}?v=${v}` : p;
}

const app = express();
app.disable('x-powered-by');

/* ---------------------------------- auth ---------------------------------- */

const authToken = crypto.createHash('sha256').update(`${AUTH_USER}:${AUTH_PASS}:mp-salt`).digest('hex');

function isAuthed(req) {
  return (req.headers.cookie || '').includes(`mpauth=${authToken}`);
}

// only allow redirecting back to a safe local path (no protocol-relative // jumps)
function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/';
}

function loginPage({ error = false, next = '/' } = {}) {
  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${asset('/favicon.svg')}" type="image/svg+xml">
<link rel="alternate icon" href="${asset('/favicon.png')}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${asset('/apple-touch-icon.png')}">
<meta name="theme-color" content="#14151a">
<title>Prisijungimas</title>
<link rel="stylesheet" href="${asset('/tv.css')}">
</head>
<body class="loginpage">
<form class="login-card" action="/login" method="post">
  <div class="login-logo">🎬 Filmai</div>
  ${error ? `<div class="login-error">Neteisingas vartotojas arba slaptažodis</div>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <label>Vartotojas
    <input type="text" name="username" autocomplete="username" autofocus required>
  </label>
  <label>Slaptažodis
    <input type="password" name="password" autocomplete="current-password" required>
  </label>
  <button type="submit">Prisijungti</button>
</form>
<script src="${asset('/tv.js')}"></script>
</body>
</html>`;
}

// static assets and the login page are reachable without a session
app.use(express.static('public', { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect(safeNext(req.query.next));
  res.send(loginPage({ error: req.query.error === '1', next: safeNext(req.query.next) }));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const next = safeNext(req.body && req.body.next);
  if (username === AUTH_USER && password === AUTH_PASS) {
    res.setHeader('Set-Cookie', `mpauth=${authToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    return res.redirect(next);
  }
  res.status(401).send(loginPage({ error: true, next }));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'mpauth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.redirect('/login');
});

// everything below requires a session — except the proxy/media endpoints, which
// are fetched by the player itself, not navigated to. iOS plays <video>/HLS in a
// separate media process that does NOT send our cookie, so a cookie gate here
// bounces those range/segment/subtitle requests to the login HTML and playback
// silently never starts (works on desktop, which does send the cookie). These
// don't need a session to be safe: /stream and /tvproxy carry an unguessable
// HMAC signature (s=) so they're not an open proxy, and /sub only takes an imdb
// id and relays public OpenSubtitles data. Each handler validates its own input.
const PLAYER_ENDPOINTS = /^\/(stream|tvproxy|sub)(\/|$)/;
app.use((req, res, next) => {
  if (isAuthed(req) || PLAYER_ENDPOINTS.test(req.path)) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

/* ------------------------------ source fetching ---------------------------- */

const cache = new Map();

async function srcFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : SOURCE + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Referer': opts.referer || SOURCE + '/',
      'Accept-Language': 'lt,en;q=0.8',
      ...(opts.headers || {}),
    },
    body: opts.body,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Šaltinis grąžino ${res.status} (${url})`);
  return res.text();
}

async function getPage(srcPath, ttlMs = 5 * 60 * 1000) {
  const hit = cache.get(srcPath);
  if (hit && hit.exp > Date.now()) return hit.html;
  const html = await srcFetch(srcPath);
  cache.set(srcPath, { html, exp: Date.now() + ttlMs });
  if (cache.size > 200) {
    for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
  }
  return html;
}

/* ------------------------- watched store (shared, on disk) -------------------
   Server-side so every device sees the same state. Marked automatically when a
   player opens (i.e. when a stream provider link is clicked). Persisted as JSON;
   no native dependencies, fine for a single-process app on Hostinger. */

const WATCHED_FILE = process.env.WATCHED_FILE || path.join(__dirname, 'data', 'watched.json');
let watched = {};
try {
  watched = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8')) || {};
} catch { /* first run — no file yet */ }

let saveTimer = null;
function persistWatched() {
  // debounce bursts of writes, then write atomically (temp file + rename)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(WATCHED_FILE), { recursive: true });
      const tmp = WATCHED_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(watched));
      fs.renameSync(tmp, WATCHED_FILE);
    } catch (e) { console.error('watched persist failed:', e.message); }
  }, 400);
}

// key = the local detail path, e.g. /t/filmas/slug (no trailing slash)
function watchedKey(u) {
  if (!u) return null;
  let p = u;
  try { p = new URL(u, 'http://x').pathname; } catch { /* already a path */ }
  try { p = decodeURIComponent(p); } catch { /* leave as-is */ }
  p = p.replace(/\/+$/, '');
  return p.startsWith('/t/') ? p : null;
}

function markWatched(key, { title, kind, ep } = {}) {
  if (!key) return;
  const rec = watched[key] || { eps: [] };
  rec.t = Date.now();
  if (title) rec.title = title;
  if (kind) rec.kind = kind;
  if (ep) {
    rec.eps = rec.eps || [];
    if (!rec.eps.includes(ep)) rec.eps.push(ep);
  }
  watched[key] = rec;
  persistWatched();
}

/* ------------------------- wishlist store (shared, on disk) ------------------
   Same shape and persistence strategy as the watched store, but toggled by the
   user from a film/serial detail page (not automatic). Keyed by the local detail
   path so the wishlist page can link straight back. Stores enough to render a
   card (title/poster/kind/rating) without re-fetching the source. */

const WISHLIST_FILE = process.env.WISHLIST_FILE || path.join(__dirname, 'data', 'wishlist.json');
let wishlist = {};
try {
  wishlist = JSON.parse(fs.readFileSync(WISHLIST_FILE, 'utf8')) || {};
} catch { /* first run — no file yet */ }

let wlSaveTimer = null;
function persistWishlist() {
  if (wlSaveTimer) return;
  wlSaveTimer = setTimeout(() => {
    wlSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(WISHLIST_FILE), { recursive: true });
      const tmp = WISHLIST_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(wishlist));
      fs.renameSync(tmp, WISHLIST_FILE);
    } catch (e) { console.error('wishlist persist failed:', e.message); }
  }, 400);
}

// Add when missing, remove when present. Returns the new state (true = in list).
function toggleWishlist(key, { title, poster, kind, rating } = {}) {
  if (!key) return false;
  if (wishlist[key]) {
    delete wishlist[key];
    persistWishlist();
    return false;
  }
  wishlist[key] = { title, poster, kind, rating, t: Date.now() };
  persistWishlist();
  return true;
}

/* ------------------------------- IPTV (live TV) ------------------------------
   Channels come from a plain m3u file next to the app (iptv.m3u) so it can be
   edited straight in the hosting file manager — changes are picked up on the
   next page load (mtime check), no restart needed. Streams are played through
   /tvproxy, which rewrites HLS playlists to route every segment through us.
   That solves three TV/iPad realities at once: http:// streams on an https
   page (mixed content), hosts without CORS headers (hls.js needs them), and
   Referer-locked CDNs. */

// Runtime playlist lives in data/ so it can be edited live in hosting. It's
// seeded once from the encoded default (iptv.iptv) — see seedIptv() — and then
// never overwritten, so edits survive restarts and redeploys.
const IPTV_FILE = process.env.IPTV_FILE || path.join(__dirname, 'data', 'iptv.m3u');
const IPTV_DEFAULT = process.env.IPTV_DEFAULT || path.join(__dirname, 'iptv.iptv');

// Decode the bundled default into data/iptv.m3u on first run only. Delete
// data/iptv.m3u (or set it via IPTV_FILE) to force a re-seed from iptv.iptv.
function seedIptv() {
  try {
    if (fs.existsSync(IPTV_FILE) || !fs.existsSync(IPTV_DEFAULT)) return;
    const { decode } = require('./iptv-codec');
    fs.mkdirSync(path.dirname(IPTV_FILE), { recursive: true });
    fs.writeFileSync(IPTV_FILE, decode(fs.readFileSync(IPTV_DEFAULT, 'utf8')));
    console.log(`iptv: seeded ${IPTV_FILE} from ${path.basename(IPTV_DEFAULT)}`);
  } catch (e) { console.error('iptv seed failed:', e.message); }
}
seedIptv();

let iptvCache = { mtime: -1, channels: [], groups: [] };

function parseM3U(text) {
  const channels = [];
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const re = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2];
      // display name = everything after the comma that follows the attributes
      const ci = line.indexOf(',', Math.max(line.lastIndexOf('"'), 0));
      meta = {
        name: (ci >= 0 ? line.slice(ci + 1).trim() : '') || attrs['tvg-name'] || 'Kanalas',
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
        // tvg-id doubles as the iptvx.one EPG slug ([a-z0-9-]); empty = no guide
        epg: /^[a-z0-9-]+$/.test(attrs['tvg-id'] || '') ? attrs['tvg-id'] : '',
        // licensed embed player to fall back to when the clean HLS turns out to
        // be DRM-encrypted (e.g. SAMPLE-AES/FairPlay on sports) — see iptv.js
        embed: attrs['tvg-embed'] || '',
      };
    } else if (line.startsWith('#')) {
      continue; // header, separators, comments
    } else {
      channels.push({ ...(meta || { name: line, group: '', logo: '', epg: '' }), url: line });
      meta = null;
    }
  }
  return channels;
}

function loadIptv() {
  let st;
  try { st = fs.statSync(IPTV_FILE); } catch { return { channels: [], groups: [], missing: true }; }
  if (st.mtimeMs !== iptvCache.mtime) {
    const channels = parseM3U(fs.readFileSync(IPTV_FILE, 'utf8'));
    const groups = [];
    const byName = new Map();
    channels.forEach((c, i) => {
      c.idx = i;
      const g = c.group || 'Kiti';
      if (!byName.has(g)) {
        byName.set(g, []);
        groups.push({ name: g, channels: byName.get(g) });
      }
      byName.get(g).push(c);
    });
    iptvCache = { mtime: st.mtimeMs, channels, groups };
  }
  return iptvCache;
}

// sign proxied URLs so /tvproxy only serves what we minted (no open proxy).
// r = optional Referer the proxy must send upstream (e.g. hd4u.sbs streams are
// Referer-locked); it's part of the signature so it can't be tampered with.
function tvSig(u, r = '') {
  return crypto.createHash('sha256').update(`tv|${u}|${r}|${authToken}`).digest('hex').slice(0, 16);
}
function tvProxyUrl(u, r = '') {
  return `/tvproxy?u=${enc(u)}${r ? `&r=${enc(r)}` : ''}&s=${tvSig(u, r)}`;
}

// route every URI in an HLS playlist (segments, variant playlists, keys,
// alternate audio) back through /tvproxy, resolved against the final URL.
// The Referer is carried onto every child request so locked CDNs keep serving.
function rewriteM3U8(body, baseUrl, referer = '') {
  const absProxy = (u) => {
    try { return tvProxyUrl(new URL(u, baseUrl).href, referer); } catch { return u; }
  };
  return body.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${absProxy(u)}"`);
    return absProxy(t);
  }).join('\n');
}

// Pipe an upstream fetch() body to the client, surviving aborts. Without the
// 'error' handler, a CDN dropping the socket mid-stream (or the viewer closing
// the player) emits an unhandled 'error' on the Readable and crashes the whole
// process. We also destroy the upstream when the client goes away so we stop
// pulling bytes we'll never send.
function streamUpstream(up, res) {
  if (!up.body) return res.end();
  const body = Readable.fromWeb(up.body);
  body.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
  res.on('close', () => { try { body.destroy(); } catch { /* already gone */ } });
  body.pipe(res);
}

function youtubeId(u) {
  const m = String(u).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : null;
}

// embed/player pages (play.tv3.lt ir pan.) go straight into an iframe instead
// of the video proxy; an explicit "iframe:" prefix in the m3u forces this
function iframeSrcOf(u) {
  if (/^iframe:/i.test(u)) return u.slice(7);
  return /\/embed[-/]|\.html?(\?|$)/i.test(u) ? u : null;
}

/* ------------------------------- EPG (iptvx.one) -----------------------------
   The channel's tvg-id is an iptvx.one slug; we scrape its program page
   (https://epg.iptvx.one/id/<slug>) into a flat list of {start,title,desc}.
   Times on that page are Vilnius-local, which is what the TV/iPad shows, so we
   return them as naive local datetimes and let the client pick "now". Cached
   per slug; the source itself only refreshes about hourly. */

const EPG_BASE = 'https://epg.iptvx.one/id/';
const EPG_TTL = 30 * 60 * 1000;
const epgCache = new Map();
const RU_MONTHS = {
  'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04', 'мая': '05', 'июня': '06',
  'июля': '07', 'августа': '08', 'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12',
};

function parseEpgHtml(html) {
  const $ = cheerio.load(html);
  const programs = [];
  $('section.panel').each((_, sec) => {
    const head = $(sec).prevAll('h3').first().text().trim();
    const m = head.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
    if (!m) return;
    const date = `${m[3]}-${RU_MONTHS[m[2].toLowerCase()] || '01'}-${String(m[1]).padStart(2, '0')}`;
    $(sec).find('.prog_id').each((__, p) => {
      const time = $(p).find('.prog_time').text().trim();
      const title = $(p).find('.prog_title').text().trim();
      if (!/^\d{1,2}:\d{2}$/.test(time) || !title) return;
      const desc = $(p).nextAll('.prog_desc').first().text().trim();
      programs.push({ start: `${date}T${time.padStart(5, '0')}`, title, desc: desc.slice(0, 400) });
    });
  });
  return programs;
}

const epgPending = new Map();
async function getEpg(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const hit = epgCache.get(slug);
  if (hit && hit.exp > Date.now()) return hit.data;
  // collapse concurrent fetches for the same slug (the /tv grid asks for many at once)
  if (epgPending.has(slug)) return epgPending.get(slug);
  const p = (async () => {
    const res = await fetch(EPG_BASE + slug, { headers: { 'User-Agent': UA, 'Accept-Language': 'lt' } });
    if (!res.ok) throw new Error(`EPG ${res.status}`);
    const programs = parseEpgHtml(await res.text());
    epgCache.set(slug, { data: programs, exp: Date.now() + EPG_TTL });
    return programs;
  })();
  epgPending.set(slug, p);
  try { return await p; } finally { epgPending.delete(slug); }
}

// current Europe/Vilnius wall-clock as "YYYY-MM-DDTHH:MM" — directly comparable
// to the program start strings (which are Vilnius-local), regardless of server tz
function vilniusNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return s.replace(' ', 'T');
}

// {now, next} for a sorted program list, or null if no schedule
function epgNowNext(programs) {
  if (!programs || !programs.length) return null;
  const now = vilniusNow();
  let cur = -1;
  for (let i = 0; i < programs.length; i++) { if (programs[i].start <= now) cur = i; else break; }
  const fmt = (p) => p ? { time: p.start.slice(11, 16), title: p.title } : null;
  return { now: cur >= 0 ? fmt(programs[cur]) : null, next: fmt(programs[cur + 1]) };
}

/* --------------------------------- helpers --------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// /filmas/slug/ or absolute source URL -> local /t/filmas/slug
function toLocal(url) {
  if (!url) return null;
  let path = url;
  try { if (url.startsWith('http')) path = new URL(url).pathname; } catch { return null; }
  const m = path.match(/^\/(filmas|serialai)\/([^/]+)/);
  return m ? `/t/${m[1]}/${m[2]}` : null;
}

function absSrc(url) {
  if (!url) return '';
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  return SOURCE + (url.startsWith('/') ? url : '/' + url);
}

function imgOf($, el) {
  const img = $(el).find('img').first();
  const src = img.attr('data-src') || img.attr('src') || '';
  return src.startsWith('data:') ? (img.attr('data-src') || '') : src;
}

/* --------------------------------- parsers --------------------------------- */

function parseItems($, container) {
  const items = [];
  $(container).find('article.item').each((_, a) => {
    const $a = $(a);
    const href = $a.find('a[href*="/filmas/"], a[href*="/serialai/"]').first().attr('href');
    const local = toLocal(href);
    if (!local) return;
    const title = $a.find('.pname').first().text().trim()
      || $a.find('.data a').first().text().trim()
      || ($a.find('img').first().attr('alt') || '').trim();
    items.push({
      url: local,
      title,
      poster: absSrc(imgOf($, a)),
      rating: $a.find('.rating').first().text().trim(),
      episodes: $a.find('a[data-ep]').first().attr('data-ep') || '',
      kind: $a.hasClass('tvshows') ? 'serialai' : 'filmas',
    });
  });
  // de-dup (source sometimes repeats cards)
  const seen = new Set();
  return items.filter(i => !seen.has(i.url) && seen.add(i.url));
}

function parseHome(html) {
  const $ = cheerio.load(html);
  const sections = [];
  $('.items').each((_, el) => {
    const items = parseItems($, el);
    if (!items.length) return;
    let title;
    if ($(el).hasClass('featured')) title = 'Populiaru dabar';
    else if (items[0].kind === 'serialai') title = 'Naujausi serialai';
    else title = 'Naujausi filmai';
    sections.push({ title, items });
  });
  return sections;
}

function parseArchive(html) {
  const $ = cheerio.load(html);
  const all = [];
  $('.items').each((_, el) => all.push(...parseItems($, el)));
  const seen = new Set();
  return all.filter(i => !seen.has(i.url) && seen.add(i.url));
}

function parseSearch(html) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result-item').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.title a').first();
    const local = toLocal(a.attr('href'));
    if (!local) return;
    const orig = a.find('span').text().replace(/\/|&nbsp;| /g, ' ').trim();
    results.push({
      url: local,
      title: a.clone().children().remove().end().text().trim(),
      original: orig,
      poster: absSrc(imgOf($, el)),
      rating: $el.find('.meta .rating').text().trim(),
      year: $el.find('.meta .year').text().trim(),
      desc: $el.find('.contenido p').first().text().trim(),
      kind: local.includes('/serialai/') ? 'serialai' : 'filmas',
    });
  });
  return results;
}

function parseServerLi($, li) {
  const $li = $(li);
  return {
    post: $li.attr('data-post') || '',
    type: $li.attr('data-type') || '',
    nume: $li.attr('data-nume') || '',
    name: $li.find('.title').first().text().trim(),
    tag: $li.find('.server').first().text().trim(),
  };
}

// Order: YouTube trailer first, then DOOD and STREAMT, then everything else.
function sortServers(servers) {
  const rank = (s) => {
    if (s.nume === 'trailer') return 0;
    const t = (s.tag || '').toUpperCase();
    if (t.includes('DOOD')) return 1;
    if (t.includes('STREAMT')) return 2;
    return 3;
  };
  return servers
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

function parseDetail(html) {
  const $ = cheerio.load(html);
  const d = {};
  d.title = $('.sheader .data h1').first().text().trim();
  const firstDiv = $('.sheader .data > div').first();
  d.original = (!firstDiv.hasClass('extra') && /\(/.test(firstDiv.text()))
    ? firstDiv.text().replace(/[()]/g, '').trim() : '';
  d.poster = absSrc(($('.sheader .poster img').attr('data-src') || $('.sheader .poster img').attr('src') || ''));
  d.year = $('.extra .date').first().text().replace(/ /g, '').trim();
  d.imdb = $('.extra .imdb2').first().text().trim();
  d.runtime = $('.extra .runtime').first().text().replace(/ /g, '').trim();
  d.lang = $('.extra .pt10').first().text().trim();
  d.genres = $('.sgeneros a').map((_, a) => $(a).text().trim()).get();
  d.rating = $('.dt_rating_vgs').first().text().trim();
  d.votes = $('.rating-count').first().text().trim();
  const info = $('#info .wp-content').clone();
  info.find('noscript, script, img, iframe').remove();
  d.description = info.text().replace(/\s+/g, ' ').trim();
  d.cast = $('#cast .persons .person').map((_, p) => ({
    name: $(p).find('.name a').text().trim(),
    role: $(p).find('.caracter').text().trim(),
    img: absSrc(imgOf($, p)),
  })).get().filter(c => c.name).slice(0, 14);

  const epLis = $('#playeroptions li.clickable');
  if (epLis.length) {
    d.kind = 'series';
    d.episodes = epLis.map((_, li) => {
      const $li = $(li);
      const servers = sortServers($li.next('.collapse').find('li.dooplay_player_option')
        .map((__, s) => parseServerLi($, s)).get()
        .filter(s => s.post && s.nume));
      return { label: $li.find('.title').first().text().trim(), servers };
    }).get().filter(e => e.servers.length);
  } else {
    d.kind = 'movie';
    d.servers = sortServers($('#playeroptions li.dooplay_player_option')
      .map((_, s) => parseServerLi($, s)).get()
      .filter(s => s.post && s.nume));
  }
  return d;
}

/* ------------------------- 8filmai player resolution ------------------------ */

async function resolveEmbed(post, type, nume) {
  const body = new URLSearchParams({ action: 'doo_player_ajax', post, nume, type }).toString();
  const text = await srcFetch('/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  try {
    const j = JSON.parse(text);
    if (j && (j.embed_url || j.url)) {
      const m = String(j.embed_url || j.url).match(/src=['"]([^'"]+)['"]/);
      return m ? m[1] : (j.embed_url || j.url);
    }
  } catch { /* not JSON — raw iframe HTML */ }
  const m = text.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i) || text.match(/src=['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// p2.php is an ad-wrapper page; pull the real player iframe out of it
async function resolveClean(embedUrl) {
  try {
    const html = await srcFetch(embedUrl, { referer: SOURCE + '/' });
    const m = html.match(/<iframe[^>]*src=\\?["']([^"'\\]+)\\?["']/i);
    if (m && m[1] && !m[1].includes('p2.php')) return m[1];
  } catch { /* fall back to the wrapper */ }
  return null;
}

/* ------------------------------ Streamtape bypass ----------------------------
   Streamtape wraps its player in pop-up / redirect ads. Its direct-link scheme
   is simple and (unlike DoodStream) not Cloudflare-gated: the embed page builds
   a /get_video URL from a lightly-obfuscated string whose junk prefix is sliced
   off with .substring(). We rebuild that URL server-side and play the resulting
   MP4 in our own <video> via /stream. The token is bound to the requesting IP,
   so playback must go through our proxy (the same IP that minted the token).
   Fragile by nature — falls back to the normal iframe if the scheme changes.

   (DoodStream used to have an equivalent bypass, but its mirrors now sit behind a
   Cloudflare *managed* JS challenge that can't be solved server-side, so it was
   removed.) */

function isStreamtapeHost(host) {
  return /streamtape|str[ae]?tape|stape|tapecontent|streamadblock/i.test(host || '');
}

// Some embed hosts 403 Node's fetch (flagged TLS fingerprint) but allow the
// system curl binary, so we use curl for the text fetches. -w appends the final
// (post-redirect) URL after a marker so we can recover the real origin after any
// mirror redirect.
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
function curlFetch(url, referer) {
  return new Promise((resolve, reject) => {
    execFile(CURL, ['-k', '-s', '-L', '-m', '25', '-A', UA, '-e', referer || (new URL(url).origin + '/'),
      '-w', '\n@@U@@%{url_effective}', url], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const i = stdout.lastIndexOf('\n@@U@@');
      if (i < 0) return resolve({ body: stdout, finalUrl: url });
      resolve({ body: stdout.slice(0, i), finalUrl: stdout.slice(i + 6).trim() });
    });
  });
}

// embed url (https://streamtape.com/e/<id>) -> { url: direct mp4, referer }
// The page sets: getElementById('robotlink').innerHTML =
//   '//streamtape.com/' + ('<junk>get_video?id=...&token=...').substring(n)[.substring(m)]
// Strip the junk prefix per the .substring() calls, then prepend the scheme.
async function resolveStreamtapeMp4(embedUrl) {
  const start = embedUrl.replace('/v/', '/e/');
  const { body: page, finalUrl } = await curlFetch(start, new URL(start).origin + '/');
  const origin = new URL(finalUrl).origin;

  const build = (prefix, inner, subs) => {
    for (const sm of subs.matchAll(/\.substring\((\d+)\)/g)) inner = inner.substring(parseInt(sm[1], 10));
    const path = prefix + inner;                       // //streamtape.com/get_video?...
    if (!/get_video\?id=/.test(path)) return null;
    let url = path.startsWith('//') ? 'https:' + path : path.startsWith('http') ? path : origin + path;
    if (!/[?&]stream=1\b/.test(url)) url += '&stream=1';
    return url;
  };

  // Prefer #robotlink (the element Streamtape's own player reads); the page also
  // sprinkles decoy elements, so fall back to scanning every innerHTML concat.
  const rl = page.match(/getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]+)['"]\s*\)((?:\s*\.substring\(\d+\))+)/i);
  if (rl) { const u = build(rl[1], rl[2], rl[3]); if (u) return { url: u, referer: origin + '/' }; }

  const re = /innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]+)['"]\s*\)((?:\s*\.substring\(\d+\))+)/gi;
  let m;
  while ((m = re.exec(page))) { const u = build(m[1], m[2], m[3]); if (u) return { url: u, referer: origin + '/' }; }
  return null;
}

// sign a /stream target so the proxy only serves URLs we minted (no open proxy)
function streamSig(u, r) {
  return crypto.createHash('sha256').update(`${u}|${r}|${authToken}`).digest('hex').slice(0, 16);
}

/* --------------------------- MoviesAPI ad-free (HLS) -------------------------
   WatchLuna's "MoviesAPI" server (moviesapi.to) embeds the hd4u.sbs player,
   which wraps the stream in pop-up ads and an IMA pre-roll and refuses headless
   browsers. But its data API isn't Cloudflare-gated, so we skip the player
   entirely: ask moviesapi for the hd4u id, hit hd4u's /api/v1/video, and decrypt
   the AES-CBC blob to recover a plain HLS master. The key/IV are derived in the
   player JS from window.location and resolve to these constants for hd4u.sbs.
   The master + its segments are Referer-locked to hd4u.sbs, so playback goes
   through /tvproxy (which sets that Referer). Fragile — falls back to the normal
   embed if hd4u rotates the scheme. */
const HD4U_KEY = Buffer.from('kiemtienmua911ca');
const HD4U_IV = Buffer.from('1234567890oiuytr');
const HD4U_REFERER = 'https://hd4u.sbs/';

function hd4uDecrypt(hexBody) {
  const hex = String(hexBody).trim().match(/[\da-f]{2}/gi);
  if (!hex) return null;
  const ct = Buffer.from(hex.join(''), 'hex');
  const d = crypto.createDecipheriv('aes-128-cbc', HD4U_KEY, HD4U_IV);
  try { return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')); }
  catch { return null; }
}

// (kind, tmdbId[, season, episode]) -> { m3u8, referer } or null
async function resolveMoviesApiHls(kind, id, season, episode) {
  const apiPath = kind === 'tv'
    ? `tv/${enc(id)}/${enc(season)}/${enc(episode)}`
    : `movie/${enc(id)}`;
  // moviesapi -> hd4u player id (the hash up to the first '&': #<id>&poster=…)
  let vid;
  try {
    const { body } = await curlFetch(`https://ww2.moviesapi.to/api/${apiPath}`, 'https://moviesapi.to/');
    vid = new URL(JSON.parse(body).video_url).hash.replace(/^#/, '').split('&')[0];
  } catch { return null; }
  if (!vid) return null;

  // Each call to /api/v1/video mints a fresh, token-bound master on a rotating
  // CDN IP that occasionally 502s — re-mint and retry a few times. A 404 means
  // the title isn't provisioned here, so give up and let /play use the embed.
  for (let attempt = 0; attempt < 3; attempt++) {
    let src;
    try {
      const { body: blob } = await curlFetch(
        `https://hd4u.sbs/api/v1/video?id=${enc(vid)}&w=1920&h=1080&r=moviesapi.to`, HD4U_REFERER);
      const j = hd4uDecrypt(blob);
      src = j && j.source;
    } catch { src = null; }
    if (!src || !/\.m3u8/i.test(src)) return null;
    try {
      const opts = { headers: { 'User-Agent': UA, Referer: HD4U_REFERER, Accept: '*/*' }, redirect: 'follow' };
      if (insecureAgent) opts.dispatcher = insecureAgent;
      const probe = await fetch(src, opts);
      try { await probe.arrayBuffer(); } catch { /* drain */ }
      if (probe.status === 404) return null;            // not provisioned -> embed
      if (probe.ok) return { m3u8: src, referer: HD4U_REFERER };
    } catch { /* transient network blip — retry */ }
  }
  return null;
}

/* ---------------------------------- providers -------------------------------
   Each provider returns the same unified data model so the routes and rendering
   stay generic. A "source" is chosen after login and stored in the mpsrc cookie. */

// --- 8filmai (WordPress / DooPlay, server-rendered HTML) ---
const EIGHT = {
  id: '8filmai',
  async home() {
    return parseHome(await getPage('/'));
  },
  async archive(kind, page) {
    const base = kind === 'serialai' ? '/serialai' : '/filmas';
    const path = page > 1 ? `${base}/page/${page}/` : `${base}/`;
    const items = parseArchive(await getPage(path));
    return { items, hasMore: items.length >= 10 };
  },
  async search(q) {
    return parseSearch(await getPage('/?s=' + enc(q), 60 * 1000));
  },
  async detail(type, id) {
    const d = parseDetail(await getPage(`/${type}/${enc(id)}/?old`));
    if (!d.title) throw new Error('Nepavyko perskaityti puslapio (gal pasikeitė šaltinio struktūra?)');
    d.backUrl = `/t/${type}/${enc(id)}`;
    const pl = (s, ep) =>
      `/play?source=8filmai&post=${enc(s.post)}&type=${enc(s.type)}&nume=${enc(s.nume)}` +
      `&t=${enc(d.title + (ep ? ' – ' + ep : ''))}${ep ? `&ep=${enc(ep)}` : ''}&back=${enc(d.backUrl)}`;
    if (d.kind === 'movie') {
      d.servers = (d.servers || []).map(s => ({
        name: s.name || 'Serveris', tag: s.tag, isTrailer: s.nume === 'trailer', play: pl(s),
      }));
    } else {
      d.episodes = (d.episodes || []).map(ep => ({
        label: ep.label,
        servers: ep.servers.map(s => ({ name: s.name, tag: s.tag, play: pl(s, ep.label) })),
      }));
    }
    return d;
  },
  async play({ post, type, nume }) {
    if (!post || !type || !nume) throw new Error('Trūksta grotuvo parametrų');
    const embed = await resolveEmbed(post, type, nume);
    if (!embed) throw new Error('Serveris negrąžino grotuvo nuorodos');
    let src = embed.startsWith('http') ? embed : SOURCE + embed;
    // The source's p2.php wrapper would force the browser to hit the source IP
    // (untrusted cert on many TV browsers). Extract the real player instead.
    if (new URL(src).host === new URL(SOURCE).host) {
      const clean = await resolveClean(src);
      if (clean) src = clean;
    }
    return src;
  },
};

// --- WatchLuna (catalog metadata from TMDB; playback via tmdb-id embed hosts) ---
// WatchLuna's own site sits behind a Cloudflare JS challenge that 403s any
// server-side fetch. Its API was only ever a thin proxy over TMDB (same field
// names, same ids), and the embed hosts below take TMDB ids directly — so we
// query TMDB ourselves. Works on any server with a free TMDB_API_KEY, no browser.
const WL_SERVERS = [
  { id: 1, name: 'Serveris 1', tag: 'VidSrc',
    // ds_lang preselects the subtitle language in the VidSrc player; without
    // it the player starts with subtitles off
    movie: (id, sub) => `https://vidsrc-embed.ru/embed/movie?tmdb=${id}${sub ? `&ds_lang=${sub}` : ''}`,
    tv: (id, s, e, sub) => `https://vidsrc-embed.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}${sub ? `&ds_lang=${sub}` : ''}` },
  { id: 2, name: 'Serveris 2', tag: 'MoviesAPI',
    movie: id => `https://moviesapi.to/movie/${id}`,
    tv: (id, s, e) => `https://moviesapi.to/tv/${id}-${s}-${e}` },
  { id: 3, name: 'Serveris 3', tag: 'MultiEmbed',
    movie: id => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
];

function wlImg(p) {
  if (!p) return '';
  return /^https?:/.test(p) ? p : 'https://image.tmdb.org/t/p/w500' + (p.startsWith('/') ? p : '/' + p);
}

async function tmdb(p) {
  if (!TMDB_KEY) throw new Error('Nenustatytas TMDB_API_KEY — gauk nemokamą raktą iš themoviedb.org ir įrašyk į .env');
  const key = 'tmdb:' + p;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.html;
  const url = `${TMDB_BASE}${p}${p.includes('?') ? '&' : '?'}api_key=${TMDB_KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`TMDB grąžino ${res.status}`);
  const j = await res.json();
  cache.set(key, { html: j, exp: Date.now() + (p.includes('/search') ? 60 * 1000 : 5 * 60 * 1000) });
  return j;
}

function wlItem(o) {
  const mt = o.media_type || (o.title ? 'movie' : (o.name ? 'tv' : 'movie'));
  const isTv = mt === 'tv';
  return {
    url: `/t/${isTv ? 'tv' : 'movie'}/${o.id}`,
    title: o.title || o.name || '',
    poster: wlImg(o.poster_path),
    rating: o.vote_average ? Number(o.vote_average).toFixed(1) : '',
    year: String(o.release_date || o.first_air_date || '').slice(0, 4),
    episodes: '',
    kind: isTv ? 'serialai' : 'filmas',
  };
}

const WL = {
  id: 'watchluna',
  async home() {
    const [mv, tv] = await Promise.all([tmdb('/trending/movie/week'), tmdb('/trending/tv/week')]);
    return [
      { title: 'Populiarūs filmai', items: (mv.results || []).map(o => wlItem({ ...o, media_type: 'movie' })) },
      { title: 'Populiarūs serialai', items: (tv.results || []).map(o => wlItem({ ...o, media_type: 'tv' })) },
    ].filter(s => s.items.length);
  },
  async archive(kind, page) {
    const isTv = kind === 'serialai';
    const j = await tmdb(`/${isTv ? 'tv' : 'movie'}/popular?page=${page}`);
    const items = (j.results || []).map(o => wlItem({ ...o, media_type: isTv ? 'tv' : 'movie' }));
    return { items, hasMore: !!items.length && page < (j.total_pages || 1) };
  },
  async search(q) {
    const j = await tmdb('/search/multi?query=' + enc(q));
    return (j.results || [])
      .filter(o => o.media_type === 'movie' || o.media_type === 'tv')
      .map(o => {
        const it = wlItem(o);
        const orig = (o.original_title && o.original_title !== it.title) ? o.original_title
          : (o.original_name && o.original_name !== it.title) ? o.original_name : '';
        return { url: it.url, title: it.title, original: orig, poster: it.poster, rating: it.rating, year: it.year, desc: o.overview || '', kind: it.kind };
      });
  },
  async detail(type, id) {
    const backUrl = `/t/${type}/${enc(id)}`;
    if (type === 'movie') {
      const m = await tmdb('/movie/' + enc(id));
      if (!m || !m.id) throw new Error('Filmas nerastas');
      const title = m.title || m.original_title || '';
      const imdbId = (m.imdb_id || '').replace(/^tt/, '');
      const pl = srv => `/play?source=watchluna&kind=movie&id=${enc(id)}&server=${srv}` +
        `${imdbId ? `&imdb=${enc(imdbId)}` : ''}&t=${enc(title)}&back=${enc(backUrl)}`;
      return {
        kind: 'movie', backUrl, title,
        original: (m.original_title && m.original_title !== title) ? m.original_title : '',
        // numeric imdb id (no "tt") — the LT-subtitle check queries OpenSubtitles with it
        imdbId,
        poster: wlImg(m.poster_path), year: String(m.release_date || '').slice(0, 4), imdb: '',
        runtime: m.runtime ? `${m.runtime} min` : '', lang: (m.original_language || '').toUpperCase(),
        genres: (m.genres || []).map(g => g.name),
        rating: m.vote_average ? Number(m.vote_average).toFixed(1) : '', votes: m.vote_count || '',
        description: m.overview || '', cast: [],
        servers: WL_SERVERS.map(s => ({ name: s.name, tag: s.tag, play: pl(s.id) })),
      };
    }
    const t = await tmdb('/tv/' + enc(id) + '?append_to_response=external_ids');
    if (!t || !t.id) throw new Error('Serialas nerastas');
    const title = t.name || t.original_name || '';
    const imdbId = ((t.external_ids && t.external_ids.imdb_id) || '').replace(/^tt/, '');
    const episodes = [];
    for (const se of (t.seasons || [])) {
      if (se.season_number == null || se.season_number === 0 || !se.episode_count) continue;
      for (let e = 1; e <= se.episode_count; e++) {
        const label = `S${se.season_number} E${e}`;
        episodes.push({
          label,
          servers: WL_SERVERS.map(s => ({
            name: s.name, tag: s.tag,
            play: `/play?source=watchluna&kind=tv&id=${enc(id)}&server=${s.id}&season=${se.season_number}&episode=${e}` +
              `${imdbId ? `&imdb=${enc(imdbId)}` : ''}&t=${enc(title + ' – ' + label)}&ep=${enc(label)}&back=${enc(backUrl)}`,
          })),
        });
      }
    }
    return {
      kind: 'series', backUrl, title,
      original: (t.original_name && t.original_name !== title) ? t.original_name : '',
      imdbId,
      poster: wlImg(t.poster_path), year: String(t.first_air_date || '').slice(0, 4), imdb: '',
      runtime: t.number_of_seasons ? `${t.number_of_seasons} sez.` : '', lang: (t.original_language || '').toUpperCase(),
      genres: (t.genres || []).map(g => g.name),
      rating: t.vote_average ? Number(t.vote_average).toFixed(1) : '', votes: t.vote_count || '',
      description: t.overview || '', cast: [], episodes,
    };
  },
  play({ kind, id, server, season, episode, sub }) {
    const s = WL_SERVERS.find(x => String(x.id) === String(server)) || WL_SERVERS[0];
    const lang = (sub === 'lt' || sub === 'en') ? sub : ''; // default: subtitles off
    return kind === 'tv' ? s.tv(id, season, episode, lang) : s.movie(id, lang);
  },
};

// --- TOPfilmai (DataLife Engine; LT-dubbed catalog, direct-MP4 playback) ---
// A custom DLE site (not DooPlay), so it gets its own cheerio parsers. The win
// is playback: every title embeds Playerjs with a *direct* MP4 from the
// filmaito.top CDN — movies as a single signed file, series as a JSON playlist
// of episodes. No ad-wrapper, no embed host, no DRM. The CDN is Referer-locked,
// so the browser can't fetch it itself; /play hands the MP4 to /stream (which
// sets the Referer) and we play it in our own <video>. Movie URLs carry an
// expiring token, so they're re-resolved from the (cached) detail page at click
// time rather than baked into the catalog.

// The CDN's Referer allowlist accepts this and the source IP, but NOT the
// topfilmai.org domain (it 403s) — so we pin a constant independent of the
// front-end host instead of deriving it from TOPFILMAI.
const TF_STREAM_REFERER = 'https://filmaito.top/';

async function tfGet(slug, ttlMs = 5 * 60 * 1000) {
  const url = slug.startsWith('http') ? slug : TOPFILMAI + (slug.startsWith('/') ? slug : '/' + slug);
  const key = 'tf:' + url;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.html;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': TOPFILMAI + '/', 'Accept-Language': 'lt,en;q=0.8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Šaltinis grąžino ${res.status} (${url})`);
  const html = await res.text();
  cache.set(key, { html, exp: Date.now() + ttlMs });
  return html;
}

function tfImg(src) {
  if (!src) return '';
  src = src.trim();
  if (/^https?:/.test(src) || src.startsWith('data:')) return src;
  return TOPFILMAI + (src.startsWith('/') ? src : '/' + src);
}

// kind from the card's first category chip ("Filmai"/"Serialai"/"Animacija");
// "Animacija" alone is ambiguous, so fall back to a "… N sezonas" title check
function tfCardKind($c) {
  const first = ($c.find('.krasik__meta .flex-1').first().text().split(',')[0] || '').trim().toLowerCase();
  if (first.startsWith('serial')) return 'serialai';
  if (first.startsWith('film')) return 'filmas';
  return /sezon/i.test($c.find('a.krasik__title').text()) ? 'serialai' : 'filmas';
}

// article card href -> local detail path. The kind is encoded in the type
// (tff = film, tfs = series) so watched/wishlist know it without re-fetching.
// Article slugs are one hyphenated segment (filmas-…-online); category pages
// (filmai, metai/2023) are single words or have a slash — those are skipped.
function tfLocal(href, kind) {
  let slug = href || '';
  try { slug = new URL(href, TOPFILMAI + '/').pathname; } catch { /* maybe already a path */ }
  slug = slug.replace(/^\/+|\/+$/g, '');
  if (!slug || slug.includes('/') || !slug.includes('-')) return null;
  return `/t/${kind === 'serialai' ? 'tfs' : 'tff'}/${slug}`;
}

function tfParseCards($, scope) {
  const items = [];
  $(scope).find('.krasik').each((_, el) => {
    const $c = $(el);
    const a = $c.find('a.krasik__title').first();
    const kind = tfCardKind($c);
    const url = tfLocal(a.attr('href'), kind);
    if (!url) return;
    items.push({
      url,
      title: a.text().trim(),
      poster: tfImg($c.find('.krasik__img img').first().attr('src')),
      rating: ($c.find('.krasik__label').first().text().match(/[\d.]+/) || [''])[0],
      year: $c.find('.krasik__year').first().text().trim(),
      episodes: '',
      kind,
    });
  });
  const seen = new Set();
  return items.filter(i => !seen.has(i.url) && seen.add(i.url));
}

// the file: argument of new Playerjs({...}) — a single MP4 (movie) or a JSON
// playlist of {title,file} episodes (series, listed newest-first by the site).
// The series array is tried first because its objects also contain a quoted
// "file": key that the movie regex would otherwise match.
function tfPlaylist(html) {
  const arr = html.match(/file\s*:\s*(\[[\s\S]*?\])/);
  if (arr) {
    try {
      const list = JSON.parse(arr[1]).filter(x => x && x.file);
      if (list.length) return { kind: 'series', list };
    } catch { /* not the playlist array */ }
  }
  const m = html.match(/file\s*:\s*["']([^"']+\.mp4[^"']*)["']/i);
  return m ? { kind: 'movie', file: m[1] } : null;
}

function tfTrailer(html) {
  const m = html.match(/youtube\.com\/embed\/([\w-]{6,})/i);
  return m ? m[1] : null;
}

function tfParseDetail(html) {
  const $ = cheerio.load(html);
  const d = { original: '', votes: '', cast: [], genres: [] };
  d.title = $('.zfx__main-header h1').first().text().trim();
  d.poster = tfImg($('.zfx__img img').first().attr('src'));
  d.rating = $('.zfx__list-rates-item.imdb').first().text().trim();
  d.imdb = d.rating;
  $('.zfx__list > li').each((_, li) => {
    const $li = $(li);
    const label = $li.find('span').first().text().trim().toLowerCase();
    const vals = $li.find('a').map((__, a) => $(a).text().trim()).get().filter(Boolean);
    if (label.startsWith('metai')) d.year = vals[0] || '';
    else if (label.startsWith('kalba')) d.lang = vals[0] || '';
    else if (label.startsWith('žanr') || label.startsWith('zanr'))
      d.genres = vals.filter(g => !/^(Filmai|Serialai|Animacija)$/i.test(g));
    else if (label.startsWith('trukm')) d.runtime = (vals[0] || '').replace(/\s+/g, ' ').trim();
  });
  d.description = $('.zfx__text .full-text').first().text().replace(/\s+/g, ' ').trim();
  return d;
}

const TF = {
  id: 'topfilmai',
  async home() {
    const $ = cheerio.load(await tfGet('/'));
    const labels = { 'Filmai': 'Naujausi filmai', 'Serialai': 'Naujausi serialai' };
    const sections = [];
    $('.marlo').each((_, el) => {
      const $m = $(el);
      const items = tfParseCards($, $m.find('.marlo__content'));
      if (!items.length) return;
      const raw = $m.find('.marlo__title').first().text().trim();
      sections.push({ title: labels[raw] || raw || 'Naujausi', items });
    });
    return sections;
  },
  async archive(kind, page) {
    const base = kind === 'serialai' ? '/serialai' : '/filmai';
    const slug = page > 1 ? `${base}/page/${page}/` : `${base}/`;
    const $ = cheerio.load(await tfGet(slug));
    const items = tfParseCards($, '#dle-content');
    return { items, hasMore: items.length >= 12 };
  },
  async search(q) {
    const $ = cheerio.load(await tfGet(
      `/index.php?do=search&subaction=search&story=${enc(q)}`, 60 * 1000));
    return tfParseCards($, '#dle-content').map(i => ({
      url: i.url, title: i.title, original: '', poster: i.poster,
      rating: i.rating, year: i.year, desc: '', kind: i.kind,
    }));
  },
  async detail(type, id) {
    const html = await tfGet('/' + id);
    const d = tfParseDetail(html);
    if (!d.title) throw new Error('Nepavyko perskaityti puslapio (gal pasikeitė šaltinio struktūra?)');
    const backUrl = `/t/${type}/${enc(id)}`;
    d.backUrl = backUrl;
    const pl = tfPlaylist(html);
    const trailerId = tfTrailer(html);

    if (pl && pl.kind === 'series') {
      d.kind = 'series';
      // Playerjs lists episodes newest-first; show them oldest-first but keep
      // the raw array index in the play link — play() re-parses the same array
      // and picks the file by that index.
      d.episodes = pl.list
        .map((it, i) => ({ i, label: (it.title || `${i + 1} serija`).trim() }))
        .reverse()
        .map(e => ({
          label: e.label,
          servers: [{
            name: 'Žiūrėti', tag: 'LT',
            play: `/play?source=topfilmai&id=${enc(id)}&kind=tv&epi=${e.i}` +
              `&t=${enc(d.title + ' – ' + e.label)}&ep=${enc(e.label)}&back=${enc(backUrl)}`,
          }],
        }));
    } else {
      d.kind = 'movie';
      d.servers = pl ? [{
        name: 'Žiūrėti', tag: 'LT',
        play: `/play?source=topfilmai&id=${enc(id)}&kind=movie&t=${enc(d.title)}&back=${enc(backUrl)}`,
      }] : [];
      if (trailerId) d.servers.push({
        name: 'Anonsas', tag: 'YouTube', isTrailer: true,
        play: `/play?source=topfilmai&id=${enc(id)}&kind=trailer&yt=${enc(trailerId)}` +
          `&nume=trailer&t=${enc(d.title + ' – anonsas')}&back=${enc(backUrl)}`,
      });
    }
    // Optional: play in the site's own Playerjs (richer controls + a built-in
    // episode list for series) instead of our bare <video>. Only when there's
    // something to play.
    if (pl) d.sitePlayer = `/play?source=topfilmai&id=${enc(id)}&kind=site` +
      `&t=${enc(d.title)}&back=${enc(backUrl)}`;
    return d;
  },
  async play({ id, kind, epi, yt }) {
    if (kind === 'trailer') {
      if (!yt) throw new Error('Nėra anonso');
      return { embed: `https://www.youtube.com/embed/${enc(yt)}?autoplay=1` };
    }
    const html = await tfGet('/' + id);
    const pl = tfPlaylist(html);
    if (!pl) throw new Error('Nepavyko rasti vaizdo nuorodos');

    // The site's own player: hand Playerjs the whole playlist (a single file for
    // a movie, every episode for a series) so it renders exactly like the source
    // — each file still routed through /stream so the Referer lock is satisfied.
    if (kind === 'site') {
      const files = pl.kind === 'series'
        ? pl.list.map(it => ({ title: (it.title || '').trim(), url: it.file }))
        : [{ title: '', url: pl.file }];
      return { site: true, poster: tfParseDetail(html).poster, referer: TF_STREAM_REFERER, files };
    }

    let file;
    if (pl.kind === 'series') {
      const i = parseInt(epi, 10);
      file = (Number.isInteger(i) && pl.list[i] && pl.list[i].file) || (pl.list[0] && pl.list[0].file);
    } else {
      file = pl.file;
    }
    if (!file) throw new Error('Nepavyko rasti vaizdo nuorodos');
    return { mp4: file, referer: TF_STREAM_REFERER };
  },
};

const SOURCES = {
  '8filmai': { id: '8filmai', name: '8filmai', emoji: '🇱🇹', desc: 'Lietuviškai įgarsinti filmai ir serialai', provider: EIGHT },
  'topfilmai': { id: 'topfilmai', name: 'TOPfilmai', emoji: '🎬', desc: 'Lietuviški filmai ir serialai — be reklamų', provider: TF },
  'watchluna': { id: 'watchluna', name: 'WatchLuna', emoji: '🌙', desc: 'Platus angliškas filmų ir serialų katalogas', provider: WL },
};
const PROVIDER_BY_TYPE = { filmas: EIGHT, serialai: EIGHT, movie: WL, tv: WL, tff: TF, tfs: TF };
const SOURCE_BY_PROVIDER = id => Object.values(SOURCES).find(s => s.provider.id === id);

function activeSourceId(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mpsrc=([a-z0-9]+)/i);
  return m && SOURCES[m[1]] ? m[1] : null;
}
function activeProvider(req) {
  const id = activeSourceId(req);
  return id ? SOURCES[id].provider : null;
}

/* -------------------------------- rendering -------------------------------- */

function layout(title, body, { query = '', active = '', source = '', hideNav = false } = {}) {
  // IPTV (Live TV) mode hides the movie/series-only items (Filmai, Serialai and
  // the search bar), since they don't apply to live channels.
  const iptv = active === 'tv';
  const nav = hideNav ? '' : [
    ['/', 'Pradžia', 'home'],
    ['/filmai', 'Filmai', 'filmai'],
    ['/serialai', 'Serialai', 'serialai'],
    ['/sarasas', 'Sąrašas', 'wishlist'],
  ].filter(([, , key]) => !(iptv && (key === 'filmai' || key === 'serialai')))
    .map(([href, label, key]) =>
    `<a class="navlink${active === key ? ' active' : ''}" href="${href}">${label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${asset('/favicon.svg')}" type="image/svg+xml">
<link rel="alternate icon" href="${asset('/favicon.png')}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${asset('/apple-touch-icon.png')}">
<meta name="theme-color" content="#14151a">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${asset('/tv.css')}">
</head>
<body>
<header class="topbar">
  <a class="logo" href="/">🎬 Filmai</a>
  ${hideNav ? '' : `<nav>${nav}</nav>
  ${iptv ? '' : `<form class="search" action="/search" method="get">
    <input type="search" name="q" placeholder="Ieškoti filmo ar serialo..." value="${esc(query)}" enterkeyhint="search">
    <button type="submit">Ieškoti</button>
  </form>`}`}
  ${source ? `<a class="navlink source-switch" href="/sources" title="Keisti šaltinį">${esc(source)} ⇄</a>` : ''}
  <a class="navlink logout" href="/logout">Atsijungti</a>
</header>
<main>
${body}
</main>
<script src="${asset('/tv.js')}"></script>
</body>
</html>`;
}

function cardGrid(items) {
  return `<div class="grid">` + items.map(i => {
    const seen = !!watched[watchedKey(i.url)];
    return `
  <a class="card${seen ? ' is-watched' : ''}" href="${esc(i.url)}">
    <div class="poster">
      <img loading="lazy" src="${esc(i.poster)}" alt="${esc(i.title)}">
      ${i.rating ? `<span class="badge">★ ${esc(String(i.rating).replace(/[^\d.,]/g, ''))}</span>` : ''}
      ${i.episodes ? `<span class="badge eps">${esc(i.episodes)} ser.</span>` : ''}
      ${i.kind === 'serialai' ? `<span class="badge kind">Serialas</span>` : ''}
      ${seen ? `<span class="badge watched">✓ Žiūrėta</span>` : ''}
    </div>
    <div class="card-title">${esc(i.title)}</div>
  </a>`;
  }).join('') + `</div>`;
}

// the ad-free play URL for a server list, or null if no ad-free-capable server.
// 8filmai's Streamtape -> &bypass=1 (direct MP4); WatchLuna's MoviesAPI ->
// &adfree=1 (decrypted HLS). Both render in our own player instead of an ad iframe.
function adFreeHref(servers) {
  const st = (servers || []).find(s => /STREAMT/i.test(s.tag || ''));
  if (st) return st.play + '&bypass=1';
  const ma = (servers || []).find(s => /MoviesAPI/i.test(s.tag || ''));
  if (ma) return ma.play + '&adfree=1';
  return null;
}

function detailPage(d, sourceName) {
  const wkey = watchedKey(d.backUrl);
  const wrec = watched[wkey];
  const seenEps = (wrec && wrec.eps) || [];
  const wlKind = /^\/t\/(serialai|tv|tfs)\//.test(wkey || '') ? 'serialai' : 'filmas';
  const inWishlist = !!wishlist[wkey];
  const wishlistBtn = wkey ? `
  <form class="wishlist-form" method="post" action="/wishlist/toggle">
    <input type="hidden" name="key" value="${esc(wkey)}">
    <input type="hidden" name="title" value="${esc(d.title)}">
    <input type="hidden" name="poster" value="${esc(d.poster)}">
    <input type="hidden" name="kind" value="${wlKind}">
    <input type="hidden" name="rating" value="${esc(d.rating || '')}">
    <button type="submit" class="btn wishlist-btn${inWishlist ? ' active' : ''}" aria-pressed="${inWishlist}">
      <span class="wl-on">✓ Sąraše</span><span class="wl-off">+ Į sąrašą</span>
    </button>
  </form>` : '';

  // optional "site's own player" shortcut (TopFilmai) — Playerjs with the source
  // playlist; for a series it carries every episode, so it sits at the top.
  const sitePlayerBtn = d.sitePlayer
    ? `<a class="btn srv siteplayer" href="${esc(d.sitePlayer)}">▶ Originalus grotuvas <small>svetainės</small></a>`
    : '';

  let sources = '';
  if (d.kind === 'movie') {
    // ad-free shortcut, shown before the trailer so it's offered first:
    // 8filmai -> Streamtape direct MP4; WatchLuna -> MoviesAPI HLS extraction.
    const af = adFreeHref(d.servers);
    const adFreeBtn = af ? `<a class="btn srv adfree" href="${esc(af)}">▶ Be reklamų</a>` : '';
    // v2: the same ad-free stream (8filmai MP4 / WatchLuna HLS) but in the
    // Playerjs UI
    const adFreeBtn2 = af
      ? `<a class="btn srv adfree2" href="${esc(af + '&player=pjs')}">▶ Be reklamų v2</a>` : '';
    // v3 (HLS only): native-HLS player, a smart-TV captions test (cues on the
    // video plane survive Tizen fullscreen, where HTML overlays are hidden)
    const adFreeBtn3 = (af && af.endsWith('&adfree=1'))
      ? `<a class="btn srv adfree3" href="${esc(af + '&player=native')}">▶ Be reklamų v3 <small>TV titrai</small></a>` : '';
    sources = `<h2 class="section-title">Šaltiniai</h2>
    <div class="srvlist">` + adFreeBtn + adFreeBtn2 + adFreeBtn3 + (d.servers || []).map(s => `
      <a class="btn srv${s.isTrailer ? ' trailer' : ''}" href="${esc(s.play)}">
        ▶ ${esc(s.name || 'Serveris')}${s.tag ? ` <small>${esc(s.tag)}</small>` : ''}
      </a>`).join('') + sitePlayerBtn + `</div>`;
    if (!(d.servers || []).length) sources += `<p class="empty">Šaltinių nerasta.</p>`;
  } else {
    sources = `<h2 class="section-title">Epizodai</h2>`
      + (sitePlayerBtn ? `<div class="srvlist">${sitePlayerBtn}</div>` : '')
      + (d.episodes || []).map(ep => {
      const epSeen = seenEps.includes(ep.label);
      // ad-free shortcut per episode (Streamtape MP4 or MoviesAPI HLS)
      const af = adFreeHref(ep.servers);
      const adFreeBtn = af
        ? `<a class="btn srv adfree" data-ep="${esc(ep.label)}" href="${esc(af)}">▶ Be reklamų</a>`
        : '';
      const adFreeBtn2 = af
        ? `<a class="btn srv adfree2" data-ep="${esc(ep.label)}" href="${esc(af + '&player=pjs')}">▶ Be reklamų v2</a>`
        : '';
      const adFreeBtn3 = (af && af.endsWith('&adfree=1'))
        ? `<a class="btn srv adfree3" data-ep="${esc(ep.label)}" href="${esc(af + '&player=native')}">▶ Be reklamų v3 <small>TV titrai</small></a>`
        : '';
      return `
    <div class="episode${epSeen ? ' is-watched' : ''}" data-ep="${esc(ep.label)}">
      <div class="ep-label">${esc(ep.label)}${epSeen ? ` <span class="eptick">✓</span>` : ''}</div>
      <div class="ep-servers">` + adFreeBtn + adFreeBtn2 + adFreeBtn3 + ep.servers.map(s => `
        <a class="btn srv" data-ep="${esc(ep.label)}" href="${esc(s.play)}">▶ ${esc(s.name)}${s.tag ? ` <small>${esc(s.tag)}</small>` : ''}</a>`).join('') + `
      </div>
    </div>`;
    }).join('');
    if (!(d.episodes || []).length) sources += `<p class="empty">Epizodų nerasta.</p>`;
  }

  const body = `
  <div class="detail">
    <img class="detail-poster" src="${esc(d.poster)}" alt="${esc(d.title)}">
    <div class="detail-info">
      <h1>${esc(d.title)}</h1>
      ${d.original ? `<div class="orig-title">${esc(d.original)}</div>` : ''}
      <div class="meta-row">
        <span class="chip">${d.kind === 'movie' ? 'Filmas' : 'Serialas'}</span>
        ${d.year ? `<span class="chip">${esc(d.year)}</span>` : ''}
        ${d.imdb ? `<span class="chip">IMDb ${esc(d.imdb)}</span>` : ''}
        ${d.runtime ? `<span class="chip">${esc(d.runtime)}</span>` : ''}
        ${d.lang ? `<span class="chip">${esc(d.lang)}</span>` : ''}
        ${d.rating ? `<span class="chip">★ ${esc(d.rating)}${d.votes ? ` (${esc(d.votes)})` : ''}</span>` : ''}
        ${d.imdbId ? `<span class="chip subs-chip" id="lt-subs" hidden></span>` : ''}
      </div>
      ${d.genres.length ? `<div class="meta-row">${d.genres.map(g => `<span class="chip genre">${esc(g)}</span>`).join('')}</div>` : ''}
      ${wrec ? `<div class="meta-row"><span class="chip watched">✓ Žiūrėta</span></div>` : ''}
      ${wishlistBtn ? `<div class="meta-row">${wishlistBtn}</div>` : ''}
      ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
    </div>
  </div>
  ${d.imdbId ? `<div class="meta-row subs-row" id="sub-pick">
    <span class="subs-label">Subtitrai:</span>
    <button type="button" class="chip subs-pick active" data-sub="off">Išjungta</button>
    <button type="button" class="chip subs-pick" data-sub="en">EN</button>
    <button type="button" class="chip subs-pick" data-sub="lt" hidden>LT</button>
  </div>` : ''}
  ${sources}
  ${d.cast && d.cast.length ? `<h2 class="section-title">Vaidina</h2>
  <div class="cast">` + d.cast.map(c => `
    <div class="person">
      <img loading="lazy" src="${esc(c.img)}" alt="">
      <div class="person-name">${esc(c.name)}</div>
      <div class="person-role">${esc(c.role)}</div>
    </div>`).join('') + `</div>` : ''}
  ${d.imdbId ? `<script>
  /* The VidSrc player pulls its subtitle list from the free OpenSubtitles REST
     API by imdb id — query the same endpoint to show whether LT subs exist
     (the LT button appears only then). The picker choice is written into every
     play link as &sub=, which /play turns into the embed's ds_lang; the
     default is off (no ds_lang — the player starts without subtitles). */
  (function () {
    var el = document.getElementById('lt-subs');
    var pick = document.getElementById('sub-pick');
    fetch('https://rest.opensubtitles.org/search/imdbid-${esc(d.imdbId)}/sublanguageid-lit')
      .then(function (r) { return r.json(); })
      .then(function (a) {
        var yes = a && a.length;
        el.textContent = yes ? '✓ LT subtitrai' : 'LT subtitrų nėra';
        el.className = 'chip subs-chip ' + (yes ? 'subs-yes' : 'subs-no');
        el.hidden = false;
        if (yes) pick.querySelector('button[data-sub="lt"]').hidden = false;
      })
      .catch(function () {});

    pick.addEventListener('click', function (e) {
      var b = e.target;
      if (!b.getAttribute || !b.getAttribute('data-sub')) return;
      var code = b.getAttribute('data-sub');
      var btns = pick.querySelectorAll('button[data-sub]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].className = 'chip subs-pick' + (btns[i] === b ? ' active' : '');
      }
      var links = document.querySelectorAll('a.btn.srv');
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute('href');
        if (href.indexOf('/play?') !== 0) continue;
        if (href.indexOf('sub=') !== -1) href = href.replace(/([?&])sub=[a-z]+/, '$1sub=' + code);
        else href += '&sub=' + code;
        links[j].setAttribute('href', href);
      }
    });
  })();
  </script>` : ''}`;
  return layout(d.title, body, { source: sourceName });
}

function errorPage(res, err, backUrl = '/') {
  res.status(502).send(layout('Klaida', `
  <div class="errorbox">
    <h1>Nepavyko pasiekti šaltinio</h1>
    <p>${esc(err.message || String(err))}</p>
    <a class="btn" href="${esc(backUrl)}">Grįžti</a>
    <a class="btn" href="">Bandyti dar kartą</a>
    <a class="btn alt" href="/sources">Keisti šaltinį</a>
  </div>`));
}

/* ---------------------------------- routes --------------------------------- */

app.get('/sources', (req, res) => {
  // IPTV is "current" when it was the last thing picked (mpiptv flag, set by
  // /set-source?src=iptv); otherwise the current movie source (mpsrc) is.
  const iptvCurrent = /(?:^|;\s*)mpiptv=1\b/.test(req.headers.cookie || '');
  const cur = iptvCurrent ? null : activeSourceId(req);
  const cards = Object.values(SOURCES).map(s => `
    <a class="source-card${cur === s.id ? ' active' : ''}" href="/set-source?src=${s.id}">
      <div class="source-emoji">${s.emoji}</div>
      <div class="source-name">${esc(s.name)}</div>
      <div class="source-desc">${esc(s.desc)}</div>
      ${cur === s.id ? `<div class="source-current">✓ Dabartinis</div>` : `<div class="source-pick">Pasirinkti</div>`}
    </a>`).join('');
  // Live TV isn't a movie/series source, so it's not in SOURCES — it's a
  // separate destination offered here instead of in the top nav.
  const iptvCard = `
    <a class="source-card iptv${iptvCurrent ? ' active' : ''}" href="/set-source?src=iptv">
      <div class="source-emoji">📺</div>
      <div class="source-name">IPTV</div>
      <div class="source-desc">Tiesioginė televizija</div>
      ${iptvCurrent ? `<div class="source-current">✓ Dabartinis</div>` : `<div class="source-pick">Pasirinkti</div>`}
    </a>`;
  res.send(layout('Pasirink šaltinį', `
    <div class="sources-intro">
      <h1>Iš kur ieškoti?</h1>
      <p>Pasirink filmų ir serialų šaltinį arba žiūrėk tiesioginę televiziją. Visada gali jį pakeisti viršuje.</p>
    </div>
    <div class="source-grid">${cards}${iptvCard}</div>`, { hideNav: true }));
});

app.get('/set-source', (req, res) => {
  const src = (req.query.src || '').toString();
  // IPTV: remember it as the current selection (mpiptv) and open Live TV
  if (src === 'iptv') {
    res.setHeader('Set-Cookie', 'mpiptv=1; Path=/; Max-Age=31536000; SameSite=Lax');
    return res.redirect('/tv');
  }
  if (!SOURCES[src]) return res.redirect('/sources');
  // a movie source becomes current, clearing the IPTV selection
  res.setHeader('Set-Cookie', [
    `mpsrc=${src}; Path=/; Max-Age=31536000; SameSite=Lax`,
    'mpiptv=; Path=/; Max-Age=0; SameSite=Lax',
  ]);
  res.redirect('/');
});

app.get('/', async (req, res) => {
  const id = activeSourceId(req);
  if (!id) return res.redirect('/sources');
  try {
    const sections = await SOURCES[id].provider.home();
    const body = sections.map(s => `
      <h2 class="section-title">${esc(s.title)}</h2>
      ${cardGrid(s.items)}`).join('');
    res.send(layout('Filmai ir serialai', body, { active: 'home', source: SOURCES[id].name }));
  } catch (e) { errorPage(res, e); }
});

function archiveRoute(kind, label, activeKey) {
  return async (req, res) => {
    const id = activeSourceId(req);
    if (!id) return res.redirect('/sources');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    try {
      const { items, hasMore } = await SOURCES[id].provider.archive(kind, page);
      const base = `/${activeKey}`;
      const pager = `
      <div class="pager">
        ${page > 1 ? `<a class="btn" href="${base}?page=${page - 1}">‹ Ankstesnis</a>` : ''}
        <span class="pageno">${page} psl.</span>
        ${hasMore ? `<a class="btn" href="${base}?page=${page + 1}">Kitas ›</a>` : ''}
      </div>`;
      res.send(layout(label, `<h2 class="section-title">${label}</h2>${cardGrid(items)}${pager}`,
        { active: activeKey, source: SOURCES[id].name }));
    } catch (e) { errorPage(res, e); }
  };
}
app.get('/filmai', archiveRoute('filmai', 'Filmai', 'filmai'));
app.get('/serialai', archiveRoute('serialai', 'Serialai', 'serialai'));

/* -------------------------------- wishlist -------------------------------- */

app.post('/wishlist/toggle', (req, res) => {
  const key = watchedKey((req.body.key || '').toString());
  const inList = toggleWishlist(key, {
    title: (req.body.title || '').toString(),
    poster: (req.body.poster || '').toString(),
    kind: (req.body.kind || 'filmas').toString(),
    rating: (req.body.rating || '').toString(),
  });
  // fetch() callers (progressive enhancement) get JSON; everyone else is
  // redirected back to where they came from so the button re-renders.
  if ((req.headers.accept || '').includes('application/json')) {
    return res.json({ inList });
  }
  res.redirect(key || '/');
});

// Which source/kind a wishlist key belongs to, derived from its /t/<type>/ path:
//   filmas|serialai -> 8filmai,  tff|tfs -> topfilmai,  movie|tv -> watchluna.
function wishlistMeta(key) {
  const m = /^\/t\/(filmas|serialai|movie|tv|tff|tfs)\//.exec(key || '');
  const type = m ? m[1] : 'filmas';
  const sourceId = (type === 'movie' || type === 'tv') ? 'watchluna'
    : (type === 'tff' || type === 'tfs') ? 'topfilmai' : '8filmai';
  return {
    sourceId,
    isSeries: (type === 'serialai' || type === 'tv' || type === 'tfs'),
  };
}

app.get('/sarasas', (req, res) => {
  const entries = Object.entries(wishlist)
    .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
    .map(([url, r]) => ({ url, rec: r, meta: wishlistMeta(url) }));

  // Source order follows the SOURCES definition; movies before series.
  let sections = '';
  for (const sid of Object.keys(SOURCES)) {
    const inSource = entries.filter(e => e.meta.sourceId === sid);
    if (!inSource.length) continue;
    const src = SOURCES[sid];
    let groups = '';
    for (const [label, isSeries] of [['Filmai', false], ['Serialai', true]]) {
      const items = inSource
        .filter(e => e.meta.isSeries === isSeries)
        .map(e => ({ url: e.url, poster: e.rec.poster, title: e.rec.title, kind: e.rec.kind, rating: e.rec.rating }));
      if (!items.length) continue;
      groups += `<h3 class="wl-subtitle">${label} <span class="wl-count">${items.length}</span></h3>${cardGrid(items)}`;
    }
    sections += `<section class="wl-source">
      <h2 class="section-title">${esc(src.emoji)} ${esc(src.name)} <span class="wl-count">${inSource.length}</span></h2>
      ${groups}
    </section>`;
  }

  const body = entries.length
    ? `<h1 class="wl-heading">Mano sąrašas <span class="wl-count">${entries.length}</span></h1>${sections}`
    : `<h2 class="section-title">Mano sąrašas</h2>
       <p class="empty">Sąrašas tuščias. Atidaryk filmą ar serialą ir paspausk „+ Į sąrašą".</p>`;
  const id = activeSourceId(req);
  res.send(layout('Mano sąrašas', body, { active: 'wishlist', source: id ? SOURCES[id].name : '' }));
});

app.get('/search', async (req, res) => {
  const id = activeSourceId(req);
  if (!id) return res.redirect('/sources');
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.redirect('/');
  try {
    const results = await SOURCES[id].provider.search(q);
    const body = `
    <h2 class="section-title">Rezultatai: ${esc(q)} (${results.length})</h2>
    ${results.length ? `<div class="results">` + results.map(r => {
      const seen = !!watched[watchedKey(r.url)];
      return `
      <a class="result${seen ? ' is-watched' : ''}" href="${esc(r.url)}">
        <img loading="lazy" src="${esc(r.poster)}" alt="">
        <div class="result-info">
          <div class="result-title">${esc(r.title)}${r.original ? ` <span class="orig">/ ${esc(r.original)}</span>` : ''}</div>
          <div class="result-meta">
            ${seen ? `<span class="chip watched">✓ Žiūrėta</span>` : ''}
            <span class="chip">${r.kind === 'serialai' ? 'Serialas' : 'Filmas'}</span>
            ${r.rating ? `<span class="chip">★ ${esc(r.rating)}</span>` : ''}
            ${r.year ? `<span class="chip">${esc(r.year)}</span>` : ''}
          </div>
          ${r.desc ? `<p class="result-desc">${esc(r.desc)}</p>` : ''}
        </div>
      </a>`;
    }).join('') + `</div>` : `<p class="empty">Nieko nerasta.</p>`}`;
    res.send(layout(`Paieška: ${q}`, body, { query: q, source: SOURCES[id].name }));
  } catch (e) { errorPage(res, e); }
});

/* -------------------------------- TV routes -------------------------------- */

function channelAbbr(name) {
  const clean = String(name).replace(/\(.*?\)/g, '').trim();
  if (clean.length <= 5) return clean.toUpperCase();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) return clean.slice(0, 3).toUpperCase();
  return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

function channelTile(c) {
  // stable per-name hue so tiles without a logo still look distinct
  let h = 0;
  for (const ch of c.name) h = (h * 31 + ch.codePointAt(0)) % 360;
  const icon = c.logo
    ? `<img class="ch-logo" loading="lazy" src="${esc(c.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;ch-abbr&quot;>${esc(channelAbbr(c.name))}</span>'">`
    : `<span class="ch-abbr" style="background:hsl(${h},45%,30%)">${esc(channelAbbr(c.name))}</span>`;
  // now/next programme placeholders, filled client-side from /tv/epg-now
  const epg = c.epg
    ? `<div class="ch-epg" data-epg="${esc(c.epg)}"><div class="ch-now"></div><div class="ch-next"></div></div>`
    : '';
  return `
    <a class="ch" href="/tv/play?c=${c.idx}">
      <span class="ch-no">${c.idx + 1}</span>
      ${icon}
      <span class="ch-name">${esc(c.name)}</span>
      ${epg}
    </a>`;
}

app.get('/tv', (req, res) => {
  const { groups, missing } = loadIptv();
  // In IPTV the header's source-switch reflects IPTV, not the stored movie source
  const opts = { active: 'tv', source: 'IPTV' };
  if (missing) {
    return res.send(layout('TV', `
      <div class="errorbox">
        <h1>Nerastas kanalų failas</h1>
        <p>Nepavyko sukurti <code>${esc(IPTV_FILE)}</code>. Patikrink, ar yra <code>${esc(IPTV_DEFAULT)}</code>, arba įkelk kanalų sąrašą rankiniu būdu.</p>
      </div>`, opts));
  }
  const body = (groups.map(g => `
    <h2 class="section-title">${esc(g.name)} <small class="count">${g.channels.length}</small></h2>
    <div class="chgrid">${g.channels.map(channelTile).join('')}</div>`).join('')
    || `<p class="empty">Kanalų sąrašas tuščias — papildyk iptv.m3u failą.</p>`)
    + `\n<script src="${asset('/epg-grid.js')}"></script>`;
  res.send(layout('TV kanalai', body, opts));
});

// hls.js player markup (shared by live TV and the MoviesAPI ad-free path).
// directUrl '' skips the browser-direct attempt (for Referer-locked streams that
// only work through the proxy); proxyUrl is the /tvproxy entry point. subTrack is
// an optional <track> (subtitles); initCaptions renders it natively (desktop +
// iOS, where it works windowed and in fullscreen) and falls back to a DOM
// overlay only on smart TVs, which don't paint <track> cues over hls.js/MSE
// video — see initCaptions in iptv.js.
function hlsPlayerInner(directUrl, proxyUrl, embedUrl = '', subTrack = '') {
  // A CSS-only "maximize" button, shown only when there are captions: native
  // fullscreen hands the <video> to a smart-TV hardware plane that's drawn above
  // the web page, hiding our DOM caption overlay. Instead this just blows the
  // player box up to fill the viewport while it stays in the page layer, so the
  // captions ride along and stay visible. See initFakeFs in iptv.js.
  const fsBtn = subTrack
    ? `<button id="tvfs" class="tv-fs" aria-label="Visas ekranas" title="Visas ekranas">⛶</button>`
    : '';
  return `<video id="tvvideo" class="playerframe" controls autoplay playsinline>${subTrack}</video>
    <button id="tvtap" class="tv-tap" hidden aria-label="Paleisti">▶</button>
    <div id="tverr" class="tv-err" hidden>Nepavyko paleisti. <a href="">Bandyti dar kartą</a></div>${fsBtn}
    <script src="${asset('/hls.min.js')}"></script>
    <script src="${asset('/iptv.js')}"></script>
    <script>initIptv(${JSON.stringify(directUrl)}, ${JSON.stringify(proxyUrl)}, ${JSON.stringify(embedUrl)});${subTrack ? `initCaptions(document.getElementById('tvvideo'));initFakeFs(document.getElementById('tvvideo'));` : ''}</script>`;
}

// Bare-<video> player for the ad-free MP4 streams. `src` is the URL the <video>
// loads — ideally a direct CDN URL (8filmai's Streamtape, resolved server-side
// so the client streams straight from the CDN at full speed), otherwise the
// /stream proxy (TopFilmai, whose CDN is Referer-locked and can't be handed to a
// browser). `fallback`, when set, is a /stream proxy URL initMp4 swaps to if the
// direct URL fails on this client. Carries the same tap-to-play / error-retry
// overlays as the hls.js player: smart-TV browsers block autoplay-with-sound
// until a gesture and expose no obvious controls, so a bare autoplaying <video>
// just sits there "not buffering". preload=auto starts the buffer immediately;
// initMp4 shows ▶ when play() is rejected (see iptv.js). referrerpolicy=
// no-referrer because the CDN URL is verified to need no Referer.
function mp4PlayerInner(src, fallback = '') {
  return `<video id="tvvideo" class="playerframe" controls autoplay playsinline preload="auto" referrerpolicy="no-referrer" src="${esc(src)}"></video>
    <button id="tvtap" class="tv-tap" hidden aria-label="Paleisti">▶</button>
    <div id="tverr" class="tv-err" hidden>Nepavyko paleisti. <a href="">Bandyti dar kartą</a></div>
    <script src="${asset('/iptv.js')}"></script>
    <script>initMp4(document.getElementById('tvvideo'), ${JSON.stringify(fallback || '')});</script>`;
}

// Build a Playerjs `file` value from raw URLs, each routed through /stream so
// Referer-locked CDNs keep serving: a single string for one file, or a
// {title,file} playlist array for several. The "/v.mp4" segment is ignored by
// /stream — it just lets Playerjs pick its MP4 engine by extension.
function streamFiles(files, referer) {
  const stream = u => `/stream/v.mp4?` +
    new URLSearchParams({ u, r: referer, s: streamSig(u, referer) }).toString();
  return files.length > 1
    ? files.map(f => ({ title: f.title || '', file: stream(f.url) }))
    : stream(files[0].url);
}

// House subtitle styling for Playerjs, to mirror the .tv-caption overlay our
// hls.js player draws: bigger, semi-bold white text on a translucent black box
// (Playerjs's defaults are small 14px/weight-400 with a near-opaque bg). Colors
// are hex without '#'; sub_bga is a 0–1 alpha; sizes are px.
const PJS_SUB_STYLE = {
  sub_size: 18, sub_size_fullscreen: 28, sub_weight: 600, sub_lineheight: 1.35,
  sub_color: 'ffffff', sub_bg: 1, sub_bgcolor: '000000', sub_bga: 0.6,
  sub_bgpadding: 4, sub_shadow: 1,
};

// Render the vendored Playerjs (public/playerjs.js, served from our origin, no
// domain lock). `file` is the final Playerjs file value — a URL string (MP4 with
// a .mp4-looking path, or HLS with .m3u8 visible in the URL) or a {title,file}
// playlist array. `subtitle`, when set, is Playerjs's "[Label]url" form (the url
// needs a .vtt/.srt in it) and is auto-enabled, styled per PJS_SUB_STYLE. Used
// by the TopFilmai site player and the 8filmai / WatchLuna "Be reklamų v2".
function playerjsInner(file, { subtitle = '', poster = '' } = {}) {
  const safe = v => JSON.stringify(v).replace(/</g, '\\u003c');
  const opts = ['id:"player"'];
  if (poster) opts.push(`poster:${safe(poster)}`);
  opts.push(`file:${safe(file)}`);
  if (subtitle) {
    opts.push(`subtitle:${safe(subtitle)}`);
    for (const [k, v] of Object.entries(PJS_SUB_STYLE)) opts.push(`${k}:${safe(v)}`);
  }
  // Two captions fixes for "v2":
  // 1) Playerjs registers the subtitle track but leaves it OFF behind a settings
  //    submenu — useless on a TV remote, defeating the point of "v2". api(
  //    'subtitle',0) turns the first (only) track on, but only takes once the
  //    <video> is really playing (called before the proxied HLS manifest loads it
  //    just sets the menu label, then no-ops), so we wait for playback to start
  //    and enable exactly once.
  // 2) In fullscreen, captions vanish on smart TVs: the native fullscreen button
  //    fullscreens the bare <video>, dropping Playerjs's caption overlay (a DOM
  //    sibling) off the top layer. When the <video> itself becomes the fullscreen
  //    element we re-target fullscreen to the .player-box container (which holds
  //    both the video and the captions and already has the :fullscreen CSS).
  //    Refusal (desktop Firefox) is caught and harmless. Same trick as
  //    initCaptions in iptv.js.
  const enableSub = subtitle
    ? `(function(){var done=false;function go(){if(done)return;done=true;try{pjsp.api('subtitle',0)}catch(e){}}` +
      `var n=0,iv=setInterval(function(){var v=document.querySelector('#player video');` +
      `if(v){clearInterval(iv);v.addEventListener('playing',go);` +
      `v.addEventListener('timeupdate',function(){if(v.currentTime>0)go()})}else if(++n>60)clearInterval(iv)},200);` +
      `function fsEl(){return document.fullscreenElement||document.webkitFullscreenElement||null}` +
      `function onFs(){var v=document.querySelector('#player video');var b=v&&(v.closest('.player-box')||document.getElementById('player'));` +
      `if(!v||!b||fsEl()!==v)return;var rq=b.requestFullscreen||b.webkitRequestFullscreen;if(!rq)return;` +
      `try{var pr=rq.call(b);if(pr&&pr.catch)pr.catch(function(){})}catch(e){}}` +
      `document.addEventListener('fullscreenchange',onFs);document.addEventListener('webkitfullscreenchange',onFs)})();`
    : '';
  return `<div id="player" class="playerframe"></div>
    <script src="${asset('/playerjs.js')}"></script>
    <script>var pjsp=new Playerjs({${opts.join(',')}});${enableSub}</script>`;
}

// Native-HLS player (experimental, for the "v3" smart-TV captions test). Plays
// the proxied m3u8 via the platform's OWN HLS support (video.src, no hls.js/MSE)
// and shows the subtitle as a native <track>. The point: on Samsung Tizen the
// fullscreen video is a hardware plane that hides HTML caption overlays (what
// hls.js+initCaptions and Playerjs both use), but cues from a native track are
// drawn by the video pipeline itself, so they survive fullscreen. `file` needs a
// visible .m3u8 so native HLS detection kicks in; segments stay Referer-locked,
// so it still goes through /tvproxy. Reuses initMp4's tap-to-play / error overlay.
function nativeHlsPlayerInner(file, subTrack = '') {
  return `<video id="tvvideo" class="playerframe" controls autoplay playsinline preload="auto" src="${esc(file)}">${subTrack}</video>
    <button id="tvtap" class="tv-tap" hidden aria-label="Paleisti">▶</button>
    <div id="tverr" class="tv-err" hidden>Nepavyko paleisti. <a href="">Bandyti dar kartą</a></div>
    <script src="${asset('/iptv.js')}"></script>
    <script>(function(){var v=document.getElementById('tvvideo');initMp4(v,'');
      function subsOn(){try{for(var i=0;i<v.textTracks.length;i++)v.textTracks[i].mode='showing';}catch(e){}}
      v.addEventListener('loadedmetadata',subsOn);v.addEventListener('playing',subsOn);subsOn();})();</script>`;
}

app.get('/tv/play', (req, res) => {
  const { channels } = loadIptv();
  const i = parseInt(req.query.c, 10);
  const c = channels[i];
  if (!c) return res.redirect('/tv');

  // prev/next channel zapper — show the channel name next to the arrow
  const zap = (j, dir) => {
    const ch = channels[j];
    if (!ch) return '';
    const arrow = dir < 0 ? '‹' : '›';
    const name = `<span class="zap-name">${esc(ch.name)}</span>`;
    const label = dir < 0 ? `${arrow} ${name}` : `${name} ${arrow}`;
    return `<a class="btn alt zap" href="/tv/play?c=${j}" title="${esc(ch.name)}">${label}</a>`;
  };
  const buttons = zap(i - 1, -1) + zap(i + 1, 1);

  const yt = youtubeId(c.url);
  const ifr = yt ? null : iframeSrcOf(c.url);
  const inner = yt
    ? `<iframe class="playerframe" src="https://www.youtube-nocookie.com/embed/${esc(yt)}?autoplay=1&playsinline=1" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>`
    : ifr
    ? `<iframe class="playerframe" src="${esc(ifr)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>`
    : hlsPlayerInner(c.url, tvProxyUrl(c.url), c.embed || '');

  res.send(playerShell(c.name, '/tv', inner, buttons, '', c.epg || ''));
});

// current + next programme for every channel that has a guide, as one compact
// JSON map keyed by slug — the /tv grid fetches this once and fills in tiles
app.get('/tv/epg-now', async (req, res) => {
  const { channels } = loadIptv();
  const slugs = [...new Set(channels.map(c => c.epg).filter(Boolean))];
  const out = {};
  await Promise.all(slugs.map(async (slug) => {
    try { out[slug] = epgNowNext(await getEpg(slug)); } catch { out[slug] = null; }
  }));
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.json(out);
});

// EPG schedule for one channel (iptvx.one slug), as JSON for the player sidebar
app.get('/tv/epg', async (req, res) => {
  const id = (req.query.id || '').toString();
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const programs = await getEpg(id);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json({ id, programs: programs || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* Subtitle proxy for the ad-free HLS player: <track> needs same-origin WebVTT,
   but OpenSubtitles serves gzipped SRT (often CP1257 for LT) with no CORS. We
   fetch by imdb id (+ season/episode for TV) using the same API as the LT-subs
   check, decode per its SubEncoding, and convert SRT->VTT. 404 when none exist
   so the track silently doesn't show. Cached a day. */
const SUB_OSL = { lt: 'lit', en: 'eng' };
function srtToVtt(srt) {
  const s = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2') // SRT comma -> VTT dot
    // lift cues off the very bottom (where the controls bar sits): line:85% on
    // each timing line that doesn't already carry cue settings
    .replace(/^(\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d)([^\n]*)$/gm,
      (m, times, rest) => rest.trim() ? m : `${times} line:85%`);
  return 'WEBVTT\n\n' + s;
}
// The optional /:fname segment (e.g. /sub/s.vtt) is ignored — it only lets
// Playerjs recognise the response as a subtitle by its .vtt extension.
app.get(['/sub', '/sub/:fname'], async (req, res) => {
  const imdb = (req.query.imdb || '').toString().replace(/\D/g, '');
  const osl = SUB_OSL[(req.query.lang || '').toString()];
  const se = (req.query.s || '').toString().replace(/\D/g, '');
  const ep = (req.query.e || '').toString().replace(/\D/g, '');
  if (!imdb || !osl) return res.status(400).end();
  const ckey = `sub:${imdb}:${osl}:${se}:${ep}`;
  const hit = cache.get(ckey);
  const serve = (vtt) => {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  };
  if (hit && hit.exp > Date.now()) return serve(hit.html);
  try {
    // OpenSubtitles requires the search tokens in alphabetical order, else it
    // 302-redirects to the sorted URL (which then breaks the JSON fetch).
    const parts = [`imdbid-${imdb}`, `sublanguageid-${osl}`];
    if (se && ep) parts.push(`season-${se}`, `episode-${ep}`);
    parts.sort();
    const r = await fetch(`https://rest.opensubtitles.org/search/${parts.join('/')}`, { headers: { 'User-Agent': UA } });
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) return res.status(404).end();
    const pick = list.find(x => /srt/i.test(x.SubFormat)) || list[0];
    if (!pick.SubDownloadLink) return res.status(404).end();
    const raw = Buffer.from(await (await fetch(pick.SubDownloadLink, { headers: { 'User-Agent': UA } })).arrayBuffer());
    const buf = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw) : raw;
    const enc = (pick.SubEncoding || 'utf-8').toLowerCase().replace(/^cp(\d+)$/, 'windows-$1');
    let srt;
    try { srt = new TextDecoder(enc).decode(buf); } catch { srt = buf.toString('utf8'); }
    const vtt = srtToVtt(srt);
    cache.set(ckey, { html: vtt, exp: Date.now() + 24 * 3600 * 1000 });
    serve(vtt);
  } catch { res.status(502).end(); }
});

/* HLS-aware proxy: playlists get their URIs rewritten back through here,
   everything else (segments, keys, direct mp4/radio) is piped through.
   The optional /:fname segment (e.g. /tvproxy/master.m3u8) is ignored — it only
   lets Playerjs recognise an HLS master by its .m3u8 extension. */
app.get(['/tvproxy', '/tvproxy/:fname'], async (req, res) => {
  const u = (req.query.u || '').toString();
  const r = (req.query.r || '').toString();
  const s = (req.query.s || '').toString();
  if (!u || s !== tvSig(u, r)) return res.status(403).end();
  try {
    // By default no Referer: most CDNs serve fine without one, and a self-origin
    // Referer actively breaks some (e.g. dcdn.lt answers 204 to it). Some streams
    // are Referer-locked though (hd4u.sbs) — r carries the one to send.
    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if (r) headers.Referer = r;
    if (req.headers.range) headers.Range = req.headers.range;
    const opts = { headers, redirect: 'follow' };
    if (insecureAgent) opts.dispatcher = insecureAgent;
    const up = await fetch(u, opts);
    if (!up.ok && up.status !== 206) return res.status(up.status === 404 ? 404 : 502).end();
    const finalUrl = up.url || u;
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    const looksTexty = /mpegurl|json|text|octet-stream/.test(ct) || /\.(m3u8?|php)(\?|$)/i.test(new URL(finalUrl).pathname);

    if (looksTexty) {
      const body = await up.text();
      if (body.trimStart().startsWith('#EXTM3U')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(rewriteM3U8(body, finalUrl, r));
      }
      // JSON wrapper (LRT get_live_url.php, tv3 playlist API, …) — pull the real
      // HLS url out. Handles \/ escaping and protocol-relative //host urls, and
      // prefers a plain HLS source over DRM/Verimatrix (VMX) variants.
      const urls = body.replace(/\\\//g, '/').match(/(?:https?:)?\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*/gi) || [];
      const pick = urls.find(u => /GO3_LIVE_HLS/.test(u)) || urls.find(u => !/VMX|nHLS/i.test(u)) || urls[0];
      if (pick) return res.redirect(tvProxyUrl(pick.startsWith('//') ? 'https:' + pick : pick, r));
      // not a playlist after all (e.g. small text/binary file) — pass through
      res.status(up.status);
      if (ct) res.setHeader('Content-Type', ct);
      return res.send(body);
    }

    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    streamUpstream(up, res);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/t/:type(filmas|serialai|movie|tv|tff|tfs)/:id', async (req, res) => {
  const { type, id } = req.params;
  const provider = PROVIDER_BY_TYPE[type];
  try {
    const d = await provider.detail(type, id);
    res.send(detailPage(d, SOURCE_BY_PROVIDER(provider.id).name));
  } catch (e) { errorPage(res, e, '/'); }
});

// Tagged logger for the ad-free playback path so each play is easy to find in
// the log (which source, proxied vs. embed, and any client-side fallback).
function logAdfree(msg) { console.log(`[adfree ${new Date().toISOString()}] ${msg}`); }

app.get('/play', async (req, res) => {
  const source = (req.query.source || '').toString();
  const provider = SOURCES[source] && SOURCES[source].provider;
  const title = (req.query.t || 'Grotuvas').toString();
  const back = (req.query.back || '/').toString();
  if (!provider) return res.redirect('/');

  // Opening a real provider == watched. The 8filmai trailer doesn't count.
  const key = watchedKey(back);
  if (key && req.query.nume !== 'trailer') {
    const ep = (req.query.ep || '').toString();
    markWatched(key, {
      title: title.split(' – ')[0],
      kind: /^\/t\/(serialai|tv|tfs)\//.test(key) ? 'serialai' : 'filmas',
      ep: ep || undefined,
    });
  }

  try {
    // --- WatchLuna ad-free: pull a clean HLS master from MoviesAPI/hd4u and
    // play it in our own hls.js player through /tvproxy (Referer-locked). ---
    if (source === 'watchluna' && req.query.adfree === '1') {
      const hls = await resolveMoviesApiHls(req.query.kind, req.query.id, req.query.season, req.query.episode);
      if (hls) {
        const proxied = tvProxyUrl(hls.m3u8, hls.referer);
        // the picked LT/EN subtitle (served as VTT by /sub) if one exists
        const sub = (req.query.sub === 'lt' || req.query.sub === 'en') ? req.query.sub : '';
        const imdb = (req.query.imdb || '').toString().replace(/\D/g, '');
        let subSp = null;
        const label = sub === 'lt' ? 'Lietuvių' : 'English';
        if (sub && imdb) {
          subSp = new URLSearchParams({ imdb, lang: sub });
          if (req.query.kind === 'tv') { subSp.set('s', req.query.season); subSp.set('e', req.query.episode); }
        }
        // "v2": the same HLS + subtitle, but in the vendored Playerjs UI. Playerjs
        // picks its HLS engine from the ".m3u8" in the proxied URL, and renders
        // the subtitle itself ([Label]/sub/s.vtt) — so it works even on smart TVs
        // that won't paint <track> cues over hls.js/MSE.
        if (req.query.player === 'pjs') {
          const file = proxied.replace('/tvproxy?', '/tvproxy/master.m3u8?');
          const subtitle = subSp ? `[${label}]/sub/s.vtt?${subSp.toString()}` : '';
          return res.send(playerShell(title, back, playerjsInner(file, { subtitle })));
        }
        const subTrack = subSp
          ? `<track kind="subtitles" srclang="${sub}" label="${esc(label)}" src="/sub?${esc(subSp.toString())}" default>`
          : '';
        // "v3" (experimental, smart-TV captions test): native HLS + native <track>
        // so cues are drawn on the video plane and survive Tizen fullscreen.
        if (req.query.player === 'native') {
          const file = proxied.replace('/tvproxy?', '/tvproxy/master.m3u8?');
          return res.send(playerShell(title, back, nativeHlsPlayerInner(file, subTrack)));
        }
        // default: our own hls.js player, subtitle as a native <track> rendered
        // by initCaptions (with the smart-TV overlay fallback)
        return res.send(playerShell(title, back, hlsPlayerInner('', proxied, '', subTrack)));
      }
      // extraction failed — fall through to the normal embed player
    }

    // --- TOPfilmai: a direct (Referer-locked) MP4 played in our own <video>
    // via /stream, the site's own Playerjs fed the same proxied file(s), or a
    // YouTube trailer in a plain iframe. ---
    if (source === 'topfilmai') {
      const r = await provider.play(req.query);
      if (r && r.mp4) {
        const sq = new URLSearchParams({ u: r.mp4, r: r.referer, s: streamSig(r.mp4, r.referer) });
        logAdfree(`topfilmai PROXY (CDN is referer-locked) — ${title}`);
        return res.send(playerShell(title, back, mp4PlayerInner(`/stream?${sq.toString()}`), ''));
      }
      if (r && r.site && r.files && r.files.length) {
        // the source's own Playerjs UI — playlist + next/prev for a series,
        // single file for a movie (see playerjsInner)
        return res.send(playerShell(title, back, playerjsInner(streamFiles(r.files, r.referer), { poster: r.poster }), ''));
      }
      if (r && r.embed) {
        return res.send(playerShell(title, back, `
    <iframe class="playerframe" src="${esc(r.embed)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="origin"></iframe>`));
      }
      throw new Error('Nepavyko gauti grotuvo nuorodos');
    }

    const src = await provider.play(req.query);
    if (!src) throw new Error('Nepavyko gauti grotuvo nuorodos');

    const stape = isStreamtapeHost(new URL(src).host);
    const wantBypass = req.query.bypass === '1';

    // --- Streamtape bypass: extract the direct MP4 and play it ourselves ---
    if (stape && wantBypass) {
      const direct = await resolveStreamtapeMp4(src);
      if (direct) {
        // Both the get_video gate and the tapecontent CDN URL it 302-redirects to
        // are IP-locked to the resolver (us). Handing the CDN URL to the client (a
        // different IP) now 403s — Streamtape used to leave the redirect target
        // open to any IP, but no longer. So playback must go through /stream, which
        // fetches from our allowed IP and relays the bytes.
        const sq = new URLSearchParams({ u: direct.url, r: direct.referer, s: streamSig(direct.url, direct.referer) });
        const proxied = `/stream?${sq.toString()}`;
        logAdfree(`8filmai PROXY — ${title}`);
        // "v2" plays the same stream in the vendored Playerjs UI instead of a
        // bare <video> (handy for comparing players across sources)
        if (req.query.player === 'pjs') {
          return res.send(playerShell(title, back, playerjsInner(streamFiles([{ url: direct.url }], direct.referer)), ''));
        }
        return res.send(playerShell(title, back, mp4PlayerInner(proxied)));
      }
      // extraction failed — fall through to the normal iframe with a note
    }

    const bypassBtn = stape && !wantBypass
      ? `<a class="btn alt" href="/play?${esc(new URLSearchParams({ ...req.query, bypass: '1' }).toString())}">Be reklamų (bandyti)</a>`
      : '';
    const note = stape && wantBypass
      ? `<div class="player-note">Nepavyko apeiti reklamų — rodomas originalus grotuvas.</div>` : '';

    res.send(playerShell(title, back, `
    <iframe class="playerframe" src="${esc(src)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="origin"></iframe>`, bypassBtn, note));
  } catch (e) { errorPage(res, e, back); }
});

// Client beacons here when the ad-free player swaps from the direct CDN URL to
// the /stream proxy, or errors out — so fallbacks surface in the server log
// instead of only on the device. Best-effort; returns 204 and never blocks
// playback. (sendBeacon POSTs, the Image() fallback GETs — accept both.)
app.all('/clientlog', (req, res) => {
  const ev = (req.query.ev || '').toString().slice(0, 40);
  const t = (req.query.t || '').toString().slice(0, 120);
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 140);
  logAdfree(`client: ${ev} — ${t} [${ua}]`);
  res.status(204).end();
});

function playerShell(title, back, inner, extraBtn = '', note = '', epg = '') {
  const box = `<div class="player-box">${inner}
  </div>`;
  const stage = epg
    ? `<div class="player-stage with-epg">
  <div class="player-main">${box}</div>
  <aside class="epg-panel">
    <div class="epg-title">Programa</div>
    <div id="epg-list" class="epg-list" data-epg="${esc(epg)}"><div class="epg-msg">Kraunama…</div></div>
  </aside>
</div>
<script src="${asset('/epg.js')}"></script>`
    : `<div class="player-stage">
  ${box}
</div>`;
  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${asset('/favicon.svg')}" type="image/svg+xml">
<link rel="alternate icon" href="${asset('/favicon.png')}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${asset('/apple-touch-icon.png')}">
<meta name="theme-color" content="#14151a">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${asset('/tv.css')}">
</head>
<body class="playerpage">
<div class="playerbar">
  <a class="btn" href="${esc(back)}" autofocus>‹ Grįžti</a>
  <span class="playertitle">${esc(title)}</span>
  ${extraBtn}
</div>
${note}
${stage}
<script src="${asset('/tv.js')}"></script>
</body>
</html>`;
}

// Proxy the direct video bytes (DoodStream MP4 is Referer-locked, so the browser
// can't fetch it itself). Only serves URLs we signed; forwards Range for seeking.
// The optional /:fname segment (e.g. /stream/v.mp4) is ignored — it only lets a
// player that picks its engine by file extension see an ".mp4" URL.
app.get(['/stream', '/stream/:fname'], async (req, res) => {
  const u = (req.query.u || '').toString();
  const r = (req.query.r || '').toString();
  const s = (req.query.s || '').toString();
  if (!u || s !== streamSig(u, r)) return res.status(403).end();
  try {
    const headers = { 'User-Agent': UA, 'Referer': r, 'Accept': '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(u, { headers });
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    streamUpstream(up, res);
  } catch (e) {
    res.status(502).end();
  }
});

app.use((req, res) => res.status(404).send(layout('Nerasta', `
<div class="errorbox"><h1>Puslapis nerastas</h1><a class="btn" href="/">Į pradžią</a></div>`)));

app.listen(PORT, () => console.log(`movie-proxy veikia: http://localhost:${PORT}`));
