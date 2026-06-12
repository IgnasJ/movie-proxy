/* Fills each channel tile on /tv with its current and next programme.
   One request to /tv/epg-now (server computes now/next in Vilnius time and
   caches per channel); refreshed every couple of minutes. */
(function () {
  'use strict';
  var tiles = [].slice.call(document.querySelectorAll('.ch-epg[data-epg]'));
  if (!tiles.length) return;

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function fill(data) {
    tiles.forEach(function (t) {
      var d = data[t.getAttribute('data-epg')];
      var now = t.querySelector('.ch-now');
      var next = t.querySelector('.ch-next');
      if (d && d.now) now.innerHTML = '<span class="ch-dot"></span>' + d.now.time + '&nbsp; ' + esc(d.now.title);
      else now.textContent = '';
      if (d && d.next) next.innerHTML = '<span class="ch-na">toliau</span> ' + d.next.time + '&nbsp; ' + esc(d.next.title);
      else next.textContent = '';
    });
  }

  function load() {
    fetch('/tv/epg-now')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) fill(d); })
      .catch(function () { /* leave tiles as-is */ });
  }

  load();
  setInterval(load, 120000);
})();
