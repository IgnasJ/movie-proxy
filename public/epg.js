/* Fetches the channel's program guide from /tv/epg and renders it in the player
   sidebar. iptvx.one times are Vilnius-local and returned as naive datetimes;
   the device (an iPad/TV in Lithuania) is in the same zone, so we compare them
   against the browser's local clock to find what's on now. */
(function () {
  'use strict';
  var box = document.getElementById('epg-list');
  if (!box) return;
  var slug = box.getAttribute('data-epg');
  if (!slug) { box.innerHTML = '<div class="epg-msg">Programa nepasiekiama</div>'; return; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function dayLabel(d) {
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var day = new Date(d); day.setHours(0, 0, 0, 0);
    var diff = Math.round((day - t) / 86400000);
    if (diff === 0) return 'Šiandien';
    if (diff === 1) return 'Rytoj';
    var w = ['Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis'];
    return w[d.getDay()] + ', ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  }

  function render(programs) {
    if (!programs || !programs.length) {
      box.innerHTML = '<div class="epg-msg">Programos nėra</div>';
      return;
    }
    var items = programs.map(function (p) { return { start: new Date(p.start), title: p.title, desc: p.desc }; })
      .filter(function (p) { return !isNaN(p.start); });
    var now = new Date();

    // current programme = last one that has already started
    var curIdx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].start <= now) curIdx = i; else break;
    }
    // show from the current programme onward (or from the start if nothing has aired yet)
    var from = Math.max(0, curIdx);
    var html = '', lastDay = '';
    for (var j = from; j < items.length; j++) {
      var it = items[j];
      var dl = dayLabel(it.start);
      if (dl !== lastDay) { html += '<div class="epg-day">' + dl + '</div>'; lastDay = dl; }
      var live = (j === curIdx);
      html += '<div class="epg-item' + (live ? ' epg-now' : '') + '">'
        + '<span class="epg-time">' + hhmm(it.start) + '</span>'
        + '<span class="epg-prog">' + escapeHtml(it.title) + (live ? ' <span class="epg-badge">DABAR</span>' : '') + '</span>'
        + '</div>';
    }
    box.innerHTML = html;
    // list already starts at the current programme (DABAR); don't scroll the
    // page/list to it, which would push the player out of view
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function load() {
    fetch('/tv/epg?id=' + encodeURIComponent(slug))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (d) { render(d.programs); })
      .catch(function () { box.innerHTML = '<div class="epg-msg">Nepavyko įkelti programos</div>'; });
  }

  load();
  // re-highlight "now" every minute (cheap; EPG data itself is cached server-side)
  setInterval(load, 60000);
})();
