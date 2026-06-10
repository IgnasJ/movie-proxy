/* Spatial navigation for TV remotes (arrow keys move focus geometrically).
   preventDefault stops TVs with native spatial nav from double-moving. */
(function () {
  'use strict';

  function focusables() {
    var els = document.querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"])');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ el: els[i], r: r });
    }
    return out;
  }

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function findNext(dir) {
    var active = document.activeElement;
    if (!active || active === document.body) return focusables()[0] ? focusables()[0].el : null;
    var ar = active.getBoundingClientRect();
    var ac = center(ar);
    var best = null, bestScore = Infinity;
    var all = focusables();
    for (var i = 0; i < all.length; i++) {
      if (all[i].el === active) continue;
      var c = center(all[i].r);
      var dx = c.x - ac.x, dy = c.y - ac.y;
      var inDir =
        (dir === 'left' && dx < -5) || (dir === 'right' && dx > 5) ||
        (dir === 'up' && dy < -5) || (dir === 'down' && dy > 5);
      if (!inDir) continue;
      var primary = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
      var secondary = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
      var score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = all[i].el; }
    }
    return best;
  }

  var keys = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  document.addEventListener('keydown', function (e) {
    var dir = keys[e.keyCode];
    if (!dir) return;
    var t = document.activeElement;
    // don't steal left/right inside text inputs
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (dir === 'left' || dir === 'right')) return;
    var next = findNext(dir);
    if (next) {
      e.preventDefault();
      next.focus();
      if (next.scrollIntoView) next.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  });

  // Back button on remotes (and Backspace outside inputs) -> history back
  document.addEventListener('keydown', function (e) {
    var isBack = e.keyCode === 461 /* LG */ || e.keyCode === 10009 /* Samsung */ ||
      (e.keyCode === 8 && document.activeElement && document.activeElement.tagName !== 'INPUT');
    if (isBack && document.referrer) {
      e.preventDefault();
      history.back();
    }
  });

  // initial focus so arrows work immediately
  if (!document.activeElement || document.activeElement === document.body) {
    var first = document.querySelector('main a, .playerbar a, a[href]');
    if (first) first.focus();
  }
})();

/* ----------------------- "watched" tracking (per device) -----------------------
   Stored in localStorage: { "/t/filmas/slug": { t: <ms>, eps: ["1 Serija", ...] } }
   A title is marked watched when its player page opens; series also record the
   specific episode. Cards across the site get a ✓ badge; the detail page shows a
   toggle and ticks watched episodes. */
(function () {
  'use strict';
  var KEY = 'mp_watched';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
    catch (e) { return {}; }
  }
  function save(w) {
    try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (e) { /* quota/full */ }
  }
  // normalize any /t/... URL to a stable key (decoded path, no trailing slash)
  function keyOf(u) {
    if (!u) return null;
    var p;
    try { p = new URL(u, location.origin).pathname; } catch (e) { return null; }
    try { p = decodeURIComponent(p); } catch (e) { /* leave as-is */ }
    p = p.replace(/\/+$/, '');
    return p.indexOf('/t/') === 0 ? p : null;
  }
  function mark(url, ep) {
    if (!url) return;
    var w = load();
    var rec = w[url] || {};
    rec.t = Date.now();
    if (ep) {
      rec.eps = rec.eps || [];
      if (rec.eps.indexOf(ep) < 0) rec.eps.push(ep);
    }
    w[url] = rec;
    save(w);
  }
  function unmark(url) {
    var w = load();
    delete w[url];
    save(w);
  }

  // 1) record a watch when the player page opens
  if (location.pathname === '/play') {
    var pp = new URLSearchParams(location.search);
    mark(keyOf(pp.get('back') || ''), pp.get('ep') || null);
  }

  // 2) badge every card / search result that's been watched
  function decorate() {
    var w = load();
    var links = document.querySelectorAll('a.card, a.result');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var k = keyOf(a.getAttribute('href'));
      if (!k || !w[k]) continue;
      a.classList.add('is-watched');
      if (a.classList.contains('result')) {
        var meta = a.querySelector('.result-meta');
        if (meta && !meta.querySelector('.chip.watched')) {
          var c = document.createElement('span');
          c.className = 'chip watched';
          c.textContent = '✓ Žiūrėta';
          meta.insertBefore(c, meta.firstChild);
        }
      } else {
        var poster = a.querySelector('.poster');
        if (poster && !poster.querySelector('.badge.watched')) {
          var b = document.createElement('span');
          b.className = 'badge watched';
          b.textContent = '✓ Žiūrėta';
          poster.appendChild(b);
        }
      }
    }
  }

  // 3) detail page: toggle button + per-episode ticks
  function detail() {
    var ctl = document.getElementById('watched-ctl');
    if (!ctl) return;
    var k = keyOf(location.pathname);
    if (!k) return;

    function tickEpisodes() {
      var rec = load()[k] || {};
      var eps = rec.eps || [];
      var rows = document.querySelectorAll('.episode[data-ep]');
      for (var i = 0; i < rows.length; i++) {
        var div = rows[i];
        var seen = eps.indexOf(div.getAttribute('data-ep')) >= 0;
        div.classList.toggle('is-watched', seen);
        var lbl = div.querySelector('.ep-label');
        if (!lbl) continue;
        var tick = lbl.querySelector('.eptick');
        if (seen && !tick) {
          var t = document.createElement('span');
          t.className = 'eptick';
          t.textContent = ' ✓';
          lbl.appendChild(t);
        } else if (!seen && tick) {
          tick.remove();
        }
      }
    }
    function render() {
      var on = !!load()[k];
      ctl.innerHTML = '';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn watched-toggle' + (on ? ' on' : '');
      btn.textContent = on ? '✓ Žiūrėta — pažymėti kaip nežiūrėtą' : 'Pažymėti kaip žiūrėtą';
      btn.addEventListener('click', function () {
        if (load()[k]) unmark(k); else mark(k);
        render();
        tickEpisodes();
      });
      ctl.appendChild(btn);
    }
    render();
    tickEpisodes();
  }

  decorate();
  detail();
})();
