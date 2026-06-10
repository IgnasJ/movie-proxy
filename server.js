require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const express = require('express');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const SOURCE = (process.env.SOURCE_URL || 'https://176.97.124.32').replace(/\/$/, '');
const WL_BASE = (process.env.WATCHLUNA_URL || 'https://watchluna.com').replace(/\/$/, '');
const enc = encodeURIComponent;
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'pass';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
<title>Prisijungimas</title>
<link rel="stylesheet" href="/tv.css">
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
<script src="/tv.js"></script>
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

// everything below requires a session
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
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

/* ------------------------------ DoodStream bypass ----------------------------
   DoodStream refuses to play when sandboxed, so we can't block its popups that
   way. Instead, for dood hosts we offer a "bypass" that replicates dood's own
   pass_md5 token handshake server-side to get the direct MP4, then plays it in
   our own <video> via /stream (which proxies the bytes with the required
   Referer). This skips dood's ad page entirely. Fragile by nature — dood rotates
   the scheme periodically; falls back to the normal iframe when it stops working. */

const DOOD_RE = /(^|\.)(dood|do0+d|ds2play|ds2video|d0{2,}d|vidply|doods)\b|dood|ds2(play|video)|d0{3,}d/i;
function isDoodHost(host) { return DOOD_RE.test(host || ''); }

function randStr(n) {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[crypto.randomInt(c.length)];
  return s;
}

// dood's HTML pages sit behind Cloudflare, which 403s Node's fetch (flagged TLS
// fingerprint). The system curl binary passes, so we use it for the text fetches.
// curl -w appends the final (post-redirect) URL after a marker so we can recover
// the rotating mirror origin (dood.pm -> playmogo.com, etc.).
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

