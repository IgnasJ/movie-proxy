/* Player-page helpers for TV remotes (loaded on every player page):
     - seek / play / pause keys with an on-screen readout (OSD)
     - resume from the saved position and report progress ("Tęsti žiūrėti")
     - "next episode" button, and auto-next with a countdown when one ends
     - channel up/down on live TV
   Written as plain ES5: smart-TV browsers are old. Everything here is
   best-effort and must never break playback. */
(function () {
  'use strict';

  var box = document.querySelector('.player-box');
  if (!box) return;

  var isPlay = location.pathname === '/play';      // films/series (not live TV)
  var own = document.getElementById('tvvideo');     // our bare <video> (MP4 / hls.js)

  // our <video>, or the one Playerjs creates a moment after load
  function vid() { return own || document.querySelector('#player video'); }
  // seekable, finite-length content (not a live stream)
  function vod(v) { return !!v && isFinite(v.duration) && v.duration > 0; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }

  /* ---- OSD: a short readout over the picture, since a remote gives no other
     feedback that a key did anything ---- */
  var osd = null, osdTimer = null;
  function showOsd(text, v) {
    if (!osd) {
      osd = document.createElement('div');
      osd.className = 'tv-osd';
      osd.innerHTML = '<div class="tv-osd-text"></div><div class="tv-osd-bar"><i></i></div>';
      box.appendChild(osd);
    }
    osd.firstChild.textContent = text;
    var bar = osd.lastChild;
    if (vod(v)) {
      bar.style.display = '';
      bar.firstChild.style.width = Math.min(100, (v.currentTime / v.duration) * 100) + '%';
    } else {
      bar.style.display = 'none';
    }
    osd.className = 'tv-osd show';
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { osd.className = 'tv-osd'; }, 1800);
  }

  /* ---- seeking: 10 s steps that grow while the key is held or tapped quickly,
     so a 2-hour film doesn't take 700 presses ---- */
  var streak = 0, lastSeek = 0, lastDir = 0;
  function seek(dir, fixed) {
    var v = vid();
    if (!vod(v)) return false;
    var now = Date.now();
    // the run restarts on a pause between presses or a change of direction
    streak = (now - lastSeek < 800 && dir === lastDir) ? streak + 1 : 0;
    lastSeek = now;
    lastDir = dir;
    var step = fixed || (streak < 4 ? 10 : streak < 10 ? 30 : 60);
    var t = Math.max(0, Math.min(v.duration - 1, v.currentTime + dir * step));
    try { v.currentTime = t; } catch (e) { return false; }
    showOsd((dir < 0 ? '« −' : '» +') + step + ' s    ' + fmt(t) + ' / ' + fmt(v.duration), v);
    return true;
  }

  function play() {
    var v = vid();
    if (!v) return false;
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
    showOsd('▶  ' + (vod(v) ? fmt(v.currentTime) + ' / ' + fmt(v.duration) : ''), v);
    return true;
  }
  function pause() {
    var v = vid();
    if (!v) return false;
    v.pause();
    showOsd('❚❚  ' + (vod(v) ? fmt(v.currentTime) + ' / ' + fmt(v.duration) : 'Pauzė'), v);
    return true;
  }
  function toggle() {
    var v = vid();
    if (!v) return false;
    return v.paused ? play() : pause();
  }

  // focus is "on the picture": on the box itself, inside it, or nowhere
  function onPicture() {
    var a = document.activeElement;
    return !a || a === document.body || a === box || a === own;
  }

  function zap(dir) {
    var links = document.querySelectorAll('.playerbar a.zap');
    if (!links.length) return false;
    var a = dir < 0 ? links[0] : links[links.length - 1];
    // with a single zap button it is either prev or next — check the arrow
    if (links.length === 1 && (a.textContent.indexOf('›') !== -1) !== (dir > 0)) return false;
    location.href = a.getAttribute('href');
    return true;
  }

  /* ---- next episode ---- */
  var next = null;            // { h: href, l: label }
  var nextBox = null, nextTimer = null;

  function sameUrl(a, b) {
    try { return decodeURIComponent(a) === decodeURIComponent(b); } catch (e) { return a === b; }
  }
  if (isPlay) {
    try {
      var q = JSON.parse(sessionStorage.getItem('mpq') || 'null');
      var cur = location.pathname + location.search;
      if (q && q.list) {
        for (var i = 0; i < q.list.length - 1; i++) {
          if (sameUrl(q.list[i].h, cur)) { next = q.list[i + 1]; break; }
        }
      }
    } catch (e) { /* no queue — no next button */ }
  }
  if (next) {
    var bar = document.querySelector('.playerbar');
    if (bar) {
      var nb = document.createElement('a');
      nb.className = 'btn alt nextep';
      nb.href = next.h;
      nb.title = next.l;
      nb.innerHTML = '<span class="zap-name"></span> ›';
      nb.firstChild.textContent = 'Kita: ' + next.l;
      bar.appendChild(nb);
    }
  }

  function cancelNext() {
    if (!nextBox) return false;
    clearInterval(nextTimer);
    if (nextBox.parentNode) nextBox.parentNode.removeChild(nextBox);
    nextBox = null;
    try { box.focus(); } catch (e) {}
    return true;
  }
  function offerNext() {
    if (!next || nextBox) return;
    var left = 10;
    nextBox = document.createElement('div');
    nextBox.className = 'tv-next';
    nextBox.innerHTML = '<div class="tv-next-title"></div><div class="tv-next-btns">' +
      '<a class="btn"></a><button type="button" class="btn alt">Atšaukti</button></div>';
    nextBox.firstChild.textContent = 'Kita serija: ' + next.l;
    var go = nextBox.querySelector('a');
    go.href = next.h;
    function label() { go.textContent = '▶ Žiūrėti dabar (' + left + ')'; }
    label();
    nextBox.querySelector('button').addEventListener('click', cancelNext);
    box.appendChild(nextBox);
    try { go.focus(); } catch (e) {}
    nextTimer = setInterval(function () {
      left--;
      if (left <= 0) { clearInterval(nextTimer); location.href = next.h; return; }
      label();
    }, 1000);
  }

  /* ---- keys. Capture phase, so a key handled here never reaches the spatial
     navigation in tv.js (which would also move the focus). ---- */
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, done = false;

    if (nextBox) {
      // Back / Escape cancels the countdown; arrows and OK go to its buttons
      if (k === 461 || k === 10009 || k === 27 || k === 8) done = cancelNext();
      if (done) { e.preventDefault(); e.stopPropagation(); }
      return;
    }

    // dedicated remote keys work wherever the focus is
    if (k === 415) done = play();                                  // Play
    else if (k === 19 || k === 413) done = pause();                // Pause / Stop
    else if (k === 10252 || k === 179) done = toggle();            // Play/Pause
    else if (k === 417 || k === 228) done = seek(1, 30);           // Fast forward
    else if (k === 412 || k === 227) done = seek(-1, 30);          // Rewind
    else if (k === 427 || k === 33) done = zap(1);                 // Channel up
    else if (k === 428 || k === 34) done = zap(-1);                // Channel down
    // arrows / OK act on the picture only while the focus is on it, and only
    // for our own <video> — Playerjs has its own keyboard handling
    else if (own && onPicture()) {
      if (k === 37) done = seek(-1);
      else if (k === 39) done = seek(1);
      else if (k === 13 || k === 32) done = toggle();
    }

    if (done) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  if (!isPlay || !own) return;   // the rest is for films/series in our own <video>

  // put the focus on the picture so ←/→ seek straight away; ↑ reaches the bar
  box.tabIndex = 0;
  try { box.focus(); } catch (e) {}

  /* ---- resume ---- */
  var resumePos = 0;
  function applyResume() {
    if (resumePos > 30 && vod(own) && own.duration > resumePos + 30 && own.currentTime < 5) {
      try { own.currentTime = resumePos; } catch (e) { return; }
      showOsd('Tęsiama nuo ' + fmt(resumePos), own);
    }
  }
  own.addEventListener('loadedmetadata', applyResume);
  try {
    var x = new XMLHttpRequest();
    x.open('GET', '/progress/get' + location.search, true);
    x.onload = function () {
      try { resumePos = Number(JSON.parse(x.responseText).pos) || 0; } catch (e) { resumePos = 0; }
      applyResume();
    };
    x.send();
  } catch (e) { /* no resume */ }

  /* ---- progress reporting ---- */
  var lastSent = -100;
  function report(force) {
    // skip live streams, clips too short to be a film/episode, and the first seconds
    if (!vod(own) || own.duration < 120 || own.currentTime < 5) return;
    if (!force && Math.abs(own.currentTime - lastSent) < 5) return;
    lastSent = own.currentTime;
    var url = '/progress' + location.search;
    var body = 'pos=' + Math.floor(own.currentTime) + '&dur=' + Math.floor(own.duration);
    try {
      if (navigator.sendBeacon && window.Blob) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/x-www-form-urlencoded' }));
        return;
      }
    } catch (e) { /* fall through to XHR */ }
    try {
      var r = new XMLHttpRequest();
      r.open('POST', url, true);
      r.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      r.send(body);
    } catch (e) { /* best-effort */ }
  }
  setInterval(function () { if (!own.paused) report(false); }, 15000);
  own.addEventListener('pause', function () { report(true); });
  window.addEventListener('pagehide', function () { report(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) report(true); });

  own.addEventListener('ended', function () {
    report(true);          // marks it finished server-side
    offerNext();
  });
})();
