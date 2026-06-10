require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const SOURCE = (process.env.SOURCE_URL || 'https://176.97.124.32').replace(/\/$/, '');
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

app.use((req, res, next) => {
  const cookies = req.headers.cookie || '';
  if (cookies.includes(`mpauth=${authToken}`)) return next();
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === AUTH_USER && p === AUTH_PASS) {
      // remember on this device so the TV doesn't re-prompt
      res.setHeader('Set-Cookie', `mpauth=${authToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Movies", charset="UTF-8"');
  res.status(401).send('Reikalingas prisijungimas / Authentication required');
});

app.use(express.static('public', { maxAge: '7d' }));

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

async function getPage(path, ttlMs = 5 * 60 * 1000) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.html;
  const html = await srcFetch(path);
  cache.set(path, { html, exp: Date.now() + ttlMs });
  if (cache.size > 200) {
    for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
  }
  return html;
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
      const servers = $li.next('.collapse').find('li.dooplay_player_option')
        .map((__, s) => parseServerLi($, s)).get()
        .filter(s => s.post && s.nume);
      return { label: $li.find('.title').first().text().trim(), servers };
    }).get().filter(e => e.servers.length);
  } else {
    d.kind = 'movie';
    d.servers = $('#playeroptions li.dooplay_player_option')
      .map((_, s) => parseServerLi($, s)).get()
      .filter(s => s.post && s.nume);
  }
  return d;
}

/* ----------------------------- player resolution ---------------------------- */

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

/* -------------------------------- rendering -------------------------------- */

function layout(title, body, { query = '', active = '' } = {}) {
  const nav = [
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
  <nav>${nav}</nav>
  <form class="search" action="/search" method="get">
    <input type="search" name="q" placeholder="Ieškoti filmo ar serialo..." value="${esc(query)}" enterkeyhint="search">
    <button type="submit">Ieškoti</button>
  </form>
</header>
<main>
${body}
</main>
<script src="/tv.js"></script>
</body>
</html>`;
}

function cardGrid(items) {
  return `<div class="grid">` + items.map(i => `
  <a class="card" href="${esc(i.url)}">
    <div class="poster">
      <img loading="lazy" src="${esc(i.poster)}" alt="${esc(i.title)}">
      ${i.rating ? `<span class="badge">★ ${esc(i.rating.replace(/[^\d.,]/g, ''))}</span>` : ''}
      ${i.episodes ? `<span class="badge eps">${esc(i.episodes)} ser.</span>` : ''}
      ${i.kind === 'serialai' ? `<span class="badge kind">Serialas</span>` : ''}
    </div>
    <div class="card-title">${esc(i.title)}</div>
  </a>`).join('') + `</div>`;
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

app.get('/', async (req, res) => {
  try {
    const sections = parseHome(await getPage('/'));
    const body = sections.map(s => `
      <h2 class="section-title">${esc(s.title)}</h2>
      ${cardGrid(s.items)}`).join('');
    res.send(layout('Filmai ir serialai', body, { active: 'home' }));
  } catch (e) { errorPage(res, e); }
});

function archiveRoute(srcBase, label, activeKey) {
  return async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    try {
      const path = page > 1 ? `${srcBase}/page/${page}/` : `${srcBase}/`;
      const items = parseArchive(await getPage(path));
      const base = `/${activeKey}`;
      const pager = `
      <div class="pager">
        ${page > 1 ? `<a class="btn" href="${base}?page=${page - 1}">‹ Ankstesnis</a>` : ''}
        <span class="pageno">${page} psl.</span>
        ${items.length >= 10 ? `<a class="btn" href="${base}?page=${page + 1}">Kitas ›</a>` : ''}
      </div>`;
      res.send(layout(label, `<h2 class="section-title">${label}</h2>${cardGrid(items)}${pager}`, { active: activeKey }));
    } catch (e) { errorPage(res, e); }
  };
}
app.get('/filmai', archiveRoute('/filmas', 'Filmai', 'filmai'));
app.get('/serialai', archiveRoute('/serialai', 'Serialai', 'serialai'));

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.redirect('/');
  try {
    const results = parseSearch(await getPage('/?s=' + encodeURIComponent(q), 60 * 1000));
    const body = `
    <h2 class="section-title">Rezultatai: ${esc(q)} (${results.length})</h2>
    ${results.length ? `<div class="results">` + results.map(r => `
      <a class="result" href="${esc(r.url)}">
        <img loading="lazy" src="${esc(r.poster)}" alt="">
        <div class="result-info">
          <div class="result-title">${esc(r.title)}${r.original ? ` <span class="orig">/ ${esc(r.original)}</span>` : ''}</div>
          <div class="result-meta">
            <span class="chip">${r.kind === 'serialai' ? 'Serialas' : 'Filmas'}</span>
            ${r.rating ? `<span class="chip">${esc(r.rating)}</span>` : ''}
            ${r.year ? `<span class="chip">${esc(r.year)}</span>` : ''}
          </div>
          ${r.desc ? `<p class="result-desc">${esc(r.desc)}</p>` : ''}
        </div>
      </a>`).join('') + `</div>` : `<p class="empty">Nieko nerasta.</p>`}`;
    res.send(layout(`Paieška: ${q}`, body, { query: q }));
  } catch (e) { errorPage(res, e); }
});

