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