// embed url (https://dood.x/e/<id>) -> { url: direct mp4, referer }
async function resolveDoodMp4(embedUrl) {
  const start = embedUrl.replace('/d/', '/e/');
  const { body: page, finalUrl } = await curlFetch(start, new URL(start).origin + '/');
  const origin = new URL(finalUrl).origin;
  const m = page.match(/\/pass_md5\/[\w-]+\/[\w-]+/);
  if (!m) return null;
  const passPath = m[0];
  const token = passPath.split('/').pop();
  const { body } = await curlFetch(origin + passPath, finalUrl);
  const base = body.trim();
  if (!/^https?:\/\//.test(base)) return null;
  const mp4 = `${base}${randStr(10)}?token=${token}&expiry=${Date.now()}`;
  return { url: mp4, referer: origin + '/' };
}

// sign a /stream target so the proxy only serves URLs we minted (no open proxy)
function streamSig(u, r) {
  return crypto.createHash('sha256').update(`${u}|${r}|${authToken}`).digest('hex').slice(0, 16);
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

// --- WatchLuna (Nuxt SPA backed by a public JSON API) ---
const WL_SERVERS = [
  { id: 1, name: 'Serveris 1', tag: 'VidSrc',
    movie: id => `https://vidsrc-embed.ru/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc-embed.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
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

async function wlJson(p) {
  const key = 'wl:' + p;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.html;
  const res = await fetch(WL_BASE + p, {
    headers: { 'User-Agent': UA, 'Referer': WL_BASE + '/', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`WatchLuna grąžino ${res.status}`);
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
    const t = await wlJson('/api/trending');
    return [
      { title: 'Populiarūs filmai', items: (t.trendingMovies || []).map(wlItem) },
      { title: 'Populiarūs serialai', items: (t.trendingTv || []).map(wlItem) },
    ].filter(s => s.items.length);
  },
  async archive(kind, page) {
    const isTv = kind === 'serialai';
    const arr = await wlJson(`/api/${isTv ? 'tv' : 'movies'}/popular?page=${page}`);
    const items = (Array.isArray(arr) ? arr : []).map(wlItem);
    return { items, hasMore: items.length >= 20 };
  },
  async search(q) {
    const arr = await wlJson('/api/search?query=' + enc(q));
    return (Array.isArray(arr) ? arr : []).map(o => {
      const it = wlItem(o);
      const orig = (o.original_title && o.original_title !== it.title) ? o.original_title
        : (o.original_name && o.original_name !== it.title) ? o.original_name : '';
      return { url: it.url, title: it.title, original: orig, poster: it.poster, rating: it.rating, year: it.year, desc: o.overview || '', kind: it.kind };
    });
  },
  async detail(type, id) {
    const backUrl = `/t/${type}/${enc(id)}`;
    if (type === 'movie') {
      const m = (await wlJson('/api/movies/' + enc(id))).details;
      if (!m || !m.id) throw new Error('Filmas nerastas');
      const title = m.title || m.original_title || '';
      const pl = srv => `/play?source=watchluna&kind=movie&id=${enc(id)}&server=${srv}&t=${enc(title)}&back=${enc(backUrl)}`;
      return {
        kind: 'movie', backUrl, title,
        original: (m.original_title && m.original_title !== title) ? m.original_title : '',
        poster: wlImg(m.poster_path), year: String(m.release_date || '').slice(0, 4), imdb: '',
        runtime: m.runtime ? `${m.runtime} min` : '', lang: (m.original_language || '').toUpperCase(),
        genres: (m.genres || []).map(g => g.name),
        rating: m.vote_average ? Number(m.vote_average).toFixed(1) : '', votes: m.vote_count || '',
        description: m.overview || '', cast: [],
        servers: WL_SERVERS.map(s => ({ name: s.name, tag: s.tag, play: pl(s.id) })),
      };
    }
    const t = await wlJson('/api/tv/' + enc(id));
    if (!t || !t.id) throw new Error('Serialas nerastas');
    const title = t.name || t.original_name || '';
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
              `&t=${enc(title + ' – ' + label)}&ep=${enc(label)}&back=${enc(backUrl)}`,
          })),
        });
      }
    }
    return {
      kind: 'series', backUrl, title,
      original: (t.original_name && t.original_name !== title) ? t.original_name : '',
      poster: wlImg(t.poster_path), year: String(t.first_air_date || '').slice(0, 4), imdb: '',
      runtime: t.number_of_seasons ? `${t.number_of_seasons} sez.` : '', lang: (t.original_language || '').toUpperCase(),
      genres: (t.genres || []).map(g => g.name),
      rating: t.vote_average ? Number(t.vote_average).toFixed(1) : '', votes: t.vote_count || '',
      description: t.overview || '', cast: [], episodes,
    };
  },
  play({ kind, id, server, season, episode }) {
    const s = WL_SERVERS.find(x => String(x.id) === String(server)) || WL_SERVERS[0];
    return kind === 'tv' ? s.tv(id, season, episode) : s.movie(id);
  },
};

const SOURCES = {
  '8filmai': { id: '8filmai', name: '8filmai', emoji: '🇱🇹', desc: 'Lietuviškai įgarsinti filmai ir serialai', provider: EIGHT },
  'watchluna': { id: 'watchluna', name: 'WatchLuna', emoji: '🌙', desc: 'Platus angliškas filmų ir serialų katalogas', provider: WL },
};
const PROVIDER_BY_TYPE = { filmas: EIGHT, serialai: EIGHT, movie: WL, tv: WL };
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
  const nav = hideNav ? '' : [
    ['/', 'Pradžia', 'home'],
    ['/filmai', 'Filmai', 'filmai'],
    ['/serialai', 'Serialai', 'serialai'],
  ].map(([href, label, key]) =>
    `<a class="navlink${active === key ? ' active' : ''}" href="${href}">${label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/tv.css">
</head>
<body>
<header class="topbar">
  <a class="logo" href="/">🎬 Filmai</a>
  ${hideNav ? '' : `<nav>${nav}</nav>
  <form class="search" action="/search" method="get">
    <input type="search" name="q" placeholder="Ieškoti filmo ar serialo..." value="${esc(query)}" enterkeyhint="search">
    <button type="submit">Ieškoti</button>
  </form>`}
  ${source ? `<a class="navlink source-switch" href="/sources" title="Keisti šaltinį">${esc(source)} ⇄</a>` : ''}
  <a class="navlink logout" href="/logout">Atsijungti</a>
</header>
<main>
${body}
</main>
<script src="/tv.js"></script>
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

function detailPage(d, sourceName) {
  const wrec = watched[watchedKey(d.backUrl)];
  const seenEps = (wrec && wrec.eps) || [];

  let sources = '';
  if (d.kind === 'movie') {
    sources = `<h2 class="section-title">Šaltiniai</h2>
    <div class="srvlist">` + (d.servers || []).map(s => `
      <a class="btn srv${s.isTrailer ? ' trailer' : ''}" href="${esc(s.play)}">
        ▶ ${esc(s.name || 'Serveris')}${s.tag ? ` <small>${esc(s.tag)}</small>` : ''}
      </a>`).join('') + `</div>`;
    if (!(d.servers || []).length) sources += `<p class="empty">Šaltinių nerasta.</p>`;
  } else {
    sources = `<h2 class="section-title">Epizodai</h2>` + (d.episodes || []).map(ep => {
      const epSeen = seenEps.includes(ep.label);
      return `
    <div class="episode${epSeen ? ' is-watched' : ''}" data-ep="${esc(ep.label)}">
      <div class="ep-label">${esc(ep.label)}${epSeen ? ` <span class="eptick">✓</span>` : ''}</div>
      <div class="ep-servers">` + ep.servers.map(s => `
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
      </div>
      ${d.genres.length ? `<div class="meta-row">${d.genres.map(g => `<span class="chip genre">${esc(g)}</span>`).join('')}</div>` : ''}
      ${wrec ? `<div class="meta-row"><span class="chip watched">✓ Žiūrėta</span></div>` : ''}
      ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
    </div>
  </div>
  ${sources}
  ${d.cast && d.cast.length ? `<h2 class="section-title">Vaidina</h2>
  <div class="cast">` + d.cast.map(c => `
    <div class="person">
      <img loading="lazy" src="${esc(c.img)}" alt="">
      <div class="person-name">${esc(c.name)}</div>
      <div class="person-role">${esc(c.role)}</div>
    </div>`).join('') + `</div>` : ''}`;
  return layout(d.title, body, { source: sourceName });
}

function errorPage(res, err, backUrl = '/') {
  res.status(502).send(layout('Klaida', `
  <div class="errorbox">
    <h1>Nepavyko pasiekti šaltinio</h1>
    <p>${esc(err.message || String(err))}</p>
    <a class="btn" href="${esc(backUrl)}">Grįžti</a>
    <a class="btn" href="">Bandyti dar kartą</a>
  </div>`));
}

/* ---------------------------------- routes --------------------------------- */

app.get('/sources', (req, res) => {
  const cur = activeSourceId(req);
  const cards = Object.values(SOURCES).map(s => `
    <a class="source-card${cur === s.id ? ' active' : ''}" href="/set-source?src=${s.id}">
      <div class="source-emoji">${s.emoji}</div>
      <div class="source-name">${esc(s.name)}</div>
      <div class="source-desc">${esc(s.desc)}</div>
      ${cur === s.id ? `<div class="source-current">✓ Dabartinis</div>` : `<div class="source-pick">Pasirinkti</div>`}
    </a>`).join('');
  res.send(layout('Pasirink šaltinį', `
    <div class="sources-intro">
      <h1>Iš kur ieškoti?</h1>
      <p>Pasirink filmų ir serialų šaltinį. Visada gali jį pakeisti viršuje.</p>
    </div>
    <div class="source-grid">${cards}</div>`, { hideNav: true }));
});

app.get('/set-source', (req, res) => {
  const src = (req.query.src || '').toString();
  if (!SOURCES[src]) return res.redirect('/sources');
  res.setHeader('Set-Cookie', `mpsrc=${src}; Path=/; Max-Age=31536000; SameSite=Lax`);
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

app.get('/t/:type(filmas|serialai|movie|tv)/:id', async (req, res) => {
  const { type, id } = req.params;
  const provider = PROVIDER_BY_TYPE[type];
  try {
    const d = await provider.detail(type, id);
    res.send(detailPage(d, SOURCE_BY_PROVIDER(provider.id).name));
  } catch (e) { errorPage(res, e, '/'); }
});

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
      kind: /^\/t\/(serialai|tv)\//.test(key) ? 'serialai' : 'filmas',
      ep: ep || undefined,
    });
  }

  try {
    const src = await provider.play(req.query);
    if (!src) throw new Error('Nepavyko gauti grotuvo nuorodos');

    const dood = isDoodHost(new URL(src).host);
    const wantBypass = req.query.bypass === '1';

    // --- DoodStream bypass: extract the direct MP4 and play it ourselves ---
    if (dood && wantBypass) {
      const direct = await resolveDoodMp4(src);
      if (direct) {
        const sq = new URLSearchParams({ u: direct.url, r: direct.referer, s: streamSig(direct.url, direct.referer) });
        return res.send(playerShell(title, back, `
    <video class="playerframe" controls autoplay playsinline src="/stream?${esc(sq.toString())}"></video>`, ''));
      }
      // extraction failed — fall through to the normal iframe with a note
    }

    // DoodStream refuses to play when sandboxed; everything else stays sandboxed.
    const sandbox = dood ? '' : ' sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"';
    const bypassBtn = dood && !wantBypass
      ? `<a class="btn alt" href="/play?${esc(new URLSearchParams({ ...req.query, bypass: '1' }).toString())}">Be reklamų (bandyti)</a>`
      : '';
    const note = dood && wantBypass
      ? `<div class="player-note">Nepavyko apeiti reklamų — rodomas originalus grotuvas.</div>` : '';

    res.send(playerShell(title, back, `
    <iframe class="playerframe" src="${esc(src)}"${sandbox} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="origin"></iframe>`, bypassBtn, note));
  } catch (e) { errorPage(res, e, back); }
});

function playerShell(title, back, inner, extraBtn = '', note = '') {
  return `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/tv.css">
</head>
<body class="playerpage">
<div class="playerbar">
  <a class="btn" href="${esc(back)}" autofocus>‹ Grįžti</a>
  <span class="playertitle">${esc(title)}</span>
  ${extraBtn}
</div>
${note}
<div class="player-stage">
  <div class="player-box">${inner}
  </div>
</div>
<script src="/tv.js"></script>
</body>
</html>`;
}

// Proxy the direct video bytes (DoodStream MP4 is Referer-locked, so the browser
// can't fetch it itself). Only serves URLs we signed; forwards Range for seeking.
app.get('/stream', async (req, res) => {
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
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    res.status(502).end();
  }
});

app.use((req, res) => res.status(404).send(layout('Nerasta', `
<div class="errorbox"><h1>Puslapis nerastas</h1><a class="btn" href="/">Į pradžią</a></div>`)));

app.listen(PORT, () => console.log(`movie-proxy veikia: http://localhost:${PORT}`));