app.get('/t/:type(filmas|serialai)/:slug', async (req, res) => {
  const { type, slug } = req.params;
  const backUrl = `/t/${type}/${encodeURIComponent(slug)}`;
  try {
    const d = parseDetail(await getPage(`/${type}/${encodeURIComponent(slug)}/?old`));
    if (!d.title) throw new Error('Nepavyko perskaityti puslapio (gal pasikeitė šaltinio struktūra?)');

    const playLink = (s, extra = '') =>
      `/play?post=${encodeURIComponent(s.post)}&type=${encodeURIComponent(s.type)}&nume=${encodeURIComponent(s.nume)}&t=${encodeURIComponent(d.title + extra)}&back=${encodeURIComponent(backUrl)}`;

    let sources = '';
    if (d.kind === 'movie') {
      sources = `<h2 class="section-title">Šaltiniai</h2>
      <div class="srvlist">` + (d.servers || []).map(s => `
        <a class="btn srv${s.nume === 'trailer' ? ' trailer' : ''}" href="${playLink(s)}">
          ▶ ${esc(s.name || 'Serveris')}${s.tag ? ` <small>${esc(s.tag)}</small>` : ''}
        </a>`).join('') + `</div>`;
      if (!(d.servers || []).length) sources += `<p class="empty">Šaltinių nerasta.</p>`;
    } else {
      sources = `<h2 class="section-title">Epizodai</h2>` + (d.episodes || []).map(ep => `
      <div class="episode">
        <div class="ep-label">${esc(ep.label)}</div>
        <div class="ep-servers">` + ep.servers.map(s => `
          <a class="btn srv" href="${playLink(s, ' – ' + ep.label)}">▶ ${esc(s.name)}${s.tag ? ` <small>${esc(s.tag)}</small>` : ''}</a>`).join('') + `
        </div>
      </div>`).join('');
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
          ${d.rating ? `<span class="chip">★ ${esc(d.rating)} (${esc(d.votes)})</span>` : ''}
        </div>
        ${d.genres.length ? `<div class="meta-row">${d.genres.map(g => `<span class="chip genre">${esc(g)}</span>`).join('')}</div>` : ''}
        ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
      </div>
    </div>
    ${sources}
    ${d.cast.length ? `<h2 class="section-title">Vaidina</h2>
    <div class="cast">` + d.cast.map(c => `
      <div class="person">
        <img loading="lazy" src="${esc(c.img)}" alt="">
        <div class="person-name">${esc(c.name)}</div>
        <div class="person-role">${esc(c.role)}</div>
      </div>`).join('') + `</div>` : ''}`;
    res.send(layout(d.title, body));
  } catch (e) { errorPage(res, e, '/'); }
});

app.get('/play', async (req, res) => {
  const { post, type, nume } = req.query;
  const title = (req.query.t || 'Grotuvas').toString();
  const back = (req.query.back || '/').toString();
  // auto (default): extract the real player so the browser loads a trusted player
  // domain instead of the source IP (whose TLS cert many TV/mobile browsers reject).
  // The extracted player keeps the source referer baked into its own URL, so the
  // referer check still passes. raw: force the source's p2.php wrapper (needed only
  // if extraction fails or a player misbehaves) — requires trusting the source cert.
  const mode = ['clean', 'raw'].includes(req.query.mode) ? req.query.mode : 'auto';
  if (!post || !type || !nume) return res.redirect('/');
  try {
    const embed = await resolveEmbed(post, type, nume);
    if (!embed) throw new Error('Serveris negrąžino grotuvo nuorodos');
    let src = embed.startsWith('http') ? embed : SOURCE + embed;

    // If the embed is the source's own wrapper page (p2.php), the browser would have
    // to connect to the source IP directly. We extract the real player instead, unless
    // raw mode is explicitly requested. resolveClean falls back to the wrapper if it
    // can't find an inner player.
    const onSource = new URL(src).host === new URL(SOURCE).host;
    let usingWrapper = onSource;
    if (onSource && mode !== 'raw') {
      const clean = await resolveClean(src);
      if (clean) { src = clean; usingWrapper = false; }
    }

    let toggle = '';
    if (onSource) {
      const nextMode = usingWrapper ? 'clean' : 'raw';
      const label = usingWrapper ? 'Bandyti švarų režimą' : 'Jei neveikia, spausk čia';
      const qs = new URLSearchParams({ post, type, nume, t: title, back, mode: nextMode }).toString();
      toggle = `<a class="btn alt" href="/play?${esc(qs)}">${label}</a>`;
    }
    const statusNote = usingWrapper ? ' (originalus režimas)' : '';

    res.send(`<!DOCTYPE html>
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
  <span class="playertitle">${esc(title)}${statusNote}</span>
  ${toggle}
</div>
<iframe class="playerframe" src="${esc(src)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="origin"></iframe>
<script src="/tv.js"></script>
</body>
</html>`);
  } catch (e) { errorPage(res, e, back); }
});

app.use((req, res) => res.status(404).send(layout('Nerasta', `
<div class="errorbox"><h1>Puslapis nerastas</h1><a class="btn" href="/">Į pradžią</a></div>`)));

app.listen(PORT, () => console.log(`movie-proxy veikia: http://localhost:${PORT} (šaltinis: ${SOURCE})`));
