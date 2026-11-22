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
    // (history.length too: a page reached from the no-Referer player has an
    // empty document.referrer but still has somewhere to go back to)
    if (isBack && (document.referrer || history.length > 1)) {
      e.preventDefault();
      history.back();
    }
  });

  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      var m = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
      if (m && m.call(el, sel)) return el;
      el = el.parentNode;
    }
    return null;
  }

  /* ---- long episode lists: range tabs (1–50, 51–100, …) ---- */
  function showGroup(g) {
    var i, groups = document.querySelectorAll('.ep-group'), tabs = document.querySelectorAll('.ep-range');
    for (i = 0; i < groups.length; i++) groups[i].hidden = groups[i].getAttribute('data-g') !== String(g);
    for (i = 0; i < tabs.length; i++) {
      tabs[i].className = 'chip ep-range' + (tabs[i].getAttribute('data-g') === String(g) ? ' active' : '');
    }
  }
  document.addEventListener('click', function (e) {
    var tab = closest(e.target, '.ep-range');
    if (tab) showGroup(tab.getAttribute('data-g'));
  });

  /* ---- episode queue: when an episode is opened, remember every episode's
     link for the same server so the player can offer "next episode" (see
     player.js). Kept in viewing order, oldest first. ---- */
  function lastNum(s) { var m = String(s).match(/[0-9]+/g); return m ? parseInt(m[m.length - 1], 10) : NaN; }
  function buildQueue(a) {
    var eps = document.querySelectorAll('.episode');
    if (!eps.length) return;
    var cur = closest(a, '.episode'), pos = 0, i, links;
    if (cur) {
      links = cur.querySelectorAll('.ep-servers a.btn.srv');
      for (i = 0; i < links.length; i++) if (links[i] === a) pos = i;
    }
    var list = [];
    for (i = 0; i < eps.length; i++) {
      links = eps[i].querySelectorAll('.ep-servers a.btn.srv');
      var l = links[pos] || links[0];
      if (l) list.push({ h: l.getAttribute('href'), l: eps[i].getAttribute('data-ep') || '' });
    }
    if (list.length > 1 && lastNum(list[0].l) > lastNum(list[list.length - 1].l)) list.reverse();
    try { sessionStorage.setItem('mpq', JSON.stringify({ back: location.pathname, list: list })); } catch (e) {}
  }

  /* ---- focus memory: coming back from a film or the player lands on the card
     or button that was opened, not at the top of the page ---- */
  var FKEY = 'mpf:' + location.pathname + location.search;
  document.addEventListener('click', function (e) {
    var a = closest(e.target, 'a');
    if (!a || !a.getAttribute('href')) return;
    notePath();
    if (closest(a, '.episode') || a.getAttribute('data-epi') !== null) buildQueue(a);
    var href = a.getAttribute('href'), same = document.querySelectorAll('a[href]'), n = 0, i;
    for (i = 0; i < same.length; i++) {
      if (same[i].getAttribute('href') !== href) continue;
      if (same[i] === a) break;
      n++;
    }
    try { sessionStorage.setItem(FKEY, JSON.stringify({ h: href, n: n })); } catch (err) {}
  }, true);

  // The page we came from, kept in sessionStorage rather than read from
  // document.referrer: the TopFilmai player page sends no Referer at all.
  var prevPath = '';
  try { prevPath = sessionStorage.getItem('mpprev') || ''; } catch (e) {}
  function notePath() { try { sessionStorage.setItem('mpprev', location.pathname); } catch (e) {} }
  window.addEventListener('pagehide', notePath);

  function cameBack() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type === 'back_forward') return true;
    } catch (e) {}
    // arriving from a film/series page or a player = "coming back"
    return prevPath.indexOf('/t/') === 0 || prevPath.indexOf('/play') === 0 || prevPath.indexOf('/tv/play') === 0;
  }
  function restoreFocus() {
    if (document.body.className.indexOf('playerpage') !== -1 || !cameBack()) return false;
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem(FKEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.h) return false;
    var all = document.querySelectorAll('a[href]'), hit = null, n = 0, i;
    for (i = 0; i < all.length; i++) {
      if (all[i].getAttribute('href') !== saved.h) continue;
      hit = all[i];
      if (n++ === saved.n) break;
    }
    if (!hit) return false;
    var group = closest(hit, '.ep-group');
    if (group && group.hidden) showGroup(group.getAttribute('data-g'));
    hit.focus();
    if (hit.scrollIntoView) hit.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }

  // initial focus so arrows work immediately: where the user left off, else
  // the "continue" button / next-up episode, else the first link
  if (!restoreFocus() && (!document.activeElement || document.activeElement === document.body)) {
    var first = document.querySelector('main .resume') ||
      document.querySelector('main .episode.is-next a') ||
      document.querySelector('main a') ||
      document.querySelector('.playerbar a, a[href]');
    if (first) first.focus();
  }

  // Wishlist toggle: intercept the form submit and flip state in place via
  // fetch, so the page doesn't reload. Falls back to a normal POST + redirect
  // if fetch is unavailable or the request fails.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.classList || !form.classList.contains('wishlist-form') || !window.fetch) return;
    e.preventDefault();
    var btn = form.querySelector('.wishlist-btn');
    fetch(form.action, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString()
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (btn) btn.classList.toggle('active', !!data.inList);
      if (btn) btn.setAttribute('aria-pressed', data.inList ? 'true' : 'false');
    }).catch(function () { form.submit(); });
  });
})();
